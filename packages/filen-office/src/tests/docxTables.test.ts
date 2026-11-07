import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { Node } from "prosemirror-model"
import { EditorState, TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { bytesSource, OpcPackage, SliceClock } from "@filen/office/core/opc"
import { encodeUtf8, parseXml } from "@filen/office/core/xml"
import { RevisionFlag } from "@filen/office/core/docx"
import { DocxDocBuilder, DocxEditorSession, docxSchema, freshSlice, type DocxEditorCommand } from "@filen/office/core/docx/edit"
import { sourceCopies } from "../core/docx/edit/session"
import { DocxVerifyError, saveDocx, writerProof, type CheckInput } from "@filen/office/core/docx/write"
import { SetAttrsStep } from "../core/docx/edit/attrs"
import { TABLE_UNITS } from "../core/docx/edit/handlers/tables"
import { rightToLeft } from "../core/docx/edit/tables/hits"
import { tableMap } from "../core/docx/edit/tables/map"
import { markCommand, markInternal } from "../core/docx/edit/invariants/core"
import { TABLES_STAGE } from "../core/docx/edit/invariants/tables"
import { clearCellRevision, removeCells } from "../core/docx/edit/tables/ops"
import { resolveChanges, storyReviewIndex } from "../core/docx/review/accept"
import { tableChecks } from "../core/docx/write/checks/tables"
import { CORPUS_DIR } from "./corpusDir"
import { W as W_NAMESPACE, parseXml as parseIndependent, violations } from "./fuzz/independentReader"
import { tableOps } from "./fuzz/ops/tables"
import { openBytes, openSpec, type Opened } from "./docxEditFixtures"
import { buildDocx, p } from "./docxSynthetic"
import { layOut } from "./layoutFixtures"
import { editedLayout, pageDigest, pagedEditor, savedDigest, type EditedLayout } from "./pagedFixtures"

const nodes = docxSchema.nodes
const decoder = new TextDecoder()

// ---- documents ------------------------------------------------------------------------------------------

function tc(text: string, tcPr = ""): string {
	return `<w:tc>${tcPr === "" ? "" : `<w:tcPr>${tcPr}</w:tcPr>`}${p(text)}</w:tc>`
}

function tr(cells: readonly string[], trPr = ""): string {
	return `<w:tr>${trPr === "" ? "" : `<w:trPr>${trPr}</w:trPr>`}${cells.join("")}</w:tr>`
}

function tbl(grid: readonly number[], rows: readonly string[], tblPr = '<w:tblW w:w="0" w:type="auto"/>'): string {
	return `<w:tbl><w:tblPr>${tblPr}</w:tblPr><w:tblGrid>${grid.map(width => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>`
}

const W = (w: number): string => `<w:tcW w:w="${w}" w:type="dxa"/>`

// A 3 x 3 table: a1..c3 (rows 1..3, columns a..c).
const GRID3 = tbl(
	[2000, 2000, 2000],
	[1, 2, 3].map(row =>
		tr(
			["a", "b", "c"].map(column => tc(`${column}${row}`, W(2000))),
			row === 1 ? '<w:trHeight w:val="500"/>' : ""
		)
	)
)

// a1 b1 c1 / [a2 merged down over three rows] b2 c2 / b3 c3 / b4 c4
const MERGED = tbl(
	[2000, 2000, 2000],
	[
		tr(["a1", "b1", "c1"].map(text => tc(text, W(2000)))),
		tr([tc("a2", `${W(2000)}<w:vMerge w:val="restart"/>`), tc("b2", W(2000)), tc("c2", W(2000))]),
		tr([tc("", `${W(2000)}<w:vMerge/>`), tc("b3", W(2000)), tc("c3", W(2000))]),
		tr([tc("", `${W(2000)}<w:vMerge/>`), tc("b4", W(2000)), tc("c4", W(2000))])
	]
)

function docx(body: string, styles?: string): Uint8Array {
	return buildDocx({
		body: `${p("Before the table")}${body}${p("After the table")}`,
		...(styles === undefined
			? {}
			: {
					parts: [
						{
							name: "word/styles.xml",
							contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
							data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styles}</w:styles>`
						}
					],
					relationships: [{ id: "rIdStyles", type: "styles", target: "styles.xml" }]
				})
	})
}

// ---- selection ------------------------------------------------------------------------------------------

function textPos(doc: Node, text: string): number {
	let found = -1

	doc.descendants((node, pos) => {
		if (found >= 0) return false
		if (node.isText && node.text?.includes(text) === true) found = pos + (node.text.indexOf(text) ?? 0)

		return true
	})

	if (found < 0) throw new Error(`No text ${text}`)

	return found
}

function select(session: DocxEditorSession, from: string, to: string = from): void {
	const doc = session.state.doc

	session.dispatch(session.state.tr.setSelection(TextSelection.create(doc, textPos(doc, from), textPos(doc, to) + (to === from ? 0 : 1))))
}

// ---- reading back ---------------------------------------------------------------------------------------

function firstTable(doc: Node): Node {
	let table: Node | undefined

	doc.descendants(node => {
		if (table !== undefined) return false
		if (node.type === nodes.table) table = node

		return table === undefined
	})

	if (table === undefined) throw new Error("No table")

	return table
}

// Each row's cells as "text:span[:r|:c]" (without the text: ":span[:r|:c]").
function shape(table: Node, text = true): string[] {
	const out: string[] = []

	table.forEach(row => {
		const cells: string[] = []

		row.forEach(cell => {
			const vMerge = cell.attrs["vMerge"] as string | null

			cells.push(
				`${text ? cell.textContent : ""}:${String(cell.attrs["colspan"])}${vMerge === null ? "" : vMerge === "restart" ? ":r" : ":c"}`
			)
		})
		out.push(cells.join(" "))
	})

	return out
}

async function reopen(bytes: Uint8Array): Promise<{ opened: Opened; table: Node; grid: readonly number[] }> {
	const opened = await openBytes(bytes)
	const body = opened.model.body

	if (body === undefined) throw new Error("No body")

	const table = firstTable(new DocxDocBuilder(opened.context).build(body).doc)

	return { opened, table, grid: table.attrs["grid"] as readonly number[] }
}

async function partXml(bytes: Uint8Array, name = "word/document.xml"): Promise<string> {
	return decoder.decode(await (await OpcPackage.open(bytesSource(bytes))).read(name))
}

// Runs `commands` (after `prepare`) on the document's body in a laid-out editor, checks the pages shown
// against a fresh layout of the saved file, and returns the saved bytes.
async function edited(
	bytes: Uint8Array,
	prepare: (session: DocxEditorSession) => void,
	commands: readonly (DocxEditorCommand | ((session: DocxEditorSession) => void))[]
): Promise<{ bytes: Uint8Array; layout: EditedLayout }> {
	const layout = await editedLayout(bytes)

	prepare(layout.session)

	for (const command of commands) {
		if (typeof command === "function") command(layout.session)
		else expect(await layout.edit(session => session.execute(command)), command.type).toBe(true)
	}

	const saved = await layout.save()

	expect(pageDigest(layout.layout)).toEqual(await savedDigest(saved))

	return { bytes: saved, layout }
}

// ---- tests ----------------------------------------------------------------------------------------------

describe("table commands", () => {
	it("inserts rows above and below with the reference row's properties", async () => {
		const { bytes } = await edited(docx(GRID3), session => select(session, "b1"), [
			{ type: "table.row.insertBelow" },
			{ type: "table.row.insertAbove" }
		])
		const { table } = await reopen(bytes)

		expect(shape(table)).toEqual(["a1:1 b1:1 c1:1", ":1 :1 :1", ":1 :1 :1", "a2:1 b2:1 c2:1", "a3:1 b3:1 c3:1"])

		const xml = await partXml(bytes)

		// Both new rows copied the first row's height.
		expect(xml.match(/<w:trHeight w:val="500"\/>/g)?.length).toBe(3)
	})

	it("inserts a row inside a vertical merge as part of it", async () => {
		const { bytes } = await edited(docx(MERGED), session => select(session, "b2"), [{ type: "table.row.insertBelow" }])
		const { table } = await reopen(bytes)

		expect(shape(table)).toEqual(["a1:1 b1:1 c1:1", "a2:1:r b2:1 c2:1", ":1:c :1 :1", ":1:c b3:1 c3:1", ":1:c b4:1 c4:1"])
	})

	it("deletes rows; a merge losing its first row starts below with its content", async () => {
		const { bytes } = await edited(docx(MERGED), session => select(session, "b2"), [{ type: "table.row.delete" }])
		const { table } = await reopen(bytes)

		expect(shape(table)).toEqual(["a1:1 b1:1 c1:1", "a2:1:r b3:1 c3:1", ":1:c b4:1 c4:1"])
	})

	it("inserts columns, scaling the grid to the table's width", async () => {
		const { bytes } = await edited(docx(GRID3), session => select(session, "b2"), [{ type: "table.column.insertRight" }])
		const { table, grid } = await reopen(bytes)

		expect(shape(table)).toEqual(["a1:1 b1:1 :1 c1:1", "a2:1 b2:1 :1 c2:1", "a3:1 b3:1 :1 c3:1"])
		expect(grid).toEqual([1500, 1500, 1500, 1500])
		expect((await partXml(bytes)).match(/<w:tcW w:w="1500" w:type="dxa"\/>/g)?.length).toBe(12)
	})

	it("inserts one column per selected cell, as wide as the cell, however many grid columns it spans", async () => {
		// a1 spans the first two grid columns.
		const wide = tbl(
			[2000, 2000, 2000],
			[tr([tc("a1", `${W(4000)}<w:gridSpan w:val="2"/>`), tc("c1", W(2000))]), tr(["a2", "b2", "c2"].map(text => tc(text, W(2000))))]
		)
		const one = await edited(docx(wide), session => select(session, "a1"), [{ type: "table.column.insertLeft" }])
		const back = await reopen(one.bytes)

		expect(shape(back.table)).toEqual([":1 a1:2 c1:1", ":1 a2:1 b2:1 c2:1"])
		// The new column is as wide as a1 (4000 of 10000), scaled to the table's width.
		expect(back.grid).toEqual([2400, 1200, 1200, 1200])

		// Two cells selected in the second row: two columns, each as wide as its cell.
		const two = await edited(docx(wide), session => select(session, "a2", "b2"), [{ type: "table.column.insertRight" }])

		expect(shape((await reopen(two.bytes)).table)).toEqual(["a1:2 :1 :1 c1:1", "a2:1 b2:1 :1 :1 c2:1"])
	})

	it("merges and splits cells", async () => {
		const merged = await edited(docx(GRID3), session => select(session, "a1", "b2"), [{ type: "table.cells.merge" }])
		const back = await reopen(merged.bytes)

		expect(shape(back.table)).toEqual(["a1b1a2b2:2:r c1:1", ":2:c c2:1", "a3:1 b3:1 c3:1"])

		const split = await edited(merged.bytes, session => select(session, "a1"), [{ type: "table.cell.split", rows: 2, cols: 2 }])

		expect(shape((await reopen(split.bytes)).table)).toEqual(["a1b1a2b2:1 :1 c1:1", ":1 :1 c2:1", "a3:1 b3:1 c3:1"])
	})

	it("keeps the markers between and after merged cells in their order, the merged cell ending in a paragraph", async () => {
		// A bookmark starting between a1 and b1 and ending in b1, another after the last paragraph of b1 (Word
		// writes both).
		const source = tbl(
			[2000, 2000],
			[
				`<w:tr>${tc("a1", W(2000))}<w:bookmarkStart w:id="1" w:name="Between"/><w:tc><w:tcPr>${W(2000)}</w:tcPr><w:p><w:r><w:t>b1</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p><w:p><w:r><w:t>b1 more</w:t></w:r></w:p><w:bookmarkStart w:id="2" w:name="After"/><w:bookmarkEnd w:id="2"/></w:tc></w:tr>`,
				tr([tc("a2", W(2000)), tc("b2", W(2000))])
			]
		)
		const { bytes } = await edited(docx(source), session => select(session, "a1", "b1"), [{ type: "table.cells.merge" }])
		const xml = await partXml(bytes)
		const cell = xml.slice(xml.indexOf("<w:tc>"), xml.indexOf("</w:tc>") + 7)
		const order = [...cell.matchAll(/<w:bookmark(Start|End) w:id="(\d)"|<w:t[^>]*>(\w[^<]*)<\/w:t>/g)].map(
			match => match[3] ?? `${match[1]}${match[2]}`
		)

		expect(order).toEqual(["a1", "Start1", "b1", "End1", "b1 more", "Start2", "End2"])
		expect(cell.endsWith("</w:p></w:tc>")).toBe(true)
		expect(violations(parseIndependent(new TextEncoder().encode(xml)), {}).counts.get("tc-notEndingInP")).toBeUndefined()
	})

	it("splits a cell of one row into new rows, the other cells merged down", async () => {
		const { bytes } = await edited(docx(GRID3), session => select(session, "b2"), [{ type: "table.cell.split", rows: 2, cols: 1 }])

		expect(shape((await reopen(bytes)).table)).toEqual(["a1:1 b1:1 c1:1", "a2:1:r b2:1 c2:1:r", ":1:c :1 :1:c", "a3:1 b3:1 c3:1"])
	})

	it("splits a cell into columns by adding grid columns the other rows span", async () => {
		const { bytes } = await edited(docx(GRID3), session => select(session, "b2"), [{ type: "table.cell.split", rows: 1, cols: 2 }])
		const { table, grid } = await reopen(bytes)

		expect(shape(table)).toEqual(["a1:1 b1:2 c1:1", "a2:1 b2:1 :1 c2:1", "a3:1 b3:2 c3:1"])
		expect(grid).toEqual([2000, 1000, 1000, 2000])
	})

	it("deletes columns and tables", async () => {
		const columns = await edited(docx(GRID3), session => select(session, "b1", "c1"), [{ type: "table.column.delete" }])

		expect(shape((await reopen(columns.bytes)).table)).toEqual(["a1:1", "a2:1", "a3:1"])

		const table = await edited(docx(GRID3), session => select(session, "b2"), [{ type: "table.delete" }])

		expect(await partXml(table.bytes)).not.toContain("<w:tbl>")
	})

	it("inserts a table at the caret", async () => {
		const { bytes } = await edited(
			docx(""),
			session => {
				const doc = session.state.doc

				session.dispatch(session.state.tr.setSelection(TextSelection.create(doc, textPos(doc, "the table") + 4)))
			},
			[{ type: "table.insert", rows: 2, cols: 3 }]
		)
		const { table, opened } = await reopen(bytes)

		expect(shape(table)).toEqual([":1 :1 :1", ":1 :1 :1"])
		expect(opened.model.body).toBeDefined()

		const xml = await partXml(bytes)

		expect(xml).toContain("<w:tblBorders>")
		expect(xml).toMatch(/Before the <\/w:t>.*<w:tbl>.*<\/w:tbl>.*>table<\/w:t>/)
	})

	it("keeps a paragraph between a table and one inserted right after it", async () => {
		const after = (session: DocxEditorSession): void => {
			session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, textPos(session.state.doc, "After"))))
		}
		const { bytes, layout } = await edited(docx(GRID3), after, [{ type: "table.insert", rows: 1, cols: 2 }])
		const xml = await partXml(bytes)

		expect(xml).not.toContain("</w:tbl><w:tbl>")
		expect(xml).toMatch(/<\/w:tbl><w:p\b[^>]*\/?>(?:<\/w:p>)?<w:tbl>/)
		expect(layout.session.state.doc.childCount).toBe(5)

		const tracked = await edited(
			docx(GRID3),
			session => {
				session.context.review.tracking = true
				session.context.identity.author = "Ann Author"
				after(session)
			},
			[{ type: "table.insert", rows: 1, cols: 2 }]
		)

		// While tracking, the new paragraph's mark is inserted with the table.
		expect(await partXml(tracked.bytes)).toMatch(
			/<\/w:tbl><w:p><w:pPr><w:rPr><w:ins w:id="\d+" w:author="Ann Author"[^>]*\/><\/w:rPr><\/w:pPr><\/w:p><w:tbl>/
		)
	})

	it("inserts a table in place of the selection, the deletion tracked while changes are", async () => {
		const word = (session: DocxEditorSession): void => {
			const from = textPos(session.state.doc, "the tab")

			session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, from + 7)))
		}
		const replaced = await edited(docx(""), word, [{ type: "table.insert", rows: 1, cols: 2 }])

		expect(await partXml(replaced.bytes)).toMatch(/Before <\/w:t>.*<w:tbl>.*<\/w:tbl>.*>le<\/w:t>/)
		// One undo step takes the table and the deletion back.
		expect(await replaced.layout.edit(session => session.execute({ type: "history.undo" }))).toBe(true)
		expect(replaced.layout.session.state.doc.textContent).toBe("Before the tableAfter the table")

		const tracked = await edited(
			docx(""),
			session => {
				session.context.review.tracking = true
				session.context.identity.author = "Ann Author"
				word(session)
			},
			[{ type: "table.insert", rows: 1, cols: 2 }]
		)

		expect(await partXml(tracked.bytes)).toMatch(/<w:del w:id="\d+" w:author="Ann Author"[^>]*><w:r><w:delText>the tab<\/w:delText>/)
		// Tracked too, one undo step takes back the table and the deletion (a tracked deletion changes no
		// positions, so the table's step is not "adjacent" to it).
		expect(await tracked.layout.edit(session => session.execute({ type: "history.undo" }))).toBe(true)
		expect(tracked.layout.session.state.doc.eq((await editedLayout(docx(""))).session.state.doc)).toBe(true)
	})

	it("records the paragraph mark a tracked table insertion splits off as inserted", async () => {
		const { bytes, layout } = await edited(
			docx(""),
			session => {
				session.context.review.tracking = true
				session.context.identity.author = "Ann Author"
				session.dispatch(
					session.state.tr.setSelection(TextSelection.create(session.state.doc, textPos(session.state.doc, "table")))
				)
			},
			[{ type: "table.insert", rows: 1, cols: 2 }]
		)
		const first = layout.session.state.doc.firstChild

		expect(first?.textContent).toBe("Before the ")
		expect(((first?.attrs["revision"] as number) & RevisionFlag.Inserted) !== 0).toBe(true)
		// The first half's mark is the new one; the original mark ends the second half.
		expect(await partXml(bytes)).toMatch(
			/<w:p><w:pPr><w:rPr><w:ins w:id="\d+" w:author="Ann Author" w:date="[0-9T:-]+Z"\/><\/w:rPr><\/w:pPr><w:r><w:t xml:space="preserve">Before the <\/w:t><\/w:r><\/w:p><w:tbl>.*<\/w:tbl><w:p><w:r><w:t>table<\/w:t>/
		)
	})

	// Fails until review/accept.ts looks past a table the resolution takes out whole (F4-needs-accept.ts.md).
	it("rejecting a tracked table insertion joins the paragraph it split", async () => {
		const layout = await editedLayout(docx(""))
		const session = layout.session

		session.context.review.tracking = true
		session.context.identity.author = "Ann Author"
		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, textPos(session.state.doc, "table"))))
		expect(session.execute({ type: "table.insert", rows: 2, cols: 2 })).toBe(true)

		const outcome = resolveChanges(session, storyReviewIndex(session), { all: true }, false)

		expect(outcome.tr !== null && session.dispatch(outcome.tr)).toBe(true)

		const texts: string[] = []

		session.state.doc.forEach(node => texts.push(`${node.type.name}:${node.textContent}`))
		expect({ texts, skipped: outcome.skipped }).toEqual({
			texts: ["paragraph:Before the table", "paragraph:After the table"],
			skipped: 0
		})
	})

	it("restarts the merges of new rows in a table that stays where they continue under no merge", async () => {
		// What a raw paste whose open table joins another leaves (the paste itself is a host's transaction): a new
		// row continuing merges that nothing above it starts.
		const opened = await openBytes(docx(GRID3))
		const session = new DocxEditorSession(opened.context)
		const doc = session.state.doc
		const table = firstTable(doc)
		let tablePos = -1

		doc.forEach((node, pos) => {
			if (node === table) tablePos = pos
		})

		const cell = (vMerge: string | null): Node =>
			nodes.table_cell.create({ colspan: 1, vMerge }, nodes.paragraph.create(null, docxSchema.text("x")))
		const rows = [cell(null), cell("continue"), cell("continue")]
		const at = tablePos + 1 + table.child(0).nodeSize
		const tr = session.state.tr.insert(at, [
			nodes.table_row.create(null, rows),
			nodes.table_row.create(null, [cell(null), cell(null), cell("continue")])
		])
		const fix = TABLES_STAGE?.repair?.([tr], EditorState.create({ doc: tr.doc }), {})
		const healed = firstTable(fix?.doc ?? tr.doc)
		const merges = [1, 2].map(r => {
			const out: (string | null)[] = []

			healed.child(r).forEach(child => out.push(child.attrs["vMerge"] as string | null))

			return out
		})

		// Under a row of plain cells: b continues nothing below, so it is none; c starts the merge the row below
		// continues.
		expect(merges).toEqual([
			[null, null, "restart"],
			[null, null, "continue"]
		])
	})

	it("heals the merges of new rows a later transaction rebuilt whole blocks around", async () => {
		// The tracking stage marks a big tracked paste by rebuilding the blocks it touched in one step.
		const opened = await openBytes(docx(GRID3))
		const doc = new DocxEditorSession(opened.context).state.doc
		const table = firstTable(doc)
		let tablePos = -1

		doc.forEach((node, pos) => {
			if (node === table) tablePos = pos
		})

		const cell = (vMerge: string | null): Node =>
			nodes.table_cell.create({ colspan: 1, vMerge }, nodes.paragraph.create(null, docxSchema.text("x")))
		const tr = EditorState.create({ doc }).tr.insert(
			tablePos + 1 + table.child(0).nodeSize,
			nodes.table_row.create(null, [cell(null), cell("continue"), cell(null)])
		)
		const pasted = tr.doc.child(1)
		const bulk = markInternal(
			EditorState.create({ doc: tr.doc }).tr.replaceWith(tablePos, tablePos + pasted.nodeSize, pasted.copy(pasted.content))
		)
		const fix = TABLES_STAGE?.repair?.([tr, bulk], EditorState.create({ doc: bulk.doc }), {})
		const merges: (string | null)[] = []

		firstTable(fix?.doc ?? bulk.doc)
			.child(1)
			.forEach(child => merges.push(child.attrs["vMerge"] as string | null))

		expect(merges).toEqual([null, null, null])
	})

	it("finds a column border under a press, as the grid column it ends", async () => {
		const borders =
			'<w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/>' +
			'<w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders>'
		const { editor } = await pagedEditor(
			docx(
				tbl(
					[2000, 2000, 2000],
					[1, 2].map(row => tr(["a", "b", "c"].map(column => tc(`${column}${row}`, W(2000))))),
					borders
				)
			)
		)
		const page = editor.page(0)

		if (page === undefined) throw new Error("no page")

		const edges = new Map<number, number>()

		for (let k = 0; k < page.graphicCount; k++) {
			const [x = 0, y = 0, width = 0, height = 0] = page.graphicFloats.subarray(k * 4, k * 4 + 4)

			if (height > width && !edges.has(Math.round(x + width / 2))) edges.set(Math.round(x + width / 2), y + height / 2)
		}

		const xs = [...edges.keys()].sort((a, b) => a - b)

		expect(xs.length).toBe(4)

		const hit = (x: number): string | undefined => {
			const found = editor.hitObject(0, x + 1, edges.get(x) ?? 0)

			return found?.kind === "tableBorder" ? found.part : undefined
		}

		// The left edge ends no column; the others end columns 0, 1 and 2.
		expect(xs.map(hit)).toEqual([undefined, "column:0", "column:1", "column:2"])

		const found = editor.hitObject(0, (xs[1] ?? 0) - 2, edges.get(xs[1] ?? 0) ?? 0)

		expect(found).toMatchObject({ kind: "tableBorder", story: editor.activeStory, part: "column:0" })
		expect(editor.state.doc.nodeAt(found?.pos ?? -1)?.type).toBe(nodes.table)
		// Off a border: no hit.
		expect(editor.hitObject(0, (xs[1] ?? 0) + 20, edges.get(xs[1] ?? 0) ?? 0)).toBeUndefined()

		// The grab distance is the same on screen at every zoom.
		const y = edges.get(xs[1] ?? 0) ?? 0

		expect(editor.hitObject(0, (xs[1] ?? 0) - 2.5, y, 2)).toBeUndefined()
		expect(editor.hitObject(0, (xs[1] ?? 0) - 5, y, 0.5)).toMatchObject({ kind: "tableBorder", part: "column:0" })
		editor.dispose()
	})

	it("finds the column a border ends next to merged cells, in nested and in right-to-left tables", async () => {
		const sides = (insideV: boolean): string =>
			["top", "left", "bottom", "right", "insideH", ...(insideV ? ["insideV"] : [])]
				.map(side => `<w:${side} w:val="single" w:sz="4"/>`)
				.join("")
		const borders = `<w:tblW w:w="0" w:type="auto"/><w:tblBorders>${sides(true)}</w:tblBorders>`
		// Per row band (top to bottom), the hit of each vertical border left to right: "<table>:<part>", the
		// table by the first text in it.
		const hits = async (bytes: Uint8Array): Promise<string[][]> => {
			const { editor } = await pagedEditor(bytes)
			const page = editor.page(0)

			if (page === undefined) throw new Error("no page")

			const bands = new Map<string, { x: number; y: number }[]>()

			for (let k = 0; k < page.graphicCount; k++) {
				const [x = 0, y = 0, width = 0, height = 0] = page.graphicFloats.subarray(k * 4, k * 4 + 4)
				const key = `${y.toFixed(1)}:${height.toFixed(1)}`

				if (height > width) bands.set(key, [...(bands.get(key) ?? []), { x: x + width / 2, y: y + height / 2 }])
			}

			const out = [...bands.values()]
				.sort((a, b) => (a[0]?.y ?? 0) - (b[0]?.y ?? 0))
				.map(band =>
					band
						.sort((a, b) => a.x - b.x)
						.map(({ x, y }) => {
							const found = editor.hitObject(0, x + 1, y)

							if (found?.kind !== "tableBorder") return "-"

							const table = editor.state.doc.nodeAt(found.pos)

							return `${table?.type === nodes.table ? (table.textContent.slice(0, 2) ?? "") : "?"}:${found.part ?? ""}`
						})
				)

			editor.dispose()

			return out
		}

		// b1 merged down over the second row: the border right of it in that row ends column 1.
		const merged = tbl(
			[2000, 2000, 2000],
			[
				tr([tc("a1", W(2000)), tc("b1", `${W(2000)}<w:vMerge w:val="restart"/>`), tc("c1", W(2000))]),
				tr([tc("a2", W(2000)), tc("", `${W(2000)}<w:vMerge/>`), tc("c2", W(2000))])
			],
			borders
		)

		expect(await hits(docx(merged))).toEqual([
			["-", "a1:column:0", "a1:column:1", "a1:column:2"],
			["-", "a1:column:0", "a1:column:1", "a1:column:2"]
		])

		// A table nested in the left cell: its borders are its own columns, the outer ones the outer table's.
		const inner = tbl(
			[1000, 1000],
			[tr([tc("x1", W(1000)), tc("y1", W(1000))])],
			`<w:tblW w:w="0" w:type="auto"/><w:tblBorders>${sides(true)}</w:tblBorders>`
		)
		const nested = tbl(
			[3000, 3000],
			[`<w:tr><w:tc><w:tcPr>${W(3000)}</w:tcPr>${p("o1")}${inner}${p("")}</w:tc>${tc("o2", W(3000))}</w:tr>`],
			borders
		)

		expect(new Set((await hits(docx(nested))).map(band => band.join(" ")))).toEqual(
			new Set(["- o1:column:0 o1:column:1", "- x1:column:0 x1:column:1"])
		)

		// Right to left: the leftmost border ends the last column, the rightmost (the table's start) none.
		const rtl = tbl(
			[2000, 2000, 2000],
			[1, 2].map(row => tr(["a", "b", "c"].map(column => tc(`${column}${row}`, W(2000))))),
			`<w:bidiVisual/>${borders}`
		)

		expect(await hits(docx(rtl))).toEqual([
			["a1:column:2", "a1:column:1", "a1:column:0", "-"],
			["a1:column:2", "a1:column:1", "a1:column:0", "-"]
		])

		// Right to left from the table style too (what a row whose lines give no order goes by).
		const styled = await pagedEditor(
			docx(
				tbl([2000, 2000], [tr([tc("a1", W(2000)), tc("b1", W(2000))])], `<w:tblStyle w:val="Rtl"/>${borders}`),
				'<w:style w:type="table" w:styleId="Rtl"><w:name w:val="Rtl"/><w:tblPr><w:bidiVisual/></w:tblPr></w:style>'
			)
		)

		expect(rightToLeft(styled.editor, firstTable(styled.editor.state.doc))).toBe(true)
		styled.editor.dispose()
	})

	it("sets table and cell properties", async () => {
		const { bytes } = await edited(docx(GRID3), session => select(session, "a1", "b2"), [
			{ type: "table.row.header" },
			{ type: "table.align", align: "center" },
			{ type: "table.cell.shading", fill: "ffee00" },
			{ type: "table.cell.vAlign", align: "bottom" },
			{ type: "table.column.width", index: 0, twips: 3000 }
		])
		const xml = await partXml(bytes)

		expect(xml.match(/<w:tblHeader\/>/g)?.length).toBe(2)
		expect(xml).toContain('<w:jc w:val="center"/>')
		expect(xml.match(/<w:shd w:val="clear" w:color="auto" w:fill="FFEE00"\/>/g)?.length).toBe(4)
		expect(xml.match(/<w:vAlign w:val="bottom"\/>/g)?.length).toBe(4)
		expect((await reopen(bytes)).grid).toEqual([3000, 1000, 2000])
	})

	it("drags the last border of a table in percent by its percentage, the other borders staying", async () => {
		const sides = ["top", "left", "bottom", "right", "insideH", "insideV"].map(side => `<w:${side} w:val="single" w:sz="4"/>`).join("")
		const pct = tbl(
			[2000, 2000, 2000],
			[tr(["a", "b", "c"].map(text => tc(text, W(2000))))],
			`<w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${sides}</w:tblBorders>`
		)
		const edges = async (bytes: Uint8Array): Promise<number[]> => {
			const { editor } = await pagedEditor(bytes)
			const page = editor.page(0)
			const out = new Set<number>()

			for (let k = 0; k < (page?.graphicCount ?? 0); k++) {
				const [x = 0, , width = 0, height = 0] = page?.graphicFloats.subarray(k * 4, k * 4 + 4) ?? []

				if (height > width) out.add(Math.round(x + width / 2))
			}

			editor.dispose()

			return [...out].sort((a, b) => a - b)
		}
		const before = await edges(docx(pct))
		const { bytes } = await edited(docx(pct), session => select(session, "c"), [{ type: "table.column.width", index: 2, twips: 1000 }])
		const after = await edges(bytes)

		expect(await partXml(bytes)).toContain('<w:tblW w:w="4167" w:type="pct"/>')
		expect(after.slice(0, 3)).toEqual(before.slice(0, 3))
		expect(after[3]).toBeLessThan(before[3] ?? 0)
	})

	it("repeats header rows again on the pages after one they left no room on", async () => {
		const exact = (twips: number): string => `<w:trHeight w:val="${String(twips)}" w:hRule="exact"/>`
		const page =
			'<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
		// Two columns from a continuous section break below "start" (864 px of text): the second column on the
		// first page is not empty, so the header repeated there (100 px) leaves no room for "big" (800 px). That
		// column stays without a body row, the next one has no header and takes "big", and the columns after it
		// repeat the header again.
		const table = tbl(
			[2000],
			[
				tr([tc("H", W(2000))], `<w:tblHeader/>${exact(1500)}`),
				tr([tc("r1", W(2000))], exact(9000)),
				tr([tc("big", W(2000))], exact(12000)),
				...Array.from({ length: 12 }, (_, k) => tr([tc(`s${String(k + 1)}`, W(2000))], exact(1500)))
			]
		)
		const body =
			`<w:p><w:pPr><w:sectPr>${page}</w:sectPr></w:pPr><w:r><w:t>start</w:t></w:r></w:p>` +
			`${table}${p("end")}<w:sectPr><w:type w:val="continuous"/>${page}<w:cols w:num="2" w:space="720"/></w:sectPr>`
		const layout = await layOut(buildDocx({ body }))
		const texts = layout.pages.flatMap(page => page.sourceTexts.filter(text => text !== ""))

		expect(texts.slice(0, texts.indexOf("s1") + 1)).toEqual(["start", "H", "r1", "H", "big", "H", "s1"])
	})

	it("keeps the header rows from ending inside a vertical merge", async () => {
		const session = new DocxEditorSession((await openBytes(docx(MERGED))).context)
		const headers = (): boolean[] => {
			const out: boolean[] = []
			const table = firstTable(session.state.doc)

			for (let r = 0; r < table.childCount; r++) out.push(tableMap(table, session.story.part, session.context.store).row(r).header)

			return out
		}

		// a2 is merged down to the last row: repeating the second row repeats them all.
		select(session, "b2")
		expect(session.execute({ type: "table.row.header" })).toBe(true)
		expect(headers()).toEqual([true, true, true, true])

		select(session, "b3")
		expect(session.execute({ type: "table.row.header" })).toBe(true)
		expect(headers()).toEqual([true, false, false, false])

		// Merging a header row's cell with the row below makes that row a header row too.
		select(session, "b1", "b2")
		expect(session.execute({ type: "table.cells.merge" })).toBe(true)
		expect(headers()).toEqual([true, true, false, false])
	})

	it("saves the source bytes again after every edit is undone", async () => {
		const source = docx(MERGED)
		const opened = await openBytes(source)
		const session = new DocxEditorSession(opened.context, { proof: writerProof(opened.context) })

		select(session, "b2")

		const commands: DocxEditorCommand[] = [
			{ type: "table.row.insertBelow" },
			{ type: "table.column.insertLeft" },
			{ type: "table.row.delete" },
			{ type: "table.cell.shading", fill: "00FF00" }
		]

		for (const command of commands) expect(session.execute(command), command.type).toBe(true)

		for (let k = 0; k < commands.length; k++) session.execute({ type: "history.undo" })

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })

		expect(result.bytes).toBeDefined()
		expect(await partXml(result.bytes as Uint8Array)).toBe(await partXml(source))
		expect(tableMap(firstTable(session.state.doc), session.story.part, opened.context.store).height).toBe(4)
	})

	it("edits nested tables and rows with grid columns before and after their cells", async () => {
		const nested = tbl([4000, 4000], [tr([`<w:tc>${p("outer")}${GRID3}${p("")}</w:tc>`, tc("right")])])
		const inner = await edited(docx(nested), session => select(session, "b2"), [
			{ type: "table.row.insertBelow" },
			{ type: "table.column.delete" }
		])
		const outer = firstTable((await reopen(inner.bytes)).table.child(0).child(0))

		// The caret went to the new row's first cell: its column went.
		expect(shape(outer)).toEqual(["b1:1 c1:1", "b2:1 c2:1", ":1 :1", "b3:1 c3:1"])

		const offset = tbl(
			[1000, 2000, 2000],
			[tr([tc("x1", W(2000)), tc("y1", W(2000))], '<w:gridBefore w:val="1"/>'), tr(["x2", "y2", "z2"].map(text => tc(text)))]
		)
		const left = await edited(docx(offset), session => select(session, "x2"), [{ type: "table.column.insertLeft" }])
		const back = await reopen(left.bytes)

		expect(shape(back.table)).toEqual(["x1:1 y1:1", ":1 x2:1 y2:1 z2:1"])
		expect(await partXml(left.bytes)).toContain('<w:gridBefore w:val="2"/>')
	})

	it("uses the document's grid style for a new table and sets table styles", async () => {
		const styles =
			'<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/></w:tblBorders></w:tblPr></w:style>' +
			'<w:style w:type="table" w:styleId="Fancy"><w:name w:val="Fancy Table"/></w:style>'
		const { bytes, layout } = await edited(docx(GRID3, styles), session => select(session, "b2"), [
			{ type: "table.style", styleId: "fancy" }
		])

		expect(await partXml(bytes)).toContain('<w:tblStyle w:val="Fancy"/>')
		expect(layout.session.snapshot().context.table?.styles.map(style => style.id)).toEqual(["TableGrid", "Fancy"])
		expect(layout.session.execute({ type: "table.style", styleId: "Missing" })).toBe(false)

		const inserted = await edited(docx("", styles), session => select(session, "After"), [{ type: "table.insert", rows: 1, cols: 2 }])
		const xml = await partXml(inserted.bytes)

		expect(xml).toContain('<w:tblStyle w:val="TableGrid"/>')
		expect(xml).not.toContain("<w:tblBorders>")
	})

	it("records row and cell insertions and deletions while changes are tracked", async () => {
		const { bytes } = await edited(
			docx(GRID3),
			session => {
				session.context.review.tracking = true
				session.context.identity.author = "Ann Author"
				select(session, "b2")
			},
			[
				{ type: "table.row.insertBelow" },
				{ type: "table.row.delete" },
				session => select(session, "b2"),
				{ type: "table.row.delete" },
				session => select(session, "a1"),
				{ type: "table.column.delete" }
			]
		)
		const xml = await partXml(bytes)
		const { opened, table } = await reopen(bytes)
		const part = opened.model.parts[opened.model.body?.part ?? 0]

		// The inserted row was deleted again: it is gone, not marked.
		expect(shape(table)).toEqual(["a1:1 b1:1 c1:1", "a2:1 b2:1 c2:1", "a3:1 b3:1 c3:1"])
		expect(xml).toMatch(/<w:trPr><w:del w:id="\d+" w:author="Ann Author" w:date="[0-9T:-]+Z"\/><\/w:trPr>/)
		expect(xml.match(/<w:cellDel w:id="\d+" w:author="Ann Author"/g)?.length).toBe(3)
		expect([...(part?.rows.revision ?? [])]).toEqual([0, RevisionFlag.Deleted, 0])

		const kept = await edited(
			docx(GRID3),
			session => {
				session.context.review.tracking = true
				session.context.identity.author = "Ann Author"
				select(session, "b2")
			},
			[{ type: "table.row.insertAbove" }]
		)

		expect(await partXml(kept.bytes)).toMatch(/<w:tr><w:trPr><w:ins w:id="\d+" w:author="Ann Author"/)

		const anonymous = await editedLayout(docx(GRID3))

		anonymous.context.review.tracking = true
		select(anonymous.session, "b2")
		expect(anonymous.session.execute({ type: "table.row.insertBelow" })).toBe(false)
	})

	it("takes tracked cells back for accept and reject", async () => {
		const opened = await openBytes(docx(MERGED))
		const session = new DocxEditorSession(opened.context)

		session.context.review.tracking = true
		session.context.identity.author = "Ann Author"
		select(session, "c1")
		expect(session.execute({ type: "table.column.delete" })).toBe(true)
		session.context.review.tracking = false

		const doc = session.state.doc
		const table = firstTable(doc)
		let pos = -1

		doc.descendants((node, at) => {
			if (node === table) pos = at

			return pos < 0
		})

		const map = tableMap(table, session.story.part, opened.context.store)
		const bits = (node: Node): number[] => {
			const out: number[] = []

			node.forEach(row => row.forEach(cell => out.push(cell.attrs["revision"] as number)))

			return out
		}

		expect(bits(table)).toEqual([
			0,
			0,
			RevisionFlag.Deleted,
			0,
			0,
			RevisionFlag.Deleted,
			0,
			0,
			RevisionFlag.Deleted,
			0,
			0,
			RevisionFlag.Deleted
		])

		// Reject the first deletion, accept the others (the column's last cells go; no merge runs there).
		const tr = session.state.tr

		clearCellRevision(tr, pos, 0, 2, RevisionFlag.Deleted)
		expect(
			removeCells(
				tr,
				map,
				pos,
				[1, 2, 3].map(row => ({ row, index: 2 }))
			)
		).toBe(true)
		// As accept/reject runs it: a transaction of the session's own kind.
		expect(session.dispatch(markCommand(tr))).toBe(true)
		expect(shape(firstTable(session.state.doc))).toEqual(["a1:1 b1:1 c1:1", "a2:1:r b2:1", ":1:c b3:1", ":1:c b4:1"])
		expect(bits(firstTable(session.state.doc)).every(value => value === 0)).toBe(true)
		// Cells a vertical merge runs through stay.
		expect(
			removeCells(session.state.tr, tableMap(firstTable(session.state.doc), session.story.part, opened.context.store), pos, [
				{ row: 1, index: 0 }
			])
		).toBe(false)
		expect((await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })).bytes).toBeDefined()
	})

	it("resolves a tracked column insertion or deletion next to a vertical merge as the untracked edit leaves the table", async () => {
		// b1 merged down over b2.
		const merged = docx(
			tbl(
				[2000, 2000, 2000],
				[
					tr([tc("a1", W(2000)), tc("b1", `${W(2000)}<w:vMerge w:val="restart"/>`), tc("c1", W(2000))]),
					tr([tc("a2", W(2000)), tc("", `${W(2000)}<w:vMerge/>`), tc("c2", W(2000))]),
					tr([tc("a3", W(2000)), tc("b3", W(2000)), tc("c3", W(2000))])
				]
			)
		)
		const tracking = (session: DocxEditorSession): void => {
			session.context.review.tracking = true
			session.context.identity.author = "Ann Author"
			select(session, "a1")
		}
		const resolved = async (layout: EditedLayout, accept: boolean): Promise<Uint8Array> => {
			const outcome = resolveChanges(layout.session, storyReviewIndex(layout.session), { all: true }, accept)

			expect(outcome.skipped).toBe(0)
			expect(outcome.tr === null || (await layout.edit(outcome.tr))).toBe(true)

			const saved = await layout.save()

			expect(pageDigest(layout.layout)).toEqual(await savedDigest(saved))

			return saved
		}
		const untracked = await partXml((await edited(merged, session => select(session, "a1"), [{ type: "table.column.delete" }])).bytes)

		for (const reopened of [false, true]) {
			const inserted = await edited(merged, tracking, [{ type: "table.column.insertLeft" }])

			expect(await partXml(await resolved(reopened ? await editedLayout(inserted.bytes) : inserted.layout, false))).toBe(
				await partXml(merged)
			)

			const deleted = await edited(merged, tracking, [{ type: "table.column.delete" }])
			const accepted = await partXml(await resolved(reopened ? await editedLayout(deleted.bytes) : deleted.layout, true))

			// The deleted column's grid column goes too.
			expect(accepted).toBe(untracked)
			expect(accepted).toMatch(/<w:tblGrid><w:gridCol w:w="2000"\/><w:gridCol w:w="2000"\/><\/w:tblGrid>/)
		}
	})

	it("saves a tracked cell change of a cell merged or split since with the width rejecting it gives", async () => {
		const tracking = (session: DocxEditorSession): void => {
			session.context.review.tracking = true
			session.context.identity.author = "Ann Author"
			select(session, "b2")
		}
		const scripts: (DocxEditorCommand | ((session: DocxEditorSession) => void))[][] = [
			[
				{ type: "table.cell.shading", fill: "00FF00" },
				{ type: "table.cell.split", rows: 1, cols: 2 }
			],
			[{ type: "table.column.width", index: 0, twips: 3000 }, session => select(session, "a2", "b2"), { type: "table.cells.merge" }]
		]

		for (const script of scripts) {
			const inSession = await edited(docx(GRID3), tracking, script)
			const reopened = await editedLayout(inSession.bytes)

			for (const layout of [inSession.layout, reopened]) {
				const outcome = resolveChanges(layout.session, storyReviewIndex(layout.session), { all: true }, false)

				expect(outcome.tr === null || (await layout.edit(outcome.tr))).toBe(true)
			}

			expect(await partXml(await reopened.save())).toBe(await partXml(await inSession.layout.save()))
		}
	})

	it("leaves out a row's property element its resolved insertion leaves empty", async () => {
		const { bytes } = await edited(
			docx(GRID3),
			session => {
				session.context.review.tracking = true
				session.context.identity.author = "Ann Author"
				select(session, "b2")
			},
			[{ type: "table.row.insertBelow" }]
		)

		for (const accept of [true, false]) {
			const layout = await editedLayout(bytes)
			const outcome = resolveChanges(layout.session, storyReviewIndex(layout.session), { all: true }, accept)

			expect(outcome.tr !== null && (await layout.edit(outcome.tr))).toBe(true)

			const xml = await partXml(await layout.save())

			expect(xml).not.toMatch(/<w:trPr><\/w:trPr>/)
			if (!accept) expect(xml).toBe(await partXml(docx(GRID3)))
		}
	})

	it("models new rows and cells on a copy of another part's, and reports a copied cell's fill and alignment", async () => {
		const copiedTable = tbl(
			[3000],
			[
				tr(
					[
						tc(
							"x1",
							`${W(3000)}<w:shd w:val="clear" w:color="auto" w:fill="DDDDDD" w:themeFill="accent1" w:themeFillTint="33"/><w:vAlign w:val="center"/>`
						)
					],
					'<w:cantSplit/><w:trHeight w:val="700"/>'
				)
			]
		)
		const opened = await openSpec({
			body: copiedTable + p("End") + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
			headers: { rIdH: p("Head") }
		})
		const story = opened.context.model.stories.find(entry => entry.kind === "header")

		if (story === undefined) throw new Error("no header")

		const body = new DocxEditorSession(opened.context)
		const header = new DocxEditorSession(opened.context, { story })
		const copied = body.state.doc.slice(0, body.state.doc.child(0).nodeSize)

		header.dispatch(header.state.tr.setSelection(TextSelection.create(header.state.doc, textPos(header.state.doc, "Head"))))
		expect(
			header.dispatch(
				header.state.tr.replaceSelection(
					freshSlice(copied, sourceCopies(opened.context), body.story.part.index, header.story.part.index)
				)
			)
		).toBe(true)
		select(header, "x1")
		// The copy's fill is a theme colour: reported as that.
		expect(header.snapshot().context.table).toMatchObject({ shading: "theme:accent1/tint:51", vAlign: "center" })

		expect(header.execute({ type: "table.row.insertBelow" })).toBe(true)
		select(header, "x1")
		expect(header.execute({ type: "table.column.insertRight" })).toBe(true)
		// While tracking too, and split.
		header.context.review.tracking = true
		header.context.identity.author = "Ann Author"
		select(header, "x1")
		expect(header.execute({ type: "table.row.insertAbove" })).toBe(true)
		header.context.review.tracking = false
		select(header, "x1")
		expect(header.execute({ type: "table.cell.split", rows: 1, cols: 2 })).toBe(true)

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [body, header] })
		const xml = await partXml(result.bytes as Uint8Array, "word/header1.xml")

		// Three rows, each with the copied row's properties; seven cells, each with the copied cell's fill.
		expect(xml.match(/<w:trPr><w:cantSplit\/><w:trHeight w:val="700"\/>(?:<w:ins [^>]*\/>)?<\/w:trPr>/g)).toHaveLength(3)
		expect(xml.match(/w:fill="DDDDDD" w:themeFill="accent1" w:themeFillTint="33"\/><w:vAlign w:val="center"\/>/g)).toHaveLength(7)
	})

	it("has the fuzz's tracked table commands leave the track switch as it was", async () => {
		const session = new DocxEditorSession((await openBytes(docx(GRID3))).context)
		const op = tableOps.find(entry => entry.name === "tableTracked")

		if (op === undefined) throw new Error("no op")

		for (const on of [true, false]) {
			session.context.review.tracking = on

			for (let seed = 0; seed < 4; seed++) {
				let state = seed + 1

				await op.run({
					rand: () => (state = (state * 16807) % 2147483647) / 2147483647,
					session,
					editor: undefined,
					numIds: [],
					styleIds: [],
					transact: () => "noop",
					execute: (_label, command) => String(session.execute(command))
				})
				expect(session.context.review.tracking).toBe(on)
			}
		}
	})

	it("drops the tracked state of a pasted copy of a tracked row", async () => {
		const opened = await openBytes(docx(GRID3))
		const session = new DocxEditorSession(opened.context)

		session.context.review.tracking = true
		session.context.identity.author = "Ann Author"
		select(session, "b2")
		expect(session.execute({ type: "table.row.insertBelow" })).toBe(true)
		select(session, "b1")
		expect(session.execute({ type: "table.row.delete" })).toBe(true)
		session.context.review.tracking = false

		// Rows 1 (deleted) to 3 (inserted), pasted after the table.
		const doc = session.state.doc
		const slice = doc.slice(textPos(doc, "a1"), textPos(doc, "c2") + 1)
		const after = textPos(doc, "After")

		session.dispatch(session.state.tr.setSelection(TextSelection.create(doc, after)))
		expect(session.dispatch(session.state.tr.replaceSelection(slice))).toBe(true)

		const tables: Node[] = []

		session.state.doc.descendants(node => {
			if (node.type === nodes.table) tables.push(node)

			return node.type !== nodes.table
		})

		const bits = (table: Node | undefined): number[] => {
			const out: number[] = []

			table?.forEach(row => {
				out.push(row.attrs["revision"] as number)
				row.forEach(cell => out.push(cell.attrs["revision"] as number))
			})

			return out
		}

		expect(tables).toHaveLength(2)
		expect(bits(tables[1]).every(value => value === 0)).toBe(true)

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })

		expect(result.bytes).toBeDefined()
	})

	it("refuses rows a host's paste puts into a row a vertical merge runs through", async () => {
		const session = new DocxEditorSession((await openBytes(docx(`${GRID3}${p("")}${MERGED}`))).context)
		const doc = session.state.doc
		// Two rows of the first table, open at both ends (from inside b1 to inside b2).
		const rows = doc.slice(textPos(doc, "b1") + 1, textPos(doc, "b2") + 1)
		const pasteAt = (text: string): boolean => {
			const at = textPos(session.state.doc, text) + 1

			return session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, at)).replaceSelection(rows))
		}

		expect(rows.content.firstChild?.type).toBe(nodes.table_row)
		// b4's row (of the second table) is one a2's merge runs through: splitting it would leave the merge
		// continuing under no merge. The first table has no merges.
		expect(pasteAt("b4")).toBe(false)
		expect(pasteAt("c3")).toBe(true)
	})

	it("leaves rows a merge runs through to the row command", async () => {
		const layout = await editedLayout(docx(MERGED))
		const doc = layout.session.state.doc
		const table = firstTable(doc)
		let tablePos = -1

		doc.descendants((node, pos) => {
			if (node === table) tablePos = pos

			return tablePos < 0
		})

		const map = tableMap(table, layout.session.story.part, layout.context.store)

		// A host's own steps removing the row the merge starts in, or the one above it (allowed), or the whole table.
		expect(await layout.edit(layout.session.state.tr.delete(map.rowPos(tablePos, 1), map.rowPos(tablePos, 2)))).toBe(false)
		// A cell taken out of a row under which a merge continues.
		expect(
			await layout.edit(
				layout.session.state.tr.delete(map.cellPos(tablePos, 1, 2), map.cellPos(tablePos, 1, 2) + map.cell(1, 2).nodeSize)
			)
		).toBe(false)
		expect(await layout.edit(layout.session.state.tr.delete(map.rowPos(tablePos, 0), map.rowPos(tablePos, 1)))).toBe(true)
		expect(shape(firstTable(layout.session.state.doc))).toEqual(["a2:1:r b2:1 c2:1", ":1:c b3:1 c3:1", ":1:c b4:1 c4:1"])

		const saved = await layout.save()

		expect(pageDigest(layout.layout)).toEqual(await savedDigest(saved))
		expect(shape((await reopen(saved)).table)).toEqual(["a2:1:r b2:1 c2:1", ":1:c b3:1 c3:1", ":1:c b4:1 c4:1"])

		const whole = layout.session.state.tr.delete(tablePos, tablePos + firstTable(layout.session.state.doc).nodeSize)

		expect(await layout.edit(whole)).toBe(true)
	})

	it("keeps spans and merges for table commands", async () => {
		const session = new DocxEditorSession((await openBytes(docx(GRID3))).context)
		const doc = session.state.doc
		let cellPos = -1

		doc.descendants((node, pos) => {
			if (cellPos < 0 && node.type === nodes.table_cell) cellPos = pos

			return cellPos < 0
		})

		expect(session.dispatch(session.state.tr.setNodeAttribute(cellPos, "colspan", 2))).toBe(false)
		expect(session.dispatch(session.state.tr.setNodeAttribute(cellPos, "vMerge", "restart"))).toBe(false)
		expect(session.dispatch(session.state.tr.step(new SetAttrsStep([{ pos: cellPos, attrs: { colspan: 2 } }])))).toBe(false)

		select(session, "a1")
		expect(session.execute({ type: "table.column.insertLeft" })).toBe(true)
		expect(session.execute({ type: "history.undo" })).toBe(true)
		expect(session.state.doc.eq(doc)).toBe(true)
	})

	it("reports the table at the selection, the same object while it is the same", async () => {
		const session = new DocxEditorSession((await openBytes(docx(MERGED))).context)

		select(session, "b3")

		const first = session.snapshot().context.table

		expect(first).toMatchObject({
			rows: 4,
			columns: 3,
			fromRow: 2,
			toRow: 3,
			fromColumn: 1,
			toColumn: 2,
			mergeable: false,
			splittable: true,
			headerRow: false,
			depth: 0,
			widths: [2000, 2000, 2000],
			align: null,
			vAlign: null,
			shading: null
		})

		session.dispatch(session.state.tr.insertText("x"))
		expect(session.snapshot().context.table).toBe(first)

		select(session, "b2", "c3")
		expect(session.snapshot().context.table).toMatchObject({ fromRow: 1, toRow: 3, mergeable: true, splittable: false })

		// The merge at a2 makes the selection grow to whole merged cells.
		select(session, "b1", "a2")
		expect(session.snapshot().context.table).toMatchObject({ fromColumn: 0, toColumn: 2, mergeable: true })
		expect(session.snapshot().enabled["table.cells.merge"]).toBe(true)

		select(session, "Before")
		expect(session.snapshot().context.table).toBeNull()
		expect(session.snapshot().enabled["table.row.insertBelow"]).toBe(false)
		expect(session.snapshot().enabled["table.insert"]).toBe(true)
	})

	it("takes back a table a save refused as a unit", async () => {
		const opened = await openBytes(docx(GRID3))
		const session = new DocxEditorSession(opened.context)

		select(session, "After")
		expect(session.execute({ type: "table.insert", rows: 2, cols: 2 })).toBe(true)
		select(session, "b2")
		expect(session.execute({ type: "table.row.insertBelow" })).toBe(true)
		select(session, "b1")
		session.dispatch(session.state.tr.insertText("typed "))

		const keys = TABLE_UNITS.edited(session)

		expect(keys.filter(key => key < 0)).toHaveLength(1)
		expect(keys.filter(key => key >= 0)).toHaveLength(1)

		const trial = TABLE_UNITS.withReverted(session, keys)
		let tables = 0

		trial.state.doc.descendants(node => {
			if (node.type === nodes.table) tables++

			return true
		})

		expect(tables).toBe(1)
		expect(shape(firstTable(trial.state.doc))).toEqual(["a1:1 b1:1 c1:1", "a2:1 b2:1 c2:1", "a3:1 b3:1 c3:1"])
		expect(TABLE_UNITS.revert(session, keys)).toBe(2)
		expect(shape(firstTable(session.state.doc))).toEqual(["a1:1 b1:1 c1:1", "a2:1 b2:1 c2:1", "a3:1 b3:1 c3:1"])
	})
})

describe("gate 2 table checks", () => {
	async function check(source: string, written: string): Promise<unknown> {
		const opened = await openBytes(docx(source))
		const part = opened.model.parts[opened.model.body?.part ?? 0]
		const document = parseXml(encodeUtf8((await partXml(docx(written))).replace("<w:body>", "<w:body>")))
		const input = { original: opened.pkg, changes: { stories: [] } } as unknown as CheckInput

		try {
			await tableChecks[0]?.part?.(input, { name: "word/document.xml", part, document, skeleton: false })

			return undefined
		} catch (error) {
			return error instanceof DocxVerifyError ? { reason: error.reason, message: error.message } : error
		}
	}

	const orphan = tbl([2000, 2000], [tr([tc("a"), tc("b")]), tr([tc("", "<w:vMerge/>"), tc("d")])])
	const wide = tbl([2000], [tr([tc("a"), tc("b")])])

	it("reads a long table a few rows at a time in a sliced save, merges carried across", async () => {
		const opened = await openBytes(docx(GRID3))
		const part = opened.model.parts[opened.model.body?.part ?? 0]
		// A merge from row 30 to row 34, across a slice; `orphanAt` continues one under no merge.
		const long = (orphanAt: number): string =>
			tbl(
				[2000, 2000],
				Array.from({ length: 200 }, (_, row) =>
					tr([
						tc(
							"",
							row === 30 ? '<w:vMerge w:val="restart"/>' : (row > 30 && row <= 34) || row === orphanAt ? "<w:vMerge/>" : ""
						),
						tc("b")
					])
				)
			)
		const run = async (orphanAt: number): Promise<{ pauses: number; refused: boolean }> => {
			let pauses = 0
			const clock = new SliceClock({ sliceMs: 0, now: () => 0, pause: () => Promise.resolve(void pauses++) })
			const document = parseXml(encodeUtf8(await partXml(docx(long(orphanAt)))))
			const input = { original: opened.pkg, changes: { stories: [] }, clock } as unknown as CheckInput

			try {
				await tableChecks[0]?.part?.(input, { name: "word/document.xml", part, document, skeleton: false })

				return { pauses, refused: false }
			} catch (error) {
				if (!(error instanceof DocxVerifyError)) throw error

				return { pauses, refused: true }
			}
		}

		const whole = await run(-1)

		expect(whole.refused).toBe(false)
		// 200 rows checked 32 at a time.
		expect(whole.pauses).toBeGreaterThanOrEqual(6)
		expect((await run(100)).refused).toBe(true)
	})

	it("refuses rows wider than the grid and merges continuing under no merge", async () => {
		expect(await check(GRID3, GRID3)).toBeUndefined()
		expect(await check(GRID3, orphan)).toEqual({
			reason: "content",
			message: "word/document.xml: a vertical merge continues under no merge"
		})
		expect(await check(GRID3, wide)).toEqual({ reason: "content", message: "word/document.xml: a table row is wider than its grid" })
		expect(
			await check(
				GRID3,
				tbl(
					[2000],
					[
						tr([
							'<w:tc><w:tcPr/><w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="10"/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl></w:tc>'
						])
					]
				)
			)
		).toEqual({
			reason: "content",
			message: "word/document.xml: a table cell does not end with a paragraph"
		})
		expect(await check(GRID3, tbl([2000], [tr([tc("a")], '<w:ins w:id="5"/>')]))).toEqual({
			reason: "content",
			message: "word/document.xml: a tracked table, row or cell change has no id, author or previous properties"
		})
	})

	it("reads the source copies a rewritten table holds from the source part", async () => {
		const opened = await openBytes(docx(GRID3))
		const part = opened.model.parts[opened.model.body?.part ?? 0]

		if (part === undefined) throw new Error("No body part")

		const source = part.document
		const text = decoder.decode(source.bytes)
		// The source's w:tblPr through its first row: one span copied whole, as the writer copies it.
		const from = text.indexOf("<w:tblPr>")
		const to = text.indexOf("</w:tr>") + "</w:tr>".length
		const skeleton = (row: string): CheckInput["changes"]["stories"][number]["output"] => ({
			bytes: encodeUtf8(row),
			trusted: [0, 0, from, to],
			paragraphs: [],
			containers: []
		})
		const run = async (row: string): Promise<unknown> => {
			const document = parseXml(
				encodeUtf8(
					`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><_/>${row}</w:tbl></w:body></w:document>`
				)
			)
			const input = {
				original: opened.pkg,
				changes: { stories: [{ part, output: skeleton(row), session: { story: { story: opened.model.body } } }] }
			} as unknown as CheckInput

			try {
				await tableChecks[0]?.part?.(input, { name: "word/document.xml", part, document, skeleton: true })

				return undefined
			} catch (error) {
				return error instanceof DocxVerifyError ? error.message : error
			}
		}

		expect(await run(tr([tc("x"), tc("y"), tc("z")]))).toBeUndefined()
		// Under a source row whose cells take part in no merge, and one cell too many for the source's grid.
		expect(await run(tr([tc("x", "<w:vMerge/>"), tc("y"), tc("z")]))).toBe(
			"word/document.xml: a vertical merge continues under no merge"
		)
		expect(await run(tr([tc("x"), tc("y"), tc("z"), tc("w")]))).toBe("word/document.xml: a table row is wider than its grid")
	})

	it("lets through what the source had already", async () => {
		expect(await check(orphan, orphan)).toBeUndefined()
		expect(await check(wide, wide)).toBeUndefined()
		expect(await check(wide, wide + wide)).toEqual({
			reason: "content",
			message: "word/document.xml: a table row is wider than its grid"
		})
	})
})

// The licensed real-world corpus is kept out of the repository (pnpm run corpus:fetch).
const TABLE_FILES = ["docx", "docm", "dotx", "dotm"].flatMap(extension => {
	const directory = join(CORPUS_DIR, extension)

	return existsSync(directory)
		? readdirSync(directory)
				.sort()
				.map(name => join(directory, name))
		: []
})

describe.skipIf(TABLE_FILES.length === 0)("table commands over the real-world corpus", () => {
	it("deletes the row Word deleted in WC023 as Word did", async () => {
		const before = TABLE_FILES.find(file => file.endsWith("oxpt__WC023-Table-4-Row-Image-Before.docx"))
		const after = TABLE_FILES.find(file => file.endsWith("oxpt__WC023-Table-4-Row-Image-After-Delete-1-Row.docx"))

		if (before === undefined || after === undefined) return

		const opened = await openBytes(new Uint8Array(readFileSync(before)))
		const session = new DocxEditorSession(opened.context, { proof: writerProof(opened.context) })
		const structure = (table: Node): string[] => shape(table, false)
		const expected = structure((await reopen(new Uint8Array(readFileSync(after)))).table)
		const table = firstTable(session.state.doc)
		const rows = structure(table)
		// The row Word deleted, as far as the structure tells.
		const index = rows.findIndex((_row, k) => [...rows.slice(0, k), ...rows.slice(k + 1)].join("/") === expected.join("/"))
		let pos = -1

		expect(index).toBeGreaterThanOrEqual(0)
		session.state.doc.descendants((node, at) => {
			if (pos < 0 && node === table.child(index)) pos = at

			return pos < 0
		})

		session.dispatch(session.state.tr.setSelection(TextSelection.near(session.state.doc.resolve(pos + 3))))
		expect(session.execute({ type: "table.row.delete" })).toBe(true)

		const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })

		expect(structure((await reopen(result.bytes as Uint8Array)).table)).toEqual(expected)
	})

	it("reads every table back as the editor holds it after the scripted table edits", { timeout: 600_000 }, async () => {
		const failures: string[] = []
		const scripts = tableOps.filter(op => op.script !== undefined).sort((a, b) => (a.script?.order ?? 0) - (b.script?.order ?? 0))
		const tables = (doc: Node): string[] => {
			const out: string[] = []

			doc.descendants(node => {
				if (node.type === nodes.table) out.push(shape(node, false).join("/"))

				return !node.isTextblock
			})

			return out
		}
		let edited = 0

		for (const file of TABLE_FILES) {
			let opened: Opened

			try {
				opened = await openBytes(new Uint8Array(readFileSync(file)))
			} catch {
				continue
			}

			if (opened.model.body === undefined || opened.context.gate.length > 0) continue

			const session = new DocxEditorSession(opened.context, { proof: writerProof(opened.context) })

			if (tables(session.state.doc).length === 0) continue

			const done = scripts.filter(op => op.script?.run({ session, story: () => undefined }) === true)

			if (done.length === 0) continue

			edited++

			try {
				const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })
				const back = await openBytes(result.bytes as Uint8Array)
				const body = back.model.body

				if (body === undefined) throw new Error("no body")

				const read = tables(new DocxDocBuilder(back.context).build(body).doc)

				if (read.join("|") !== tables(session.state.doc).join("|")) failures.push(`${file}: tables read back differently`)
			} catch (error) {
				failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}

		expect(edited).toBeGreaterThan(0)
		expect(failures).toEqual([])
	})

	it("has the fuzz's own reader take a cell ending in a content control around a paragraph as Word writes it", () => {
		const cellEnding = (inner: string): number | undefined => {
			const xml = `<w:document xmlns:w="${W_NAMESPACE}"><w:body><w:tbl><w:tr><w:tc><w:tcPr/>${inner}</w:tc></w:tr></w:tbl><w:p/></w:body></w:document>`

			return violations(parseIndependent(new TextEncoder().encode(xml)), {}).counts.get("tc-notEndingInP")
		}
		const nested = "<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>"

		expect(cellEnding(`${nested}<w:sdt><w:sdtPr/><w:sdtContent><w:p/></w:sdtContent></w:sdt>`)).toBeUndefined()
		expect(cellEnding('<w:customXml w:element="x"><w:p/></w:customXml>')).toBeUndefined()
		expect(cellEnding(nested)).toBe(1)
		expect(cellEnding(`<w:p/><w:sdt><w:sdtPr/><w:sdtContent>${nested}</w:sdtContent></w:sdt>`)).toBe(1)
	})
})
