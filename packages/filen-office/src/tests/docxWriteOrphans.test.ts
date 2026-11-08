import { TextSelection } from "prosemirror-state"
import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { DocxEditorCommand } from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { saveDocx } from "@filen/office/core/docx/write"
import { buildDocx, p, type ExtraPart } from "./docxSynthetic"
import { pagedEditor, settleAll } from "./pagedFixtures"

// What a save leaves out once nothing uses it: the parts of deleted pictures, charts and objects, and of a
// removed header, with their relationships and content-type overrides.

const T = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const RELATIONSHIPS = (entries: string): string =>
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
	`${entries}</Relationships>`
const RELATIONSHIP = (id: string, type: string, target: string): string =>
	`<Relationship Id="${id}" Type="${T}/${type}" Target="${target}"/>`
const CHART_TYPE = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
const MARGINS = '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
const SECTION = (references: string): string => `<w:sectPr>${references}<w:pgSz w:w="12240" w:h="15840"/>${MARGINS}</w:sectPr>`

// A PNG of a width x height picture (its header only).
function png(width: number, height: number): Uint8Array {
	const u32 = (value: number): number[] => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]

	return new Uint8Array([
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
		...u32(13),
		0x49,
		0x48,
		0x44,
		0x52,
		...u32(width),
		...u32(height),
		8,
		6,
		0,
		0,
		0,
		...u32(0)
	])
}

function picture(rel: string, id: number): string {
	return (
		'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="457200"/>' +
		`<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="Picture ${id}"/>` +
		'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr>' +
		`<pic:cNvPr id="0" name="a.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
		'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
		"</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
	)
}

const CHART =
	'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1828800" cy="914400"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
	'<wp:docPr id="6" name="Chart 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
	'<c:chart r:id="rIdChart"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
// An embedded object whose icon is a VML picture.
const OLE =
	'<w:r><w:object w:dxaOrig="1440" w:dyaOrig="720"><v:shape id="_x0000_i1025" type="#_x0000_t75" style="width:72pt;height:36pt" o:ole="">' +
	'<v:imagedata r:id="rIdIcon" o:title=""/></v:shape><o:OLEObject Type="Embed" ProgID="Package" ShapeID="_x0000_i1025" DrawAspect="Content" ObjectID="_1" r:id="rIdOle"/></w:object></w:r>'
// A legacy VML picture naming its image by o:relid only.
const LEGACY =
	'<w:r><w:pict><v:shape id="_x0000_i1030" type="#_x0000_t75" style="width:72pt;height:36pt"><v:imagedata o:relid="rIdImg" o:title=""/></v:shape></w:pict></w:r>'

const CHART_PARTS: readonly ExtraPart[] = [
	{
		name: "word/charts/chart1.xml",
		contentType: CHART_TYPE,
		data:
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
			'<c:chart><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/>' +
			'<c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>2</c:v></c:pt><c:pt idx="1"><c:v>3</c:v></c:pt></c:numCache></c:numRef></c:val>' +
			'</c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart></c:plotArea></c:chart><c:externalData r:id="rIdData"/></c:chartSpace>'
	},
	{
		name: "word/charts/_rels/chart1.xml.rels",
		data: RELATIONSHIPS(RELATIONSHIP("rIdData", "package", "../embeddings/Microsoft_Excel_Worksheet.xlsx"))
	},
	{
		name: "word/embeddings/Microsoft_Excel_Worksheet.xlsx",
		contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		data: new Uint8Array([0x50, 0x4b, 5, 6, 1, 2, 3])
	},
	{
		name: "word/embeddings/oleObject1.bin",
		contentType: "application/vnd.openxmlformats-officedocument.oleObject",
		data: new Uint8Array([7, 8, 9])
	},
	{ name: "word/media/icon.png", data: png(48, 24) }
]

function docx(body: string, parts: readonly ExtraPart[] = []): Uint8Array {
	return buildDocx({
		body: body + SECTION(""),
		relationships: [
			{ id: "rIdImg", type: "image", target: "media/a.png" },
			{ id: "rIdChart", type: "chart", target: "charts/chart1.xml" },
			{ id: "rIdOle", type: "oleObject", target: "embeddings/oleObject1.bin" },
			{ id: "rIdIcon", type: "image", target: "media/icon.png" }
		].filter(relationship => relationship.id === "rIdImg" || parts.length > 0),
		parts: [{ name: "word/media/a.png", data: png(96, 48) }, ...parts]
	})
}

async function run(editor: PagedEditor, command: DocxEditorCommand): Promise<boolean> {
	return await editor.execute(command)
}

// Deletes the body's top-level blocks [from, to) (by index).
function deleteBlocks(editor: PagedEditor, from: number, to: number): void {
	const session = editor.session
	const doc = session.state.doc
	let start = 0

	for (let index = 0; index < from; index++) start += doc.child(index).nodeSize

	let end = start

	for (let index = from; index < to; index++) end += doc.child(index).nodeSize

	session.dispatch(session.state.tr.delete(start, end))
}

// The saved archive's entries, by name.
async function save(opened: Awaited<ReturnType<typeof pagedEditor>>): Promise<Record<string, Uint8Array>> {
	await settleAll(opened.editor)

	const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })

	if (result.bytes === undefined) throw new Error("No bytes")

	return unzipSync(result.bytes)
}

const text = (entries: Record<string, Uint8Array>, name: string): string => {
	const entry = entries[name]

	return entry === undefined ? "" : strFromU8(entry)
}

describe("docx save drops what nothing uses any more", () => {
	it("drops a deleted picture's image part and relationship", async () => {
		const opened = await pagedEditor(docx(p("Before") + `<w:p>${picture("rIdImg", 1)}</w:p>` + p("After")))

		deleteBlocks(opened.editor, 1, 2)

		const entries = await save(opened)

		expect(Object.keys(entries)).not.toContain("word/media/a.png")
		expect(text(entries, "word/_rels/document.xml.rels")).not.toContain("rIdImg")
		expect(text(entries, "word/document.xml")).toContain("After")
		opened.editor.dispose()
	})

	it("keeps an image a second picture still uses", async () => {
		const opened = await pagedEditor(docx(`<w:p>${picture("rIdImg", 1)}</w:p>` + p("Middle") + `<w:p>${picture("rIdImg", 2)}</w:p>`))

		deleteBlocks(opened.editor, 0, 1)

		const entries = await save(opened)

		expect(Object.keys(entries)).toContain("word/media/a.png")
		expect(text(entries, "word/_rels/document.xml.rels")).toContain('Id="rIdImg"')
		opened.editor.dispose()
	})

	it("keeps an image a legacy VML picture names by o:relid, kept or rewritten", async () => {
		const body = `<w:p>${picture("rIdImg", 1)}</w:p>` + `<w:p><w:r><w:t>Legacy</w:t></w:r>${LEGACY}</w:p>`

		for (const edit of [false, true]) {
			const opened = await pagedEditor(docx(body))

			deleteBlocks(opened.editor, 0, 1)

			if (edit) {
				const session = opened.editor.session

				session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 2)))
				session.dispatch(session.state.tr.insertText("Old "))
			}

			const entries = await save(opened)

			expect(text(entries, "word/document.xml")).toContain('o:relid="rIdImg"')
			expect(Object.keys(entries)).toContain("word/media/a.png")
			expect(text(entries, "word/_rels/document.xml.rels")).toContain('Id="rIdImg"')
			opened.editor.dispose()
		}
	})

	it("drops a deleted chart and embedded object with what only they pointed at, overrides included", async () => {
		const opened = await pagedEditor(docx(p("Keep") + `<w:p>${CHART}</w:p>` + `<w:p>${OLE}</w:p>` + p("End"), CHART_PARTS))

		deleteBlocks(opened.editor, 1, 3)

		const entries = await save(opened)
		const names = Object.keys(entries)
		const rels = text(entries, "word/_rels/document.xml.rels")
		const types = text(entries, "[Content_Types].xml")

		for (const name of [
			"word/charts/chart1.xml",
			"word/charts/_rels/chart1.xml.rels",
			"word/embeddings/Microsoft_Excel_Worksheet.xlsx",
			"word/embeddings/oleObject1.bin",
			"word/media/icon.png"
		]) {
			expect(names).not.toContain(name)
			expect(types).not.toContain(`/${name}"`)
		}

		for (const id of ["rIdChart", "rIdOle", "rIdIcon"]) expect(rels).not.toContain(`Id="${id}"`)

		expect(names).toContain("word/media/a.png")
		opened.editor.dispose()
	})
})

describe("docx save drops a removed header", () => {
	const HEADER_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"
	const TWO_SECTIONS = (header: string, parts: readonly ExtraPart[] = []): Uint8Array =>
		buildDocx({
			body:
				p("First section") +
				`<w:p><w:pPr>${SECTION('<w:headerReference w:type="default" r:id="rIdH"/>')}</w:pPr></w:p>` +
				p("Second section") +
				SECTION(""),
			headers: { rIdH: header },
			parts
		})
	const caret = (editor: PagedEditor): void => {
		const session = editor.session

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 2)))
	}
	const gone = (entries: Record<string, Uint8Array>, secret: string): void => {
		expect(Object.keys(entries)).not.toContain("word/header1.xml")
		expect(text(entries, "word/_rels/document.xml.rels")).not.toContain('Id="rIdH"')
		expect(text(entries, "[Content_Types].xml")).not.toContain("/word/header1.xml")
		expect(text(entries, "[Content_Types].xml")).not.toContain(HEADER_TYPE)

		for (const [name, bytes] of Object.entries(entries)) expect(strFromU8(bytes), name).not.toContain(secret)
	}

	it("drops the header part, its relationship and override: its text is nowhere in the file", async () => {
		const opened = await pagedEditor(TWO_SECTIONS(p("Secret header text")))

		caret(opened.editor)
		expect(await run(opened.editor, { type: "header.remove" })).toBe(true)
		gone(await save(opened), "Secret header text")
		opened.editor.dispose()
	})

	it("drops a header edited and then removed", async () => {
		const opened = await pagedEditor(TWO_SECTIONS(p("Secret header text")))
		const { editor } = opened

		caret(editor)
		expect(await run(editor, { type: "header.edit" })).toBe(true)
		editor.session.dispatch(editor.session.state.tr.insertText("More secret "))
		await settleAll(editor)
		expect(await run(editor, { type: "header.remove" })).toBe(true)

		const entries = await save(opened)

		gone(entries, "Secret header text")
		gone(entries, "More secret")
		editor.dispose()
	})

	it("drops what only the removed header pointed at", async () => {
		const header = `<w:p>${CHART}${OLE}</w:p>`
		const parts: ExtraPart[] = [
			...CHART_PARTS,
			{
				name: "word/_rels/header1.xml.rels",
				data: RELATIONSHIPS(
					RELATIONSHIP("rIdChart", "chart", "charts/chart1.xml") +
						RELATIONSHIP("rIdOle", "oleObject", "embeddings/oleObject1.bin") +
						RELATIONSHIP("rIdIcon", "image", "media/icon.png")
				)
			}
		]
		const opened = await pagedEditor(TWO_SECTIONS(header, parts))

		caret(opened.editor)
		expect(await run(opened.editor, { type: "header.remove" })).toBe(true)

		const entries = await save(opened)
		const names = Object.keys(entries)

		for (const name of [
			"word/header1.xml",
			"word/_rels/header1.xml.rels",
			"word/charts/chart1.xml",
			"word/charts/_rels/chart1.xml.rels",
			"word/embeddings/Microsoft_Excel_Worksheet.xlsx",
			"word/embeddings/oleObject1.bin",
			"word/media/icon.png"
		])
			expect(names).not.toContain(name)

		expect(text(entries, "[Content_Types].xml")).not.toContain(CHART_TYPE)
		opened.editor.dispose()
	})
})
