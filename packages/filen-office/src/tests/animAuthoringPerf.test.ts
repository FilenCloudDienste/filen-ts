import { describe, expect, it } from "vitest"
import { compile, instantiate } from "../core/anim/timegraph"
import { EFFECT_PRESETS } from "../core/anim/presets/effects/index"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { addEffectsOp, effectTimingOp, moveEffectOp, slideEffects } from "../core/presentation/edit/commands/timing"
import type { DeckOp } from "../core/presentation/edit/ops"
import { EMIT, layersOf } from "./animAuthoringFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { editHarness, type EditHarness } from "./presentationEditFixtures"
import { budget, cpuMs } from "./timing"

// animAuthoringPerf: on a slide with 200 authored effects over 40 shapes, one effect op (add, move, retime) applies in
// at most 15 ms of worker CPU, the pane's list of the effects is read from the tree in at most 5 ms (main thread),
// and the authored slide compiles in at most 10 ms and samples a frame in at most 1 ms.

const SHAPES = 40
const EFFECTS = 200
const RUNS = 5

function deck(): Uint8Array {
	let shapes = ""

	for (let k = 0; k < SHAPES; k++)
		shapes += sp(
			10 + k,
			`Shape ${String(k)}`,
			undefined,
			xfrm((k % 8) * 1100000, Math.floor(k / 8) * 1200000, 1000000, 1000000),
			body(para(`Text ${String(k)}`))
		)

	return buildPptx({ slides: [{ shapes }] })
}

async function authored(): Promise<EditHarness> {
	const h = await editHarness(deck(), EMIT)
	const slide = await h.slide(0)
	const ops: DeckOp[] = []

	for (let k = 0; k < EFFECTS; k++) {
		const preset = EFFECT_PRESETS[k % EFFECT_PRESETS.length]

		if (preset === undefined) continue

		const op = addEffectsOp(
			slide.ref,
			[],
			[{ id: 10 + (k % SHAPES) }],
			{ preset, aspect: 16 / 9 },
			k % 3 === 0 ? "click" : k % 3 === 1 ? "with" : "after"
		)

		if (op !== undefined) ops.push(op)
	}

	const result = await h.command({ family: "batch", kind: "batch", ops })

	if (!result.ok) throw new Error(JSON.stringify(result))

	return h
}

describe("animAuthoringPerf", () => {
	it("applies an effect op on a 200-effect slide in at most 15 ms of CPU", { timeout: budget(120_000) }, async ({ task }) => {
		const h = await authored()
		const slide = await h.slide(0)
		const effects = slideEffects(slide.timing)

		if (effects.kind !== "effects") throw new Error(effects.detail)

		expect(effects.rows).toHaveLength(EFFECTS)

		const first = effects.rows[0]

		if (first === undefined) throw new Error("no effect")

		let add = Number.POSITIVE_INFINITY
		let move = Number.POSITIVE_INFINITY
		let retime = Number.POSITIVE_INFINITY
		const preset = EFFECT_PRESETS[0]

		if (preset === undefined) throw new Error("no preset")

		for (let run = 0; run < RUNS; run++) {
			const op = addEffectsOp(slide.ref, effects.rows, [{ id: 10 }], { preset, aspect: 16 / 9 })

			if (op === undefined) throw new Error("no op")

			let start = cpuMs()

			expect((await h.command(op)).ok).toBe(true)
			add = Math.min(add, cpuMs() - start)
			await h.undo()

			start = cpuMs()
			expect((await h.command(moveEffectOp(slide.ref, first.id, EFFECTS - 1))).ok).toBe(true)
			move = Math.min(move, cpuMs() - start)
			await h.undo()

			const timing = effectTimingOp(slide.ref, [first.id], { durationMs: 1234 + run, delayMs: 100 })

			if (timing === undefined) throw new Error("no op")

			start = cpuMs()
			expect((await h.command(timing)).ok).toBe(true)
			retime = Math.min(retime, cpuMs() - start)
			await h.undo()
		}

		Object.assign(task.meta, {
			perf: {
				addCpuMs: { value: add, budget: 15 },
				moveCpuMs: { value: move, budget: 15 },
				retimeCpuMs: { value: retime, budget: 15 }
			}
		})
		expect(add).toBeLessThanOrEqual(budget(15))
		expect(move).toBeLessThanOrEqual(budget(15))
		expect(retime).toBeLessThanOrEqual(budget(15))
		h.close()
	})

	it("lists, compiles and samples the 200-effect slide within its budgets", { timeout: budget(120_000) }, async ({ task }) => {
		const h = await authored()
		const slide = await h.slide(0)
		const layers = layersOf(slide)
		let list = Number.POSITIVE_INFINITY
		let compiled = Number.POSITIVE_INFINITY
		let sampled = Number.POSITIVE_INFINITY

		for (let run = 0; run < RUNS; run++) {
			let start = cpuMs()
			const effects = slideEffects(slide.timing)

			list = Math.min(list, cpuMs() - start)
			expect(effects.kind).toBe("effects")

			start = cpuMs()

			const graph = compile(slide, layers, DEFAULT_PRESENTATION_BUDGETS.timing)

			compiled = Math.min(compiled, cpuMs() - start)

			const instance = instantiate(graph)

			instance.fire({ kind: "slideBegin" }, 0)

			for (let step = 1; step <= graph.mainSteps; step++) instance.fire({ kind: "next" }, step * 6000)

			const frames = 60

			start = cpuMs()

			for (let frame = 0; frame < frames; frame++) instance.sample(graph.mainSteps * 6000 + frame * 16)

			sampled = Math.min(sampled, (cpuMs() - start) / frames)
		}

		Object.assign(task.meta, {
			perf: {
				listCpuMs: { value: list, budget: 5 },
				compileCpuMs: { value: compiled, budget: 10 },
				sampleCpuMs: { value: sampled, budget: 1 }
			}
		})
		expect(list).toBeLessThanOrEqual(budget(5))
		expect(compiled).toBeLessThanOrEqual(budget(10))
		expect(sampled).toBeLessThanOrEqual(budget(1))
		h.close()
	})
})
