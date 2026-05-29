import { describe, it, expect } from "vitest"
import { create } from "zustand"
import { createSelectionSlice, toggleInArray, isItemSelected, type SelectionSlice } from "@/stores/createSelectionSlice"

type Item = { uuid: string; name: string }

const items: Item[] = [
	{ uuid: "a", name: "alpha" },
	{ uuid: "b", name: "beta" },
	{ uuid: "c", name: "gamma" }
]

const getId = (i: Item) => i.uuid

function makeStore() {
	return create<SelectionSlice<Item>>()(createSelectionSlice(getId))
}

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

describe("isItemSelected", () => {
	it("returns true when present", () => {
		expect(isItemSelected([items[0]!, items[1]!], items[0]!, getId)).toBe(true)
	})

	it("returns false when absent", () => {
		expect(isItemSelected([items[0]!], items[1]!, getId)).toBe(false)
	})

	it("compares by id, not reference", () => {
		const dup: Item = { uuid: "a", name: "renamed" }

		expect(isItemSelected([items[0]!], dup, getId)).toBe(true)
	})

	it("returns false on empty array", () => {
		expect(isItemSelected([], items[0]!, getId)).toBe(false)
	})
})

describe("createSelectionSlice", () => {
	it("starts empty", () => {
		const store = makeStore()

		expect(store.getState().selected).toEqual([])
	})

	it("setSelected accepts an array", () => {
		const store = makeStore()

		store.getState().setSelected(items)

		expect(store.getState().selected).toEqual(items)
	})

	it("setSelected accepts an updater fn", () => {
		const store = makeStore()

		store.getState().setSelected([items[0]!])
		store.getState().setSelected(prev => [...prev, items[1]!])

		expect(store.getState().selected).toEqual([items[0], items[1]])
	})

	it("clearSelected empties the selection", () => {
		const store = makeStore()

		store.getState().selectAll(items)
		store.getState().clearSelected()

		expect(store.getState().selected).toEqual([])
	})

	it("toggleSelected adds when absent", () => {
		const store = makeStore()

		store.getState().toggleSelected(items[0]!)

		expect(store.getState().selected).toEqual([items[0]])
	})

	it("toggleSelected removes when present", () => {
		const store = makeStore()

		store.getState().selectAll([items[0]!, items[1]!])
		store.getState().toggleSelected(items[0]!)

		expect(store.getState().selected).toEqual([items[1]])
	})

	it("selectAll replaces the current selection", () => {
		const store = makeStore()

		store.getState().setSelected([items[0]!])
		store.getState().selectAll([items[1]!, items[2]!])

		expect(store.getState().selected).toEqual([items[1], items[2]])
	})

	it("selectAll with empty array clears the selection", () => {
		const store = makeStore()

		store.getState().selectAll(items)
		store.getState().selectAll([])

		expect(store.getState().selected).toEqual([])
	})

	it("each store instance is independent", () => {
		const a = makeStore()
		const b = makeStore()

		a.getState().selectAll(items)

		expect(b.getState().selected).toEqual([])
		expect(a.getState().selected).toEqual(items)
	})
})
