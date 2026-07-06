import { type } from "arktype"
import type { StringifiedClient } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { parseEnvelope, stringifyEnvelope } from "@/lib/serialize"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { comboFor, setUserCombo } from "@/lib/keymap/registry"
import { SESSION_KV_KEY } from "@/lib/sdk/session"
import { useBootStore } from "@/stores/boot"
import { log } from "@/lib/log"

// Test-only hooks, loaded ONLY when the app is built with VITE_E2E=1 (a dynamic import behind that
// env condition in main.tsx, so a normal build dead-code-eliminates this whole module — proven by
// the no-flag build grep). Nothing here ships to production.
//
// The e2e harness never types credentials or the session blob into the UI: it logs in once
// (`mint`), stores the resulting blob to a file, and re-seeds it on later loads via sessionStorage,
// which `seedFromSlot` moves into the worker + kv through the app's own code paths. The blob carries
// a bigint (`StringifiedClient.userId`), so it always travels as an envelope STRING (@/lib/serialize),
// never raw JSON.

const SESSION_SLOT = "filen.e2e.session"

// Test kv probes go through the normal adapter, which requires an arktype schema on read.
const stringSchema = type("string")

interface E2eHooks {
	// Logs in and returns the session blob as an envelope string (bigint-safe, ready to persist).
	mint: (email: string, password: string) => Promise<string>
	// A single authenticated read against the API — proves an injected session actually authenticates.
	probeAuthedRead: () => Promise<boolean>
	kvSet: (key: string, value: string) => Promise<void>
	kvGet: (key: string) => Promise<string | null>
	setUserCombo: (actionId: string, combo: string) => Promise<void>
	comboFor: (actionId: string) => string
}

// Minimal shape of the TanStack router main.tsx hands in — enough to re-run route guards after the
// session is injected. `to` is narrowed to the one route the hook navigates to ("/") so the real,
// strictly-typed router is structurally assignable here without a cast at the call site.
interface RouterLike {
	navigate: (opts: { to: "/" }) => Promise<unknown>
}

declare global {
	interface Window {
		__filenE2E?: E2eHooks
	}
}

type BootSnapshot = ReturnType<typeof useBootStore.getState>

// Resolves once the SDK worker boot reaches "ready" (wasm init + thread pool up, required before
// injectClient/login run); rejects if boot fails, so callers surface the failure instead of hanging.
function whenBootReady(): Promise<void> {
	return new Promise((resolve, reject) => {
		function settle(state: BootSnapshot): void {
			if (state.phase === "ready") {
				unsub()
				resolve()
			} else if (state.phase === "error") {
				unsub()
				reject(new Error(`boot failed before ready: ${state.reason ?? "unknown"}`))
			}
		}

		// zustand's subscribe never invokes the listener synchronously, so `unsub` is always assigned
		// before `settle` first runs (the manual call below, or any later store change).
		const unsub = useBootStore.subscribe(settle)

		settle(useBootStore.getState())
	})
}

// If a session blob was seeded into sessionStorage (by the injection fixture), move it into the
// worker (so `hasClient()` reports authed) and persist it through the normal kv session-save path,
// then clear the one-shot slot and re-run the route guards. The guards resolve `hasClient()` long
// before this async injection completes, so the app first lands unauthed; a client-side navigation
// (never a reload — that would drop the just-injected worker state) mirrors the real post-login
// transition and lets the authed shell render.
async function seedFromSlot(router: RouterLike): Promise<void> {
	const raw = sessionStorage.getItem(SESSION_SLOT)

	if (raw === null) {
		return
	}

	sessionStorage.removeItem(SESSION_SLOT)

	await whenBootReady()

	const blob = parseEnvelope(raw) as StringifiedClient

	await sdkApi.injectClient(blob)
	await kvSetJson(SESSION_KV_KEY, blob)
	await router.navigate({ to: "/" })
}

export function installE2eHooks(router: RouterLike): void {
	window.__filenE2E = {
		mint: async (email, password) => {
			await whenBootReady()

			return stringifyEnvelope(await sdkApi.login({ email, password }))
		},
		probeAuthedRead: () => sdkApi.probeAuthedRead(),
		kvSet: (key, value) => kvSetJson(key, value),
		kvGet: key => kvGetJson(key, stringSchema),
		setUserCombo: (actionId, combo) => setUserCombo(actionId, combo),
		comboFor: actionId => comboFor(actionId)
	}

	void seedFromSlot(router).catch((e: unknown) => {
		log.error("e2e", "session seed failed", e)
	})
}
