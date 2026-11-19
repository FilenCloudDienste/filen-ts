import { describe, expect, it } from "vitest"
import { freshSlice } from "@filen/office/core/docx/edit"
import { saveDocx } from "@filen/office/core/docx/write"
import { sourceCopies } from "../core/docx/edit/session"
import {
	canMoveOutlineEntry,
	countRange,
	countSession,
	docxLineCount,
	docxOutline,
	docxRangeLayout,
	docxWordCount,
	type DocxWordCount,
	goToOutlineEntry,
	moveOutlineEntry,
	outlineEntryAt,
	outlineSectionEnd
} from "../core/docx/paged/queries"
import type { PagedEditor } from "../core/docx/paged/editor"
import { STYLES_PART } from "./docxEditFixtures"
import { buildDocx, p, type SyntheticDocx } from "./docxSynthetic"
import { pagedEditor, settleAll } from "./pagedFixtures"

const STYLES = STYLES_PART(
	'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
		'<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
		'<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>'
)

function spec(body: string): SyntheticDocx {
	return { body, parts: [STYLES], relationships: [{ id: "rIdS", type: "styles", target: "styles.xml" }] }
}

const h1 = (text: string): string => p(text, '<w:pStyle w:val="Heading1"/>')
const h2 = (text: string): string => p(text, '<w:pStyle w:val="Heading2"/>')

function paragraphs(editor: PagedEditor): string[] {
	const out: string[] = []

	editor.body.session.state.doc.forEach(node => {
		out.push(node.textContent)
	})

	return out
}

async function opened(body: string): Promise<PagedEditor> {
	const { editor } = await pagedEditor(buildDocx(spec(body)))

	await settleAll(editor)

	return editor
}

describe("selection counts", () => {
	it("counts the words and characters of a range, a word cut in two counting once", async () => {
		const editor = await opened(p("Hello brave new world") + p("Second line here"))
		const session = editor.body.session
		// "brave new" and "Sec" (positions: paragraph 1 opens at 0, text from 1).
		const first = 1 + "Hello ".length
		const secondStart = session.state.doc.child(0).nodeSize + 1

		expect(countRange(session, first, first + "brave new".length)).toMatchObject({
			words: 2,
			characters: 9,
			charactersNoSpaces: 8,
			paragraphs: 1
		})
		expect(countRange(session, first, secondStart + 3)).toMatchObject({ words: 4, paragraphs: 2 })
		expect(countRange(session, 5, 5)).toMatchObject({ words: 0, characters: 0, paragraphs: 0 })
		expect(countRange(session, 0, session.state.doc.content.size)).toEqual(await countSession(session))
		editor.dispose()
	})
})

const NOTE_REFERENCE = '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>'
const NOTE_SEPARATORS =
	'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
	'<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
const NOTE =
	'<w:footnote w:id="1"><w:p><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> a note of six words</w:t></w:r></w:p></w:footnote>'
const TEXTBOX =
	'<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">' +
	'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>' +
	'<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
	'<wp:extent cx="2743200" cy="914400"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/>' +
	'<wp:docPr id="3" name="Text Box 3"/><wp:cNvGraphicFramePr/>' +
	'<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/>' +
	'<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>' +
	"<wps:txbx><w:txbxContent><w:p><w:r><w:t>Boxed words here</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>"
const NOTED = buildDocx({
	body: `<w:p><w:r><w:t>Noted</w:t></w:r>${NOTE_REFERENCE}</w:p><w:p>${TEXTBOX}<w:r><w:t>Holds the box</w:t></w:r></w:p>${p("After")}`,
	footnotes: NOTE_SEPARATORS + NOTE
})

// The counts of a fresh open of what `editor` saves.
async function savedCount({ editor, pkg, context }: Awaited<ReturnType<typeof pagedEditor>>): Promise<DocxWordCount> {
	await settleAll(editor)

	const result = await saveDocx({ pkg, context, sessions: editor.sessions })

	if (result.bytes === undefined) throw new Error("No bytes")

	const fresh = (await pagedEditor(result.bytes)).editor

	await settleAll(fresh)

	const count = await docxWordCount(fresh, { notesAndTextBoxes: true })

	fresh.dispose()

	return count
}

describe("word counts with notes and text boxes", () => {
	it("counts an edited footnote and a text box whose paragraph was edited once", async () => {
		const edited = await pagedEditor(NOTED)
		const { editor } = edited
		const before = await docxWordCount(editor, { notesAndTextBoxes: true })

		expect(before).toMatchObject({ words: 1 + 3 + 1 + 5 + 3, paragraphs: 5 })

		const footnote = editor.edits.model.stories.find(story => story?.kind === "footnote" && story.id === "1")

		if (footnote === undefined) throw new Error("no footnote")

		expect(editor.enterStory(footnote.index, 0)).toBe(true)
		editor.session.dispatch(editor.session.state.tr.insertText(" more", editor.session.state.doc.content.size - 1))
		editor.exitStory()
		// The paragraph holding the text box, a keystroke at a time.
		for (const char of "Still ") {
			editor.dispatch(editor.state.tr.insertText(char, editor.state.doc.child(0).nodeSize + 1 + "Still ".indexOf(char)))
			await settleAll(editor)
		}

		const count = await docxWordCount(editor, { notesAndTextBoxes: true })

		expect(count).toMatchObject({ words: before.words + 2, paragraphs: 5 })
		expect(count).toEqual(await savedCount(edited))
		editor.dispose()
	})

	it("counts the text box of a copied paragraph as the save keeps it", async () => {
		const edited = await pagedEditor(NOTED)
		const { editor } = edited
		const body = editor.body.session
		const doc = body.state.doc
		const start = doc.child(0).nodeSize
		const end = start + doc.child(1).nodeSize
		const part = body.story.part.index
		const slice = freshSlice(doc.slice(start, end), sourceCopies(edited.context), part, part)

		expect(body.dispatch(body.state.tr.replaceRange(end, end, slice).setMeta("uiEvent", "paste"))).toBe(true)
		await settleAll(editor)

		const count = await docxWordCount(editor, { notesAndTextBoxes: true })

		// A copy keeps no drawing that only the source's bytes hold: the box is the source's alone.
		expect(count).toMatchObject({ words: 1 + 3 + 3 + 1 + 5 + 3, paragraphs: 6 })
		expect(count).toEqual(await savedCount(edited))
		editor.dispose()
	})

	it("tells a text box only an overlay part holds from one laid out as its source story", async () => {
		const { editor } = await pagedEditor(NOTED)
		const edits = editor.edits
		const body = editor.body.session.story
		const xml = (marker: string): Uint8Array =>
			new TextEncoder().encode(
				`<w:p>${TEXTBOX.replace("<w:txbxContent>", `<w:txbxContent${marker}>`)}<w:r><w:t>Holds the box</w:t></w:r></w:p>`
			)
		const source = edits.model.stories.find(story => story?.kind === "textbox")

		if (source === undefined) throw new Error("no text box")

		const textboxOf = (bytes: Uint8Array): number => {
			const added = edits.addPart(body.part, body.story.item, bytes, true)
			const story = edits.model.stories.find(entry => entry?.kind === "textbox" && entry.part === added?.part.index)

			if (story === undefined) throw new Error("no overlay text box")

			return story.index
		}

		expect(edits.overlayTextbox(source.index)).toBe(false)
		expect(edits.overlayTextbox(textboxOf(xml(` data-filen-story="${String(source.index)}"`)))).toBe(false)
		expect(edits.overlayTextbox(textboxOf(xml("")))).toBe(true)
		editor.dispose()
	})
})

describe("line counts", () => {
	it("counts the body's laid out lines, a wrapped paragraph's each", async () => {
		const long = "word ".repeat(200).trim()
		const editor = await opened(p("One") + p("Two") + p(long))
		const lines = docxLineCount(editor)

		expect(lines).toBeGreaterThan(3)
		expect((await docxWordCount(editor)).lines).toBe(lines)
		expect(docxRangeLayout(editor, 1, 2)).toEqual({ pages: 1, lines: 1 })

		const doc = editor.body.session.state.doc

		expect(docxRangeLayout(editor, 1, doc.content.size - 1)).toEqual({ pages: editor.pageCount, lines })
		editor.dispose()
	})

	it("keeps a page's count until it is laid out again", async () => {
		const editor = await opened(p("One") + p("Two"))

		expect(docxLineCount(editor)).toBe(2)
		editor.dispatch(editor.state.tr.split(2))
		await settleAll(editor)
		expect(docxLineCount(editor)).toBe(3)
		editor.dispose()
	})
})

describe("outline navigation", () => {
	const body = h1("Alpha") + p("a1") + h2("Alpha sub") + p("a2") + h1("Beta") + p("b1") + h1("Gamma") + p("c1")

	it("finds the heading governing a position and a heading's subheadings", async () => {
		const editor = await opened(body)
		const outline = docxOutline(editor)

		expect(outline.entries.map(entry => entry.text)).toEqual(["Alpha", "Alpha sub", "Beta", "Gamma"])
		expect(outlineEntryAt(outline, 0)).toBe(0)
		expect(outlineEntryAt(outline, (outline.entries[1]?.pos ?? 0) + 3)).toBe(1)
		expect(outlineEntryAt(outline, (outline.entries[2]?.pos ?? 0) - 1)).toBe(1)
		expect(outlineEntryAt(outline, editor.state.doc.content.size)).toBe(3)
		expect(outlineSectionEnd(outline, 0)).toBe(2)
		expect(outlineSectionEnd(outline, 1)).toBe(2)
		expect(outlineSectionEnd(outline, 3)).toBe(4)
		editor.dispose()
	})

	it("moves a heading with its content, before another heading or to the end", async () => {
		const editor = await opened(body)

		expect(moveOutlineEntry(editor, docxOutline(editor), 2, 0)).toBe(true)
		expect(paragraphs(editor)).toEqual(["Beta", "b1", "Alpha", "a1", "Alpha sub", "a2", "Gamma", "c1"])
		expect(editor.state.selection.$from.parent.textContent).toBe("Beta")

		// Alpha (with Alpha sub) to the end.
		const outline = docxOutline(editor)

		expect(moveOutlineEntry(editor, outline, 1, outline.entries.length)).toBe(true)
		expect(paragraphs(editor)).toEqual(["Beta", "b1", "Gamma", "c1", "Alpha", "a1", "Alpha sub", "a2"])
		expect(editor.state.selection.$from.parent.textContent).toBe("Alpha")
		editor.dispose()
	})

	it("refuses a place within what moves, and an outline the document has left", async () => {
		const editor = await opened(body)
		const outline = docxOutline(editor)

		expect(moveOutlineEntry(editor, outline, 0, 1)).toBe(false)
		expect(moveOutlineEntry(editor, outline, 0, 2)).toBe(false)
		expect(canMoveOutlineEntry(outline, 0)).toBe(true)

		editor.dispatch(editor.state.tr.insertText("x", 1))
		expect(moveOutlineEntry(editor, outline, 2, 0)).toBe(false)
		expect(paragraphs(editor)[0]).toBe("xAlpha")
		editor.dispose()
	})

	it("lists a paragraph given a heading style the file does not define yet", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("Plain") + p("Text") }))

		editor.select({ pos: 1, affinity: 1, page: 0, line: 0, atom: false })
		expect(await editor.execute({ type: "style.set", style: "heading2" })).toBe(true)
		expect(docxOutline(editor).entries.map(entry => [entry.level, entry.text])).toEqual([[1, "Plain"]])
		editor.dispose()
	})

	it("gives a built-in heading style defined without an outline level, and one based on it, its level", async () => {
		const styles = STYLES_PART(
			'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
				'<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/><w:basedOn w:val="Normal"/></w:style>' +
				'<w:style w:type="paragraph" w:styleId="Mine"><w:name w:val="Mine"/><w:basedOn w:val="Heading3"/></w:style>'
		)
		const { editor } = await pagedEditor(
			buildDocx({
				body: p("Three", '<w:pStyle w:val="Heading3"/>') + p("Derived", '<w:pStyle w:val="Mine"/>') + p("Plain"),
				parts: [styles],
				relationships: [{ id: "rIdS", type: "styles", target: "styles.xml" }]
			})
		)

		expect(docxOutline(editor).entries.map(entry => [entry.level, entry.text])).toEqual([
			[2, "Three"],
			[2, "Derived"]
		])
		editor.dispose()
	})

	it("gives a style an edit added its heading level whatever the spacing and case of its name", async () => {
		const editor = await opened(p("Odd", '<w:pStyle w:val="Odd"/>') + p("Plain"))

		editor.body.session.context.newStyles.set("Odd", "  Heading   3 ")
		expect(docxOutline(editor).entries.map(entry => [entry.level, entry.text])).toEqual([[2, "Odd"]])
		editor.dispose()
	})

	it("lists a heading's text as shown: tabs as spaces, fields by their result, deleted content left out", async () => {
		const heading = (runs: string): string => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${runs}</w:p>`
		const deleted = (runs: string): string => `<w:del w:id="9" w:author="A" w:date="2024-01-01T00:00:00Z">${runs}</w:del>`
		const editor = await opened(
			heading("<w:r><w:t>2.1</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Scope</w:t></w:r>") +
				p("text") +
				heading('<w:fldSimple w:instr=" TITLE "><w:r><w:t>Report title</w:t></w:r></w:fldSimple>') +
				heading(
					"<w:r><w:t>Kept</w:t></w:r>" +
						deleted(
							'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:delInstrText xml:space="preserve"> TITLE </w:delInstrText></w:r>' +
								'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:delText>Gone</w:delText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
						) +
						deleted("<w:r><w:tab/></w:r>")
				)
		)
		const outline = docxOutline(editor)

		expect(outline.entries.map(entry => entry.text)).toEqual(["2.1 Scope", "Report title", "Kept"])

		const field = outline.entries[1]

		if (field === undefined) throw new Error("no field heading")

		expect(goToOutlineEntry(editor, outline, field)).toBe(true)
		expect(editor.state.selection.from).toBe(field.pos + 1)
		expect(await docxWordCount(editor)).toMatchObject({ words: 2 + 1 + 2 + 1, characters: 9 + 4 + 12 + 4 })
		editor.dispose()
	})

	it("does not move a heading inside a table", async () => {
		const table = `<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>${h1("In table")}</w:tc></w:tr></w:tbl>`
		const editor = await opened(h1("Top") + table + p("after"))
		const outline = docxOutline(editor)

		expect(outline.entries.map(entry => entry.text)).toEqual(["Top", "In table"])
		expect(canMoveOutlineEntry(outline, 1)).toBe(false)
		expect(moveOutlineEntry(editor, outline, 1, 0)).toBe(false)
		editor.dispose()
	})
})
