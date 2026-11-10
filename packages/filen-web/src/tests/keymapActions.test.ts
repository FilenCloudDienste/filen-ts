import { describe, expect, it, vi } from "vitest"

// actions.ts pulls registry.ts, whose only storage calls are these two — the same boundary stub every
// other keymap test uses.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

const { ALL_ACTIONS } = await import("@/lib/keymap/actions")
const { RESOLVED_COLLISIONS } = await import("@/lib/keymap/conflicts")
const { SHORTCUT_SCOPE_LABEL_KEYS } = await import("@/lib/keymap/shortcutsCatalog")
const { normalizeCombo } = await import("@filen/shared/keymap")

const PLATFORMS = [
	{ name: "a Mac", mac: true, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" },
	{ name: "Windows", mac: false, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
] as const

// The action set as a platform registers it: some defaults are per platform (the Mac's paragraph keys), read once at
// module load, so each platform gets its own module graph under its own user agent.
async function actionsOn(userAgent: string) {
	vi.resetModules()
	vi.stubGlobal("navigator", { userAgent })

	const actions = await import("@/lib/keymap/actions")
	const conflicts = await import("@/lib/keymap/conflicts")

	return { actions: actions.ALL_ACTIONS, conflictingActions: conflicts.conflictingActions }
}

function isAllowlisted(a: string, b: string): boolean {
	return RESOLVED_COLLISIONS.some(([first, second]) => (first === a && second === b) || (first === b && second === a))
}

// The colliding pairs among the defaults on one platform, each once, as "a × b".
async function collisionsOn(userAgent: string, mac: boolean): Promise<string[]> {
	const { actions, conflictingActions } = await actionsOn(userAgent)
	const resolved = actions.map(def => ({ ...def, combo: def.defaultCombo }))

	return actions.flatMap(def => conflictingActions(resolved, def.defaultCombo, def.id, mac).map(other => `${def.id} × ${other.id}`))
}

// These assert on the REAL action set, not a fixture — with the defs exported as data there is no
// mirrored copy anywhere in the suite, so nothing here can drift from what the app registers.
describe("ALL_ACTIONS", () => {
	it("registers no id twice", () => {
		const ids = ALL_ACTIONS.map(def => def.id)

		expect(new Set(ids).size).toBe(ids.length)
	})

	it("namespaces every id as <feature>.<name> and describes every action", () => {
		for (const def of ALL_ACTIONS) {
			expect(def.id, def.id).toMatch(/^[a-z]+(?:\.[a-z]+)?\.[A-Za-z]+$/)
			expect(def.descriptionKey.length, def.id).toBeGreaterThan(0)
		}
	})

	it.each(PLATFORMS)("ships every default in the canonical token spelling on $name", async ({ userAgent }) => {
		const { actions } = await actionsOn(userAgent)

		for (const def of actions) {
			expect(normalizeCombo(def.defaultCombo), def.id).toBe(def.defaultCombo)
		}
	})

	it.each(PLATFORMS)("has no unguarded collision between two co-mountable actions on $name", async ({ userAgent, mac }) => {
		const unguarded = (await collisionsOn(userAgent, mac)).filter(pair => {
			const [a = "", b = ""] = pair.split(" × ")

			return !isAllowlisted(a, b)
		})

		expect(unguarded).toEqual([])
	})

	it("pins each allowlisted collision to a pair that really does collide on some platform", async () => {
		const collisions = new Set<string>()

		for (const { userAgent, mac } of PLATFORMS) for (const pair of await collisionsOn(userAgent, mac)) collisions.add(pair)

		for (const [first, second] of RESOLVED_COLLISIONS) {
			expect(collisions.has(`${first} × ${second}`), `${first} × ${second}`).toBe(true)
		}
	})

	it("labels every scope it uses", () => {
		for (const def of ALL_ACTIONS) {
			expect(SHORTCUT_SCOPE_LABEL_KEYS[def.scope], def.id).toBeTruthy()
		}
	})
})

describe("registerAllActions", () => {
	it("registers every action and is idempotent", async () => {
		vi.resetModules()

		const { registerAllActions } = await import("@/lib/keymap/actions")
		const { comboFor } = await import("@/lib/keymap/registry")

		registerAllActions()
		registerAllActions()

		for (const def of ALL_ACTIONS) {
			expect(comboFor(def.id), def.id).toBe(def.defaultCombo)
		}
	})
})
