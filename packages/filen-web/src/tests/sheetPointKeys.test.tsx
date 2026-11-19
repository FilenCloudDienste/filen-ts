// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { writeXlsx } from "hucre/xlsx"
import { registerAllActions } from "@/lib/keymap/actions"
import { preview } from "@/locales/en/preview"
import { openViewer as openSheetViewer, stubSheetCanvas } from "@/tests/support/sheetViewerHarness"

// Point mode from the keyboard, as in Excel: in a formula's entry where a reference may go, an arrow points at a cell
// and Shift+arrow widens the reference to a range; elsewhere an arrow commits the entry.

vi.mock("@/providers/themeProvider", async importOriginal =>
	(await import("@/tests/support/sheetViewerHarness")).themeProviderMock(await importOriginal<object>())
)

vi.mock("@/features/preview/hooks/usePreviewBytes", async () => (await import("@/tests/support/sheetViewerHarness")).previewBytesMock())

vi.mock("@/features/spreadsheet/lib/sheetHosts", async importOriginal =>
	(await import("@/tests/support/sheetViewerHarness")).sheetHostsMock(await importOriginal<object>())
)

registerAllActions()

beforeEach(stubSheetCanvas)

// Opens the in-cell editor on A1 and types `text` into it, the caret at its end.
async function typeInCell(text: string): Promise<HTMLTextAreaElement> {
	const grid = await openSheetViewer(await writeXlsx({ sheets: [{ name: "Data", rows: [[null, 5], [1], [2]] }] }), {
		name: "point.xlsx",
		documentKey: "point"
	})

	await act(async () => {
		grid.focus()
		await Promise.resolve()
	})
	fireEvent.keyDown(grid, { key: "=" })

	const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: preview.previewSheetCellEditor })

	fireEvent.change(editor, { target: { value: text } })
	await waitFor(() => {
		expect(editor.value).toBe(text)
	})
	editor.setSelectionRange(text.length, text.length)

	return editor
}

function cellEditor(): HTMLTextAreaElement | null {
	return screen.queryByRole<HTMLTextAreaElement>("textbox", { name: preview.previewSheetCellEditor })
}

describe("arrows in a formula's entry", () => {
	it("point at the cells next to the edited one, Shift widening the reference to a range", async () => {
		const editor = await typeInCell("=SUM(")

		fireEvent.keyDown(editor, { key: "ArrowDown" })
		expect(editor.value).toBe("=SUM(A2")

		fireEvent.keyDown(editor, { key: "ArrowDown" })
		expect(editor.value).toBe("=SUM(A3")

		fireEvent.keyDown(editor, { key: "ArrowUp", shiftKey: true })
		expect(editor.value).toBe("=SUM(A2:A3")

		fireEvent.keyDown(editor, { key: "ArrowRight", shiftKey: true })
		expect(editor.value).toBe("=SUM(A2:B3")
		expect(cellEditor()).toBe(editor)

		// Typed on after it, the reference stays; a new one goes after the separator.
		fireEvent.change(editor, { target: { value: "=SUM(A2:B3," } })
		editor.setSelectionRange(editor.value.length, editor.value.length)
		fireEvent.keyDown(editor, { key: "ArrowRight" })
		expect(editor.value).toBe("=SUM(A2:B3,B1")
	})

	it("commit the entry where no reference may go", async () => {
		const editor = await typeInCell("=12")

		fireEvent.keyDown(editor, { key: "ArrowDown" })

		await waitFor(() => {
			expect(cellEditor()).toBeNull()
		})
	})
})
