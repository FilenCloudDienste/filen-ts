// @vitest-environment jsdom

import { webcrypto } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import type { SheetRange, SheetSelectionStats } from "@filen/office/core/sheet"
import type { SheetGridModel } from "@filen/office/react/sheet"
import { openGrid, workbook } from "@/tests/sheetMenusFixtures"
import { GridHarness } from "@/tests/sheetMenusHarness"
import { LatestQuery, singleCell, statusSummary } from "@/features/spreadsheet/components/sheetStatusBar.logic"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string, options?: { value?: unknown }) => `${key}=${String(options?.value)}` })
}))

const { SheetStatusBar } = await import("@/features/spreadsheet/components/sheetStatusBar")

// Excel's status bar: Average, Count and Sum of a selection of more than one cell.

function stats(partial: Partial<SheetSelectionStats>): SheetSelectionStats {
	return { count: 0, numericCount: 0, sum: "", average: "", error: false, version: 0, ...partial }
}

function select(model: SheetGridModel, range: SheetRange): void {
	const active = { row: range.startRow, col: range.startCol }

	act(() => {
		model.select({ active, anchor: active, focus: { row: range.endRow, col: range.endCol }, ranges: [range] })
	})
}

describe("the status bar's summary", () => {
	it("shows nothing for fewer than two cells that hold something", () => {
		expect(statusSummary(null)).toBeNull()
		expect(statusSummary(stats({ count: 1, numericCount: 1, sum: "4", average: "4" }))).toBeNull()
	})

	it("shows Count alone without numbers or with an error, and Average and Sum with numbers", () => {
		expect(statusSummary(stats({ count: 2 }))).toEqual({ count: 2, average: null, sum: null })
		expect(statusSummary(stats({ count: 3, numericCount: 2, error: true }))).toEqual({ count: 3, average: null, sum: null })
		expect(statusSummary(stats({ count: 3, numericCount: 2, sum: "6", average: "3" }))).toEqual({ count: 3, average: "3", sum: "6" })
	})

	it("asks nothing for one cell", () => {
		expect(singleCell([{ startRow: 2, startCol: 2, endRow: 2, endCol: 2 }])).toBe(true)
		expect(singleCell([{ startRow: 2, startCol: 2, endRow: 3, endCol: 2 }])).toBe(false)
		expect(
			singleCell([
				{ startRow: 2, startCol: 2, endRow: 2, endCol: 2 },
				{ startRow: 4, startCol: 2, endRow: 4, endCol: 2 }
			])
		).toBe(false)
	})
})

describe("LatestQuery", () => {
	it("asks once per answer, for the latest request only, and delivers only its answer", async () => {
		const resolvers: ((value: number) => void)[] = []
		const asked: number[] = []
		const delivered: number[] = []
		const query = new LatestQuery<number, number>(
			request => {
				asked.push(request)

				return new Promise<number>(resolve => {
					resolvers.push(resolve)
				})
			},
			result => {
				delivered.push(result)
			}
		)

		query.request(1)
		query.request(2)
		query.request(3)
		expect(asked).toEqual([1])

		resolvers[0]?.(10)
		await Promise.resolve()
		await Promise.resolve()
		// The first answer is stale: only the latest request is asked next.
		expect(delivered).toEqual([])
		expect(asked).toEqual([1, 3])

		resolvers[1]?.(30)
		await Promise.resolve()
		await Promise.resolve()
		expect(delivered).toEqual([30])

		query.request(4)
		query.cancel()
		resolvers[2]?.(40)
		await Promise.resolve()
		await Promise.resolve()
		expect(delivered).toEqual([30])
	})
})

describe("the status bar", () => {
	beforeEach(() => {
		vi.stubGlobal("crypto", webcrypto)
	})

	it("shows the Average, Count and Sum of the selection, and nothing for one cell", async () => {
		const model = await openGrid(
			await workbook([
				{
					name: "One",
					rows: [
						[1, "text"],
						[2, null],
						[3, null]
					]
				}
			]),
			"xlsx"
		)

		const { container } = render(
			<GridHarness model={model}>
				{grid => (
					<SheetStatusBar
						grid={grid}
						session={model.session}
						cellless={false}
					/>
				)}
			</GridHarness>
		)

		select(model, { startRow: 0, startCol: 0, endRow: 2, endCol: 1 })
		await waitFor(() => {
			expect(screen.getByText("previewSheetStatusSum=6")).toBeTruthy()
		})
		expect(screen.getByText("previewSheetStatusAverage=2")).toBeTruthy()
		expect(screen.getByText("previewSheetStatusCount=4")).toBeTruthy()

		select(model, { startRow: 0, startCol: 0, endRow: 0, endCol: 0 })
		expect(container.textContent).toBe("")
	})
})
