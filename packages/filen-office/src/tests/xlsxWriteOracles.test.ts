import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { OpcPackage, bytesSource } from "../core/opc/index"
import { decodeUtf8 } from "../core/xml/index"
import { openXlsx, type XlsxWorkbook } from "../core/xlsx/read/index"
import { CellKind, ColFlag, FormulaKind, RowFlag, type XlsxSheetModel } from "../core/xlsx/model/types"
import { saveXlsx } from "../core/xlsx/write/save"
import { seedImpliedStyles } from "../core/xlsx/write/styles"
import { CORPUS_DIR } from "./corpusDir"
import { loadAllowlist, newSdkErrors, OpenXmlSdk, openXmlSdkMissing, sdkErrorCounts } from "./oracles/openXmlSdk"
import { newValidityErrors, NOT_WELL_FORMED, schemaFamily, XsdOracle, xsdOracleMissing } from "./oracles/xsd"
import { buildFixture, changedEntries } from "./xlsxWriteFixtures"

// Edited saves against the schema oracles: every part the save rewrites or adds that an ECMA-376 schema declares
// (SpreadsheetML, relationships, content types) may hold no validity error its source part did not (xmllint and
// the Transitional schemas), and the package no Open XML SDK error (Microsoft365) its source did not, but the
// allowlisted ones. The edit is the writer's whole surface at once: a changed cell, a new row of every cell kind
// with a new shared string, style and formula, a merge, a frozen pane, a column, a tab colour, sheet protection and
// a full recalculation on load. Opt-in: needs xmllint and the schema archive, the built validator and a dotnet host;
// FILEN_OFFICE_XLSX_ORACLE_LIMIT caps the corpus workbooks.

const STRICT_MAIN = "http://purl.oclc.org/ooxml/spreadsheetml/main"
const XSD_MISSING = xsdOracleMissing()
const SDK_MISSING = openXmlSdkMissing()
const LIMIT = Number(process.env["FILEN_OFFICE_XLSX_ORACLE_LIMIT"] ?? Number.POSITIVE_INFINITY)
const KINDS = ["xlsx", "xlsm", "xltx", "xltm"]
// FILEN_OFFICE_XLSX_ORACLE_FILES: only the workbooks whose path contains one of these (comma-separated).
const ONLY = (process.env["FILEN_OFFICE_XLSX_ORACLE_FILES"] ?? "").split(",").filter(part => part !== "")
const FILES = KINDS.flatMap(kind =>
	existsSync(join(CORPUS_DIR, kind)) ? readdirSync(join(CORPUS_DIR, kind)).map(name => join(kind, name)) : []
)
	.filter(file => ONLY.length === 0 || ONLY.some(part => file.includes(part)))
	.slice(0, LIMIT)

interface Edited {
	readonly label: string
	readonly source: Uint8Array
	readonly output: Uint8Array
	readonly parts: readonly string[]
}

function overlaps(merges: Uint32Array, row: number, col: number, endRow: number, endCol: number): boolean {
	for (let k = 0; k + 3 < merges.length; k += 4) {
		if ((merges[k] ?? 0) <= endRow && row <= (merges[k + 2] ?? 0) && (merges[k + 1] ?? 0) <= endCol && col <= (merges[k + 3] ?? 0))
			return true
	}

	return false
}

// The edit above on the first worksheet; false when the sheet has no room for it.
function edit(workbook: XlsxWorkbook, sheet: XlsxSheetModel, id: number): boolean {
	const store = sheet.store
	const base = store.rowExtent

	if (base + 4 >= 1_048_576) return false

	const styles = workbook.styles
	const font = styles.appendFont({ name: "Arial", size: 10, bold: true, color: { argb: 0xff1f4e79 } })
	const fill = styles.appendFill({ kind: "pattern", pattern: "solid", fg: { argb: 0xffffff00 }, bg: { indexed: 64 } })
	const border = styles.appendBorder({ bottom: { style: "thin", color: { auto: true } } })
	const xf = styles.appendXf({
		numFmtId: styles.numFmtId("0.00"),
		fontId: font,
		fillId: fill,
		borderId: border,
		xfId: 0,
		flags: 0b1111,
		alignment: { horizontal: "center" }
	})
	const shared = workbook.sharedStrings.append("oracle text")
	const formula = store.formulas.add({ kind: FormulaKind.NORMAL, text: "1+2.5", sharedIndex: -1, ref: null, flags: 0, cellMetadata: -1 })

	workbook.changes.stylesAppended()
	workbook.sharedStrings.adjustReferences(1)
	workbook.changes.sharedStringsAppended()

	// A number in the first cell that holds one.
	outer: for (const block of store.blocks) {
		for (let slot = 0; slot < block.kinds.length; slot++) {
			if (block.kinds[slot] !== CellKind.NUMBER || (block.formulas?.[slot] ?? -1) >= 0) continue

			const index = block.rowStarts.findIndex(
				(start, k) => k < block.rowCount && start <= slot && slot < (block.rowStarts[k + 1] ?? 0)
			)

			store.setCell(
				block.firstRow + (block.rows[index] ?? 0),
				block.cols[slot] ?? 0,
				CellKind.NUMBER,
				(block.values[slot] ?? 0) * 2 + 1,
				block.styles[slot] ?? 0,
				-1
			)
			break outer
		}
	}

	store.setCell(base, 0, CellKind.SHARED_STRING, shared, xf, -1)
	store.setCell(base, 1, CellKind.NUMBER, 3.5, 0, formula)
	store.setCell(base, 2, CellKind.BOOLEAN, 1, 0, -1)
	store.setCell(base, 3, CellKind.INLINE_STRING, store.strings.intern("inline"), 0, -1)
	store.setCell(base, 4, CellKind.ERROR, store.strings.intern("#N/A"), 0, -1)
	store.setRow(base, 22.5, -1, RowFlag.CUSTOM_HEIGHT)
	workbook.changes.sheetRows(id)
	workbook.changes.formulasChanged()
	workbook.changes.needsFullCalc()

	if (!overlaps(sheet.merges, base + 1, 0, base + 2, 1)) {
		sheet.merges = Uint32Array.from([...sheet.merges, base + 1, 0, base + 2, 1])
		workbook.changes.sheetSection(id, "mergeCells")
	}

	const lastCol = sheet.cols.reduce((last, col) => Math.max(last, col.last), -1)

	if (lastCol + 1 < 16_384) {
		sheet.cols = [...sheet.cols, { first: lastCol + 1, last: lastCol + 1, width: 18.5, style: -1, flags: ColFlag.CUSTOM_WIDTH }]
		workbook.changes.sheetSection(id, "cols")
	}

	sheet.view = {
		...sheet.view,
		frozen: { rows: 1, cols: 1, topLeftRow: 1, topLeftCol: 1 },
		activeRow: 1,
		activeCol: 1,
		selection: [{ startRow: 1, startCol: 1, endRow: 1, endCol: 1 }]
	}
	sheet.tabColor = { theme: 5, tint: 0.3999755851924192 }
	sheet.protection ??= { hash: { legacy: "CC3D" }, allows: new Set(["selectLockedCells", "selectUnlockedCells"]) }

	for (const section of ["sheetViews", "sheetPr", "sheetProtection"]) workbook.changes.sheetSection(id, section)

	return true
}

async function edited(label: string, source: Uint8Array): Promise<Edited | string | undefined> {
	const opened = await openXlsx(bytesSource(source))

	if (!opened.ok) return undefined

	const workbook = opened.workbook

	// As the session does at open: a workbook without styles gets the implied defaults before an edit appends.
	seedImpliedStyles(workbook.styles)

	const entry = workbook.sheets.find(sheet => sheet.kind === "worksheet" && sheet.part !== "")

	if (entry === undefined) return undefined

	let sheet: XlsxSheetModel

	try {
		sheet = await workbook.load(entry.id)
	} catch {
		return undefined
	}

	if (!edit(workbook, sheet, entry.id)) return undefined

	const result = await saveXlsx({ opc: workbook.opc, workbook })

	if (!result.ok) return `${label}: refused (${result.reason}) ${result.message}`

	const output = result.bytes as Uint8Array
	const entries = await changedEntries(source, output)

	return { label, source, output, parts: [...entries.changed, ...entries.added] }
}

const SYNTHETIC = buildFixture({
	sheets: [
		{
			name: "S",
			body: '<sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
		}
	],
	sharedStrings:
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>',
	calcChain: true,
	workbookTail: '<calcPr calcId="191029"/>'
})

async function* saves(): AsyncGenerator<Edited | string> {
	const synthetic = await edited("synthetic", SYNTHETIC)

	if (synthetic !== undefined) yield synthetic

	for (const file of FILES) {
		const result = await edited(file, new Uint8Array(readFileSync(join(CORPUS_DIR, file))))

		if (result !== undefined) yield result
	}
}

describe.skipIf(XSD_MISSING !== undefined)("xlsx saves against the SpreadsheetML schemas", () => {
	let oracle: XsdOracle

	beforeAll(() => {
		oracle = new XsdOracle()
	})

	afterAll(() => {
		oracle.dispose()
	})

	it("adds no validity error to any part a save rewrites", { timeout: 1_800_000 }, async () => {
		const failures: string[] = []
		let checked = 0
		let saved = 0

		for await (const save of saves()) {
			if (typeof save === "string") {
				failures.push(save)
				continue
			}

			saved++

			const source = await OpcPackage.open(bytesSource(save.source))
			const output = await OpcPackage.open(bytesSource(save.output))
			const types = await output.contentTypes()
			const candidates = save.parts.filter(part => {
				const family = schemaFamily(part, part === "[Content_Types].xml" ? undefined : types.typeOf(part))

				return family === "sml" || (family === "opc" && oracle.opc)
			})
			const written = await Promise.all(candidates.map(part => output.read(part)))
			// The oracle holds the Transitional schemas: Strict parts are left to the re-read and the SDK.
			const names = candidates.filter((_, index) => !decodeUtf8(written[index] as Uint8Array).includes(STRICT_MAIN))
			const before = await Promise.all(names.map(part => (source.has(part) ? source.read(part) : Promise.resolve(undefined))))
			const after = written.filter((_, index) => !decodeUtf8(written[index] as Uint8Array).includes(STRICT_MAIN))
			const documents = [...before.filter((bytes): bytes is Uint8Array => bytes !== undefined), ...after]
			const results = oracle.validate(documents)
			let at = 0
			const sourceErrors = before.map(bytes =>
				bytes === undefined ? new Map<string, number>() : (results[at++] as Map<string, number>)
			)

			names.forEach((part, index) => {
				const errors = results[at + index] as Map<string, number>

				checked++

				if (errors.has(NOT_WELL_FORMED)) failures.push(`${save.label} ${part}: not well formed`)

				for (const error of newValidityErrors(sourceErrors[index] as Map<string, number>, errors, before[index]))
					failures.push(`${save.label} ${part}: ${error}`)
			})
		}

		console.log(`xlsx schema: ${saved} saves, ${checked} parts, ${failures.length} failures`)
		expect(failures).toEqual([])
		expect(saved).toBeGreaterThan(0)
	})
})

describe.skipIf(SDK_MISSING !== undefined)("xlsx saves against the Open XML SDK", () => {
	let sdk: OpenXmlSdk
	let scratch: string

	beforeAll(() => {
		sdk = new OpenXmlSdk()
		scratch = mkdtempSync(join(tmpdir(), "filen-office-xlsx-sdk-"))
	})

	afterAll(async () => {
		await sdk.close()
		rmSync(scratch, { recursive: true, force: true })
	})

	it("adds no validator error to any save", { timeout: 1_800_000 }, async () => {
		const allow = loadAllowlist()
		const failures: string[] = []
		let saved = 0

		for await (const save of saves()) {
			if (typeof save === "string") {
				failures.push(save)
				continue
			}

			saved++

			const extension = save.label.endsWith(".xlsm")
				? "xlsm"
				: save.label.endsWith(".xltx")
					? "xltx"
					: save.label.endsWith(".xltm")
						? "xltm"
						: "xlsx"
			const sourcePath = join(scratch, `source.${extension}`)
			const outputPath = join(scratch, `output.${extension}`)

			writeFileSync(sourcePath, save.source)
			writeFileSync(outputPath, save.output)

			const before = sdkErrorCounts(await sdk.validate(sourcePath))
			const after = sdkErrorCounts(await sdk.validate(outputPath))

			for (const error of newSdkErrors(before, after, allow)) failures.push(`${save.label}: ${error}`)
		}

		console.log(`xlsx Open XML SDK: ${saved} saves, ${failures.length} failures`)
		expect(failures).toEqual([])
		expect(saved).toBeGreaterThan(0)
	})
})
