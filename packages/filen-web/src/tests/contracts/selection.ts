import { describe, expect, it } from "vitest"
import { act, type MouseEvent as ReactMouseEvent } from "react"
import type { UuidStr } from "@filen/sdk-rs"
import type { ListPointerSelection } from "@/lib/useListPointerSelection"
import { testUuid } from "@/tests/support/uuid"

// The behaviour every per-domain selection store and list-selection hook shares. Each caller's own
// beforeEach empties its store; domain-specific cases stay in the caller's file.

export function clickEvent(modifiers: Partial<Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">> = {}): ReactMouseEvent {
	return { shiftKey: false, metaKey: false, ctrlKey: false, ...modifiers } as ReactMouseEvent
}

export interface SelectionStoreContract<T> {
	makeItem: (uuid: UuidStr) => T
	selected: () => T[]
	seed: (items: T[]) => void
	toggle: (item: T) => void
	set: (next: T[] | ((prev: T[]) => T[])) => void
	remove: (uuids: string[]) => void
	clear: () => void
}

export function describeSelectionStoreContract<T>(store: SelectionStoreContract<T>): void {
	describe("selection store: toggle", () => {
		it("adds an item that is not yet selected", () => {
			const item = store.makeItem(testUuid("a"))

			store.toggle(item)

			expect(store.selected()).toEqual([item])
		})

		it("removes an already-selected item, matched by uuid", () => {
			const item = store.makeItem(testUuid("a"))

			store.seed([item])
			store.toggle(item)

			expect(store.selected()).toEqual([])
		})

		it("toggling the same item twice restores the original selection", () => {
			const item = store.makeItem(testUuid("a"))

			store.toggle(item)
			store.toggle(item)

			expect(store.selected()).toEqual([])
		})

		it("does not mutate the previous array (returns a new reference)", () => {
			const prev = store.selected()

			store.toggle(store.makeItem(testUuid("a")))

			expect(store.selected()).not.toBe(prev)
		})

		it("only affects the matching uuid, leaving other selected items untouched", () => {
			const itemA = store.makeItem(testUuid("a"))
			const itemB = store.makeItem(testUuid("b"))

			store.seed([itemA, itemB])
			store.toggle(itemA)

			expect(store.selected()).toEqual([itemB])
		})
	})

	describe("selection store: set", () => {
		it("accepts a plain array and replaces the selection", () => {
			const item = store.makeItem(testUuid("a"))

			store.set([item])

			expect(store.selected()).toEqual([item])
		})

		it("accepts an updater function that reads the previous selection", () => {
			const itemA = store.makeItem(testUuid("a"))
			const itemB = store.makeItem(testUuid("b"))

			store.seed([itemA])
			store.set(prev => [...prev, itemB])

			expect(store.selected()).toEqual([itemA, itemB])
		})
	})

	describe("selection store: removeFromSelection", () => {
		it("removes only the given uuids", () => {
			const itemA = store.makeItem(testUuid("a"))
			const itemB = store.makeItem(testUuid("b"))

			store.seed([itemA, itemB])
			store.remove([testUuid("a")])

			expect(store.selected()).toEqual([itemB])
		})

		it("is a no-op (same array reference) when none of the given uuids are selected", () => {
			store.seed([store.makeItem(testUuid("a"))])

			const prev = store.selected()

			store.remove([testUuid("z")])

			expect(store.selected()).toBe(prev)
		})
	})

	describe("selection store: clear", () => {
		it("empties a non-empty selection", () => {
			store.seed([store.makeItem(testUuid("a"))])
			store.clear()

			expect(store.selected()).toEqual([])
		})
	})
}

export interface ClickSelectionContract<T> {
	// Exactly five items, in render order.
	items: readonly T[]
	render: () => { readonly current: ListPointerSelection }
	selected: () => T[]
	seed: (items: T[]) => void
}

export function describeClickSelectionContract<T>({ items, render, selected, seed }: ClickSelectionContract<T>): void {
	// Whether the click was taken as a selection gesture (so a row's Link must not navigate).
	function click(result: { readonly current: ListPointerSelection }, index: number, event: ReactMouseEvent, pointerType = "mouse"): boolean {
		let gesture = false

		act(() => {
			gesture = result.current.handlePointerSelect(index, event, pointerType)
		})

		return gesture
	}

	function tap(result: { readonly current: ListPointerSelection }, index: number): boolean {
		return click(result, index, clickEvent(), "touch")
	}

	function longPress(result: { readonly current: ListPointerSelection }, index: number): void {
		act(() => {
			result.current.toggleAt(index)
		})
	}

	describe("click selection: plain click", () => {
		it("replaces the selection with just the clicked item, regardless of prior selection", () => {
			const result = render()

			// Built through the hook itself: its mount effect clears anything seeded into the store beforehand.
			click(result, 0, clickEvent({ ctrlKey: true }))
			click(result, 1, clickEvent({ ctrlKey: true }))
			expect(selected()).toEqual([items[0], items[1]])

			click(result, 2, clickEvent())

			expect(selected()).toEqual([items[2]])
		})

		it("is a no-op when the index has no matching item", () => {
			click(render(), 99, clickEvent())

			expect(selected()).toEqual([])
		})
	})

	describe("click selection: Ctrl/Cmd+click toggles", () => {
		it("adds an unselected item to the selection", () => {
			const result = render()

			click(result, 0, clickEvent({ ctrlKey: true }))
			click(result, 2, clickEvent({ metaKey: true }))

			expect(selected()).toEqual([items[0], items[2]])
		})

		it("removes an already-selected item, leaving the rest untouched", () => {
			const result = render()

			click(result, 0, clickEvent({ ctrlKey: true }))
			click(result, 1, clickEvent({ ctrlKey: true }))
			expect(selected()).toEqual([items[0], items[1]])

			click(result, 0, clickEvent({ ctrlKey: true }))

			expect(selected()).toEqual([items[1]])
		})
	})

	describe("click selection: Shift+click range", () => {
		it("extends a range from the last plain-click/ctrl-click anchor to the shift-clicked index", () => {
			const result = render()

			click(result, 1, clickEvent())
			click(result, 3, clickEvent({ shiftKey: true }))

			expect(selected()).toEqual([items[1], items[2], items[3]])
		})

		it("range is ascending regardless of which side (anchor or target) is later in the list", () => {
			const result = render()

			click(result, 3, clickEvent())
			click(result, 1, clickEvent({ shiftKey: true }))

			expect(selected()).toEqual([items[1], items[2], items[3]])
		})

		it("a second shift-click re-anchors from the ORIGINAL (non-shift) anchor, not the previous shift target", () => {
			const result = render()

			click(result, 0, clickEvent())
			click(result, 2, clickEvent({ shiftKey: true }))
			click(result, 4, clickEvent({ shiftKey: true }))

			expect(selected()).toEqual(items)
		})
	})

	describe("click selection: navigation", () => {
		it("lets a plain click navigate and blocks a modified one", () => {
			const result = render()

			expect(click(result, 0, clickEvent())).toBe(false)
			expect(click(result, 1, clickEvent({ ctrlKey: true }))).toBe(true)
			expect(click(result, 2, clickEvent({ shiftKey: true }))).toBe(true)
		})

		it("blocks a modified click on an index with no item", () => {
			expect(click(render(), 99, clickEvent({ metaKey: true }))).toBe(true)
		})
	})

	describe("click selection: touch", () => {
		it("a tap with nothing selected navigates and leaves the selection empty", () => {
			const result = render()

			expect(tap(result, 1)).toBe(false)
			expect(selected()).toEqual([])
		})

		it("a long-press selects, then each tap toggles without navigating until the selection is empty again", () => {
			const result = render()

			longPress(result, 1)
			expect(selected()).toEqual([items[1]])

			expect(tap(result, 3)).toBe(true)
			expect(selected()).toEqual([items[1], items[3]])

			expect(tap(result, 1)).toBe(true)
			expect(tap(result, 3)).toBe(true)
			expect(selected()).toEqual([])

			expect(tap(result, 2)).toBe(false)
			expect(selected()).toEqual([])
		})

		it("a long-press in selection mode toggles too, and anchors a later Shift range", () => {
			const result = render()

			longPress(result, 0)
			longPress(result, 2)
			expect(selected()).toEqual([items[0], items[2]])

			longPress(result, 0)
			expect(selected()).toEqual([items[2]])

			longPress(result, 2)
			click(result, 4, clickEvent({ shiftKey: true }))
			expect(selected()).toEqual([items[2], items[3], items[4]])
		})
	})

	describe("click selection: mount", () => {
		it("mounting fresh never inherits a selection already sitting in the store from elsewhere", () => {
			seed(items.slice(0, 1))
			render()

			expect(selected()).toEqual([])
		})
	})
}
