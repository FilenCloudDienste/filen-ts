import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { docxSchema, type DocxEditorCommand } from "@filen/office/core/docx/edit"
import {
	currentNoteOptions,
	currentPageSetup,
	docxBookmarkStart,
	docxBookmarks,
	docxLinkAt,
	formatDatePicture,
	tableBorderOf,
	type DocxCurrentPageSetup,
	type PagedEditor
} from "@filen/office/core/docx/paged"
import { saveDocx } from "@filen/office/core/docx/write"
import { STYLES_PART } from "./docxEditFixtures"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor, settleAll } from "./pagedFixtures"

// What the editing UI reads before it changes something: page setup and note numbering of the caret's section,
// the bookmarks a link offers, a table border's drag, and which field updates run while paged layout is
// suspended.

const nodes = docxSchema.nodes

function caret(editor: PagedEditor, pos: number): void {
	const session = editor.session

	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, pos)))
}

// The position just inside the first paragraph whose text starts with `text`.
function at(editor: PagedEditor, text: string): number {
	let found = -1

	editor.state.doc.descendants((node, pos) => {
		if (found >= 0) return false
		if (node.type === nodes.paragraph && node.textContent.startsWith(text)) found = pos + 1

		return node.type !== nodes.paragraph
	})

	if (found < 0) throw new Error(`no paragraph ${text}`)

	return found
}

async function run(editor: PagedEditor, command: DocxEditorCommand): Promise<boolean> {
	return await editor.execute(command)
}

async function reopened(editor: PagedEditor, opened: Awaited<ReturnType<typeof pagedEditor>>): Promise<PagedEditor> {
	await settleAll(editor)

	const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: editor.sessions })

	if (result.bytes === undefined) throw new Error("no bytes")

	return (await pagedEditor(result.bytes)).editor
}

const LETTER: DocxCurrentPageSetup = {
	size: { width: 12_240, height: 15_840 },
	orientation: "portrait",
	margins: { top: 1440, bottom: 1440, left: 1440, right: 1440, header: 720, footer: 720, gutter: 0 },
	columns: { count: 1, space: 720, separator: false },
	mirrorMargins: false,
	pageNumbers: { start: null, format: "decimal" },
	lineNumbers: null
}

describe("page setup of the caret's section", () => {
	it("reads Letter for a body without page size, the page layout lays out", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("Plain") }))

		expect(currentPageSetup(editor)).toEqual(LETTER)
		// Pages are in CSS px: 15 twips each.
		expect(Math.round((editor.page(0)?.width ?? 0) * 15)).toBe(12_240)
		expect(Math.round((editor.page(0)?.height ?? 0) * 15)).toBe(15_840)
		editor.dispose()
	})

	it("reads what page.setup wrote before a save, per section, and the same after one", async () => {
		const section = (extra: string): string =>
			`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1100" w:bottom="1200" w:left="1300" w:header="500" w:footer="600" w:gutter="0"/>${extra}</w:sectPr>`
		const opened = await pagedEditor(
			buildDocx({
				body:
					p("First") +
					`<w:p><w:pPr>${section('<w:pgNumType w:fmt="hebrew1" w:start="4"/><w:lnNumType w:countBy="0"/>')}</w:pPr></w:p>` +
					p("Second") +
					section(
						'<w:lnNumType w:countBy="2" w:start="9" w:distance="500" w:restart="continuous"/><w:cols w:num="3" w:space="400" w:sep="1"/>'
					)
			})
		)
		const { editor } = opened

		caret(editor, at(editor, "First"))
		// A format the commands do not offer reads null; w:countBy 0 is no line numbers (Word shows none).
		expect(currentPageSetup(editor)).toEqual({
			size: { width: 11_906, height: 16_838 },
			orientation: "portrait",
			margins: { top: 1000, bottom: 1200, left: 1300, right: 1100, header: 500, footer: 600, gutter: 0 },
			columns: { count: 1, space: 720, separator: false },
			mirrorMargins: false,
			pageNumbers: { start: 4, format: null },
			lineNumbers: null
		})

		caret(editor, at(editor, "Second"))
		// Word numbers lines from w:start + 1.
		expect(currentPageSetup(editor)).toMatchObject({
			columns: { count: 3, space: 400, separator: true },
			pageNumbers: { start: null, format: "decimal" },
			lineNumbers: { countBy: 2, start: 10, distance: 500, restart: "continuous" }
		})

		caret(editor, at(editor, "First"))
		expect(
			await run(editor, {
				type: "page.setup",
				size: { width: 12_240, height: 20_160 },
				orientation: "landscape",
				margins: { left: 720, gutter: 360 },
				columns: { count: 2, space: 360, separator: true },
				pageNumbers: { start: 7, format: "upperRoman" },
				lineNumbers: { countBy: 5, start: 3, restart: "newSection" }
			})
		).toBe(true)

		// Turned to landscape, the margins turned with the page.
		const edited: DocxCurrentPageSetup = {
			size: { width: 20_160, height: 12_240 },
			orientation: "landscape",
			margins: { top: 1300, bottom: 1100, left: 720, right: 1000, header: 500, footer: 600, gutter: 360 },
			columns: { count: 2, space: 360, separator: true },
			mirrorMargins: false,
			pageNumbers: { start: 7, format: "upperRoman" },
			lineNumbers: { countBy: 5, start: 3, distance: 360, restart: "newSection" }
		}

		expect(currentPageSetup(editor)).toEqual(edited)

		// The other section is as it was.
		caret(editor, at(editor, "Second"))
		expect(currentPageSetup(editor).columns.count).toBe(3)

		const saved = await reopened(editor, opened)

		caret(saved, at(saved, "First"))
		expect(currentPageSetup(saved)).toEqual(edited)
		saved.dispose()

		// Undone, the section reads as it did.
		caret(editor, at(editor, "First"))
		expect(await run(editor, { type: "history.undo" })).toBe(true)
		expect(currentPageSetup(editor).orientation).toBe("portrait")
		editor.dispose()
	})
})

describe("note numbering of the caret's section", () => {
	it("reads Word's defaults, the settings, the section's own and what note.options set", async () => {
		const plain = await pagedEditor(buildDocx({ body: p("Text") }))

		expect(currentNoteOptions(plain.editor, "footnote")).toEqual({
			kind: "footnote",
			format: "decimal",
			start: 1,
			restart: "continuous",
			position: "pageBottom"
		})
		expect(currentNoteOptions(plain.editor, "endnote")).toEqual({
			kind: "endnote",
			format: "lowerRoman",
			start: 1,
			restart: "continuous",
			position: "docEnd"
		})
		plain.editor.dispose()

		const { editor } = await pagedEditor(
			buildDocx({
				body:
					p("First") +
					'<w:p><w:pPr><w:sectPr><w:footnotePr><w:numFmt w:val="upperLetter"/><w:numRestart w:val="eachPage"/></w:footnotePr></w:sectPr></w:pPr></w:p>' +
					p("Second") +
					'<w:sectPr><w:endnotePr><w:numFmt w:val="hebrew1"/><w:numRestart w:val="eachPage"/></w:endnotePr></w:sectPr>',
				settings: '<w:footnotePr><w:pos w:val="beneathText"/><w:numFmt w:val="lowerRoman"/><w:numStart w:val="5"/></w:footnotePr>'
			})
		)

		caret(editor, at(editor, "First"))
		expect(currentNoteOptions(editor, "footnote")).toEqual({
			kind: "footnote",
			format: "upperLetter",
			start: 5,
			restart: "eachPage",
			position: "beneathText"
		})

		caret(editor, at(editor, "Second"))
		// A format the commands do not offer reads null; endnotes never restart on each page.
		expect(currentNoteOptions(editor, "endnote")).toMatchObject({ format: null, restart: "continuous", position: "docEnd" })
		expect(currentNoteOptions(editor, "footnote")).toMatchObject({ format: "lowerRoman", start: 5, restart: "continuous" })

		expect(
			await run(editor, {
				type: "note.options",
				kind: "footnote",
				format: "chicago",
				start: 2,
				restart: "eachSect",
				position: "pageBottom",
				scope: "section"
			})
		).toBe(true)
		expect(currentNoteOptions(editor, "footnote")).toEqual({
			kind: "footnote",
			format: "chicago",
			start: 2,
			restart: "eachSect",
			position: "pageBottom"
		})

		// Where notes go is the document's: the first section reads it too.
		caret(editor, at(editor, "First"))
		expect(currentNoteOptions(editor, "footnote")).toMatchObject({ format: "upperLetter", position: "pageBottom" })
		editor.dispose()
	})
})

describe("bookmarks a link offers", () => {
	it("lists the body's visible bookmarks once each, in order, and the same list until the body changes", async () => {
		const mark = (id: number, name: string, text: string): string =>
			`<w:p><w:bookmarkStart w:id="${String(id)}" w:name="${name}"/><w:r><w:t>${text}</w:t></w:r><w:bookmarkEnd w:id="${String(id)}"/></w:p>`
		const { editor } = await pagedEditor(
			buildDocx({
				body:
					mark(1, "Results", "One") +
					mark(2, "_Toc123456789", "Two") +
					mark(3, "Appendix", "Three") +
					mark(4, "_GoBack", "Four") +
					mark(5, "results", "Five"),
				headers: {
					rIdH: '<w:p><w:bookmarkStart w:id="9" w:name="InHeader"/><w:r><w:t>H</w:t></w:r><w:bookmarkEnd w:id="9"/></w:p>'
				}
			})
		)
		const list = docxBookmarks(editor)

		expect(list.map(bookmark => bookmark.name)).toEqual(["Results", "Appendix"])
		expect(docxBookmarks(editor)).toBe(list)

		caret(editor, at(editor, "One") + 2)
		expect(await run(editor, { type: "bookmark.add", name: "Middle" })).toBe(true)
		expect(docxBookmarks(editor).map(bookmark => bookmark.name)).toEqual(["Results", "Middle", "Appendix"])
		editor.dispose()
	})

	it("reads the link a press follows: an external target or a bookmark it goes to", async () => {
		const { editor } = await pagedEditor(
			buildDocx({
				body:
					'<w:p><w:r><w:t xml:space="preserve">See </w:t></w:r><w:hyperlink r:id="rIdL"><w:r><w:t>site</w:t></w:r></w:hyperlink></w:p>' +
					'<w:p><w:hyperlink w:anchor="results"><w:r><w:t>Jump</w:t></w:r></w:hyperlink></w:p>' +
					'<w:p><w:bookmarkStart w:id="1" w:name="Results"/><w:r><w:t>Target</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>',
				relationships: [{ id: "rIdL", type: "hyperlink", target: "https://example.com/", external: true }]
			})
		)
		const site = at(editor, "See") + 4

		expect(docxLinkAt(editor, site)).toEqual({ target: "https://example.com/", anchor: null })
		// At the link's end, and not before it.
		expect(docxLinkAt(editor, site + 4)).toEqual({ target: "https://example.com/", anchor: null })
		expect(docxLinkAt(editor, site - 1)).toBeUndefined()

		const jump = docxLinkAt(editor, at(editor, "Jump") + 1)

		expect(jump).toEqual({ target: null, anchor: "results" })
		// Just after its start marker.
		expect(docxBookmarkStart(editor, jump?.anchor ?? "")).toBe(at(editor, "Target") + 1)
		expect(docxBookmarkStart(editor, "missing")).toBeUndefined()
		editor.dispose()
	})

	it("formats a date under a date picture", () => {
		expect(formatDatePicture(Date.UTC(2026, 0, 5, 12), "d MMMM yyyy", "en")).toBe("5 January 2026")
	})
})

describe("field updates while paged layout is suspended", () => {
	it("offers field and table of contents updates only while the pages are laid out", async () => {
		const toc =
			'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r>' +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Entry</w:t></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		const page =
			'<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		const { editor } = await pagedEditor(buildDocx({ body: toc + page + p("Plain") }))
		const UPDATES = ["field.update", "field.updateAll", "toc.insert", "toc.update"] as const
		const enabled = (): Record<string, boolean> =>
			Object.fromEntries(UPDATES.map(type => [type, editor.snapshot().enabled[type]] as const))

		caret(editor, at(editor, "Page") + 5)
		expect(enabled()).toEqual({ "field.update": true, "field.updateAll": true, "toc.insert": true, "toc.update": true })

		editor.suspend()
		expect(enabled()).toEqual({ "field.update": false, "field.updateAll": false, "toc.insert": false, "toc.update": false })
		// Refused, not left waiting for a layout that does not come.
		expect(await run(editor, { type: "field.updateAll" })).toBe(false)
		// Inserting a field computes its result from the pages as they are: still offered.
		expect(editor.snapshot().enabled["insert.pageNumber"]).toBe(true)

		editor.resume()
		expect(enabled()).toEqual({ "field.update": true, "field.updateAll": true, "toc.insert": true, "toc.update": true })
		editor.dispose()
	})
})

describe("table border drags", () => {
	const sides =
		'<w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders>'
	const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`
	const table = (tblPr: string, row: readonly string[]): string =>
		`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${tblPr}${sides}</w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>` +
		`<w:tr>${row.map(cell).join("")}</w:tr></w:tbl>`

	// The x of the border ending grid column `column` on the first page, as a hit finds it.
	function borderX(editor: PagedEditor, column: number): { x: number; y: number } {
		const page = editor.page(0)

		if (page === undefined) throw new Error("no page")

		for (let k = 0; k < page.graphicCount; k++) {
			const [x = 0, y = 0, width = 0, height = 0] = page.graphicFloats.subarray(k * 4, k * 4 + 4)

			if (height <= width) continue

			const hit = editor.hitObject(0, x + width / 2, y + height / 2)

			if (hit?.kind === "tableBorder" && hit.part === `column:${String(column)}`) return { x: x + width / 2, y: y + height / 2 }
		}

		throw new Error(`no border of column ${String(column)}`)
	}

	it("gives a border's column, widths and direction, and a drag the width that moves it the way it went", async () => {
		for (const rtl of [false, true]) {
			const { editor } = await pagedEditor(
				buildDocx({ body: p("Before") + table(rtl ? "<w:bidiVisual/>" : "", ["a1", "b1", "c1"]) + p("After") })
			)
			const start = borderX(editor, 0)
			const hit = editor.hitObject(0, start.x, start.y)

			if (hit === undefined) throw new Error("no hit")

			const border = tableBorderOf(editor, hit)

			expect(border).toEqual({ column: 0, widths: [2000, 2000, 2000], rtl, minTwips: 230 })
			// Not a border: nothing.
			expect(tableBorderOf(editor, { ...hit, kind: "drawing" })).toBeUndefined()
			expect(tableBorderOf(editor, { ...hit, pos: 0 })).toBeUndefined()

			// The table context says the same direction.
			caret(editor, at(editor, "a1"))
			expect(editor.snapshot().context.table?.rtl).toBe(rtl)

			// Dragged 30 px to the right: a right-to-left column narrows.
			const dx = 30
			const width = (border?.widths[0] ?? 0) + (border?.rtl === true ? -dx : dx) * 15

			expect(await run(editor, { type: "table.column.width", index: 0, twips: width })).toBe(true)
			await settleAll(editor)

			const moved = borderX(editor, 0)

			expect(moved.x - start.x).toBeCloseTo(dx, 0)
			editor.dispose()
		}
	})

	it("reads a table's direction from its style, and a style a command set", async () => {
		const { editor } = await pagedEditor(
			buildDocx({
				body: table('<w:tblStyle w:val="Rtl"/>', ["a1", "b1", "c1"]) + p("After"),
				parts: [
					STYLES_PART(
						'<w:style w:type="table" w:styleId="Rtl"><w:name w:val="Rtl"/><w:tblPr><w:bidiVisual/></w:tblPr></w:style>' +
							'<w:style w:type="table" w:styleId="Ltr"><w:name w:val="Ltr"/></w:style>'
					)
				],
				relationships: [{ id: "rIdStyles", type: "styles", target: "styles.xml" }]
			})
		)

		caret(editor, at(editor, "a1"))
		expect(editor.snapshot().context.table?.rtl).toBe(true)
		expect(await run(editor, { type: "table.style", styleId: "Ltr" })).toBe(true)
		expect(editor.snapshot().context.table?.rtl).toBe(false)
		editor.dispose()
	})
})
