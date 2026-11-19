import { describe, expect, it } from "vitest"
import { cellKey, newSheetName, parseTsv, pastedCells, pastedInputs, type CellView, type GridClip } from "../core/sheet/index"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetRange } from "../core/sheet/protocol"
import { openKeys, sheetBody } from "./sheetKeysFixtures"

function sheetOf(name: string, cells: [row: number, col: number, view: CellView][]) {
	const map = new Map(cells.map(([row, col, view]) => [cellKey(row, col), view]))

	return { name, cells: map }
}

// A1 3.14159265 shown "3.14", B1 "=A1*2", C1 "$1,234.50", D1 a date, E1 plain text.
const ROW = sheetOf("Data", [
	[0, 0, { text: "3.14", input: "3.14159265", numeric: true }],
	[0, 1, { text: "6.28", input: "=A1*2", numeric: true }],
	[0, 2, { text: "$1,234.50", input: "1234.5", numeric: true }],
	[0, 3, { text: "9/28/2026", input: "2026-09-28", numeric: true }],
	[0, 4, { text: "plain" }]
])
const RANGE = { startRow: 0, startCol: 0, endRow: 0, endCol: 4 }

// A range as the grid copies it: what each cell shows as tab-separated text (quoted where a tab, a line end or a
// quote would break it), and what the cells hold where that is not what they show.
function clipOf(sheet: ReturnType<typeof sheetOf>, range: typeof RANGE, cut: boolean): GridClip {
	const inputs = new Map<number, string>()
	const lines: string[] = []

	for (let row = range.startRow; row <= range.endRow; row++) {
		const fields: string[] = []

		for (let col = range.startCol; col <= range.endCol; col++) {
			const view = sheet.cells.get(cellKey(row, col))

			if (view?.input !== undefined) inputs.set(cellKey(row - range.startRow, col - range.startCol), view.input)

			const text = view?.text ?? ""

			fields.push(/[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text)
		}

		lines.push(fields.join("\t"))
	}

	return { tsv: lines.join("\r\n"), sheet: sheet.name, range, cut, inputs }
}

describe("grid clipboard", () => {
	it("pastes a copy's entries, relative references moved by the paste's offset", () => {
		const clip = clipOf(ROW, RANGE, false)
		const inputs = pastedInputs(clip, { row: 2, col: 5 }, "Data")

		expect(inputs.get(cellKey(0, 0))).toBe("3.14159265")
		expect(inputs.get(cellKey(0, 1))).toBe("=F3*2")
		expect(inputs.get(cellKey(0, 2))).toBe("1234.5")
		expect(inputs.get(cellKey(0, 3))).toBe("2026-09-28")
		expect(parseTsv(clip.tsv)[0]?.[4]).toBe("plain")
	})

	it("moves a cut's references into the range with its cells, and keeps the rest where they point", () => {
		const sheet = sheetOf("Data", [
			[0, 0, { text: "1", numeric: true }],
			[0, 1, { text: "2", input: "=A1*2+$A$1+Z9", numeric: true }]
		])
		const clip = clipOf(sheet, { startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, true)

		expect(pastedInputs(clip, { row: 0, col: 5 }, "Data").get(cellKey(0, 1))).toBe("=F1*2+$F$1+Z9")
		// Onto another sheet, what stays behind is named by its sheet.
		expect(pastedInputs(clip, { row: 0, col: 5 }, "Other").get(cellKey(0, 1))).toBe("=F1*2+$F$1+Data!Z9")
	})

	it("pastes a lone cell showing nothing, keeping its formula", () => {
		const sheet = sheetOf("Data", [[0, 0, { text: "", input: '=IF(B1="","",1)' }]])
		const clip = clipOf(sheet, { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, false)

		expect(clip.tsv).toBe("")
		expect(pastedCells(clip.tsv, clip, { row: 4, col: 2 }, "Data", 10)).toMatchObject({
			cells: [{ row: 4, col: 2, input: '=IF(D5="","",1)' }],
			rows: 1,
			cols: 1
		})
		// A cut too: its source is emptied by then.
		expect(
			pastedCells("", clipOf(sheet, { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, true), { row: 4, col: 2 }, "Data", 10)?.cells
		).toEqual([{ row: 4, col: 2, input: '=IF(B1="","",1)' }])
	})

	it("fills the whole range, a last row of blanks included", () => {
		const sheet = sheetOf("Data", [
			[0, 0, { text: "2", input: "=1+1", numeric: true }],
			[2, 0, { text: "", input: '=""' }]
		])
		const clip = clipOf(sheet, { startRow: 0, startCol: 0, endRow: 2, endCol: 0 }, false)

		// The text drops the last row, blank as it shows.
		expect(parseTsv(clip.tsv)).toEqual([["2"], [""]])
		expect(pastedCells(clip.tsv, clip, { row: 0, col: 3 }, "Data", 10)).toMatchObject({
			cells: [
				{ row: 0, col: 3, input: "=1+1" },
				{ row: 1, col: 3, input: "" },
				{ row: 2, col: 3, input: '=""' }
			],
			rows: 3,
			cols: 1
		})
	})

	it("pastes other text as it parses, and keeps the clip a copy leaves", () => {
		expect(pastedCells("x\ty\r\nz\r\n", null, { row: 1, col: 1 }, "Data", 10)).toEqual({
			cells: [
				{ row: 1, col: 1, input: "x" },
				{ row: 1, col: 2, input: "y" },
				{ row: 2, col: 1, input: "z" }
			],
			rows: 2,
			cols: 2,
			clip: null
		})

		const clip = clipOf(ROW, RANGE, false)

		expect(pastedCells(clip.tsv, clip, { row: 2, col: 0 }, "Data", 10)?.clip).toBe(clip)
	})

	it("keeps a pasted cut as a copy of where it landed", () => {
		const sheet = sheetOf("Data", [[0, 1, { text: "2", input: "=A1*2", numeric: true }]])
		const moved = pastedCells(
			"2",
			clipOf(sheet, { startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, true),
			{ row: 3, col: 5 },
			"Data",
			10
		)?.clip

		expect(moved).toMatchObject({ sheet: "Data", cut: false, range: { startRow: 3, startCol: 5, endRow: 3, endCol: 6 } })
		expect(moved?.inputs.get(cellKey(0, 1))).toBe("=F4*2")
	})

	it("gives up past the edit limit", () => {
		const clip = clipOf(ROW, RANGE, false)

		expect(pastedCells(clip.tsv, clip, { row: 0, col: 0 }, "Data", 4)).toBeNull()
		expect(pastedCells("a\tb\tc", null, { row: 0, col: 0 }, "Data", 2)).toBeNull()
	})
})

describe("newSheetName", () => {
	const nameFor = (number: number) => `Sheet ${String(number)}`

	it("numbers after the sheets there are, past any name taken", () => {
		expect(newSheetName(["Sheet 1"], nameFor)).toBe("Sheet 2")
		expect(newSheetName(["Sheet1", "Sheet 3"], nameFor)).toBe("Sheet 4")
		expect(newSheetName(["sheet 2"], nameFor)).toBe("Sheet 3")
	})
})

describe("a workbook's copy of whole columns and rows", () => {
	it("copies the used cells' text, however far the range reaches", async () => {
		const { session } = await openKeys({ sheets: [{ name: "S", body: sheetBody([["a", 1], ["b", 2], ["c"]]) }] })
		const copyText = async (range: SheetRange): Promise<string> => {
			const copy = await session.query("copy", { sheet: 0, range, cut: false })

			if ("refused" in copy) throw new Error(copy.refused)

			return copy.text
		}

		expect(await copyText({ startRow: 0, startCol: 1, endRow: SHEET_MAX_ROWS - 1, endCol: 1 })).toBe("1\r\n2\r\n")
		expect(await copyText({ startRow: 0, startCol: 0, endRow: 0, endCol: SHEET_MAX_COLS - 1 })).toBe("a\t1")
		expect(await copyText({ startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 })).toBe(
			"a\t1\r\nb\t2\r\nc\t"
		)
		expect(await copyText({ startRow: 10, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: 0 })).toBe("")
		session.close()
	})
})
