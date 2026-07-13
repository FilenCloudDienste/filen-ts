import { beforeEach, describe, expect, it, vi } from "vitest"

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

// Mirrors iconRail.tsx's real module-scope registration for the new /photos rail entry (same
// unassigned-by-default shape as app.openTransfers/app.openPlaylists right next to it) — a genuine
// drift between this fixture and the real call site would only surface as an app-wide combo
// collision (registry.test.ts's own "does not collide" test covers that generically for empty
// combos, which never match anything per react-hotkeys-hook's own parser), so what's worth locking
// down here is the registration/resolution contract itself.
describe("keymap registry — app.openPhotos registration", () => {
	it("registers with its unassigned-by-default combo and resolves through comboFor", async () => {
		const { registerAction, comboFor } = await freshRegistry()

		registerAction({ id: "app.openPhotos", defaultCombo: "", scope: "global", descriptionKey: "modulePhotos" })

		expect(comboFor("app.openPhotos")).toBe("")
	})
})
