import { describe, expect, it } from "vitest"
import {
	MINI_TOOLBAR_EDGE,
	MINI_TOOLBAR_FADED,
	MINI_TOOLBAR_FADE_OUT,
	MINI_TOOLBAR_GAP,
	MINI_TOOLBAR_MIN_START,
	hidesMiniToolbar,
	miniToolbarOpacity,
	mouseContextMenu,
	placeMiniToolbar,
	rectDistance
} from "@/features/preview/components/docxMiniToolbar.logic"

// Word's Mini toolbar: faded as it appears, opaque as the pointer reaches it, gone as it moves away; placed above the
// selection's line inside the viewport and clear of the context menu; shown for the mouse's right click alone.

const VIEWPORT = { left: 0, top: 0, right: 1000, bottom: 800 }

describe("rectDistance", () => {
	it("is 0 inside and the straight distance outside", () => {
		const rect = { left: 10, top: 10, right: 110, bottom: 50 }

		expect(rectDistance(rect, 50, 30)).toBe(0)
		expect(rectDistance(rect, 50, 60)).toBe(10)
		expect(rectDistance(rect, 0, 30)).toBe(10)
		expect(rectDistance(rect, 113, 54)).toBe(5)
	})
})

describe("miniToolbarOpacity", () => {
	it("is faded where it appeared and opaque on the toolbar", () => {
		expect(miniToolbarOpacity(60, 60)).toBeCloseTo(MINI_TOOLBAR_FADED)
		expect(miniToolbarOpacity(0, 60)).toBe(1)
		expect(miniToolbarOpacity(30, 60)).toBeCloseTo((MINI_TOOLBAR_FADED + 1) / 2)
	})

	it("fades out moving away and hides past the fade-out distance", () => {
		const half = miniToolbarOpacity(60 + MINI_TOOLBAR_FADE_OUT / 2, 60)

		expect(half).toBeCloseTo(MINI_TOOLBAR_FADED / 2)
		expect(miniToolbarOpacity(60 + MINI_TOOLBAR_FADE_OUT, 60)).toBeNull()
		expect(miniToolbarOpacity(500, 60)).toBeNull()
	})

	it("measures the fade-in over a least distance when shown at the pointer", () => {
		expect(miniToolbarOpacity(MINI_TOOLBAR_MIN_START, 0)).toBeCloseTo(MINI_TOOLBAR_FADED)
		expect(miniToolbarOpacity(MINI_TOOLBAR_MIN_START + 1, 0)).not.toBeNull()
	})
})

describe("placeMiniToolbar", () => {
	it("goes above the line, starting a little left of the point", () => {
		expect(placeMiniToolbar(400, 72, { x: 300, y: 400, below: 20 }, VIEWPORT)).toEqual({
			left: 300 - MINI_TOOLBAR_EDGE,
			top: 400 - MINI_TOOLBAR_GAP - 72
		})
	})

	it("stays inside the viewport", () => {
		expect(placeMiniToolbar(400, 72, { x: 900, y: 400, below: 20 }, VIEWPORT).left).toBe(1000 - MINI_TOOLBAR_EDGE - 400)
		expect(placeMiniToolbar(400, 72, { x: 2, y: 400, below: 20 }, VIEWPORT).left).toBe(MINI_TOOLBAR_EDGE)
		expect(placeMiniToolbar(1200, 72, { x: 300, y: 400, below: 20 }, VIEWPORT).left).toBe(MINI_TOOLBAR_EDGE)
	})

	it("goes below the line where there is no room above it", () => {
		expect(placeMiniToolbar(400, 72, { x: 300, y: 30, below: 20 }, VIEWPORT).top).toBe(30 + 20 + MINI_TOOLBAR_GAP)
		// No room either way: its top inside the top edge.
		expect(placeMiniToolbar(400, 72, { x: 300, y: 790, below: 20 }, { ...VIEWPORT, top: 760 }).top).toBe(760 + MINI_TOOLBAR_EDGE)
	})

	it("keeps clear of the context menu: above it, else below it", () => {
		const menu = { left: 300, top: 100, right: 500, bottom: 500 }

		expect(placeMiniToolbar(400, 72, { x: 300, y: 300, below: 0 }, VIEWPORT, menu).top).toBe(100 - MINI_TOOLBAR_GAP - 72)
		expect(placeMiniToolbar(400, 72, { x: 300, y: 300, below: 0 }, VIEWPORT, { ...menu, top: 40 }).top).toBe(500 + MINI_TOOLBAR_GAP)
		// Already clear: where it was.
		expect(placeMiniToolbar(400, 72, { x: 300, y: 300, below: 0 }, VIEWPORT, { ...menu, top: 310 }).top).toBe(
			300 - MINI_TOOLBAR_GAP - 72
		)
	})
})

describe("mouseContextMenu", () => {
	it("takes the mouse's right click, not the menu key, Shift+F10 or touch", () => {
		expect(mouseContextMenu({ button: 2, pointerType: "mouse" })).toBe(true)
		expect(mouseContextMenu({ button: 2 })).toBe(true)
		expect(mouseContextMenu({ button: 0 })).toBe(false)
		expect(mouseContextMenu({ button: 0, pointerType: "" })).toBe(false)
		expect(mouseContextMenu({ button: 2, pointerType: "touch" })).toBe(false)
		expect(mouseContextMenu({ button: 2, pointerType: "pen" })).toBe(false)
	})
})

describe("hidesMiniToolbar", () => {
	it("hides on a key typed, not on a modifier held", () => {
		for (const key of ["a", "Enter", "ArrowLeft", "Escape", "Backspace"]) {
			expect(hidesMiniToolbar(key)).toBe(true)
		}

		for (const key of ["Shift", "Control", "Alt", "Meta"]) {
			expect(hidesMiniToolbar(key)).toBe(false)
		}
	})
})
