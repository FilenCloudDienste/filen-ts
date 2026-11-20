import { describe, expect, it } from "vitest"
import type { DirectoryTreeChild, DirectoryTreeLevel } from "@/features/drive/queries/drive"
import {
	flattenDirectoryTree,
	openTreeParents,
	sameTreeParents,
	treeIndexOfPath,
	treeKeyAction,
	treeRowPath,
	type TreeLevels
} from "@/features/drive/lib/directoryTree.logic"

function child(uuid: string): DirectoryTreeChild {
	return { uuid, name: uuid.toUpperCase(), color: "default" }
}

function resolved(...uuids: string[]): DirectoryTreeLevel {
	return { status: "success", isFetching: false, data: uuids.map(child) }
}

const PENDING: DirectoryTreeLevel = { status: "pending", isFetching: true, data: undefined }
const FAILED: DirectoryTreeLevel = { status: "error", isFetching: false, data: undefined }

// root > a > (a1, a2 > a2x), b
const LEVELS: TreeLevels = new Map<string | null, DirectoryTreeLevel>([
	[null, resolved("a", "b")],
	["a", resolved("a1", "a2")],
	["a2", resolved("a2x")]
])

const ALL_OPEN = new Set(["a", "a2"])

function openIn(set: ReadonlySet<string>): (uuid: string) => boolean {
	return uuid => set.has(uuid)
}

function keys(levels: TreeLevels, open: ReadonlySet<string>): string[] {
	return flattenDirectoryTree(levels, openIn(open)).rows.map(row => row.key)
}

describe("flattenDirectoryTree", () => {
	it("lists the visible rows depth-first, each with its depth, parent row and place among its siblings", () => {
		const { rows, indexByUuid } = flattenDirectoryTree(LEVELS, openIn(ALL_OPEN))

		expect(
			rows.map(row => (row.kind === "node" ? [row.uuid, row.depth, row.parentIndex, row.posInSet, row.setSize, row.open] : row.key))
		).toEqual([
			["a", 0, -1, 1, 2, true],
			["a1", 1, 0, 1, 2, false],
			["a2", 1, 0, 2, 2, true],
			["a2x", 2, 2, 1, 1, false],
			["b", 0, -1, 2, 2, false]
		])
		expect(indexByUuid.get("a2x")).toBe(3)
	})

	it("leaves a closed node's children out, even when its level is loaded", () => {
		expect(keys(LEVELS, new Set(["a2"]))).toEqual(["a", "b"])
	})

	it("marks an open node loading while its level is pending or not observed yet, adding no row", () => {
		const { rows } = flattenDirectoryTree(new Map([...LEVELS, ["a", PENDING]]), openIn(ALL_OPEN))

		expect(rows.map(row => [row.key, row.kind === "node" && row.loading])).toEqual([
			["a", true],
			["b", false]
		])
		expect(flattenDirectoryTree(LEVELS, openIn(new Set(["b"]))).rows.at(-1)).toMatchObject({ key: "b", loading: true })
	})

	it("puts a failed level's line in its place", () => {
		const { rows } = flattenDirectoryTree(new Map([...LEVELS, ["a", FAILED]]), openIn(ALL_OPEN))

		expect(rows.map(row => [row.kind, row.key, row.depth])).toEqual([
			["node", "a", 0],
			["error", "error:a", 1],
			["node", "b", 0]
		])
		expect(flattenDirectoryTree(new Map([[null, FAILED]]), openIn(ALL_OPEN)).rows).toEqual([
			{ kind: "error", key: "error:", depth: 0, parentIndex: -1 }
		])
	})

	it("places a directory two stale listings both claim once, ending a cycle", () => {
		const cyclic: TreeLevels = new Map([
			[null, resolved("a", "b")],
			["a", resolved("b", "a")],
			["b", resolved("a")]
		])

		expect(keys(cyclic, new Set(["a", "b"]))).toEqual(["a", "b"])
	})

	it("is empty while the root level loads", () => {
		expect(flattenDirectoryTree(new Map([[null, PENDING]]), openIn(ALL_OPEN)).rows).toEqual([])
	})
})

describe("openTreeParents", () => {
	it("observes the root, then every open directory a loaded level shows", () => {
		expect(openTreeParents(LEVELS, openIn(ALL_OPEN))).toEqual([null, "a", "a2"])
		expect(openTreeParents(new Map([[null, resolved("a", "b")]]), openIn(new Set(["a", "a2"])))).toEqual([null, "a"])
	})

	it("stops below a closed, loading or failed level", () => {
		expect(openTreeParents(LEVELS, openIn(new Set(["a2"])))).toEqual([null])
		expect(openTreeParents(new Map([...LEVELS, ["a", PENDING]]), openIn(ALL_OPEN))).toEqual([null, "a"])
		expect(openTreeParents(new Map([...LEVELS, ["a", FAILED]]), openIn(ALL_OPEN))).toEqual([null, "a"])
	})

	it("reads a level it does not observe yet from the cache, so a held chain joins in one step", () => {
		const cache = new Map([
			["a", resolved("a1", "a2").data],
			["a2", resolved("deep").data]
		])
		const cached = (uuid: string) => cache.get(uuid)

		expect(openTreeParents(new Map([[null, resolved("a", "b")]]), openIn(new Set(["a", "a2", "deep"])), cached)).toEqual([
			null,
			"a",
			"a2",
			"deep"
		])
		// An observed level is authoritative: a loading or failed one is not read past from the cache.
		expect(openTreeParents(new Map([...LEVELS, ["a", PENDING]]), openIn(ALL_OPEN), cached)).toEqual([null, "a"])
		expect(openTreeParents(new Map([...LEVELS, ["a", FAILED]]), openIn(ALL_OPEN), cached)).toEqual([null, "a"])
	})

	it("compares by value", () => {
		expect(sameTreeParents([null, "a"], [null, "a"])).toBe(true)
		expect(sameTreeParents([null, "a"], [null])).toBe(false)
		expect(sameTreeParents([null, "a"], [null, "b"])).toBe(false)
	})
})

describe("treeRowPath and treeIndexOfPath", () => {
	const flat = flattenDirectoryTree(LEVELS, openIn(ALL_OPEN))

	it("walks a row's chain back to the root", () => {
		expect(treeRowPath(flat.rows, 3)).toEqual(["a", "a2", "a2x"])
		expect(treeRowPath(flat.rows, 4)).toEqual(["b"])
	})

	it("finds the row of a path only where that path is shown", () => {
		expect(treeIndexOfPath(flat, ["a", "a2", "a2x"])).toBe(3)
		expect(treeIndexOfPath(flat, ["b", "a2x"])).toBe(-1)
		expect(treeIndexOfPath(flat, ["missing"])).toBe(-1)
		expect(treeIndexOfPath(flat, [])).toBe(-1)
	})
})

describe("treeKeyAction", () => {
	const { rows } = flattenDirectoryTree(LEVELS, openIn(ALL_OPEN))
	const failed = flattenDirectoryTree(new Map([...LEVELS, ["a", FAILED]]), openIn(ALL_OPEN)).rows

	it("steps Up and Down through the visible nodes, staying put at either end", () => {
		expect(treeKeyAction(rows, 0, "ArrowDown")).toEqual({ kind: "focus", index: 1 })
		expect(treeKeyAction(rows, 3, "ArrowUp")).toEqual({ kind: "focus", index: 2 })
		expect(treeKeyAction(rows, 4, "ArrowDown")).toEqual({ kind: "focus", index: 4 })
		expect(treeKeyAction(rows, 0, "ArrowUp")).toEqual({ kind: "focus", index: 0 })
	})

	it("passes over a failed level's line", () => {
		expect(treeKeyAction(failed, 0, "ArrowDown")).toEqual({ kind: "focus", index: 2 })
		expect(treeKeyAction(failed, 2, "ArrowUp")).toEqual({ kind: "focus", index: 0 })
		expect(treeKeyAction(failed, 1, "ArrowDown")).toBeNull()
	})

	it("goes to the first and last nodes with Home and End", () => {
		expect(treeKeyAction(rows, 3, "Home")).toEqual({ kind: "focus", index: 0 })
		expect(treeKeyAction(rows, 0, "End")).toEqual({ kind: "focus", index: 4 })
	})

	it("opens a closed node with Right and steps into an open one's first child", () => {
		expect(treeKeyAction(rows, 4, "ArrowRight")).toEqual({ kind: "toggle", index: 4 })
		expect(treeKeyAction(rows, 0, "ArrowRight")).toEqual({ kind: "focus", index: 1 })
		// Open with nothing shown below it (empty, loading or failed): stays.
		expect(treeKeyAction(failed, 0, "ArrowRight")).toEqual({ kind: "focus", index: 0 })
	})

	it("closes an open node with Left and steps out of a closed one to its parent", () => {
		expect(treeKeyAction(rows, 2, "ArrowLeft")).toEqual({ kind: "toggle", index: 2 })
		expect(treeKeyAction(rows, 3, "ArrowLeft")).toEqual({ kind: "focus", index: 2 })
		expect(treeKeyAction(rows, 4, "ArrowLeft")).toEqual({ kind: "focus", index: 4 })
	})

	it("opens the directory with Enter or Space, and leaves every other key alone", () => {
		expect(treeKeyAction(rows, 3, "Enter")).toEqual({ kind: "open", index: 3 })
		expect(treeKeyAction(rows, 3, " ")).toEqual({ kind: "open", index: 3 })
		expect(treeKeyAction(rows, 3, "a")).toBeNull()
		expect(treeKeyAction(rows, 3, "Tab")).toBeNull()
	})
})
