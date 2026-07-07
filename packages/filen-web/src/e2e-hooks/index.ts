import { type } from "arktype"
import type { StringifiedClient } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { parseEnvelope, stringifyEnvelope } from "@/lib/serialize"
import { kvGetJson, kvHas, kvSetJson } from "@/lib/storage/adapter"
import { comboFor, setUserCombo } from "@/lib/keymap/registry"
import { persistSession, resumeSession } from "@/lib/sdk/session"
import { whenBootReady } from "@/lib/sdk/boot"
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
	// Documented fallback for auth-setup's real-form login (see auth.setup.ts) — kept working in case
	// the form path ever proves too flaky to drive from Playwright.
	mint: (email: string, password: string) => Promise<string>
	// Re-stringifies the WORKER'S currently-live client (not the kv copy — see dumpSession) into the
	// same envelope-string shape mint returns. Used by auth-setup to harvest the session after driving
	// the real login form, so the harness gets genuine UI coverage from the one login the budget allows.
	dumpSession: () => Promise<string>
	// A single authenticated read against the API — proves an injected session actually authenticates.
	probeAuthedRead: () => Promise<boolean>
	kvSet: (key: string, value: string) => Promise<void>
	kvGet: (key: string) => Promise<string | null>
	// Raw existence check, independent of schema — kvGet/kvGetJson return null for BOTH "absent" and
	// "present but the wrong shape for the schema this hook happens to validate with", which makes
	// kvGet useless for proving a key is genuinely gone (e.g. asserting a wipe) unless the caller also
	// holds that exact schema. Used by auth.spec's logout test to check the session key without
	// depending on sessionSchema.
	kvHas: (key: string) => Promise<boolean>
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

// If a session blob was seeded into sessionStorage (by the injection fixture), drive it through the
// PRODUCTION session path — persist to kv, then resume (validate → inject into the worker) — so the
// harness exercises the real save/restore round-trip rather than a bespoke write. Then clear the
// one-shot slot and re-run the route guards. On this first seeded load the guards ran during boot
// (kv still empty) and landed unauthed; a client-side navigation (never a reload — that would drop
// the just-injected worker state) mirrors the real post-login transition and lets the authed shell
// render. On a later reload the blob is already in kv, so bootSdk's own resumeSession authenticates
// before the guards read hasClient() — no navigation needed.
async function seedFromSlot(router: RouterLike): Promise<void> {
	const raw = sessionStorage.getItem(SESSION_SLOT)

	if (raw === null) {
		return
	}

	sessionStorage.removeItem(SESSION_SLOT)

	await whenBootReady()

	const blob = parseEnvelope(raw) as StringifiedClient

	await persistSession(blob)
	await resumeSession()
	await router.navigate({ to: "/" })
}

export function installE2eHooks(router: RouterLike): void {
	window.__filenE2E = {
		mint: async (email, password) => {
			await whenBootReady()

			return stringifyEnvelope(await sdkApi.login({ email, password }))
		},
		dumpSession: async () => {
			await whenBootReady()

			return stringifyEnvelope(await sdkApi.toStringified())
		},
		probeAuthedRead: () => sdkApi.probeAuthedRead(),
		kvSet: (key, value) => kvSetJson(key, value),
		kvGet: key => kvGetJson(key, stringSchema),
		kvHas: key => kvHas(key),
		setUserCombo: (actionId, combo) => setUserCombo(actionId, combo),
		comboFor: actionId => comboFor(actionId)
	}

	void seedFromSlot(router).catch((e: unknown) => {
		log.error("e2e", "session seed failed", e)
	})
}
