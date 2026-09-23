// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { isKeepSelectionTarget, isPlainPointerClick, isScrollbarPress, KEEP_SELECTION_PROPS } from "@/features/drive/lib/clickAway.logic"
import { useClickAwayDeselect } from "@/features/drive/hooks/useClickAwayDeselect"

let root: HTMLDivElement

beforeEach(() => {
	root = document.createElement("div")
	root.id = "root"
	root.innerHTML = `
		<header id="page-header">
			<nav id="breadcrumb" data-keep-selection><span id="crumb">Drive</span></nav>
			<div id="header-gap"></div>
			<button id="sort"><svg id="sort-icon"></svg></button>
		</header>
		<div id="search" data-keep-selection><kbd id="search-hint">/</kbd><input id="search-input" /></div>
		<div role="listbox" id="listbox">
			<div role="presentation" id="sized">
				<div role="option" id="row"><span id="row-name">a.txt</span></div>
			</div>
		</div>
		<div role="toolbar" id="bulk-bar"><p id="bulk-count">1 selected</p></div>
		<div role="separator" id="resize"></div>
		<a href="/x" id="link"><span id="link-text">x</span></a>
	`
	document.body.appendChild(root)
})

afterEach(() => {
	document.body.innerHTML = ""
})

function byId(id: string): Element {
	const el = document.getElementById(id)

	if (!el) {
		throw new Error(`missing #${id}`)
	}

	return el
}

describe("isKeepSelectionTarget", () => {
	it("treats listing whitespace and header background as empty space", () => {
		for (const id of ["listbox", "sized", "page-header", "header-gap", "root"]) {
			expect(isKeepSelectionTarget(byId(id), root), id).toBe(false)
		}
	})

	it("keeps the selection for an item and anything inside it", () => {
		expect(isKeepSelectionTarget(byId("row"), root)).toBe(true)
		expect(isKeepSelectionTarget(byId("row-name"), root)).toBe(true)
	})

	it("keeps the selection for controls, including their inner glyphs", () => {
		for (const id of ["sort", "sort-icon", "search-input", "link", "link-text", "resize"]) {
			expect(isKeepSelectionTarget(byId(id), root), id).toBe(true)
		}
	})

	it("keeps the selection for the bulk bar, breadcrumb and search field backgrounds", () => {
		for (const id of ["bulk-bar", "bulk-count", "breadcrumb", "crumb", "search", "search-hint"]) {
			expect(isKeepSelectionTarget(byId(id), root), id).toBe(true)
		}
	})

	it("keeps the selection for anything portalled outside the app root", () => {
		const portal = document.createElement("div")
		const inner = document.createElement("span")

		portal.appendChild(inner)
		document.body.appendChild(portal)

		expect(isKeepSelectionTarget(inner, root)).toBe(true)
	})

	it("never treats a non-element target as empty space", () => {
		expect(isKeepSelectionTarget(null, root)).toBe(true)
		expect(isKeepSelectionTarget(window, root)).toBe(true)
	})

	it("spreads the same marker the classifier reads", () => {
		const el = document.createElement("div")

		for (const [key, value] of Object.entries(KEEP_SELECTION_PROPS)) {
			el.setAttribute(key, value)
		}

		root.appendChild(el)

		expect(isKeepSelectionTarget(el, root)).toBe(true)
	})
})

describe("isPlainPointerClick", () => {
	const plain = { button: 0, detail: 1, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }

	it("accepts a plain primary click, including later clicks of a sequence", () => {
		expect(isPlainPointerClick(plain)).toBe(true)
		expect(isPlainPointerClick({ ...plain, detail: 2 })).toBe(true)
	})

	it("rejects a keyboard- or script-synthesized click", () => {
		expect(isPlainPointerClick({ ...plain, detail: 0 })).toBe(false)
	})

	it("rejects any modifier", () => {
		expect(isPlainPointerClick({ ...plain, shiftKey: true })).toBe(false)
		expect(isPlainPointerClick({ ...plain, metaKey: true })).toBe(false)
		expect(isPlainPointerClick({ ...plain, ctrlKey: true })).toBe(false)
		expect(isPlainPointerClick({ ...plain, altKey: true })).toBe(false)
	})

	it("rejects a non-primary button", () => {
		expect(isPlainPointerClick({ ...plain, button: 1 })).toBe(false)
		expect(isPlainPointerClick({ ...plain, button: 2 })).toBe(false)
	})
})

describe("isScrollbarPress", () => {
	const overflowing = { clientLeft: 0, clientTop: 0, clientWidth: 785, clientHeight: 600, scrollWidth: 785, scrollHeight: 2000 }

	it("flags a press in the vertical scrollbar gutter of an overflowing element", () => {
		expect(isScrollbarPress(790, 100, overflowing)).toBe(true)
	})

	it("does not flag a press inside the client box", () => {
		expect(isScrollbarPress(400, 100, overflowing)).toBe(false)
	})

	it("does not flag an element that does not overflow", () => {
		expect(isScrollbarPress(790, 100, { ...overflowing, scrollHeight: 600 })).toBe(false)
	})

	it("offsets by the border via clientLeft", () => {
		expect(isScrollbarPress(786, 100, { ...overflowing, clientLeft: 2 })).toBe(false)
		expect(isScrollbarPress(787, 100, { ...overflowing, clientLeft: 2 })).toBe(true)
	})

	it("flags the horizontal gutter only when the element overflows horizontally", () => {
		expect(isScrollbarPress(100, 605, { ...overflowing, scrollHeight: 600, scrollWidth: 2000 })).toBe(true)
		expect(isScrollbarPress(100, 605, overflowing)).toBe(false)
	})
})

describe("useClickAwayDeselect", () => {
	function press(target: Element, init: { x?: number; y?: number; endX?: number; endY?: number; detail?: number } = {}): void {
		const x = init.x ?? 10
		const y = init.y ?? 10

		target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, clientX: x, clientY: y }))

		if (init.endX !== undefined || init.endY !== undefined) {
			target.dispatchEvent(
				new PointerEvent("pointermove", { bubbles: true, isPrimary: true, clientX: init.endX ?? x, clientY: init.endY ?? y })
			)
		}

		target.dispatchEvent(
			new MouseEvent("click", {
				bubbles: true,
				button: 0,
				detail: init.detail ?? 1,
				clientX: init.endX ?? x,
				clientY: init.endY ?? y
			})
		)
	}

	it("clears on a plain click in empty listing space", () => {
		const clear = vi.fn()

		renderHook(() => {
			useClickAwayDeselect(true, clear)
		})
		press(byId("listbox"))

		expect(clear).toHaveBeenCalledTimes(1)
	})

	it("does nothing while inactive (no selection)", () => {
		const clear = vi.fn()

		renderHook(() => {
			useClickAwayDeselect(false, clear)
		})
		press(byId("listbox"))

		expect(clear).not.toHaveBeenCalled()
	})

	it("keeps the selection for a click on an item or a control", () => {
		const clear = vi.fn()

		renderHook(() => {
			useClickAwayDeselect(true, clear)
		})
		press(byId("row-name"))
		press(byId("sort"))

		expect(clear).not.toHaveBeenCalled()
	})

	it("treats a press that travelled past the drag threshold as a drag, not a click", () => {
		const clear = vi.fn()

		renderHook(() => {
			useClickAwayDeselect(true, clear)
		})
		press(byId("listbox"), { x: 10, y: 10, endX: 10, endY: 200 })

		expect(clear).not.toHaveBeenCalled()
	})

	it("still counts a sub-threshold wiggle as a click", () => {
		const clear = vi.fn()

		renderHook(() => {
			useClickAwayDeselect(true, clear)
		})
		press(byId("listbox"), { x: 10, y: 10, endX: 12, endY: 11 })

		expect(clear).toHaveBeenCalledTimes(1)
	})

	it("ignores a press that was cancelled by the browser (native drag, touch pan)", () => {
		const clear = vi.fn()

		renderHook(() => {
			useClickAwayDeselect(true, clear)
		})

		const listbox = byId("listbox")

		listbox.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true }))
		listbox.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, isPrimary: true }))
		listbox.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }))

		expect(clear).not.toHaveBeenCalled()
	})

	it("ignores a click with no pointer press behind it (keyboard activation)", () => {
		const clear = vi.fn()

		renderHook(() => {
			useClickAwayDeselect(true, clear)
		})
		byId("listbox").dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 0 }))

		expect(clear).not.toHaveBeenCalled()
	})

	it("ignores a modifier click", () => {
		const clear = vi.fn()

		renderHook(() => {
			useClickAwayDeselect(true, clear)
		})

		const listbox = byId("listbox")

		listbox.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true }))
		listbox.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1, metaKey: true }))

		expect(clear).not.toHaveBeenCalled()
	})

	it("only dismisses an open menu when the press lands outside it", () => {
		const clear = vi.fn()
		const menu = document.createElement("div")

		menu.setAttribute("role", "menu")
		menu.setAttribute("data-open", "")
		document.body.appendChild(menu)

		renderHook(() => {
			useClickAwayDeselect(true, clear)
		})

		const listbox = byId("listbox")

		listbox.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true }))
		// The menu closes between press and click, as Base UI does on an outside press.
		menu.remove()
		listbox.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }))

		expect(clear).not.toHaveBeenCalled()
	})

	it("stops listening on unmount", () => {
		const clear = vi.fn()
		const { unmount } = renderHook(() => {
			useClickAwayDeselect(true, clear)
		})

		unmount()
		press(byId("listbox"))

		expect(clear).not.toHaveBeenCalled()
	})
})
