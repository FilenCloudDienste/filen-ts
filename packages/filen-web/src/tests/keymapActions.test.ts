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
const { RESOLVED_COLLISIONS, conflictingActions } = await import("@/lib/keymap/conflicts")
const { SHORTCUT_SCOPE_LABEL_KEYS } = await import("@/lib/keymap/shortcutsCatalog")
const { defaultComboOn } = await import("@/lib/keymap/registry")
const { reservedBlocks, reservedOwner } = await import("@/lib/keymap/reserved")
const { normalizeCombo, parseCombo } = await import("@filen/shared/keymap")

// Defaults are per platform (a Mac's paragraph keys, the macOS app's Cmd+,), so every check runs on each of them.
const PLATFORMS = [
	{ name: "a Mac browser", mac: true, desktop: false },
	{ name: "a Windows or Linux browser", mac: false, desktop: false },
	{ name: "the macOS desktop app", mac: true, desktop: true },
	{ name: "the Windows or Linux desktop app", mac: false, desktop: true }
] as const

type Platform = (typeof PLATFORMS)[number]

function isAllowlisted(a: string, b: string): boolean {
	return RESOLVED_COLLISIONS.some(([first, second]) => (first === a && second === b) || (first === b && second === a))
}

// The colliding pairs among the defaults on one platform, each once, as "a × b".
function collisionsOn(platform: Platform): string[] {
	const resolved = ALL_ACTIONS.map(def => ({ ...def, combo: defaultComboOn(def, platform) }))

	return resolved.flatMap(def => conflictingActions(resolved, def.combo, def.id, platform.mac).map(other => `${def.id} × ${other.id}`))
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

	it.each(PLATFORMS)("ships every default in the canonical token spelling on $name", platform => {
		for (const def of ALL_ACTIONS) {
			const combo = defaultComboOn(def, platform)

			expect(normalizeCombo(combo), def.id).toBe(combo)
		}
	})

	it.each(PLATFORMS)("ships no default the platform's shell refuses on $name", platform => {
		for (const def of ALL_ACTIONS) {
			for (const chord of parseCombo(defaultComboOn(def, platform))) {
				const owner = reservedOwner(chord, platform)

				expect(owner !== undefined && reservedBlocks(owner, platform), `${def.id} ${String(owner)}`).toBe(false)
			}
		}
	})

	it.each(PLATFORMS)("has no unguarded collision between two co-mountable actions on $name", platform => {
		const unguarded = collisionsOn(platform).filter(pair => {
			const [a = "", b = ""] = pair.split(" × ")

			return !isAllowlisted(a, b)
		})

		expect(unguarded).toEqual([])
	})

	it("pins each allowlisted collision to a pair that really does collide on some platform", () => {
		const collisions = new Set<string>()

		for (const platform of PLATFORMS) for (const pair of collisionsOn(platform)) collisions.add(pair)

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

		const { CURRENT_PLATFORM } = await import("@/lib/keymap/registry")

		for (const def of ALL_ACTIONS) {
			expect(comboFor(def.id), def.id).toBe(defaultComboOn(def, CURRENT_PLATFORM))
		}
	})
})
