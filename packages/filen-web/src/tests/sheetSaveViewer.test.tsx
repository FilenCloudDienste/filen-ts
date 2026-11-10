// @vitest-environment jsdom

import "@/tests/support/officeKeys"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { writeXlsx } from "hucre/xlsx"
import { inThreadSheetHost } from "@filen/office/dom/sheet"
import { CellFlag, type SheetFileKind, type SheetQueryResult } from "@filen/office/core/sheet"
import type { DriveItem } from "@/features/drive/lib/item"
import type { SpreadsheetSnapshot } from "@/features/spreadsheet/save/sheetSave.logic"
import { WORKBOOK_PASSWORD, encryptedWorkbook } from "@/tests/encryptedWorkbookFixtures"
import { preview } from "@/locales/en/preview"
import { PreviewDownloadableProvider } from "@/features/preview/lib/accessMode"

// Saving on the spreadsheet viewer, over real sessions on this thread (an in-thread host stands in for each
// worker): idle autosave asks the overlay, Save as .xlsx carries a text file's edits into the copy it uploads and
// opens, and Download as CSV hands out Excel's "CSV UTF-8" of the sheet on show, never a protected workbook's.

const hooks = vi.hoisted(() => {
	const state: {
		bytes: Uint8Array
		settings: { authorName: string | null; autosave: boolean; loaded: boolean }
		uploads: Uint8Array[]
		downloads: { name: string; blob: Blob }[]
		autosaveChoices: boolean[]
	} = {
		bytes: new Uint8Array(0),
		settings: { authorName: null, autosave: true, loaded: true },
		uploads: [],
		downloads: [],
		autosaveChoices: []
	}

	return state
})

vi.mock("@/providers/themeProvider", async importOriginal => ({
	...(await importOriginal<typeof import("@/providers/themeProvider")>()),
	useTheme: () => ({ theme: "light" })
}))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: hooks.bytes, refetch: () => undefined })
}))
vi.mock("@/features/spreadsheet/lib/sheetHosts", async importOriginal => {
	const host = inThreadSheetHost()

	return {
		...(await importOriginal<typeof import("@/features/spreadsheet/lib/sheetHosts")>()),
		openSheet: (source: Uint8Array, options: Parameters<typeof host.open>[1], onEvent: Parameters<typeof host.open>[2]) =>
			host.open(source, options, onEvent),
		// As the workbook worker does it (lib/sheetHosts.ts), on this thread.
		textToXlsx: async (cells: Uint8Array, name: string): Promise<SheetQueryResult<"saveAs.xlsx">> => {
			const opened = await host.open(cells, { kind: "tsv" }, () => undefined)

			if (opened.kind !== "opened") throw new Error(opened.kind)

			try {
				return await opened.session.query("saveAs.xlsx", { name })
			} finally {
				opened.session.close()
			}
		}
	}
})
vi.mock("@/features/spreadsheet/lib/saveAsXlsx", () => ({
	uploadXlsxCopy: (item: DriveItem, bytes: Uint8Array) => {
		hooks.uploads.push(bytes)

		return Promise.resolve({ status: "saved", item: { ...item, data: { ...item.data, uuid: "copy" } }, name: "copy.xlsx" })
	}
}))
vi.mock("@/lib/downloadBlob", () => ({
	downloadBlob: (name: string, blob: Blob) => {
		hooks.downloads.push({ name, blob })
	}
}))
vi.mock("@/features/office/lib/officeSettings", () => ({
	loadOfficeSettings: () => Promise.resolve(),
	saveOfficeAutosave: (autosave: boolean) => {
		hooks.autosaveChoices.push(autosave)

		return Promise.resolve()
	},
	useOfficeSettings: () => hooks.settings
}))
vi.mock("@/features/office/lib/officeAutosave", () => ({ AUTOSAVE_IDLE_MS: 100, E2E_AUTOSAVE_OFF: false }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }))

const { SheetViewer } = await import("@/features/spreadsheet/sheetViewer")

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
	hooks.settings = { authorName: null, autosave: true, loaded: true }
	hooks.uploads = []
	hooks.downloads = []
	hooks.autosaveChoices = []
})

function file(name: string): DriveItem {
	return { type: "file", data: { uuid: `u-${name}`, decryptedMeta: { name }, size: 1n } } as unknown as DriveItem
}

async function budget(): Promise<Uint8Array> {
	return await writeXlsx({
		sheets: [
			{
				name: "Budget",
				rows: [
					["Item", "Cost"],
					["Rent", 1200]
				]
			},
			{ name: "Notes", rows: [["second"]] }
		]
	})
}

// A cell of a workbook as a fresh session shows it: its text, and whether it holds a number.
async function cellOf(bytes: Uint8Array, kind: SheetFileKind, row: number, col: number): Promise<{ text: string; number: boolean }> {
	const host = inThreadSheetHost()
	const opened = await host.open(bytes.slice(), { kind }, () => undefined)

	if (opened.kind !== "opened") throw new Error(opened.kind)

	const { tiles } = await opened.session.tiles(opened.info.activeSheet, Uint32Array.of(0, 0))
	const tile = tiles[0]
	const at = tile?.positions.indexOf(row * 32 + col) ?? -1
	const text = at < 0 ? "" : (tile?.strings[tile.texts[at] ?? -1] ?? "")
	const number = at >= 0 && ((tile?.flags[at] ?? 0) & CellFlag.NUMBER) !== 0

	host.dispose()

	return { text, number }
}

async function enter(cell: string, text: string): Promise<void> {
	const box = screen.getByRole("textbox", { name: preview.previewSheetNameBox })

	fireEvent.focus(box)
	fireEvent.change(box, { target: { value: cell } })
	fireEvent.keyDown(box, { key: "Enter" })

	const bar = await screen.findByRole("textbox", { name: preview.previewSpreadsheetCellContents })

	await act(async () => {
		bar.focus()
		await Promise.resolve()
	})
	fireEvent.change(bar, { target: { value: text } })
	fireEvent.keyDown(bar, { key: "Enter" })
}

// Enters `text` ("A4"-style cells only) and waits for the commit to move down a row, as Enter does.
async function entered(cell: string, text: string): Promise<void> {
	await enter(cell, text)

	const box = screen.getByRole("textbox", { name: preview.previewSheetNameBox })
	const below = `${cell.replace(/\d+$/, "")}${String(Number(cell.replace(/^\D+/, "")) + 1)}`

	await waitFor(() => {
		expect(box).toHaveProperty("value", below)
	})
}

async function openFileMenu(): Promise<void> {
	const trigger = await screen.findByRole("button", { name: preview.previewSheetFileMenu })

	await act(async () => {
		trigger.focus()
		fireEvent.keyDown(trigger, { key: "ArrowDown" })
		await Promise.resolve()
	})
}

describe("saving on the spreadsheet viewer", () => {
	it("saves an edited CSV as an .xlsx copy holding its edits, numbers as numbers, and shows the copy", async () => {
		// This realm's array: jsdom's TextEncoder answers in its own.
		hooks.bytes = Uint8Array.from(new TextEncoder().encode("Name;Qty\r\nApples;3\r\n=1+2;007\r\n"))

		const opened = vi.fn()
		const saveRef = { current: null as (() => Promise<SpreadsheetSnapshot>) | null }

		render(
			<SheetViewer
				item={file("fruit.csv")}
				documentKey="k1"
				alt="fruit.csv"
				editable
				canSaveCopy
				saveRef={saveRef}
				onOpenFile={opened}
			/>
		)

		await screen.findByRole("textbox", { name: preview.previewSpreadsheetCellContents })
		await entered("A4", "Plums")
		await entered("B4", "12")
		await openFileMenu()
		fireEvent.click(await screen.findByRole("menuitem", { name: preview.previewSpreadsheetSaveAsXlsx }))

		const confirm = await screen.findByRole("alertdialog")

		expect(within(confirm).getByText(preview.previewSheetSaveAsXlsxTextBody)).toBeTruthy()
		fireEvent.click(within(confirm).getByRole("button", { name: preview.previewSpreadsheetSaveAsXlsx }))

		await waitFor(() => {
			expect(opened).toHaveBeenCalledTimes(1)
		})

		const copy = hooks.uploads[0] ?? new Uint8Array(0)

		expect(await cellOf(copy, "xlsx", 1, 0)).toEqual({ text: "Apples", number: false })
		expect(await cellOf(copy, "xlsx", 1, 1)).toEqual({ text: "3", number: true })
		// A formula and a leading zero stay the text the file held.
		expect(await cellOf(copy, "xlsx", 2, 0)).toEqual({ text: "=1+2", number: false })
		expect(await cellOf(copy, "xlsx", 2, 1)).toEqual({ text: "007", number: false })
		// The edits made before the copy, not yet saved to the CSV.
		expect(await cellOf(copy, "xlsx", 3, 0)).toEqual({ text: "Plums", number: false })
		expect(await cellOf(copy, "xlsx", 3, 1)).toEqual({ text: "12", number: true })
		expect((opened.mock.calls[0]?.[0] as DriveItem).data.uuid).toBe("copy")
	}, 30_000)

	it("downloads the sheet on show as CSV UTF-8, named after the file and the sheet", async () => {
		hooks.bytes = await budget()

		render(
			<SheetViewer
				item={file("b.xlsx")}
				documentKey="k2"
				alt="b.xlsx"
				editable
				saveRef={{ current: null }}
			/>
		)

		await screen.findByRole("textbox", { name: preview.previewSpreadsheetCellContents })
		await openFileMenu()
		fireEvent.click(await screen.findByRole("menuitem", { name: preview.previewSheetDownloadAs }))
		expect(await screen.findByRole("menuitem", { name: preview.previewSheetDownloadPdf })).toBeTruthy()
		fireEvent.click(await screen.findByRole("menuitem", { name: preview.previewSheetDownloadSheetCsvFormat }))

		await waitFor(() => {
			expect(hooks.downloads).toHaveLength(1)
		})

		const download = hooks.downloads[0]
		const bytes = new Uint8Array(await (download?.blob ?? new Blob()).arrayBuffer())

		expect(download?.name).toBe("b - Budget.csv")
		expect(download?.blob.type).toBe("text/csv;charset=utf-8")
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
		expect(new TextDecoder().decode(bytes.slice(3))).toBe("Item,Cost\r\nRent,1200\r\n")
		// No .xlsx offers Save as .xlsx.
		expect(screen.queryByRole("menuitem", { name: preview.previewSpreadsheetSaveAsXlsx })).toBeNull()
	})

	it("prints the sheet on show with Mod+P and the file menu's Print… when the file may be downloaded", async () => {
		hooks.bytes = await budget()

		render(
			<SheetViewer
				item={file("b.xlsx")}
				documentKey="k-print"
				alt="b.xlsx"
				editable
				saveRef={{ current: null }}
			/>
		)

		await screen.findByRole("textbox", { name: preview.previewSpreadsheetCellContents })
		await openFileMenu()
		await screen.findByRole("menuitem", { name: preview.previewSheetPrintMenu })
		fireEvent.keyDown(screen.getByRole("grid"), { key: "p", code: "KeyP", ctrlKey: true })
		await screen.findByRole("dialog", { name: preview.previewSheetPrint })
	})

	it("offers no download, export or print of a file that may not be downloaded", async () => {
		hooks.bytes = await budget()

		render(
			<PreviewDownloadableProvider downloadable={false}>
				<SheetViewer
					item={file("b.xlsx")}
					documentKey="k-nodownload"
					alt="b.xlsx"
					editable
					saveRef={{ current: null }}
				/>
			</PreviewDownloadableProvider>
		)

		await screen.findByRole("textbox", { name: preview.previewSpreadsheetCellContents })
		// Nothing left to offer: no file menu at all (no Download as, PDF, CSV or Print…).
		expect(screen.queryByRole("button", { name: preview.previewSheetFileMenu })).toBeNull()

		const grid = screen.getByRole("grid")
		const shortcut = new KeyboardEvent("keydown", { key: "p", code: "KeyP", ctrlKey: true, bubbles: true, cancelable: true })

		await act(async () => {
			grid.dispatchEvent(shortcut)
			await new Promise(resolve => setTimeout(resolve, 50))
		})
		// Mod+P is taken (the browser's print of the page stays shut) and opens no print dialog.
		expect(shortcut.defaultPrevented).toBe(true)
		expect(screen.queryByRole("dialog", { name: preview.previewSheetPrint })).toBeNull()
	})

	// The preview's Save owns Mod+S wherever it is bound: rebound elsewhere, the grid still keeps Save Page As away.
	it("keeps the browser's Save Page As away on Mod+S in the grid, with no save bound to it", async () => {
		hooks.bytes = await budget()

		render(
			<SheetViewer
				item={file("b.xlsx")}
				documentKey="k-save-key"
				alt="b.xlsx"
				editable
				saveRef={{ current: null }}
			/>
		)

		await screen.findByRole("textbox", { name: preview.previewSpreadsheetCellContents })

		const shortcut = new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true })

		act(() => {
			screen.getByRole("grid").dispatchEvent(shortcut)
		})
		expect(shortcut.defaultPrevented).toBe(true)
	})

	it("keeps a password-protected workbook's cells sealed: no CSV is offered", async () => {
		hooks.bytes = await encryptedWorkbook("default")

		render(
			<SheetViewer
				item={file("locked.xlsx")}
				documentKey="k3"
				alt="locked.xlsx"
				editable
				saveRef={{ current: null }}
				onAutosave={() => false}
			/>
		)

		await screen.findByRole("button", { name: preview.previewDocxPasswordProtected }, { timeout: 20_000 })
		await openFileMenu()
		await screen.findByRole("menuitemcheckbox", { name: preview.previewSheetAutosave })
		expect(screen.queryByRole("menuitem", { name: preview.previewSheetDownloadSheetCsvFormat })).toBeNull()
		expect(WORKBOOK_PASSWORD).not.toBe("")
	}, 30_000)

	it("autosaves through the overlay a pause after an edit, and the menu changes the synced setting", async () => {
		hooks.bytes = await budget()

		const onAutosave = vi.fn(() => true)

		render(
			<SheetViewer
				item={file("b.xlsx")}
				documentKey="k4"
				alt="b.xlsx"
				editable
				saveRef={{ current: null }}
				onAutosave={onAutosave}
			/>
		)

		await screen.findByRole("textbox", { name: preview.previewSpreadsheetCellContents })
		await enter("B2", "1300")
		await waitFor(() => {
			expect(onAutosave).toHaveBeenCalledTimes(1)
		})

		await openFileMenu()

		const choice = await screen.findByRole("menuitemcheckbox", { name: preview.previewSheetAutosave })

		expect(choice.getAttribute("aria-checked")).toBe("true")
		fireEvent.click(choice)
		expect(hooks.autosaveChoices).toEqual([false])
	})
})
