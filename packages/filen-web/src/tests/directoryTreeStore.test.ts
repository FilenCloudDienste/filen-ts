// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { reconcileTreeLevel, TREE_ROOT_KEY, type TreeEntries } from "@/features/drive/store/useDirectoryTreeStore"

const STORAGE_KEY = "driveTreeOpen"

// Fresh module per case: the store reads localStorage once, at creation.
async function loadStore() {
	vi.resetModules()

	return import("@/features/drive/store/useDirectoryTreeStore")
}

function stored(): unknown {
	return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")
}

beforeEach(() => {
	localStorage.clear()
})

describe("useDirectoryTreeStore", () => {
	it("starts with the root expanded and every directory collapsed", async () => {
		const { useDirectoryTreeStore, isTreeNodeOpen } = await loadStore()
		const open = useDirectoryTreeStore.getState().open

		expect(isTreeNodeOpen(open, TREE_ROOT_KEY)).toBe(true)
		expect(isTreeNodeOpen(open, "dir-1")).toBe(false)
	})

	it("collapses the root on its first toggle", async () => {
		const { useDirectoryTreeStore, isTreeNodeOpen } = await loadStore()

		useDirectoryTreeStore.getState().toggle(TREE_ROOT_KEY, TREE_ROOT_KEY)

		expect(isTreeNodeOpen(useDirectoryTreeStore.getState().open, TREE_ROOT_KEY)).toBe(false)
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

	it("restores what was saved and sheds entries saved at their default or malformed", async () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ root: true, "dir-1": true, "dir-2": false, "dir-3": "yes", "dir-4": "", "dir-5": 1 })
		)

		const { useDirectoryTreeStore } = await loadStore()

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

	it("forgets everything on clear", async () => {
		const { useDirectoryTreeStore, clearDirectoryTreeState } = await loadStore()

		useDirectoryTreeStore.getState().toggle("dir-1", TREE_ROOT_KEY)
		clearDirectoryTreeState()

		expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
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
