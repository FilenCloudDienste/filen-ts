import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import type { SheetStore } from "../core/xlsx/model/store"
import { openXlsx } from "../core/xlsx/read/index"
import { encodeUtf8 } from "../core/xml/index"
import { SHEET_MAX_COLS } from "../core/sheet/protocol"
import { SML, workbookFiles } from "./xlsxReadFixtures"
import { budget, cpuMs } from "./timing"
import { ZIP_ENTRY_TIME } from "./zipTime"

// Repeated rows are merged in steps on the reader's slice clock: no long task, and an abort is heard meanwhile.

function repeated(): Uint8Array {
	const row = `<row r="1">${"<c><v>1</v></c>".repeat(16_384)}</row>`
	const sheet = encodeUtf8(`<worksheet xmlns="${SML}"><sheetData>${row.repeat(30)}</sheetData></worksheet>`)

	return zipSync(workbookFiles({ sheets: [{ bytes: sheet }] }), { mtime: ZIP_ENTRY_TIME })
}

describe("xlsx reader: repeated rows", () => {
	it("merges 30 copies of a 16,384-cell row without one long synchronous stretch", async () => {
		const opened = await openXlsx(bytesSource(repeated()))

		if (!opened.ok) throw new Error(opened.message)

		const timed = timedSlicing()
		const model = await opened.workbook.load(0, timed.slicing)

		expect(model.store.cellCount).toBe(16_384)
		expect(timed.longest()).toBeLessThan(budget(50))
	})

	it("reads rows of repeated columns in steps bounded by the cells read, not the cells kept", async () => {
		const opened = await openXlsx(bytesSource(foldingRows()))

		if (!opened.ok) throw new Error(opened.message)

		const timed = timedSlicing()
		const model = await opened.workbook.load(0, timed.slicing)

		expect(model.store.cellCount).toBe(FOLDING_ROWS)
		expect(timed.longest()).toBeLessThan(budget(50))
	})

	it("hears an abort while reading rows of repeated columns", async () => {
		const opened = await openXlsx(bytesSource(foldingRows()))

		if (!opened.ok) throw new Error(opened.message)

		// Looked at once before the part is read, then between the steps of sheetData: raised at the second look
		// (inside sheetData), heard at the next one.
		let looks = 0
		let raisedAt = 0
		let heardAfter = Number.POSITIVE_INFINITY
		const signal = {
			get aborted(): boolean {
				looks++

				if (looks === 2) raisedAt = cpuMs()
				if (looks === 3) heardAfter = cpuMs() - raisedAt

				return looks >= 3
			}
		}

		await expect(opened.workbook.load(0, undefined, signal)).rejects.toMatchObject({ code: "aborted" })
		expect(heardAfter).toBeLessThan(budget(50))
	})

	it("opens a row with a few repeated columns, the last one winning", async () => {
		const row = '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="A1"><v>3</v></c></row>'
		const opened = await openXlsx(bytesSource(sheetOf(row)))

		if (!opened.ok) throw new Error(opened.message)

		const store = (await opened.workbook.load(0)).store as SheetStore

		expect(store.cellCount).toBe(2)
		expect(store.value(store.locate(0, 0))).toBe(3)
		expect(store.value(store.locate(0, 1))).toBe(2)
	})

	it("refuses a row holding more cells than twice the grid's width", async () => {
		const opened = await openXlsx(bytesSource(sheetOf(`<row r="1">${REPEATED_A1.repeat(SHEET_MAX_COLS * 2 + 1)}</row>`)))

		if (!opened.ok) throw new Error(opened.message)

		await expect(opened.workbook.load(0)).rejects.toMatchObject({ code: "malformed" })
	})

	it("still opens a row of exactly twice the grid's width", async () => {
		const opened = await openXlsx(bytesSource(sheetOf(`<row r="1">${REPEATED_A1.repeat(SHEET_MAX_COLS * 2)}</row>`)))

		if (!opened.ok) throw new Error(opened.message)

		expect((await opened.workbook.load(0)).store.cellCount).toBe(1)
	})
})

const REPEATED_A1 = '<c r="A1"/>'
const FOLDING_ROWS = 64

// Rows of twice the grid's width of one repeated cell: each folds back to a single kept cell.
function foldingRows(): Uint8Array {
	const rows: string[] = []

	for (let row = 1; row <= FOLDING_ROWS; row++) rows.push(`<row r="${row}">${`<c r="A${row}"/>`.repeat(SHEET_MAX_COLS * 2)}</row>`)

	return sheetOf(rows.join(""))
}

// A slicing that records the longest CPU stretch between two pauses (and after the last one, once read).
function timedSlicing() {
	let longest = 0
	let last = cpuMs()
	const slicing = {
		sliceMs: 8,
		now: () => performance.now(),
		pause: () => {
			longest = Math.max(longest, cpuMs() - last)

			return new Promise<void>(resolve =>
				setImmediate(() => {
					last = cpuMs()
					resolve()
				})
			)
		}
	}

	return {
		slicing,
		longest: () => Math.max(longest, cpuMs() - last)
	}
}

function sheetOf(rows: string): Uint8Array {
	const sheet = encodeUtf8(`<worksheet xmlns="${SML}"><sheetData>${rows}</sheetData></worksheet>`)

	return zipSync(workbookFiles({ sheets: [{ bytes: sheet }] }), { mtime: ZIP_ENTRY_TIME })
}
