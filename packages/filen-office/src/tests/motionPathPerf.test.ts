import { describe, expect, it } from "vitest"
import { movePoint, polylinePath, simplifyStroke, writeEditablePath, type EditablePath, type Point } from "../core/anim/motionEdit"
import { anchorsData, editableData, handlesData, placementOf } from "../react/presentation/edit/motionPath/geometry"
import { budget, cpuMs } from "./timing"

// Edit Points on a 2,000-point scribble path: what one animation frame of a point drag computes on the main thread
// (the edited path from the path the drag began on, and the path data of the path, its anchors and the point's
// handles), and the drop's path attribute; and the Scribble tool's simplification of a long stroke.

const RUNS = 5
const FRAMES = 60
const POINTS = 2000
const SIZE = { cx: 12192000, cy: 6858000 }

function scribble(): EditablePath {
	const points: Point[] = []

	for (let i = 0; i < POINTS; i++) points.push({ x: (i / POINTS) * 0.6 - 0.3, y: Math.sin(i / 7) * 0.1 + Math.cos(i / 31) * 0.05 })

	const path = polylinePath(points)

	if ("reason" in path) throw new Error(path.reason)

	return path
}

describe("motionPathPerf", () => {
	it("a point drag frame on a 2,000-point path costs at most 4 ms of CPU, the drop 8 ms", { timeout: budget(60_000) }, ({ task }) => {
		const base = scribble()
		const placement = placementOf({ x: 6096000, y: 3429000 }, SIZE, 1)
		let frame = Number.POSITIVE_INFINITY
		let drop = Number.POSITIVE_INFINITY

		expect(base.xs).toHaveLength(POINTS)

		for (let run = 0; run < RUNS; run++) {
			let worst = 0
			let edited = base

			for (let f = 0; f < FRAMES; f++) {
				const start = cpuMs()

				edited = movePoint(base, 1000, (base.xs[1000] ?? 0) + f * 0.001, (base.ys[1000] ?? 0) - f * 0.0005)

				const data =
					editableData(placement, edited).length +
					anchorsData(placement, edited).length +
					handlesData(placement, edited, 1000).lines.length

				worst = Math.max(worst, cpuMs() - start)
				expect(data).toBeGreaterThan(0)
			}

			frame = Math.min(frame, worst)

			const start = cpuMs()

			expect(writeEditablePath(edited).path.length).toBeGreaterThan(0)
			drop = Math.min(drop, cpuMs() - start)
		}

		Object.assign(task.meta, { perf: { dragFrameCpuMs: { value: frame, budget: 4 }, dropCpuMs: { value: drop, budget: 8 } } })
		expect(frame).toBeLessThanOrEqual(4)
		expect(drop).toBeLessThanOrEqual(8)
	})

	it("simplifies a 20,000-sample scribble stroke in at most 10 ms of CPU", { timeout: budget(60_000) }, ({ task }) => {
		const stroke = new Float64Array(2 * 20_000)

		for (let i = 0; i < 20_000; i++) {
			stroke[i * 2] = i / 20_000
			stroke[i * 2 + 1] = 0.5 + Math.sin(i / 50) * 0.2 + ((i * 7919) % 13) * 1e-5
		}

		let best = Number.POSITIVE_INFINITY

		for (let run = 0; run < RUNS; run++) {
			const start = cpuMs()
			const kept = simplifyStroke(stroke, 0.5 / 720, 16 / 9)

			best = Math.min(best, cpuMs() - start)
			expect(kept.length).toBeGreaterThan(2)
			expect(kept.length).toBeLessThan(20_000)
		}

		Object.assign(task.meta, { perf: { simplifyCpuMs: { value: best, budget: 10 } } })
		expect(best).toBeLessThanOrEqual(10)
	})
})
