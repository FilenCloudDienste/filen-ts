// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { writeXlsx } from "hucre/xlsx"
import { inThreadSheetHost } from "@filen/office/dom/sheet"
import type { DriveItem } from "@/features/drive/lib/item"
import { registerAllActions } from "@/lib/keymap/actions"
import { preview } from "@/locales/en/preview"

// Typing a formula in the viewer over a real session on this thread: function names offered as a word is typed (Tab
// takes one), the syntax of the call the caret is in, AutoSum, and entries read in the browser's locale.

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

const NUMBERS = [["Amount"], [1], [2]]

type BookCell = string | number | { readonly formula: string; readonly formulaResult: number; readonly formulaType?: "array" }

async function book(sheets: readonly { readonly name: string; readonly rows: readonly (readonly BookCell[])[] }[]): Promise<Uint8Array> {
	return await writeXlsx({ sheets: sheets.map(sheet => ({ name: sheet.name, rows: sheet.rows.map(row => [...row]) })) })
}

async function openViewer(
	sheets: readonly { readonly name: string; readonly rows: readonly (readonly BookCell[])[] }[] = [{ name: "Data", rows: NUMBERS }]
): Promise<HTMLElement> {
	bytes.current = await book(sheets)

	render(
		<SheetViewer
			item={file("fruit.xlsx")}
			documentKey="formula"
			alt="fruit.xlsx"
			editable
			saveRef={{ current: null }}
		/>
	)

	return await screen.findByRole("grid")
}

function bar(): HTMLInputElement {
	return screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSpreadsheetCellContents })
}

// Starts an entry in the formula bar and types `text` into it, the caret at its end.
async function typeInBar(text: string): Promise<HTMLInputElement> {
	const input = bar()

	await act(async () => {
		input.focus()
		await Promise.resolve()
	})
	fireEvent.input(input, { target: { value: text } })

	return input
}

async function goTo(reference: string): Promise<void> {
	const box = screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSheetNameBox })

	fireEvent.focus(box)
	fireEvent.change(box, { target: { value: reference } })
	fireEvent.keyDown(box, { key: "Enter" })
	await waitFor(() => {
		expect(box.value).toBe(reference)
	})
}

describe("typing a formula", () => {
	it("offers the functions a word could become, and Tab takes the one chosen", async () => {
		await openViewer()
		await goTo("B2")

		const input = await typeInBar("=sumi")
		const list = await screen.findByRole("listbox", { name: preview.previewSheetFormulaSuggestions })

		expect(
			within(list)
				.getAllByRole("option")
				.map(option => option.textContent)
		).toEqual(["SUMIF", "SUMIFS"])
		expect(within(list).getByRole("option", { selected: true }).textContent).toBe("SUMIF")

		fireEvent.keyDown(input, { key: "ArrowDown" })
		await waitFor(() => {
			expect(within(list).getByRole("option", { selected: true }).textContent).toBe("SUMIFS")
		})

		fireEvent.keyDown(input, { key: "Tab" })
		await waitFor(() => {
			expect(bar().value).toBe("=SUMIFS(")
		})
		expect(screen.queryByRole("listbox", { name: preview.previewSheetFormulaSuggestions })).toBeNull()
	})

	it("shows the syntax of the call the caret is in", async () => {
		await openViewer()
		await goTo("B2")
		await typeInBar("=ROUND(A2,")

		const hint = await screen.findByRole("status", { name: preview.previewSheetFormulaSignature })

		expect(hint.textContent).toBe("ROUND(number, digits)")
		expect(within(hint).getByText("digits").className).toContain("font-semibold")
	})

	it("closes the list with Escape and keeps the entry open", async () => {
		await openViewer()
		await goTo("B2")

		const input = await typeInBar("=co")

		await screen.findByRole("listbox", { name: preview.previewSheetFormulaSuggestions })
		fireEvent.keyDown(input, { key: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("listbox", { name: preview.previewSheetFormulaSuggestions })).toBeNull()
		})
		expect(bar().value).toBe("=co")
	})
})

describe("AutoSum", () => {
	it("opens the sum of the numbers above the active cell to finish", async () => {
		await openViewer()
		await goTo("A4")
		// The formula bar's (the ribbon's Home tab has one too).
		const autoSum = screen
			.getAllByRole("button", { name: preview.previewSheetAutoSum })
			.find(button => button.closest("[data-office-ribbon]") === null)

		if (autoSum === undefined) throw new Error("no AutoSum in the formula bar")

		fireEvent.click(autoSum)
		await waitFor(() => {
			expect(bar().value).toBe("=SUM(A2:A3)")
		})
	})
})

describe("entries in the browser's locale", () => {
	it("reads a formula typed with ; and a decimal comma, and shows it back as typed", async () => {
		vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE"])

		await openViewer()
		await goTo("B2")

		const input = await typeInBar("=ROUND(A2*1,25;1)")

		fireEvent.keyDown(input, { key: "Enter" })
		await goTo("C2")
		await goTo("B2")
		await waitFor(
			() => {
				expect(bar().value).toBe("=ROUND(A2*1,25;1)")
			},
			{ timeout: 5000 }
		)
		// Opening the viewer and the three moves wait up to a second each, the entry's round trip up to five.
	}, 15_000)
})

describe("a result the app does not calculate", () => {
	it("marks the cell as showing the result saved in the file", async () => {
		await openViewer([{ name: "Data", rows: [["Amount"], [1], [{ formula: "A2*7", formulaResult: 7, formulaType: "array" }]] }])
		await goTo("A2")
		expect(screen.queryByRole("img", { name: preview.previewSheetCachedResult })).toBeNull()
		await goTo("A3")
		await screen.findByRole("img", { name: preview.previewSheetCachedResult })
	})
})
