import { describe, expect, it } from "vitest"
import { EditorState } from "prosemirror-state"
import { emitPptx } from "../core/pptx/write/emit"
import type { ShapeNode, TextBody } from "../core/presentation/model"
import { bodyToDoc, docToBody, presentationTextSchema } from "../core/presentation/text/schema"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { editHarness, shapeById } from "./presentationEditFixtures"
import { partsOf, rebaseSession, saveEdits, text } from "./pptxWriteFixtures"

const EDIT = { emit: emitPptx } as never
const MATH =
	'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main">' +
	'<mc:Choice Requires="a14"><a14:m><m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:oMath><m:r><m:t>x²</m:t></m:r></m:oMath></m:oMathPara></a14:m></mc:Choice>' +
	'<mc:Fallback><a:r><a:rPr lang="en-GB"/><a:t>x2</a:t></a:r></mc:Fallback></mc:AlternateContent>'

function deck(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes: sp(
					3,
					"Box",
					undefined,
					`${xfrm(100, 200, 3000, 1000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
					body(`<a:p><a:r><a:rPr lang="en-GB"/><a:t>Area </a:t></a:r>${MATH}</a:p>` + para("Second"))
				)
			}
		]
	})
}

function texts(shape: ShapeNode | undefined): string[] {
	return (shape?.text?.paragraphs ?? []).map(p => p.runs.map(r => (r.kind === "br" ? "\n" : r.text)).join(""))
}

describe("text undo across a save", () => {
	it("typing in a paragraph that holds kept content, saving, then undoing restores the content and saves it", async () => {
		const bytes = deck()
		const h = await editHarness(bytes, EDIT)
		const slide = await h.slide(0)
		const box = shapeById(slide.shapes, 3) as ShapeNode
		const { doc, origins } = bodyToDoc(box.text as TextBody)
		const state = EditorState.create({ doc, schema: presentationTextSchema })
		const typed = state.apply(state.tr.insertText("Big ", 1))
		const result = await h.command({
			family: "text",
			kind: "setText",
			target: { slide: slide.ref, id: 3 },
			body: docToBody(typed.doc, box.text as TextBody, origins)
		})

		expect(result.ok).toBe(true)

		const saved = await saveEdits(h, (result as { revision: number }).revision)

		expect(text((await partsOf(saved)).get("ppt/slides/slide1.xml"))).toContain("a14:m")
		await rebaseSession(h, bytes, saved)

		const undone = await h.undo()

		expect(undone).toMatchObject({ ok: true })

		const now = await h.slide(0)

		expect(texts(shapeById(now.shapes, 3))).toEqual(["Area x2", "Second"])

		const again = await saveEdits(h, (undone as { revision: number }).revision)
		const xml = text((await partsOf(again)).get("ppt/slides/slide1.xml"))

		expect(xml).toContain("a14:m")
		expect(xml).not.toContain("Big ")

		const redone = await h.redo()

		expect(redone).toMatchObject({ ok: true })
		expect(texts(shapeById((await h.slide(0)).shapes, 3))).toEqual(["Big Area x2", "Second"])
		h.close()
	})
})
