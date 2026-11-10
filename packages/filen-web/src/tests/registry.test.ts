import { beforeEach, describe, expect, it, vi } from "vitest"
import { type } from "arktype"

// registry.ts is a module singleton (registered actions, one loaded record, a write chain) — `vi.resetModules()` + a
// dynamic re-import before every test gives each test its own instance. The mock boundary is `@/lib/storage/adapter`,
// the kv calls lib/keymap/storage.ts makes; adapter.test.ts covers their own envelope and schema contract.
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
	},
	kvDelete: (key: string) => {
		kvStore.delete(key)
		return Promise.resolve()
	},
	kvEntriesJson: (prefix: string) => Promise.resolve([...kvStore.entries()].filter(([key]) => key.startsWith(prefix)))
}))

const UNCLAIMED = "keymap.v2.unclaimed"
const LEGACY = "keymap.v1.overrides"

function actionDef(id: string, defaultCombo = "k") {
	return { id, defaultCombo, scope: "global" as const, descriptionKey: "common:toggleTheme" as const }
}

function record(overrides: Record<string, string>, characterKeys = true) {
	return { overrides, characterKeys }
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
	it("comboFor returns an action's default combo once registered, before the load resolves", async () => {
		const { registerAction, comboFor } = await freshRegistry()

		kvStore.set(UNCLAIMED, record({ "app.test": "shift+k" }))
		registerAction(actionDef("app.test"))

		expect(comboFor("app.test")).toBe("k")
	})

	it("throws for an unregistered action id and for a duplicate registration", async () => {
		const { registerAction, comboFor } = await freshRegistry()

		registerAction(actionDef("app.test"))

		expect(() => comboFor("app.unknown")).toThrow(/unknown action/)
		expect(() => {
			registerAction(actionDef("app.test"))
		}).toThrow(/already registered/)
	})

	it("applies a stored record on load", async () => {
		const { registerAction, comboFor, keymapOverridesLoaded } = await freshRegistry()

		kvStore.set(UNCLAIMED, record({ "app.test": "ctrl+k" }))
		registerAction(actionDef("app.test"))
		await keymapOverridesLoaded()

		expect(comboFor("app.test")).toBe("ctrl+k")
	})

	it("migrates an older record's character spellings to the token model on load and keeps the unbound marker", async () => {
		const { registerAction, comboFor, keymapOverridesLoaded } = await freshRegistry()

		kvStore.set(UNCLAIMED, record({ "app.shrink": "mod+shift+,", "app.zoom": "mod+=", "app.broken": "a>b", "app.off": "none" }))

		for (const id of ["app.shrink", "app.zoom", "app.broken", "app.off"]) registerAction(actionDef(id))

		await keymapOverridesLoaded()

		expect(comboFor("app.shrink")).toBe("mod+shift+comma")
		expect(comboFor("app.zoom")).toBe("mod+equal")
		expect(comboFor("app.broken")).toBe("k")
		expect(comboFor("app.off")).toBe("")
	})

	it("drops an invalid stored record and a rejected read without breaking: defaults win", async () => {
		const { registerAction, comboFor, keymapOverridesLoaded } = await freshRegistry()

		mockState.rejectNextGet = new Error("opfs gone")
		registerAction(actionDef("app.test"))
		await keymapOverridesLoaded()

		expect(comboFor("app.test")).toBe("k")
	})

	it("setUserCombo stores the canonical combo in one record with the single-key switch", async () => {
		const { registerAction, comboFor, setUserCombo } = await freshRegistry()

		registerAction(actionDef("app.test"))
		await setUserCombo("app.test", "shift+.")

		expect(comboFor("app.test")).toBe("shift+period")
		expect(kvStore.get(UNCLAIMED)).toEqual(record({ "app.test": "shift+period" }))
	})

	it("stores nothing for a combo equal to the default, so the action reads as unchanged", async () => {
		const { registerAction, setUserCombo } = await freshRegistry()

		registerAction(actionDef("app.test"))
		await setUserCombo("app.test", "shift+k")
		await setUserCombo("app.test", "k")

		expect(kvStore.get(UNCLAIMED)).toEqual(record({}))
	})

	it("refuses a string that holds no combo, writing nothing", async () => {
		const { registerAction, setUserCombo } = await freshRegistry()

		registerAction(actionDef("app.test"))

		await expect(setUserCombo("app.test", "a>b")).rejects.toThrow(/no combo/)
		expect(kvStore.has(UNCLAIMED)).toBe(false)
	})

	it("merges a write onto what another tab stored after this one loaded", async () => {
		const { registerAction, setUserCombo, keymapOverridesLoaded } = await freshRegistry()

		registerAction(actionDef("app.mine"))
		registerAction(actionDef("app.theirs"))
		await keymapOverridesLoaded()
		kvStore.set(UNCLAIMED, record({ "app.theirs": "shift+t" }))
		await setUserCombo("app.mine", "shift+m")

		expect(kvStore.get(UNCLAIMED)).toEqual(record({ "app.theirs": "shift+t", "app.mine": "shift+m" }))
	})

	it("clearUserCombo drops only its own entry", async () => {
		const { registerAction, comboFor, setUserCombo, clearUserCombo } = await freshRegistry()

		registerAction(actionDef("app.test"))
		registerAction(actionDef("app.other"))
		await setUserCombo("app.test", "shift+k")
		await setUserCombo("app.other", "shift+o")
		await clearUserCombo("app.test")

		expect(comboFor("app.test")).toBe("k")
		expect(comboFor("app.other")).toBe("shift+o")
		expect(kvStore.get(UNCLAIMED)).toEqual(record({ "app.other": "shift+o" }))
	})

	it("keymapOverridesSchema accepts non-empty combo strings only", async () => {
		const { keymapOverridesSchema } = await freshRegistry()

		expect(keymapOverridesSchema({ "app.test": "shift+d" })).toEqual({ "app.test": "shift+d" })
		expect(keymapOverridesSchema({ "app.test": "" })).toBeInstanceOf(type.errors)
		expect(keymapOverridesSchema({ "app.test": 123 })).toBeInstanceOf(type.errors)
	})
})

describe("keymap registry — turning an action off", () => {
	it("stores the unbound marker, which every reader resolves to no key", async () => {
		const { registerAction, comboFor, bindingsOf, currentKeymapRecord, unbindAction } = await freshRegistry()
		const { parseCombo, matchesCombo, UNBOUND_COMBO } = await import("@filen/shared/keymap")

		registerAction(actionDef("app.test", "d"))
		await unbindAction("app.test")

		expect(kvStore.get(UNCLAIMED)).toEqual(record({ "app.test": UNBOUND_COMBO }))
		expect(comboFor("app.test")).toBe("")
		expect(bindingsOf(currentKeymapRecord())["app.test"]).toBe("")
		// A matcher handed the raw stored value (the office editors, CodeMirror, the desktop menu) sees no key either.
		expect(parseCombo(UNBOUND_COMBO)).toEqual([])
		expect(
			matchesCombo({ code: "KeyN", key: "n", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, UNBOUND_COMBO, false)
		).toBe(false)
	})

	it("stores nothing when the action ships unassigned, and reset brings a turned-off action back", async () => {
		const { registerAction, comboFor, unbindAction, clearUserCombo } = await freshRegistry()

		registerAction(actionDef("app.unset", ""))
		registerAction(actionDef("app.test", "d"))
		await unbindAction("app.unset")
		await unbindAction("app.test")
		await clearUserCombo("app.test")

		expect(kvStore.get(UNCLAIMED)).toEqual(record({}))
		expect(comboFor("app.test")).toBe("d")
	})
})

describe("keymap registry — single-key shortcuts", () => {
	it("drops character keys from the combos in effect while switched off, keeping modifier chords and named keys", async () => {
		const { registerAction, comboFor, setCharacterKeys } = await freshRegistry()

		registerAction(actionDef("app.theme", "d"))
		registerAction(actionDef("app.help", "shift+slash"))
		registerAction(actionDef("app.trash", "delete,backspace,t"))
		registerAction(actionDef("app.save", "mod+s"))
		await setCharacterKeys(false)

		expect(comboFor("app.theme")).toBe("")
		expect(comboFor("app.help")).toBe("")
		expect(comboFor("app.trash")).toBe("delete,backspace")
		expect(comboFor("app.save")).toBe("mod+s")
		expect(kvStore.get(UNCLAIMED)).toEqual(record({}, false))

		await setCharacterKeys(true)

		expect(comboFor("app.theme")).toBe("d")
	})

	it("keeps an exempt action's character keys (the running slideshow)", async () => {
		const { registerAction, comboFor, setCharacterKeys } = await freshRegistry()

		registerAction({ ...actionDef("app.next", "n,arrowright"), keepsCharacterKeys: true })
		await setCharacterKeys(false)

		expect(comboFor("app.next")).toBe("n,arrowright")
	})
})

describe("keymap registry — reset", () => {
	it("resets every override, or one group's, in a single write", async () => {
		const { registerAction, comboFor, updateOverrides, resetOverrides } = await freshRegistry()

		for (const id of ["app.a", "app.b", "app.c"]) registerAction(actionDef(id))

		await updateOverrides({ "app.a": "shift+a", "app.b": "shift+b", "app.c": "shift+c" })
		await resetOverrides(["app.a", "app.b"])

		expect(comboFor("app.a")).toBe("k")
		expect(comboFor("app.c")).toBe("shift+c")

		await resetOverrides()

		expect(kvStore.get(UNCLAIMED)).toEqual(record({}))
	})

	it("keeps the single-key switch through a reset", async () => {
		const { registerAction, setCharacterKeys, setUserCombo, resetOverrides } = await freshRegistry()

		registerAction(actionDef("app.a"))
		await setCharacterKeys(false)
		await setUserCombo("app.a", "shift+a")
		await resetOverrides()

		expect(kvStore.get(UNCLAIMED)).toEqual(record({}, false))
	})
})

describe("keymap registry — per-platform defaults", () => {
	const def = {
		...actionDef("app.settings", ""),
		platformDefaults: [
			{ on: { mac: true, desktop: true }, combo: "mod+comma" },
			{ on: { desktop: true }, combo: "ctrl+comma" }
		]
	}

	it("picks the first matching default, else the base one", async () => {
		const { defaultComboOn } = await freshRegistry()

		expect(defaultComboOn(def, { mac: true, desktop: true })).toBe("mod+comma")
		expect(defaultComboOn(def, { mac: false, desktop: true })).toBe("ctrl+comma")
		expect(defaultComboOn(def, { mac: true, desktop: false })).toBe("")
		expect(defaultComboOn(def, { mac: false, desktop: false })).toBe("")
	})

	it("resolves the configured and the effective combo per platform", async () => {
		const { configuredCombo, effectiveCombo } = await freshRegistry()

		expect(configuredCombo(def, {}, { mac: true, desktop: true })).toBe("mod+comma")
		expect(configuredCombo(def, { "app.settings": "none" }, { mac: true, desktop: true })).toBe("")
		expect(effectiveCombo(def, record({ "app.settings": "s,mod+s" }, false), { mac: false, desktop: false })).toBe("mod+s")
	})
})

describe("keymap registry — accounts", () => {
	it("reads and writes the signed-in account's own record", async () => {
		const { registerAction, comboFor, bindKeymapAccount, setUserCombo } = await freshRegistry()

		kvStore.set("keymap.v2.account.42", record({ "app.test": "shift+x" }))
		registerAction(actionDef("app.test"))
		await bindKeymapAccount("42")

		expect(comboFor("app.test")).toBe("shift+x")

		await setUserCombo("app.test", "shift+y")

		expect(kvStore.get("keymap.v2.account.42")).toEqual(record({ "app.test": "shift+y" }))
		expect(kvStore.has(UNCLAIMED)).toBe(false)
	})

	it("adopts the unclaimed record on an account's first sign-in, then removes it", async () => {
		const { registerAction, comboFor, bindKeymapAccount } = await freshRegistry()

		kvStore.set(UNCLAIMED, record({ "app.test": "shift+u" }, false))
		registerAction(actionDef("app.test"))
		await bindKeymapAccount("7")

		expect(comboFor("app.test")).toBe("")
		expect(kvStore.get("keymap.v2.account.7")).toEqual(record({ "app.test": "shift+u" }, false))
		expect(kvStore.has(UNCLAIMED)).toBe(false)
	})

	it("adopts the previous format's overrides", async () => {
		const { registerAction, comboFor, bindKeymapAccount } = await freshRegistry()

		kvStore.set(LEGACY, { "app.test": "mod+=" })
		registerAction(actionDef("app.test"))
		await bindKeymapAccount("7")

		expect(comboFor("app.test")).toBe("mod+equal")
		expect(kvStore.has(LEGACY)).toBe(false)
	})

	it("gives a second account on this browser the defaults, not the first one's keys", async () => {
		const { registerAction, comboFor, bindKeymapAccount } = await freshRegistry()

		kvStore.set("keymap.v2.account.1", record({ "app.test": "shift+one" }))
		registerAction(actionDef("app.test"))
		await bindKeymapAccount("2")

		expect(comboFor("app.test")).toBe("k")
	})

	it("keeps every account's record across the sign-out wipe and nothing else", async () => {
		const { keepKeymapsAcrossWipe } = await import("@/lib/keymap/storage")

		kvStore.set("keymap.v2.account.1", record({ "app.test": "shift+a" }))
		kvStore.set("keymap.v2.account.2", record({}, false))
		kvStore.set(UNCLAIMED, record({ "app.test": "shift+u" }))
		kvStore.set("session", "secret")

		await keepKeymapsAcrossWipe(() => {
			kvStore.clear()

			return Promise.resolve()
		})

		expect([...kvStore.keys()].sort()).toEqual(["keymap.v2.account.1", "keymap.v2.account.2"])
		expect(kvStore.get("keymap.v2.account.1")).toEqual(record({ "app.test": "shift+a" }))
	})
})

describe("keymap registry — other tabs", () => {
	it("applies a change another tab makes to the same record, without a kv read", async () => {
		const first = await freshRegistry()

		first.registerAction(actionDef("app.test"))
		await first.keymapOverridesLoaded()

		const second = await freshRegistry()

		second.registerAction(actionDef("app.test"))
		await second.keymapOverridesLoaded()
		await first.setUserCombo("app.test", "shift+t")

		await vi.waitFor(() => {
			expect(second.comboFor("app.test")).toBe("shift+t")
		})
	})

	it("ignores a change to another account's record", async () => {
		const first = await freshRegistry()

		first.registerAction(actionDef("app.test"))
		await first.bindKeymapAccount("1")

		const second = await freshRegistry()

		second.registerAction(actionDef("app.test"))
		await second.bindKeymapAccount("2")
		await first.setUserCombo("app.test", "shift+t")
		// One round trip of the channel: a later post from the same tab arrives after the first.
		await first.setUserCombo("app.test", "shift+u")
		await new Promise(resolve => setTimeout(resolve, 20))

		expect(second.comboFor("app.test")).toBe("k")
	})
})

// The registry owns the recording session's whole lifecycle so the shortcuts surface holds none: two lists can be
// mounted at once (the dialog over Settings → Keyboard), and only the owner may end a session.
describe("keymap registry — combo recording session", () => {
	it("starts with no session and carries the action, the slot and the owner", async () => {
		const { beginRecording, currentRecording, isRecordingCombo } = await freshRegistry()

		expect(isRecordingCombo()).toBe(false)

		beginRecording("a", "app.test", 1)

		expect(currentRecording()).toEqual({ owner: "a", actionId: "app.test", slot: 1 })
	})

	it("endRecording from a non-owner is a no-op, from the owner ends it", async () => {
		const { beginRecording, endRecording, isRecordingCombo } = await freshRegistry()

		beginRecording("a", "app.test")
		endRecording("b")

		expect(isRecordingCombo()).toBe(true)

		endRecording("a")

		expect(isRecordingCombo()).toBe(false)
	})

	it("a problem report from the owner ends the session and keeps the problem; from another owner changes nothing", async () => {
		const { beginRecording, reportRecordingProblem, currentRecordingProblem, isRecordingCombo } = await freshRegistry()
		const problem = { kind: "reserved", actionId: "app.test", chord: "mod+w", owner: "browser", blocked: false } as const

		beginRecording("a", "app.test")
		reportRecordingProblem("b", problem)

		expect(currentRecordingProblem()).toBeNull()

		reportRecordingProblem("a", problem)

		expect(isRecordingCombo()).toBe(false)
		expect(currentRecordingProblem()).toEqual(problem)
	})

	it("retires a problem once its action's binding changes, and on a new recording or clearRecording", async () => {
		const { registerAction, beginRecording, reportRecordingProblem, setUserCombo, currentRecordingProblem, clearRecording } =
			await freshRegistry()
		const problem = { kind: "reserved", actionId: "app.test", chord: "mod+w", owner: "browser", blocked: true } as const

		registerAction(actionDef("app.test"))
		beginRecording("a", "app.test")
		reportRecordingProblem("a", problem)
		await setUserCombo("app.test", "shift+k")

		expect(currentRecordingProblem()).toBeNull()

		beginRecording("a", "app.test")
		reportRecordingProblem("a", problem)
		beginRecording("a", "app.test")

		expect(currentRecordingProblem()).toBeNull()

		reportRecordingProblem("a", problem)
		clearRecording()

		expect(currentRecordingProblem()).toBeNull()
	})
})

// The guard the session exists for, asserted at the exact shape useHotkeys consumes it in
// (useAction's DEFAULT_OPTIONS.ignoreEventWhen).
describe("useAction — shouldIgnoreEvent", () => {
	it("lets a normal keypress through", async () => {
		const { shouldIgnoreEvent } = await freshKeymap()

		expect(shouldIgnoreEvent({ repeat: false, key: "a" })).toBe(false)
	})

	it("ignores an OS autorepeat tick", async () => {
		const { shouldIgnoreEvent } = await freshKeymap()

		expect(shouldIgnoreEvent({ repeat: true, key: "a" })).toBe(true)
	})

	it("ignores every keypress while any owner is recording a combo", async () => {
		const { beginRecording, endRecording, shouldIgnoreEvent } = await freshKeymap()

		beginRecording("a", "app.test")

		expect(shouldIgnoreEvent({ repeat: false, key: "a" })).toBe(true)

		endRecording("a")

		expect(shouldIgnoreEvent({ repeat: false, key: "a" })).toBe(false)
	})

	it("ignores a character typed with AltGr", async () => {
		const { shouldIgnoreEvent } = await freshKeymap()
		const altGraph = (name: string): boolean => name === "AltGraph"

		expect(shouldIgnoreEvent({ repeat: false, key: "ó", getModifierState: altGraph })).toBe(true)
		expect(shouldIgnoreEvent({ repeat: false, key: "@", getModifierState: altGraph })).toBe(true)
		expect(shouldIgnoreEvent({ repeat: false, key: "o", getModifierState: altGraph })).toBe(false)
	})
})
