import { describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import { ungroupOps } from "../core/presentation/edit/commands/group"
import { resetSlideOps, setLayoutOps } from "../core/presentation/edit/commands/slide"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { Xfrm } from "../core/presentation/model"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { editDeck, editHarness, shapeById } from "./presentationEditFixtures"
import { buildPptx, sp, xfrm } from "./pptxFixtures"
import { saveEdits } from "./pptxWriteFixtures"

// A command of several ops (Ungroup of several groups, Layout or Reset of several slides) as one batch: all or
// nothing, one undo step, redone as one.

const EDIT = { emit: emitPptx } as never

function group(id: number, x: number, children: readonly number[]): string {
	return (
		`<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${String(id)}" name="Group ${String(id)}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
		`<p:grpSpPr><a:xfrm><a:off x="${String(x)}" y="0"/><a:ext cx="2000" cy="1000"/><a:chOff x="0" y="0"/><a:chExt cx="1000" cy="500"/></a:xfrm></p:grpSpPr>` +
		children
			.map((child, index) =>
				sp(
					child,
					`Leaf ${String(child)}`,
					undefined,
					`${xfrm(index * 500, 0, 500, 500)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
				)
			)
			.join("") +
		"</p:grpSp>"
	)
}

describe("several ops as one step", () => {
	it("ungrouping two groups is one undo step, redone as one, and saves", async () => {
		const h = await editHarness(buildPptx({ slides: [{ shapes: group(10, 0, [11, 12]) + group(20, 5000, [21, 22]) }] }), EDIT)
		const slide = await h.slide(0)
		const ops = ungroupOps(slide.ref, [
			{ id: 10, role: "group" },
			{ id: 20, role: "group" }
		])

		expect(ops).toHaveLength(1)
		expect(await h.command(ops[0] as DeckOp)).toMatchObject({ ok: true })
		expect(slide.shapes.map(shape => shape.id)).toEqual([11, 12, 21, 22])
		expect(await h.undo()).toMatchObject({ ok: true, dirty: false })
		expect(slide.shapes.map(shape => shape.id)).toEqual([10, 20])
		expect(sessionEdits(h.session).history.canUndo).toBe(false)
		expect(await h.redo()).toMatchObject({ ok: true })
		expect(slide.shapes.map(shape => shape.id)).toEqual([11, 12, 21, 22])
		await expect(saveEdits(h, sessionEdits(h.session).history.revision)).resolves.toBeInstanceOf(Uint8Array)
		h.close()
	})

	it("a batch refused half-way leaves the deck and the history as they were", async () => {
		const h = await editHarness(editDeck(), EDIT)
		const slide = await h.slide(0)
		const before = structuredClone(shapeById(slide.shapes, 3)?.xfrm) as Xfrm
		const revision = sessionEdits(h.session).history.revision

		expect(
			await h.command({
				family: "batch",
				kind: "batch",
				ops: [
					{ family: "shape", kind: "setXfrm", target: { slide: slide.ref, id: 3 }, xfrm: { ...before, x: before.x + 5000 } },
					{ family: "shape", kind: "setXfrm", target: { slide: slide.ref, id: 999 }, xfrm: before }
				]
			})
		).toEqual({ ok: false, refusal: "notFound" })
		expect(shapeById(slide.shapes, 3)?.xfrm).toEqual(before)
		expect(sessionEdits(h.session).history.revision).toBe(revision)
		expect(sessionEdits(h.session).history.canUndo).toBe(false)
		h.close()
	})

	it("a layout change and a reset of two slides are one undo step each", async () => {
		const h = await editHarness(editDeck(), EDIT)
		const deck = h.session.deck
		const first = await h.slide(0)
		const second = await h.slide(1)
		const parents = [first.parent, second.parent]
		const other = deck.layouts.find(ref => ref !== first.parent)

		if (other === undefined) throw new Error("two layouts")

		const [layout] = setLayoutOps(deck.slides, [first.ref, second.ref], other)
		const [reset] = resetSlideOps(deck.slides, [first.ref, second.ref])

		expect(layout).toMatchObject({ family: "batch" })
		expect(await h.command(layout as DeckOp)).toMatchObject({ ok: true })
		expect([deck.nodes.get(first.ref)?.parent, deck.nodes.get(second.ref)?.parent]).toEqual([other, other])
		expect(await h.command(reset as DeckOp)).toMatchObject({ ok: true })
		await h.undo()
		expect(await h.undo()).toMatchObject({ ok: true, dirty: false })
		expect([deck.nodes.get(first.ref)?.parent, deck.nodes.get(second.ref)?.parent]).toEqual(parents)
		h.close()
	})
})
