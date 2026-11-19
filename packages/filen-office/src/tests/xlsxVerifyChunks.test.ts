import { describe, expect, it } from "vitest"
import { CellKind } from "../core/xlsx/model/types"
import { XlsxWriteError } from "../core/xlsx/write/failure"
import { writeXlsx, type XlsxDraft } from "../core/xlsx/write/save"
import { verifyXlsxParts } from "../core/xlsx/verify/verify"
import { decodeUtf8, encodeUtf8, parseXml } from "../core/xml/index"
import { buildFixture, openWorkbook } from "./xlsxWriteFixtures"

// The save's check reads rewritten rows back in runs, never the part whole: what it refuses, and why, is what a parse
// of the whole part refused.

const ROWS = 40_000

async function buildDraft(): Promise<XlsxDraft> {
	const workbook = await openWorkbook(buildFixture({ sheets: [{ name: "Data", body: "<sheetData/>" }] }))
	const model = await workbook.load(0)

	// New rows: written anew, not spliced into source rows.
	for (let row = 0; row < ROWS; row++) model.store.setCell(row, 0, CellKind.NUMBER, row + 1, 0, -1)

	workbook.changes.sheetRows(0)

	return writeXlsx({ opc: workbook.opc, workbook })
}

// Built once, by whichever test runs first: the check only reads a draft, and tests derive variants with tampered().
let shared: Promise<XlsxDraft> | undefined

function draftOfRows(): Promise<XlsxDraft> {
	return (shared ??= buildDraft())
}

// The draft with rows at `at` given new bytes.
function tampered(draft: XlsxDraft, rows: ReadonlyMap<number, string>): XlsxDraft {
	const sheet = draft.sheets[0]

	if (sheet?.rows === null || sheet?.rows === undefined) throw new Error("no rows written")

	return {
		...draft,
		sheets: [{ ...sheet, rows: sheet.rows.map((row, k) => (rows.has(k) ? { ...row, bytes: encodeUtf8(rows.get(k) ?? "") } : row)) }]
	}
}

async function reason(draft: XlsxDraft): Promise<string | null> {
	return verifyXlsxParts(draft).then(
		() => null,
		(error: unknown) => (error instanceof XlsxWriteError ? error.reason : String(error))
	)
}

describe("the save check over rewritten rows", () => {
	it("accepts a part of many rewritten rows, read in runs", { timeout: 60_000 }, async () => {
		const draft = await draftOfRows()

		const rows = draft.sheets[0]?.rows ?? []

		expect(rows.length).toBe(ROWS)
		// Rows written anew, more than one run of them.
		expect(rows.every(row => !row.spliced && !row.renumbered)).toBe(true)
		expect(rows.reduce((size, row) => size + row.bytes.length, 0)).toBeGreaterThan(1 << 20)
		expect(await reason(draft)).toBeNull()
	})

	it("refuses a row that reads back otherwise", { timeout: 60_000 }, async () => {
		expect(
			await reason(
				tampered(
					await draftOfRows(),
					new Map([[ROWS - 10, `<row r="${String(ROWS - 9)}"><c r="A${String(ROWS - 9)}"><v>0</v></c></row>`]])
				)
			)
		).toBe("model")
	})

	it("refuses a malformed row in a later run before a row of an earlier run that reads back otherwise", { timeout: 60_000 }, async () => {
		const draft = tampered(
			await draftOfRows(),
			new Map([
				[10, '<row r="11"><c r="A11"><v>0</v></c></row>'],
				[ROWS - 10, `<row r="${String(ROWS - 9)}"><c r="A${String(ROWS - 9)}"><v>1</v></c>`]
			])
		)

		expect(await reason(draft)).toBe("malformedPart")
	})
	// The last row of the first run of rows parsed together (runs of at most a mebibyte).
	function lastOfFirstRun(draft: XlsxDraft): number {
		const rows = draft.sheets[0]?.rows ?? []
		let size = 0
		let last = 0

		while (last < rows.length && (last === 0 || size + (rows[last]?.bytes.length ?? 0) <= 1 << 20))
			size += rows[last++]?.bytes.length ?? 0

		return last - 1
	}

	for (const where of ["before the first row", "in a run", "between runs", "after the last row"] as const) {
		it(`refuses an element that is no row ${where}`, { timeout: 60_000 }, async () => {
			const draft = await draftOfRows()
			const rows = draft.sheets[0]?.rows ?? []
			const at =
				where === "before the first row"
					? 0
					: where === "in a run"
						? 100
						: where === "between runs"
							? lastOfFirstRun(draft)
							: rows.length - 1
			const own = decodeUtf8(rows[at]?.bytes ?? new Uint8Array(0))
			const bytes = where === "before the first row" ? `<foo/>${own}` : `${own}<foo/>`

			expect(await reason(tampered(draft, new Map([[at, bytes]])))).toBe("malformedPart")
			// A row written twice is no stray: the next one reads back as another row.
			if (where !== "before the first row") expect(await reason(tampered(draft, new Map([[at, own + own]])))).not.toBeNull()
		})
	}

	it(
		"pairs rows with the elements read across runs, as the part parsed whole: an empty row at a run's start reads back as the next",
		{ timeout: 60_000 },
		async () => {
			const draft = await draftOfRows()
			const at = lastOfFirstRun(draft) + 1

			// HEAD read the part whole: the empty row took the next row's element, which reads back as another row.
			expect(await reason(tampered(draft, new Map([[at, ""]])))).toBe("model")
			expect(await reason(tampered(draft, new Map([[at - 1, ""]])))).toBe("model")
			expect(await reason(tampered(draft, new Map([[50, ""]])))).toBe("model")
		}
	)

	it("names a malformed row by its byte in the part as read whole, not in its run", { timeout: 60_000 }, async () => {
		const draft = await draftOfRows()
		const sheet = draft.sheets[0]
		const at = lastOfFirstRun(draft) + 5
		const broken = tampered(draft, new Map([[at, `<row r="${String(at + 1)}"><c r="A${String(at + 1)}"><v>1</v></c>`]]))
		const message = await verifyXlsxParts(broken).then(
			() => "",
			(error: unknown) => (error instanceof XlsxWriteError ? error.message : String(error))
		)
		// The part as the check once parsed it whole: its root, its new sections, sheetData and every row.
		const tamperedRows = broken.sheets[0]?.rows ?? []
		const whole = [
			sheet?.rootOpen ?? new Uint8Array(0),
			...(sheet?.written.values() ?? []),
			encodeUtf8("<sheetData>"),
			...tamperedRows.map(row => row.bytes),
			encodeUtf8("</sheetData></worksheet>")
		]
		const joined = new Uint8Array(whole.reduce((size, part) => size + part.length, 0))

		whole.reduce((at, part) => {
			joined.set(part, at)

			return at + part.length
		}, 0)

		const expected = (() => {
			try {
				parseXml(joined)

				return ""
			} catch (error) {
				return /byte (\d+)/.exec(String(error))?.[1] ?? ""
			}
		})()

		expect(expected).not.toBe("")
		expect(/byte (\d+)/.exec(message)?.[1]).toBe(expected)
	})
})
