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
	return { id, defaultCombo, scope: "global" as const, descriptionKey: "toggleTheme" as const }
}

async function freshRegistry() {
	vi.resetModules()
	return import("@/lib/keymap/registry")
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

// drive.download (directoryListing.tsx's module-scope registration, mirrored here since registry.ts
// itself holds no concrete actions — every feature registers its own). Combos below mirror the app's
// REAL default registrations as of this task (directoryListing.tsx/newDirectory.tsx/
// themeProvider.tsx/iconRail.tsx) so a genuine collision would fail this test, not just a synthetic
// one.
describe("keymap registry — drive.download registration", () => {
	it("registers with its chosen default combo (mod+s)", async () => {
		const { registerAction, comboFor } = await freshRegistry()

		registerAction({ id: "drive.download", defaultCombo: "mod+s", scope: "drive", descriptionKey: "driveCommandDownload" })

		expect(comboFor("drive.download")).toBe("mod+s")
	})

	it("does not collide with any other registered default combo in the app", async () => {
		const { registerAction, comboFor } = await freshRegistry()

		// drive scope (directoryListing.tsx + newDirectory.tsx)
		registerAction({ id: "drive.selectAll", defaultCombo: "mod+a", scope: "drive", descriptionKey: "driveCommandSelectAll" })
		registerAction({ id: "drive.clearSelection", defaultCombo: "escape", scope: "drive", descriptionKey: "driveCommandClearSelection" })
		registerAction({ id: "drive.toggleView", defaultCombo: "v", scope: "drive", descriptionKey: "driveCommandToggleView" })
		registerAction({ id: "drive.rename", defaultCombo: "f2", scope: "drive", descriptionKey: "driveCommandRename" })
		registerAction({ id: "drive.trash", defaultCombo: "delete,backspace", scope: "drive", descriptionKey: "driveCommandTrash" })
		registerAction({ id: "drive.newDirectory", defaultCombo: "n", scope: "drive", descriptionKey: "driveCommandNewDirectory" })
		registerAction({ id: "drive.download", defaultCombo: "mod+s", scope: "drive", descriptionKey: "driveCommandDownload" })
		registerAction({ id: "drive.search", defaultCombo: "mod+f", scope: "drive", descriptionKey: "driveCommandSearch" })
		// global scope (themeProvider.tsx + iconRail.tsx) — scope isn't enforced yet (every action
		// fires unconditionally, see registry.ts's ActionScope comment), so these are live collision
		// candidates too, not just drive-scope ones.
		registerAction({ id: "app.toggleTheme", defaultCombo: "d", scope: "global", descriptionKey: "toggleTheme" })
		registerAction({ id: "app.openSettings", defaultCombo: "", scope: "global", descriptionKey: "settings" })

		const ids = [
			"drive.selectAll",
			"drive.clearSelection",
			"drive.toggleView",
			"drive.rename",
			"drive.trash",
			"drive.newDirectory",
			"drive.download",
			"drive.search",
			"app.toggleTheme",
			"app.openSettings"
		]
		// "" (openSettings' unbound default) is excluded from the collision check — an empty combo
		// isn't a real binding (keymapOverridesSchema itself rejects "" as a value), it just means
		// unbound-by-default.
		const combos = ids.map(comboFor).filter(combo => combo.length > 0)

		expect(new Set(combos).size).toBe(combos.length)
	})
})
