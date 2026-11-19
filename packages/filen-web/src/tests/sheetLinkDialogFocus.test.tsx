// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { registerAllActions } from "@/lib/keymap/actions"
import { common } from "@/locales/en/common"
import { preview } from "@/locales/en/preview"
import { workbook } from "@/tests/sheetMenusFixtures"
import { goTo, openViewer as openSheetViewer, stubSheetCanvas } from "@/tests/support/sheetViewerHarness"

// The link dialog (Ctrl/Cmd+K, Edit link) gives the grid its focus back however it closes, as the other dialogs do.

vi.mock("@/providers/themeProvider", async importOriginal =>
	(await import("@/tests/support/sheetViewerHarness")).themeProviderMock(await importOriginal<object>())
)

vi.mock("@/features/preview/hooks/usePreviewBytes", async () => (await import("@/tests/support/sheetViewerHarness")).previewBytesMock())

vi.mock("@/features/spreadsheet/lib/sheetHosts", async importOriginal =>
	(await import("@/tests/support/sheetViewerHarness")).sheetHostsMock(await importOriginal<object>())
)

// The find field is the document editor's, which binds Mod+F through the app's keymap.
registerAllActions()

beforeEach(stubSheetCanvas)

async function openViewer(name: string, source: Uint8Array): Promise<HTMLElement> {
	return await openSheetViewer(source, {
		name,
		wrap: viewer => <QueryClientProvider client={new QueryClient()}>{viewer}</QueryClientProvider>
	})
}

async function openLinkDialog(): Promise<{ grid: HTMLElement; dialog: HTMLElement }> {
	const grid = await openViewer(
		"links.xlsx",
		await workbook([
			{
				name: "One",
				rows: [
					["a", "b"],
					["c", "d"]
				]
			}
		])
	)

	await goTo("B2")
	grid.focus()
	fireEvent.keyDown(grid, { key: "k", code: "KeyK", ctrlKey: true })

	return { grid, dialog: await screen.findByRole("dialog", {}, { timeout: 3000 }) }
}

async function closed(grid: HTMLElement): Promise<void> {
	await waitFor(() => {
		expect(screen.queryByRole("dialog")).toBeNull()
	})
	// Still there once the dialog's own closing work is done.
	await new Promise(resolve => setTimeout(resolve, 300))
	await waitFor(() => {
		expect(document.activeElement).toBe(grid)
	})
}

describe("the link dialog", () => {
	it("gives the grid its focus back when cancelled", { timeout: 30_000 }, async () => {
		const { grid, dialog } = await openLinkDialog()

		fireEvent.click(within(dialog).getByRole("button", { name: common.cancel }))
		await closed(grid)
	})

	it("gives the grid its focus back on Escape", { timeout: 30_000 }, async () => {
		const { grid, dialog } = await openLinkDialog()

		fireEvent.keyDown(within(dialog).getByRole("textbox", { name: preview.previewSheetLinkAddress }), { key: "Escape" })
		await closed(grid)
	})

	it("gives the grid its focus back when applied, and starts from the cell on the next opening", { timeout: 30_000 }, async () => {
		const { grid, dialog } = await openLinkDialog()

		fireEvent.change(within(dialog).getByRole("textbox", { name: preview.previewSheetLinkAddress }), { target: { value: "filen.io" } })
		fireEvent.click(within(dialog).getByRole("button", { name: preview.previewSheetLinkApply }))
		await closed(grid)

		await goTo("A1")
		grid.focus()
		fireEvent.keyDown(grid, { key: "k", code: "KeyK", ctrlKey: true })

		const next = await screen.findByRole("dialog", {}, { timeout: 3000 })

		expect(within(next).getByRole<HTMLInputElement>("textbox", { name: preview.previewSheetLinkAddress }).value).toBe("")
		expect(within(next).getByRole<HTMLInputElement>("textbox", { name: preview.previewSheetLinkText }).value).toBe("a")
	})
})
