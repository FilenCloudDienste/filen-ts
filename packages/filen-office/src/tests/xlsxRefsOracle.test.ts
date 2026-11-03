import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { unzipSync } from "fflate"
import { bytesSource } from "../core/opc/index"
import { decodeUtf8, parseXml, type XmlDocument } from "../core/xml/index"
import { FormulaKind } from "../core/xlsx/model/types"
import { openXlsx, type XlsxWorkbook } from "../core/xlsx/read/index"
import { planRefEdit, type RefEdit } from "../core/xlsx/refs/index"
import { saveXlsx } from "../core/xlsx/write/save"
import { CORPUS_DIR } from "./corpusDir"
import { sheetOffices, unoOffice } from "./oracles/sheet/libreOffice"
import { UnoSheets, type UnoOperation } from "./oracles/sheet/unoSheets"
import { TYPES, relationship } from "./xlsxRefsFixtures"
import { buildFixture, type Fixture } from "./xlsxWriteFixtures"

// The catalogue against LibreOffice: the same structure operation replayed by LibreOffice over UNO on the source
// file (insert/delete rows and columns, delete and move sheets), its xlsx re-save read into the same normalised
// constructs as our save (cell formulas, merges, conditional formats, validations, hyperlinks, autofilter, page
// breaks, defined names, tables, drawing anchors, chart formulas, notes). Every difference must be one listed below
// with its reason (Excel's documented behaviour breaks a tie). Opt-in: FILEN_OFFICE_SOFFICE=<soffice>[,<soffice>].

const UNO = unoOffice(sheetOffices())
const SCRATCH = join(tmpdir(), "filen-office-xlsx-refs-oracle")

interface Constructs {
	readonly [key: string]: string
}

function elements(document: XmlDocument, local: string): number[] {
	const out: number[] = []
	const walk = (node: number): void => {
		if (document.localName(node) === local) out.push(node)

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) walk(child)
	}

	walk(document.documentElement())

	return out
}

// Formula text as both writers spell it: no quotes a plain sheet name does not need, upper case outside strings.
function normal(formula: string): string {
	return formula
		.replace(/^=/, "")
		.replace(/'([A-Za-z_][A-Za-z0-9_. ]*)'!/g, (_, name: string) => (name.includes(" ") ? `'${name}'!` : `${name}!`))
		.replace(/"[^"]*"|[^"]+/g, part => (part.startsWith('"') ? part : part.toUpperCase()))
}

function sqref(text: string): string {
	return text.trim().split(/\s+/).sort().join(" ")
}

// Every construct of a saved package, normalised, by "sheet/kind".
async function constructs(bytes: Uint8Array): Promise<Constructs> {
	const opened = await openXlsx(bytesSource(bytes))

	if (!opened.ok) throw new Error(`does not open: ${opened.reason}`)

	const workbook: XlsxWorkbook = opened.workbook
	const files = unzipSync(bytes)
	const text = (name: string): string | undefined => {
		const data = files[name.replace(/^\//, "")]

		return data === undefined ? undefined : decodeUtf8(data)
	}
	const out: Record<string, string> = {}
	const put = (key: string, values: readonly string[]): void => {
		const unique = [...new Set(values)].sort()

		if (unique.length > 0) out[key] = unique.join("\n")
	}

	for (const entry of workbook.sheets) {
		if (entry.kind !== "worksheet") continue

		const model = await workbook.load(entry.id)
		const table = model.store.formulas
		const formulas: string[] = []

		for (const block of model.store.blocks) {
			for (let i = 0; i < block.rowCount; i++) {
				const row = block.firstRow + (block.rows[i] ?? 0)
				const end = block.rowStarts[i + 1] ?? 0

				for (let k = block.rowStarts[i] ?? 0; k < end; k++) {
					const id = block.formulas?.[k] ?? -1

					if (id < 0) continue

					const col = block.cols[k] ?? 0
					const formula = table.kind(id) === FormulaKind.SHARED_CHILD ? table.expanded(id, row, col) : table.text(id)

					formulas.push(`${row},${col} ${normal(formula)}`)
				}
			}
		}

		const sheet = entry.name

		put(`${sheet}/formulas`, formulas)
		put(
			`${sheet}/merges`,
			Array.from({ length: model.merges.length / 4 }, (_, k) => [...model.merges.subarray(k * 4, k * 4 + 4)].join(","))
		)

		const part = text(entry.part) ?? ""
		const document = parseXml(new TextEncoder().encode(part))
		const read = (local: string, describe: (node: number) => string) =>
			put(`${sheet}/${local}`, elements(document, local).map(describe))

		read("conditionalFormatting", node =>
			[
				sqref(document.attribute(node, "sqref") ?? ""),
				...elements(document, "formula")
					.filter(formula => document.parent(document.parent(formula)) === node)
					.map(formula => normal(document.textContent(formula)))
			].join(" | ")
		)
		read("dataValidation", node =>
			[
				sqref(document.attribute(node, "sqref") ?? ""),
				...["formula1", "formula2"].map(local => {
					const child = elements(document, local).find(candidate => document.parent(candidate) === node)
					// LibreOffice writes a formula2 of 0 for operators that take one value.
					const value = child === undefined ? "" : normal(document.textContent(child))

					return local === "formula2" && value === "0" ? "" : value
				})
			].join(" | ")
		)
		read("hyperlink", node => `${document.attribute(node, "ref") ?? ""} ${normal(document.attribute(node, "location") ?? "")}`)
		read("autoFilter", node => document.attribute(node, "ref") ?? "")
		read("brk", node => `${document.localName(document.parent(node))} ${document.attribute(node, "id") ?? ""}`)

		for (const relationshipEntry of model.relationships.all) {
			const target = relationshipEntry.partName

			if (relationshipEntry.external || target === undefined) continue

			const type = relationshipEntry.type.slice(relationshipEntry.type.lastIndexOf("/") + 1)
			const related = text(target)

			if (related === undefined || !["comments", "table", "drawing"].includes(type)) continue

			const doc = parseXml(new TextEncoder().encode(related))

			if (type === "comments")
				put(
					`${sheet}/comments`,
					elements(doc, "comment").map(node => doc.attribute(node, "ref") ?? "")
				)
			if (type === "table")
				put(`${sheet}/tables`, [
					`${doc.attribute(doc.documentElement(), "ref") ?? ""} ${elements(doc, "tableColumn")
						.map(column => doc.attribute(column, "name") ?? "")
						.join(",")}`
				])
			if (type === "drawing")
				put(
					`${sheet}/anchors`,
					[...elements(doc, "twoCellAnchor"), ...elements(doc, "oneCellAnchor")].map(anchor =>
						["from", "to"]
							.map(edge => {
								const node = elements(doc, edge).find(candidate => doc.parent(candidate) === anchor)

								if (node === undefined) return ""

								const value = (local: string) =>
									doc.textContent(elements(doc, local).find(candidate => doc.parent(candidate) === node) ?? -1)

								return `${value("col")},${value("row")}`
							})
							.join("-")
					)
				)
		}
	}

	put(
		"names",
		workbook.definedNames
			.filter(name => !name.name.startsWith("_xlnm._FilterDatabase"))
			.map(name => `${name.name}@${name.sheet ?? ""} ${normal(name.formula)}`)
	)

	const charts: string[] = []

	for (const name of Object.keys(files)) {
		if (!/^xl\/charts\/chart\d+\.xml$/.test(name)) continue

		const doc = parseXml(files[name] as Uint8Array)

		for (const node of elements(doc, "f")) charts.push(normal(doc.textContent(node)))
	}

	put("charts", charts)

	return out
}

function differences(ours: Constructs, theirs: Constructs): string[] {
	const keys = new Set([...Object.keys(ours), ...Object.keys(theirs)])
	const out: string[] = []

	for (const key of [...keys].sort()) {
		if (ours[key] === theirs[key]) continue

		const a = new Set((ours[key] ?? "").split("\n"))
		const b = new Set((theirs[key] ?? "").split("\n"))

		out.push(
			`${key}: ours only [${[...a].filter(value => !b.has(value) && value !== "").join("; ")}] LibreOffice only [${[...b].filter(value => !a.has(value) && value !== "").join("; ")}]`
		)
	}

	return out
}

// Differences that are LibreOffice's, not ours, each with why (a pattern over the difference line).
// Keys whose constructs LibreOffice already changes on a re-save without any operation (its round trip: internal
// hyperlinks, anchors recomputed from its own row heights) are compared no further; they are logged.
const ACCEPTED: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
	{
		pattern: /\/dataValidation: ours only \[[^\]]*\] LibreOffice only \[[^\]]*\]$/,
		reason: "LibreOffice leaves validation formulas where they were; their references move as cell formulas do (ECMA-376 Part 1 §18.3.1.32, formula1 relative to the range's top-left cell)"
	},
	{
		pattern: /\/conditionalFormatting: ours only \[[^|]*\| [^\]]*\] LibreOffice only \[[^|]*\| #REF!/,
		reason: "the rule formula is relative to the range's top-left cell (ECMA-376 Part 1 §18.3.1.10): with that cell deleted it is written for the new top-left, where LibreOffice keeps the deleted reference"
	},
	{
		pattern: /\/conditionalFormatting: ours only \[(\S+) \| [^\]]*\] LibreOffice only \[\S+ \|/,
		reason: "LibreOffice gives an inserted column the format of the column to its left, conditional formats included: Excel's Insert Options default, which the structure command applies, not the reference catalogue"
	},
	{
		pattern: /formulas: ours only \[[^\]]*[A-Z]!#REF![^\]]*\] LibreOffice only \[[^\]]*#REF!/,
		reason: "Excel keeps the sheet name of a deleted area (Sheet!#REF!); LibreOffice writes #REF! alone"
	},
	{
		pattern: /(formulas|names): ours only \[[^\]]*#REF![A-Z$]+[0-9][^\]]*\] LibreOffice only \[[^\]]*#REF!/,
		reason: "Excel writes a reference to a deleted sheet as #REF! followed by the cell (#REF!A1); LibreOffice drops the cell"
	},
	{
		pattern: /\/tables: ours only \[\S+ [^\]]*Column1[^\]]*\] LibreOffice only \[\S+ [^\]]*Column\d/,
		reason: "a new table column takes the first unused ColumnN name; LibreOffice numbers it by position"
	},
	{
		pattern: /\/formulas: ours only \[[^\]]*#REF!\+TAB\[/,
		reason: "a structured reference to a deleted table column becomes #REF! (support.microsoft.com, Using structured references with Excel tables); LibreOffice points it at another column"
	},
	{
		pattern: /\/anchors: ours only \[(\d+),(\d+)-(\d+),\d+\] LibreOffice only \[\1,\2-\3,\d+\]$/,
		reason: "an object a column edit moves is anchored again by LibreOffice from its own row heights: its bottom row differs by the rounding of the offset, the columns agree"
	},
	{
		pattern: /^charts: ours only \[[^\]]*#REF![^\]]*\] LibreOffice only \[\]$/,
		reason: "Excel keeps a series whose range was deleted, its formula reading #REF!; LibreOffice drops the range"
	}
]

interface Case {
	readonly name: string
	readonly source: () => Uint8Array | null
	readonly edits: readonly { readonly ours: (workbook: XlsxWorkbook) => RefEdit; readonly theirs: UnoOperation }[]
}

const DATA =
	'<sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="B4" sqref="B4"/></sheetView></sheetViews>' +
	'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row><row r="2"><c r="A2"><v>3</v></c></row>' +
	'<row r="3"><c r="A3"><f>SUM(A1:A2)</f><v>4</v></c><c r="B3"><f>A$1*$B1+A2</f><v>5</v></c><c r="C3"><f t="shared" ref="C3:C6" si="0">A3+A1</f><v>5</v></c></row>' +
	'<row r="4"><c r="A4"><v>6</v></c><c r="C4"><f t="shared" si="0"/><v>0</v></c></row><row r="5"><c r="A5"><v>7</v></c><c r="C5"><f t="shared" si="0"/><v>0</v></c></row>' +
	'<row r="6"><c r="A6"><f>SUM(A2:A5)</f><v>0</v></c><c r="C6"><f t="shared" si="0"/><v>0</v></c></row><row r="8"><c r="E8"><f>SUM(A:A)</f><v>0</v></c></row></sheetData>' +
	'<mergeCells count="2"><mergeCell ref="E2:F3"/><mergeCell ref="E5:E6"/></mergeCells>' +
	'<conditionalFormatting sqref="A2:A6"><cfRule type="expression" dxfId="0" priority="1"><formula>A2&gt;$B$1</formula></cfRule></conditionalFormatting>' +
	'<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="B5:B6"><formula1>$A$1:$A$4</formula1></dataValidation></dataValidations>' +
	'<hyperlinks><hyperlink ref="F8" location="Data!A4" display="go"/></hyperlinks>' +
	'<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><rowBreaks count="1" manualBreakCount="1"><brk id="4" max="16383" man="1"/></rowBreaks>'
const STYLES =
	'<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
	'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
	'<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
	'<dxfs count="1"><dxf><font><b/></font></dxf></dxfs>'
const SHEETS: Fixture = {
	sheets: [
		{ name: "Data", body: DATA },
		{ name: "Other", body: '<sheetData><row r="1"><c r="A1"><f>Data!A3+SUM(Data!A2:A6)</f><v>0</v></c></row></sheetData>' },
		{ name: "Last", body: '<sheetData><row r="1"><c r="A1"><f>Other!A1*2</f><v>0</v></c></row></sheetData>' }
	],
	styles: STYLES,
	workbookTail:
		'<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$F$8</definedName><definedName name="block">Data!$A$2:$B$5</definedName><definedName name="far">Other!$A$1</definedName></definedNames>'
}
const TABLE: Fixture = {
	sheets: [
		{
			name: "Data",
			body:
				'<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
				'<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c><c r="C2"><f>Tab[[#This Row],[One]]+Tab[[#This Row],[Two]]</f><v>3</v></c></row>' +
				'<row r="3"><c r="A3"><v>4</v></c><c r="B3"><v>5</v></c><c r="C3"><f>Tab[[#This Row],[One]]+Tab[[#This Row],[Two]]</f><v>9</v></c></row>' +
				'<row r="6"><c r="E6"><f>SUM(Tab[Two])</f><v>7</v></c></row></sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts>',
			rels: relationship("rId1", "table", "../tables/table1.xml")
		}
	],
	styles: STYLES,
	sharedStrings:
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><t>One</t></si><si><t>Two</t></si><si><t>Sum</t></si></sst>',
	parts: {
		"xl/tables/table1.xml": {
			text:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Tab" displayName="Tab" ref="A1:C3">' +
				'<autoFilter ref="A1:C3"/><tableColumns count="3"><tableColumn id="1" name="One"/><tableColumn id="2" name="Two"/><tableColumn id="3" name="Sum">' +
				"<calculatedColumnFormula>Tab[[#This Row],[One]]+Tab[[#This Row],[Two]]</calculatedColumnFormula></tableColumn></tableColumns>" +
				'<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>',
			type: TYPES.table
		}
	}
}

function corpus(relative: string): () => Uint8Array | null {
	return () => {
		const path = join(CORPUS_DIR, relative)

		return existsSync(path) ? new Uint8Array(readFileSync(path)) : null
	}
}

const AXIS: readonly [RefEdit["kind"], "insert" | "delete", "rows" | "cols", number, number][] = [
	["axis", "insert", "rows", 2, 2],
	["axis", "delete", "rows", 1, 2],
	["axis", "insert", "cols", 1, 1],
	["axis", "delete", "cols", 0, 1]
]

function axisEdits(sheet: number) {
	return AXIS.map(([, type, axis, at, count]) => ({
		ours: (workbook: XlsxWorkbook): RefEdit => ({
			kind: "axis",
			sheet: workbook.sheets[sheet]?.id ?? sheet,
			shift: { type, axis, at, count }
		}),
		theirs: {
			op: `${type}${axis === "rows" ? "Rows" : "Columns"}` as "insertRows" | "deleteRows" | "insertColumns" | "deleteColumns",
			sheet,
			at,
			count
		}
	}))
}

const CASES: readonly Case[] = [
	{
		name: "sheet constructs",
		source: () => buildFixture(SHEETS),
		edits: [
			...axisEdits(0),
			{ ours: workbook => ({ kind: "deleteSheet", sheet: workbook.sheets[1]?.id ?? 1 }), theirs: { op: "deleteSheet", sheet: 1 } },
			{
				ours: workbook => ({ kind: "moveSheet", sheet: workbook.sheets[0]?.id ?? 0, to: 2 }),
				theirs: { op: "moveSheet", sheet: 0, to: 2 }
			}
		]
	},
	{
		name: "table",
		source: () => buildFixture(TABLE),
		edits: axisEdits(0)
	},
	{ name: "chart", source: corpus("xlsx/xlsxwriter__chart_pie01.xlsx"), edits: axisEdits(0) },
	{ name: "comments", source: corpus("xlsx/xlsxwriter__comment01.xlsx"), edits: axisEdits(0) },
	{ name: "corpus table", source: corpus("xlsx/xlsxwriter__table10.xlsx"), edits: axisEdits(0) },
	{ name: "charts and tables", source: corpus("xlsx/poi__DataTableCities.xlsx"), edits: axisEdits(0) },
	{ name: "conditional formats", source: corpus("xlsx/closedxml__cond_format_theme_color2.xlsx"), edits: axisEdits(0) }
]

// Our side of a sheet delete or move: the catalogue's plan, then the sheet list itself (as the sheet edits do).
function finishSheetEdit(workbook: XlsxWorkbook, edit: RefEdit): void {
	const changes = workbook.changes
	const index = workbook.sheets.findIndex(sheet => sheet.id === edit.sheet)
	const entry = workbook.sheets[index]

	if (entry === undefined) return

	if (edit.kind === "deleteSheet") {
		workbook.sheets.splice(index, 1)
		changes.removePart(entry.part)
		changes.removeRelationship(workbook.workbookPart, entry.relationshipId)
		changes.workbookSection("sheets")
	} else if (edit.kind === "moveSheet") {
		workbook.sheets.splice(index, 1)
		workbook.sheets.splice(edit.to, 0, entry)
		changes.workbookSection("sheets")
	}
}

describe.skipIf(UNO === undefined)("structure edits against LibreOffice", () => {
	let uno: UnoSheets

	beforeAll(() => {
		mkdirSync(SCRATCH, { recursive: true })
		uno = new UnoSheets(UNO as NonNullable<typeof UNO>, SCRATCH)
	})

	afterAll(async () => {
		await uno.close()
		rmSync(SCRATCH, { recursive: true, force: true })
	})

	for (const testCase of CASES) {
		it(`equals LibreOffice's re-save: ${testCase.name}`, { timeout: 900_000 }, async () => {
			const source = testCase.source()

			if (source === null) return

			const input = join(SCRATCH, `${testCase.name.replaceAll(" ", "-")}.xlsx`)
			const unexplained: string[] = []

			writeFileSync(input, source)

			// LibreOffice's own round trip: what a re-save without operations already changes.
			const baselineTarget = join(SCRATCH, `${testCase.name.replaceAll(" ", "-")}-base.xlsx`)
			const baseline = await uno.run({ input, saveAs: baselineTarget, maxCells: 1000 })

			expect(baseline.ok, baseline.error).toBe(true)

			const roundTrip = new Set(
				differences(await constructs(source), await constructs(new Uint8Array(readFileSync(baselineTarget)))).map(line =>
					line.slice(0, line.indexOf(":"))
				)
			)

			for (const key of roundTrip) console.log(`refs-lo ${testCase.name}: LibreOffice's re-save alone changes ${key}`)

			for (const edit of testCase.edits) {
				const opened = await openXlsx(bytesSource(source))

				if (!opened.ok) throw new Error(opened.reason)

				const workbook = opened.workbook
				const ours = edit.ours(workbook)
				const planned = await planRefEdit(workbook, ours)

				if (!planned.ok) {
					console.log(`refs-lo ${testCase.name} ${JSON.stringify(edit.theirs)}: refused ${JSON.stringify(planned.refusal)}`)

					continue
				}

				planned.plan.apply()
				finishSheetEdit(workbook, ours)

				const saved = await saveXlsx({ opc: workbook.opc, workbook })

				expect(saved.ok, JSON.stringify(saved)).toBe(true)

				const target = join(SCRATCH, `${testCase.name.replaceAll(" ", "-")}-lo.xlsx`)
				const replay = await uno.run({ input, ops: [edit.theirs], saveAs: target, maxCells: 1000 })

				expect(replay.ok, replay.error).toBe(true)
				expect(replay.ops?.[0]?.ok, replay.ops?.[0]?.error).toBe(true)

				const found = differences(
					await constructs((saved as { bytes: Uint8Array }).bytes),
					await constructs(new Uint8Array(readFileSync(target)))
				)

				for (const line of found) {
					const accepted = roundTrip.has(line.slice(0, line.indexOf(":")))
						? { reason: "LibreOffice's re-save alone changes it" }
						: ACCEPTED.find(item => item.pattern.test(line))

					console.log(
						`refs-lo ${testCase.name} ${JSON.stringify(edit.theirs)}: ${accepted === undefined ? "DIFF" : `accepted (${accepted.reason})`} ${line}`
					)

					if (accepted === undefined) unexplained.push(`${JSON.stringify(edit.theirs)} ${line}`)
				}
			}

			expect(unexplained).toEqual([])
		})
	}
})
