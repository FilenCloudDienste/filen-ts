import type { LayerIndex, LayerState, TimingTree } from "../core/anim/model"
import { compile, instantiate } from "../core/anim/timegraph"
import { emitPptx } from "../core/pptx/write/emit"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { effectNodes } from "../core/presentation/edit/commands/timing"
import type { SlideNode } from "../core/presentation/model"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { editHarness, type EditHarness } from "./presentationEditFixtures"

// Decks and timegraph probes for the animation authoring tests: a slide with a title, a two-paragraph body and a
// box; the timegraph of a slide sampled at the end of every main-sequence step (after the slide begins, then after
// each click), so two slides play alike exactly when their samples are equal.

export const EMIT = { emit: emitPptx } as never

export function authoringDeck(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Title 1", 'type="title"', xfrm(457200, 274638, 8229600, 1143000), body(para("Animated"))) +
					sp(3, "Body 2", 'idx="1"', xfrm(457200, 1600200, 8229600, 4525963), body(para("One") + para("Two"))) +
					sp(
						4,
						"Box 3",
						undefined,
						`${xfrm(6000000, 1000000, 1000000, 1000000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>`
					)
			},
			{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Second"))) }
		]
	})
}

export async function authoringHarness(bytes: Uint8Array = authoringDeck()): Promise<EditHarness> {
	return editHarness(bytes, EMIT)
}

// The slide's layers as the show would address them: every top-level shape in order, then one layer per paragraph a
// by-paragraph effect animates.
export function layersOf(slide: SlideNode): LayerIndex {
	const shapes = slide.shapes.map(shape => shape.id)
	const ranges: ({ readonly unit: "para"; readonly start: number; readonly end: number } | undefined)[] = shapes.map(() => undefined)
	const seen = new Set<string>()

	for (const effect of effectNodes(slide.timing)) {
		const stack = [effect]

		for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
			if (node.kind === "behavior" && "common" in node.behavior) {
				const target = node.behavior.common.target

				if (target.kind === "text" && target.unit === "para" && !seen.has(`${String(target.shape)}:${String(target.start)}`)) {
					seen.add(`${String(target.shape)}:${String(target.start)}`)
					shapes.push(target.shape)
					ranges.push({ unit: "para", start: target.start, end: target.end })
				}
			}

			stack.push(...node.ctn.children)
		}
	}

	return { shapes: Int32Array.from(shapes), ranges }
}

const STEP_MS = 20_000

function rounded(states: readonly LayerState[]): unknown {
	return JSON.parse(
		JSON.stringify(states, (_key, value: unknown) => (typeof value === "number" ? Math.round(value * 1000) / 1000 : value))
	)
}

// The samples at every step end: after the slide begins, then after each click (the main sequence's steps), plus the
// steps' count.
export function stepEnds(slide: SlideNode, timing: TimingTree | undefined = slide.timing): { steps: number; samples: unknown[] } {
	const node: SlideNode = { ...slide, ...(timing === undefined ? {} : { timing }) }
	const layers = layersOf(node)
	const graph = compile(node, layers, DEFAULT_PRESENTATION_BUDGETS.timing)
	const instance = instantiate(graph)
	const samples: unknown[] = []

	instance.fire({ kind: "slideBegin" }, 0)
	samples.push(rounded(instance.sample(STEP_MS - 1)))

	for (let step = 1; step <= graph.mainSteps; step++) {
		instance.fire({ kind: "next" }, step * STEP_MS)
		samples.push(rounded(instance.sample((step + 1) * STEP_MS - 1)))
	}

	return { steps: graph.mainSteps, samples }
}

// The tree with its ctn ids renumbered in document order (and node conditions with them): two trees that differ only
// in the ids their containers were given compare equal.
export function canonicalIds(tree: TimingTree | undefined): string {
	const ids = new Map<number, number>()
	const visit = (value: unknown): void => {
		if (value === null || typeof value !== "object") return
		if (Array.isArray(value)) {
			for (const item of value) visit(item)

			return
		}

		const record = value as Record<string, unknown>
		const ctn = record["ctn"] as { id?: number } | undefined

		if (ctn !== undefined && typeof ctn.id === "number" && !ids.has(ctn.id)) ids.set(ctn.id, ids.size + 1)

		for (const item of Object.values(record)) visit(item)
	}

	visit(tree)

	return JSON.stringify(tree, (key, value: unknown) =>
		(key === "id" || key === "tn") && typeof value === "number" ? (ids.get(value) ?? value) : value
	)
}

// The state of `layer` in one step-end sample.
export function stateOf(sample: unknown, layer: number): LayerState | undefined {
	return (sample as LayerState[]).find(state => state.layer === layer)
}
