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
const { conflictingActions, RESOLVED_COLLISIONS } = await import("@/lib/keymap/conflicts")
const { SHORTCUT_NAMESPACES, SHORTCUT_SCOPE_LABEL_KEYS } = await import("@/lib/keymap/shortcutsCatalog")
const { EN_CATALOGS } = await import("@/lib/i18n/catalog")

const RESOLVED = ALL_ACTIONS.map(def => ({ ...def, combo: def.defaultCombo }))

function isAllowlisted(a: string, b: string): boolean {
	return RESOLVED_COLLISIONS.some(([first, second]) => (first === a && second === b) || (first === b && second === a))
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
			expect(def.id, def.id).toMatch(/^[a-z]+\.[A-Za-z]+$/)
			expect(def.descriptionKey.length, def.id).toBeGreaterThan(0)
		}
	})

	it("has no unguarded collision between two co-mountable actions on the same combo", () => {
		const unguarded = ALL_ACTIONS.flatMap(def =>
			conflictingActions(RESOLVED, def.defaultCombo, def.id)
				.filter(other => !isAllowlisted(def.id, other.id))
				.map(other => `${def.id} × ${other.id} (${def.defaultCombo})`)
		)

		expect(unguarded).toEqual([])
	})

	it("pins each allowlisted collision to a pair that really does collide", () => {
		for (const [first, second] of RESOLVED_COLLISIONS) {
			expect(conflictingActions(RESOLVED, RESOLVED.find(def => def.id === first)?.combo ?? "", first).map(def => def.id)).toContain(
				second
			)
		}
	})

	it("labels every scope it uses", () => {
		for (const def of ALL_ACTIONS) {
			expect(SHORTCUT_SCOPE_LABEL_KEYS[def.scope], def.id).toBeTruthy()
		}
	})

	it("names a shortcut namespace in every descriptionKey, and a key that exists in it", () => {
		// The prefixed type already compile-checks both halves; this is the runtime guard that
		// SHORTCUT_NAMESPACES (what the shortcuts UI actually loads) has not drifted from the prefixes
		// the type admits — a mismatch there renders a raw key on screen.
		for (const def of ALL_ACTIONS) {
			const [namespacePart, keyPart] = def.descriptionKey.split(":")
			const namespace = SHORTCUT_NAMESPACES.find(candidate => candidate === namespacePart)

			expect(namespace, def.descriptionKey).toBeDefined()

			if (namespace === undefined) {
				continue
			}

			const catalog: Record<string, unknown> = EN_CATALOGS[namespace]

			expect(Object.keys(catalog), def.descriptionKey).toContain(keyPart)
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
