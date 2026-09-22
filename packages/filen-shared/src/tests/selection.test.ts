import { describe, it, expect } from "vitest"
import { toggleInArray, removeSelectedIds } from "@filen/shared"

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
