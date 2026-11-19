// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { registerAllActions } from "@/lib/keymap/actions"
import { preview } from "@/locales/en/preview"
import { goTo, openViewer, stubSheetCanvas } from "@/tests/support/sheetViewerHarness"

// Entries through the formula bar over a real text session on this thread, read back as the active cell comes back.

vi.mock("@/providers/themeProvider", async importOriginal =>
	(await import("@/tests/support/sheetViewerHarness")).themeProviderMock(await importOriginal<object>())
)

vi.mock("@/features/preview/hooks/usePreviewBytes", async () => (await import("@/tests/support/sheetViewerHarness")).previewBytesMock())

vi.mock("@/features/spreadsheet/lib/sheetHosts", async importOriginal =>
	(await import("@/tests/support/sheetViewerHarness")).sheetHostsMock(await importOriginal<object>())
)

registerAllActions()

beforeEach(stubSheetCanvas)

function contents(): string {
	return screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSpreadsheetCellContents }).value
}

describe("entries in a CSV", () => {
	it("show again in the formula bar when the active cell comes back to a row the file did not have", async () => {
		await openViewer(Uint8Array.from(new TextEncoder().encode("a,b\r\n1,2\r\n")), { name: "rows.csv", documentKey: "rows" })
		await goTo("A2")
		await waitFor(() => {
			expect(contents()).toBe("1")
		})

		await goTo("A3")

		const bar = screen.getByRole("textbox", { name: preview.previewSpreadsheetCellContents })

		await act(async () => {
			bar.focus()
			await Promise.resolve()
		})
		fireEvent.change(bar, { target: { value: "x" } })
		fireEvent.keyDown(bar, { key: "Enter" })

		await goTo("A5")
		await waitFor(() => {
			expect(contents()).toBe("")
		})
		await goTo("A3")
		await waitFor(() => {
			expect(contents()).toBe("x")
		})
	})
})
