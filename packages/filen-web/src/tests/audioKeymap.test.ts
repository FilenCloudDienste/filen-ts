import { beforeEach, describe, expect, it, vi } from "vitest"
import { AUDIO_ACTIONS } from "@/features/audio/lib/keymap"

// The audio transport bindings are exported as plain data (AUDIO_ACTIONS) so their scope/combos are
// testable without mounting the player bar. Two things are verified: the static contract (audio scope,
// mod+shift chords that can't collide with the overlay's bare Arrow/Space or an editor), and that they
// register cleanly into a fresh keymap registry and resolve to their defaults. The registry is a
// Map-backed singleton, so a fresh dynamic import per test isolates registration — mirroring
// registry.test.ts's own approach, mocking the same storage-adapter boundary.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

async function freshRegistry() {
	vi.resetModules()

	return import("@/lib/keymap/registry")
}

beforeEach(() => {
	kvStore.clear()
})

describe("AUDIO_ACTIONS — static contract", () => {
	it("are all audio-scoped", () => {
		for (const def of AUDIO_ACTIONS) {
			expect(def.scope).toBe("audio")
		}
	})

	it("use mod+shift chords that never collide with bare Arrow/Space or editor caret keys", () => {
		for (const def of AUDIO_ACTIONS) {
			expect(def.defaultCombo.startsWith("mod+shift+")).toBe(true)
			expect(def.defaultCombo).not.toBe("space")
			expect(def.defaultCombo).not.toBe("arrowleft")
			expect(def.defaultCombo).not.toBe("arrowright")
		}
	})

	it("have unique ids under the audio namespace", () => {
		const ids = AUDIO_ACTIONS.map(def => def.id)

		expect(new Set(ids).size).toBe(ids.length)

		for (const id of ids) {
			expect(id.startsWith("audio.")).toBe(true)
		}
	})
})

describe("AUDIO_ACTIONS — registration", () => {
	it("register into the registry and resolve to their default combos", async () => {
		const { registerAction, comboFor } = await freshRegistry()

		for (const def of AUDIO_ACTIONS) {
			registerAction(def)
		}

		for (const def of AUDIO_ACTIONS) {
			expect(comboFor(def.id)).toBe(def.defaultCombo)
		}
	})

	it("reject a duplicate registration (id already taken)", async () => {
		const { registerAction } = await freshRegistry()
		const first = AUDIO_ACTIONS[0]

		expect(first).toBeDefined()

		if (!first) {
			return
		}

		registerAction(first)

		expect(() => {
			registerAction(first)
		}).toThrow()
	})
})
