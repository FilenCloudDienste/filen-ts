import { describe, expect, it } from "vitest"
import { writeEditablePath, type EditablePath } from "../core/anim/motionEdit"
import { PathDrawing } from "../react/presentation/edit/motionPath/draw"
import type { Refused } from "../core/presentation/model"

// The Draw Custom Path tools' pointer state machine on a 1000 × 500 px slide: how each tool starts, adds points and
// ends, and the path it gives relative to the shape's centre.

const SCREEN = { width: 1000, height: 500 }
const ORIGIN = { x: 0.5, y: 0.5 }

function path(drawing: PathDrawing): string {
	const result: EditablePath | Refused | undefined = drawing.result(ORIGIN)

	if (result === undefined || "reason" in result) throw new Error("no path")

	return writeEditablePath(result).path
}

describe("Draw Custom Path tools", () => {
	it("Line: press, drag and release", () => {
		const drawing = new PathDrawing("line", SCREEN)

		expect(drawing.down(0.5, 0.5, 0)).toBe("continue")
		drawing.move(0.6, 0.6)
		expect(drawing.up(0.7, 0.4)).toBe("done")
		expect(path(drawing)).toBe("M 0 0 L 0.2 -0.1 E")
	})

	it("Line: a click, then a click at the end", () => {
		const drawing = new PathDrawing("line", SCREEN)

		drawing.down(0.5, 0.5, 0)
		expect(drawing.up(0.5, 0.5)).toBe("continue")
		drawing.down(0.6, 0.5, 1000)
		expect(drawing.up(0.6, 0.5)).toBe("done")
		expect(path(drawing)).toBe("M 0 0 L 0.1 0 E")
	})

	it("Line from the keyboard: the first placed point starts it, the next one ends it", () => {
		const drawing = new PathDrawing("line", SCREEN)

		expect(drawing.place(0.5, 0.5)).toBe("continue")
		// Not as far as a drag from the start: no zero-length line.
		expect(drawing.place(0.501, 0.5)).toBe("continue")
		expect(drawing.place(0.6, 0.4)).toBe("done")
		expect(path(drawing)).toBe("M 0 0 L 0.1 -0.1 E")
	})

	it("Curve from the keyboard: placed points as clicks, one placed on the start closes it", () => {
		const drawing = new PathDrawing("curve", SCREEN)

		for (const [x, y] of [
			[0.5, 0.5],
			[0.6, 0.5],
			[0.6, 0.6]
		] as const)
			expect(drawing.place(x, y)).toBe("continue")

		expect(drawing.place(0.5, 0.5)).toBe("done")
		expect(drawing.result(ORIGIN)).toMatchObject({ closed: true })
	})

	it("Scribble takes no placed points (it is drawn by dragging)", () => {
		const drawing = new PathDrawing("scribble", SCREEN)

		expect(drawing.place(0.5, 0.5)).toBe("continue")
		expect(drawing.place(0.6, 0.5)).toBe("continue")
		expect(drawing.result(ORIGIN)).toBeUndefined()
	})

	it("Curve: clicks add points and a double click ends it", () => {
		const drawing = new PathDrawing("curve", SCREEN)

		for (const [i, [x, y]] of [
			[0.5, 0.5],
			[0.6, 0.3],
			[0.7, 0.5]
		].entries()) {
			drawing.down(x ?? 0, y ?? 0, i * 1000)
			drawing.up(x ?? 0, y ?? 0)
		}

		expect(drawing.down(0.7005, 0.5, 2200)).toBe("done")
		expect(writeEditablePath(drawing.result(ORIGIN) as EditablePath).ptsTypes).toBe("aaA")
	})

	it("Freeform: clicks are straight segments, a drag draws freehand, a click on the start closes it", () => {
		const drawing = new PathDrawing("freeform", SCREEN)

		drawing.down(0.5, 0.5, 0)
		drawing.up(0.5, 0.5)
		drawing.down(0.6, 0.5, 1000)
		drawing.up(0.6, 0.5)
		drawing.down(0.6, 0.5, 3000)

		for (let i = 1; i <= 50; i++) drawing.move(0.6, 0.5 + i * 0.004)

		drawing.up(0.6, 0.7)
		expect(drawing.down(0.501, 0.501, 5000)).toBe("done")

		const result = drawing.result(ORIGIN) as EditablePath

		expect(result.closed).toBe(true)
		// The straight freehand run keeps only its ends.
		expect(writeEditablePath(result).path).toBe("M 0 0 L 0.1 0 L 0.1 0.2 L 0 0 Z E")
	})

	it("Scribble: one stroke, simplified within half a pixel, ends on release", () => {
		const drawing = new PathDrawing("scribble", SCREEN)

		drawing.down(0.5, 0.5, 0)

		for (let i = 1; i <= 1000; i++) drawing.move(0.5 + i * 0.0002, 0.5 + Math.sin(i / 100) * 0.1)

		expect(drawing.up(0.7, 0.5 + Math.sin(10) * 0.1)).toBe("done")

		const result = drawing.result(ORIGIN) as EditablePath

		expect(result.xs.length).toBeGreaterThan(10)
		expect(result.xs.length).toBeLessThan(200)
	})

	it("Enter ends a curve of two points; one point gives nothing", () => {
		const one = new PathDrawing("curve", SCREEN)

		one.down(0.5, 0.5, 0)
		one.up(0.5, 0.5)
		expect(one.finishNow()).toBe("continue")
		expect(one.result(ORIGIN)).toBeUndefined()

		one.down(0.6, 0.5, 1000)
		one.up(0.6, 0.5)
		expect(one.finishNow()).toBe("done")
	})
})
