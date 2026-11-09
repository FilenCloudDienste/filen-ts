import { describe, expect, it } from "vitest"
import { rgba } from "../core/drawingml/index"
import { emitPptx } from "../core/pptx/write/emit"
import type { Paragraph, ShapeNode, TextBody, Xfrm } from "../core/presentation/model"
import { refitNormAutofit, spAutoFitXfrm } from "../core/presentation/text/autofit"
import { layoutBody, type TextEnvironment } from "../core/presentation/text/body"
import { resolveBody, type BodyContext } from "../core/presentation/text/resolve"
import { MeasureCache } from "../core/text/index"
import { findShape } from "../core/presentation/edit/changes"
import type { ShapeTextContext, TextServices } from "../dom/presentation/engine/text"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { editHarness, shapeById } from "./presentationEditFixtures"
import { FakeMeasurer, testFont } from "./textFixtures"

// Autofit refitted as a body is edited, as PowerPoint does: a normAutofit body's fontScale and lnSpcReduction found
// anew from fontScale 1 (so deleted text grows it back), a spAutoFit shape's box sized to its text with its top edge
// kept, both in the step of the text, undone with it.

const CONTEXT: BodyContext = { listStyles: [], bodyPr: [], fonts: { color: () => rgba("000000"), typeface: typeface => typeface } }

function environment(): TextEnvironment {
	return { fonts: { resolve: () => testFont() }, cache: new MeasureCache(new FakeMeasurer()) }
}

function lines(count: number): Paragraph[] {
	return Array.from({ length: count }, (_, k) => ({
		pPr: {},
		runs: [{ kind: "r" as const, text: `line ${String(k)}`, rPr: { sz: 1200 } }]
	}))
}

function normal(count: number, fontScale = 1, lineSpacingReduction = 0): TextBody {
	return { bodyPr: { autofit: "normal", fontScale, lineSpacingReduction }, paragraphs: lines(count) }
}

// 12 pt lines with the fake font: 16 px, 19.2 px apart.
const BOX = { width: 400, height: 100 }

describe("normAutofit refit", () => {
	it("keeps a body that fits at full size", () => {
		const fit = refitNormAutofit(resolveBody(normal(3), CONTEXT), BOX, environment())

		expect([fit.fontScale, fit.lineSpacingReduction]).toEqual([1, 0])
		expect(fit.layout.overflow).toBe(false)
	})

	it("shrinks an overflowing body to the largest step it fits at", () => {
		const env = environment()
		const fit = refitNormAutofit(resolveBody(normal(8), CONTEXT), BOX, env)

		expect(fit.fontScale).toBeLessThan(1)
		expect(fit.layout.overflow).toBe(false)
		expect(fit.lineSpacingReduction).toBe(Math.min(0.2, Math.round(((1 - fit.fontScale) / 0.075) * 10) / 100))

		// One step larger overflows.
		const step = Math.round((1 - fit.fontScale) / 0.075) - 1
		const larger = layoutBody(resolveBody(normal(8, (1000 - 75 * step) / 1000, Math.min(2, step) / 10), CONTEXT), BOX, env)

		expect(larger.overflow).toBe(true)
	})

	it("grows a shrunk body back once its text fits again", () => {
		const fit = refitNormAutofit(resolveBody(normal(2, 0.25, 0.2), CONTEXT), BOX, environment())

		expect([fit.fontScale, fit.lineSpacingReduction]).toEqual([1, 0])
	})

	it("stops at the last step when nothing fits", () => {
		const fit = refitNormAutofit(resolveBody(normal(80), CONTEXT), BOX, environment())

		expect([fit.fontScale, fit.lineSpacingReduction]).toEqual([0.25, 0.2])
	})
})

describe("spAutoFit box", () => {
	const box = { width: 300, height: 100 }
	const base: Xfrm = { x: 10_000, y: 20_000, cx: 3_000_000, cy: 952_500, rot: 0, flipH: false, flipV: false }

	it("grows down from a fixed top edge, and shrinks back", () => {
		expect(spAutoFitXfrm(base, "horz", box, 150)).toEqual({ ...base, cy: 952_500 + 50 * 9525 })
		expect(spAutoFitXfrm(base, "horz", box, 60)).toEqual({ ...base, cy: 952_500 - 40 * 9525 })
		expect(spAutoFitXfrm(base, "horz", box, 100.2)).toBeUndefined()
	})

	it("keeps the rotated top edge where it is", () => {
		const rotated = { ...base, rot: 90 * 60_000 }
		const next = spAutoFitXfrm(rotated, "horz", box, 200) as Xfrm
		const grow = 100 * 9525

		// Turned 90° clockwise the shape's top edge is on the right: it grows left, its centre moving half the growth.
		expect(next.cy).toBe(base.cy + grow)
		expect(next.x + next.cx / 2 - (base.x + base.cx / 2)).toBeCloseTo(-grow / 2, 0)
		expect(next.y + next.cy / 2 - (base.y + base.cy / 2)).toBeCloseTo(0, 0)
	})

	it("grows a vertical body's width away from its right edge, and leaves stacked WordArt", () => {
		const next = spAutoFitXfrm(base, "vert", box, 150) as Xfrm

		expect(next.cx).toBe(base.cx + 50 * 9525)
		expect(next.x + next.cx).toBe(base.x + base.cx)
		expect(next.cy).toBe(base.cy)
		expect(spAutoFitXfrm(base, "wordArtVert", box, 150)).toBeUndefined()
	})
})

describe("autofit in the edit step", () => {
	const SHRINK = '<a:bodyPr><a:normAutofit fontScale="25000" lnSpcReduction="20000"/></a:bodyPr>'
	const GROW = "<a:bodyPr><a:spAutoFit/></a:bodyPr>"

	function deck(bodyPr: string, cy = 952_500): Uint8Array {
		return buildPptx({
			slides: [
				{
					shapes: sp(
						3,
						"Box",
						undefined,
						`${xfrm(0, 0, 3_810_000, cy)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
						body(para("x"), bodyPr)
					)
				}
			]
		})
	}

	// The shape's text box as the render reads it: its height less the default 0.05 in insets, or a fixed box.
	function services(fixed?: { width: number; height: number }): Partial<{ text: TextServices }> {
		const env = environment()
		const shapeText: TextServices["shapeText"] = (session, shape) => {
			const node = findShape(session.deck.nodes.get(shape.slide)?.shapes ?? [], shape.id)?.shape
			const context: ShapeTextContext = {
				kind: "shapeText",
				context: CONTEXT,
				box: fixed ?? { width: 400, height: (node?.xfrm?.cy ?? 0) / 9525 - 9.6 },
				environment: env,
				prepare: () => Promise.resolve(),
				options: {},
				refit: true,
				revision: 1
			}

			return Promise.resolve(context)
		}

		return { text: { shapeText } }
	}

	// The editor's body: new paragraphs under the body properties the shape holds.
	function typed(count: number, shape: ShapeNode): TextBody {
		return { bodyPr: shape.text?.bodyPr ?? {}, paragraphs: lines(count) }
	}

	it("refits a normAutofit body as its text changes, and undo puts the stored fit back", async () => {
		const h = await editHarness(deck(SHRINK), { emit: emitPptx } as never, services(BOX))
		const slide = await h.slide(0)
		const target = { slide: slide.ref, id: 3 }
		const shape = (): ShapeNode => shapeById(slide.shapes, 3) as ShapeNode

		expect(shape().text?.bodyPr).toMatchObject({ autofit: "normal", fontScale: 0.25 })
		expect(await h.command({ family: "text", kind: "setText", target, body: typed(2, shape()) })).toMatchObject({
			ok: true
		})
		expect(shape().text?.bodyPr).toMatchObject({ autofit: "normal", fontScale: 1, lineSpacingReduction: 0 })

		expect((await h.command({ family: "text", kind: "setText", target, body: typed(8, shape()) })).ok).toBe(true)
		expect(shape().text?.bodyPr.fontScale).toBeLessThan(1)

		await h.undo()
		expect(shape().text?.bodyPr).toMatchObject({ fontScale: 1, lineSpacingReduction: 0 })
		await h.undo()
		expect(shape().text?.bodyPr).toMatchObject({ fontScale: 0.25, lineSpacingReduction: 0.2 })
	})

	it("sizes a spAutoFit shape to its text in a typing burst, and one undo restores text and box", async () => {
		// A 100 px box: one 19.2 px line needs less, six need more.
		const h = await editHarness(deck(GROW), { emit: emitPptx } as never, services())
		const slide = await h.slide(0)
		const target = { slide: slide.ref, id: 3 }
		const shape = (): ShapeNode => shapeById(slide.shapes, 3) as ShapeNode
		const before = { ...(shape().xfrm as Xfrm) }

		expect((await h.command({ family: "text", kind: "setText", target, body: typed(1, shape()), burst: 7 })).ok).toBe(true)

		const shrunk = shape().xfrm as Xfrm

		expect(shrunk.cy).toBeLessThan(before.cy)
		expect(shrunk.y).toBe(before.y)
		expect((await h.command({ family: "text", kind: "setText", target, body: typed(6, shape()), burst: 7 })).ok).toBe(true)
		expect((shape().xfrm as Xfrm).cy).toBeGreaterThan(before.cy)

		await h.undo()
		expect(shape().xfrm).toEqual(before)
		expect(shape().text?.paragraphs.length).toBe(1)
	})

	it("starts a step of its own when a burst first resizes the box", async () => {
		// One 19.2 px line and the insets.
		const h = await editHarness(deck(GROW, (19.2 + 9.6) * 9525), { emit: emitPptx } as never, services())
		const slide = await h.slide(0)
		const target = { slide: slide.ref, id: 3 }
		const shape = (): ShapeNode => shapeById(slide.shapes, 3) as ShapeNode
		const before = { ...(shape().xfrm as Xfrm) }

		// One line fills the box exactly: the text alone, then the box grows with the second line.
		expect((await h.command({ family: "text", kind: "setText", target, body: typed(1, shape()), burst: 9 })).ok).toBe(true)
		expect(shape().xfrm).toEqual(before)
		expect((await h.command({ family: "text", kind: "setText", target, body: typed(2, shape()), burst: 9 })).ok).toBe(true)
		expect((shape().xfrm as Xfrm).cy).toBeGreaterThan(before.cy)

		await h.undo()
		expect(shape().xfrm).toEqual(before)
		expect(shape().text?.paragraphs.length).toBe(1)
	})
})
