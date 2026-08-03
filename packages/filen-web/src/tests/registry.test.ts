import { beforeEach, describe, expect, it, vi } from "vitest"
import { type } from "arktype"

// registry.ts is a Map-backed singleton (registered actions + a one-shot overrides load) —
// `vi.resetModules()` + a dynamic re-import before every test gives each test its own fresh
// instance instead of fighting shared state (duplicate-id / comboFor / setUserCombo would
// otherwise collide on the same in-memory Map across `it()` blocks). The mock boundary is
// `@/lib/storage/adapter` itself — registry.ts's only two calls into storage — mirroring how
// src/queries/persist.test.ts mocks the same module at the functions its own subject actually
// calls, rather than reaching one layer deeper into `@/lib/storage/leader` like adapter.test.ts
// does (that layer is irrelevant here; kvGetJson/kvSetJson's own envelope+schema contract is
// already covered by adapter.test.ts, not re-tested through this mock).
const { kvStore, mockState } = vi.hoisted(() => ({
	kvStore: new Map<string, unknown>(),
	mockState: { rejectNextGet: null as Error | null }
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => {
		if (mockState.rejectNextGet) {
			const error = mockState.rejectNextGet
			mockState.rejectNextGet = null
			return Promise.reject(error)
		}

		return Promise.resolve(kvStore.get(key) ?? null)
	},
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)
		return Promise.resolve()
	}
}))

const OVERRIDES_KEY = "keymap.v1.overrides"

function actionDef(id: string, defaultCombo = "k") {
	return { id, defaultCombo, scope: "global" as const, descriptionKey: "common:toggleTheme" as const }
}

async function freshRegistry() {
	vi.resetModules()
	return import("@/lib/keymap/registry")
}

// useAction reads the registry's recording session through a module-level import, so it has to be
// imported AFTER the same vi.resetModules() — a static top-of-file import would bind a DIFFERENT
// registry instance than beginRecording mutates and every assertion below would pass vacuously.
async function freshKeymap() {
	vi.resetModules()
	const registry = await import("@/lib/keymap/registry")
	const { shouldIgnoreEvent } = await import("@/lib/keymap/useAction")

	return { ...registry, shouldIgnoreEvent }
}

beforeEach(() => {
	kvStore.clear()
	mockState.rejectNextGet = null
})

describe("keymap registry", () => {
	it("comboFor returns an action's default combo once registered", async () => {
		const { registerAction, comboFor } = await freshRegistry()

		registerAction(actionDef("app.test"))

		expect(comboFor("app.test")).toBe("k")
	})

	it("bindings work immediately with defaults, before the async overrides load resolves", async () => {
		const { registerAction, comboFor } = await freshRegistry()

		registerAction(actionDef("app.test"))

		// deliberately not awaiting keymapOverridesLoaded() — this is the synchronous, pre-load state.
		expect(comboFor("app.test")).toBe("k")
	})

	it("throws for an unregistered action id", async () => {
		const { comboFor } = await freshRegistry()

		expect(() => comboFor("app.unknown")).toThrow(/unknown action/)
	})

	it("throws when the same action id is registered twice", async () => {
		const { registerAction } = await freshRegistry()
		const def = actionDef("app.test")

		registerAction(def)

		expect(() => {
			registerAction(def)
		}).toThrow(/already registered/)
	})

	it("comboFor prefers a runtime user override over the default combo", async () => {
		const { registerAction, comboFor, setUserCombo, keymapOverridesLoaded } = await freshRegistry()

		registerAction(actionDef("app.test"))
		await keymapOverridesLoaded()
		await setUserCombo("app.test", "shift+k")

		expect(comboFor("app.test")).toBe("shift+k")
	})

	it("setUserCombo persists the full overrides record at the versioned kv key", async () => {
		const { registerAction, setUserCombo, keymapOverridesLoaded } = await freshRegistry()

		registerAction(actionDef("app.test"))
		await keymapOverridesLoaded()
		await setUserCombo("app.test", "shift+k")

		expect(kvStore.get(OVERRIDES_KEY)).toEqual({ "app.test": "shift+k" })
	})

	it("setUserCombo merges onto a persisted override even when called before the load is awaited", async () => {
		// The race the load-first guard closes: a stored override plus a remap issued before anyone has
		// awaited the load. setUserCombo must load-then-merge, so BOTH entries survive in the persisted
		// record — not just the freshly-set one clobbering the stored one.
		kvStore.set(OVERRIDES_KEY, { "app.existing": "ctrl+e" })

		const { registerAction, setUserCombo } = await freshRegistry()

		registerAction(actionDef("app.existing"))
		registerAction(actionDef("app.other"))

		// deliberately NOT awaiting keymapOverridesLoaded() first — setUserCombo owns that ordering now.
		await setUserCombo("app.other", "shift+o")

		expect(kvStore.get(OVERRIDES_KEY)).toEqual({ "app.existing": "ctrl+e", "app.other": "shift+o" })
	})

	it("applies a valid persisted override on load, ahead of the default combo", async () => {
		kvStore.set(OVERRIDES_KEY, { "app.test": "ctrl+k" })

		const { registerAction, comboFor, keymapOverridesLoaded } = await freshRegistry()

		registerAction(actionDef("app.test"))
		await keymapOverridesLoaded()

		expect(comboFor("app.test")).toBe("ctrl+k")
	})

	it("drops a missing/invalid persisted overrides value without throwing; defaults win", async () => {
		// kvGetJson's own documented contract (adapter.test.ts) collapses BOTH "no value at this
		// key yet" and "schema-invalid/corrupt value" to a plain `null` — this mock returns exactly
		// that (nothing seeded at OVERRIDES_KEY), so this test exercises the registry's half of that
		// contract: a null load result must never throw and must never touch the default combo.
		const { registerAction, comboFor, keymapOverridesLoaded } = await freshRegistry()

		registerAction(actionDef("app.test"))
		await keymapOverridesLoaded()

		expect(comboFor("app.test")).toBe("k")
	})

	it("a rejected kv read never breaks the keymap; defaults still win", async () => {
		mockState.rejectNextGet = new Error("storage unavailable")

		const { registerAction, comboFor, keymapOverridesLoaded } = await freshRegistry()
		registerAction(actionDef("app.test"))

		await expect(keymapOverridesLoaded()).resolves.toBeUndefined()
		expect(comboFor("app.test")).toBe("k")
	})

	it("keymapOverridesSchema accepts a record of non-empty combo strings", async () => {
		const { keymapOverridesSchema } = await freshRegistry()

		expect(keymapOverridesSchema({ "app.test": "shift+d" })).toEqual({ "app.test": "shift+d" })
	})

	it('keymapOverridesSchema rejects an empty-string combo (the "string > 0" length constraint)', async () => {
		const { keymapOverridesSchema } = await freshRegistry()

		expect(keymapOverridesSchema({ "app.test": "" })).toBeInstanceOf(type.errors)
	})

	it("keymapOverridesSchema rejects a non-string combo value", async () => {
		const { keymapOverridesSchema } = await freshRegistry()

		expect(keymapOverridesSchema({ "app.test": 123 })).toBeInstanceOf(type.errors)
	})
})

describe("keymap registry — clearUserCombo", () => {
	it("drops only the target override and leaves the action resolving to its default", async () => {
		const { registerAction, comboFor, setUserCombo, clearUserCombo } = await freshRegistry()

		registerAction(actionDef("app.test"))
		registerAction(actionDef("app.other"))
		await setUserCombo("app.test", "shift+k")
		await setUserCombo("app.other", "shift+o")
		await clearUserCombo("app.test")

		expect(comboFor("app.test")).toBe("k")
		expect(comboFor("app.other")).toBe("shift+o")
	})

	it("persists the remaining overrides at the versioned kv key", async () => {
		const { registerAction, setUserCombo, clearUserCombo } = await freshRegistry()

		registerAction(actionDef("app.test"))
		registerAction(actionDef("app.other"))
		await setUserCombo("app.test", "shift+k")
		await setUserCombo("app.other", "shift+o")
		await clearUserCombo("app.test")

		expect(kvStore.get(OVERRIDES_KEY)).toEqual({ "app.other": "shift+o" })
	})

	it("is a no-op for an id with no override", async () => {
		const { registerAction, comboFor, setUserCombo, clearUserCombo } = await freshRegistry()

		registerAction(actionDef("app.test"))
		await setUserCombo("app.test", "shift+k")
		await clearUserCombo("app.unbound")

		expect(comboFor("app.test")).toBe("shift+k")
		expect(kvStore.get(OVERRIDES_KEY)).toEqual({ "app.test": "shift+k" })
	})
})

// Invariant R: at most ONE combo recording exists app-wide, identified by its owner token, and only
// its owner can end it. Two <ShortcutsList> instances can be mounted at once (the shortcuts dialog
// opens on top of Settings → Keyboard), so a shared boolean would let the second one's unmount clear
// a session the first started — a live recorder AND live hotkeys, exactly what the session prevents.
describe("keymap registry — combo recording session", () => {
	it("starts with no session", async () => {
		const { isRecordingCombo } = await freshRegistry()

		expect(isRecordingCombo()).toBe(false)
	})

	it("carries the action being rebound, so the surface holds no session state of its own", async () => {
		const { beginRecording, currentRecording } = await freshRegistry()

		beginRecording("a", "app.test")

		expect(currentRecording()).toEqual({ owner: "a", actionId: "app.test" })
	})

	it("beginRecording claims the session", async () => {
		const { beginRecording, isRecordingCombo } = await freshRegistry()

		beginRecording("a", "app.test")

		expect(isRecordingCombo()).toBe(true)
	})

	it("endRecording from a non-owner is a no-op", async () => {
		const { beginRecording, endRecording, isRecordingCombo } = await freshRegistry()

		beginRecording("a", "app.test")
		endRecording("b")

		expect(isRecordingCombo()).toBe(true)
	})

	it("endRecording from the owner ends the session", async () => {
		const { beginRecording, endRecording, isRecordingCombo } = await freshRegistry()

		beginRecording("a", "app.test")
		endRecording("a")

		expect(isRecordingCombo()).toBe(false)
	})

	it("a second beginRecording displaces the owner, leaving exactly one session", async () => {
		const { beginRecording, endRecording, isRecordingCombo } = await freshRegistry()

		beginRecording("a", "app.test")
		beginRecording("b", "app.other")
		endRecording("a")

		expect(isRecordingCombo()).toBe(true)

		endRecording("b")

		expect(isRecordingCombo()).toBe(false)
	})

	it("clearRecording ends a session owned by anyone", async () => {
		const { beginRecording, clearRecording, isRecordingCombo } = await freshRegistry()

		beginRecording("a", "app.test")
		clearRecording()

		expect(isRecordingCombo()).toBe(false)
	})

	it("rejectRecording ends the owner's session and records which action holds the combo", async () => {
		const { beginRecording, rejectRecording, isRecordingCombo, currentRecordingRejection } = await freshRegistry()

		beginRecording("a", "app.test")
		rejectRecording("a", "common:toggleTheme")

		expect(isRecordingCombo()).toBe(false)
		expect(currentRecordingRejection()).toEqual({ actionId: "app.test", conflictKey: "common:toggleTheme" })
	})

	it("rejectRecording from a non-owner changes nothing", async () => {
		const { beginRecording, rejectRecording, isRecordingCombo, currentRecordingRejection } = await freshRegistry()

		beginRecording("a", "app.test")
		rejectRecording("b", "common:toggleTheme")

		expect(isRecordingCombo()).toBe(true)
		expect(currentRecordingRejection()).toBeNull()
	})

	it("retires a rejection once the rebound action's combo changes", async () => {
		const { registerAction, beginRecording, rejectRecording, setUserCombo, clearUserCombo, currentRecordingRejection } =
			await freshRegistry()

		registerAction(actionDef("app.test"))
		beginRecording("a", "app.test")
		rejectRecording("a", "common:toggleTheme")
		await setUserCombo("app.test", "shift+k")

		expect(currentRecordingRejection()).toBeNull()

		beginRecording("a", "app.test")
		rejectRecording("a", "common:toggleTheme")
		await clearUserCombo("app.test")

		expect(currentRecordingRejection()).toBeNull()
	})

	it("starting a new recording clears a pending rejection", async () => {
		const { beginRecording, rejectRecording, currentRecordingRejection } = await freshRegistry()

		beginRecording("a", "app.test")
		rejectRecording("a", "common:toggleTheme")
		beginRecording("a", "app.other")

		expect(currentRecordingRejection()).toBeNull()
	})
})

// The guard the session exists for, asserted at the exact shape useHotkeys consumes it in
// (useAction's DEFAULT_OPTIONS.ignoreEventWhen).
describe("useAction — shouldIgnoreEvent", () => {
	it("lets a normal keypress through", async () => {
		const { shouldIgnoreEvent } = await freshKeymap()

		expect(shouldIgnoreEvent({ repeat: false })).toBe(false)
	})

	it("ignores an OS autorepeat tick", async () => {
		const { shouldIgnoreEvent } = await freshKeymap()

		expect(shouldIgnoreEvent({ repeat: true })).toBe(true)
	})

	it("ignores every keypress while any owner is recording a combo", async () => {
		const { beginRecording, endRecording, shouldIgnoreEvent } = await freshKeymap()

		beginRecording("a", "app.test")

		expect(shouldIgnoreEvent({ repeat: false })).toBe(true)

		endRecording("a")

		expect(shouldIgnoreEvent({ repeat: false })).toBe(false)
	})
})
