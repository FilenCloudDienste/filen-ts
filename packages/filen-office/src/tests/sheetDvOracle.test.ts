import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { strFromU8, unzipSync } from "fflate"
import type { SheetValidationRule } from "../core/sheet/dv/xlsx"
import { readValidations } from "../core/sheet/dv/rules"
import { inThreadSheetHost } from "../dom/sheet/host"
import { encodeUtf8 } from "../core/xml/index"
import { exportSheets, sheetOffices, sheetProfile } from "./oracles/sheet/libreOffice"
import { newValidityErrors, XsdOracle, xsdOracleMissing } from "./oracles/xsd"
import { IMMEDIATE } from "./sheetCfFixtures"
import { savedBytes } from "./sheetSessionFixtures"
import { buildFixture, type Fixture } from "./xlsxWriteFixtures"

// Validations a session sets, against the SpreadsheetML schema (no new validity errors in the saved sheet) and
// against LibreOffice (its re-save of the file keeps every validation: type, operator, cells, formulas, messages).
// Opt-in: the schema half needs xmllint and the Part 4 archive, the LibreOffice half FILEN_OFFICE_SOFFICE.

const X14 =
	'xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"'

const SOURCE: Fixture = {
	sheets: [
		{
			name: "One",
			xml:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
				'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
				'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">' +
				'<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' +
				'<dataValidations count="1"><dataValidation type="whole" allowBlank="1" showErrorMessage="1" sqref="A1:A20"><formula1>1</formula1><formula2>9</formula2></dataValidation></dataValidations>' +
				'<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
				`<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" ${X14}><x14:dataValidations count="1"><x14:dataValidation type="list" allowBlank="1" showErrorMessage="1">` +
				"<x14:formula1><xm:f>Two!$A$1:$A$2</xm:f></x14:formula1><xm:sqref>G1:G9</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>" +
				"</worksheet>"
		},
		{ name: "Two", body: '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>North</t></is></c></row></sheetData>' }
	]
}

const BASE: SheetValidationRule = {
	type: "list",
	operator: "between",
	value1: "",
	value2: "",
	allowBlank: true,
	inCellDropdown: true,
	showInputMessage: false,
	promptTitle: "",
	prompt: "",
	showErrorMessage: true,
	errorStyle: "stop",
	errorTitle: "",
	error: ""
}

const EDITS: readonly {
	readonly ranges: { startRow: number; startCol: number; endRow: number; endCol: number }[]
	readonly rule: SheetValidationRule | null
}[] = [
	{ ranges: [{ startRow: 2, startCol: 0, endRow: 4, endCol: 0 }], rule: { ...BASE, value1: "Red,Green,Blue", inCellDropdown: false } },
	{
		ranges: [{ startRow: 0, startCol: 1, endRow: 9, endCol: 1 }],
		rule: { ...BASE, type: "decimal", operator: "greaterThan", value1: "2.5" }
	},
	{
		ranges: [{ startRow: 0, startCol: 2, endRow: 9, endCol: 2 }],
		rule: {
			...BASE,
			type: "date",
			value1: "2024-01-01",
			value2: "=TODAY()",
			showInputMessage: true,
			promptTitle: "When",
			prompt: "A date in 2024 or later",
			errorStyle: "warning",
			errorTitle: "Date",
			error: "Outside the range"
		}
	},
	{ ranges: [{ startRow: 0, startCol: 3, endRow: 9, endCol: 3 }], rule: { ...BASE, type: "custom", value1: "=ISNUMBER(D1)" } },
	{
		ranges: [{ startRow: 0, startCol: 4, endRow: 0, endCol: 4 }],
		rule: { ...BASE, type: "textLength", operator: "lessThanOrEqual", value1: "10" }
	},
	{ ranges: [{ startRow: 2, startCol: 6, endRow: 3, endCol: 6 }], rule: null }
]

async function edited(): Promise<Uint8Array> {
	const host = inThreadSheetHost()
	const opened = await host.open(buildFixture(SOURCE), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

	if (opened.kind !== "opened") throw new Error(opened.kind)

	const sheet = opened.info.sheets[0]?.id ?? 0

	for (const edit of EDITS) {
		const result = await opened.session.command({ type: "validation.set", sheet, ranges: edit.ranges, rule: edit.rule })

		if (!result.ok) throw new Error(result.refusal.reason)
	}

	const bytes = await savedBytes(opened.session)

	opened.session.close()

	return bytes
}

// The validations of a saved workbook's first sheet, as comparable records (a second formula only where the operator
// takes one: LibreOffice writes a 0 for the others).
function validations(bytes: Uint8Array): string[] {
	const parts = unzipSync(bytes)
	const xml = strFromU8(parts["xl/worksheets/sheet1.xml"] ?? new Uint8Array(0))
	const main = [...xml.matchAll(/<(?:\w+:)?dataValidations\b[\s\S]*?<\/(?:\w+:)?dataValidations>/gu)].map(match => match[0])
	const ext = /<(?:\w+:)?extLst>[\s\S]*<\/(?:\w+:)?extLst>/u.exec(xml)?.[0] ?? null

	return readValidations(main, ext)
		.flatMap(rule =>
			rule.ranges.flatMap(range => {
				const cells: string[] = []

				for (let row = range.startRow; row <= range.endRow; row++)
					for (let col = range.startCol; col <= range.endCol; col++)
						cells.push(
							`${String(row)},${String(col)} ${rule.type} ${rule.type === "list" || rule.type === "custom" ? "" : rule.operator} ${(rule.formula1 ?? "").replace(/^\$?/u, "")} ${rule.type !== "list" && rule.type !== "custom" && (rule.operator === "between" || rule.operator === "notBetween") ? (rule.formula2 ?? "") : ""} ` +
								`${String(rule.allowBlank)} ${String(rule.hideDropDown)} ${rule.errorStyle} ${rule.errorTitle ?? ""} ${rule.error ?? ""} ${rule.promptTitle ?? ""} ${rule.prompt ?? ""}`
						)

				return cells
			})
		)
		.sort()
}

describe.skipIf(xsdOracleMissing() !== undefined)("validations set, against the SpreadsheetML schema", () => {
	it("adds no validity error to the sheet", { timeout: 120_000 }, async () => {
		const oracle = new XsdOracle()

		try {
			const before = buildFixture(SOURCE)
			const after = await edited()
			const part = (bytes: Uint8Array): Uint8Array => unzipSync(bytes)["xl/worksheets/sheet1.xml"] ?? encodeUtf8("")
			const [source, saved] = oracle.validate([part(before), part(after)])

			expect(newValidityErrors(source ?? new Map(), saved ?? new Map(), part(before))).toEqual([])
		} finally {
			oracle.dispose()
		}
	})
})

const OFFICES = sheetOffices()

describe.skipIf(OFFICES.length === 0)("validations set, against LibreOffice", () => {
	let scratch: string

	beforeAll(() => {
		scratch = mkdtempSync(join(tmpdir(), "filen-dv-oracle-"))
	})

	afterAll(() => {
		rmSync(scratch, { recursive: true, force: true })
	})

	it("keeps every validation through LibreOffice's re-save", { timeout: 300_000 }, async () => {
		const saved = await edited()
		const input = join(scratch, "edited.xlsx")

		writeFileSync(input, saved)

		for (const office of OFFICES) {
			const profile = sheetProfile(scratch, `dv-${office.version}`)
			const [result] = await exportSheets(office, profile, "xlsx", [input], join(scratch, `out-${office.version}`), 120_000)

			expect(result?.ok, result?.error).toBe(true)

			const resaved = readFileSync(result?.outputs[0] ?? "")

			expect(validations(resaved), office.version).toEqual(validations(saved))
		}
	})
})
