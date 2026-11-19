import { NodeSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { drawingAltText, vmlAltText } from "@filen/office/core/docx"
import { DocxEngine, type DocxEvent, type DocxPageData } from "@filen/office/dom/docx"
import { inThreadEditingHost } from "@filen/office/dom/docx/editing"
import { writerProof } from "@filen/office/core/docx/write"
import { parseDocxEditorCommand } from "@filen/office/core/docx/edit"
import { buildDocx, modelOf, p, type SyntheticDocx } from "./docxSynthetic"
import { settleAll } from "./pagedFixtures"
import { drawingName } from "../core/docx/objects/edit"
import { engineServices } from "./engineFixtures"

// A picture's accessible name: its alternative text (wp:docPr@descr), else its title (ECMA-376 Part 1
// §20.4.2.5); a VML shape's alt, else title. The engine serves it with the drawing to the viewer and the
// editor alike, and the page names the picture's box by it.

const PICTURE = "http://schemas.openxmlformats.org/drawingml/2006/picture"

function picture(docPr: string): string {
	return (
		`<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="d"${docPr}/><a:graphic><a:graphicData uri="${PICTURE}">` +
		'<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
		'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
	)
}

const VML =
	'<w:p><w:r><w:pict><v:shape id="s1" style="width:50pt;height:25pt" alt="A VML picture" title="VML title"><v:imagedata r:id="rIdImg" o:title=""/></v:shape></w:pict></w:r></w:p>'

function spec(body: string): SyntheticDocx {
	return {
		body,
		relationships: [{ id: "rIdImg", type: "image", target: "media/image1.png" }],
		parts: [{ name: "word/media/image1.png", data: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) }]
	}
}

// The alt text of every object the engine serves for the document, in page order.
async function served(bytes: Uint8Array): Promise<(string | undefined)[]> {
	const pages: DocxPageData[] = []
	const engine = new DocxEngine(bytesSource(bytes), engineServices(), event => {
		if (event.type === "pages") for (const page of event.pages) pages[page.index] = page
	})

	await engine.run()

	const ids = pages.flatMap(page => Array.from({ length: page.objectCount }, (_, k) => page.objectInts[k * 3] ?? -1))
	const objects = await engine.objects(ids)

	engine.close()

	return objects.map(object => (object.kind === "drawing" ? object.alt : `(${object.kind})`))
}

describe("picture alt text", () => {
	// XML holds no lone surrogate (nor U+FFFE/FFFF): the command refuses it rather than every later save.
	it("refuses alt text no XML can hold, a lone surrogate included", () => {
		for (const text of [`x${String.fromCharCode(0xd800)}`, `${String.fromCharCode(0xdc00)}x`, "x\uffff", "x\u0001"]) {
			expect(parseDocxEditorCommand({ type: "drawing.altText", text })).toBeUndefined()
			expect(parseDocxEditorCommand({ type: "image.insert", media: 1, altText: text })).toBeUndefined()
		}

		expect(parseDocxEditorCommand({ type: "drawing.altText", text: "A cat \u{1F408}\tand\na dog" })).toBeDefined()
	})

	it("reads wp:docPr@descr, then @title, and nothing when neither says anything", async () => {
		const model = await modelOf(
			spec(picture(' descr=" A cat on a mat " title="Cat"') + picture(' title="Only a title"') + picture(' descr="" title=" "') + VML)
		)
		const part = model.parts[model.drawings[0]?.part ?? -1]

		expect(part).toBeDefined()

		if (part === undefined) return

		expect(model.drawings.map(drawing => drawingAltText(part.reader, drawing.docPr))).toEqual(["A cat on a mat", "Only a title", ""])
		expect(drawingAltText(part.reader, -1)).toBe("")
		expect(model.vml.map(shape => vmlAltText(part.reader, shape.shape))).toEqual(["A VML picture"])
	})

	it("is served with each drawing, viewer and editor alike", async () => {
		expect(await served(buildDocx(spec(picture(' descr="A cat"') + picture(' title="A title"') + picture("") + VML)))).toEqual([
			"A cat",
			"A title",
			undefined,
			"A VML picture"
		])
	})

	it("names a drawing in the editor by its alt text as edited, else its title", async () => {
		const editing = inThreadEditingHost(() => engineServices(), { proof: writerProof })
		const session = editing.host(
			bytesSource(buildDocx(spec(picture(' descr="Old" title="A title"') + picture("") + VML))),
			() => undefined
		)
		const editor = await editing.editor
		const names = (): string[] => {
			const out: string[] = []

			editor.session.state.doc.descendants(node => {
				if (node.type.name === "drawing") out.push(drawingName(editor.session.context, node))
			})

			return out
		}

		expect(names()).toEqual(["Old", "", "A VML picture"])

		let at = -1

		editor.session.state.doc.descendants((node, pos) => {
			if (at < 0 && node.type.name === "drawing") at = pos
		})
		editor.dispatch(editor.session.state.tr.setSelection(NodeSelection.create(editor.session.state.doc, at)))
		expect(await editor.execute({ type: "drawing.altText", text: "" })).toBe(true)
		expect(names()).toEqual(["A title", "", "A VML picture"])
		session.close()
	})

	it("follows the editor's alt text edits", async () => {
		const pages: DocxPageData[] = []
		const editing = inThreadEditingHost(() => engineServices(), { proof: writerProof })
		const session = editing.host(bytesSource(buildDocx(spec(p("Before") + picture(' descr="Old"')))), (event: DocxEvent) => {
			if (event.type === "pages") for (const page of event.pages) pages[page.index] = page
		})
		const editor = await editing.editor
		const altOf = async (): Promise<(string | undefined)[]> => {
			const ids = pages.flatMap(page => Array.from({ length: page.objectCount }, (_, k) => page.objectInts[k * 3] ?? -1))

			return (await session.objects(ids)).map(object => (object.kind === "drawing" ? object.alt : `(${object.kind})`))
		}

		await settleAll(editor)
		expect(await altOf()).toEqual(["Old"])

		let at = -1

		editor.session.state.doc.descendants((node, pos) => {
			if (at < 0 && node.type.name === "drawing") at = pos
		})
		editor.dispatch(editor.session.state.tr.setSelection(NodeSelection.create(editor.session.state.doc, at)))
		expect(await editor.execute({ type: "drawing.altText", text: "New" })).toBe(true)
		await settleAll(editor)
		expect(await altOf()).toEqual(["New"])
		session.close()
	})
})
