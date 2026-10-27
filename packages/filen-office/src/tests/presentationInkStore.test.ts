import { describe, expect, it } from "vitest"
import { slideRef } from "../core/presentation/model"
import {
	createInkStore,
	INK_HIGHLIGHTER_COLOR,
	INK_HIGHLIGHTER_WIDTH,
	INK_PEN_COLOR,
	INK_PEN_WIDTH,
	type InkChange
} from "../react/presentation/ink/store"
import { budget, cpuMs } from "./timing"

// The show's ink: strokes per slide, growing in typed arrays, mirrored to every listening window, erased, and kept
// as ops when the show ends.

describe("ink store", () => {
	const one = slideRef(3)
	const two = slideRef(4)

	it("draws pen and highlighter strokes only with those tools, and tells every listener as they grow", () => {
		const ink = createInkStore()
		const audience: InkChange[] = []
		const presenter: InkChange[] = []

		ink.listen(change => audience.push(change))
		ink.listen(change => presenter.push(change))
		ink.begin(one, 1, 2)
		expect(ink.strokes(one)).toHaveLength(0)
		ink.setTool("pen")
		ink.begin(one, 1, 2)
		ink.extend([3, 4, 5, 6])
		ink.end()
		ink.setTool("highlighter")
		ink.begin(two, 7, 8)
		ink.end()

		const [pen] = ink.strokes(one)

		expect(pen?.length).toBe(6)
		expect([...(pen?.points.subarray(0, 6) ?? [])]).toEqual([1, 2, 3, 4, 5, 6])
		expect(pen).toMatchObject({ width: INK_PEN_WIDTH, color: INK_PEN_COLOR, highlighter: false })
		expect(ink.strokes(two)[0]).toMatchObject({ width: INK_HIGHLIGHTER_WIDTH, color: INK_HIGHLIGHTER_COLOR, highlighter: true })
		expect(audience.map(change => (change.kind === "extend" ? change.from : -1))).toEqual([0, 2, 0])
		expect(presenter).toEqual(audience)
		expect(ink.getSnapshot().inked).toBe(true)
	})

	it("keeps the pen's colour across the highlighter", () => {
		const ink = createInkStore()

		ink.setTool("pen")
		ink.setColor("0070C0")
		ink.setTool("highlighter")
		expect(ink.getSnapshot().color).toBe(INK_HIGHLIGHTER_COLOR)
		ink.setTool("pen")
		expect(ink.getSnapshot().color).toBe("0070C0")
	})

	it("erases the topmost stroke under the eraser and clears a slide", () => {
		const ink = createInkStore()
		const redraws: InkChange[] = []

		ink.listen(change => {
			if (change.kind === "redraw") redraws.push(change)
		})
		ink.setTool("pen")
		ink.begin(one, 0, 0)
		ink.extend([100_000, 0])
		ink.end()
		ink.begin(one, 0, 50_000)
		ink.extend([100_000, 50_000])
		ink.end()
		expect(ink.eraseAt(one, 50_000, 900_000, 1000)).toBe(false)
		expect(ink.eraseAt(one, 50_000, 49_000, 1000)).toBe(true)
		expect(ink.strokes(one)).toHaveLength(1)
		expect(ink.strokes(one)[0]?.points[1]).toBe(0)
		ink.clear(one)
		expect(ink.strokes(one)).toHaveLength(0)
		expect(ink.getSnapshot().inked).toBe(false)
		expect(redraws).toHaveLength(2)
	})

	it("hands the ink over as one op per slide with its own copy of the points", () => {
		const ink = createInkStore()

		ink.setTool("pen")
		ink.begin(one, 1, 2)
		ink.extend([3, 4])
		ink.end()
		ink.setTool("highlighter")
		ink.begin(one, 5, 6)
		ink.end()

		const ops = ink.ops("Ink")

		expect(ops).toHaveLength(1)
		expect(ops[0]).toMatchObject({ family: "ink", kind: "add", slide: one, name: "Ink" })
		expect(ops[0]?.strokes.map(stroke => [...stroke.points])).toEqual([
			[1, 2, 3, 4],
			[5, 6]
		])
		expect(ops[0]?.strokes[1]).toMatchObject({ highlighter: true, color: { kind: "srgb", rgb: INK_HIGHLIGHTER_COLOR } })
		// Transferring the op's arrays never detaches the store's.
		expect(ops[0]?.strokes[0]?.points.buffer).not.toBe(ink.strokes(one)[0]?.points.buffer)
		ink.reset()
		expect(ink.ops("Ink")).toEqual([])
		expect(ink.getSnapshot()).toEqual({ tool: "none", color: INK_PEN_COLOR, inked: false })
	})

	it("appends a pointer event's points in well under 2 ms", () => {
		const ink = createInkStore()
		let drawn = 0

		ink.listen(change => {
			if (change.kind === "extend") drawn += change.stroke.length - change.from
		})
		ink.setTool("pen")
		ink.begin(one, 0, 0)

		const events = 20_000
		const samples = [0, 0, 0, 0, 0, 0, 0, 0]
		const start = cpuMs()

		for (let event = 0; event < events; event++) {
			for (let index = 0; index < samples.length; index += 2) {
				samples[index] = event * 10 + index
				samples[index + 1] = event * 5
			}

			ink.extend(samples)
		}

		const perEvent = (cpuMs() - start) / events

		ink.end()
		expect(drawn).toBe(2 + events * samples.length)
		expect(ink.strokes(one)[0]?.length).toBe(2 + events * samples.length)
		expect(perEvent).toBeLessThan(budget(0.05))
	})
})
