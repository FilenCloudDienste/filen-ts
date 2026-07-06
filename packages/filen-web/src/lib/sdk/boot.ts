import { sdkApi, threadCount } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { useBootStore } from "@/stores/boot"
import { queryClient } from "@/queries/client"
import { restorePersistedQueries } from "@/queries/persist"
import { log } from "@/lib/log"

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
		// Warm the query cache from disk once per boot, before the first render that reads it
		// (best-effort — never rejects; a failed restore just means an empty cache).
		await restorePersistedQueries(queryClient)
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
	}
}
