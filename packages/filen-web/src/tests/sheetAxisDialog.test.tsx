// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { SheetCommand } from "@filen/office/core/sheet"
import type { SheetGridState } from "@filen/office/react/sheet"
import "@/lib/i18n"
import { preview } from "@/locales/en/preview"
import { SheetAxisDialog, type SheetAxisDialogKind } from "@/features/spreadsheet/components/sheetAxisDialog"

// Excel's Insert and Delete dialogs for cells: its four options in its order, cells shifted by default, and each
// option's command.

afterEach(() => {
	cleanup()
})

const RANGE = { startRow: 1, startCol: 2, endRow: 3, endCol: 4 }

function open(kind: SheetAxisDialogKind, ranges = [RANGE]): ReturnType<typeof vi.fn<(command: SheetCommand) => void>> {
	const run = vi.fn<(command: SheetCommand) => void>()
	const grid = { sheet: 7, selection: { active: { row: 1, col: 2 }, ranges } } as unknown as SheetGridState

	render(
		<SheetAxisDialog
			kind={kind}
			grid={grid}
			run={run}
			onClose={() => undefined}
		/>
	)

	return run
}

function labels(): (string | null | undefined)[] {
	return screen.getAllByRole("radio").map(radio => radio.closest("div")?.textContent)
}

function checked(name: string): boolean {
	return screen.getByRole("radio", { name }).getAttribute("aria-checked") === "true"
}

describe("the Insert and Delete dialogs", () => {
	it("offers Excel's insert options in its order, shifting cells down by default", () => {
		const run = open("insert")

		expect(labels()).toEqual([
			preview.previewSheetShiftCellsRight,
			preview.previewSheetShiftCellsDown,
			preview.previewSheetDialogEntireRow,
			preview.previewSheetDialogEntireColumn
		])
		expect(checked(preview.previewSheetShiftCellsDown)).toBe(true)

		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetInsertDialogTitle }))

		expect(run).toHaveBeenCalledWith({ type: "cells.shift", sheet: 7, range: RANGE, edit: "insert", axis: "rows" })
	})

	it("shifts cells right, or inserts whole columns", () => {
		const run = open("insert")

		fireEvent.click(screen.getByRole("radio", { name: preview.previewSheetShiftCellsRight }))
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetInsertDialogTitle }))

		expect(run).toHaveBeenLastCalledWith({ type: "cells.shift", sheet: 7, range: RANGE, edit: "insert", axis: "cols" })

		cleanup()

		const columns = open("insert")

		fireEvent.click(screen.getByRole("radio", { name: preview.previewSheetDialogEntireColumn }))
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetInsertDialogTitle }))

		expect(columns).toHaveBeenLastCalledWith({ type: "axis.insert", sheet: 7, axis: "cols", at: 2, count: 3 })
	})

	it("deletes cells shifting up by default, left, or whole rows", () => {
		const run = open("delete")

		expect(labels()).toEqual([
			preview.previewSheetShiftCellsLeft,
			preview.previewSheetShiftCellsUp,
			preview.previewSheetDialogEntireRow,
			preview.previewSheetDialogEntireColumn
		])

		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetDeleteDialogTitle }))

		expect(run).toHaveBeenLastCalledWith({ type: "cells.shift", sheet: 7, range: RANGE, edit: "delete", axis: "rows" })

		cleanup()

		const left = open("delete")

		fireEvent.click(screen.getByRole("radio", { name: preview.previewSheetShiftCellsLeft }))
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetDeleteDialogTitle }))

		expect(left).toHaveBeenLastCalledWith({ type: "cells.shift", sheet: 7, range: RANGE, edit: "delete", axis: "cols" })

		cleanup()

		const rows = open("delete")

		fireEvent.click(screen.getByRole("radio", { name: preview.previewSheetDialogEntireRow }))
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetDeleteDialogTitle }))

		expect(rows).toHaveBeenLastCalledWith({ type: "axis.delete", sheet: 7, axis: "rows", at: 1, count: 3 })
	})

	it("deletes the entire rows of every selected range in one command", () => {
		const run = open("delete", [RANGE, { startRow: 6, startCol: 0, endRow: 7, endCol: 0 }])

		fireEvent.click(screen.getByRole("radio", { name: preview.previewSheetDialogEntireRow }))
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetDeleteDialogTitle }))

		expect(run).toHaveBeenLastCalledWith({
			type: "axis.delete",
			sheet: 7,
			axis: "rows",
			spans: [
				{ at: 1, count: 3 },
				{ at: 6, count: 2 }
			]
		})
	})

	it("keeps each dialog's own choice: one made in Insert never opens Delete", () => {
		const run = vi.fn<(command: SheetCommand) => void>()
		const grid = { sheet: 7, selection: { active: { row: 1, col: 2 }, ranges: [RANGE] } } as unknown as SheetGridState
		const dialog = (kind: SheetAxisDialogKind | null) => (
			<SheetAxisDialog
				kind={kind}
				grid={grid}
				run={run}
				onClose={() => undefined}
			/>
		)
		const { rerender } = render(dialog("insert"))

		fireEvent.click(screen.getByRole("radio", { name: preview.previewSheetDialogEntireColumn }))
		rerender(dialog(null))
		rerender(dialog("delete"))

		expect(checked(preview.previewSheetShiftCellsUp)).toBe(true)
		expect(checked(preview.previewSheetDialogEntireColumn)).toBe(false)

		fireEvent.click(screen.getByRole("radio", { name: preview.previewSheetDialogEntireRow }))
		rerender(dialog(null))
		rerender(dialog("insert"))

		expect(checked(preview.previewSheetDialogEntireColumn)).toBe(true)
	})
})
