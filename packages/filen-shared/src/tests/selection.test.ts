import { describe, it, expect } from "vitest"
import { toggleInArray, removeSelectedIds, pruneSelection, droppedIds } from "@filen/shared"

type Item = { uuid: string; name: string }

const items: Item[] = [
	{ uuid: "a", name: "alpha" },
	{ uuid: "b", name: "beta" },
	{ uuid: "c", name: "gamma" }
]

const getId = (i: Item) => i.uuid

describe("toggleInArray", () => {
	it("adds when absent", () => {
		expect(toggleInArray<Item>([], items[0]!, getId)).toEqual([items[0]])
		expect(toggleInArray([items[0]!], items[1]!, getId)).toEqual([items[0], items[1]])
	})

	it("removes when present", () => {
		expect(toggleInArray([items[0]!, items[1]!], items[0]!, getId)).toEqual([items[1]])
		expect(toggleInArray([items[0]!, items[1]!, items[2]!], items[1]!, getId)).toEqual([items[0], items[2]])
	})

	it("preserves order when adding", () => {
		expect(toggleInArray([items[0]!, items[1]!], items[2]!, getId)).toEqual([items[0], items[1], items[2]])
	})

	it("does not mutate input", () => {
		const arr = [items[0]!]
		const out = toggleInArray(arr, items[1]!, getId)

		expect(arr).toEqual([items[0]])
		expect(out).toEqual([items[0], items[1]])
	})

	it("identifies items by id even when references differ", () => {
		const arr = [{ uuid: "a", name: "alpha" }]
		const dup: Item = { uuid: "a", name: "alpha-renamed" }

		expect(toggleInArray(arr, dup, getId)).toEqual([])
	})
})

describe("removeSelectedIds", () => {
	it("removes an item by id while keeping the others", () => {
		expect(removeSelectedIds(items, ["b"], getId).map(getId)).toEqual(["a", "c"])
	})

	it("removes multiple ids in a single call", () => {
		expect(removeSelectedIds(items, ["a", "c"], getId).map(getId)).toEqual(["b"])
	})

	it("is a no-op (same array reference) when no id matches", () => {
		const before = items

		const after = removeSelectedIds(before, ["not-selected"], getId)

		expect(after).toBe(before)
		expect(after.map(getId)).toEqual(["a", "b", "c"])
	})

	it("is a no-op on an empty array", () => {
		const before: Item[] = []

		const after = removeSelectedIds(before, ["anything"], getId)

		expect(after).toBe(before)
		expect(after).toEqual([])
	})

	it("does not mutate input and returns a new instance when something is removed", () => {
		const arr = [items[0]!, items[1]!]

		const after = removeSelectedIds(arr, ["a"], getId)

		expect(arr.map(getId)).toEqual(["a", "b"])
		expect(after).not.toBe(arr)
		expect(after.map(getId)).toEqual(["b"])
	})

	it("removes all matching ids, leaving an empty array", () => {
		expect(removeSelectedIds([items[0]!, items[1]!], ["a", "b"], getId)).toEqual([])
	})
})

describe("pruneSelection", () => {
	it("drops selected items whose uuid is gone from the live list", () => {
		// "b" was deleted remotely and is no longer in the refetched data.
		const liveUuids = new Set(["a", "c"])
		const kept = pruneSelection(items, item => liveUuids.has(item.uuid))

		expect(kept).toHaveLength(2)
		expect(kept.map(getId)).toEqual(["a", "c"])
	})

	it("drops every selected item when the live list is empty", () => {
		const liveUuids = new Set<string>()

		expect(pruneSelection(items, item => liveUuids.has(item.uuid))).toEqual([])
	})

	it("returns the SAME array reference when nothing changed (no-op store write)", () => {
		// All selected uuids still present (live also has an extra "d").
		const liveUuids = new Set(["a", "b", "c", "d"])
		const kept = pruneSelection(items, item => liveUuids.has(item.uuid))

		expect(kept).toBe(items)
	})

	it("returns the SAME reference for an empty selection regardless of the predicate", () => {
		const empty: Item[] = []

		expect(pruneSelection(empty, item => item.uuid === "a")).toBe(empty)
		expect(pruneSelection(empty, () => false)).toBe(empty)
	})

	it("does not mutate the input selection when pruning", () => {
		const input: Item[] = [
			{ uuid: "x", name: "x" },
			{ uuid: "y", name: "y" }
		]
		const liveUuids = new Set(["x"])
		const kept = pruneSelection(input, item => liveUuids.has(item.uuid))

		expect(input).toHaveLength(2)
		expect(kept).toHaveLength(1)
		expect(kept[0]).toMatchObject({ uuid: "x" })
	})

	it("keeps the original selected object identities, not fresh copies", () => {
		// A refetch hands the caller different object identities with the same uuids to build the
		// Set from — pruneSelection must still return the ORIGINAL selected objects, not new ones.
		const liveUuids = new Set(["a", "b", "c"])
		const kept = pruneSelection(items, item => liveUuids.has(item.uuid))

		expect(kept[0]).toBe(items[0])
		expect(kept[1]).toBe(items[1])
		expect(kept[2]).toBe(items[2])
	})

	it("preserves the original order of the kept selection", () => {
		const liveUuids = new Set(["c", "a", "b"])
		const kept = pruneSelection(items, item => liveUuids.has(item.uuid))

		expect(kept.map(getId)).toEqual(["a", "b", "c"])
	})
})

describe("droppedIds", () => {
	it("returns the ids of items that fail the keep predicate", () => {
		const liveUuids = new Set(["a", "c"])

		expect(droppedIds(items, item => liveUuids.has(item.uuid), getId)).toEqual(["b"])
	})

	it("returns an empty array when every item passes", () => {
		expect(droppedIds(items, () => true, getId)).toEqual([])
	})

	it("returns an empty array for an empty selection", () => {
		expect(droppedIds([], () => false, getId)).toEqual([])
	})

	it("does not mutate the input selection", () => {
		const input = [items[0]!, items[1]!]

		const dropped = droppedIds(input, item => item.uuid === "a", getId)

		expect(input.map(getId)).toEqual(["a", "b"])
		expect(dropped).toEqual(["b"])
	})
})
