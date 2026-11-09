import { describe, expect, it } from "vitest"
import {
	canMoveOutlineEntry,
	countRange,
	countSession,
	docxLineCount,
	docxOutline,
	docxRangeLayout,
	docxWordCount,
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
