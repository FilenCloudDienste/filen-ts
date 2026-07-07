import { sdkApi, threadCount } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { resumeSession } from "@/lib/sdk/session"
import { storage } from "@/lib/storage/adapter"
import { isOpfsUnavailableError } from "@/lib/storage/errors"
import { useBootStore } from "@/stores/boot"
import { queryClient } from "@/queries/client"
import { restorePersistedQueries, purgePersistedQueries } from "@/queries/persist"
import { log } from "@/lib/log"

// Settled when bootSdk() finishes — on success OR failure, and never rejected. Auth-sensitive route
// guards await this before reading hasClient(): the boot kick runs before the router mounts, but
// wasm init + session resume complete asynchronously, so a guard that read hasClient() during the
// router's initial load would resolve `false` mid-boot and bounce an authed reload to /login. Guards
// must also not hang on a boot failure — the BootGate error screen owns that path, so a failed boot
// still settles this and the guard proceeds (hasClient() is false → redirect to sign-in).
let signalBootReady: () => void = () => undefined
const bootReady = new Promise<void>(resolve => {
	signalBootReady = resolve
})

export function whenBootReady(): Promise<void> {
	return bootReady
}

// Drives the worker boot + the async-runtime smoke test, reflecting each phase into the boot store.
// Boot success is NOT health: probeAsync() (an unauth network op that must settle) gates "ready".
export async function bootSdk(): Promise<void> {
	const { setBooting, setReady, setError } = useBootStore.getState()
	setBooting()
	try {
		const result = await sdkApi.boot({ threads: threadCount() })
		if (!result.ok) {
			setError(result.reason, { species: "plain", message: result.detail, label: result.detail })
			log.error("boot", `${result.reason}: ${result.detail}`)
			return
		}
		// OPFS is a hard boot requirement — probed here as its own explicit step so a failure maps to
		// the dedicated `opfs` reason immediately, rather than surfacing later as a generic
		// async-runtime failure the first time resumeSession/restorePersistedQueries below happens to
		// touch storage lazily.
		try {
			await storage()
		} catch (e) {
			if (!isOpfsUnavailableError(e)) {
				throw e
			}
			setError("opfs", asErrorDTO(e))
			log.error("boot", "opfs unavailable", e)
			return
		}
		// Resume a persisted session into the worker BEFORE the gate flips to ready: guards observe
		// readiness via whenBootReady() and then read hasClient(), so the client must already be
		// injected. Self-heals an invalid blob; a missing one just leaves the tab unauthed.
		// Runs BEFORE the query-cache restore below — resumeSession only touches kv + the already-
		// booted worker, nothing about the query cache — so the restore can be gated on whether this
		// boot is actually authed.
		const resumed = await resumeSession()
		if (resumed) {
			// Warm the query cache from disk once per boot, before the first render that reads it
			// (best-effort — never rejects; a failed restore just means an empty cache).
			await restorePersistedQueries(queryClient)
		} else {
			// An unauthed boot must not resurrect a leftover rq.v1-* row (e.g. a cross-tab
			// logout/persister-write race) into the cache, where it would flash under whatever
			// account signs in next — wipe instead of restoring.
			await purgePersistedQueries()
		}
		// Async-runtime health check: boot success ≠ health. Gated to dev so a transient probe failure
		// can't block first paint in production/preview, where real ops exercise the runtime anyway.
		if (import.meta.env.DEV) {
			await sdkApi.probeAsync()
		}
		setReady()
		log.info("boot", `ready (${String(result.threads)} threads)`)
	} catch (e) {
		setError("async-runtime", asErrorDTO(e))
		log.error("boot", "boot/probe threw", e)
	} finally {
		// Every exit path settles the gate: ready, boot-not-ok, or a thrown boot — guards never hang.
		signalBootReady()
	}
}
