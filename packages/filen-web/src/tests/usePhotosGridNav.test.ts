// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import type { File, UuidStr } from "@filen/sdk-rs"
import type { Virtualizer } from "@tanstack/react-virtual"

// The grid's pure key table is pinned in photosGridNav.test.ts; this file covers the hook that ACTS on
// it — cursor identity, the anchor/range split between plain and shifted arrows, and the row (never the
// item index) handed to the virtualizer. The stubbing shape mirrors drive's twin,
// useDriveListboxNavReveal.test.ts: the virtualizer and the ref map are plain params.

import { narrowItem } from "@/features/drive/lib/item"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { usePhotosGridNav } from "@/features/photos/hooks/usePhotosGridNav"

const COLUMNS = 4

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function photoItem(label: string): PhotoItem {
	const file: File = {
		uuid: testUuid(label),
		stableUUID: undefined,
		parent: testUuid("root"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name: `${label}.jpg`, mime: "image/jpeg", modified: 1n, size: 1n, key: "k", version: 2 } }
	}
	const item = narrowItem(file)

	if (item.type !== "file") {
		throw new Error("test fixture narrowed to a non-file arm")
	}

	return item
}

const ITEMS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(photoItem)

// Where a key press starts: the tile face inside the grid, the tile's ⋯ trigger, or one of the tile's
// menu items, which Base UI portals out to the body while React still bubbles its keys through the grid.
type KeyOrigin = "tile" | "trigger" | "menuItem"

interface GridDom {
	listbox: HTMLElement
	origins: Record<KeyOrigin, HTMLElement>
}

let dom: GridDom

function buildGridDom(): GridDom {
	const listbox = document.createElement("div")
	const tile = listbox.appendChild(document.createElement("div"))
	const trigger = tile.appendChild(document.createElement("button"))
	const menuItem = document.body.appendChild(document.createElement("div"))

	menuItem.setAttribute("role", "menuitem")

	return { listbox, origins: { tile, trigger, menuItem } }
}

function keyEvent(key: string, options: { shiftKey?: boolean; from?: KeyOrigin } = {}): ReactKeyboardEvent<HTMLDivElement> {
	return {
		key,
		shiftKey: options.shiftKey ?? false,
		target: dom.origins[options.from ?? "tile"],
		currentTarget: dom.listbox,
		preventDefault: vi.fn()
	} as unknown as ReactKeyboardEvent<HTMLDivElement>
}

function renderNav(items: PhotoItem[] = ITEMS) {
	const scrollToIndex = vi.fn()
	const virtualizer = { scrollToIndex } as unknown as Virtualizer<HTMLDivElement, Element>
	const onOpen = vi.fn()
	// The anchor lives in photoGrid.tsx (shared with usePhotosSelection), so it is threaded in and out
	// here exactly as the component does it.
	const anchor = { uuid: null as string | null }
	const setAnchorUuid = vi.fn((next: string | null) => {
		anchor.uuid = next
	})

	const rendered = renderHook(
		(props: { items: PhotoItem[] }) =>
			usePhotosGridNav({
				items: props.items,
				columns: COLUMNS,
				virtualizer,
				anchorUuid: anchor.uuid,
				setAnchorUuid,
				onOpen
			}),
		{ initialProps: { items } }
	)

	return { ...rendered, scrollToIndex, onOpen, anchor, setAnchorUuid }
}

function selectedUuids(): string[] {
	return usePhotosStore.getState().selectedItems.map(item => item.data.uuid)
}

beforeEach(() => {
	usePhotosStore.setState({ selectedItems: [] })
	document.body.replaceChildren()
	dom = buildGridDom()
})

describe("usePhotosGridNav — cursor movement", () => {
	it("starts on the first tile and steps along the row", () => {
		const { result } = renderNav()

		expect(result.current.safeActiveIndex).toBe(0)

		act(() => {
			result.current.handleKeyDown(keyEvent("ArrowRight"))
		})

		expect(result.current.safeActiveIndex).toBe(1)
	})

	// The virtualizer measures ROWS, not tiles — handing it the item index would scroll `columns` times
	// too far on every vertical move.
	it("scrolls the cursor's ROW into view, not its item index", () => {
		const { result, scrollToIndex } = renderNav()

		act(() => {
			result.current.handleKeyDown(keyEvent("ArrowDown"))
		})

		expect(result.current.safeActiveIndex).toBe(COLUMNS)
		expect(scrollToIndex).toHaveBeenLastCalledWith(1, { align: "auto" })

		act(() => {
			result.current.handleKeyDown(keyEvent("End"))
		})

		expect(scrollToIndex).toHaveBeenLastCalledWith(Math.floor((ITEMS.length - 1) / COLUMNS), { align: "auto" })
	})

	it("keeps the cursor on its own photo after a reorder", () => {
		const { result, rerender } = renderNav()

		act(() => {
			result.current.handleKeyDown(keyEvent("ArrowRight"))
		})

		expect(result.current.safeActiveIndex).toBe(1)

		rerender({ items: [...ITEMS].reverse() })

		expect(result.current.safeActiveIndex).toBe(ITEMS.length - 2)
	})

	it("falls back to the last resolved position once the cursor's photo leaves the grid", () => {
		const { result, rerender } = renderNav()

		act(() => {
			result.current.handleKeyDown(keyEvent("ArrowRight"))
		})

		rerender({ items: ITEMS.filter(item => item.data.uuid !== ITEMS[1]?.data.uuid) })

		expect(result.current.safeActiveIndex).toBe(1)

		rerender({ items: ITEMS.slice(0, 1) })

		expect(result.current.safeActiveIndex).toBe(0)
	})
})

describe("usePhotosGridNav — selection", () => {
	// Plain arrow re-anchors, shifted arrow extends FROM the anchor: swapping the two turns every
	// shift-extension into a single-tile selection.
	it("Shift+Arrow extends the range from the anchor while a plain arrow only moves it", () => {
		const { result, anchor, setAnchorUuid } = renderNav()

		act(() => {
			result.current.handleKeyDown(keyEvent("ArrowRight"))
		})

		expect(setAnchorUuid).toHaveBeenLastCalledWith(ITEMS[1]?.data.uuid)
		expect(selectedUuids()).toEqual([])

		act(() => {
			result.current.handleKeyDown(keyEvent("ArrowRight", { shiftKey: true }))
		})

		expect(selectedUuids()).toEqual([ITEMS[1]?.data.uuid, ITEMS[2]?.data.uuid])
		// The anchor must NOT follow a shifted move, or the next extension starts from the wrong end.
		expect(anchor.uuid).toBe(ITEMS[1]?.data.uuid)

		act(() => {
			result.current.handleKeyDown(keyEvent("ArrowDown", { shiftKey: true }))
		})

		expect(selectedUuids()).toEqual([1, 2, 3, 4, 5, 6].map(index => ITEMS[index]?.data.uuid))
	})

	it("Space toggles the cursor tile and re-anchors on it", () => {
		const { result, anchor } = renderNav()

		act(() => {
			result.current.handleKeyDown(keyEvent("ArrowRight"))
		})
		act(() => {
			result.current.handleKeyDown(keyEvent(" "))
		})

		expect(selectedUuids()).toEqual([ITEMS[1]?.data.uuid])
		expect(anchor.uuid).toBe(ITEMS[1]?.data.uuid)

		act(() => {
			result.current.handleKeyDown(keyEvent(" "))
		})

		expect(selectedUuids()).toEqual([])
	})

	it("Enter opens the cursor tile", () => {
		const { result, onOpen } = renderNav()

		act(() => {
			result.current.handleKeyDown(keyEvent("ArrowDown"))
		})
		act(() => {
			result.current.handleKeyDown(keyEvent("Enter"))
		})

		expect(onOpen).toHaveBeenCalledExactlyOnceWith(COLUMNS)
	})

	it("leaves a key that originated on the tile's own ⋯ trigger to that button", () => {
		const { result, onOpen, scrollToIndex, setAnchorUuid } = renderNav()
		const preventDefault = vi.fn()

		act(() => {
			for (const key of ["Enter", " ", "ArrowRight"]) {
				result.current.handleKeyDown({ ...keyEvent(key, { from: "trigger" }), preventDefault })
			}
		})

		expect(onOpen).not.toHaveBeenCalled()
		expect(scrollToIndex).not.toHaveBeenCalled()
		expect(setAnchorUuid).not.toHaveBeenCalled()
		expect(selectedUuids()).toEqual([])
		expect(result.current.safeActiveIndex).toBe(0)
		// The button's own click (what opens its menu) needs the default action.
		expect(preventDefault).not.toHaveBeenCalled()
	})

	// Base UI turns a menu item's Enter/Space into its click without stopping the keydown, which React
	// then bubbles through the portal into the grid: a Rename or Info entry must not also open the viewer.
	it("leaves Enter and Space from a tile's portaled menu item to the menu", () => {
		const { result, onOpen, setAnchorUuid } = renderNav()

		act(() => {
			result.current.handleKeyDown(keyEvent("ArrowRight"))
		})
		setAnchorUuid.mockClear()
		act(() => {
			result.current.handleKeyDown(keyEvent("Enter", { from: "menuItem" }))
			result.current.handleKeyDown(keyEvent(" ", { from: "menuItem" }))
		})

		expect(onOpen).not.toHaveBeenCalled()
		expect(selectedUuids()).toEqual([])
		expect(setAnchorUuid).not.toHaveBeenCalled()
		expect(result.current.safeActiveIndex).toBe(1)
	})
})

describe("usePhotosGridNav — pointer/marquee entry points", () => {
	it("setActive moves the cursor only; setCursor moves the anchor with it", () => {
		const { result, anchor } = renderNav()

		act(() => {
			result.current.setActive(3)
		})

		expect(result.current.safeActiveIndex).toBe(3)
		expect(anchor.uuid).toBeNull()

		act(() => {
			result.current.setCursor(5)
		})

		expect(result.current.safeActiveIndex).toBe(5)
		expect(anchor.uuid).toBe(ITEMS[5]?.data.uuid)
	})

	it("resetCursor returns to the first tile", () => {
		const { result } = renderNav()

		act(() => {
			result.current.setActive(6)
		})
		act(() => {
			result.current.resetCursor()
		})

		expect(result.current.safeActiveIndex).toBe(0)
	})
})
