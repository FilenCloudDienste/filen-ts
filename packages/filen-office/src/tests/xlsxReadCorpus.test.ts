import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openEncryptedPackage } from "@filen/office/dom/encryption"
import { CellKind, FormulaKind, NO_SPAN } from "../core/xlsx/model/types"
import { openXlsx, parseRange, XlsxReadError, type SheetStore, type XlsxSheet, type XlsxWorkbook } from "../core/xlsx/read/index"
import type { CorpusManifest } from "../scripts/corpusManifest"
import { CORPUS_DIR } from "./corpusDir"
import { readXlsxCells, type XlsxCell } from "./oracles/sheet/xlsxCells"

// Every OOXML spreadsheet of the corpus read twice, by the reader and by the oracles' independent plain reader
// (a tree parse of each part): every cell's value, type and formula must agree, and every cell the oracle sees
// must be in the store. Password-protected files are unlocked with their manifest password first.

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "corpus", "manifest.json"), "utf8")) as CorpusManifest
const FILES = manifest.files
	.filter(file => /^(xlsx|xlsm|xltx|xltm)\//u.test(file.path))
	.filter(file => existsSync(join(CORPUS_DIR, file.path)))

const KIND_NAMES: Record<number, string> = {
	[FormulaKind.NORMAL]: "normal",
	[FormulaKind.SHARED_MASTER]: "shared",
	[FormulaKind.SHARED_CHILD]: "shared",
	[FormulaKind.ARRAY]: "array",
	[FormulaKind.DATA_TABLE]: "dataTable"
}

// What the store holds at a slot, in the oracle's terms.
function storeValue(workbook: XlsxWorkbook, store: SheetStore, slot: number): XlsxCell["value"] {
	const kind = store.kind(slot)
	const value = store.value(slot)

	switch (kind) {
		case CellKind.NUMBER:
			return { type: "n", value }
		case CellKind.SHARED_STRING:
			return { type: "s", value: workbook.sharedStrings.text(value) }
		case CellKind.INLINE_STRING:
		case CellKind.FORMULA_STRING:
		case CellKind.DATE:
			return { type: "s", value: store.strings.text(value) }
		case CellKind.BOOLEAN:
			return { type: "b", value: value === 1 }
		case CellKind.ERROR:
			return { type: "e", value: store.strings.text(value) }
		default:
			return undefined
	}
}

async function plaintext(path: string, bytes: Uint8Array, password: string | undefined): Promise<Uint8Array | null> {
	const opened = await openEncryptedPackage(bytesSource(bytes), { tryDefault: true })

	if (opened.kind === "plain") return bytes
	if (opened.kind === "unlocked") return opened.document.bytes
	if (opened.kind === "needsPassword" && password !== undefined) {
		const unlocked = await opened.locked.unlock(password)

		if (unlocked.ok) return unlocked.document.bytes
	}

	throw new Error(`${path}: cannot unlock (${opened.kind})`)
}

const decoder = new TextDecoder()

// Every section and every row span names its element's bytes in the part as inflated: the splice writer copies
// them as they are.
async function spansProblem(workbook: XlsxWorkbook, id: number): Promise<string | null> {
	const sheet = workbook.loaded(id) as XlsxSheet

	if (sheet.utf16) return null

	const bytes = await workbook.parts.read(sheet.part)
	const text = (start: number, end: number): string => decoder.decode(bytes.subarray(start, end))
	let previous = 0

	for (const section of sheet.sections) {
		if (section.start < previous || bytes[section.start] !== 60 || bytes[section.end - 1] !== 62) return `section ${section.name} span`
		if (section.bytes !== null && Buffer.compare(section.bytes, bytes.subarray(section.start, section.end)) !== 0)
			return `section ${section.name} bytes`
		if (
			!text(section.start + 1, section.end)
				.replace(/^[\w.-]+:/u, "")
				.startsWith(section.name.replace(/^[\w.-]+:/u, ""))
		)
			return `section ${section.name} name`

		previous = section.end
	}

	for (const block of sheet.store.blocks) {
		for (let i = 0; i < block.rowCount; i++) {
			const start = block.rowSpans[i * 2] ?? NO_SPAN
			const end = block.rowSpans[i * 2 + 1] ?? NO_SPAN

			if (start === NO_SPAN) continue

			const row = text(start, end)

			if (!/^<([\w.-]+:)?row[\s/>]/u.test(row) || !(row.endsWith("/>") || /<\/([\w.-]+:)?row>$/u.test(row)))
				return `row span ${row.slice(0, 40)}...${row.slice(-20)}`
		}
	}

	return null
}

interface Tally {
	files: number
	sheets: number
	otherSheets: number
	cells: number
	formulas: number
	encrypted: number
	readerFailures: string[]
	oracleFailures: string[]
	mismatches: string[]
}

describe.skipIf(FILES.length === 0)("xlsx reader against the plain reader over the corpus", () => {
	it("reads every cell's value, type and formula as written", { timeout: 600_000 }, async () => {
		const tally: Tally = {
			files: 0,
			sheets: 0,
			otherSheets: 0,
			cells: 0,
			formulas: 0,
			encrypted: 0,
			readerFailures: [],
			oracleFailures: [],
			mismatches: []
		}

		for (const file of FILES) {
			const raw = new Uint8Array(readFileSync(join(CORPUS_DIR, file.path)))
			const bytes = await plaintext(file.path, raw, file.password)

			if (bytes === null) continue
			if (bytes !== raw) tally.encrypted++

			let oracle: Awaited<ReturnType<typeof readXlsxCells>>

			try {
				oracle = await readXlsxCells(bytes)
			} catch (error) {
				tally.oracleFailures.push(`${file.path}: ${String(error)}`)

				// Whatever the oracle cannot read, the reader must refuse with a type or read.
				const opened = await openXlsx(bytesSource(bytes))

				expect(opened.ok || opened.reason !== "failed", `${file.path}: ${opened.ok ? "" : opened.message}`).toBe(true)

				continue
			}

			const opened = await openXlsx(bytesSource(bytes))

			if (!opened.ok) {
				tally.readerFailures.push(`${file.path}: ${opened.reason} ${opened.message}`)

				continue
			}

			tally.files++

			const workbook = opened.workbook

			for (const sheet of oracle.sheets) {
				const entry = workbook.sheets.find(candidate => candidate.part === sheet.part)

				if (entry === undefined) {
					tally.mismatches.push(`${file.path} ${sheet.name}: no sheet entry`)

					continue
				}

				let store: SheetStore

				try {
					store = (await workbook.load(entry.id)).store as SheetStore
				} catch (error) {
					tally.readerFailures.push(`${file.path} ${sheet.name}: ${String(error)}`)

					continue
				}

				tally.sheets++

				const spanProblem = await spansProblem(workbook, entry.id)

				if (spanProblem !== null) tally.mismatches.push(`${file.path} ${sheet.name}: ${spanProblem}`)

				// The last of repeated positions is the one a reader keeps.
				const expected = new Map<number, XlsxCell>()

				for (const cell of sheet.cells) expected.set(cell.row * 16_384 + cell.column, cell)

				const problems: string[] = []

				if (store.cellCount !== expected.size) problems.push(`cells ${store.cellCount} != ${expected.size}`)

				for (const cell of expected.values()) {
					const slot = store.locate(cell.row, cell.column)

					if (slot < 0) {
						problems.push(`R${cell.row}C${cell.column} missing`)

						continue
					}

					tally.cells++

					const value = storeValue(workbook, store, slot)

					if (JSON.stringify(value) !== JSON.stringify(cell.value)) {
						problems.push(`R${cell.row}C${cell.column} ${JSON.stringify(value)} != ${JSON.stringify(cell.value)}`)
					}

					const id = store.formula(slot)

					if (id >= 0 !== (cell.formula !== undefined)) {
						problems.push(`R${cell.row}C${cell.column} formula presence`)

						continue
					}

					if (id < 0 || cell.formula === undefined) continue

					tally.formulas++

					const formula = store.formulas.formula(id)
					const ref = cell.formula.ref === undefined ? null : parseRange(cell.formula.ref)
					const si = cell.formula.si === undefined ? -1 : Number(cell.formula.si)

					if (
						formula.text !== cell.formula.text ||
						KIND_NAMES[formula.kind] !== cell.formula.kind ||
						JSON.stringify(formula.ref) !== JSON.stringify(ref) ||
						formula.sharedIndex !== (Number.isInteger(si) ? si : -1)
					) {
						problems.push(`R${cell.row}C${cell.column} formula ${JSON.stringify(formula)} != ${JSON.stringify(cell.formula)}`)
					}
				}

				if (problems.length > 0)
					tally.mismatches.push(`${file.path} ${sheet.name}: ${problems.slice(0, 5).join("; ")} (${problems.length})`)
			}

			// The sheets the oracle leaves out (chartsheets, dialogsheets, macrosheets) read too, or name the
			// part they miss.
			for (const entry of workbook.sheets) {
				if (entry.model !== null) continue

				try {
					await workbook.load(entry.id)
					tally.otherSheets++
				} catch (error) {
					if (!(error instanceof XlsxReadError && error.code === "missingPart"))
						tally.readerFailures.push(`${file.path} ${entry.name}: ${String(error)}`)
				}
			}
		}

		console.log(
			`xlsx reader corpus: ${tally.files} files (${tally.encrypted} unlocked), ${tally.sheets} sheets (+${tally.otherSheets} other), ${tally.cells} cells, ${tally.formulas} formulas; ` +
				`oracle could not read ${tally.oracleFailures.length}: ${tally.oracleFailures.join(" | ")}`
		)

		expect(tally.readerFailures).toEqual([])
		expect(tally.mismatches).toEqual([])
		expect(tally.files).toBeGreaterThan(0)
	})
})

// Excel binary workbooks (MS-XLSB), often renamed .xlsx: the open path refuses them as unsupported, never as damaged.
const BINARY = manifest.files.filter(file => file.path.startsWith("xlsb/")).filter(file => existsSync(join(CORPUS_DIR, file.path)))

describe.skipIf(BINARY.length === 0)("xlsx reader over the corpus's binary workbooks", () => {
	it.each(BINARY.map(file => file.path))("refuses %s as unsupported", async path => {
		const opened = await openXlsx(bytesSource(new Uint8Array(readFileSync(join(CORPUS_DIR, path)))))

		expect(opened.ok ? "opened" : opened.reason).toBe("unsupported")
	})
})
