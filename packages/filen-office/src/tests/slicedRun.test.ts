import { describe, expect, it } from "vitest"
import { longestStretch, slicedRun } from "./slicedRun"

describe("the longest stretch of a sliced run", () => {
	it("leaves out a collection inside a stretch, which a measure taken at the stretch's end would have missed", () => {
		// A 60 ms collection inside the second slice: its entry arrives after that stretch closed.
		const stretches = [
			{ fromWall: 0, toWall: 8, cpu: 8 },
			{ fromWall: 9, toWall: 77, cpu: 68 },
			{ fromWall: 78, toWall: 86, cpu: 8 }
		]

		expect(longestStretch(stretches, [])).toBe(68)
		expect(longestStretch(stretches, [{ start: 12, end: 72 }])).toBe(8)
	})

	it("counts only the part of a collection within the stretch's window", () => {
		const stretches = [{ fromWall: 10, toWall: 40, cpu: 30 }]

		// 5 ms before the window, 10 ms in it; another wholly after it.
		expect(
			longestStretch(stretches, [
				{ start: 5, end: 20 },
				{ start: 50, end: 90 }
			])
		).toBe(20)
	})

	it("is never negative", () => {
		expect(longestStretch([{ fromWall: 0, toWall: 10, cpu: 2 }], [{ start: 0, end: 10 }])).toBe(0)
		expect(longestStretch([], [])).toBe(0)
	})
})

describe("a sliced run", () => {
	it("hands the save a slicing and counts its turns", async () => {
		const run = await slicedRun(async slicing => {
			for (let k = 0; k < 3; k++) await slicing.pause()

			return "done"
		})

		expect(run.result).toBe("done")
		expect(run.turns).toBe(3)
		expect(run.longest).toBeGreaterThanOrEqual(0)
	})
})
