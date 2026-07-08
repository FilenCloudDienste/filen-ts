import { describe, expect, it } from "vitest"
import { enterDragDepth, leaveDragDepth } from "@/components/drive/upload-dropzone.logic"

describe("enterDragDepth", () => {
	it("increments from zero", () => {
		expect(enterDragDepth(0)).toBe(1)
	})

	it("increments a positive depth", () => {
		expect(enterDragDepth(3)).toBe(4)
	})
})

describe("leaveDragDepth", () => {
	it("decrements a positive depth", () => {
		expect(leaveDragDepth(2)).toBe(1)
	})

	it("floors at zero instead of going negative", () => {
		expect(leaveDragDepth(0)).toBe(0)
	})

	it("stays at zero across repeated leaves with no matching enter", () => {
		expect(leaveDragDepth(leaveDragDepth(leaveDragDepth(0)))).toBe(0)
	})
})

describe("enterDragDepth/leaveDragDepth together", () => {
	it("stays active while the cursor moves from the zone onto a nested child", () => {
		let depth = 0
		depth = enterDragDepth(depth) // enters the zone
		depth = enterDragDepth(depth) // enters a child row
		depth = leaveDragDepth(depth) // leaves the child row, still inside the zone

		expect(depth).toBeGreaterThan(0)
	})

	it("returns to zero once a balanced enter/leave sequence fully exits the zone", () => {
		let depth = 0
		depth = enterDragDepth(depth)
		depth = enterDragDepth(depth)
		depth = leaveDragDepth(depth)
		depth = leaveDragDepth(depth)

		expect(depth).toBe(0)
	})
})
