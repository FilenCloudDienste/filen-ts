import { existsSync } from "node:fs"
import { join } from "node:path"
import { unzipSync } from "fflate"
import type { Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { Transform } from "prosemirror-transform"
import { describe, expect, it, vi } from "vitest"
import { layoutDocument, refPart, RevisionView, type DocxPackage } from "@filen/office/core/docx"
import { docxSchema, type DocxEditContext, type DocxEditorSession } from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { saveDocx, StoryWriter } from "@filen/office/core/docx/write"
import { MeasureCache, StyleTable } from "@filen/office/core/text"
import { BlockFlow, Engine, type FlowSnapshot } from "../core/docx/layout/flow"
import { DecorationTable, RunStyles } from "../core/docx/layout/styles"
import { TableLayout } from "../core/docx/layout/table"
import { Item } from "../core/docx/model/index"
import { namePrefixes, StoryEdits, type OverlayRecord } from "../core/docx/paged/edits"
import { CORPUS_DIR } from "./corpusDir"
import { buildDocx } from "./docxSynthetic"
import { HmtxMeasurer, layOut, loadDocx, readBytes } from "./layoutFixtures"
import { editedLayout, finishLayout, pageDigest, pagedEditor, savedDigest, settleAll, type EditedLayout } from "./pagedFixtures"
import { harness } from "./textFixtures"
import { runJobs } from "./fuzz/config"

// Edits laid out incrementally show exactly what a fresh layout of the saved file shows.

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname
const SUSPENSIONS = join(CORPUS_DIR, "docx", "govuk__The_Suspensions_of_Import_Duty_Rates_Document_3.7.docx")
const BROCHURE = join(CORPUS_DIR, "dotx", "oxsdk__Brochure_TP10072667.dotx")

function paragraphs(doc: Node, inTables: boolean, minimum = 8): { node: Node; pos: number }[] {
	const out: { node: Node; pos: number }[] = []

	doc.descendants((node, pos, parent) => {
		if (node.type === docxSchema.nodes.paragraph) {
			const inCell = parent?.type === docxSchema.nodes.table_cell

			if (inCell === inTables && node.textContent.length >= minimum && node.firstChild?.isText === true) out.push({ node, pos })

			return false
		}

		return !node.isInline
	})

	return out
}

function select(session: DocxEditorSession, from: number, to: number = from): void {
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

async function expectSaved(edited: EditedLayout): Promise<void> {
	const saved = await savedDigest(await edited.save())

	expect(pageDigest(edited.layout)).toEqual(saved)
}

const words = (count: number, seed = 1): string =>
	Array.from({ length: count }, (_, k) => ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"][(k * 7 + seed) % 6]).join(" ")

const para = (text: string, pPr = ""): string =>
	`<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

const PAGE =
	'<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
const LANDSCAPE =
	'<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
const NARROW =
	'<w:pgSz w:w="8000" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'

// A content control holding `inner`.
const control = (inner: string): string => `<w:sdt><w:sdtPr><w:id w:val="7"/></w:sdtPr><w:sdtContent>${inner}</w:sdtContent></w:sdt>`

function longDocument(paragraphCount: number): Uint8Array {
	const p = (text: string, pPr = ""): string =>
		`<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
	const body =
		Array.from({ length: paragraphCount }, (_, k) =>
			k % 17 === 9
				? `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>${Array.from(
						{ length: 3 },
						(_, r) =>
							`<w:tr><w:tc><w:p><w:r><w:t>cell ${r} ${words(6, k + r)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>${words(4, r)}</w:t></w:r></w:p></w:tc></w:tr>`
					).join("")}</w:tbl>`
				: k % 23 === 11
					? p(words(20, k), "<w:pageBreakBefore/>")
					: p(words(30 + (k % 7) * 9, k), k % 13 === 0 ? "<w:keepNext/>" : "")
		).join("") +
		'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'

	return buildDocx({ body })
}

// Paragraphs with a footnote each, notes of a few lengths.
function notedDocument(): Uint8Array {
	const noted = (k: number): string =>
		`<w:p><w:r><w:t xml:space="preserve">${words(25 + (k % 4) * 11, k)} </w:t></w:r><w:r><w:footnoteReference w:id="${String(k + 1)}"/></w:r><w:r><w:t xml:space="preserve"> ${words(12, k + 2)}</w:t></w:r></w:p>`
	const note = (k: number): string =>
		`<w:footnote w:id="${String(k + 1)}"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${words(8 + (k % 3) * 20, k)}</w:t></w:r></w:p></w:footnote>`

	return buildDocx({
		body: Array.from({ length: 40 }, (_, k) => noted(k)).join("") + `<w:sectPr>${PAGE}</w:sectPr>`,
		footnotes:
			'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
			Array.from({ length: 40 }, (_, k) => note(k)).join(""),
		settings: '<w:footnotePr><w:footnote w:id="-1"/></w:footnotePr>'
	})
}

// A long table: a header row repeated on every page, rows of a few heights kept whole on a page, vertical
// merges across rows (some across a page boundary) and a numbered paragraph every so often.
function longTableDocument(): Uint8Array {
	const cell = (text: string, tcPr = ""): string =>
		`<w:tc>${tcPr === "" ? "" : `<w:tcPr>${tcPr}</w:tcPr>`}<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`
	const rows = Array.from({ length: 260 }, (_, r) => {
		if (r === 0) return `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell("Header one")}${cell("Header two")}</w:tr>`

		const merge = r % 19 === 3 ? '<w:vMerge w:val="restart"/>' : r % 19 === 4 || r % 19 === 5 ? "<w:vMerge/>" : ""
		const numbered =
			r % 23 === 7
				? `<w:tc><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>item ${r}</w:t></w:r></w:p></w:tc>`
				: cell(`row ${r} ${words(3 + (r % 5) * 4, r)}`)

		return `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(merge === "<w:vMerge/>" ? "" : `merged ${r} ${words(r % 3 === 0 ? 30 : 5, r)}`, merge)}${numbered}</w:tr>`
	}).join("")
	const numbering =
		'<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'

	return buildDocx({
		body:
			para(words(40)) +
			`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="6000"/></w:tblGrid>${rows}</w:tbl>` +
			para(words(30, 2)) +
			`<w:sectPr>${PAGE}</w:sectPr>`,
		parts: [
			{
				name: "word/numbering.xml",
				contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
				data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${numbering}</w:numbering>`
			}
		],
		relationships: [{ id: "rIdN1", type: "numbering", target: "numbering.xml" }]
	})
}

describe("paged layout of edits", { timeout: 60_000 }, () => {
	it("lays out typing, deletion and formatting like the saved file, stopping at the next page", async () => {
		const edited = await editedLayout(longDocument(160))
		const pages = edited.layout.pages.length

		expect(pages).toBeGreaterThan(12)

		const target = paragraphs(edited.session.state.doc, false)[40]

		if (target === undefined) throw new Error("no paragraph")

		await edited.edit(edited.session.state.tr.insertText("x", target.pos + 3))

		// One character: the page is laid out again, the rest is kept.
		expect(edited.last.laidOut).toBeLessThanOrEqual(2)
		expect(edited.layout.pages.length).toBe(pages)
		await expectSaved(edited)

		const other = paragraphs(edited.session.state.doc, false)[60]

		if (other === undefined) throw new Error("no paragraph")

		await edited.edit(edited.session.state.tr.delete(other.pos + 2, other.pos + 9))
		select(edited.session, other.pos + 2, other.pos + 8)
		await edited.edit(session => session.execute({ type: "format.bold" }))
		await expectSaved(edited)
	})

	it("lays out a paragraph command from the paragraph's page, not the whole document", async () => {
		const edited = await editedLayout(longDocument(160))
		const target = paragraphs(edited.session.state.doc, false)[100]

		if (target === undefined) throw new Error("no paragraph")

		select(edited.session, target.pos + 2)
		await edited.edit(session => session.execute({ type: "align.center" }))

		expect(edited.last.restart).toBeGreaterThan(5)
		expect(edited.last.laidOut).toBeLessThanOrEqual(3)
		await expectSaved(edited)
	})

	it("follows paragraphs added, split, joined and removed", async () => {
		const edited = await editedLayout(longDocument(120))
		const doc = (): Node => edited.session.state.doc
		const list = paragraphs(doc(), false)
		const split = list[10]

		if (split === undefined) throw new Error("no paragraph")

		await edited.edit(edited.session.state.tr.split(split.pos + 6))
		await expectSaved(edited)

		const again = paragraphs(doc(), false)
		const first = again[30]
		const second = again[31]

		if (first !== undefined && second !== undefined && first.pos + first.node.nodeSize === second.pos) {
			await edited.edit(edited.session.state.tr.join(second.pos))
			await expectSaved(edited)
		}

		const removed = paragraphs(doc(), false)[50]

		if (removed === undefined) throw new Error("no paragraph")

		await edited.edit(edited.session.state.tr.delete(removed.pos, removed.pos + removed.node.nodeSize))
		await expectSaved(edited)

		// Several paragraphs typed in a row (Enter after Enter).
		for (let k = 0; k < 6; k++) {
			const at = paragraphs(doc(), false)[70]

			if (at === undefined) break

			await edited.edit(edited.session.state.tr.split(at.pos + 4).insertText("new line ", at.pos + 6))
		}

		await expectSaved(edited)
	})

	it("edits table cells without laying the table out from an overlay", async () => {
		const edited = await editedLayout(longDocument(80))
		const cell = paragraphs(edited.session.state.doc, true, 4)[2]

		if (cell === undefined) throw new Error("no cell")

		await edited.edit(edited.session.state.tr.insertText("typed ", cell.pos + 1))

		// The table keeps its source; the paragraph is substituted.
		expect([...edited.edits.overlayRecords()].every(record => record.node.type === docxSchema.nodes.paragraph)).toBe(true)
		await expectSaved(edited)

		// A new paragraph in a cell changes its row's structure: that row alone is laid out from an overlay.
		const next = paragraphs(edited.session.state.doc, true, 4)[2]

		if (next === undefined) throw new Error("no cell")

		await edited.edit(edited.session.state.tr.split(next.pos + 3))

		const written = [...edited.edits.overlayRecords()]
		const row = written.find(record => record.node.type === docxSchema.nodes.table_row)

		expect(row).toBeDefined()
		expect(written.some(record => record.node.type === docxSchema.nodes.table)).toBe(false)
		await expectSaved(edited)

		// Typing in its cells afterwards, the new paragraph included, lays out just those paragraphs from overlays
		// over the row's own.
		for (const index of [2, 3, 5]) {
			const at = paragraphs(edited.session.state.doc, true, 1)[index]

			if (at === undefined) throw new Error("no cell")

			await edited.edit(edited.session.state.tr.insertText("more ", at.pos + 1))
		}

		const records = [...edited.edits.overlayRecords()]

		expect(records.filter(record => record.node.type === docxSchema.nodes.table_row)).toEqual([row])
		expect(records.filter(record => record.node.type === docxSchema.nodes.paragraph).length).toBeGreaterThanOrEqual(3)
		expect(records.some(record => record.node.type === docxSchema.nodes.paragraph && refPart(record.base) === row?.part.index)).toBe(
			true
		)
		await expectSaved(edited)
	})

	it("lays out a keystroke in a long table from the edited row's page and stops after it", async () => {
		const edited = await editedLayout(longTableDocument())
		const pages = edited.layout.pages.length

		expect(pages).toBeGreaterThan(12)

		// After `text` at the start of a cell's paragraph.
		const cellAt = (text: string): number => {
			const found = paragraphs(edited.session.state.doc, true, 1).find(entry => entry.node.textContent.startsWith(text))

			if (found === undefined) throw new Error(`no ${text}`)

			return found.pos + 1 + text.length
		}

		// Typing in a row half way down lays out the page holding it (and the one before), not the table.
		await edited.edit(edited.session.state.tr.insertText("x", cellAt("row 150 ")))

		expect(edited.last.restart).toBeGreaterThan(pages / 3)
		expect(edited.last.laidOut).toBeLessThanOrEqual(3)
		expect(edited.last.resyncedAt).toBeGreaterThan(edited.last.restart)
		await expectSaved(edited)

		// A row grown by lines moves every page break after it; tracked, into a merge, a numbered paragraph.
		await edited.edit(edited.session.state.tr.insertText(`${words(120, 4)} `, cellAt("row 101 ")))
		await expectSaved(edited)

		edited.context.identity.author = "Test"
		edited.context.review.tracking = true
		await edited.edit(edited.session.state.tr.insertText(`${words(40, 5)} `, cellAt("merged 79 ")))
		await edited.edit(edited.session.state.tr.insertText("y ", cellAt("item 76")))
		edited.context.review.tracking = false
		await expectSaved(edited)

		// Shortened, a row may move back to the page before; the header row is on every page.
		const long = paragraphs(edited.session.state.doc, true, 100).find(entry => entry.node.textContent.startsWith("row 101 "))

		if (long === undefined) throw new Error("no long row")

		await edited.edit(edited.session.state.tr.delete(long.pos + 10, long.pos + long.node.nodeSize - 3))
		await expectSaved(edited)
		await edited.edit(edited.session.state.tr.insertText(`${words(12, 6)} `, cellAt("Header two")))

		expect(edited.last.laidOut).toBeGreaterThan(pages / 2)
		await expectSaved(edited)
	})

	it("draws the caret in rows of a long table on pages an edit in another row kept", async () => {
		const { editor } = await pagedEditor(longTableDocument())
		const session = editor.body.session
		const at = (text: string): number => {
			const found = paragraphs(session.state.doc, true, 1).find(entry => entry.node.textContent.startsWith(text))

			if (found === undefined) throw new Error(`no ${text}`)

			return found.pos + 1 + text.length
		}
		const caretOn = async (text: string): Promise<number | undefined> => {
			select(session, at(text))
			await settleAll(editor)

			return editor.caret()?.page
		}
		const before = { early: await caretOn("row 20 "), late: await caretOn("row 230 ") }

		session.dispatch(session.state.tr.insertText("typed ", at("row 150 ")))
		await settleAll(editor)

		expect(before.early).toBeDefined()
		expect(await caretOn("row 20 ")).toBe(before.early)
		expect(await caretOn("row 230 ")).toBe(before.late)
		editor.dispose()
	})

	it("lays out an Enter in a long table's cell from an overlay of its row alone, one overlay per row edited", async () => {
		const edited = await editedLayout(longTableDocument())
		const pages = edited.layout.pages.length
		const cellAt = (text: string): number => {
			const found = paragraphs(edited.session.state.doc, true, 1).find(entry => entry.node.textContent.startsWith(text))

			if (found === undefined) throw new Error(`no ${text}`)

			return found.pos + 1 + text.length
		}
		const written = (): OverlayRecord[] => [...edited.edits.overlayRecords()]

		await edited.edit(edited.session.state.tr.split(cellAt("row 150 ")))

		const rows = written().filter(record => record.node.type === docxSchema.nodes.table_row)

		expect(written().some(record => record.node.type === docxSchema.nodes.table)).toBe(false)
		expect(rows.length).toBe(1)
		// The overlay part holds that row alone.
		expect(rows[0]?.part.document.bytes.length ?? Infinity).toBeLessThan(4096)
		expect(edited.last.restart).toBeGreaterThan(pages / 3)
		await expectSaved(edited)

		// Rows split again keep one overlay each (the one they were written to before is dropped).
		for (const text of ["row 20 ", "row 150 ", "row 230 ", "row 20 "]) await edited.edit(edited.session.state.tr.split(cellAt(text)))

		const live = written()

		expect(live.filter(record => record.node.type === docxSchema.nodes.table_row).length).toBe(3)
		expect(new Set(live.map(record => record.part)).size).toBe(3)
		await expectSaved(edited)

		// Undone, the rows are their sources again: nothing is laid out from an overlay.
		for (let k = 0; k < 10; k++) if (!(await edited.edit(session => session.execute({ type: "history.undo" })))) break

		expect(written()).toEqual([])
		expect(edited.edits.rows.size).toBe(0)
		await expectSaved(edited)
	})

	it("edits a long table inside a content control from the previous edit, not as opened", async () => {
		const cell = (text: string): string => `<w:tc><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`
		const rows = Array.from({ length: 120 }, (_, r) => `<w:tr>${cell(`row ${r} ${words(4, r)}`)}${cell(words(6, r))}</w:tr>`).join("")
		const edited = await editedLayout(
			buildDocx({
				body:
					para(words(20)) +
					'<w:sdt><w:sdtPr><w:id w:val="9"/></w:sdtPr><w:sdtContent>' +
					para("inside the control") +
					`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>${rows}</w:tbl>` +
					"</w:sdtContent></w:sdt>" +
					para(words(10)) +
					`<w:sectPr>${PAGE}</w:sectPr>`
			})
		)
		const cellAt = (text: string): number => {
			const found = paragraphs(edited.session.state.doc, true, 1).find(entry => entry.node.textContent.startsWith(text))

			if (found === undefined) throw new Error(`no ${text}`)

			return found.pos + 1 + text.length
		}
		const rowsWritten = (): OverlayRecord[] =>
			[...edited.edits.overlayRecords()].filter(record => record.node.type === docxSchema.nodes.table_row)

		await edited.edit(edited.session.state.tr.split(cellAt("row 30 ")))

		const first = rowsWritten()

		expect(first.length).toBe(1)
		await expectSaved(edited)

		// The next edits leave the row written before as it was (no second write of it), the paragraph before the
		// table too.
		await edited.edit(edited.session.state.tr.split(cellAt("row 90 ")))
		await edited.edit(edited.session.state.tr.insertText("typed ", cellAt("row 30 ")))
		const control = paragraphs(edited.session.state.doc, false, 1).find(entry => entry.node.textContent.startsWith("inside"))

		if (control === undefined) throw new Error("no paragraph in the control")

		await edited.edit(edited.session.state.tr.insertText("more ", control.pos + 1))

		const after = rowsWritten()

		expect(after.length).toBe(2)
		expect(after).toContain(first[0])
		expect([...edited.edits.overlayRecords()].some(record => record.node.type === docxSchema.nodes.table)).toBe(false)
		await expectSaved(edited)
	})

	it("keeps a cell's edited paragraph where it is when an earlier cell of its row grows", async () => {
		const cell = (text: string): string => `<w:tc><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`
		const rows = Array.from(
			{ length: 40 },
			(_, r) => `<w:tr>${cell(`a${r} ${words(3, r)}`)}${cell(`b${r} ${words(3, r)}`)}</w:tr>`
		).join("")
		const edited = await editedLayout(
			buildDocx({
				body:
					'<w:sdt><w:sdtPr><w:id w:val="9"/></w:sdtPr><w:sdtContent>' +
					para("inside the control") +
					`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>${rows}</w:tbl>` +
					"</w:sdtContent></w:sdt>" +
					`<w:sectPr>${PAGE}</w:sectPr>`
			})
		)
		const at = (text: string): number => {
			const doc = edited.session.state.doc
			const found = [...paragraphs(doc, true, 1), ...paragraphs(doc, false, 1)].find(entry => entry.node.textContent.startsWith(text))

			if (found === undefined) throw new Error(`no ${text}`)

			return found.pos + 1 + text.length
		}
		const misplaced = (): OverlayRecord[] =>
			[...edited.edits.overlayRecords()].filter(
				record => record.node.type === docxSchema.nodes.paragraph && record.entry.node.nodeAt(record.offset - 1) !== record.node
			)

		await edited.edit(edited.session.state.tr.insertText("typed ", at("b5 ")))
		await edited.edit(edited.session.state.tr.insertText(`${words(40, 2)} `, at("a5 ")))
		expect(misplaced()).toEqual([])

		// And shrinks again: the place a paragraph reports is where it is (paragraphOf).
		await edited.edit(edited.session.state.tr.delete(at("a5 "), at("a5 ") + words(40, 2).length))
		expect(misplaced()).toEqual([])

		const record = [...edited.edits.overlayRecords()].find(record => record.node.textContent.startsWith("b5 "))

		if (record === undefined) throw new Error("no record of b5")

		expect(edited.story.paragraphOf(record.part.index, record.item)?.pos).toBe(at("b5 ") - "b5 ".length - 1)

		// The control's other block edited: the table's records are taken over by where they stand.
		await edited.edit(edited.session.state.tr.insertText("more ", at("inside ")))
		expect(misplaced()).toEqual([])

		// Every substitution is an entry's (released with it).
		const owned = new Set(edited.story.entries.flatMap(entry => entry.substituted))

		expect([...edited.edits.substitutes.keys()].filter(base => !owned.has(base))).toEqual([])
		await expectSaved(edited)
	})

	it("lays out again what referred to a style the document lacked once an edit adds it", async () => {
		// A footnote reference styled FootnoteReference, a style the file does not define (no styles part).
		const noted =
			'<w:p><w:r><w:t>noted</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p>'
		const { editor, pkg, context } = await pagedEditor(
			buildDocx({
				body: noted + Array.from({ length: 40 }, (_, k) => para(words(40, k))).join("") + `<w:sectPr>${PAGE}</w:sectPr>`,
				footnotes:
					'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
					'<w:footnote w:id="1"><w:p><w:r><w:t>the note</w:t></w:r></w:p></w:footnote>'
			})
		)
		const session = editor.body.session

		await settleAll(editor)

		// A note inserted far after it: the save defines the style, which the first reference now shows with.
		const last = paragraphs(session.state.doc, false, 8).at(-1)

		if (last === undefined) throw new Error("no paragraph")

		select(session, last.pos + 4)
		expect(await editor.execute({ type: "note.insertFootnote" })).toBe(true)
		await settleAll(editor)
		expect(pageDigest(editor.layout)).toEqual(
			await savedDigest((await saveDocx({ pkg, context, sessions: editor.sessions })).bytes as Uint8Array)
		)
		editor.dispose()
	})

	it("keeps every paragraph a table edit writes its own when the same edit removes a row", async () => {
		const cell = (text: string): string => `<w:tc><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`
		const rows = Array.from({ length: 30 }, (_, r) => `<w:tr>${cell(`a${r} ${words(3, r)}`)}${cell(`b${r}`)}</w:tr>`).join("")
		const edited = await editedLayout(
			buildDocx({
				body:
					para("before") +
					`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>${rows}</w:tbl>` +
					para("after") +
					`<w:sectPr>${PAGE}</w:sectPr>`
			})
		)
		const at = (text: string): number => {
			const found = paragraphs(edited.session.state.doc, true, 1).find(entry => entry.node.textContent.startsWith(text))

			if (found === undefined) throw new Error(`no ${text}`)

			return found.pos + 1 + text.length
		}
		// A substitution no entry owns outlives the record it points at (nothing removes it with the entry).
		const unowned = (): number[] => {
			const owned = new Set(edited.story.entries.flatMap(entry => entry.substituted))

			return [...edited.edits.substitutes.keys()].filter(base => !owned.has(base))
		}
		const rowRange = (text: string): [number, number] => {
			const $pos = edited.session.state.doc.resolve(at(text))

			return [$pos.before($pos.depth - 2), $pos.after($pos.depth - 2)]
		}

		await edited.edit(edited.session.state.tr.insertText("edited ", at("a3 ")))

		// One edit: that row removed and a paragraph of another row written for the first time.
		const [from, to] = rowRange("a3 ")
		const typed = at("a20 ")

		await edited.edit(edited.session.state.tr.insertText("typed ", typed).delete(from, to))
		expect(unowned()).toEqual([])
		await expectSaved(edited)

		// Written again in an edit that adds a block before the table (the table's entry made anew).
		await edited.edit(edited.session.state.tr.insertText("more ", at("a20 ")).split(4))
		expect(unowned()).toEqual([])
		await expectSaved(edited)
	})

	it("merges edited paragraphs' overlays into one part while idle, laying their pages out the same", async () => {
		const { editor, pkg, context } = await pagedEditor(longDocument(160))
		const session = editor.body.session
		const edits = editor.edits
		const parts = (): number => new Set([...edits.overlayRecords()].map(record => record.part)).size
		const saved = async (): Promise<string[]> =>
			savedDigest((await saveDocx({ pkg, context, sessions: editor.sessions })).bytes as Uint8Array)

		edits.compaction = { ...edits.compaction, parts: 6, minimum: 3, quietMs: 0 }

		// Typed into one paragraph after another near the start (and into table cells): an overlay part each.
		for (let k = 0; k < 8; k++) {
			const target = paragraphs(session.state.doc, k % 3 === 2, 8)[k]

			if (target === undefined) throw new Error("no paragraph")

			select(session, target.pos + 3)
			editor.setVisible(editor.caret()?.page ?? 0, (editor.caret()?.page ?? 0) + 1)
			session.dispatch(session.state.tr.insertText(`typed ${String(k)} `))
			await editor.whenSettled()
		}

		const records = [...edits.overlayRecords()].length

		// The slices' loop merged them (and laid their pages out again), the blocks all still edited.
		expect(parts()).toBeLessThan(records)
		expect(pageDigest(editor.layout)).toEqual(await saved())

		// Edited again in a merged paragraph; the caret and a click on it map through the merged part.
		const again = paragraphs(session.state.doc, false, 8)[1]

		if (again === undefined) throw new Error("no paragraph")

		select(session, again.pos + 3)
		session.dispatch(session.state.tr.insertText("again "))
		await editor.whenSettled()

		const caret = editor.caret()

		if (caret === undefined) throw new Error("no caret")

		expect(editor.hitTest(caret.page, caret.x, caret.top + caret.height / 2)?.pos).toBe(session.state.selection.head)
		expect(pageDigest(editor.layout)).toEqual(await saved())
		editor.dispose()
	})

	it("writes the blocks formatting over the whole document changes while idle, laying them out as saved", async () => {
		for (const bytes of [longDocument(160), longTableDocument()]) {
			const { editor, pkg, context } = await pagedEditor(bytes)
			const session = editor.body.session
			const edits = editor.edits
			const saved = async (): Promise<string[]> =>
				savedDigest((await saveDocx({ pkg, context, sessions: editor.sessions })).bytes as Uint8Array)

			await settleAll(editor)

			const end = session.state.doc.content.size

			// The command itself writes none of them; the layout's slices do, and lay their pages out again.
			session.dispatch(session.state.tr.addMark(0, end, docxSchema.marks.bold.create({ value: true })))
			expect([...edits.overlayRecords()].length).toBe(0)
			expect(editor.layout.final).toBe(false)
			await settleAll(editor)
			expect(edits.pending()).toBe(false)
			expect([...edits.overlayRecords()].length).toBeGreaterThan(0)
			expect(pageDigest(editor.layout)).toEqual(await saved())

			// Taken off again before they are all written, then typed into.
			session.dispatch(session.state.tr.removeMark(0, end, docxSchema.marks.bold))
			editor.layout.advance(0, -1)
			select(session, end - 5)
			session.dispatch(session.state.tr.insertText("typed "))
			await settleAll(editor)

			const caret = editor.caret()

			if (caret === undefined) throw new Error("no caret")

			expect(editor.hitTest(caret.page, caret.x, caret.top + caret.height / 2)?.pos).toBe(session.state.selection.head)
			expect(pageDigest(editor.layout)).toEqual(await saved())

			editor.dispose()
		}

		// Laid out synchronously to the end: every block written first, a long table's rows a few at a time.
		const edited = await editedLayout(longTableDocument())
		const doc = edited.session.state.doc

		await edited.edit(edited.session.state.tr.addMark(0, doc.content.size, docxSchema.marks.italic.create({ value: true })))
		expect(edited.layout.final).toBe(true)
		expect(edited.edits.pending()).toBe(false)
		await expectSaved(edited)
	})

	it("shows a page announced and cut in the same task once a later run keeps it unannounced", async () => {
		const { editor } = await pagedEditor(longDocument(160), 0)
		const session = editor.body.session
		const layout = editor.layout

		await settleAll(editor)

		const count = layout.pages.length
		const list = paragraphs(session.state.doc, false)
		const middle = list[list.length >> 1]

		if (middle === undefined) throw new Error("no paragraph")

		editor.setVisible(0, 0)
		// Grows the document by a page from its middle; the run is left there.
		session.dispatch(session.state.tr.insertText(` ${words(1200, 3)}`, middle.pos + 1))
		expect(layout.final).toBe(false)

		// In one task: that run lays the new page out to the end, then a run from the first page that may meet
		// the layout again past page 3 yields before it does (the pages after it cut until then).
		while (layout.advance(Infinity, -1) !== "done");
		expect(layout.pages.length).toBeGreaterThan(count)
		layout.beginEdit(0, [], 3)
		layout.advance(0, -1)
		expect(layout.pages.length).toBeLessThan(4)
		// The editor takes the pages announced while they are cut.
		await Promise.resolve()

		await settleAll(editor)
		expect(editor.pageCount).toBe(layout.pages.length)

		for (let index = 0; index < layout.pages.length; index++) expect(editor.page(index)).toBe(layout.pages[index])

		editor.dispose()
	})

	it.skipIf(!existsSync(BROCHURE))(
		"lays a source out again from its own overlay once a pasted copy before it takes its source with another's",
		{ timeout: 120_000 },
		async () => {
			// A paste into a content control holding copies of blocks of two others (one cut short), as the paged
			// fuzz found it: the copy takes the second's source as it takes the first's.
			vi.stubEnv("FILEN_OFFICE_FUZZ", "1")
			vi.stubEnv("FILEN_OFFICE_FUZZ_STEPS", "11")
			vi.stubEnv("FILEN_OFFICE_FUZZ_OPS", "type,typeEnd,enter,delete,join,format,formatAll,undo,redo,cell,paste")

			const results: unknown[] = []

			await runJobs([["paged", BROCHURE, "20261122", "race", "final"]], 1, 110_000, job => {
				for (const line of job.lines) results.push(JSON.parse(line))
			})
			expect(results).toMatchObject([{ ok: true, steps: 11 }])
		}
	)

	it("merges overlays once input and saves are idle, a few parts per slice", async () => {
		const { editor, pkg, context } = await pagedEditor(longDocument(160))
		const session = editor.body.session
		const edits = editor.edits
		const parts = (): number => new Set([...edits.overlayRecords()].map(record => record.part)).size
		const saved = async (): Promise<string[]> =>
			savedDigest((await saveDocx({ pkg, context, sessions: editor.sessions })).bytes as Uint8Array)
		const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
		const typeAt = async (k: number): Promise<void> => {
			const target = paragraphs(session.state.doc, false, 8)[k]

			if (target === undefined) throw new Error("no paragraph")

			select(session, target.pos + 3)
			session.dispatch(session.state.tr.insertText(`typed ${String(k)} `))
			await editor.whenSettled()
		}

		edits.compaction = { ...edits.compaction, parts: 6, minimum: 3, quietMs: 200 }

		// Settled with a merge due: none starts while typing goes on (each edit's overlay a part of its own).
		for (let k = 0; k < 9; k++) await typeAt(k)

		const before = parts()

		expect(before).toBe([...edits.overlayRecords()].length)

		// Nor while a save holds it off.
		const release = edits.holdCompaction()

		await pause(500)
		expect(parts()).toBe(before)
		release()

		// Then merged, region after region.
		await pause(800)
		await settleAll(editor)
		expect(parts()).toBeLessThan(before - 3)
		expect(pageDigest(editor.layout)).toEqual(await saved())

		// A merge takes the parts the slice's time allows, the minimum at least.
		for (let k = 20; k < 29; k++) await typeAt(k)

		const pages = new Map<number, [number, number]>()

		editor.layout.pages.forEach((page, index) => {
			for (let s = 0; s < page.sourceCount; s++) {
				const part = page.sourceParts[s] ?? -1
				const range = pages.get(part)

				if (range === undefined) pages.set(part, [index, index])
				else range[1] = index
			}
		})
		expect(edits.compact(pages, () => true)?.parts.size).toBe(3)
		// Laid out again by any run (not the merge's own): the old parts go once no page shows them.
		editor.layout.beginEdit(0, undefined)
		await settleAll(editor)
		expect(edits.retiredParts().size).toBe(0)
		expect(pageDigest(editor.layout)).toEqual(await saved())
		editor.dispose()
	})

	it("numbers the notes of paragraphs edited while overlays are merged as a fresh layout does", async () => {
		const { editor, pkg, context } = await pagedEditor(notedDocument())
		const session = editor.body.session
		const edits = editor.edits
		const noted = (k: number): { node: Node; pos: number } => {
			const found = paragraphs(session.state.doc, false, 8)[k]

			if (found === undefined) throw new Error("no paragraph")

			return found
		}
		const saved = async (): Promise<string[]> =>
			savedDigest((await saveDocx({ pkg, context, sessions: editor.sessions })).bytes as Uint8Array)

		edits.compaction = { ...edits.compaction, parts: 3, minimum: 2, quietMs: 0 }
		editor.setView(RevisionView.Markup)
		await settleAll(editor)
		editor.execute({ type: "review.track", on: true })

		for (let k = 0; k < 12; k++) {
			const target = noted(k % 6)

			select(session, target.pos + 3)

			// A paragraph with its note copied in now and then (a new note), typed into, undone and redone.
			if (k % 4 === 1) {
				const from = noted(8)

				session.dispatch(
					session.state.tr.replace(
						target.pos + 3,
						target.pos + 3,
						session.state.doc.slice(from.pos + 1, from.pos + from.node.nodeSize - 1)
					)
				)
			} else if (k % 4 === 3) {
				await editor.execute({ type: "history.undo" })
				await settleAll(editor)
				await editor.execute({ type: "history.redo" })
			} else session.dispatch(session.state.tr.insertText(`typed ${String(k)} `))

			if (k % 3 === 2) await settleAll(editor)
			else editor.layout.advance(0, -1)
		}

		await settleAll(editor)
		expect(pageDigest(editor.layout)).toEqual(await saved())
		editor.dispose()
	})

	it("leaves list items out of overlay merges, numbering them as a fresh layout does", async () => {
		const numbering =
			'<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
		const item = (k: number): string =>
			para(`item ${String(k)} ${words(30, k)}`, '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')
		const { editor, pkg, context } = await pagedEditor(
			buildDocx({
				body:
					Array.from({ length: 40 }, (_, k) => item(k) + para(`plain ${String(k)} ${words(30, k)}`)).join("") +
					`<w:sectPr>${PAGE}</w:sectPr>`,
				parts: [
					{
						name: "word/numbering.xml",
						contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
						data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${numbering}</w:numbering>`
					}
				],
				relationships: [{ id: "rIdN1", type: "numbering", target: "numbering.xml" }]
			})
		)
		const session = editor.body.session
		const edits = editor.edits
		const typeInto = async (prefix: string): Promise<void> => {
			for (let k = 0; k < 8; k++) {
				const found = paragraphs(session.state.doc, false, 1).find(entry =>
					entry.node.textContent.includes(`${prefix} ${String(k)} `)
				)

				if (found === undefined) throw new Error(`no ${prefix} ${String(k)}`)

				select(session, found.pos + 1)
				session.dispatch(session.state.tr.insertText(`typed ${String(k)} `))
				await settleAll(editor)
			}
		}
		const partsOf = (prefix: string): number =>
			new Set([...edits.overlayRecords()].filter(record => record.node.textContent.includes(`${prefix} `)).map(record => record.part))
				.size

		edits.compaction = { ...edits.compaction, parts: 3, minimum: 2, quietMs: 0 }
		await typeInto("plain")
		await typeInto("item")

		// The plain paragraphs merged, the items each in the part its edit wrote.
		expect(partsOf("plain")).toBeLessThan(8)
		expect(partsOf("item")).toBe(8)
		expect(pageDigest(editor.layout)).toEqual(
			await savedDigest((await saveDocx({ pkg, context, sessions: editor.sessions })).bytes as Uint8Array)
		)
		editor.dispose()
	})

	it("merges overlays past the cap while input never pauses, however far apart they show", async () => {
		const { editor, pkg, context } = await pagedEditor(longDocument(900))
		const session = editor.body.session
		const edits = editor.edits
		const parts = (): number => new Set([...edits.overlayRecords()].map(record => record.part)).size

		// Input is never idle long enough here: only the cap starts merges.
		edits.compaction = { ...edits.compaction, parts: 4, minimum: 3, quietMs: 3_600_000, cap: 5 }

		for (let k = 0; k < 6; k++) {
			const target = paragraphs(session.state.doc, false, 8)[k * 150]

			if (target === undefined) throw new Error("no paragraph")

			select(session, target.pos + 1)
			session.dispatch(session.state.tr.insertText(`typed ${String(k)} `))
			await settleAll(editor)
		}

		expect(editor.layout.pages.length).toBeGreaterThan(70)
		// Every two of them more than a region's pages apart.
		expect(parts()).toBeLessThan(5)
		expect(pageDigest(editor.layout)).toEqual(
			await savedDigest((await saveDocx({ pkg, context, sessions: editor.sessions })).bytes as Uint8Array)
		)
		editor.dispose()
	})

	it("writes nothing again for formatting over the whole document undone at once", async () => {
		const { editor, pkg, context } = await pagedEditor(longTableDocument(), 0)
		const session = editor.body.session
		const edits = editor.edits
		const parts = (): number => new Set([...edits.overlayRecords()].map(record => record.part)).size

		for (let k = 0; k < 5; k++) {
			const target = paragraphs(session.state.doc, true, 8)[k * 7]

			if (target === undefined) throw new Error("no paragraph")

			select(session, target.pos + 1)
			session.dispatch(session.state.tr.insertText(`typed ${String(k)} `))
			await settleAll(editor)
		}

		const before = parts()

		// Bold over everything, undone in the same task (the blocks not written in between).
		session.dispatch(session.state.tr.addMark(0, session.state.doc.content.size, docxSchema.marks.bold.create({ value: true })))
		expect(edits.pending()).toBe(true)
		void editor.execute({ type: "history.undo" })
		await settleAll(editor)

		// The edited blocks stand for the document's nodes again: no part written for them.
		expect(parts()).toBe(before)
		expect(pageDigest(editor.layout)).toEqual(
			await savedDigest((await saveDocx({ pkg, context, sessions: editor.sessions })).bytes as Uint8Array)
		)

		// Edited again from there: their records and positions are the document's.
		const again = paragraphs(session.state.doc, true, 8)[0]

		if (again === undefined) throw new Error("no paragraph")

		select(session, again.pos + 1)
		session.dispatch(session.state.tr.insertText("again "))
		await settleAll(editor)

		const caret = editor.caret()

		if (caret === undefined) throw new Error("no caret")

		expect(editor.hitTest(caret.page, caret.x, caret.top + caret.height / 2)?.pos).toBe(session.state.selection.head)
		expect(pageDigest(editor.layout)).toEqual(
			await savedDigest((await saveDocx({ pkg, context, sessions: editor.sessions })).bytes as Uint8Array)
		)
		editor.dispose()
	})

	it("finds the caret and hits in a row laid out from an overlay of its own", async () => {
		const { editor } = await pagedEditor(longTableDocument())
		const session = editor.body.session
		const at = (text: string): number => {
			const found = paragraphs(session.state.doc, true, 1).find(entry => entry.node.textContent.startsWith(text))

			if (found === undefined) throw new Error(`no ${text}`)

			return found.pos + 1 + text.length
		}

		select(session, at("row 150 "))
		await settleAll(editor)

		const page = editor.caret()?.page

		session.dispatch(session.state.tr.split(at("row 150 ")))
		session.dispatch(session.state.tr.insertText("split off "))
		await settleAll(editor)

		const caret = editor.caret()

		expect(caret?.page).toBe(page)

		// A click on the caret's place puts it there again.
		if (caret === undefined) throw new Error("no caret")

		const head = session.state.selection.head
		const hit = editor.hitTest(caret.page, caret.x, caret.top + caret.height / 2)

		expect(hit?.pos).toBe(head)
		editor.dispose()
	})

	it("inserts and deletes rows of a long table writing those rows alone", async () => {
		const edited = await editedLayout(longTableDocument())
		const cellAt = (text: string): number => {
			const found = paragraphs(edited.session.state.doc, true, 1).find(entry => entry.node.textContent.startsWith(text))

			if (found === undefined) throw new Error(`no ${text}`)

			return found.pos + 1 + text.length
		}

		select(edited.session, cellAt("row 120 "))
		expect(await edited.edit(session => session.execute({ type: "table.row.insertBelow" }))).toBe(true)

		const added = [...edited.edits.overlayRecords()]

		expect(added.map(record => record.node.type.name)).toEqual(["table_row"])
		await expectSaved(edited)

		// Typed into (the caret is in it), the new row's paragraph is laid out from an overlay over the row's own.
		expect(edited.session.state.selection.$from.parent.content.size).toBe(0)
		await edited.edit(edited.session.state.tr.insertText("new row text"))
		expect(
			[...edited.edits.overlayRecords()].some(
				record => record.node.type === docxSchema.nodes.paragraph && refPart(record.base) === added[0]?.part.index
			)
		).toBe(true)
		await expectSaved(edited)

		for (const text of ["row 121 ", "row 40 ", "row 200 "]) {
			select(edited.session, cellAt(text))
			expect(await edited.edit(session => session.execute({ type: "table.row.delete" }))).toBe(true)
			await expectSaved(edited)
		}

		expect([...edited.edits.overlayRecords()].some(record => record.node.type === docxSchema.nodes.table)).toBe(false)
		expect(edited.edits.rows.size).toBe(1)

		// Deleted with tracking, rows stay but the Final view leaves them out: the rows after them move up.
		edited.session.context.review.tracking = true
		edited.session.context.identity.author = "Reviewer"
		select(edited.session, cellAt("row 60 "), cellAt("row 90 "))
		expect(await edited.edit(session => session.execute({ type: "table.row.delete" }))).toBe(true)
		await expectSaved(edited)
	})

	it("lays out tracked row deletions in a long table whose rows were written again as the saved file", async () => {
		const edited = await editedLayout(longTableDocument())
		const cellAt = (text: string): number => {
			const found = paragraphs(edited.session.state.doc, true, 1).find(entry => entry.node.textContent.startsWith(text))

			if (found === undefined) throw new Error(`no ${text}`)

			return found.pos + 1 + text.length
		}

		for (const text of ["row 70 ", "row 150 "]) await edited.edit(edited.session.state.tr.split(cellAt(text)))

		edited.session.context.review.tracking = true
		edited.session.context.identity.author = "Reviewer"
		select(edited.session, cellAt("row 60 "), cellAt("row 90 "))
		expect(await edited.edit(session => session.execute({ type: "table.row.delete" }))).toBe(true)
		await expectSaved(edited)
		expect(await edited.edit(session => session.execute({ type: "history.undo" }))).toBe(true)
		await expectSaved(edited)
	})

	it("restarts at the edited row's page while an earlier edit's layout is under way", async () => {
		const { editor, pkg, context } = await pagedEditor(longTableDocument(), 0)
		const session = editor.body.session
		const layout = editor.layout
		const at = (text: string): number => {
			const found = paragraphs(session.state.doc, true, 1).find(entry => entry.node.textContent.startsWith(text))

			if (found === undefined) throw new Error(`no ${text}`)

			return found.pos + 1 + text.length
		}
		const restarts: number[] = []

		layout.subscribe(event => {
			if (!event.final && event.from === event.to) restarts.push(event.from)
		})

		select(session, at("row 230 "))

		const page = editor.caret()?.page ?? -1

		editor.setVisible(page, page)
		// Grown by lines, a row moves every page break after it: that layout runs on to the table's end. It
		// gets past the page in view.
		session.dispatch(session.state.tr.insertText(`${words(150, 4)} `, at("row 60 ")))

		while (layout.pages.length <= page + 1 && layout.advance(performance.now(), page + 1) === "more");

		expect(layout.final).toBe(false)
		restarts.length = 0
		session.dispatch(session.state.tr.insertText("x", at("row 230 ")))

		// Not the table's first page: the run under way had laid out the rows before the edited one.
		expect(restarts.length).toBeGreaterThan(0)
		expect(Math.min(...restarts)).toBeGreaterThan(page / 2)

		await settleAll(editor)

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		expect(pageDigest(layout)).toEqual(await savedDigest(saved.bytes as Uint8Array))
		editor.dispose()
	})

	it("lays out the pages in view for little more than the budget when the run is far behind them, the rest in slices", async () => {
		const loaded = await loadDocx(longTableDocument())
		let clock = 0
		// Every reading of the clock moves it on: time passes with work.
		const now = (): number => clock++
		const layout = layoutDocument(loaded.model, loaded.resolver, loaded.fonts, new HmtxMeasurer(), {
			store: loaded.store,
			sliceMs: Infinity,
			now
		})

		await layout.done

		const pages = layout.pages.length
		const fresh = pageDigest(layout)

		layout.beginEdit(0, undefined)

		expect(layout.advance(now() + 4, pages - 1)).toBe("more")
		expect(layout.pages.length).toBeLessThan(pages - 1)

		await finishLayout(layout)
		expect(pageDigest(layout)).toEqual(fresh)
	})

	it("lays out balanced columns and endnotes the same however it is sliced", async () => {
		const cell = (text: string): string => `<w:tc><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`
		const rows = Array.from(
			{ length: 30 },
			(_, r) => `<w:tr>${cell(`row ${r} ${words(6, r)}`)}${cell(words(3 + (r % 4), r))}</w:tr>`
		).join("")
		const bytes = buildDocx({
			body:
				`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${rows}</w:tbl>` +
				Array.from({ length: 60 }, (_, k) => para(`two columns ${k} ${words(12 + (k % 7), k)}`)).join("") +
				`<w:p><w:pPr><w:sectPr><w:cols w:num="2" w:space="400"/><w:type w:val="continuous"/>${PAGE}</w:sectPr></w:pPr><w:r><w:t>end of columns</w:t></w:r><w:r><w:endnoteReference w:id="1"/></w:r></w:p>` +
				Array.from({ length: 30 }, (_, k) => para(`one column ${k} ${words(20, k)}`)).join("") +
				`<w:sectPr><w:type w:val="continuous"/>${PAGE}</w:sectPr>`,
			endnotes:
				'<w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>' +
				`<w:endnote w:id="1"><w:p><w:r><w:endnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${words(60)}</w:t></w:r></w:p></w:endnote>`,
			settings: '<w:endnotePr><w:endnote w:id="-1"/></w:endnotePr>'
		})
		const fresh = pageDigest(await layOut(bytes))
		const loaded = await loadDocx(bytes)
		let clock = 0
		let yields = 0
		const layout = layoutDocument(loaded.model, loaded.resolver, loaded.fonts, new HmtxMeasurer(), {
			store: loaded.store,
			sliceMs: 2,
			now: () => clock++,
			yield: () => {
				yields++

				return Promise.resolve()
			}
		})

		await layout.done

		expect(yields).toBeGreaterThan(layout.pages.length * 2)
		expect(pageDigest(layout)).toEqual(fresh)
	})

	it("lays out a floating table too slow for one slice and settles", async () => {
		const cell = (text: string): string => `<w:tc><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`
		const rows = Array.from({ length: 12 }, (_, r) => `<w:tr>${cell(`float ${r} ${words(4, r)}`)}${cell(words(3, r))}</w:tr>`).join("")
		const bytes = buildDocx({
			body:
				para(words(30)) +
				'<w:tbl><w:tblPr><w:tblpPr w:leftFromText="180" w:rightFromText="180" w:vertAnchor="text" w:tblpY="200"/><w:tblW w:w="3000" w:type="dxa"/></w:tblPr>' +
				`<w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/></w:tblGrid>${rows}</w:tbl>` +
				Array.from({ length: 40 }, (_, k) => para(`around ${k} ${words(25, k)}`)).join("") +
				`<w:sectPr>${PAGE}</w:sectPr>`
		})
		const fresh = pageDigest(await layOut(bytes))
		const loaded = await loadDocx(bytes)
		let clock = 0
		let yields = 0
		// Every reading of the clock moves it on, so the floating table never fits in one slice; it is laid out
		// whole all the same (a slice ending in it would start it over every time).
		const layout = layoutDocument(loaded.model, loaded.resolver, loaded.fonts, new HmtxMeasurer(), {
			store: loaded.store,
			sliceMs: 2,
			now: () => clock++,
			yield: () => {
				if (++yields > 100_000) throw new Error("Layout does not settle")

				return Promise.resolve()
			}
		})

		await layout.done

		expect(pageDigest(layout)).toEqual(fresh)
	})

	it("stops floating a table once it is taller than its page can hold, wherever it is anchored", async () => {
		const cell = (text: string): string => `<w:tc><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`
		const rows = Array.from({ length: 600 }, (_, r) => `<w:tr>${cell(`row ${r} a`)}${cell(`row ${r} b`)}</w:tr>`).join("")
		const rowLayouts = vi.spyOn(TableLayout.prototype as unknown as { layoutRow: (...args: unknown[]) => unknown }, "layoutRow")

		for (const position of [
			'w:vertAnchor="text" w:tblpY="1"',
			'w:vertAnchor="page" w:tblpY="1440"',
			'w:vertAnchor="margin" w:tblpYSpec="bottom"'
		]) {
			const bytes = buildDocx({
				body:
					para("before the table one") +
					para("before two") +
					`<w:tbl><w:tblPr><w:tblpPr w:leftFromText="180" w:rightFromText="180" ${position}/><w:tblW w:w="4000" w:type="dxa"/></w:tblPr>` +
					`<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${rows}</w:tbl>` +
					para("after") +
					`<w:sectPr>${PAGE}</w:sectPr>`
			})
			const { editor, pkg, context } = await pagedEditor(bytes, 4)
			const session = editor.body.session

			await settleAll(editor)
			editor.setVisible(0, 1)
			select(session, 3)
			rowLayouts.mockClear()
			session.dispatch(session.state.tr.insertText("x"))
			await settleAll(editor)

			// Two attempts to float it (on its page, then the next) and the rows flowing on the pages laid out
			// again: none of them the whole table.
			expect(rowLayouts.mock.calls.length).toBeLessThan(300)

			const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

			expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved.bytes as Uint8Array))

			// Deliberately flowing as a table anchored to the text does: from the next page's top (the first holds
			// the paragraphs before it), its rows over the pages after, never drawn whole off its page.
			const digest = pageDigest(editor.layout)
			const first = digest.findIndex(page => page.includes("row 0 a"))
			const last = digest.findIndex(page => page.includes("row 599 a"))

			expect(digest[0]).toContain("before two")
			expect(first).toBe(1)
			expect(last).toBeGreaterThan(first + 5)
			editor.dispose()
		}

		rowLayouts.mockRestore()
	})

	it.skipIf(!existsSync(SUSPENSIONS))("opens a long document with floating tables and settles", { timeout: 120_000 }, async () => {
		const { editor } = await pagedEditor(readBytes(SUSPENSIONS))
		const layout = editor.layout
		let rounds = 0

		layout.beginEdit(0, undefined)

		// Sliced as a host slices it: it reaches the end in a bounded number of slices.
		while (layout.advance(performance.now() + 6, -1) !== "done") {
			if (++rounds > 50_000) throw new Error("Layout does not settle")

			await layout.prepareFonts()
		}

		expect(layout.final).toBe(true)
		editor.dispose()
	})

	it("reads edits' budgets on the clock an editor reads them on", async () => {
		const loaded = await loadDocx(longTableDocument())
		const layout = layoutDocument(loaded.model, loaded.resolver, loaded.fonts, new HmtxMeasurer(), {
			store: loaded.store,
			sliceMs: Infinity
		})

		await layout.done
		layout.beginEdit(0, undefined)

		// A deadline on performance.now (PagedEditor's clock) a second away: the pages asked for are laid out.
		layout.advance(performance.now() + 1000, 3)
		expect(layout.pages.length).toBeGreaterThan(3)
		await finishLayout(layout)
	})

	it("scans the stories for a switched view or field codes in the layout's slices, not in the switch", async () => {
		const bytes = notedDocument()
		const loaded = await loadDocx(bytes)
		let clock = 0
		// Every reading of the clock moves it on: a slice scans a story or two.
		const layout = layoutDocument(loaded.model, loaded.resolver, loaded.fonts, new HmtxMeasurer(), {
			store: loaded.store,
			sliceMs: 2,
			now: () => clock++,
			yield: () => Promise.resolve()
		})
		const boxes = vi.spyOn(Engine.prototype, "layoutBox")

		await layout.done

		for (const run of [() => layout.setView(RevisionView.Markup), () => layout.setFieldCodes({ all: true, toggled: undefined })]) {
			boxes.mockClear()
			run()
			expect(boxes).not.toHaveBeenCalled()
			expect(layout.advance(clock + 2, -1)).toBe("more")
			expect(boxes.mock.calls.length).toBeLessThan(5)
			await finishLayout(layout)
		}

		boxes.mockRestore()
		// Its notes have no fields: as a fresh layout in that view.
		expect(pageDigest(layout)).toEqual(pageDigest(await layOut(bytes, { view: RevisionView.Markup })))
	})

	it("yields between the rows of a page too slow for one slice and lays out the same pages", async () => {
		const loaded = await loadDocx(longTableDocument())
		const fresh = pageDigest(await layOut(longTableDocument()))
		let clock = 0
		let yields = 0
		const layout = layoutDocument(loaded.model, loaded.resolver, loaded.fonts, new HmtxMeasurer(), {
			store: loaded.store,
			sliceMs: 3,
			now: () => clock++,
			yield: () => {
				yields++

				return Promise.resolve()
			}
		})

		await layout.done

		expect(yields).toBeGreaterThan(layout.pages.length * 2)
		expect(pageDigest(layout)).toEqual(fresh)
	})

	it("lays out again a page whose page number changed when it opens inside a table", async () => {
		const cell = (text: string): string => `<w:tc><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`
		const rows = Array.from(
			{ length: 100 },
			(_, r) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(`row ${r}`)}${cell(words(4, r))}</w:tr>`
		).join("")
		const page =
			'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
		const edited = await editedLayout(
			buildDocx({
				body:
					Array.from({ length: 50 }, (_, k) => para(`intro ${k} ${words(8, k)}`)).join("") +
					para("start", "<w:pageBreakBefore/>") +
					`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>${rows}</w:tbl>` +
					`<w:p><w:r><w:t xml:space="preserve">after on page </w:t></w:r>${page}</w:p>` +
					Array.from({ length: 90 }, (_, k) => para(`tail ${k} ${words(8, k)}`)).join("") +
					`<w:sectPr>${PAGE}</w:sectPr>`
			})
		)
		let from = -1
		let to = -1

		edited.session.state.doc.forEach((node, offset) => {
			if (node.type !== docxSchema.nodes.paragraph || !node.textContent.startsWith("intro")) return

			if (from < 0) from = offset
			to = offset + node.nodeSize
		})

		// A page less before the table: the page after it, opening inside the table, is kept with its old number
		// until refreshed, which lays it out again (meeting the earlier layout only after it).
		await edited.edit(edited.session.state.tr.delete(from, to))
		await expectSaved(edited)
	})

	it("refreshes page numbers through a long table page by page, not from the table's start each time", async () => {
		const page =
			'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
		const cell = (inner: string): string => `<w:tc><w:p>${inner}</w:p></w:tc>`
		const rows = Array.from(
			{ length: 1500 },
			(_, r) =>
				`<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(`<w:r><w:t xml:space="preserve">row ${r} </w:t></w:r>${r % 20 === 7 ? page : ""}`)}${cell(`<w:r><w:t>${words(4, r)}</w:t></w:r>`)}</w:tr>`
		).join("")
		const edited = await editedLayout(
			buildDocx({
				body:
					Array.from({ length: 50 }, (_, k) => para(`intro ${k} ${words(8, k)}`)).join("") +
					para("start", "<w:pageBreakBefore/>") +
					`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>${rows}</w:tbl>` +
					`<w:sectPr>${PAGE}</w:sectPr>`
			})
		)
		const pages = edited.layout.pages.length
		let laid = 0

		expect(pages).toBeGreaterThan(20)
		edited.layout.subscribe(event => {
			if (!event.final) laid += event.to - event.from
		})

		let from = -1
		let to = -1

		edited.session.state.doc.forEach((node, offset) => {
			if (node.type !== docxSchema.nodes.paragraph || !node.textContent.startsWith("intro")) return

			if (from < 0) from = offset
			to = offset + node.nodeSize
		})

		// A page less before the table: every page showing a page number in it is laid out again once.
		await edited.edit(edited.session.state.tr.delete(from, to))

		expect(laid).toBeLessThan(pages * 4)
		expect([...edited.layout.stale]).toEqual([])
		await expectSaved(edited)
	})

	it("numbers pages in footnotes anew when an edit moves them to other pages", async () => {
		const page =
			'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
		const run = (text: string): string => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
		const notes = Array.from(
			{ length: 40 },
			(_, k) =>
				`<w:footnote w:id="${String(k + 1)}"><w:p><w:r><w:footnoteRef/></w:r>${run(` note ${String(k + 1)} `)}${k % 5 === 4 ? `${page}${run(" x")}` : run(words(6, k))}</w:p></w:footnote>`
		).join("")
		const body =
			Array.from({ length: 60 }, (_, k) => para(`intro ${String(k)} ${words(30, k)}`)).join("") +
			Array.from(
				{ length: 40 },
				(_, k) =>
					`<w:p>${k === 0 ? "<w:pPr><w:pageBreakBefore/></w:pPr>" : ""}${run(`noted ${String(k + 1)} ${words(40, k)} `)}<w:r><w:footnoteReference w:id="${String(k + 1)}"/></w:r></w:p>`
			).join("") +
			`<w:sectPr>${PAGE}</w:sectPr>`
		const edited = await editedLayout(
			buildDocx({
				body,
				footnotes:
					'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
					notes,
				settings: '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>'
			})
		)
		let from = -1
		let to = -1

		edited.session.state.doc.forEach((node, offset) => {
			if (!node.textContent.startsWith("intro")) return

			if (from < 0) from = offset
			to = offset + node.nodeSize
		})

		// The pages after the edit are kept, a page earlier: the notes on them show their new page numbers.
		await edited.edit(edited.session.state.tr.delete(from, to))
		await expectSaved(edited)
	})

	it("numbers notes per page as a layout from the start did when layout restarts at any page", async () => {
		const run = (text: string): string => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
		const notes: string[] = []
		const reference = (k: number): string => {
			const id = String(notes.length + 1)

			notes.push(
				`<w:footnote w:id="${id}"><w:p><w:r><w:footnoteRef/></w:r>${run(` note ${id} ${words(k % 4 === 0 ? 60 : 8, k)}`)}</w:p></w:footnote>`
			)

			return `<w:r><w:footnoteReference w:id="${id}"/></w:r>`
		}
		const body =
			Array.from(
				{ length: 50 },
				(_, k) =>
					`<w:p>${run(`para ${String(k)} ${words(30, k)} `)}${reference(k)}${run(` ${words(10, k)} `)}${reference(k + 1)}</w:p>`
			).join("") +
			`<w:sectPr><w:footnotePr><w:numFmt w:val="lowerRoman"/><w:numStart w:val="2"/><w:numRestart w:val="eachPage"/></w:footnotePr>${PAGE}</w:sectPr>`
		const { editor } = await pagedEditor(
			buildDocx({
				body,
				footnotes:
					'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
					notes.join(""),
				settings: '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>'
			})
		)
		const layout = editor.layout
		const first = pageDigest(layout)

		// A paragraph built on a page and left for the next keeps the numbers it was built with.
		for (let page = 1; page < layout.pages.length; page++) {
			layout.beginEdit(page, undefined)
			await finishLayout(layout)

			expect(pageDigest(layout)).toEqual(first)
		}

		editor.dispose()
	})

	it("settles page counts in the body on the count a fresh layout settles on", async () => {
		// NUMPAGES in two-column table cells: 9 pages show "9" and 10 pages "10", both consistent.
		const edited = await editedLayout(readBytes(`${FIXTURES}two-page-counts.docx`))

		expect(edited.layout.pages.length).toBe(9)

		await edited.edit(edited.session.state.tr.insertText("lorem ipsum dolor sit amet ".repeat(120), 3))

		expect(edited.layout.pages.length).toBe(10)

		await edited.edit(s => s.execute({ type: "history.undo" }))

		expect(edited.layout.pages.length).toBe(9)
		await expectSaved(edited)
	})

	it("counts the page breaks Word recorded in deleted text as a fresh layout does when an edit settles page counts", async () => {
		const edited = await editedLayout(readBytes(`${FIXTURES}two-page-counts-deleted-breaks.docx`))

		expect(edited.layout.pages.length).toBe(10)

		await edited.edit(edited.session.state.tr.insertText("lorem ipsum dolor sit amet ".repeat(120), 3))
		await edited.edit(s => s.execute({ type: "history.undo" }))

		expect(edited.layout.pages.length).toBe(10)
		await expectSaved(edited)
	})

	it("settles page counts in the body on the count a fresh layout settles on after edits while suspended", async () => {
		const { editor, pkg, context } = await pagedEditor(readBytes(`${FIXTURES}two-page-counts.docx`))
		const session = editor.body.session

		expect(editor.layout.pages.length).toBe(9)

		editor.suspend()
		session.dispatch(session.state.tr.insertText("lorem ipsum dolor sit amet ".repeat(120), 3))
		editor.resume()
		await settleAll(editor)

		expect(editor.layout.pages.length).toBe(10)

		editor.suspend()
		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		editor.resume()
		await settleAll(editor)

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		expect(editor.layout.pages.length).toBe(9)
		expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved.bytes as Uint8Array))
		editor.dispose()
	})

	it("takes a story's keystrokes while suspended as one change of its view, whatever their number", async () => {
		const { editor, pkg, context } = await pagedEditor(longTableDocument(), 4)
		const session = editor.body.session
		const cell = paragraphs(session.state.doc, true, 1).find(entry => entry.node.textContent.startsWith("row 120 "))

		if (cell === undefined) throw new Error("no row 120")

		await settleAll(editor)
		editor.suspend()
		select(session, cell.pos + 1)

		const changes = vi.spyOn(StoryEdits.prototype as unknown as { change: (...args: unknown[]) => unknown }, "change")

		// Past the most applies left waiting: none written while typing, every one once on resume.
		for (let k = 0; k < 450; k++) session.dispatch(session.state.tr.insertText("x"))
		expect(changes).not.toHaveBeenCalled()
		editor.resume()
		expect(changes).toHaveBeenCalledTimes(1)
		changes.mockRestore()
		await settleAll(editor)

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved.bytes as Uint8Array))
		editor.dispose()
	})

	it("counts the list paragraphs of an edited paragraph's text box once when layout restarts at the page it moved to", async () => {
		const ns =
			'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
			'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
			'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"'
		const numbered = (text: string): string =>
			`<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const box =
			'<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">' +
			'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
			'<wp:extent cx="2743200" cy="914400"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="3" name="Text Box 3"/><wp:cNvGraphicFramePr/>' +
			'<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>' +
			`<wps:txbx><w:txbxContent>${numbered("boxed a")}${numbered("boxed b")}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`
		const items = (from: number, count: number): string =>
			Array.from({ length: count }, (_, k) => numbered(`item ${String(from + k)}`)).join("")
		const { editor, pkg, context } = await pagedEditor(
			buildDocx({
				// The box's paragraph is built on the first page, does not fit and opens the second.
				document: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${items(0, 48)}<w:p><w:pPr><w:keepLines/></w:pPr>${box}<w:r><w:t xml:space="preserve">holds the box ${words(150)}</w:t></w:r></w:p>${items(48, 10)}<w:sectPr>${PAGE}</w:sectPr></w:body></w:document>`,
				parts: [
					{
						name: "word/numbering.xml",
						contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
						data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'
					}
				],
				relationships: [{ id: "rIdN1", type: "numbering", target: "numbering.xml" }]
			})
		)
		const body = editor.body.session
		// The end of the body paragraph holding `text`.
		const find = (text: string): number => {
			let at = -1

			body.state.doc.forEach((node, offset) => {
				if (at < 0 && node.textContent.includes(text)) at = offset + node.nodeSize - 1
			})

			if (at < 0) throw new Error(text)

			return at
		}

		expect(editor.layout.pages.length).toBe(2)

		// The box's paragraph split (laid out from an overlay), then an edit after it on its page.
		body.dispatch(body.state.tr.split(find("holds the box") - 3))
		await settleAll(editor)
		body.dispatch(body.state.tr.insertText("y", find("item 52")))
		await settleAll(editor)

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved.bytes as Uint8Array))
		editor.dispose()
	})

	it("numbers a list paragraph in an edited text box anew when the body's list changes before it", async () => {
		const ns =
			'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
			'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
			'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"'
		const numbered = (text: string): string =>
			`<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const box =
			'<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">' +
			'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
			'<wp:extent cx="2743200" cy="914400"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="3" name="Text Box 3"/><wp:cNvGraphicFramePr/>' +
			'<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>' +
			`<wps:txbx><w:txbxContent>${numbered("boxed")}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`
		const { editor, pkg, context } = await pagedEditor(
			buildDocx({
				document: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${numbered("one")}${numbered("two")}${numbered("three")}<w:p>${box}<w:r><w:t>holds the box</w:t></w:r></w:p><w:sectPr>${PAGE}</w:sectPr></w:body></w:document>`,
				parts: [
					{
						name: "word/numbering.xml",
						contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
						data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'
					}
				],
				relationships: [{ id: "rIdN1", type: "numbering", target: "numbering.xml" }]
			})
		)
		const story = editor.edits.model.stories.find(entry => entry?.kind === "textbox")

		if (story === undefined) throw new Error("no text box")

		// The box gains a list paragraph (laid out from an overlay, with no source), then an item before it goes.
		expect(editor.enterStory(story.index, 0)).toBe(true)
		editor.session.dispatch(editor.session.state.tr.split(3))
		editor.exitStory()

		const body = editor.body.session
		const second = body.state.doc.child(0).nodeSize

		body.dispatch(body.state.tr.delete(second, second + body.state.doc.child(1).nodeSize))
		await settleAll(editor)

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved.bytes as Uint8Array))
		editor.dispose()
	})

	it("never restarts layout at a page opening inside a split row (those states are only compared)", async () => {
		const cell = (text: string): string => `<w:tc><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`
		// Rows taller than a few lines, split across pages.
		const rows = Array.from(
			{ length: 60 },
			(_, r) => `<w:tr>${cell(`row ${String(r)} ${words(60 + (r % 4) * 30, r)}`)}${cell(words(5, r))}</w:tr>`
		).join("")
		const restore = vi.spyOn(BlockFlow.prototype, "restore")
		const edited = await editedLayout(
			buildDocx({
				body:
					para(words(40)) +
					`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="6000"/><w:gridCol w:w="3000"/></w:tblGrid>${rows}</w:tbl>` +
					para(words(30, 2)) +
					`<w:sectPr>${PAGE}</w:sectPr>`
			})
		)
		const snapshots = (edited.layout as unknown as { driver: { paginator: { snapshots: ({ flow: FlowSnapshot } | undefined)[] } } })
			.driver.paginator.snapshots

		expect(snapshots.some(snapshot => snapshot?.flow.table?.cells !== undefined)).toBe(true)

		for (const text of ["row 20 ", "row 35 ", "row 50 "]) {
			const found = paragraphs(edited.session.state.doc, true, 1).find(entry => entry.node.textContent.startsWith(text))

			if (found === undefined) throw new Error(`no ${text}`)

			await edited.edit(edited.session.state.tr.insertText(`${words(40, 3)} `, found.pos + 1 + text.length))
		}

		expect(restore.mock.calls.filter(([snapshot]) => snapshot.table?.cells !== undefined)).toEqual([])
		await expectSaved(edited)
	})

	it("settles section page counts in a long table after a section break before it", async () => {
		const field = (code: string): string =>
			`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>9</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`
		const cell = (inner: string): string => `<w:tc><w:p>${inner}</w:p></w:tc>`
		const rows = Array.from(
			{ length: 200 },
			(_, r) =>
				`<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(`<w:r><w:t xml:space="preserve">row ${String(r)} </w:t></w:r>${r % 20 === 7 ? `${field("SECTIONPAGES")}<w:r><w:t xml:space="preserve"> of </w:t></w:r>${field("NUMPAGES")}` : ""}`)}${cell(`<w:r><w:t>${words(4, r)}</w:t></w:r>`)}</w:tr>`
		).join("")
		const { editor, pkg, context } = await pagedEditor(
			buildDocx({
				body:
					Array.from({ length: 12 }, (_, k) => para(`intro ${String(k)} ${words(30, k)}`)).join("") +
					`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>${rows}</w:tbl>` +
					para("end") +
					`<w:sectPr>${PAGE}</w:sectPr>`
			})
		)
		const session = editor.body.session

		// A new section from the fifth paragraph on: its page count was never estimated.
		session.dispatch(
			session.state.tr.setSelection(TextSelection.create(session.state.doc, session.state.doc.child(0).nodeSize * 4 + 3))
		)
		expect(await editor.execute({ type: "insert.sectionBreak", kind: "nextPage" })).toBe(true)
		await settleAll(editor)

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved.bytes as Uint8Array))
		editor.dispose()
	})

	it("shows a footnote left for the next page with the number its reference has now", async () => {
		const { editor, pkg, context } = await pagedEditor(readBytes(`${FIXTURES}notes-each-page.docx`))
		const session = editor.body.session
		const at = (prefix: string): void => {
			const found = paragraphs(session.state.doc, false).find(p => p.node.textContent.startsWith(prefix))

			if (found === undefined) throw new Error(prefix)

			select(session, found.pos + 2)
		}

		at("noted 3 ")
		expect(
			await editor.execute({ type: "note.options", kind: "footnote", scope: "document", format: "chicago", restart: "eachPage" })
		).toBe(true)
		await settleAll(editor)

		// A note on the page before now: the one its page could not hold shows its reference's new number.
		at("noted 21 ")
		expect(await editor.execute({ type: "note.insertFootnote" })).toBe(true)
		await settleAll(editor)

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved.bytes as Uint8Array))
		editor.dispose()
	})

	it("lays out a keystroke in a long document showing its page count in the body as one without", async () => {
		const numPages =
			'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>9</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
		const edited = await editedLayout(
			buildDocx({
				body:
					`<w:p><w:r><w:t xml:space="preserve">Pages: </w:t></w:r>${numPages}</w:p>` +
					Array.from({ length: 400 }, (_, k) => para(`paragraph ${String(k)} ${words(40, k)}`)).join("") +
					`<w:sectPr>${PAGE}</w:sectPr>`
			})
		)
		const pages = edited.layout.pages.length
		let laid = 0

		expect(pages).toBeGreaterThan(20)
		edited.layout.subscribe(event => {
			if (!event.final) laid += event.to - event.from
		})

		// The page count stays: the keystroke lays out its page, not the document from its first page.
		const target = paragraphs(edited.session.state.doc, false)[300]

		if (target === undefined) throw new Error("no paragraph")

		await edited.edit(edited.session.state.tr.insertText("x", target.pos + 3))

		expect(edited.layout.pages.length).toBe(pages)
		expect(laid).toBeLessThan(4)
		await expectSaved(edited)
	})

	it("writes the blocks one edit changes into one overlay part", async () => {
		const edited = await editedLayout(longDocument(60))
		const session = edited.session

		select(session, 1, session.state.doc.content.size - 1)
		await edited.edit(s => s.execute({ type: "format.bold" }))

		const records = [...edited.edits.overlayRecords()]

		expect(records.length).toBeGreaterThan(40)
		expect(new Set(records.map(record => record.part)).size).toBe(1)
		await expectSaved(edited)

		// Typing in one of them gives it a part of its own; the others stay.
		const target = paragraphs(session.state.doc, false)[10]

		if (target === undefined) throw new Error("no paragraph")

		await edited.edit(session.state.tr.insertText("x", target.pos + 2))
		expect(new Set([...edited.edits.overlayRecords()].map(record => record.part)).size).toBe(2)
		await expectSaved(edited)
	})

	it("undoes back to the source and keeps every page as laid out before", async () => {
		const edited = await editedLayout(longDocument(60))
		const before = pageDigest(edited.layout)
		const target = paragraphs(edited.session.state.doc, false)[12]

		if (target === undefined) throw new Error("no paragraph")

		await edited.edit(edited.session.state.tr.insertText("inserted words that wrap ", target.pos + 3))
		await edited.edit(edited.session.state.tr.split(target.pos + 10))
		await edited.edit(session => session.execute({ type: "history.undo" }))
		await edited.edit(session => session.execute({ type: "history.undo" }))

		expect(pageDigest(edited.layout)).toEqual(before)
	})

	it("lays table paragraphs out from their source again when a paragraph command over them is undone", async () => {
		const edited = await editedLayout(longDocument(60))
		const session = edited.session
		const before = pageDigest(edited.layout)

		select(session, 1, session.state.doc.content.size - 1)
		await edited.edit(s => s.execute({ type: "align.center" }))
		expect([...edited.edits.overlayRecords()].length).toBeGreaterThan(40)
		await edited.edit(s => s.execute({ type: "history.undo" }))

		// No overlay left: every paragraph, those in table cells too, is its source again.
		expect([...edited.edits.overlayRecords()]).toEqual([])
		expect(pageDigest(edited.layout)).toEqual(before)
		await expectSaved(edited)
	})

	it("keeps later pages when an edit adds a page before a page break, renumbered", async () => {
		const field = (instruction: string): string =>
			`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`
		const p = (text: string, pPr = ""): string =>
			`<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		// Chapters of three short paragraphs, each starting on a new page.
		const body =
			Array.from({ length: 24 }, (_, chapter) =>
				[
					p(`Chapter ${chapter} ${words(10, chapter)}`, chapter === 0 ? "" : "<w:pageBreakBefore/>"),
					p(words(40, chapter)),
					p(words(40, chapter + 1))
				].join("")
			).join("") +
			'<w:sectPr><w:footerReference w:type="default" r:id="rIdF1"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		const edited = await editedLayout(
			buildDocx({
				body,
				footers: {
					rIdF1: `<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r>${field("PAGE")}<w:r><w:t xml:space="preserve"> of </w:t></w:r>${field("NUMPAGES")}</w:p>`
				}
			})
		)
		const pages = edited.layout.pages.length

		expect(pages).toBe(24)

		const target = paragraphs(edited.session.state.doc, false)[3 * 5 + 1]

		if (target === undefined) throw new Error("no paragraph")

		// Enough text to push the chapter onto a second page.
		await edited.edit(edited.session.state.tr.insertText(`${words(900, 3)} `, target.pos + 2))

		expect(edited.layout.pages.length).toBe(pages + 1)
		// Laid out up to the next chapter only; the rest was moved and renumbered.
		expect(edited.last.resyncedAt).toBeGreaterThan(edited.last.restart)
		expect(edited.last.resyncedAt).toBeLessThan(edited.last.restart + 4)
		await expectSaved(edited)
	})

	for (const name of ["01-plain.docx", "03-header-footer-footnotes.docx", "05-fields-toc.docx"]) {
		it(`lays out a scripted edit suite of ${name} like the saved file`, async () => {
			const edited = await editedLayout(readBytes(FIXTURES + name))
			const session = edited.session
			const pick = (index: number, inTables = false): { node: Node; pos: number } | undefined => {
				const list = paragraphs(session.state.doc, inTables)

				return list[Math.min(list.length - 1, index)]
			}
			const type = pick(0)

			if (type !== undefined) await edited.edit(session.state.tr.insertText("Filen ", type.pos + 1))

			const remove = pick(1)

			if (remove !== undefined) await edited.edit(session.state.tr.delete(remove.pos + 2, remove.pos + 5))

			const bold = pick(2)

			if (bold !== undefined) {
				select(session, bold.pos + 1, bold.pos + 5)
				await edited.edit(s => s.execute({ type: "format.bold" }))
			}

			const heading = pick(3)

			if (heading !== undefined) {
				select(session, heading.pos + 1)
				await edited.edit(s => s.execute({ type: "style.set", style: "heading2" }))
			}

			const list = pick(4)

			if (list !== undefined) {
				select(session, list.pos + 1)
				await edited.edit(s => s.execute({ type: "list.bullet" }))
			}

			const numbered = pick(6)

			if (numbered !== undefined) {
				select(session, numbered.pos + 1)
				await edited.edit(s => s.execute({ type: "list.numbered" }))
			}

			const quote = pick(7)

			if (quote !== undefined) {
				select(session, quote.pos + 1)
				await edited.edit(s => s.execute({ type: "style.set", style: "quote" }))
			}

			const linked = pick(8)

			if (linked !== undefined) {
				await edited.edit(
					session.state.tr.addMark(linked.pos + 1, linked.pos + 4, docxSchema.marks.link.create({ target: "https://filen.io/" }))
				)

				// The link is laid out as one (its target resolves) before it is saved.
				expect(
					edited.layout.pages.some(page =>
						page.sourceParts.some(part =>
							edited.edits.part(part)?.relationships.all.some(r => r.target === "https://filen.io/")
						)
					)
				).toBe(true)
			}

			const split = pick(5)

			if (split !== undefined) await edited.edit(session.state.tr.split(split.pos + 4))

			const cell = pick(0, true)

			if (cell !== undefined) await edited.edit(session.state.tr.insertText("cell ", cell.pos + 1))

			await expectSaved(edited)
		})
	}

	it("edits a header on every page that shows it and goes back to the body", async () => {
		const p = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const body =
			Array.from({ length: 140 }, (_, k) => p(`Paragraph ${k} ${words(40, k)}`)).join("") +
			'<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		const { editor, pkg, context } = await pagedEditor(buildDocx({ body, headers: { rIdH1: p("Report header") } }))
		const pages = editor.pageCount

		expect(pages).toBeGreaterThan(5)

		// The header shows above the body on page 3.
		const band = editor.bodyBand(3)
		const story = editor.storyAt(3, 300, (band?.top ?? 100) - 30)

		expect(story).toBeGreaterThanOrEqual(0)
		expect(editor.enterStory(story, 3)).toBe(true)
		expect(editor.activeStory).toBe(story)

		const hit = editor.hitTest(3, 400, (band?.top ?? 100) - 30)

		if (hit === undefined) throw new Error("no hit in the header")

		editor.select(hit)
		expect(editor.caret()?.page).toBe(3)
		editor.dispatch(editor.session.state.tr.insertText(" (draft)"))
		await settleAll(editor)

		// Every page shows the new header; the body is as it was.
		for (let index = 0; index < editor.pageCount; index++) {
			const page = editor.page(index)

			expect(page?.sourceTexts.some(text => text.includes("Report header (draft)"))).toBe(true)
		}

		expect(editor.pageCount).toBe(pages)

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		if (saved.bytes === undefined) throw new Error("no bytes")

		expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved.bytes))

		editor.exitStory()
		expect(editor.activeStory).toBe(editor.body.session.story.story.index)
	})

	it("counts fonts still loading as missing, so layout waits for them", async () => {
		let release = (): void => undefined
		const prepared: string[] = []
		const fonts = {
			prepare: (requests: Iterable<{ family: string }>) =>
				new Promise<void>(resolve => {
					for (const request of requests) prepared.push(request.family)

					release = resolve
				}),
			resolve: () => {
				throw new Error("not resolved here")
			}
		}
		const styles = new RunStyles(new StyleTable(new MeasureCache(harness().measurer)), fonts, new DecorationTable())
		const request = { family: "Lato", bold: false, italic: false, slot: "ascii" as const }
		const loading = styles.prepare([request])

		expect(styles.hasMissing).toBe(true)

		// Another wait for the same fonts waits for the load under way instead of passing at once.
		let done = false
		const waiting = styles.prepareMissing().then(() => {
			done = true
		})

		await Promise.resolve()
		expect(done).toBe(false)

		release()
		await loading
		await waiting
		expect(done).toBe(true)
		expect(styles.hasMissing).toBe(false)
		expect(prepared).toEqual(["Lato"])
	})

	it("meets the earlier layout again when an edit comes while another is still being laid out", async () => {
		const bytes = readBytes(`${FIXTURES}08-large-300p.docx`)
		const saveOf = async (editor: PagedEditor, pkg: DocxPackage, context: DocxEditContext): Promise<string[]> => {
			const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

			if (saved.bytes === undefined) throw new Error("no bytes")

			return savedDigest(saved.bytes)
		}

		for (const variant of ["delete", "paste", "paste, laid out"] as const) {
			// Edits lay out the pages in view in their own task, the rest later: nothing runs in between here.
			const { editor, pkg, context } = await pagedEditor(bytes, 0)
			const session = editor.session
			const onPage = (page: number): number => {
				const found = paragraphs(session.state.doc, false, 20).find(at => editor.geometry.locate(at.pos + 2, 1)?.page === page)

				if (found === undefined) throw new Error(`no paragraph on page ${String(page)}`)

				return found.pos + 2
			}

			editor.setVisible(20, 25)

			const from = onPage(20)

			if (variant === "delete") {
				editor.dispatch(session.state.tr.delete(from, onPage(23)))
			} else {
				editor.dispatch(session.state.tr.replace(from, from, session.state.doc.slice(onPage(40), onPage(43))))
			}

			if (variant === "paste, laid out") {
				// Laid out to the end, with later pages' page numbers not brought up to date yet (out of view).
				await finishLayout(editor.layout)

				expect(editor.layout.stale.size).toBeGreaterThan(0)
			} else {
				expect(editor.layout.final).toBe(false)
			}

			// Before that layout gets further (or its pages are brought up to date): an edit on an earlier page.
			editor.dispatch(session.state.tr.split(onPage(10)))
			await settleAll(editor)

			expect(pageDigest(editor.layout)).toEqual(await saveOf(editor, pkg, context))
			editor.dispose()
		}
	}, 60_000)

	it("renumbers pages of later sections up to one numbering its pages anew", async () => {
		const field =
			'<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		const p = (text: string, pPr = ""): string =>
			`<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const sectPr = (extra = ""): string =>
			`<w:sectPr><w:footerReference w:type="default" r:id="rIdF1"/>${extra}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`
		const section = (seed: number, extra?: string): string =>
			Array.from({ length: 12 }, (_, k) => p(words(60, seed + k), k % 4 === 0 && k > 0 ? "<w:pageBreakBefore/>" : "")).join("") +
			(extra === undefined ? "" : `<w:p><w:pPr>${sectPr(extra)}</w:pPr></w:p>`)
		const body = section(0, "") + section(20, "") + section(40, '<w:pgNumType w:start="1"/>') + section(60) + sectPr()
		const edited = await editedLayout(buildDocx({ body, footers: { rIdF1: field } }))
		const target = paragraphs(edited.session.state.doc, false)[2]

		if (target === undefined) throw new Error("no paragraph")

		// A page more in the first section: the second section's pages move on; the third numbers its pages anew,
		// so neither it nor the fourth moves.
		await edited.edit(edited.session.state.tr.insertText(`${words(900, 5)} `, target.pos + 2))
		expect(edited.last.resyncedAt).toBeGreaterThan(0)
		expect(edited.layout.pages.map(page => page.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6])
		await expectSaved(edited)
	})

	it("shows the chapter numbers a fresh layout shows after edits to the text and the chapter headings", async () => {
		const field = '<w:p><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>'
		const styles =
			'<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>'
		const numbering =
			'<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl></w:abstractNum>' +
			'<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
		const chapter = (seed: number): string =>
			para(`Chapter ${seed}`, '<w:pStyle w:val="Heading1"/>') +
			Array.from({ length: 10 }, (_, k) => para(words(60, seed + k))).join("")
		const body =
			chapter(0) +
			chapter(20) +
			chapter(40) +
			`<w:sectPr><w:footerReference w:type="default" r:id="rIdF1"/>${PAGE}<w:pgNumType w:chapStyle="1" w:chapSep="colon"/></w:sectPr>`
		const edited = await editedLayout(
			buildDocx({
				body,
				footers: { rIdF1: field },
				parts: [
					{
						name: "word/styles.xml",
						contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
						data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styles}</w:styles>`
					},
					{
						name: "word/numbering.xml",
						contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
						data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${numbering}</w:numbering>`
					}
				],
				relationships: [
					{ id: "rIdS", type: "styles", target: "styles.xml" },
					{ id: "rIdN", type: "numbering", target: "numbering.xml" }
				]
			})
		)
		const headings = (): { node: Node; pos: number }[] =>
			paragraphs(edited.session.state.doc, false, 1).filter(({ node }) => node.textContent.startsWith("Chapter"))

		expect(edited.layout.pages.some(page => page.numberText.startsWith("3:"))).toBe(true)

		// Text added in the second chapter: its pages and the third chapter's move on.
		const second = headings()[1]

		if (second === undefined) throw new Error("no heading")

		await edited.edit(edited.session.state.tr.insertText(`${words(400, 3)} `, second.pos + second.node.nodeSize + 1))
		await expectSaved(edited)

		// The first heading gone: every later page shows a chapter less.
		const first = headings()[0]

		if (first === undefined) throw new Error("no heading")

		await edited.edit(edited.session.state.tr.delete(first.pos, first.pos + first.node.nodeSize))
		expect(edited.layout.pages.some(page => page.numberText.startsWith("3:"))).toBe(false)
		await expectSaved(edited)
	})

	it("lets a shortened paragraph opening a page move back to the page before", async () => {
		const p = (text: string): string => `<w:p><w:pPr><w:widowControl/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const body =
			Array.from({ length: 60 }, (_, k) => p(words(20 + ((k * 13) % 7) * 6, k))).join("") +
			'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		const bytes = buildDocx({ body })
		// Paragraphs opening their page.
		const probe = await editedLayout(bytes)
		const pages = (index: number): readonly number[] => {
			const entry = probe.story.entries[index]

			return entry === undefined ? [] : probe.index.pagesOf(entry)
		}
		const opening = Array.from({ length: 59 }, (_, k) => k + 1).filter(
			block => pages(block)[0] !== undefined && pages(block)[0] !== pages(block - 1).at(-1)
		)

		expect(opening.length).toBeGreaterThanOrEqual(2)

		for (const block of opening.slice(0, 2)) {
			const edited = await editedLayout(bytes)
			const node = edited.session.state.doc.child(block)
			const start = edited.story.starts[block] ?? 0

			await edited.edit(edited.session.state.tr.delete(start + 1 + 10, start + node.nodeSize - 1))
			await expectSaved(edited)
		}
	}, 30_000)

	it("enters only the document's own stories, not those of overlays", async () => {
		const { editor } = await pagedEditor(longDocument(30))
		const own = editor.edits.storyCount
		const target = paragraphs(editor.session.state.doc, false)[3]

		if (target === undefined) throw new Error("no paragraph")

		editor.dispatch(editor.session.state.tr.insertText("typed ", target.pos + 2))
		await settleAll(editor)

		const stories = editor.edits.model.stories

		expect(stories.length).toBeGreaterThan(own)
		expect(stories[own]?.kind).toBe("body")
		expect(editor.enterStory(own, 0)).toBe(false)
		expect(editor.activeStory).toBe(editor.body.session.story.story.index)
		editor.dispose()
	})

	it("moves section boundaries with the section properties a split hands to the second half", async () => {
		const p = (text: string, pPr = ""): string =>
			`<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const geometry =
			'<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1134" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/>'
		const body =
			p(words(12, 1), `<w:sectPr><w:type w:val="continuous"/>${geometry}</w:sectPr>`) +
			p(words(8, 2)) +
			`<w:sectPr>${geometry}<w:pgNumType w:start="1"/></w:sectPr>`
		const edited = await editedLayout(buildDocx({ body }))
		const first = paragraphs(edited.session.state.doc, false)[0]

		if (first === undefined) throw new Error("no paragraph")

		// The split keeps the section properties with the second half.
		await edited.edit(edited.session.state.tr.split(first.pos + 20))
		await expectSaved(edited)

		const second = paragraphs(edited.session.state.doc, false)[2]

		if (second === undefined) throw new Error("no paragraph")

		select(edited.session, second.pos + 2)
		await edited.edit(session => session.execute({ type: "align.center" }))
		await expectSaved(edited)
	})

	it("keeps the numbers of a section numbering its pages anew where layout meets the earlier one", async () => {
		const p = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const field =
			'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		const sectPr = (extra = ""): string =>
			`<w:sectPr><w:footerReference w:type="default" r:id="rIdF1"/>${extra}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`
		const section = (seed: number): string => Array.from({ length: 12 }, (_, k) => p(words(60, seed + k))).join("")
		const body = section(0) + `<w:p><w:pPr>${sectPr()}</w:pPr></w:p>` + section(20) + sectPr('<w:pgNumType w:start="0"/>')
		const edited = await editedLayout(buildDocx({ body, footers: { rIdF1: field } }))
		const target = paragraphs(edited.session.state.doc, false)[2]

		if (target === undefined) throw new Error("no paragraph")

		// A page more in the first section; layout meets the earlier layout where the second section starts.
		await edited.edit(edited.session.state.tr.insertText(`${words(400, 5)} `, target.pos + 2))
		expect(edited.last.resyncedAt).toBeGreaterThan(0)
		expect(edited.layout.pages.at(-1)?.number).toBe(edited.layout.pages.filter(page => page.section === 1).length - 1)
		await expectSaved(edited)
	})

	it("counts lists a document gains anew whenever layout restarts before them", async () => {
		const p = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const body =
			Array.from({ length: 60 }, (_, k) => p(words(40, k))).join("") +
			'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		const edited = await editedLayout(buildDocx({ body }))

		// Layout restarts from snapshots taken before the document had lists.
		for (const index of [40, 41, 25]) {
			const at = paragraphs(edited.session.state.doc, false)[index]

			if (at === undefined) throw new Error("no paragraph")

			select(edited.session, at.pos + 2)
			await edited.edit(session => session.execute({ type: "list.numbered" }))
			await expectSaved(edited)
		}
	})

	it("lays out a header edited again while layout is still under way", async () => {
		const p = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const body =
			Array.from({ length: 140 }, (_, k) => p(`Paragraph ${String(k)} ${words(40, k)}`)).join("") +
			'<w:sectPr><w:headerReference w:type="first" r:id="rIdH0"/><w:headerReference w:type="default" r:id="rIdH1"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:titlePg/></w:sectPr>'
		const { editor, pkg, context } = await pagedEditor(
			buildDocx({ body, headers: { rIdH0: p("Title page header"), rIdH1: p("Report header") } }),
			0
		)
		const band = editor.bodyBand(1)
		const story = editor.storyAt(1, 300, (band?.top ?? 100) - 30)

		editor.setVisible(1, 1)
		expect(editor.enterStory(story, 1)).toBe(true)

		// A longer header (from page 1 on) moves every body down: layout runs from page 1 on, in slices.
		const end = editor.session.state.doc.content.size - 1

		editor.dispatch(editor.session.state.tr.insertText(` ${words(60, 3)}`, end))
		expect(editor.layout.final).toBe(false)

		// Before it gets further, the header changes again.
		editor.dispatch(editor.session.state.tr.split(editor.session.state.doc.content.size - 1))
		editor.exitStory()
		await settleAll(editor)

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		if (saved.bytes === undefined) throw new Error("no bytes")

		expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved.bytes))
		editor.dispose()
	}, 30_000)

	it("draws line numbers in their own font even when nothing else uses it", async () => {
		const cambria = '<w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/></w:rPr>'
		const body =
			Array.from({ length: 3 }, (_, k) => `<w:p><w:pPr>${cambria}</w:pPr><w:r>${cambria}<w:t>${words(10, k)}</w:t></w:r></w:p>`).join(
				""
			) +
			'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:lnNumType w:countBy="1"/></w:sectPr>'
		const digest = await savedDigest(buildDocx({ body }))
		const numbers = (digest[0] ?? "").split("\n").filter(line => / 6 "\d+" /.test(line))

		expect(numbers.length).toBe(3)
		expect(numbers.every(line => !line.includes(" null:"))).toBe(true)
	})

	it("lays a split row out the same whether fonts its nested table needs arrive during it or not", async () => {
		const run = (text: string, font?: string): string =>
			`<w:r><w:rPr>${font === undefined ? "" : `<w:rFonts w:ascii="${font}" w:hAnsi="${font}"/>`}<w:sz w:val="72"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`
		const cell = (inner: string): string => `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${inner}</w:tc>`
		const row = (...cells: string[]): string => `<w:tr>${cells.join("")}</w:tr>`
		const grid = '<w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>'
		// A nested table whose last row needs a font nothing before it uses, and runs over a page.
		const nested =
			`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${grid}` +
			row(cell(`<w:p>${run(words(12, 1))}</w:p>`), cell("<w:p/>")) +
			row(cell(`<w:p>${run(words(30, 2), "Courier New")}</w:p>`), cell("<w:p/>")) +
			"</w:tbl>"
		const body =
			`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${grid}` +
			row(cell(`<w:p>${run(words(30, 3))}</w:p>${nested}<w:p>${run(words(8, 4))}</w:p>`), cell(`<w:p>${run(words(4, 5))}</w:p>`)) +
			"</w:tbl><w:p/>" +
			'<w:sectPr><w:pgSz w:w="11906" w:h="8391"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		const layout = await layOut(buildDocx({ body }))
		const first = pageDigest(layout)

		expect(first.some(page => page.includes("fotest-cousine"))).toBe(true)

		// Laid out again with every font loaded: nothing is waited for this time.
		layout.beginEdit(0, undefined)
		await finishLayout(layout)
		expect(pageDigest(layout)).toEqual(first)
	})

	it("adds a section when a paragraph ending one is pasted", async () => {
		const p = (text: string, pPr = ""): string =>
			`<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const geometry =
			'<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
		const body =
			p(words(20, 1)) +
			p(words(20, 2), `<w:sectPr>${geometry}<w:titlePg/></w:sectPr>`) +
			Array.from({ length: 8 }, (_, k) => p(words(30, k + 3))).join("") +
			`<w:sectPr>${geometry}</w:sectPr>`
		const edited = await editedLayout(buildDocx({ body }))
		const doc = edited.session.state.doc
		const breakAt = paragraphs(doc, false)[1]
		const target = paragraphs(doc, false)[6]

		if (breakAt === undefined || target === undefined) throw new Error("no paragraph")

		// Text up to the start of the paragraph ending the first section, pasted inside a later paragraph: its end
		// takes that paragraph's properties, section break included (as pasting in Word does).
		const slice = doc.slice(breakAt.pos - 3, breakAt.pos + 4)

		await edited.edit(edited.session.state.tr.replace(target.pos + 3, target.pos + 3, slice))
		expect(edited.edits.model.sections.length).toBe(3)
		await expectSaved(edited)

		await edited.edit(session => session.execute({ type: "history.undo" }))
		expect(edited.edits.model.sections.length).toBe(2)
		await expectSaved(edited)
	})

	it("lays a pasted copy out as the save writes it: the first in the document has the source", async () => {
		// A paragraph whose mark is a tracked deletion: it joins the next one where the mark is written.
		const body =
			`<w:p><w:r><w:t xml:space="preserve">${words(12, 1)}</w:t></w:r></w:p>` +
			'<w:p><w:pPr><w:rPr><w:del w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">Joined with the next </w:t></w:r></w:p>' +
			Array.from({ length: 6 }, (_, k) => `<w:p><w:r><w:t xml:space="preserve">${words(30, k)}</w:t></w:r></w:p>`).join("") +
			'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		const edited = await editedLayout(buildDocx({ body }))
		const doc = edited.session.state.doc
		const [first, marked] = paragraphs(doc, false)

		if (first === undefined || marked === undefined) throw new Error("no paragraph")

		// Text up to the start of the marked paragraph, pasted into the paragraph before it: the paste ends with
		// a copy of the marked paragraph, now the first holding its source.
		const slice = doc.slice(marked.pos - 3, marked.pos + 4)

		await edited.edit(edited.session.state.tr.replace(first.pos + 5, first.pos + 5, slice))
		await expectSaved(edited)

		// The copy removed again: the original has its source back.
		await edited.edit(session => session.execute({ type: "history.undo" }))
		await expectSaved(edited)
	})

	it("gives a source to one half of a paragraph split inside a content control", async () => {
		const body =
			'<w:sdt><w:sdtPr><w:id w:val="7"/></w:sdtPr><w:sdtContent>' +
			`<w:p><w:r><w:t xml:space="preserve">${words(40, 1)}</w:t></w:r></w:p>` +
			"</w:sdtContent></w:sdt>" +
			Array.from({ length: 6 }, (_, k) => `<w:p><w:r><w:t xml:space="preserve">${words(30, k)}</w:t></w:r></w:p>`).join("") +
			'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		const edited = await editedLayout(buildDocx({ body }))
		const inside = paragraphs(edited.session.state.doc, false)[0]

		if (inside === undefined) throw new Error("no paragraph")

		await edited.edit(edited.session.state.tr.split(inside.pos + 30))
		await expectSaved(edited)
	})

	it("lays out a table an edit moves and changes as it now reads", async () => {
		const p = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const table =
			'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
			`<w:tr><w:tc>${p(words(6, 1))}</w:tc><w:tc>${p(words(6, 2))}</w:tc></w:tr></w:tbl>`
		const body =
			p(words(20, 3)) +
			p(words(20, 4)) +
			table +
			p(words(20, 5)) +
			'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		const edited = await editedLayout(buildDocx({ body }))
		const doc = edited.session.state.doc
		const second = paragraphs(doc, false)[1]
		const cell = paragraphs(doc, true, 4)[0]

		if (second === undefined || cell === undefined) throw new Error("no paragraph")

		// One edit removes the paragraph before the table and types in the table: the table moves up a block.
		const tr = edited.session.state.tr.insertText("typed ", cell.pos + 1)

		tr.delete(second.pos, second.pos + second.node.nodeSize)
		await edited.edit(tr)
		await expectSaved(edited)
	})

	it("lays pages out again rather than keep them on the other side when mirrored margins shift by a page", async () => {
		const p = (text: string, pPr = ""): string =>
			`<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const body =
			Array.from({ length: 6 }, (_, chapter) =>
				[p(`Chapter ${String(chapter)}`, chapter === 0 ? "" : "<w:pageBreakBefore/>"), p(words(40, chapter))].join("")
			).join("") +
			'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="4200" w:bottom="1440" w:left="1800" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		const edited = await editedLayout(buildDocx({ body, settings: "<w:mirrorMargins/>" }))
		const target = paragraphs(edited.session.state.doc, false)[1]

		if (target === undefined) throw new Error("no paragraph")

		// One page more before the later chapters: they now fall on pages of the other parity.
		await edited.edit(edited.session.state.tr.insertText(`${words(900, 2)} `, target.pos + 2))
		await expectSaved(edited)
	})

	it("lays out again the page a keep-with-next chain moved off when the chain changes", async () => {
		const p = (text: string, pPr = ""): string =>
			`<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const body =
			Array.from({ length: 53 }, (_, k) => p(words(14, k))).join("") +
			p("Kept with the next one", "<w:keepNext/>") +
			p(words(80, 3), "<w:keepLines/>") +
			p(words(30, 4)) +
			'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		const edited = await editedLayout(buildDocx({ body }))
		const kept = edited.story.entries[53]
		const next = paragraphs(edited.session.state.doc, false)[54]

		if (kept === undefined || next === undefined) throw new Error("no paragraph")

		// The chain did not fit the first page and starts the second; shortened, it fits the first.
		expect(edited.index.pagesOf(kept)).toEqual([1])
		expect(edited.layout.keepFrom(1)).toBe(0)
		await edited.edit(edited.session.state.tr.delete(next.pos + 10, next.pos + next.node.nodeSize - 1))
		await expectSaved(edited)
	})

	it("keeps blocks a paste adds in the section they are in when it also moves a source", async () => {
		const p = (text: string, pPr = ""): string =>
			`<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
		const geometry =
			'<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
		const body =
			p(words(20, 1), `<w:sectPr>${geometry}</w:sectPr>`) +
			Array.from({ length: 12 }, (_, k) => p(words(90, k + 2))).join("") +
			`<w:sectPr>${geometry}</w:sectPr>`
		const edited = await editedLayout(buildDocx({ body }))
		const doc = edited.session.state.doc
		const [, into, from] = paragraphs(doc, false)
		const copied = paragraphs(doc, false)[6]

		if (into === undefined || from === undefined || copied === undefined) throw new Error("no paragraph")

		// A paste of several paragraphs ending with a copy of a later one: the copy, now first, has its source.
		await edited.edit(edited.session.state.tr.replace(into.pos + 3, into.pos + 3, doc.slice(from.pos - 3, copied.pos + 4)))
		// Every block after the first section's break is in the second section (dirty blocks carry it).
		expect(edited.story.entries.slice(1).map(entry => entry.section)).toEqual(edited.story.entries.slice(1).map(() => 1))
		await expectSaved(edited)

		const later = paragraphs(edited.session.state.doc, false)[8]

		if (later === undefined) throw new Error("no paragraph")

		await edited.edit(edited.session.state.tr.insertText(`${words(60, 9)} `, later.pos + 2))
		await expectSaved(edited)
	})
	it("lays out again from the page a keep-with-next run moved off when a later page of the run changes", async () => {
		// The first page has no header; later ones a tall one, so less room than the first page has left.
		const header = Array.from({ length: 40 }, (_, k) => para(`Header line ${String(k)}`)).join("")
		const body =
			para(words(12, 1)) +
			para(words(150, 2), "<w:keepNext/>") +
			para(words(250, 3), "<w:keepNext/>") +
			para(words(600, 4), "<w:keepNext/>") +
			para(words(40, 5)) +
			Array.from({ length: 6 }, (_, k) => para(words(60, k + 6))).join("") +
			`<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/><w:headerReference w:type="first" r:id="rIdH2"/>${PAGE}<w:titlePg/></w:sectPr>`
		const edited = await editedLayout(buildDocx({ body, headers: { rIdH1: header, rIdH2: "<w:p/>" } }))
		const last = edited.story.entries[3]
		const target = paragraphs(edited.session.state.doc, false)[3]

		if (last === undefined || target === undefined) throw new Error("no paragraph")

		// The run moved off the first page and the last of it begins pages on, after a chain of its own moved too.
		const page = edited.index.pagesOf(last)[0] ?? -1

		expect(page).toBeGreaterThanOrEqual(3)
		expect(edited.layout.keepFrom(page)).toBe(0)

		// Shortened, the whole run fits the first page.
		await edited.edit(edited.session.state.tr.delete(target.pos + 10, target.pos + target.node.nodeSize - 1))

		const shortened = edited.story.entries[3]

		expect(shortened === undefined ? [] : edited.index.pagesOf(shortened)).toEqual([0])
		await expectSaved(edited)
	})

	it("restarts a keep-with-next document one page back, not from its first page", async () => {
		const body =
			Array.from(
				{ length: 300 },
				(_, k) => para(`Question ${String(k)}`, "<w:keepNext/>") + para(words(40 + ((k * 37) % 90), k), "<w:keepLines/>")
			).join("") + `<w:sectPr>${PAGE}</w:sectPr>`
		const edited = await editedLayout(buildDocx({ body }))
		const answers = paragraphs(edited.session.state.doc, false, 20)
		const target = answers[answers.length - 5]

		if (target === undefined) throw new Error("no paragraph")

		const entry = edited.story.entries[edited.story.entryAt(target.pos + 3)]
		const page = entry === undefined ? -1 : (edited.index.pagesOf(entry)[0] ?? -1)

		expect(page).toBeGreaterThan(20)
		await edited.edit(edited.session.state.tr.insertText("x", target.pos + 3))
		expect(edited.last.restart).toBeGreaterThanOrEqual(page - 2)
		await expectSaved(edited)
	})

	it("lays out a few pages per edit in a document that is one long keep-with-next run", async () => {
		const body =
			para(words(200, 1)) +
			Array.from({ length: 1200 }, (_, k) => para(words(30 + (k % 20), k), "<w:keepNext/>")).join("") +
			para(words(10, 2)) +
			`<w:sectPr>${PAGE}</w:sectPr>`
		const edited = await editedLayout(buildDocx({ body }))
		const pages = edited.layout.pages.length

		expect(pages).toBeGreaterThan(20)

		// The run moved off the first page, where the paragraph it ran out of room at decides that page's end.
		expect(edited.layout.keepFrom(1)).toBe(0)

		for (const at of [0.3, 0.6, 0.9]) {
			const all = paragraphs(edited.session.state.doc, false, 20)
			const target = all[Math.floor(all.length * at)]

			if (target === undefined) throw new Error("no paragraph")

			const entry = edited.story.entries[edited.story.entryAt(target.pos + 2)]
			const page = entry === undefined ? -1 : (edited.index.pagesOf(entry)[0] ?? -1)

			await edited.edit(edited.session.state.tr.insertText("x", target.pos + 2))
			expect(edited.last.restart).toBeGreaterThanOrEqual(page - 2)
			expect(edited.last.laidOut).toBeLessThanOrEqual(4)
		}

		await expectSaved(edited)
	})

	it("lays a joined paragraph out again from its first page when the paragraph whose mark it ends with changes", async () => {
		// The seventh paragraph's mark is a tracked deletion: it and the eighth lay out as one paragraph, recorded
		// under the seventh and formatted as the eighth, from the first page onto the second.
		const deleted = '<w:rPr><w:del w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:rPr>'
		const body =
			Array.from({ length: 6 }, (_, k) => para(words(60, k))).join("") +
			para(words(900, 7), deleted) +
			para(words(20, 8)) +
			para(words(20, 9)) +
			`<w:sectPr>${PAGE}</w:sectPr>`
		const edited = await editedLayout(buildDocx({ body }))
		const [joined, last, after] = edited.story.entries.slice(6)
		const all = paragraphs(edited.session.state.doc, false)
		const from = all[7]
		const to = all[8]

		if (joined === undefined || last === undefined || after === undefined || from === undefined || to === undefined)
			throw new Error("no paragraph")

		expect(edited.index.pagesOf(joined)).toEqual([0, 1])
		expect(edited.index.pagesOf(last)).toEqual([])
		expect(edited.index.pagesOf(after)).toEqual([1])

		// One command over the end of the joined paragraph and the one after it.
		select(edited.session, from.pos + 2, to.pos + 2)
		await edited.edit(session => session.execute({ type: "align.center" }))
		expect(edited.last.restart).toBe(0)
		await expectSaved(edited)
	})

	it("numbers pages right when an edit comes while a run laying out pages of the other parity is under way", async () => {
		// Chapters starting pages of their own: pages after an edit start where pages before it did.
		const body =
			Array.from(
				{ length: 30 },
				(_, chapter) =>
					para(`Chapter ${String(chapter)}`, chapter === 0 ? "" : "<w:pageBreakBefore/>") +
					para(words(150, chapter)) +
					para(words(120, chapter + 1))
			).join("") +
			'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="4200" w:bottom="1440" w:left="1800" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		const { editor, pkg, context } = await pagedEditor(buildDocx({ body, settings: "<w:mirrorMargins/>" }), 0)
		const session = editor.session
		const onPage = (page: number): number => {
			const found = paragraphs(session.state.doc, false, 20).find(at => editor.geometry.locate(at.pos + 2, 1)?.page === page)

			if (found === undefined) throw new Error(`no paragraph on page ${String(page)}`)

			return found.pos + 2
		}
		const pages = editor.layout.pages.length

		editor.setVisible(0, 1)
		// A page more from page 1 on: the pages after it are on the other side, so the run meets none of them.
		editor.dispatch(session.state.tr.insertText(`${words(560, 3)} `, onPage(1)))
		editor.layout.advance(-Infinity, 14)
		expect(editor.layout.final).toBe(false)

		// An edit on a page that run laid out again, before it gets further.
		editor.dispatch(session.state.tr.insertText("x", onPage(5)))
		await settleAll(editor)

		const numbers = editor.layout.pages.map(page => page.number)

		expect(numbers.length % 2).not.toBe(pages % 2)
		expect(numbers).toEqual(numbers.map((_, k) => k + 1))

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		if (saved.bytes === undefined) throw new Error("no bytes")

		expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved.bytes))
		editor.dispose()
	})

	it("shows the pages a run under way kept when an edit restarts it and meets them again", async () => {
		const body =
			Array.from(
				{ length: 20 },
				(_, chapter) => para(`Chapter ${String(chapter)}`, chapter === 0 ? "" : "<w:pageBreakBefore/>") + para(words(150, chapter))
			).join("") + `<w:sectPr>${PAGE}</w:sectPr>`
		const { editor } = await pagedEditor(buildDocx({ body }), 0)
		const session = editor.session
		const second = paragraphs(session.state.doc, false)[3]

		if (second === undefined) throw new Error("no paragraph")

		editor.setVisible(1, 1)
		// A page more in the second chapter: the run stops just before meeting the third chapter's page, one on.
		editor.dispatch(session.state.tr.insertText(`${words(900, 3)} `, second.pos + 2))
		editor.layout.advance(-Infinity, 2)
		expect(editor.layout.final).toBe(false)

		// Typed there again: that run meets the pages after first, keeping them a page on, and the new run meets
		// those again after the pages in view went out.
		editor.dispatch(session.state.tr.insertText("x", second.pos + 2))
		await settleAll(editor)

		expect(editor.layout.pages.length).toBe(21)
		expect(Array.from({ length: editor.pageCount }, (_, k) => editor.page(k))).toEqual(editor.layout.pages)
		editor.dispose()
	})

	it("numbers a note anew that the run meeting the earlier layout laid out last", async () => {
		const bytes = notedDocument()
		const { editor, pkg, context } = await pagedEditor(bytes)
		const session = editor.session
		const blocks = paragraphs(session.state.doc, false)
		const later = blocks[4]
		const first = blocks[1]

		if (later === undefined || first === undefined) throw new Error("no paragraph")

		// Laid out again to where it meets the earlier layout; then a note before goes: the notes after it are
		// numbered one less, those that run laid out last included.
		editor.dispatch(session.state.tr.insertText("x", later.pos + 2))
		await settleAll(editor)
		editor.dispatch(session.state.tr.delete(first.pos, first.pos + first.node.nodeSize))
		await settleAll(editor)

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		if (saved.bytes === undefined) throw new Error("no bytes")

		expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved.bytes))
		editor.dispose()
	})

	it("lays a note edited out as it now reads, though the run before laid it out without placing it", async () => {
		const bytes = notedDocument()
		const { editor, pkg, context } = await pagedEditor(bytes)
		const session = editor.session
		const later = paragraphs(session.state.doc, false)[4]
		const note = context.model.footnotes.get("11")

		if (later === undefined || note === undefined) throw new Error("no paragraph")

		// The run meets the earlier layout again after laying out a note it then left for the next page; that
		// note is edited.
		editor.dispatch(session.state.tr.insertText("x", later.pos + 2))
		await settleAll(editor)
		editor.enterStory(note.index, 0)
		editor.session.dispatch(editor.session.state.tr.insertText(`${words(60)} `, 3))
		editor.exitStory()
		await settleAll(editor)

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		if (saved.bytes === undefined) throw new Error("no bytes")

		expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved.bytes))
		editor.dispose()
	})

	it("lays pages drawn while a font loaded out again once, when the run under way meets the earlier layout first", async () => {
		const body =
			Array.from(
				{ length: 20 },
				(_, chapter) => para(`Chapter ${String(chapter)}`, chapter === 0 ? "" : "<w:pageBreakBefore/>") + para(words(150, chapter))
			).join("") + `<w:sectPr>${PAGE}</w:sectPr>`
		const { editor, pkg, context } = await pagedEditor(buildDocx({ body }), 0)
		const session = editor.session
		const second = paragraphs(session.state.doc, false)[3]

		if (second === undefined) throw new Error("no paragraph")

		editor.setVisible(1, 1)
		// A page more in the second chapter; the run stops between pages before meeting the third chapter's.
		editor.dispatch(session.state.tr.insertText(`${words(900, 3)} `, second.pos + 2))
		editor.layout.advance(-Infinity, 2)
		expect(editor.layout.final).toBe(false)

		// A page it laid out drew stand-ins for a font loading meanwhile (a header, note or split row): the run
		// lays out again from there, meeting the earlier layout where it stands first.
		const paginator = (editor.layout as unknown as { driver: { paginator: { missedFonts: number } } }).driver.paginator

		paginator.missedFonts = 1
		await settleAll(editor)

		const saved = await saveDocx({ pkg, context, sessions: editor.sessions })

		if (saved.bytes === undefined) throw new Error("no bytes")

		expect(pageDigest(editor.layout)).toEqual(await savedDigest(saved.bytes))
		editor.dispose()
	})

	it("ends the sections a content control holds after the blocks that end them", async () => {
		for (const inner of [
			para(words(20, 1), `<w:sectPr>${LANDSCAPE}</w:sectPr>`) + para(words(40, 2)),
			para(words(20, 1), `<w:sectPr>${LANDSCAPE}</w:sectPr>`) + para(words(20, 2), `<w:sectPr>${NARROW}</w:sectPr>`)
		]) {
			const body =
				control(inner) + Array.from({ length: 4 }, (_, k) => para(words(30, k + 3))).join("") + `<w:sectPr>${PAGE}</w:sectPr>`
			const edited = await editedLayout(buildDocx({ body }))
			const target = paragraphs(edited.session.state.doc, false)[4]

			if (target === undefined) throw new Error("no paragraph")

			// A split elsewhere: the layout reads the body's block list from now on.
			await edited.edit(edited.session.state.tr.split(target.pos + 5))
			await expectSaved(edited)
		}
	})

	it("lays a section out with the properties a pasted section break gives it, from the section's start", async () => {
		for (const type of ["", '<w:type w:val="continuous"/>', '<w:type w:val="oddPage"/>']) {
			const body =
				para(words(30, 1)) +
				para(words(20, 2), `<w:sectPr>${type}${PAGE}</w:sectPr>`) +
				Array.from({ length: 30 }, (_, k) => para(words(120, k + 3))).join("") +
				`<w:sectPr>${type}${NARROW}</w:sectPr>`
			const edited = await editedLayout(buildDocx({ body }))
			const doc = edited.session.state.doc
			const breakAt = paragraphs(doc, false)[1]
			const target = paragraphs(doc, false)[25]

			if (breakAt === undefined || target === undefined) throw new Error("no paragraph")

			// The second section's pages before the paste point take the first section's properties.
			await edited.edit(edited.session.state.tr.replace(target.pos + 3, target.pos + 3, doc.slice(breakAt.pos - 3, breakAt.pos + 4)))
			expect(edited.edits.model.sections.length).toBe(3)
			await expectSaved(edited)
		}
	})

	it("knows which section each block of a content control holding a section break is in", async () => {
		const body =
			control(
				para(words(300, 1)) +
					para(words(20, 2), `<w:sectPr>${LANDSCAPE}</w:sectPr>`) +
					Array.from({ length: 6 }, (_, k) => para(words(250, k + 3))).join("")
			) +
			para(words(100, 11)) +
			`<w:sectPr>${PAGE}</w:sectPr>`
		const edited = await editedLayout(buildDocx({ body }))
		const target = paragraphs(edited.session.state.doc, false)[5]

		if (target === undefined) throw new Error("no paragraph")

		// Text added in the second section, inside the control: layout meets the earlier pages only after it.
		await edited.edit(edited.session.state.tr.insertText(`${words(400, 4)} `, target.pos + 3))
		await expectSaved(edited)
	})

	it("puts a block added after a content control in the section after every one the control ends", async () => {
		const body =
			control(
				para(words(20, 1), `<w:sectPr>${LANDSCAPE}</w:sectPr>`) +
					Array.from({ length: 4 }, (_, k) => para(words(200, k + 2))).join("") +
					para(words(20, 6), `<w:sectPr>${NARROW}</w:sectPr>`)
			) +
			Array.from({ length: 3 }, (_, k) => para(words(60, k + 7))).join("") +
			`<w:sectPr>${PAGE}</w:sectPr>`
		const edited = await editedLayout(buildDocx({ body }))
		const at = edited.session.state.doc.child(0).nodeSize
		const added = docxSchema.nodes.paragraph.create(null, docxSchema.text(words(80, 9)))

		await edited.edit(edited.session.state.tr.insert(at, added))
		expect(edited.story.entries[1]?.section).toBe(2)
		await expectSaved(edited)
	})

	it("ends a body without section properties of its own as a document opened so ends it", async () => {
		// Ending with a section break: no section after it, whatever is typed in it.
		const ending =
			para(words(30, 1)) +
			para(words(20, 2), `<w:sectPr>${LANDSCAPE}</w:sectPr>`) +
			Array.from({ length: 4 }, (_, k) => para(words(120, k + 3))).join("")
		const edited = await editedLayout(buildDocx({ body: ending + para(words(20, 9), `<w:sectPr>${NARROW}</w:sectPr>`) }))
		const last = (): { node: Node; pos: number } => {
			const all = paragraphs(edited.session.state.doc, false)
			const found = all[all.length - 1]

			if (found === undefined) throw new Error("no paragraph")

			return found
		}

		await edited.edit(edited.session.state.tr.insertText("Typed ", last().pos + 2))
		expect(edited.edits.model.sections.length).toBe(2)
		await expectSaved(edited)

		// A paragraph after that break: a last section of default properties holds it.
		const after = last().pos + last().node.nodeSize

		await edited.edit(edited.session.state.tr.insert(after, docxSchema.nodes.paragraph.create(null, docxSchema.text(words(40, 3)))))
		expect(edited.edits.model.sections.length).toBe(3)
		await expectSaved(edited)

		// Removed again, and in a document opened with blocks after its last break.
		await edited.edit(session => session.execute({ type: "history.undo" }))
		expect(edited.edits.model.sections.length).toBe(2)
		await expectSaved(edited)

		const trailing = await editedLayout(
			buildDocx({ body: ending + para(words(20, 9), `<w:sectPr>${NARROW}</w:sectPr>`) + para(words(40, 3)) })
		)
		const end = trailing.session.state.doc.content.size
		const lastChild = trailing.session.state.doc.lastChild

		if (lastChild === null) throw new Error("no paragraph")

		await trailing.edit(trailing.session.state.tr.delete(end - lastChild.nodeSize, end))
		expect(trailing.edits.model.sections.length).toBe(2)
		await expectSaved(trailing)
	})

	it("keeps pages of mirrored margins that do not differ when an edit moves them to the other side", async () => {
		const body =
			Array.from({ length: 8 }, (_, chapter) =>
				[para(`Chapter ${String(chapter)}`, chapter === 0 ? "" : "<w:pageBreakBefore/>"), para(words(40, chapter))].join("")
			).join("") + `<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/>${PAGE}</w:sectPr>`

		for (const even of [false, true]) {
			// The even pages' header: the same as the others', or one of their own.
			const evenHeader = `<w:headerReference w:type="even" r:id="${even ? "rIdH2" : "rIdH1"}"/>`
			const edited = await editedLayout(
				buildDocx({
					body: body.replace("<w:sectPr>", `<w:sectPr>${evenHeader}`),
					headers: { rIdH1: para("Header"), rIdH2: para("Even header") },
					settings: "<w:evenAndOddHeaders/><w:mirrorMargins/>"
				})
			)
			const target = paragraphs(edited.session.state.doc, false)[1]

			if (target === undefined) throw new Error("no paragraph")

			// One page more before the later chapters: equal margins and the same header look alike on either side.
			await edited.edit(edited.session.state.tr.insertText(`${words(1500, 2)} `, target.pos + 2))
			expect(edited.layout.pages.length).toBe(9)

			if (even) expect(edited.last.resyncedAt).toBe(-1)
			else expect(edited.last.resyncedAt).toBeGreaterThan(0)

			await expectSaved(edited)
		}
	})

	it("counts placements by the page's parity for the layout that made them only", async () => {
		// Chapters filling both columns of a page: a page stays open from one step to the next.
		const columns = `<w:sectPr>${PAGE}<w:cols w:num="2" w:space="720"/></w:sectPr>`
		const body =
			Array.from({ length: 8 }, (_, chapter) =>
				[para(`Chapter ${String(chapter)}`, chapter === 0 ? "" : "<w:pageBreakBefore/>"), para(words(700, chapter))].join("")
			).join("") + columns
		const edited = await editedLayout(buildDocx({ body }))
		// Another document placing a frame by the page's parity on every page.
		const other = await layOut(
			buildDocx({
				body:
					Array.from(
						{ length: 6 },
						(_, k) =>
							para(words(20, k), '<w:framePr w:w="2000" w:hAnchor="margin" w:xAlign="inside" w:y="200"/>') +
							para(words(200, k))
					).join("") + `<w:sectPr>${PAGE}</w:sectPr>`
			})
		)

		// Laid out again in steps, the other document laid out between them (pages stay open across steps).
		edited.layout.beginEdit(0, undefined)

		for (let round = 0; round < 10_000; round++) {
			const result = edited.layout.advance(-Infinity, 0)

			if (result === "done") break
			if (result === "fonts") await edited.layout.prepareFonts()

			other.beginEdit(0, undefined)
			await finishLayout(other)
		}

		const target = paragraphs(edited.session.state.doc, false)[1]

		if (target === undefined) throw new Error("no paragraph")

		// One page more: the later pages, on the other side now, are kept.
		await edited.edit(edited.session.state.tr.insertText(`${words(900, 2)} `, target.pos + 2))
		expect(edited.layout.pages.length).toBe(9)
		expect(edited.last.resyncedAt).toBeGreaterThan(0)
		await expectSaved(edited)
	})

	it("keeps one holder of a source as itself and more as a list", async () => {
		const edited = await editedLayout(longDocument(40))
		const holders = (edited.story as unknown as { holders: Map<number, unknown> }).holders
		const doc = edited.session.state.doc
		const [into, copied] = paragraphs(doc, false)

		if (into === undefined || copied === undefined) throw new Error("no paragraph")

		expect(holders.size).toBeGreaterThan(30)
		expect([...holders.values()].every(held => !Array.isArray(held) && !(held instanceof Set))).toBe(true)

		// A copy pasted: its source has two holders.
		await edited.edit(edited.session.state.tr.replace(into.pos + 3, into.pos + 3, doc.slice(copied.pos - 3, copied.pos + 4)))
		expect([...holders.values()].filter(held => Array.isArray(held) && held.length === 2).length).toBe(1)

		await edited.edit(session => session.execute({ type: "history.undo" }))
		expect([...holders.values()].every(held => !Array.isArray(held))).toBe(true)
		await expectSaved(edited)
	})

	it("writes no section break into a table cell but where the cell's paragraph had one", async () => {
		const cell = (inner: string): string => `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${inner}</w:tc>`
		// The second cell's paragraph carries a section break, which the model ignores there.
		const table =
			'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
			`<w:tr>${cell(para(words(12, 1)))}${cell(para(words(12, 2), `<w:sectPr>${NARROW}</w:sectPr>`))}</w:tr></w:tbl>`
		const body =
			para(words(30, 3)) +
			para(words(20, 4), `<w:sectPr>${LANDSCAPE}</w:sectPr>`) +
			table +
			Array.from({ length: 6 }, (_, k) => para(words(80, k + 5))).join("") +
			`<w:sectPr>${PAGE}</w:sectPr>`
		// Per cell, whether the saved file has a section break in it.
		const cellBreaks = (bytes: Uint8Array): boolean[] => {
			const xml = new TextDecoder().decode(unzipSync(bytes)["word/document.xml"])

			return [...xml.matchAll(/<w:tc>.*?<\/w:tc>/g)].map(match => match[0].includes("<w:sectPr"))
		}
		const edited = await editedLayout(buildDocx({ body }))
		const doc = edited.session.state.doc
		const breakAt = paragraphs(doc, false)[1]
		const first = paragraphs(doc, true)[0]

		if (breakAt === undefined || first === undefined) throw new Error("no paragraph")

		expect(cellBreaks(await edited.save())).toEqual([false, true])

		// Text up to the start of the paragraph ending the first section, pasted into the first cell: the cell's
		// paragraph takes that paragraph's mark, section break included, which is none there.
		await edited.edit(edited.session.state.tr.replace(first.pos + 3, first.pos + 3, doc.slice(breakAt.pos - 3, breakAt.pos + 4)))
		expect(paragraphs(edited.session.state.doc, true, 1).some(at => at.node.attrs["sectPr"] === breakAt.node.attrs["sectPr"])).toBe(
			true
		)

		const saved = await edited.save()

		expect(cellBreaks(saved)).toEqual([false, true])
		expect(edited.edits.model.sections.length).toBe(2)
		expect(pageDigest(edited.layout)).toEqual(await savedDigest(saved))
	})

	it("writes a section break copied unchanged before its source in or out of table cells as it was", async () => {
		const cell = (inner: string): string => `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${inner}</w:tc>`
		const table = (first = ""): string =>
			'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
			`<w:tr>${cell(para("cell one text") + first)}${cell(para("cell two text"))}</w:tr></w:tbl>`
		// Per cell, whether the saved file has a section break in it; and every section break in it.
		const breaks = (bytes: Uint8Array): { cells: boolean[]; all: number } => {
			const xml = new TextDecoder().decode(unzipSync(bytes)["word/document.xml"])

			return {
				cells: [...xml.matchAll(/<w:tc>.*?<\/w:tc>/g)].map(match => match[0].includes("<w:sectPr")),
				all: (xml.match(/<w:sectPr/g) ?? []).length
			}
		}
		const check = async (edited: EditedLayout, cells: boolean[], all: number): Promise<void> => {
			const saved = await edited.save()

			expect(breaks(saved)).toEqual({ cells, all })
			expect(pageDigest(edited.layout)).toEqual(await savedDigest(saved))
		}
		const sectionBreak = para("Break paragraph", `<w:sectPr>${LANDSCAPE}</w:sectPr>`)
		const cellEnd = (doc: Node): number => {
			const first = paragraphs(doc, true, 1)[0]

			if (first === undefined) throw new Error("no paragraph")

			return first.pos + first.node.nodeSize - 1
		}
		const breakParagraph = (doc: Node): { node: Node; pos: number } => {
			const found = paragraphs(doc, false, 1).find(at => (at.node.attrs["sectPr"] as number) >= 0)

			if (found === undefined) throw new Error("no section break")

			return found
		}

		// A section break paragraph copied, unchanged, to the end of a cell of an earlier table: it has the source
		// now and is still no section break there.
		const into = await editedLayout(
			buildDocx({
				body: table() + para(words(30, 1)) + sectionBreak + para(words(40, 2)) + `<w:sectPr>${PAGE}</w:sectPr>`
			})
		)
		const doc = into.session.state.doc
		const source = breakParagraph(doc)

		await into.edit(
			into.session.state.tr.replace(cellEnd(doc), cellEnd(doc), doc.slice(source.pos - 2, source.pos + source.node.nodeSize - 1))
		)
		await check(into, [false, false], 2)

		// A content control holding one, moved whole into a cell (the editor refuses that move; the writer still
		// must not copy the break into the cell): written without it there.
		const controlled = await editedLayout(
			buildDocx({ body: table() + para(words(30, 1)) + control(sectionBreak + para(words(20, 3))) + `<w:sectPr>${PAGE}</w:sectPr>` })
		)
		const doc2 = controlled.session.state.doc
		let at = -1

		doc2.forEach((node, offset) => {
			if (node.type === docxSchema.nodes.sdt) at = offset
		})

		const holder = doc2.nodeAt(at)

		if (holder === null) throw new Error("no content control")

		const writer = new StoryWriter(
			{
				context: controlled.context,
				nextRevisionId: () => 1,
				numId: id => id,
				hyperlink: () => {
					throw new Error("no hyperlink")
				}
			},
			controlled.session.story
		)
		const moved = new Transform(doc2).delete(at, at + holder.nodeSize).insert(cellEnd(doc2) + 1, holder).doc
		const written = new TextDecoder().decode(writer.writeStory(moved).bytes)

		expect([...written.matchAll(/<w:tc>.*?<\/w:tc>/g)].map(match => match[0].includes("<w:sectPr"))).toEqual([false, false])
		expect(written).toContain("Break paragraph")

		// A cell's paragraph holding one (which the model ignores there) copied to the top level before the table:
		// no section there either, in the save or in what it laid out from.
		const out = await editedLayout(
			buildDocx({
				body:
					para("P zero text") +
					table(para("cell Y with a break", `<w:sectPr>${LANDSCAPE}</w:sectPr>`)) +
					para(words(30, 1)) +
					`<w:sectPr>${PAGE}</w:sectPr>`
			})
		)
		const doc3 = out.session.state.doc
		const [zero] = paragraphs(doc3, false, 1)
		const [one, y] = paragraphs(doc3, true, 1)

		if (zero === undefined || one === undefined || y === undefined) throw new Error("no paragraph")

		const end = zero.pos + zero.node.nodeSize - 1

		await out.edit(out.session.state.tr.replace(end, end, doc3.slice(one.pos + one.node.nodeSize - 3, y.pos + y.node.nodeSize - 1)))
		expect(out.session.state.doc.child(1).attrs["sectPr"]).toBe(y.node.attrs["sectPr"])
		await check(out, [true, false], 2)

		for (const record of out.edits.overlayRecords()) {
			const document = record.part.document
			const node = record.part.node(record.item)

			expect(new TextDecoder().decode(document.bytes.subarray(document.start(node), document.end(node)))).not.toContain("sectPr")
		}
	})

	it("keeps pages across an odd page shift only when nothing on them depends on the page's parity", async () => {
		const header = (text: string, lines: number): string =>
			Array.from({ length: lines }, (_, k) => para(`${text} ${String(k)}`)).join("")
		const references =
			'<w:headerReference w:type="default" r:id="rIdH1"/><w:headerReference w:type="even" r:id="rIdH2"/><w:headerReference w:type="first" r:id="rIdH3"/>'

		for (const variant of ["evenAndOdd", "titlePg", "oddPage", "evenPage"]) {
			const sections = variant === "oddPage" || variant === "evenPage"
			const type = sections ? `<w:type w:val="${variant}"/>` : ""
			const sectPr = `<w:sectPr>${references}${type}${PAGE}${variant === "titlePg" ? "<w:titlePg/>" : ""}</w:sectPr>`
			// Chapters starting pages of their own, pages after an edit starting where pages before it did; for odd
			// and even page sections, a section every three chapters.
			const body =
				Array.from(
					{ length: 8 },
					(_, chapter) =>
						para(`Chapter ${String(chapter)}`, chapter === 0 || (sections && chapter % 3 === 0) ? "" : "<w:pageBreakBefore/>") +
						para(words(120, chapter), sections && chapter % 3 === 2 ? sectPr : "")
				).join("") + sectPr
			const edited = await editedLayout(
				buildDocx({
					body,
					headers: { rIdH1: header("Odd header", 1), rIdH2: header("Even header", 6), rIdH3: header("First header", 3) },
					settings: sections ? "" : "<w:evenAndOddHeaders/>"
				})
			)
			const target = paragraphs(edited.session.state.doc, false)[1]

			if (target === undefined) throw new Error("no paragraph")

			// A page more in the first chapter: later pages are on the other side.
			await edited.edit(edited.session.state.tr.insertText(`${words(1500, 1)} `, target.pos + 2))
			await expectSaved(edited)
		}
	})

	it("lays a page out again when a row that could not wait for a font drew stand-ins", async () => {
		const run = (text: string, font: string): string =>
			`<w:p><w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`
		const table = (widths: readonly number[], rows: string): string =>
			`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rows}</w:tbl>`
		const inner = (count: number, font: string, name: string): string =>
			Array.from({ length: count }, (_, k) => `<w:tr><w:tc>${run(`${name} ${k}`, font)}</w:tc></w:tr>`).join("")
		// A merge running out of its page inside a nested table cannot be laid out again later: its row continues
		// on the next page with stand-ins for a font first needed there.
		const merged = `<w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${table([3000], inner(40, "Arial", "arial") + inner(20, "Courier New", "mono"))}</w:tc>`
		const rows =
			`<w:tr>${merged}<w:tc>${run("b", "Arial")}</w:tc></w:tr>` +
			`<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc>${run("c", "Arial")}</w:tc></w:tr>`
		const body = Array.from({ length: 40 }, (_, k) => run(`line ${k}`, "Arial")).join("") + table([4000, 2000], rows)
		const pages = await savedDigest(buildDocx({ body }))

		expect(pages.join("\n")).toMatch(/"mono 0" \[[^\]]* fotest-cousine:/)
		expect(pages.join("\n")).not.toContain("null:")
	})

	it("lays out blocks put back after the body's last block, before its final section properties", async () => {
		const cell = (text: string): string => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${para(text)}</w:tc>`
		const rows = Array.from({ length: 60 }, (_, k) => `<w:tr>${cell(`a${k}`)}${cell(`b${k}`)}</w:tr>`).join("")
		const table = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${rows}</w:tbl>`
		const sectPr =
			'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
		const edited = await editedLayout(buildDocx({ body: para("first") + table + sectPr }))
		const session = edited.session
		const last = (): { pos: number; node: Node } => {
			const node = session.state.doc.lastChild as Node

			return { pos: session.state.doc.content.size - node.nodeSize, node }
		}
		const { pos, node } = last()

		await edited.edit(session.state.tr.delete(pos, pos + node.nodeSize))
		await expectSaved(edited)
		// The undo puts the table back after the last block: the last section grows with it.
		await edited.edit(each => each.execute({ type: "history.undo" }))
		await expectSaved(edited)
		await edited.edit(session.state.tr.insert(session.state.doc.content.size, docxSchema.nodes.paragraph.create()))
		await expectSaved(edited)
	})

	it("saves a locked table holding a section break in a cell, and refuses a locked section break moved into one", async () => {
		const cell = (inner: string): string => `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${inner}</w:tc>`
		const row = `<w:tr>${cell(para("cell one text", `<w:sectPr>${LANDSCAPE}</w:sectPr>`))}${cell(para("cell two text"))}</w:tr>`
		// A row inside w:customXml locks the table.
		const table =
			'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
			`<w:customXml w:element="r">${row}</w:customXml>${row}</w:tbl>`
		const edited = await editedLayout(
			buildDocx({ body: para("P zero text") + table + para(words(30, 1)) + `<w:sectPr>${PAGE}</w:sectPr>` })
		)
		const locked = edited.session.state.doc.child(1)

		expect(locked.type).toBe(docxSchema.nodes.locked_block)
		expect(locked.attrs["sectPr"]).toBeGreaterThanOrEqual(0)

		// An edit elsewhere: the table is written as it was, its break where it was.
		await edited.edit(edited.session.state.tr.insertText("XX ", 3))
		await expectSaved(edited)

		// A locked paragraph ending a section (w:customXml around it), moved into a table cell: its bytes would put
		// the break in the cell, so it is not written (the editor refuses that move; the writer refuses too).
		const wrapped = await editedLayout(
			buildDocx({
				body:
					table.replace(
						`<w:customXml w:element="r">${row}</w:customXml>`,
						`<w:tr>${cell(para("cell one text"))}${cell(para("cell two text"))}</w:tr>`
					) +
					`<w:customXml w:element="x">${para("Wrapped break", `<w:sectPr>${LANDSCAPE}</w:sectPr>`)}</w:customXml>` +
					para(words(30, 2)) +
					`<w:sectPr>${PAGE}</w:sectPr>`
			})
		)
		const doc = wrapped.session.state.doc
		const block = doc.child(1)
		const into = doc.child(0)
		let cellAt = -1

		doc.descendants((node, pos) => {
			if (cellAt < 0 && node.type === docxSchema.nodes.paragraph) cellAt = pos + node.nodeSize

			return cellAt < 0
		})

		expect(block.type).toBe(docxSchema.nodes.locked_block)
		expect(into.type).not.toBe(docxSchema.nodes.locked_block)

		const writer = new StoryWriter(
			{
				context: wrapped.context,
				nextRevisionId: () => 1,
				numId: id => id,
				hyperlink: () => {
					throw new Error("no hyperlink")
				}
			},
			wrapped.session.story
		)
		const moved = new Transform(doc).delete(into.nodeSize, into.nodeSize + block.nodeSize).insert(cellAt, block).doc

		expect(() => writer.writeStory(moved)).toThrow("A locked section break moved into or out of a table cell")
		expect(() => writer.writeStory(doc)).not.toThrow()
	})
})

describe("overlay parts", () => {
	const prefixesOf = (xml: string): string[] | undefined => {
		const out = new Set<string>()

		return namePrefixes(new TextEncoder().encode(xml), out) ? [...out].sort() : undefined
	}

	it("declare only the prefixes their names use, and fall back where names alone do not tell", () => {
		// `xml` is bound without a declaration; attributes without a prefix are in no namespace.
		expect(prefixesOf('<w:p w14:paraId="1"><w:r><w:t xml:space="preserve">a: b &lt; c</w:t></w:r></w:p>')).toEqual(["w", "w14"])
		expect(prefixesOf('<w:r><w:drawing><wp:inline><wp:extent cx="1" cy="2"/></wp:inline></w:drawing></w:r>')).toEqual(["w", "wp"])
		expect(prefixesOf('<w:p><mc:AlternateContent><mc:Choice Requires="wps"/></mc:AlternateContent></w:p>')).toBeUndefined()
		expect(prefixesOf('<w:p xmlns:x="urn:x"><x:y/></w:p>')).toBeUndefined()
		expect(prefixesOf("<w:p><!-- note --></w:p>")).toBeUndefined()
		expect(prefixesOf("<w:p a=\"1\" b='>'/>")).toEqual(["w"])
		expect(prefixesOf("<p/>")).toEqual([""])
	})

	it("parse an edited block in the minimal root as in the source's own", async () => {
		const edited = await editedLayout(buildDocx({ body: para("one") }))
		const source = edited.story.part
		const container = edited.story.story.story.item
		const block =
			'<w:p><w:r><w:t xml:space="preserve">a </w:t></w:r>' +
			'<w:r><w:drawing><wp:inline><wp:extent cx="1" cy="2"/></wp:inline></w:drawing></w:r></w:p>'
		const encode = (xml: string): Uint8Array => new TextEncoder().encode(xml)
		const minimal = edited.edits.addPart(source, container, encode(block), true)
		// A comment: the names alone do not tell, so the source's own root tag is used.
		const full = edited.edits.addPart(source, container, encode(`${block}<!-- full -->`), true)

		if (minimal === undefined || full === undefined) throw new Error("not parsed")

		expect(minimal.offset).toBeLessThan(full.offset)
		expect(minimal.items.length).toBe(1)

		const items = (part: typeof minimal.part, first: number): string[] => {
			const out: string[] = []

			for (let item = first; item < part.end(first); item++)
				out.push(`${String(part.kinds[item])}:${part.kinds[item] === Item.Text ? part.text(item) : ""}`)

			return out
		}

		expect(items(minimal.part, minimal.items[0] ?? -1)).toEqual(items(full.part, full.items[0] ?? -1))
	})
})
