// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reconcileTreeLevel, TREE_ROOT_KEY, type TreeEntries } from "@/features/drive/store/useDirectoryTreeStore"

// The tree's open state lives in the kv store (never localStorage), read once at boot.
const KV_KEY = "drive.treeOpen.v1"

const { kvStore, kvSetJson } = vi.hoisted(() => {
	const kvStore = new Map<string, unknown>()

	return {
		kvStore,
		kvSetJson: vi.fn((key: string, value: unknown) => {
			kvStore.set(key, value)

			return Promise.resolve()
		})
	}
})

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson,
	kvClear: () => {
		kvStore.clear()

		return Promise.resolve()
	}
}))

// Fresh module per case: the store's state is module-level.
async function loadStore() {
	vi.resetModules()

	return import("@/features/drive/store/useDirectoryTreeStore")
}

function stored(): unknown {
	return kvStore.get(KV_KEY) ?? null
}

let storageSpies: ReturnType<typeof vi.spyOn>[] = []

beforeEach(() => {
	kvStore.clear()
	kvSetJson.mockClear()
	localStorage.clear()
	storageSpies = (["getItem", "setItem", "removeItem"] as const).map(method => vi.spyOn(Storage.prototype, method))
})

afterEach(() => {
	for (const spy of storageSpies) {
		expect(spy).not.toHaveBeenCalled()
	}

	vi.restoreAllMocks()
})

describe("useDirectoryTreeStore", () => {
	it("starts with the root expanded and every directory collapsed", async () => {
		const { useDirectoryTreeStore, isTreeNodeOpen, loadDirectoryTreeOpen } = await loadStore()

		await loadDirectoryTreeOpen()

		const open = useDirectoryTreeStore.getState().open

		expect(isTreeNodeOpen(open, TREE_ROOT_KEY)).toBe(true)
		expect(isTreeNodeOpen(open, "dir-1")).toBe(false)
		expect(kvSetJson).not.toHaveBeenCalled()
	})

	it("collapses the root on its first toggle, writing through the kv store", async () => {
		const { useDirectoryTreeStore, isTreeNodeOpen } = await loadStore()

		useDirectoryTreeStore.getState().toggle(TREE_ROOT_KEY, TREE_ROOT_KEY)

		expect(isTreeNodeOpen(useDirectoryTreeStore.getState().open, TREE_ROOT_KEY)).toBe(false)
		expect(kvSetJson).toHaveBeenCalledWith(KV_KEY, { [TREE_ROOT_KEY]: false })
		expect(stored()).toEqual({ [TREE_ROOT_KEY]: false })
	})

	it("stores an expanded directory under its parent, and nothing once it collapses again", async () => {
		const { useDirectoryTreeStore } = await loadStore()
		const { toggle } = useDirectoryTreeStore.getState()

		toggle("dir-1", TREE_ROOT_KEY)
		toggle("dir-2", "dir-1")
		expect(stored()).toEqual({ "dir-1": TREE_ROOT_KEY, "dir-2": "dir-1" })

		toggle("dir-1", TREE_ROOT_KEY)
		toggle(TREE_ROOT_KEY, TREE_ROOT_KEY)
		toggle(TREE_ROOT_KEY, TREE_ROOT_KEY)
		expect(stored()).toEqual({ "dir-2": "dir-1" })
		expect(useDirectoryTreeStore.getState().open).toEqual({ "dir-2": "dir-1" })
	})

	it("takes the value read at boot as its state, shedding entries saved at their default or malformed", async () => {
		kvStore.set(KV_KEY, { root: true, "dir-1": true, "dir-2": false, "dir-3": "yes", "dir-4": "", "dir-5": 1 })

		const { useDirectoryTreeStore, loadDirectoryTreeOpen } = await loadStore()

		expect(useDirectoryTreeStore.getState().open).toEqual({})

		await loadDirectoryTreeOpen()

		expect(useDirectoryTreeStore.getState().open).toEqual({ "dir-1": true, "dir-3": "yes" })
	})

	it("prunes a level's vanished directories when it loads, and persists that", async () => {
		const { useDirectoryTreeStore } = await loadStore()
		const { toggle, reconcileLevel } = useDirectoryTreeStore.getState()

		toggle("dir-1", TREE_ROOT_KEY)
		toggle("dir-2", TREE_ROOT_KEY)
		reconcileLevel(TREE_ROOT_KEY, ["dir-2", "dir-3"])

		expect(useDirectoryTreeStore.getState().open).toEqual({ "dir-2": TREE_ROOT_KEY })
		expect(stored()).toEqual({ "dir-2": TREE_ROOT_KEY })
	})

	it("forgets everything on logout: clear resets memory without writing, the kv wipe removes the row", async () => {
		const { useDirectoryTreeStore, clearDirectoryTreeState } = await loadStore()
		const { kvClear } = await import("@/lib/storage/adapter")

		useDirectoryTreeStore.getState().toggle("dir-1", TREE_ROOT_KEY)
		kvSetJson.mockClear()
		clearDirectoryTreeState()
		await kvClear()

		expect(kvSetJson).not.toHaveBeenCalled()
		expect(stored()).toBeNull()
		expect(useDirectoryTreeStore.getState().open).toEqual({})
	})
})

describe("reconcileTreeLevel", () => {
	it("drops a vanished directory with every entry below it, leaving other branches alone", () => {
		const entries: TreeEntries = {
			[TREE_ROOT_KEY]: false,
			a: TREE_ROOT_KEY,
			b: "a",
			c: "b",
			d: TREE_ROOT_KEY,
			e: "d"
		}

		expect(reconcileTreeLevel(entries, TREE_ROOT_KEY, ["d"])).toEqual({ [TREE_ROOT_KEY]: false, d: TREE_ROOT_KEY, e: "d" })
	})

	it("only judges the entries recorded under the level that loaded", () => {
		const entries: TreeEntries = { a: TREE_ROOT_KEY, b: "a" }

		expect(reconcileTreeLevel(entries, "a", ["b"])).toBe(entries)
		expect(reconcileTreeLevel(entries, "other", [])).toBe(entries)
	})

	it("adopts the level as the parent of entries saved without one", () => {
		const entries: TreeEntries = { a: true, b: true }

		expect(reconcileTreeLevel(entries, TREE_ROOT_KEY, ["a"])).toEqual({ a: TREE_ROOT_KEY, b: true })
	})
})
