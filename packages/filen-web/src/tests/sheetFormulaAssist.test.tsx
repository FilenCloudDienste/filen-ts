// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { writeXlsx } from "hucre/xlsx"
import { inThreadSheetHost } from "@filen/office/dom/sheet"
import type { DriveItem } from "@/features/drive/lib/item"
import { registerAllActions } from "@/lib/keymap/actions"
import { preview } from "@/locales/en/preview"

// The function suggestions and the call's syntax under the editor a formula is typed in: tied to that editor for a
// screen reader, and shown above it where they would cover what is below the grid.

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

async function book(
	sheets: readonly { readonly name: string; readonly rows: readonly (readonly (string | number)[])[] }[]
): Promise<Uint8Array> {
	return await writeXlsx({ sheets: sheets.map(sheet => ({ name: sheet.name, rows: sheet.rows.map(row => [...row]) })) })
}

async function openViewer(
	sheets: readonly { readonly name: string; readonly rows: readonly (readonly (string | number)[])[] }[] = [
		{ name: "Data", rows: NUMBERS }
	]
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

function rect(top: number, bottom: number, left = 0): DOMRect {
	return { top, bottom, left, right: left + 100, width: 100, height: bottom - top, x: left, y: top, toJSON: () => ({}) }
}

describe("function suggestions", () => {
	it("tie the editor typed in to the list, its choice announced, and let go of it when the list closes", async () => {
		await openViewer()
		await goTo("B2")

		const input = await typeInBar("=sumi")
		const list = await screen.findByRole("listbox", { name: preview.previewSheetFormulaSuggestions })
		const chosen = (): string | null => within(list).getByRole("option", { selected: true }).id

		expect(list.id).not.toBe("")
		expect(input.getAttribute("aria-controls")).toBe(list.id)
		expect(input.getAttribute("aria-autocomplete")).toBe("list")
		expect(input.getAttribute("aria-activedescendant")).toBe(chosen())

		fireEvent.keyDown(input, { key: "ArrowDown" })
		await waitFor(() => {
			expect(within(list).getByRole("option", { selected: true }).textContent).toBe("SUMIFS")
		})
		expect(input.getAttribute("aria-activedescendant")).toBe(chosen())

		fireEvent.keyDown(input, { key: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("listbox", { name: preview.previewSheetFormulaSuggestions })).toBeNull()
		})
		expect([input.getAttribute("aria-controls"), input.getAttribute("aria-activedescendant")]).toEqual([null, null])
	})

	it("take the one suggestion left with Tab after the list narrowed, and open the next word's list on its first row", async () => {
		await openViewer()
		await goTo("B2")

		const input = await typeInBar("=sum")
		// The list is drawn again as the entry changes: each check reads the one shown.
		const options = (): HTMLElement[] =>
			within(screen.getByRole("listbox", { name: preview.previewSheetFormulaSuggestions })).getAllByRole("option")

		await screen.findByRole("listbox", { name: preview.previewSheetFormulaSuggestions })
		for (let step = 0; step < 3; step++) fireEvent.keyDown(input, { key: "ArrowDown" })
		await waitFor(() => {
			expect(options().findIndex(option => option.getAttribute("aria-selected") === "true")).toBe(3)
		})

		fireEvent.input(input, { target: { value: "=sumifs" } })
		await waitFor(() => {
			expect(options().map(option => option.textContent)).toEqual(["SUMIFS"])
		})
		fireEvent.keyDown(input, { key: "Tab" })
		await waitFor(() => {
			expect(input.value).toBe("=SUMIFS(")
		})

		fireEvent.input(input, { target: { value: "=SUMIFS(s" } })

		await waitFor(() => {
			expect(options().length).toBeGreaterThan(3)
		})
		expect(options()[0]?.getAttribute("aria-selected")).toBe("true")
	})

	it("show the call's syntax above the cell's editor where below it would cover the sheet tabs", async () => {
		const grid = await openViewer()

		await act(async () => {
			grid.focus()
			await Promise.resolve()
		})
		fireEvent.keyDown(grid, { key: "=" })

		const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: preview.previewSheetCellEditor })
		const sheet = editor.closest(".fo-sheet")

		if (!(sheet instanceof HTMLElement)) throw new Error("the cell's editor is outside the grid")

		vi.spyOn(sheet, "getBoundingClientRect").mockReturnValue(rect(0, 400))
		vi.spyOn(editor, "getBoundingClientRect").mockReturnValue(rect(370, 390, 40))
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(30)

		fireEvent.change(editor, { target: { value: "=ROUND(" } })
		editor.setSelectionRange(7, 7)
		fireEvent.input(editor)

		const hint = await screen.findByRole("status", { name: preview.previewSheetFormulaSignature })

		await waitFor(() => {
			expect(hint.parentElement?.style.transform).toBe("translate(40px, 338px)")
		})
	})
})
