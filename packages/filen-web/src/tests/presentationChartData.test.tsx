// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { slideRef } from "@filen/office/core/presentation"
import type { SheetGridModel } from "@filen/office/react/sheet"
import { ChartDataDialog } from "@/features/presentation/components/chartDataDialog"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import "@/lib/i18n"

// Edit Data's dismissal: a press beside the dialog never closes it, Escape closes it at once while nothing was edited
// and asks first once a cell was, and Try again opens the chart's data again after it failed.

const grid = vi.hoisted(() => ({ dirty: false }))

vi.mock("@/providers/themeProvider", async importOriginal =>
	(await import("@/tests/support/sheetViewerHarness")).themeProviderMock(await importOriginal<object>())
)
vi.mock("@/features/spreadsheet/lib/sheetHosts", () => ({
	openSheet: () => Promise.resolve({ kind: "opened", session: { close: () => undefined, save: () => Promise.resolve({ ok: false }) } })
}))
vi.mock("@/features/spreadsheet/lib/sheetDigitWidth", () => ({ withWorkbookDigit: (result: unknown) => Promise.resolve(result) }))
// The grid as far as dismissal goes: its document state, edited or not.
vi.mock("@filen/office/react/sheet", async importOriginal => {
	const snapshot = () => ({ state: { version: 0, dirty: grid.dirty, canUndo: false, canRedo: false }, editing: null })
	const model = { subscribe: () => () => undefined, getSnapshot: snapshot } as unknown as SheetGridModel

	return {
		...(await importOriginal<Record<string, unknown>>()),
		createSheetGrid: () => model,
		useSheetGrid: () => snapshot(),
		SheetGrid: () => <div data-testid="grid" />
	}
})

const target = { slide: slideRef(256), id: 7 }

function editorWith(chartData: () => Promise<unknown>): PresentationRibbonEditor {
	return {
		session: { chartData },
		command: () => Promise.resolve({ ok: true })
	} as unknown as PresentationRibbonEditor
}

const workbook = () => Promise.resolve({ workbook: { kind: "xlsx", bytes: new Uint8Array([1]) } })

function opened(chartData: () => Promise<unknown> = workbook): ReturnType<typeof vi.fn> {
	const onClose = vi.fn()

	render(
		<ChartDataDialog
			editor={editorWith(chartData)}
			target={target}
			onClose={onClose}
		/>
	)

	return onClose
}

function escape(): void {
	fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
}

afterEach(() => {
	cleanup()
	grid.dirty = false
})

describe("ChartDataDialog dismissal", () => {
	it("stays open on a press outside it after a cell was edited", async () => {
		grid.dirty = true

		const onClose = opened()

		await screen.findByTestId("grid")
		await act(async () => {
			fireEvent.pointerDown(document.body)
			fireEvent.mouseDown(document.body)
			fireEvent.click(document.body)
			await Promise.resolve()
		})

		expect(onClose).not.toHaveBeenCalled()
	})

	it("closes at once on Escape when nothing was edited", async () => {
		const onClose = opened()

		await screen.findByTestId("grid")
		escape()

		expect(onClose).toHaveBeenCalledTimes(1)
		expect(screen.queryByRole("alertdialog")).toBeNull()
	})

	it("asks before Escape discards edited cells, and closes once discarded", async () => {
		grid.dirty = true

		const onClose = opened()

		await screen.findByTestId("grid")
		escape()

		const confirm = await screen.findByRole("alertdialog")

		expect(onClose).not.toHaveBeenCalled()

		fireEvent.click(confirm.querySelector("[data-slot=alert-dialog-action]") ?? confirm)

		await waitFor(() => {
			expect(onClose).toHaveBeenCalledTimes(1)
		})
	})

	it("opens the chart's data again from Try again after it failed", async () => {
		const chartData = vi.fn().mockRejectedValueOnce(new Error("gone")).mockImplementation(workbook)

		opened(chartData)
		fireEvent.click(await screen.findByRole("button", { name: "Try again" }))

		await screen.findByTestId("grid")
		expect(chartData).toHaveBeenCalledTimes(2)
	})
})
