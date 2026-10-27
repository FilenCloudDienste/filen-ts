import { describe, expect, it } from "vitest"
import type { TimeNode } from "../core/anim/model"
import { compile, instantiate } from "../core/anim/timegraph"
import { BUDGETS, TimingBuilder, animatedSlide, shape } from "./animFixtures"
import { budget, cpuMs } from "./timing"

// timegraphPerf: compiling a 200-node slide takes at most 5 ms of CPU; a frame's sample of its 40 layers at most 1 ms;
// a click that begins 3,000 effects at once is scheduled within one frame (16 ms).

function slide(): ReturnType<typeof animatedSlide> {
	const b = new TimingBuilder()
	const groups: TimeNode[] = []

	// 20 click groups of a fly-in (4 nodes), a fade-out (4) and a spin (2) with their with/after groups: 10 nodes each.
	for (let k = 0; k < 20; k++) {
		const id = 10 + k * 2

		groups.push(
			b.click([
				[0, [b.flyIn(id, "clickEffect"), b.fadeOut(id + 1, "withEffect")]],
				[500, [b.spin(id, "afterEffect", 1000)]]
			])
		)
	}

	return animatedSlide(
		b.root([b.mainSeq(groups)]),
		Array.from({ length: 40 }, (_, k) => shape(10 + k, k * 100000, k * 50000))
	)
}

describe("timegraphPerf", () => {
	it("compiles a 200-node slide in at most 5 ms of CPU and samples a frame in at most 1 ms", { timeout: budget(60_000) }, () => {
		const node = slide()
		const layers = { shapes: Int32Array.from({ length: 40 }, (_, k) => 10 + k) }
		let count = 0
		const visit = (n: TimeNode): void => {
			count++
			n.ctn.children.forEach(visit)
		}

		visit(node.timing?.root ?? { kind: "par", ctn: { id: 0, stCondLst: [], endCondLst: [], children: [] } })
		expect(count).toBeGreaterThanOrEqual(200)

		let compileBest = Number.POSITIVE_INFINITY
		let sampleBest = Number.POSITIVE_INFINITY

		for (let run = 0; run < 5; run++) {
			const start = cpuMs()
			const graph = compile(node, layers, BUDGETS)

			compileBest = Math.min(compileBest, cpuMs() - start)

			const instance = instantiate(graph)

			instance.fire({ kind: "slideBegin" }, 0)

			for (let step = 0; step < 20; step++) instance.fire({ kind: "next" }, step * 3000)

			const frames = 60
			const sampled = cpuMs()

			for (let frame = 0; frame < frames; frame++) instance.sample(57000 + frame * 16)

			sampleBest = Math.min(sampleBest, (cpuMs() - sampled) / frames)
		}

		expect(compileBest).toBeLessThanOrEqual(budget(5))
		expect(sampleBest).toBeLessThanOrEqual(budget(1))
	})

	it("schedules a click of 3,000 effects (9,000 nodes) within one frame", { timeout: budget(60_000) }, () => {
		const b = new TimingBuilder()
		const effects: TimeNode[] = []

		for (let k = 0; k < 3000; k++)
			effects.push(b.flyIn(10 + k, k === 0 ? "clickEffect" : "withEffect"), b.spin(10 + k, "withEffect", 1000))

		const node = animatedSlide(
			b.root([b.mainSeq([b.click([[0, effects]])])]),
			Array.from({ length: 3000 }, (_, k) => shape(10 + k, k * 1000, k * 500))
		)
		const graph = compile(node, { shapes: Int32Array.from({ length: 3000 }, (_, k) => 10 + k) }, BUDGETS)
		let best = Number.POSITIVE_INFINITY

		for (let run = 0; run < 3; run++) {
			const instance = instantiate(graph)

			instance.fire({ kind: "slideBegin" }, 0)

			const start = cpuMs()

			instance.fire({ kind: "next" }, 1000)
			best = Math.min(best, cpuMs() - start)
		}

		expect(best).toBeLessThanOrEqual(budget(16))
	})
})
