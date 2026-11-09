// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { writeXlsx } from "hucre/xlsx"
import { inThreadSheetHost } from "@filen/office/dom/sheet"
import type { DriveItem } from "@/features/drive/lib/item"
import { registerAllActions } from "@/lib/keymap/actions"
import { common } from "@/locales/en/common"
import { preview } from "@/locales/en/preview"

// The grid's shortcuts the viewer takes, over a real session on this thread: the insert and delete dialogs for cells,
// Find Next from the grid, and a merge F4 repeats asking again about the values it would drop.

const { bytes } = vi.hoisted(() => {
	const held: { current: Uint8Array } = { current: new Uint8Array(0) }

	return { bytes: held }
})

vi.mock("@/providers/themeProvider", async importOriginal => ({
	...(await importOriginal<typeof import("@/providers/themeProvider")>()),
	useTheme: () => ({ theme: "light" })
}))

vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: bytes.current, refetch: () => undefined })
}))

vi.mock("@/features/spreadsheet/lib/sheetHosts", async importOriginal => {
	const host = inThreadSheetHost()

	return {
		...(await importOriginal<typeof import("@/features/spreadsheet/lib/sheetHosts")>()),
		openSheet: (source: Uint8Array, options: Parameters<typeof host.open>[1], onEvent: Parameters<typeof host.open>[2]) =>
			host.open(source, options, onEvent)
	}
})

const { SheetViewer } = await import("@/features/spreadsheet/sheetViewer")

// The find field is the document editor's, which binds Mod+F through the app's keymap.
registerAllActions()

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe = vi.fn()
			unobserve = vi.fn()
			disconnect = vi.fn()
		}
	)
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
})

function file(name: string): DriveItem {
	return { type: "file", data: { uuid: `u-${name}`, decryptedMeta: { name }, size: 1n } } as unknown as DriveItem
}

function nameBox(): string {
	return screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSheetNameBox }).value
}

function contents(): string {
	return screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSpreadsheetCellContents }).value
}

async function goTo(reference: string): Promise<void> {
	const box = screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSheetNameBox })

	fireEvent.focus(box)
	fireEvent.change(box, { target: { value: reference } })
	fireEvent.keyDown(box, { key: "Enter" })
	// The box shows the active cell: a range's top left.
	await waitFor(() => {
		expect(nameBox()).toBe(reference.split(":")[0])
	})
}

async function openViewer(name: string, source: Uint8Array): Promise<HTMLElement> {
	bytes.current = source

	render(
		<SheetViewer
			item={file(name)}
			documentKey={name}
			alt={name}
			editable
			saveRef={{ current: null }}
		/>
	)

	await screen.findByRole("textbox", { name: preview.previewSpreadsheetCellContents })

	return await screen.findByRole("grid", {}, { timeout: 5000 })
}

describe("the spreadsheet viewer's grid shortcuts", () => {
	it("asks with Ctrl+Minus on cells how to delete them, as Excel's Delete dialog", async () => {
		const grid = await openViewer("rows.csv", Uint8Array.from(new TextEncoder().encode("a,b,c\r\n1,2,x\r\n3,4,y\r\n")))

		await goTo("A2:B2")
		fireEvent.keyDown(grid, { key: "-", code: "Minus", ctrlKey: true })

		const dialog = await screen.findByRole("dialog", { name: preview.previewSheetDeleteDialogTitle })

		expect(screen.getByRole("radio", { name: preview.previewSheetShiftCellsUp }).getAttribute("aria-checked")).toBe("true")
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetDeleteDialogTitle }))
		await waitFor(() => {
			expect(dialog.isConnected).toBe(false)
		})

		// The cells below moved up; the column beside the selection kept its own.
		await goTo("A2")
		await waitFor(() => {
			expect(contents()).toBe("3")
		})
		await goTo("C2")
		await waitFor(() => {
			expect(contents()).toBe("x")
		})
	})

	it("inserts whole columns at cells through the Insert dialog (Ctrl+Shift+Plus)", async () => {
		const grid = await openViewer("cols.csv", Uint8Array.from(new TextEncoder().encode("a,b\r\n1,2\r\n")))

		await goTo("A1")
		fireEvent.keyDown(grid, { key: "+", code: "Equal", ctrlKey: true, shiftKey: true })
		await screen.findByRole("dialog", { name: preview.previewSheetInsertDialogTitle })
		fireEvent.click(screen.getByRole("radio", { name: preview.previewSheetDialogEntireColumn }))
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetInsertDialogTitle }))

		await goTo("B1")
		await waitFor(() => {
			expect(contents()).toBe("a")
		})
	})

	it("steps the find bar's matches with Shift+F4 from the grid, and opens the bar when nothing was found", async () => {
		const grid = await openViewer("fruit.csv", Uint8Array.from(new TextEncoder().encode("apple\r\npear\r\napple\r\n")))

		fireEvent.keyDown(grid, { key: "F4", code: "F4", shiftKey: true })

		const field = await screen.findByRole("searchbox", { name: preview.previewDocxFindPlaceholder })

		fireEvent.change(field, { target: { value: "apple" } })
		await waitFor(() => {
			expect(screen.getByText("1/2")).toBeTruthy()
		})

		fireEvent.keyDown(grid, { key: "F4", code: "F4", shiftKey: true })
		await waitFor(() => {
			expect(nameBox()).toBe("A3")
		})
		fireEvent.keyDown(grid, { key: "F4", code: "F4", ctrlKey: true, shiftKey: true })
		await waitFor(() => {
			expect(nameBox()).toBe("A1")
		})
	})

	it("asks again before F4 repeats a merge on cells whose values it would drop", async () => {
		const grid = await openViewer(
			"merge.xlsx",
			await writeXlsx({
				sheets: [
					{
						name: "One",
						rows: [
							["a", "b"],
							["c", "d"]
						]
					}
				]
			})
		)

		await goTo("A1:B1")
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetMerge }))
		fireEvent.click(await screen.findByRole("menuitem", { name: preview.previewSheetMergeCells }))
		fireEvent.click(await screen.findByRole("button", { name: preview.previewSheetMergeCells }))
		await waitFor(() => {
			expect(screen.queryByText(preview.previewSheetMergeLosesBody)).toBeNull()
		})

		await goTo("A2:B2")
		fireEvent.keyDown(grid, { key: "F4", code: "F4" })
		await screen.findByText(preview.previewSheetMergeLosesBody)

		// Nothing dropped while it asks; cancelled, nothing merged.
		fireEvent.click(screen.getByRole("button", { name: common.cancel }))
		await waitFor(() => {
			expect(screen.queryByText(preview.previewSheetMergeLosesBody)).toBeNull()
		})
		await goTo("B2")
		expect(contents()).toBe("d")
	})
})
