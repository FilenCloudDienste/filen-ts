import { describe, expect, it } from "vitest"
import { formulaTranslator } from "../core/sheet/refs/formulaRefs"
import { decodeUtf8 } from "../core/xml/index"
import { FormulaKind } from "../core/xlsx/model/types"
import { moveRelativeReferences, type XlsxWorkbook } from "../core/xlsx/read/index"
import { planRefEdit, type RefEdit, type RefPlan } from "../core/xlsx/refs/index"
import { MODEL_SECTIONS } from "../core/xlsx/refs/sections"
import { refState } from "../core/xlsx/refs/state"
import { R, TYPES, relationship, rels } from "./xlsxRefsFixtures"
import { buildFixture, changedEntries, openWorkbook, parts, saved, type Fixture } from "./xlsxWriteFixtures"
import { rng } from "./mulberry32"

// Random insert and delete sequences over a workbook holding most of the catalogue. Every step saves through the
// gate; reverting every step gives the source's bytes back; an insert followed by the delete of the same rows or
// columns gives back what every construct said; planning is a pure function of the workbook.

const RUNS = Number(process.env["FILEN_OFFICE_REFS_FUZZ_RUNS"] ?? "120")
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const xdr = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
const C = "http://schemas.openxmlformats.org/drawingml/2006/chart"

function cells(): string {
	let rows = ""

	for (let r = 1; r <= 20; r++) {
		let row = `<row r="${r}">`

		for (let c = 0; c < 8; c++) {
			const ref = `${String.fromCharCode(65 + c)}${r}`

			if (c === 4 && r === 3) row += `<c r="${ref}"><f t="shared" ref="E3:E12" si="0">A3+$B$1+SUM(A1:A3)</f><v>0</v></c>`
			else if (c === 4 && r > 3 && r <= 12) row += `<c r="${ref}"><f t="shared" si="0"/><v>0</v></c>`
			else if (c === 5 && r % 4 === 0) row += `<c r="${ref}"><f>SUM(A${r}:D${r})+A$1+Other!A${r}</f><v>0</v></c>`
			else if (c < 4) row += `<c r="${ref}"><v>${r * 10 + c}</v></c>`
		}

		rows += `${row}</row>`
	}

	return `<sheetData>${rows}</sheetData>`
}

const FIXTURE: Fixture = {
	sheets: [
		{
			name: "Data",
			body:
				'<dimension ref="A1:H20"/><sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/>' +
				'<selection pane="bottomRight" activeCell="C5" sqref="C5:D9"/></sheetView></sheetViews><cols><col min="2" max="4" width="12" customWidth="1"/></cols>' +
				cells() +
				'<autoFilter ref="A1:D20"><filterColumn colId="2"><filters><filter val="1"/></filters></filterColumn></autoFilter>' +
				'<mergeCells count="2"><mergeCell ref="G2:H4"/><mergeCell ref="G10:G14"/></mergeCells>' +
				'<conditionalFormatting sqref="A5:D15"><cfRule type="expression" priority="1"><formula>$A5&gt;B$2</formula></cfRule></conditionalFormatting>' +
				'<dataValidations count="1"><dataValidation type="list" sqref="H6:H16"><formula1>$A$1:$A$9</formula1></dataValidation></dataValidations>' +
				'<hyperlinks><hyperlink ref="G18" location="Data!B7"/></hyperlinks><rowBreaks count="1" manualBreakCount="1"><brk id="10" max="16383" man="1"/></rowBreaks>' +
				'<drawing r:id="rId1"/>',
			rels: relationship("rId1", "drawing", "../drawings/drawing1.xml")
		},
		{ name: "Other", body: '<sheetData><row r="1"><c r="A1"><f>SUM(Data!B2:C8)+Data!$E$12</f><v>0</v></c></row></sheetData>' }
	],
	workbookTail: '<definedNames><definedName name="area">Data!$B$3:$D$11</definedName></definedNames>',
	parts: {
		"xl/drawings/drawing1.xml": {
			text:
				`${DECLARATION}<xdr:wsDr xmlns:xdr="${xdr}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}"><xdr:twoCellAnchor>` +
				"<xdr:from><xdr:col>5</xdr:col><xdr:colOff>10</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>10</xdr:rowOff></xdr:from>" +
				"<xdr:to><xdr:col>7</xdr:col><xdr:colOff>10</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>10</xdr:rowOff></xdr:to>" +
				'<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="c"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/>' +
				`<a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`,
			type: TYPES.drawing
		},
		"xl/drawings/_rels/drawing1.xml.rels": {
			text: rels(relationship("rId1", "chart", "../charts/chart1.xml")),
			type: TYPES.relationships
		},
		"xl/charts/chart1.xml": {
			text: `${DECLARATION}<c:chartSpace xmlns:c="${C}"><c:chart><c:plotArea><c:lineChart><c:ser><c:val><c:numRef><c:f>Data!$B$2:$B$15</c:f></c:numRef></c:val></c:ser></c:lineChart></c:plotArea></c:chart></c:chartSpace>`,
			type: TYPES.chart
		}
	}
}

const SOURCE = buildFixture(FIXTURE)

function randomEdit(next: () => number): RefEdit {
	const axis = next() < 0.6 ? "rows" : "cols"
	const type = next() < 0.55 ? "insert" : "delete"
	const at = Math.floor(next() * (axis === "rows" ? 24 : 10))
	const count = 1 + Math.floor(next() * 3)

	return { kind: "axis", sheet: 0, shift: { type, axis, at, count } }
}

// What every construct says: cells with their formulas as each cell reads them (shared or not), the model's
// layout, every section and part the catalogue holds, the names.
async function meaning(workbook: XlsxWorkbook): Promise<string> {
	const state = refState(workbook)
	const out: string[] = []

	for (const entry of workbook.sheets) await workbook.load(entry.id)

	for (const entry of workbook.sheets) {
		const model = entry.model

		if (model === null) continue

		const table = model.store.formulas

		for (const block of model.store.blocks) {
			for (let i = 0; i < block.rowCount; i++) {
				const row = block.firstRow + (block.rows[i] ?? 0)
				const end = block.rowStarts[i + 1] ?? 0

				for (let k = block.rowStarts[i] ?? 0; k < end; k++) {
					const id = block.formulas?.[k] ?? -1
					const col = block.cols[k] ?? 0
					const formula =
						id < 0 ? "" : table.kind(id) === FormulaKind.SHARED_CHILD ? table.expanded(id, row, col) : table.text(id)

					out.push(`${entry.name}!${row},${col}=${block.kinds[k]}:${block.values[k]}:${formula}`)
				}
			}
		}

		out.push(JSON.stringify({ merges: [...model.merges], cols: model.cols, view: model.view }))

		// The sections the catalogue rewrites (the model's own are in the layout above).
		for (const name of new Set(model.sections.map(section => section.name)))
			if (!MODEL_SECTIONS.has(name) || name === "dimension") out.push(state.sectionMarkup(model, name).join(""))
	}

	for (const name of ["xl/drawings/drawing1.xml", "xl/charts/chart1.xml"])
		out.push(decodeUtf8((await state.partBytes(name)) ?? new Uint8Array(0)))

	out.push(JSON.stringify(workbook.definedNames.map(name => [name.name, name.formula])))

	return out.join("\n")
}

async function plan(workbook: XlsxWorkbook, edit: RefEdit): Promise<RefPlan | null> {
	const result = await planRefEdit(workbook, edit)

	return result.ok ? result.plan : null
}

describe("structure edit fuzz", () => {
	it("saves every step through the gate and reverts every sequence to the source's bytes", { timeout: 600_000 }, async () => {
		let refused = 0
		let applied = 0

		for (let run = 0; run < RUNS; run++) {
			const next = rng(run + 1)
			const workbook = await openWorkbook(SOURCE)
			const plans: RefPlan[] = []
			const steps = 1 + Math.floor(next() * 5)

			for (let step = 0; step < steps; step++) {
				const edit = randomEdit(next)
				const planned = await plan(workbook, edit)

				if (planned === null) {
					refused++

					continue
				}

				planned.apply()
				plans.push(planned)
				applied++
				await saved(workbook)
			}

			for (const planned of plans.reverse()) planned.revert()

			const back = await changedEntries(SOURCE, await saved(workbook))

			expect(back, `run ${run}`).toEqual({ changed: [], added: [], removed: [] })
		}

		expect(applied).toBeGreaterThan(RUNS)
		expect(refused).toBeLessThan(applied)
	})

	it("gives back every construct when inserted rows or columns are deleted again", { timeout: 600_000 }, async () => {
		const workbook = await openWorkbook(SOURCE)
		const original = await meaning(workbook)

		for (let run = 0; run < RUNS; run++) {
			const next = rng(10_000 + run)
			const edit = randomEdit(next)

			if (edit.kind !== "axis") continue

			const insert = await plan(workbook, { ...edit, shift: { ...edit.shift, type: "insert" } })

			if (insert === null) continue

			insert.apply()

			const remove = await plan(workbook, { ...edit, shift: { ...edit.shift, type: "delete" } })

			expect(remove, `run ${run}`).not.toBeNull()
			remove?.apply()
			expect(await meaning(workbook), `run ${run}: ${JSON.stringify(edit)}`).toBe(original)
		}

		await saved(workbook)
	})

	it("plans as a pure function of the workbook, and applies again after a revert alike", { timeout: 600_000 }, async () => {
		for (let run = 0; run < Math.min(RUNS, 40); run++) {
			const edit = randomEdit(rng(20_000 + run))
			const first = await openWorkbook(SOURCE)
			const second = await openWorkbook(SOURCE)
			const a = await plan(first, edit)
			const b = await plan(second, edit)

			expect(a === null, `run ${run}`).toBe(b === null)

			if (a === null || b === null) continue

			a.apply()
			b.apply()

			const once = parts(await saved(first))

			expect(parts(await saved(second))).toEqual(once)
			a.revert()
			a.apply()
			expect(parts(await saved(first))).toEqual(once)
		}
	})

	it("moves shared formula text as the reader expands it", () => {
		const next = rng(7)
		const atoms = [
			"A1",
			"$B$2",
			"C$3",
			"$D4",
			"Sheet2!E5",
			"'My Sheet'!F6",
			"SUM(A1:B9)",
			"A:A",
			"3:4",
			"[1]S!A1",
			'"A1"',
			"Table1[Col]",
			"LOG10(A2)"
		]

		for (let k = 0; k < 2000; k++) {
			const parts: string[] = []

			for (let n = 1 + Math.floor(next() * 4); n > 0; n--) parts.push(atoms[Math.floor(next() * atoms.length)] ?? "A1")

			const text = parts.join("+")
			const rows = Math.floor(next() * 20) - 5
			const cols = Math.floor(next() * 6) - 2

			expect(formulaTranslator(text)(rows, cols), `${text} by ${rows},${cols}`).toBe(moveRelativeReferences(text, rows, cols))
		}
	})
})
