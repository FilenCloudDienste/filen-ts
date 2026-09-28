import { describe, expect, it } from "vitest"
import { clearedCells, newSheetName } from "@/features/spreadsheet/lib/gridEdits.logic"
import { cellKey, type CellView } from "@/features/spreadsheet/lib/model"
import { endedCut, parseTsv, pastedCells, pastedInputs, rangeToClip, type GridClip } from "@/features/spreadsheet/lib/tsv.logic"

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

function clipOf(sheet: ReturnType<typeof sheetOf>, range: typeof RANGE, cut: boolean): GridClip {
	const clip = rangeToClip(sheet, range, cut)

	if (clip === null) {
		throw new Error("expected a clip")
	}

	return clip
}

describe("grid clipboard", () => {
	it("copies what cells show, keeping beside it what they hold", () => {
		const clip = rangeToClip(ROW, RANGE, false)

		expect(clip?.tsv).toBe("3.14\t6.28\t$1,234.50\t9/28/2026\tplain")
		expect(clip?.inputs.size).toBe(4)
		expect(clip?.inputs.get(cellKey(0, 4))).toBeUndefined()
	})

	it("pastes a copy's entries, relative references moved by the paste's offset", () => {
		const clip = rangeToClip(ROW, RANGE, false)

		if (clip === null) {
			throw new Error("expected a clip")
		}

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
		const clip = rangeToClip(sheet, { startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, true)

		if (clip === null) {
			throw new Error("expected a clip")
		}

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

	// A1 1, B1 "=$A$1*2": cut A1:B1, undone, pasted at F1.
	it("copies a cut once its cells changed since", () => {
		const sheet = sheetOf("Data", [
			[0, 0, { text: "1", numeric: true }],
			[0, 1, { text: "2", input: "=$A$1*2", numeric: true }]
		])
		const cut = clipOf(sheet, { startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, true)
		const ended = endedCut(cut)

		expect(pastedCells(cut.tsv, cut, { row: 0, col: 5 }, "Data", 10)?.cells[1]?.input).toBe("=$F$1*2")
		expect(ended).toMatchObject({ cut: false, range: cut.range, inputs: cut.inputs })
		expect(pastedCells(cut.tsv, ended, { row: 0, col: 5 }, "Data", 10)?.cells[1]?.input).toBe("=$A$1*2")

		const copy = clipOf(sheet, { startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, false)

		expect(endedCut(copy)).toBe(copy)
		expect(endedCut(null)).toBeNull()
	})

	it("is refused past the copy limit", () => {
		expect(rangeToClip(ROW, { startRow: 0, startCol: 0, endRow: 1_048_575, endCol: 4 }, false)).toBeNull()
	})
})

describe("clearedCells", () => {
	const cells = new Map([
		[cellKey(0, 0), { text: "a" }],
		[cellKey(1, 1), { text: "b" }],
		[cellKey(5, 2), { text: "c" }]
	])
	const store = { size: cells.size, has: (key: number) => cells.has(key), keys: () => cells.keys() }

	it("empties the filled cells in the range, walking the range or the cells", () => {
		expect(clearedCells(store, { startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, 10)).toEqual([{ row: 0, col: 0, input: "" }])
		expect(clearedCells(store, { startRow: 0, startCol: 0, endRow: 1_000, endCol: 1 }, 10)).toEqual([
			{ row: 0, col: 0, input: "" },
			{ row: 1, col: 1, input: "" }
		])
	})

	it("gives up past the limit, either way", () => {
		// A range no larger than the filled cells is walked cell by cell.
		expect(clearedCells(store, { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, 0)).toBeNull()
		expect(clearedCells(store, { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, 1)).toBeNull()
		expect(clearedCells(store, { startRow: 0, startCol: 0, endRow: 1_000, endCol: 16_000 }, 2)).toBeNull()
		expect(clearedCells(store, { startRow: 0, startCol: 0, endRow: 1_000, endCol: 16_000 }, 3)).toHaveLength(3)
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
