import { beforeEach, describe, expect, it, vi } from "vitest"
import { APP_ACTIONS } from "@/features/shell/lib/keymap"

// Same isolation approach as registry.test.ts/audioKeymap.test.ts: registry.ts is a Map-backed
// singleton, so a fresh dynamic import per test avoids duplicate-id collisions across `it()` blocks.
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

// Reads the REAL def (features/shell/lib/keymap.ts) rather than mirroring it, so this cannot drift
// from what the app registers. The /photos rail entry ships unassigned-by-default, like
// app.openTransfers/app.openPlaylists next to it; what is worth locking down is that the empty combo
// survives registration and resolution intact.
describe("keymap registry — app.openPhotos registration", () => {
	it("registers with its unassigned-by-default combo and resolves through comboFor", async () => {
		const { registerAction, comboFor } = await freshRegistry()
		const def = APP_ACTIONS.find(action => action.id === "app.openPhotos")

		expect(def).toBeDefined()

		if (!def) {
			return
		}

		expect(def.defaultCombo).toBe("")

		registerAction(def)

		expect(comboFor("app.openPhotos")).toBe("")
	})
})
