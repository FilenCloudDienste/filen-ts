import { describe, expect, it } from "vitest"
import { emitOdp } from "../core/odp/write/emit"
import { emitPptx } from "../core/pptx/write/emit"
import type { PartsApi } from "../core/pptx/write/types"
import { applyOp } from "../core/presentation/edit/apply"
import type { InkOp } from "../core/presentation/edit/ops"
import { nextShapeId } from "../core/presentation/ids"
import { slideRef, type ShapeNode } from "../core/presentation/model"
import { fixtureDeck, FIXTURE_FIRST_SLIDE } from "./fixtures/presentation/deck"
import { budget, cpuMs } from "./timing"

// Keeping a long stroke: a 100,000-point stroke is applied and written as PresentationML and as ODF within 50 ms CPU
// together (the least of 5 runs), its points kept in typed arrays.

const POINTS = 100_000
const RUNS = 5
const BUDGET_MS = 50
const SLIDE = slideRef(FIXTURE_FIRST_SLIDE)

const PARTS: PartsApi = {
	owner: "/ppt/slides/slide1.xml",
	addPart: () => ({ part: "", rId: "" }),
	relate: () => "rId1",
	target: () => undefined,
	removePart: () => undefined,
	editor: () => {
		throw new Error("no editor here")
	}
}

function longStroke(): InkOp {
	const points = new Float64Array(POINTS * 2)

	for (let k = 0; k < POINTS; k++) {
		points[2 * k] = 1_000_000 + 30 * k + Math.sin(k / 50) * 40_000
		points[2 * k + 1] = 2_000_000 + Math.cos(k / 70) * 900_000
	}

	return {
		family: "ink",
		kind: "add",
		slide: SLIDE,
		name: "Ink",
		strokes: [{ points, width: 28_575, color: { kind: "srgb", rgb: "C00000" }, highlighter: false }]
	}
}

describe("kept ink performance", () => {
	it(`applies and writes a ${String(POINTS)}-point stroke in at most ${String(BUDGET_MS)} ms CPU`, { timeout: 60_000 }, ({ task }) => {
		const op = longStroke()
		let least = Infinity
		let parts = { apply: 0, pptx: 0, odp: 0 }

		for (let run = 0; run < RUNS; run++) {
			const deck = fixtureDeck()
			const context = {
				sourceBytes: () => new Uint8Array(0),
				newShapeId: () => nextShapeId(deck.nodes.get(SLIDE)?.shapes ?? []),
				newSlideRef: () => slideRef(999)
			}
			const start = cpuMs()
			const result = applyOp(deck, op, context)
			const applied = cpuMs()
			const node = deck.nodes.get(SLIDE)!
			const group = node.shapes[node.shapes.length - 1] as ShapeNode
			const touch = { kind: "shape", slide: SLIDE, shape: group.id, dirt: { kind: "node" } } as const
			const pptx = emitPptx("shape", { slide: node, shape: group, touch }, { deck, document: undefined, parts: PARTS })
			const written = cpuMs()
			const stroke = group.children?.[0] as ShapeNode
			const odp = emitOdp(
				"ink",
				{ slide: node, shape: stroke, touch: { ...touch, shape: stroke.id } },
				{ deck, document: undefined, editor: undefined, styles: { automatic: () => "gr1", addEntry: path => path } }
			)
			const end = cpuMs()

			expect(result.kind).toBe("applied")
			expect(pptx.kind).toBe("markup")
			expect(odp.kind).toBe("markup")

			const geometry = stroke.props?.geometry

			expect(geometry?.kind === "custom" ? geometry.paths[0]?.coords : undefined).toBeInstanceOf(Float64Array)

			if (end - start < least) {
				least = end - start
				parts = { apply: applied - start, pptx: written - applied, odp: end - written }
			}
		}

		Object.assign(task.meta, {
			perf: {
				inkKeepCpuMs: { value: least, budget: BUDGET_MS },
				inkApplyCpuMs: { value: parts.apply },
				inkPptxCpuMs: { value: parts.pptx },
				inkOdpCpuMs: { value: parts.odp }
			}
		})
		expect(least).toBeLessThanOrEqual(budget(BUDGET_MS))
	})
})
