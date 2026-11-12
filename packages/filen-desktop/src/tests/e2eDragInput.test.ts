import { describe, expect, it } from "vitest"
import { dropPoint, durationMs, encodeSteps, FRAME_MS, gesture, sideBySide, toScreen, xdotoolArgs } from "../../scripts/ci/e2e/dragInput.ts"

// Chain D's real input (scripts/ci/e2e/dragInput.ts): the gestures every OS helper replays, and where the windows go.
describe("drag gestures", () => {
	it("glides one whole-pixel move a frame and ends on the target", () => {
		const moves = gesture({ x: 0, y: 0 })
			.glide({ x: 100, y: 50 }, 80)
			.primitives()
			.filter(primitive => primitive.op === "move")

		expect(moves).toHaveLength(5)
		expect(moves.at(-1)).toEqual({ op: "move", at: { x: 100, y: 50 } })
		expect(moves.every(move => Number.isInteger(move.at.x) && Number.isInteger(move.at.y))).toBe(true)
	})

	it("holds with a jitter of one pixel and comes back where it was", () => {
		const held = gesture({ x: 10, y: 20 }).hold(FRAME_MS * 4)
		const moves = held.primitives().filter(primitive => primitive.op === "move")

		expect(moves.map(move => move.at.x)).toEqual([11, 10, 11, 10, 10])
		expect(held.point).toEqual({ x: 10, y: 20 })
		expect(durationMs(held.primitives())).toBe(FRAME_MS * 4)
	})

	it("encodes the steps the Windows and macOS helpers read", () => {
		const steps = gesture({ x: 1.4, y: 2.6 }).at({ x: 1.4, y: 2.6 }).press().wait(20).escape().release().wait(0).primitives()

		expect(encodeSteps(steps)).toBe("m 1 3;d;s 20;k esc;u")
	})

	it("says the button is still held from the last gesture, which X tracks itself", () => {
		const steps = gesture({ x: 5, y: 6 }).held().hold(FRAME_MS).release().primitives()

		expect(encodeSteps(steps)).toBe("h;m 6 6;s 16;m 5 6;u")
		expect(xdotoolArgs(steps)).toEqual(["mousemove", "6", "6", "sleep", "0.016", "mousemove", "5", "6", "mouseup", "1"])
	})

	it("chains the whole gesture into one xdotool command line", () => {
		const steps = gesture({ x: 5, y: 6 }).at({ x: 5, y: 6 }).press().wait(1500).escape().release().primitives()

		expect(xdotoolArgs(steps)).toEqual(["mousemove", "5", "6", "mousedown", "1", "sleep", "1.500", "key", "Escape", "mouseup", "1"])
	})

	it("maps a page point to the screen through the calibration", () => {
		expect(toScreen({ offset: { x: 10, y: 40 }, scale: 1.5 }, { x: 100, y: 20 })).toEqual({ x: 165, y: 90 })
	})
})

describe("drag window layout", () => {
	it("puts the app left and the file manager right, apart, within the insets", () => {
		const layout = sideBySide({ x: 0, y: 0, width: 1920, height: 1080 }, 800, { top: 0, bottom: 56 })

		expect(layout).not.toBeNull()

		const { app, target } = layout ?? { app: { x: 0, y: 0, width: 0, height: 0 }, target: { x: 0, y: 0, width: 0, height: 0 } }

		expect(app.width).toBeGreaterThanOrEqual(800)
		expect(target.x).toBeGreaterThan(app.x + app.width)
		expect(target.x + target.width).toBeLessThanOrEqual(1920)
		expect(app.y + app.height).toBeLessThanOrEqual(1080 - 56)

		const drop = dropPoint(target)

		expect(drop.x).toBeGreaterThan(target.x)
		expect(drop.x).toBeLessThan(target.x + target.width)
		expect(drop.y).toBeLessThan(target.y + target.height)
	})

	it("keeps the app at its minimum width and refuses a screen too narrow for both", () => {
		expect(sideBySide({ x: 0, y: 0, width: 1280, height: 1000 }, 800, { top: 0, bottom: 0 })?.app.width).toBe(800)
		expect(sideBySide({ x: 0, y: 0, width: 1024, height: 768 }, 800, { top: 0, bottom: 0 })).toBeNull()
	})
})
