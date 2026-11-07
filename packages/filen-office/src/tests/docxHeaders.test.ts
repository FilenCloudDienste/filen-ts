import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { OpcPackage, Relationships, bytesSource, type Relationship } from "@filen/office/core/opc"
import type { DocxPackage } from "@filen/office/core/docx"
import { DocxEditorSession, type DocxEditContext, type DocxEditorCommand } from "@filen/office/core/docx/edit"
import { PagedEditor } from "@filen/office/core/docx/paged"
import { DocxSaveError, saveDocx } from "@filen/office/core/docx/write"
import { markInternal } from "../core/docx/edit/invariants/index"
import { docSectionChanges } from "../core/docx/stories/sections"
import { DocxVerifyError } from "../core/docx/write/failure"
import type { CheckInput } from "../core/docx/write/checks/index"
import { sectionChecks } from "../core/docx/write/checks/sections"
import { openBytes } from "./docxEditFixtures"
import { buildDocx, p, type ExtraPart } from "./docxSynthetic"
import { pageDigest, pagedEditor, savedDigest, settleAll } from "./pagedFixtures"

const decoder = new TextDecoder()
const MARGINS = '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
const SECTION = (references: string): string => `<w:sectPr>${references}<w:pgSz w:w="12240" w:h="15840"/>${MARGINS}</w:sectPr>`
const HEADER = (type: string, id: string): string => `<w:headerReference w:type="${type}" r:id="${id}"/>`
// Two sections, each with a page of its own; the first refers to header rIdH, the second to none (it shows the
// first's).
const TWO_SECTIONS = buildDocx({
	body: p("First section") + `<w:p><w:pPr>${SECTION(HEADER("default", "rIdH"))}</w:pPr></w:p>` + p("Second section") + SECTION(""),
	headers: { rIdH: p("Shared header") }
})

// A PNG of a width x height picture (its header: the pixels are not needed to place it).
function png(width: number, height: number): Uint8Array {
	const u32 = (value: number): number[] => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
	const chunk = (type: string, data: readonly number[]): number[] => [
		...u32(data.length),
		...[...type].map(c => c.charCodeAt(0)),
		...data,
		0,
		0,
		0,
		0
	]

	return new Uint8Array([
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
		...chunk("IHDR", [...u32(width), ...u32(height), 8, 6, 0, 0, 0]),
		...chunk("IEND", [])
	])
}

const PICTURE =
	'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="457200"/>' +
	'<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="5" name="Logo"/>' +
	'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr>' +
	'<pic:cNvPr id="0" name="a.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
	'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
	"</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
// A header holding what a paste copy leaves out: a picture with its relationship, a link, a field, a content
// control, a tracked insertion, a bookmark and a comment anchor (these two stay with the original) and paragraph
// ids.
const RICH_HEADER =
	`<w:p w14:paraId="1A2B3C4D" w14:textId="77777777"><w:bookmarkStart w:id="3" w:name="logo"/>${PICTURE}<w:bookmarkEnd w:id="3"/>` +
	'<w:hyperlink r:id="rIdLink"><w:r><w:t>Site</w:t></w:r></w:hyperlink>' +
	'<w:ins w:id="7" w:author="Ann" w:date="2026-01-01T00:00:00Z"><w:r><w:t xml:space="preserve"> new</w:t></w:r></w:ins></w:p>' +
	'<w:p w14:paraId="2B3C4D5E"><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>' +
	'<w:sdt><w:sdtPr><w:id w:val="99"/><w:text/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Control</w:t></w:r></w:p></w:sdtContent></w:sdt>'
const RICH = buildDocx({
	body: p("First section") + `<w:p><w:pPr>${SECTION(HEADER("default", "rIdH"))}</w:pPr></w:p>` + p("Second section") + SECTION(""),
	headers: { rIdH: RICH_HEADER },
	parts: [
		{ name: "word/media/a.png", data: png(96, 48) },
		{
			name: "word/_rels/header1.xml.rels",
			data:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
				'<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.png"/>' +
				'<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/>' +
				"</Relationships>"
		}
	]
})

const CHART_TYPE = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
const RELATIONSHIPS = (entries: string): string =>
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
	`${entries}</Relationships>`
const RELATIONSHIP = (id: string, type: string, target: string): string =>
	`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`
// A header holding a chart (its data in an embedded workbook), an embedded object, a content control and a
// text box as Word 16 writes one (wps in mc:Choice, the same content in the VML of mc:Fallback).
const BOX_CONTENT = "<w:txbxContent><w:p><w:r><w:t>Inside the box</w:t></w:r></w:p></w:txbxContent>"
const OWNING_HEADER =
	'<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1828800" cy="914400"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
	'<wp:docPr id="6" name="Chart 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
	'<c:chart r:id="rIdChart"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>' +
	'<w:r><w:object w:dxaOrig="1440" w:dyaOrig="720"><v:shape id="_x0000_i1025" type="#_x0000_t75" style="width:72pt;height:36pt" o:ole="">' +
	'<v:imagedata r:id="rIdImg" o:title=""/></v:shape><o:OLEObject Type="Embed" ProgID="Package" ShapeID="_x0000_i1025" DrawAspect="Content" ObjectID="_1" r:id="rIdOle"/></w:object></w:r></w:p>' +
	'<w:sdt><w:sdtPr><w:id w:val="99"/><w:text/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Control</w:t></w:r></w:p></w:sdtContent></w:sdt>' +
	'<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">' +
	'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
	'<wp:extent cx="2743200" cy="457200"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="7" name="Text Box 7"/><wp:cNvGraphicFramePr/>' +
	'<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/>' +
	'<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>' +
	`<wps:txbx>${BOX_CONTENT}</wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>` +
	'<mc:Fallback><w:pict><v:shape id="Text Box 7" o:spid="_x0000_s1026" type="#_x0000_t202" style="position:absolute;margin-left:0;margin-top:0;width:216pt;height:36pt;z-index:251659264">' +
	`<v:textbox>${BOX_CONTENT}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>Boxed</w:t></w:r></w:p>`
const OWNING_PARTS = (): readonly ExtraPart[] => [
	{ name: "word/media/a.png", data: png(96, 48) },
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
	{
		name: "word/_rels/header1.xml.rels",
		data: RELATIONSHIPS(
			RELATIONSHIP("rIdChart", "chart", "charts/chart1.xml") +
				RELATIONSHIP("rIdOle", "oleObject", "embeddings/oleObject1.bin") +
				RELATIONSHIP("rIdImg", "image", "media/a.png")
		)
	}
]
const OWNING = buildDocx({
	body: p("First section") + `<w:p><w:pPr>${SECTION(HEADER("default", "rIdH"))}</w:pPr></w:p>` + p("Second section") + SECTION(""),
	headers: { rIdH: OWNING_HEADER },
	parts: OWNING_PARTS()
})
// Three sections showing the first's header.
const OWNING_THREE = buildDocx({
	body:
		p("First section") +
		`<w:p><w:pPr>${SECTION(HEADER("default", "rIdH"))}</w:pPr></w:p>` +
		`<w:p><w:pPr>${SECTION("")}</w:pPr><w:r><w:t>Second section</w:t></w:r></w:p>` +
		p("Third section") +
		SECTION(""),
	headers: { rIdH: OWNING_HEADER },
	parts: OWNING_PARTS()
})

async function read(bytes: Uint8Array, name: string): Promise<string> {
	return decoder.decode(await (await OpcPackage.open(bytesSource(bytes))).read(name))
}

interface Opened {
	readonly editor: PagedEditor
	readonly pkg: DocxPackage
	readonly context: DocxEditContext
}

function caret(editor: PagedEditor, pos: number): void {
	const session = editor.session

	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, pos)))
}

async function run(editor: PagedEditor, command: DocxEditorCommand): Promise<boolean> {
	return await editor.execute(command)
}

function type(editor: PagedEditor, text: string): void {
	editor.session.dispatch(editor.session.state.tr.insertText(text))
}

async function saved({ editor, pkg, context }: Opened): Promise<Uint8Array> {
	await settleAll(editor)

	const result = await saveDocx({ pkg, context, sessions: editor.sessions })

	if (result.bytes === undefined) throw new Error("No bytes")

	expect(pageDigest(editor.layout)).toEqual(await savedDigest(result.bytes))

	return result.bytes
}

// The text of each page's header (region 1) as laid out.
async function headerTexts(editor: PagedEditor): Promise<string[]> {
	await settleAll(editor)

	return pageDigest(editor.layout).map(page =>
		page
			.split("\n")
			.filter(line => / 257 1 /.test(line))
			.map(line => /"([^"]*)"/.exec(line)?.[1] ?? "")
			.join("|")
	)
}

describe("docx headers and footers", () => {
	it("makes a header where the document has none, in Word's Header style, and enters it", async () => {
		const opened = await pagedEditor(buildDocx({ body: p("Body text") }))
		const { editor } = opened

		caret(editor, 3)
		expect(editor.snapshot().enabled["header.edit"]).toBe(true)
		expect(await run(editor, { type: "header.edit" })).toBe(true)
		expect(editor.session.story.story.kind).toBe("header")
		expect(editor.snapshot().context.story).toMatchObject({
			kind: "header",
			header: {
				kind: "header",
				section: 0,
				sections: 1,
				type: "default",
				differentFirst: false,
				differentOddEven: false,
				linkedToPrevious: false,
				canLink: false
			}
		})
		type(editor, "New header")

		const bytes = await saved(opened)

		expect(await read(bytes, "word/document.xml")).toMatch(
			/<w:sectPr><w:headerReference w:type="default" r:id="(rId\d+)"\/><\/w:sectPr>/
		)
		expect(await read(bytes, "word/header1.xml")).toContain(
			'<w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:t>New header</w:t></w:r></w:p></w:hdr>'
		)
		expect(await read(bytes, "word/styles.xml")).toContain('w:styleId="Header"')
		expect(await headerTexts(editor)).toEqual(["New header"])

		// Undone in the body's history: the header part is not saved.
		editor.exitStory()
		expect(await run(editor, { type: "history.undo" })).toBe(true)
		expect(await run(editor, { type: "history.undo" })).toBe(true)

		const undone = await saved(opened)

		expect((await openBytes(undone)).pkg.has("word/header1.xml")).toBe(false)
		editor.dispose()
	})

	// A header is counted from its start on every page: an edit of a numbered paragraph in it numbers it again
	// from there, never on from the count of its layout before the edit.
	it("numbers a header's list the same on every page after its paragraphs are edited", async () => {
		const opened = await pagedEditor(
			buildDocx({
				body:
					p("First section") +
					`<w:p><w:pPr>${SECTION(HEADER("default", "rIdH"))}</w:pPr></w:p>` +
					p("Second section") +
					SECTION(""),
				headers: { rIdH: p("One") + p("Two") }
			})
		)
		const { editor } = opened

		caret(editor, 3)
		expect(await run(editor, { type: "header.edit" })).toBe(true)

		const session = editor.session

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 1, session.state.doc.content.size - 1)))
		expect(await run(editor, { type: "list.numbered" })).toBe(true)
		await settleAll(editor)
		// The second paragraph alone written again: the first keeps its number, the second still counts it.
		caret(editor, session.state.doc.content.size - 1)
		type(editor, " more")
		await saved(opened)
		expect(await headerTexts(editor)).toEqual(["1.\\tOne|2.\\tTwo more", "1.\\tOne|2.\\tTwo more"])
		editor.dispose()
	})

	// An empty w:hdr (no paragraph, as some writers leave it) gets an empty paragraph to edit in: untouched, the
	// header is saved and laid out as it was.
	it("keeps an empty header part as it is until its paragraph is edited", async () => {
		const bytes = buildDocx({ body: p("Body text") + SECTION(HEADER("default", "rIdH")), headers: { rIdH: "" } })
		const document = await openBytes(bytes)
		const sessions = document.model.stories.map(story => new DocxEditorSession(document.context, { story }))
		const unedited = await saveDocx({ pkg: document.pkg, context: document.context, sessions })

		expect(unedited.changedParts).toEqual([])

		const opened = await pagedEditor(bytes)
		const { editor } = opened

		caret(editor, 3)
		expect(await run(editor, { type: "header.edit" })).toBe(true)
		expect(editor.session.state.doc.childCount).toBe(1)
		editor.exitStory()
		type(editor, "More ")
		expect(await read(await saved(opened), "word/header1.xml")).toMatch(/<w:hdr [^>]*><\/w:hdr>$/)

		caret(editor, 3)
		expect(await run(editor, { type: "header.edit" })).toBe(true)
		type(editor, "Typed")
		expect(await read(await saved(opened), "word/header1.xml")).toContain("<w:t>Typed</w:t>")
		editor.dispose()
	})

	it("links a section's header to the previous section's and unlinks it with a copy", async () => {
		const opened = await pagedEditor(TWO_SECTIONS)
		const { editor } = opened

		// The second section shows the first's header: linked.
		caret(editor, 20)
		expect(await run(editor, { type: "header.edit" })).toBe(true)
		expect(editor.snapshot().context.story.header).toMatchObject({ section: 1, linkedToPrevious: true, canLink: true })

		// Unlinked: its own header, a copy, edited apart.
		expect(await run(editor, { type: "header.linkToPrevious" })).toBe(true)
		expect(editor.snapshot().context.story.header).toMatchObject({ section: 1, linkedToPrevious: false })
		type(editor, "Own ")
		expect(await headerTexts(editor)).toEqual(["Shared header", "Own Shared header"])

		const bytes = await saved(opened)
		const document = await read(bytes, "word/document.xml")

		expect(document).toMatch(/<w:sectPr><w:headerReference w:type="default" r:id="rId\d+"\/><w:pgSz/)
		expect(await read(bytes, "word/header2.xml")).toContain("<w:t>Own Shared header</w:t>")

		// Linked again: the copy goes with the reference.
		expect(await run(editor, { type: "header.linkToPrevious" })).toBe(true)
		expect(editor.snapshot().context.story.header).toMatchObject({ linkedToPrevious: true })
		expect(await headerTexts(editor)).toEqual(["Shared header", "Shared header"])

		const linked = await saved(opened)

		expect((await openBytes(linked)).pkg.has("word/header2.xml")).toBe(false)
		editor.dispose()
	})

	it("unlinks a section's header with a copy of everything it shows, as Word copies it", async () => {
		for (const edited of [false, true]) {
			const opened = await pagedEditor(RICH)
			const { editor } = opened

			// Edited first: the copy is the header as it is now.
			if (edited) {
				caret(editor, 3)
				expect(await run(editor, { type: "header.edit" })).toBe(true)
				type(editor, "Now ")
				editor.exitStory()
				await settleAll(editor)
			}

			caret(editor, 20)
			expect(await run(editor, { type: "header.edit" })).toBe(true)
			expect(await run(editor, { type: "header.linkToPrevious" })).toBe(true)
			expect(editor.snapshot().context.story.header).toMatchObject({ section: 1, linkedToPrevious: false })

			// The same on both pages (the field numbering each).
			const shown = (await headerTexts(editor)).map(text => text.replace(/Page \d+/, "Page #"))

			expect(shown[1]).toBe(shown[0])
			expect(shown[0]).toContain(edited ? "Now \ufffcSite new|Page #|Control" : "\ufffcSite new|Page #|Control")

			const bytes = await saved(opened)
			const original = await read(bytes, "word/header1.xml")
			const copy = await read(bytes, "word/header2.xml")
			const relationships = await read(bytes, "word/_rels/header2.xml.rels")

			// The picture, link, field, content control and tracked insertion, with relationships of their own.
			expect(copy).toContain('<a:blip r:embed="rIdImg"/>')
			expect(copy).toContain('<w:hyperlink r:id="rIdLink">')
			expect(copy).toContain('<w:fldSimple w:instr=" PAGE ">')
			// A content control of its own: Word gives a copy a new w:id.
			expect(copy).toMatch(/<w:sdt><w:sdtPr><w:id w:val="(-?\d+)"\/><w:text\/><\/w:sdtPr>/)
			expect(copy).not.toContain('<w:id w:val="99"/>')
			expect(copy).toMatch(/<w:ins w:id="(\d+)" w:author="Ann"/)
			expect(relationships).toContain(
				'Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.png"'
			)
			expect(relationships).toContain('Id="rIdLink"')
			expect(relationships).toContain('TargetMode="External"')
			// What must be unique stays the original's alone.
			expect(copy).not.toMatch(/bookmarkStart|bookmarkEnd|w14:paraId|w14:textId/)
			expect(copy).not.toContain('<wp:docPr id="5"')
			expect(copy).not.toContain('<w:ins w:id="7"')
			expect(original).toContain('<w:bookmarkStart w:id="3" w:name="logo"/>')
			expect(original).toContain('<wp:docPr id="5" name="Logo"/>')

			const reopened = await openBytes(bytes)

			expect(reopened.model.sections.map(section => section.effectiveHeaders.default)).toHaveLength(2)
			editor.dispose()
		}
	})

	it("unlinks a copy owning its chart and embedded object, its controls renumbered, its text boxes as edited", async () => {
		const opened = await pagedEditor(OWNING)
		const { editor, pkg } = opened
		const box = editor.edits.model.stories.find(story => story?.kind === "textbox")

		// The text box is edited in its own session, not yet saved.
		expect(box).toBeDefined()
		expect(editor.enterStory(box?.index ?? -1, 0)).toBe(true)
		caret(editor, 1)
		type(editor, "Edited ")
		editor.exitStory()

		caret(editor, 20)
		expect(await run(editor, { type: "header.edit" })).toBe(true)
		expect(await run(editor, { type: "header.linkToPrevious" })).toBe(true)

		const bytes = await saved(opened)
		const reopened = await OpcPackage.open(bytesSource(bytes))
		const original = await read(bytes, "word/header1.xml")
		const copy = await read(bytes, "word/header2.xml")
		const relationships = await reopened.relationships("word/header2.xml")

		// The text box as edited, in both branches, in the original and the copy.
		for (const xml of [original, copy]) {
			expect(xml.match(/Edited Inside the box/g)).toHaveLength(2)
			expect(xml).not.toMatch(/<w:t>Inside the box/)
		}

		// New VML shape and embedded object ids, the object naming its shape's new id.
		const shape = /<v:shape id="([^"]+)" type="#_x0000_t75"/.exec(copy)?.[1]

		expect(shape).toBeDefined()
		expect(shape).not.toBe("_x0000_i1025")
		expect(copy).toContain(`ShapeID="${shape ?? ""}"`)
		expect(copy).not.toContain('ObjectID="_1"')
		expect(copy).not.toContain('o:spid="_x0000_s1026"')
		expect(original).toContain('ShapeID="_x0000_i1025"')

		// A new content control id.
		expect(copy).not.toContain('<w:id w:val="99"/>')
		expect(copy).toMatch(/<w:sdtPr><w:id w:val="-?\d+"\/>/)

		// The chart, its workbook and the embedded object are the copy's own; the picture is shared.
		expect(relationships.byId("rIdChart")?.partName).toBe("word/charts/chart2.xml")
		expect(relationships.byId("rIdOle")?.partName).toBe("word/embeddings/oleObject2.bin")
		expect(relationships.byId("rIdImg")?.partName).toBe("word/media/a.png")
		expect((await reopened.relationships("word/header1.xml")).byId("rIdChart")?.partName).toBe("word/charts/chart1.xml")
		expect((await reopened.relationships("word/charts/chart2.xml")).byId("rIdData")?.partName).toBe(
			"word/embeddings/Microsoft_Excel_Worksheet1.xlsx"
		)
		expect(await reopened.read("word/charts/chart2.xml")).toEqual(await pkg.opc.read("word/charts/chart1.xml"))
		expect(await reopened.read("word/embeddings/oleObject2.bin")).toEqual(new Uint8Array([7, 8, 9]))
		expect(await reopened.read("word/embeddings/Microsoft_Excel_Worksheet1.xlsx")).toEqual(
			await pkg.opc.read("word/embeddings/Microsoft_Excel_Worksheet.xlsx")
		)
		expect((await reopened.contentTypes()).typeOf("word/charts/chart2.xml")).toBe(CHART_TYPE)
		editor.dispose()
	})

	it("gives each copy of a header its own chart and embedded object", async () => {
		const opened = await pagedEditor(OWNING_THREE)
		const { editor } = opened

		for (const text of ["Second section", "Third section"]) {
			const doc = editor.body.session.state.doc
			let at = -1

			doc.descendants((node, pos) => {
				if (at < 0 && node.isText && node.text === text) at = pos + 1

				return at < 0
			})
			editor.exitStory()
			caret(editor, at)
			expect(await run(editor, { type: "header.edit" })).toBe(true)
			expect(await run(editor, { type: "header.linkToPrevious" })).toBe(true)
		}

		const bytes = await saved(opened)
		const reopened = await OpcPackage.open(bytesSource(bytes))
		const charts = await Promise.all(
			["word/header1.xml", "word/header2.xml", "word/header3.xml"].map(
				async name => (await reopened.relationships(name)).byId("rIdChart")?.partName
			)
		)

		expect(new Set(charts).size).toBe(3)
		expect(charts[0]).toBe("word/charts/chart1.xml")
		editor.dispose()
	})

	it("edits the copy apart from the header it was made from, and drops it when linked again", async () => {
		const opened = await pagedEditor(RICH)
		const { editor } = opened

		caret(editor, 20)
		expect(await run(editor, { type: "header.edit" })).toBe(true)
		expect(await run(editor, { type: "header.linkToPrevious" })).toBe(true)
		type(editor, "Own ")

		const [first, second] = (await headerTexts(editor)).map(text => text.replace(/Page \d+/, "Page #"))

		expect(second).toBe(`Own ${first ?? ""}`)

		const bytes = await saved(opened)

		expect(await read(bytes, "word/header2.xml")).toContain('<a:blip r:embed="rIdImg"/>')
		expect(await run(editor, { type: "header.linkToPrevious" })).toBe(true)

		const linked = await saved(opened)
		const reopened = await openBytes(linked)

		expect(reopened.pkg.has("word/header2.xml")).toBe(false)
		expect(reopened.pkg.has("word/_rels/header2.xml.rels")).toBe(false)
		editor.dispose()
	})

	it("refuses a copy whose relationships do not read as those of the part it was copied from", async () => {
		const opened = await pagedEditor(RICH)
		const { editor } = opened

		caret(editor, 20)
		expect(await run(editor, { type: "header.edit" })).toBe(true)
		expect(await run(editor, { type: "header.linkToPrevious" })).toBe(true)

		const part = editor.session.story.part
		const kept = part.relationships.all
		const check = async (written: readonly Relationship[]): Promise<unknown> => {
			const input = {
				original: opened.pkg,
				relationshipsOf: () => Promise.resolve(new Relationships(written)),
				exists: () => true
			} as unknown as CheckInput

			for (const entry of sectionChecks) {
				try {
					await entry.part?.(input, { name: "word/header2.xml", part, document: part.document, skeleton: false })
				} catch (error) {
					return error
				}
			}

			return undefined
		}

		expect(kept.map(relationship => relationship.id).sort()).toEqual(["rIdImg", "rIdLink"])
		expect(await check(kept)).toBeUndefined()
		expect(
			await check(
				kept.map(relationship => (relationship.id === "rIdImg" ? { ...relationship, partName: "word/media/b.png" } : relationship))
			)
		).toBeInstanceOf(DocxVerifyError)
		expect(await check(kept.filter(relationship => relationship.id !== "rIdLink"))).toBeInstanceOf(DocxVerifyError)
		editor.dispose()
	})

	it("lays out the empty paragraph of a header without blocks once a table goes before it, and not once it goes again", async () => {
		// The first-page header's part has no block: its editor holds an empty paragraph standing for none.
		const opened = await pagedEditor(
			buildDocx({
				body: p("Body") + SECTION(HEADER("default", "rIdD") + HEADER("first", "rIdF") + "<w:titlePg/>"),
				headers: { rIdD: p("Default header"), rIdF: "" }
			})
		)
		const { editor } = opened

		caret(editor, 1)
		expect(await run(editor, { type: "header.edit" })).toBe(true)
		expect(editor.snapshot().context.story.header).toMatchObject({ type: "first" })
		expect(await run(editor, { type: "table.insert", rows: 1, cols: 1 })).toBe(true)
		// The table's paragraph and the one after it, as the save writes them.
		expect(await headerTexts(editor)).toEqual(["|"])
		expect(await read(await saved(opened), "word/header2.xml")).toMatch(/<\/w:tbl><w:p><\/w:p><\/w:hdr>$/)

		expect(await run(editor, { type: "history.undo" })).toBe(true)
		expect(await headerTexts(editor)).toEqual([""])
		await saved(opened)
		editor.dispose()
	})

	it("saves a header whose relationships the edit rewrites while one already pointed at a part the package lacks", async () => {
		const opened = await pagedEditor(
			buildDocx({
				body: p("Body") + SECTION(HEADER("default", "rIdH")),
				headers: { rIdH: `${p("Header")}<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>` },
				parts: [
					{
						name: "word/_rels/header1.xml.rels",
						data: RELATIONSHIPS(
							RELATIONSHIP("rIdGone", "image", "media/gone.png") +
								'<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>'
						)
					}
				]
			})
		)
		const { editor } = opened

		caret(editor, 1)
		expect(await run(editor, { type: "header.edit" })).toBe(true)
		editor.session.dispatch(editor.session.state.tr.delete(0, editor.session.state.doc.content.size))

		// The link's relationship goes with it; the one to the missing picture stays as the source had it.
		const rels = await read(await saved(opened), "word/_rels/header1.xml.rels")

		expect(rels).not.toContain("rIdLink")
		expect(rels).toContain('Id="rIdGone"')
		editor.dispose()
	})

	it("shows a different first page and different even pages", async () => {
		const opened = await pagedEditor(TWO_SECTIONS)
		const { editor } = opened

		caret(editor, 3)
		expect(await run(editor, { type: "header.edit" })).toBe(true)
		expect(await run(editor, { type: "header.differentFirst" })).toBe(true)
		expect(editor.snapshot().context.story.header?.differentFirst).toBe(true)
		// The first page now shows the first-page header, which the section does not have: none.
		expect(await headerTexts(editor)).toEqual(["", "Shared header"])

		editor.exitStory()
		caret(editor, 3)
		expect(await run(editor, { type: "header.edit" })).toBe(true)
		expect(editor.snapshot().context.story.header).toMatchObject({ type: "first" })
		type(editor, "Title page")
		expect(await headerTexts(editor)).toEqual(["Title page", "Shared header"])

		expect(await run(editor, { type: "header.differentOddEven" })).toBe(true)
		expect(editor.snapshot().context.story.header?.differentOddEven).toBe(true)

		const bytes = await saved(opened)

		expect(await read(bytes, "word/settings.xml")).toContain("<w:evenAndOddHeaders/>")
		expect(await read(bytes, "word/document.xml")).toMatch(/<w:headerReference w:type="first" r:id="rId\d+"\/>.*<w:titlePg\/>/)
		// The second page is even: it shows the even header, which nothing has.
		expect(await headerTexts(editor)).toEqual(["Title page", ""])
		expect(docSectionChanges(editor.body.session.state.doc).evenAndOddHeaders).toBe(true)
		editor.dispose()
	})

	it("removes a header from every section showing it", async () => {
		const opened = await pagedEditor(TWO_SECTIONS)
		const { editor } = opened

		caret(editor, 20)
		expect(editor.snapshot().enabled["header.remove"]).toBe(true)
		expect(editor.snapshot().enabled["footer.remove"]).toBe(false)
		expect(await run(editor, { type: "header.remove" })).toBe(true)
		expect(await headerTexts(editor)).toEqual(["", ""])

		const bytes = await saved(opened)

		expect(await read(bytes, "word/document.xml")).not.toContain("headerReference")
		editor.dispose()
	})

	it("removes the header of a section unlinked from the previous one: it shows none, the previous keeps its own", async () => {
		const opened = await pagedEditor(TWO_SECTIONS)
		const { editor } = opened

		caret(editor, 20)
		expect(await run(editor, { type: "header.edit" })).toBe(true)
		expect(await run(editor, { type: "header.linkToPrevious" })).toBe(true)
		expect(await run(editor, { type: "header.remove" })).toBe(true)
		expect(await headerTexts(editor)).toEqual(["Shared header", ""])

		const xml = await read(await saved(opened), "word/document.xml")

		expect(xml.match(/<w:headerReference /g)).toHaveLength(2)
		editor.dispose()
	})

	it("tracks what is typed in a header while changes are tracked", async () => {
		const opened = await pagedEditor(TWO_SECTIONS)
		const { editor, context } = opened

		context.identity.author = "Tester"
		context.review.tracking = true
		caret(editor, 3)
		expect(await run(editor, { type: "header.edit" })).toBe(true)
		type(editor, "Tracked ")
		expect(editor.snapshot().review.revisionCount).toBe(1)

		const bytes = await saved(opened)

		expect(await read(bytes, "word/header1.xml")).toMatch(
			/<w:ins w:id="\d+" w:author="Tester" w:date="[^"]+"><w:r><w:t xml:space="preserve">Tracked <\/w:t><\/w:r><\/w:ins>/
		)
		expect(await run(editor, { type: "review.rejectAll" })).toBe(true)
		expect(await read(await saved(opened), "word/header1.xml")).not.toContain("Tracked")
		editor.dispose()
	})

	it("refuses a section reference to a part that is no header", async () => {
		const opened = await pagedEditor(TWO_SECTIONS)
		const { editor, pkg, context } = opened
		const body = editor.body.session
		const key = body.state.doc.attrs["sectPr"] as number

		body.dispatch(
			markInternal(
				body.state.tr.setDocAttribute("sectionChanges", {
					final: { section: key, base: key, footers: { default: body.story.story.index } }
				})
			)
		)

		const error = await saveDocx({ pkg, context, sessions: editor.sessions }).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(DocxSaveError)
		editor.dispose()
	})
})
