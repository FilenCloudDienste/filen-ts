// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { DRAG_THRESHOLD_PX, outsideWindow, passedThreshold, pickDropTarget } from "@/features/drive/lib/pointerDrag.logic"

describe("passedThreshold", () => {
	it("is false at 3 px and true at 4", () => {
		expect(DRAG_THRESHOLD_PX).toBe(4)
		expect(passedThreshold({ x: 10, y: 10 }, { x: 13, y: 10 })).toBe(false)
		expect(passedThreshold({ x: 10, y: 10 }, { x: 10, y: 14 })).toBe(true)
	})
})

describe("outsideWindow", () => {
	const size = { width: 800, height: 600 }

	it("needs 2 px past an edge", () => {
		expect(outsideWindow({ x: 400, y: 300 }, size)).toBe(false)
		expect(outsideWindow({ x: -1, y: 300 }, size)).toBe(false)
		expect(outsideWindow({ x: -2, y: 300 }, size)).toBe(true)
		expect(outsideWindow({ x: 801, y: 300 }, size)).toBe(false)
		expect(outsideWindow({ x: 802, y: 300 }, size)).toBe(true)
		expect(outsideWindow({ x: 400, y: -2 }, size)).toBe(true)
		expect(outsideWindow({ x: 400, y: 601 }, size)).toBe(false)
		expect(outsideWindow({ x: 400, y: 602 }, size)).toBe(true)
	})
})

describe("pickDropTarget", () => {
	it("returns the nearest accepting ancestor and skips a refusing one", () => {
		const outer = document.createElement("div")
		const middle = document.createElement("div")
		const inner = document.createElement("div")
		const chain = [inner, middle, outer]

		expect(pickDropTarget(chain, target => target !== inner)).toBe(middle)
		expect(pickDropTarget(chain, target => target === outer)).toBe(outer)
		expect(pickDropTarget(chain, () => true)).toBe(inner)
		expect(pickDropTarget(chain, () => false)).toBeNull()
		expect(pickDropTarget([], () => true)).toBeNull()
	})
})
