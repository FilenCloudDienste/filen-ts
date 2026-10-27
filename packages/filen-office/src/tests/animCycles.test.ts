import { describe, expect, it } from "vitest"
import type { TimeCondition, TimeNode } from "../core/anim/model"
import { compile, instantiate } from "../core/anim/timegraph"
import { PresentationError } from "../core/presentation/model"
import { BUDGETS, TimingBuilder, animatedSlide, layersOf, shape } from "./animFixtures"
import { budget, cpuMs } from "./timing"

// Node conditions (tn begin/end references) that form a cycle: SMIL 3.0 §5.4.5 ignores the change notice that reaches
// an element already on its propagation path, so the closing condition never resolves and nothing loops.

const SHAPES = [shape(2), shape(3)]
const LAYERS = layersOf([2, 3])

function visible(t: ReturnType<typeof instantiate>, at: number): number[] {
	return t
		.sample(at)
		.filter(layer => layer.visible)
		.map(layer => layer.layer)
}

function play(nodes: readonly TimeNode[], b: TimingBuilder, events: (t: ReturnType<typeof instantiate>) => void): string {
	try {
		const t = instantiate(compile(animatedSlide(b.root([...nodes]), SHAPES), LAYERS, BUDGETS))

		t.fire({ kind: "slideBegin" }, 0)
		events(t)

		return "ok"
	} catch (error) {
		if (error instanceof PresentationError) return `refused ${error.reason}`

		throw error
	}
}

describe("timegraph node-condition cycles", () => {
	it("plays two nodes that begin on each other's begin once each, without recursing", () => {
		const b = new TimingBuilder()
		const a: TimeNode = {
			kind: "par",
			ctn: b.ctn({
				id: 100,
				dur: 1000,
				restart: "always",
				stCondLst: [
					{ evt: "onNext", delay: 0 },
					{ tn: 101, evt: "onBegin", delay: 0 }
				],
				children: [b.set(2, "style.visibility", "visible", { fill: "hold" })]
			})
		}
		const c: TimeNode = {
			kind: "par",
			ctn: b.ctn({
				id: 101,
				dur: 1000,
				restart: "always",
				stCondLst: [{ tn: 100, evt: "onBegin", delay: 0 }],
				children: [b.set(3, "style.visibility", "visible", { fill: "hold" })]
			})
		}
		let shown: number[] = []

		expect(
			play([a, c], b, t => {
				t.fire({ kind: "next" }, 10)
				shown = visible(t, 20)
			})
		).toBe("ok")
		expect(shown.sort()).toEqual([0, 1])
	})

	it("ends a zero-length begin-on-end loop at once", { timeout: budget(20_000) }, () => {
		const b = new TimingBuilder()
		const a: TimeNode = {
			kind: "par",
			ctn: b.ctn({
				id: 100,
				dur: 0,
				stCondLst: [
					{ evt: "onNext", delay: 0 },
					{ tn: 101, evt: "onEnd", delay: 0 }
				]
			})
		}
		const c: TimeNode = { kind: "par", ctn: b.ctn({ id: 101, dur: 0, stCondLst: [{ tn: 100, evt: "onEnd", delay: 0 }] }) }
		const start = cpuMs()

		expect(play([a, c], b, t => t.fire({ kind: "next" }, 10))).toBe("ok")
		expect(cpuMs() - start).toBeLessThan(budget(200))
	})

	it("plays a one-second ping-pong pair as one pass: the first, then the second after it", () => {
		const b = new TimingBuilder()
		const a: TimeNode = {
			kind: "par",
			ctn: b.ctn({
				id: 100,
				dur: 1000,
				stCondLst: [
					{ evt: "onNext", delay: 0 },
					{ tn: 101, evt: "onEnd", delay: 0 }
				],
				children: [b.set(2, "style.visibility", "visible", { dur: 1000, fill: "remove" })]
			})
		}
		const c: TimeNode = {
			kind: "par",
			ctn: b.ctn({
				id: 101,
				dur: 1000,
				stCondLst: [{ tn: 100, evt: "onEnd", delay: 0 }],
				children: [b.set(3, "style.visibility", "visible", { dur: 1000, fill: "remove" })]
			})
		}
		const seen: number[][] = []

		expect(
			play([a, c], b, t => {
				t.fire({ kind: "next" }, 0)
				for (const at of [500, 1500, 2500]) seen.push(visible(t, at))
			})
		).toBe("ok")
		expect(seen).toEqual([[0], [1], []])
	})

	it("walks a 15,000-node chain of begin references without growing the stack", { timeout: budget(60_000) }, () => {
		const b = new TimingBuilder()
		const chain: TimeNode[] = []

		for (let k = 0; k < 15_000; k++) {
			const id = 1000 + k
			const stCondLst: TimeCondition[] = k === 0 ? [{ evt: "onNext", delay: 0 }] : [{ tn: id - 1, evt: "onBegin", delay: 1 }]

			chain.push({ kind: "par", ctn: b.ctn({ id, dur: 10, stCondLst }) })
		}

		expect(play(chain, b, t => t.fire({ kind: "next" }, 0))).toBe("ok")
	})

	it("plays or refuses random begin/end reference graphs, never overflowing or running on", { timeout: budget(120_000) }, () => {
		let seed = 0x5eed

		const random = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff

			return seed / 0x7fffffff
		}
		const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T
		let worst = 0
		const outcomes = new Map<string, number>()

		for (let graph = 0; graph < 400; graph++) {
			const b = new TimingBuilder()
			const count = 2 + Math.floor(random() * 30)
			const ids = Array.from({ length: count }, (_, k) => 100 + k)
			const nodes: TimeNode[] = ids.map(id => {
				const conditions = (): TimeCondition[] =>
					Array.from({ length: Math.floor(random() * 3) }, () =>
						random() < 0.2
							? {
									evt: pick(["onNext", "onClick"] as const),
									delay: 0,
									...(random() < 0.5 ? { tgtEl: { kind: "shape", shape: 2 } } : {})
								}
							: { tn: pick(ids), evt: pick(["onBegin", "onEnd", "begin", "end"] as const), delay: pick([0, 0, 1, 500]) }
					)

				return {
					kind: pick(["par", "seq", "excl"] as const),
					ctn: b.ctn({
						id,
						...(random() < 0.7 ? { dur: pick([0, 1, 1000]) } : {}),
						restart: pick(["always", "whenNotActive", "never"] as const),
						stCondLst: conditions(),
						endCondLst: random() < 0.4 ? conditions() : [],
						children: random() < 0.5 ? [b.set(pick([2, 3]), "style.visibility", "visible")] : []
					})
				}
			})
			const start = cpuMs()
			const outcome = play(nodes, b, t => {
				for (let k = 0; k < 6; k++) {
					t.fire(random() < 0.7 ? { kind: "next" } : { kind: "click", shape: 2 }, k * 700)
					t.sample(k * 700 + 350)
				}

				t.fire({ kind: "prev" }, 5000)
				t.nextActivation()
			})

			worst = Math.max(worst, cpuMs() - start)
			outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1)
		}

		expect([...outcomes.keys()].every(outcome => outcome === "ok" || outcome.startsWith("refused"))).toBe(true)
		expect(worst).toBeLessThan(budget(250))
	})
})
