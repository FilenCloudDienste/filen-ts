import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { encodeUtf8 } from "@filen/office/core/xml"
import { CellKind, FormulaKind } from "../core/xlsx/model/types"
import { openXlsx, XlsxReadError, type SheetStore } from "../core/xlsx/read/index"
import { CORPUS_DIR } from "./corpusDir"
import { DEFAULT_STYLES, workbookFiles } from "./xlsxReadFixtures"
import { ZIP_ENTRY_TIME } from "./zipTime"
import { budget } from "./timing"

// Workbooks with mutated parts (bytes flipped, markup characters inserted, spans deleted, duplicated or swapped,
// parts truncated) and mutated archives: the reader opens each, loads every sheet and walks everything it read,
// answering every failure with a typed result or an XlsxReadError, never another throw, and within a time bound.

const MUTANTS = Number(process.env["FILEN_OFFICE_XLSX_FUZZ"] || "2000")
const SEED = Number(process.env["FILEN_OFFICE_XLSX_FUZZ_SEED"] || "4021")
// Per file: open, load and walk. Generous for a loaded machine; typical is a few milliseconds.
const BOUND_MS = 1000

class Random {
	private state: number

	constructor(seed: number) {
		this.state = seed || 1
	}

	next(): number {
		this.state ^= this.state << 13
		this.state ^= this.state >>> 17
		this.state ^= this.state << 5

		return this.state >>> 0
	}

	below(n: number): number {
		return n <= 0 ? 0 : this.next() % n
	}
}

const MARKUP = [
	"<",
	">",
	"/",
	'"',
	"'",
	"=",
	"&",
	"&amp;",
	"&#0;",
	"&#x110000;",
	"<![CDATA[",
	"]]>",
	"<!--",
	"-->",
	"<?",
	"?>",
	"<!DOCTYPE x>",
	" ",
	":",
	"\u0000",
	"￿",
	"9",
	"-",
	"e",
	"XFD",
	"1048577",
	't="s"',
	'r="A0"',
	"<c>",
	"</c>",
	"<row>",
	"</row>",
	"<v>",
	"</v>",
	'<f t="shared" si="0"/>',
	"<is><t>x</t></is>"
]

function mutate(bytes: Uint8Array, random: Random): Uint8Array {
	const at = random.below(bytes.length + 1)

	switch (random.below(7)) {
		case 0: {
			const out = bytes.slice()

			for (let k = 0; k < 1 + random.below(4); k++) out[random.below(out.length)] = random.below(256)

			return out
		}
		case 1: {
			const insert = encodeUtf8(MARKUP[random.below(MARKUP.length)] ?? "<")
			const out = new Uint8Array(bytes.length + insert.length)

			out.set(bytes.subarray(0, at))
			out.set(insert, at)
			out.set(bytes.subarray(at), at + insert.length)

			return out
		}
		case 2: {
			const end = Math.min(bytes.length, at + 1 + random.below(64))

			return new Uint8Array([...bytes.subarray(0, at), ...bytes.subarray(end)])
		}
		case 3:
			return bytes.slice(0, at)
		case 4: {
			const end = Math.min(bytes.length, at + 1 + random.below(256))
			const span = bytes.subarray(at, end)
			const to = random.below(bytes.length + 1)

			return new Uint8Array([...bytes.subarray(0, to), ...span, ...bytes.subarray(to)])
		}
		case 5: {
			// Swap two spans: elements out of order.
			const a = random.below(bytes.length)
			const b = random.below(bytes.length)
			const [from, to] = a < b ? [a, b] : [b, a]
			const length = Math.min(1 + random.below(128), to - from)

			return new Uint8Array([
				...bytes.subarray(0, from),
				...bytes.subarray(to, to + length),
				...bytes.subarray(from + length, to),
				...bytes.subarray(from, from + length),
				...bytes.subarray(to + length)
			])
		}
		default: {
			// A tag's quote dropped or doubled.
			const out = bytes.slice()
			const quote = out.indexOf(34, at)

			if (quote >= 0) out[quote] = random.below(2) === 0 ? 32 : 39

			return out
		}
	}
}

// Walks everything the reader exposes, as a session would.
function walk(store: SheetStore, strings: { length: number; text(index: number): string; runs(index: number): unknown }): number {
	let seen = 0

	for (const block of store.blocks) {
		for (let k = 0; k < block.cellCount; k++) {
			const kind = block.kinds[k]
			const value = block.values[k] ?? 0

			if (kind === CellKind.SHARED_STRING) {
				seen += strings.text(value).length
				strings.runs(value)
			} else if (kind !== CellKind.NUMBER && kind !== CellKind.BOOLEAN && kind !== CellKind.EMPTY) {
				seen += store.strings.text(value).length
			}

			const formula = block.formulas?.[k] ?? -1

			if (formula >= 0 && store.formulas.kind(formula) === FormulaKind.SHARED_CHILD) {
				seen += store.formulas.expanded(formula, block.firstRow + (block.rows[0] ?? 0), block.cols[k] ?? 0).length
			}
		}
	}

	store.locate(5, 5)
	store.estimateBytes()

	return seen
}

const SEEDS: Record<string, Uint8Array>[] = [
	workbookFiles({
		sharedStrings: ["a", "b &amp; c", '<r><rPr><b/><color rgb="FF0000"/></rPr><t>rich</t></r><r><t> run</t></r>'],
		styles: DEFAULT_STYLES,
		workbookHead:
			'<workbookPr date1904="1"/><workbookProtection lockStructure="1"/><bookViews><workbookView activeTab="0"/></bookViews>',
		workbookTail: '<definedNames><definedName name="N" localSheetId="0">Sheet1!$A$1</definedName></definedNames><calcPr calcId="1"/>',
		sheets: [
			{
				body:
					'<sheetPr><tabColor rgb="FF00FF00"/></sheetPr><dimension ref="A1:D4"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/><selection activeCell="B2" sqref="B2"/></sheetView></sheetViews>' +
					'<sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="3" width="10" customWidth="1"/></cols><sheetData>' +
					'<row r="1" ht="20" customHeight="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c><c r="C1" t="inlineStr"><is><r><t>x</t></r></is></c></row>' +
					'<row r="2"><c r="A2"><f t="shared" ref="A2:A4" si="0">B2*2</f><v>2</v></c><c r="B2"><v>1</v></c><c r="C2" t="e"><v>#N/A</v></c></row>' +
					'<row r="3"><c r="A3"><f t="shared" si="0"/><v>4</v></c><c r="B3" t="b"><v>1</v></c><c r="D3" t="str"><f>"s"</f><v>s</v></c></row>' +
					'<row r="4"><c r="A4"><f t="shared" si="0"/></c><c r="B4" s="1"><f t="array" ref="B4:C4">{1,2}</f><v>1</v></c></row>' +
					'</sheetData><sheetProtection sheet="1" password="ABCD"/><mergeCells count="1"><mergeCell ref="C1:D1"/></mergeCells>'
			},
			{ body: '<sheetData><row r="2"><c r="B2" t="d"><v>2020-01-01</v></c></row></sheetData>' }
		]
	})
]

for (const name of [
	"xlsx/closedxml__inputfile.xlsx",
	"xlsx/docx4j__strict-simple.xlsx",
	"xlsx/poi__shared_formulas.xlsx",
	"xlsx/xlsxwriter__dynamic_array01.xlsx",
	"xlsx/xlsxwriter__rich_string12.xlsx",
	"xlsm/pandas__test3.xlsm",
	"xltx/poi__test.xltx"
]) {
	const path = join(CORPUS_DIR, name)

	if (existsSync(path)) {
		const files = unzipSync(new Uint8Array(readFileSync(path)))

		if (Object.values(files).reduce((total, file) => total + file.length, 0) < 2_000_000) SEEDS.push(files)
	}
}

async function exercise(bytes: Uint8Array): Promise<string> {
	const opened = await openXlsx(bytesSource(bytes), { readLimits: { maxCells: 2_000_000 } })

	if (!opened.ok) {
		if (opened.reason === "failed") throw new Error(`untyped open failure: ${opened.message}`)

		return opened.reason
	}

	const workbook = opened.workbook

	for (const sheet of workbook.sheets) {
		try {
			walk((await workbook.load(sheet.id)).store as SheetStore, workbook.sharedStrings)
		} catch (error) {
			if (!(error instanceof XlsxReadError)) throw error
		}
	}

	for (let k = 0; k < Math.min(64, workbook.sharedStrings.length); k++) workbook.sharedStrings.runs(k)

	workbook.sharedStrings.find("a")

	return "opened"
}

describe("xlsx reader fuzz", () => {
	it(`answers ${MUTANTS} mutated workbooks with a result or a typed error, in bounded time`, { timeout: 600_000 }, async () => {
		const random = new Random(SEED)
		const outcomes = new Map<string, number>()
		let slowest = 0

		for (let n = 0; n < MUTANTS; n++) {
			const files = { ...(SEEDS[random.below(SEEDS.length)] ?? {}) }
			const names = Object.keys(files)
			let bytes: Uint8Array

			if (random.below(8) === 0) {
				bytes = mutate(zipSync(files, { mtime: ZIP_ENTRY_TIME }), random)
			} else {
				// Mostly the parts the reader parses itself.
				const xml = names.filter(name => /(workbook|sheet\d*|styles|sharedStrings|\.rels|Content_Types)/u.test(name))
				const name =
					(random.below(4) === 0 ? names : xml)[random.below((random.below(4) === 0 ? names : xml).length)] ?? names[0] ?? ""

				for (let k = 0; k < 1 + random.below(3); k++) files[name] = mutate(files[name] ?? new Uint8Array(0), random)

				bytes = zipSync(files, { mtime: ZIP_ENTRY_TIME })
			}

			const started = performance.now()
			let outcome: string

			try {
				outcome = await exercise(bytes)
			} catch (error) {
				throw new Error(`mutant ${n} (seed ${SEED}): ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
			}

			const elapsed = performance.now() - started

			slowest = Math.max(slowest, elapsed)
			outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1)
			expect(elapsed, `mutant ${n} (seed ${SEED})`).toBeLessThan(budget(BOUND_MS))
		}

		console.log(
			`xlsx reader fuzz: ${MUTANTS} mutants, ${JSON.stringify(Object.fromEntries(outcomes))}, slowest ${slowest.toFixed(1)} ms`
		)
		expect(outcomes.get("opened") ?? 0).toBeGreaterThan(0)
	})
})
