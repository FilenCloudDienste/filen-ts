import { describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { FillProps, LineProps, ShapeNode } from "../core/presentation/model"
import { editHarness, shapeById, type EditHarness } from "./presentationEditFixtures"
import { buildPptx, sp, xfrm } from "./pptxFixtures"

// shape.patchLine (the Shape Format tab's outline weight and colour picks): one field of the line replaced, the rest
// kept as the shape draws it, whether its line is an edit or still its source a:ln; undone back to the line it had.

const EDIT = { emit: emitPptx } as never
const RECT = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
const RED: FillProps = { kind: "solid", color: { kind: "srgb", rgb: "FF0000" } }
const BLUE: FillProps = { kind: "solid", color: { kind: "srgb", rgb: "0000FF" } }

function deck(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes:
					sp(
						2,
						"Dashed",
						undefined,
						`${xfrm(100, 100, 1000, 500)}${RECT}<a:ln w="38100"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>` +
							'<a:prstDash val="dash"/><a:headEnd type="triangle" w="med" len="med"/></a:ln>'
					) +
					sp(3, "Bare", undefined, `${xfrm(2000, 100, 1000, 500)}${RECT}`) +
					sp(4, "NoOutline", undefined, `${xfrm(4000, 100, 1000, 500)}${RECT}<a:ln><a:noFill/></a:ln>`)
			}
		]
	})
}

async function shape(h: EditHarness, id: number): Promise<ShapeNode> {
	const found = shapeById((await h.slide(0)).shapes, id)

	if (found === undefined) throw new Error(`no shape ${String(id)}`)

	return found
}

async function patch(h: EditHarness, id: number, line: LineProps): Promise<void> {
	const slide = (await h.slide(0)).ref
	const op: DeckOp = { family: "shape", kind: "patchLine", target: { slide, id }, line }

	expect(await h.command(op)).toMatchObject({ ok: true })
}

describe("shape line patch", () => {
	it("a weight pick keeps the colour, dash and arrowhead; a colour pick keeps the weight; undo restores the source line", async () => {
		const h = await editHarness(deck(), EDIT)

		expect((await shape(h, 2)).props?.ln).toBeUndefined()

		await patch(h, 2, { w: 57_150 })

		expect((await shape(h, 2)).props?.ln).toEqual({
			w: 57_150,
			fill: RED,
			dash: "dash",
			head: { type: "triangle", w: "med", len: "med" }
		})

		await patch(h, 2, { fill: BLUE })

		expect((await shape(h, 2)).props?.ln).toEqual({
			w: 57_150,
			fill: BLUE,
			dash: "dash",
			head: { type: "triangle", w: "med", len: "med" }
		})

		expect(await h.undo()).toMatchObject({ ok: true })
		expect((await shape(h, 2)).props?.ln).toMatchObject({ w: 57_150, fill: RED })
		expect(await h.undo()).toMatchObject({ ok: true })
		expect((await shape(h, 2)).props?.ln).toBeUndefined()
		expect(await h.redo()).toMatchObject({ ok: true })
		expect((await shape(h, 2)).props?.ln).toMatchObject({ w: 57_150, fill: RED, dash: "dash" })

		h.close()
	})

	it("a weight pick on a shape with no line and no style draws it solid black", async () => {
		const h = await editHarness(deck(), EDIT)

		await patch(h, 3, { w: 12_700 })

		expect((await shape(h, 3)).props?.ln).toEqual({ w: 12_700, fill: { kind: "solid", color: { kind: "srgb", rgb: "000000" } } })

		h.close()
	})

	it("a weight pick on a shape whose source line has no fill draws it solid black; undo restores the source line", async () => {
		const h = await editHarness(deck(), EDIT)

		expect((await shape(h, 4)).props?.ln).toBeUndefined()

		await patch(h, 4, { w: 57_150 })

		expect((await shape(h, 4)).props?.ln).toEqual({ w: 57_150, fill: { kind: "solid", color: { kind: "srgb", rgb: "000000" } } })

		expect(await h.undo()).toMatchObject({ ok: true })
		expect((await shape(h, 4)).props?.ln).toBeUndefined()

		h.close()
	})
})
