// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { SheetCommand } from "@filen/office/core/sheet"
import { DEFAULT_PAGE_SETUP, paginate, paperPoints } from "@filen/office/core/sheet/print"
import "@/lib/i18n"
import { preview } from "@/locales/en/preview"
import { SheetPrintDialog } from "@/features/spreadsheet/print/printDialog"
import { sheetSettings } from "@/features/spreadsheet/print/printSettings"
import { applyForm, formOf, patchOf, percentOf, printRequests, type PrintSheetSettings } from "@/features/spreadsheet/print/print.logic"
import { printPages, svgElement } from "@/features/spreadsheet/print/printRoot"
import { GridHarness } from "@/tests/sheetMenusHarness"
import { openGrid, workbook } from "@/tests/sheetMenusFixtures"

// The print dialog: the pages as they print, the choices saved into the active sheet's page setup, and the browser's
// print of a root holding the pages.

// A page past what a print draws (MAX_PAGE_CELLS) needs millions of cells; the drawing refuses it here instead.
const refusing = vi.hoisted(() => ({ on: false }))

vi.mock("@filen/office/react/sheet/print", async original => {
	const actual = await original<typeof import("@filen/office/react/sheet/print")>()

	return {
		...actual,
		renderPrintPage: (...args: Parameters<typeof actual.renderPrintPage>) =>
			refusing.on ? Promise.reject(new actual.PrintPageTooLarge(args[1] + 1)) : actual.renderPrintPage(...args)
	}
})

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
	refusing.on = false
})

// The browser's print, which happy-dom lacks: `during` sees the document as the printer would, then the dialog closes.
function stubPrint(during: () => void): ReturnType<typeof vi.fn> {
	const print = vi.fn(() => {
		during()
		window.dispatchEvent(new Event("afterprint"))
	})

	Object.defineProperty(window, "print", { value: print, configurable: true, writable: true })

	return print
}

const SHEET = { id: 0, name: "Data", state: "visible", kind: "worksheet", ready: true } as const
const OTHER = { id: 1, name: "Hidden", state: "hidden", kind: "worksheet", ready: true } as const

function settings(sheet: PrintSheetSettings["sheet"], patch: Partial<PrintSheetSettings["setup"]> = {}): PrintSheetSettings {
	return { sheet, setup: { ...DEFAULT_PAGE_SETUP, ...patch }, used: { startRow: 0, startCol: 0, endRow: 9, endCol: 2 } }
}

describe("the print dialog's choices", () => {
	it("reads the file's scaling as a choice", () => {
		expect(formOf({ ...DEFAULT_PAGE_SETUP, fitToPage: true, fitToWidth: 1, fitToHeight: 0 }).scaling).toBe("fitColumns")
		expect(formOf({ ...DEFAULT_PAGE_SETUP, fitToPage: true, fitToWidth: 2, fitToHeight: 3 }).scaling).toBe("fitPages")
		expect(formOf({ ...DEFAULT_PAGE_SETUP, scale: 80 }).scaling).toBe("custom")
		expect(formOf({ ...DEFAULT_PAGE_SETUP, customPaper: true }).paperSize).toBe(0)
	})

	it("writes only what changed", () => {
		const form = formOf(DEFAULT_PAGE_SETUP)

		expect(patchOf(DEFAULT_PAGE_SETUP, form)).toBeNull()
		expect(patchOf(DEFAULT_PAGE_SETUP, { ...form, orientation: "landscape", scaling: "fitSheet", gridLines: true })).toEqual({
			orientation: "landscape",
			fit: { width: 1, height: 1 },
			gridLines: true
		})
		expect(patchOf({ ...DEFAULT_PAGE_SETUP, fitToPage: true }, { ...form, scaling: "custom", percent: "85" })).toEqual({ scale: 85 })
		expect(patchOf(DEFAULT_PAGE_SETUP, { ...form, scaling: "custom", percent: "5" })).toBeNull()
		expect(percentOf("400")).toBe(400)
		expect(percentOf("12.5")).toBeNull()
	})

	it("keeps the file's page counts for fit-to-pages and its custom paper unless another is chosen", () => {
		const setup = { ...DEFAULT_PAGE_SETUP, fitToPage: true, fitToWidth: 2, fitToHeight: 3, customPaper: true }
		const next = applyForm(setup, formOf(setup))

		expect(next).toMatchObject({ fitToPage: true, fitToWidth: 2, fitToHeight: 3, customPaper: true })
		expect(applyForm(setup, { ...formOf(setup), paperSize: 9 })).toMatchObject({ paperSize: 9, customPaper: false })
	})

	it("cuts the pages from the paper the dialog chose", () => {
		const chosen = applyForm(DEFAULT_PAGE_SETUP, { ...formOf(DEFAULT_PAGE_SETUP), paperSize: 9 })
		const custom = applyForm(
			{ ...DEFAULT_PAGE_SETUP, customPaper: true, paper: { width: 100, height: 200 } },
			{ ...formOf(DEFAULT_PAGE_SETUP), paperSize: 9 }
		)
		const rows = { count: 2000, size: () => 15 }
		const cols = { count: 1, size: () => 48 }
		const range = [{ startRow: 0, startCol: 0, endRow: 1999, endCol: 0 }]
		const letter = paginate({ setup: DEFAULT_PAGE_SETUP, ranges: range, rows, cols })
		const a4 = paginate({ setup: chosen ?? DEFAULT_PAGE_SETUP, ranges: range, rows, cols })

		expect(a4.paper).toEqual(paperPoints(9))
		expect(custom?.paper).toEqual(paperPoints(9))
		expect(a4.pages.length).not.toBe(letter.pages.length)
	})

	it("prints the print area unless ignored, the selection, or every visible sheet with its own settings", () => {
		const area = [{ startRow: 2, startCol: 0, endRow: 4, endCol: 1 }]
		const active = settings(SHEET, { printArea: area })
		const form = { ...formOf(active.setup), orientation: "landscape" as const }
		const selection = [{ startRow: 5, startCol: 5, endRow: 6, endCol: 6 }]

		expect(printRequests(form, active, [active], selection)?.[0]?.ranges).toEqual(area)
		expect(printRequests({ ...form, ignorePrintArea: true }, active, [active], selection)?.[0]?.ranges).toEqual([active.used])
		expect(printRequests({ ...form, scope: "selection" }, active, [active], selection)?.[0]).toMatchObject({
			ranges: selection,
			setup: { printArea: null, orientation: "landscape" }
		})

		const workbookPrint = printRequests(
			{ ...form, scope: "workbook" },
			active,
			[active, settings(OTHER), settings({ ...SHEET, id: 2, name: "B" })],
			[]
		)

		expect(workbookPrint?.map(request => [request.name, request.setup.orientation])).toEqual([
			["Data", "landscape"],
			["B", "portrait"]
		])
	})

	it("starts the browser's print once the pages' pictures are decoded", async () => {
		let decoded: () => void = () => undefined
		const decode = vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(
			() =>
				new Promise<void>(resolve => {
					decoded = resolve
				})
		)
		const print = stubPrint(() => undefined)
		const done = printPages([
			{
				svg: '<svg xmlns="http://www.w3.org/2000/svg"><image href="blob:logo" width="10" height="10"/><image href="blob:logo"/></svg>',
				width: 612,
				height: 792
			}
		])

		await new Promise(resolve => setTimeout(resolve, 0))
		// One decode per picture, however many places show it.
		expect(decode).toHaveBeenCalledTimes(1)
		expect(print).not.toHaveBeenCalled()
		decoded()
		await done
		expect(print).toHaveBeenCalledTimes(1)
		expect(document.querySelector(".fo-print-root")).toBeNull()
	})

	it("reads only well-formed SVG pages into the document", () => {
		expect(svgElement('<svg xmlns="http://www.w3.org/2000/svg"><text>1</text></svg>')?.localName).toBe("svg")
		expect(svgElement("<svg><text>unclosed</svg>")).toBeNull()
		expect(svgElement('<div xmlns="http://www.w3.org/1999/xhtml"/>')).toBeNull()
	})
})

describe("the print dialog", () => {
	it("previews the pages, saves the choices into the sheet and prints the pages from a root of their own", async () => {
		const rows = Array.from({ length: 120 }, (_, k) => [`row ${String(k + 1)}`, k])
		const model = await openGrid(await workbook([{ name: "Data", rows }]), "xlsx")
		const run = vi.fn((command: SheetCommand) => {
			void model.command(command)
		})
		const active = await sheetSettings(model, "xlsx", model.getSnapshot().sheets[0] ?? SHEET)
		const onClose = vi.fn()
		let printed: string[] = []
		const print = stubPrint(() => {
			printed = [...document.querySelectorAll(".fo-print-root .fo-print-page svg")].map(svg => svg.textContent)
		})

		if (active === null) throw new Error("no settings")

		render(
			<GridHarness model={model}>
				{grid => (
					<SheetPrintDialog
						active={active}
						grid={grid}
						model={model}
						kind="xlsx"
						name="book.xlsx"
						canSave
						run={run}
						onClose={onClose}
					/>
				)}
			</GridHarness>
		)

		await screen.findByText("Page 1 of 3")

		const preview1 = screen.getByRole("img", { name: preview.previewSheetPrintPreview })

		await waitFor(() => {
			expect(preview1.querySelector("svg")?.textContent).toContain("row 1")
		})

		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetPrintNextPage }))
		await screen.findByText("Page 2 of 3")
		fireEvent.click(screen.getByRole("radio", { name: preview.previewSheetPrintLandscape }))
		fireEvent.click(screen.getByRole("switch", { name: preview.previewSheetPrintGridlines }))
		await screen.findByText("Page 1 of 4")
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetPrintButton }))

		await waitFor(() => {
			expect(print).toHaveBeenCalledTimes(1)
		})

		expect(run).toHaveBeenCalledWith({ type: "print.setup", sheet: 0, patch: { orientation: "landscape", gridLines: true } })
		expect(printed).toHaveLength(4)
		expect(printed[3]).toContain("row 120")
		expect(document.querySelector(".fo-print-root")).toBeNull()
		expect(onClose).toHaveBeenCalled()

		await waitFor(async () => {
			expect((await model.session.query("print.settings", { sheet: 0 }))?.setup).toMatchObject({
				orientation: "landscape",
				gridLines: true
			})
		})
	})

	it("prints a text file with the defaults and saves nothing into it", async () => {
		const model = await openGrid(new TextEncoder().encode("a,b\n1,2\n"), "csv")
		const run = vi.fn()
		const active = await sheetSettings(model, "csv", model.getSnapshot().sheets[0] ?? SHEET)

		const print = stubPrint(() => undefined)

		if (active === null) throw new Error("no settings")

		render(
			<GridHarness model={model}>
				{grid => (
					<SheetPrintDialog
						active={active}
						grid={grid}
						model={model}
						kind="csv"
						name="data.csv"
						canSave
						run={run}
						onClose={() => undefined}
					/>
				)}
			</GridHarness>
		)

		await screen.findByText("Page 1 of 1")
		expect(screen.getByText(preview.previewSheetPrintNotSaved)).toBeTruthy()
		fireEvent.click(screen.getByRole("radio", { name: preview.previewSheetPrintLandscape }))
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetPrintButton }))

		await waitFor(() => {
			expect(print).toHaveBeenCalled()
		})

		expect(run).not.toHaveBeenCalled()
	})

	it("says when a page holds too many cells to draw, and prints nothing", async () => {
		const rows = Array.from({ length: 20 }, (_, row) => Array.from({ length: 4 }, (_, col) => row + col))
		const model = await openGrid(await workbook([{ name: "Data", rows }]), "xlsx")
		const read = await sheetSettings(model, "xlsx", model.getSnapshot().sheets[0] ?? SHEET)

		if (read === null) throw new Error("no settings")

		refusing.on = true

		const active = read
		const error = vi.spyOn(toast, "error")
		const print = stubPrint(() => undefined)

		render(
			<GridHarness model={model}>
				{grid => (
					<SheetPrintDialog
						active={active}
						grid={grid}
						model={model}
						kind="xlsx"
						name="big.xlsx"
						canSave={false}
						run={() => undefined}
						onClose={() => undefined}
					/>
				)}
			</GridHarness>
		)

		const message = preview.previewSheetPrintPageTooLarge.replace("{{page}}", "1")

		await screen.findByText(message, undefined, { timeout: 10_000 })
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetPrintButton }))

		await waitFor(() => {
			expect(error).toHaveBeenCalledWith(message)
		})
		expect(print).not.toHaveBeenCalled()
	}, 30_000)
})
