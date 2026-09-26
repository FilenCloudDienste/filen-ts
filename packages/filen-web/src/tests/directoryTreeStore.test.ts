// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"

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
		const { useDirectoryTreeStore, isTreeNodeOpen, TREE_ROOT_KEY } = await loadStore()
		const open = useDirectoryTreeStore.getState().open

		expect(isTreeNodeOpen(open, TREE_ROOT_KEY)).toBe(true)
		expect(isTreeNodeOpen(open, "dir-1")).toBe(false)
	})

	it("collapses the root on its first toggle", async () => {
		const { useDirectoryTreeStore, isTreeNodeOpen, TREE_ROOT_KEY } = await loadStore()

		useDirectoryTreeStore.getState().toggle(TREE_ROOT_KEY)

		expect(isTreeNodeOpen(useDirectoryTreeStore.getState().open, TREE_ROOT_KEY)).toBe(false)
		expect(stored()).toEqual({ [TREE_ROOT_KEY]: false })
	})

	it("stores only what differs from the default, so collapsing removes the entry", async () => {
		const { useDirectoryTreeStore, TREE_ROOT_KEY } = await loadStore()
		const { toggle } = useDirectoryTreeStore.getState()

		toggle("dir-1")
		toggle("dir-2")
		expect(stored()).toEqual({ "dir-1": true, "dir-2": true })

		toggle("dir-1")
		toggle(TREE_ROOT_KEY)
		toggle(TREE_ROOT_KEY)
		expect(stored()).toEqual({ "dir-2": true })
		expect(useDirectoryTreeStore.getState().open).toEqual({ "dir-2": true })
	})

	it("restores what was saved and sheds entries saved at their default", async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ root: true, "dir-1": true, "dir-2": false, "dir-3": "yes" }))

		const { useDirectoryTreeStore } = await loadStore()

		expect(useDirectoryTreeStore.getState().open).toEqual({ "dir-1": true })
	})

	it("forgets everything on clear", async () => {
		const { useDirectoryTreeStore, clearDirectoryTreeState } = await loadStore()

		useDirectoryTreeStore.getState().toggle("dir-1")
		clearDirectoryTreeState()

		expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
		expect(useDirectoryTreeStore.getState().open).toEqual({})
	})
})
