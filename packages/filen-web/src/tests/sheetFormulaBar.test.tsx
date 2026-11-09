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

type BookCell =
	| string
	| number
	| { readonly formula: string; readonly formulaResult: number; readonly formulaType?: "array"; readonly formulaRef?: string }

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

function bar(): HTMLTextAreaElement {
	return screen.getByRole<HTMLTextAreaElement>("textbox", { name: preview.previewSpreadsheetCellContents })
}

// Starts an entry in the formula bar and types `text` into it, the caret at its end.
async function typeInBar(text: string): Promise<HTMLTextAreaElement> {
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
	// The box shows the active cell: a range's top left.
	await waitFor(() => {
		expect(box.value).toBe(reference.split(":")[0])
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
		// Enter moves down once the session has kept the entry; going back before that move lands would be undone by it.
		await waitFor(
			() => {
				expect(screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSheetNameBox }).value).toBe("B3")
			},
			{ timeout: 5000 }
		)
		await goTo("B2")
		await waitFor(() => {
			expect(bar().value).toBe("=ROUND(A2*1,25;1)")
		})
		// Opening the viewer and the moves wait up to a second each, the entry's round trip up to five.
	}, 15_000)
})

describe("a result the app does not calculate", () => {
	// A legacy array formula over several cells keeps the result saved in the file; one over a single cell is
	// recalculated, as Excel gives its first value.
	it("marks the cell as showing the result saved in the file", async () => {
		await openViewer([
			{
				name: "Data",
				rows: [
					["Amount", "Single"],
					[1, { formula: "A2*7", formulaResult: 7, formulaType: "array", formulaRef: "B2" }],
					[{ formula: "A2:A2*7", formulaResult: 7, formulaType: "array", formulaRef: "A3:A4" }],
					[7]
				]
			}
		])
		await goTo("A2")
		expect(screen.queryByRole("img", { name: preview.previewSheetCachedResult })).toBeNull()
		await goTo("B2")
		expect(screen.queryByRole("img", { name: preview.previewSheetCachedResult })).toBeNull()
		await goTo("A3")
		await screen.findByRole("img", { name: preview.previewSheetCachedResult })
	})
})

async function openBook(sheet: Parameters<typeof writeXlsx>[0]["sheets"][number]): Promise<void> {
	bytes.current = await writeXlsx({ sheets: [sheet] })

	render(
		<SheetViewer
			item={file("lines.xlsx")}
			documentKey="formula"
			alt="lines.xlsx"
			editable
			saveRef={{ current: null }}
		/>
	)

	await screen.findByRole("grid")
}

function nameBox(): HTMLInputElement {
	return screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSheetNameBox })
}

describe("the name box", () => {
	function enter(text: string): void {
		const box = nameBox()

		fireEvent.focus(box)
		fireEvent.change(box, { target: { value: text } })
		fireEvent.keyDown(box, { key: "Enter" })
	}

	it("shows the active cell of a range, and selects whole columns", async () => {
		await openBook({ name: "Data", rows: [["one", "two"]] })
		await goTo("B1:C3")
		expect(nameBox().value).toBe("B1")
		enter("$B:$B")
		await waitFor(() => {
			expect(bar().value).toBe("two")
		})
	})

	it("goes to another sheet's cell and to a defined name", async () => {
		bytes.current = await writeXlsx({
			sheets: [
				{ name: "Data", rows: [["here"]] },
				{ name: "Other sheet", rows: [["a"], ["b", "far"]] }
			],
			namedRanges: [{ name: "Far", range: "'Other sheet'!$B$2" }]
		})
		render(
			<SheetViewer
				item={file("names.xlsx")}
				documentKey="names"
				alt="names.xlsx"
				editable
				saveRef={{ current: null }}
			/>
		)
		await screen.findByRole("grid")
		enter("'other SHEET'!A2")
		await waitFor(() => {
			expect(bar().value).toBe("b")
		})
		enter("Data!A1")
		await waitFor(() => {
			expect(bar().value).toBe("here")
		})
		enter("far")
		await waitFor(() => {
			expect(nameBox().value).toBe("B2")
			expect(bar().value).toBe("far")
		})
	})

	it("refuses a range on a protected sheet whose cells may not be selected", async () => {
		bytes.current = await writeXlsx({
			sheets: [{ name: "Locked", rows: [["a"]], protection: { sheet: true, selectLockedCells: false, selectUnlockedCells: true } }]
		})
		render(
			<SheetViewer
				item={file("locked.xlsx")}
				documentKey="locked"
				alt="locked.xlsx"
				editable
				saveRef={{ current: null }}
			/>
		)
		await screen.findByRole("grid")

		enter("C3:D4")
		await act(async () => {
			await Promise.resolve()
		})
		expect(nameBox().value).toBe("A1")
	})
})

describe("line breaks in the formula bar", () => {
	it("shows a cell's line break and keeps it through an edit there", async () => {
		await openBook({ name: "Data", rows: [["a\nb"], ["below"]] })
		await goTo("A1")
		await waitFor(() => {
			expect(bar().value).toBe("a\nb")
		})

		const input = await typeInBar("a\nbX")

		fireEvent.keyDown(input, { key: "Enter" })
		await waitFor(
			() => {
				expect(bar().value).toBe("below")
			},
			{ timeout: 5000 }
		)
		await goTo("A1")
		await waitFor(() => {
			expect(bar().value).toBe("a\nbX")
		})
	}, 15_000)

	it("breaks the line at the caret on Alt+Enter, and a plain Enter does not", async () => {
		await openBook({ name: "Data", rows: [["x"]] })
		await goTo("B2")

		const input = await typeInBar("ab")

		input.setSelectionRange(1, 1)
		fireEvent.keyDown(input, { key: "Enter", altKey: true })
		await waitFor(() => {
			expect(bar().value).toBe("a\nb")
		})
		expect(input.selectionStart).toBe(2)
	})
})

describe("keys in the formula bar are the in-cell editor's", () => {
	it("steps Enter past a hidden row", async () => {
		await openBook({
			name: "Data",
			rows: [["one"], ["hidden"], ["three"]],
			rowDefs: new Map([[1, { hidden: true }]])
		})
		await goTo("A1")
		await waitFor(() => {
			expect(bar().value).toBe("one")
		})

		fireEvent.keyDown(await typeInBar("one"), { key: "Enter" })
		await waitFor(
			() => {
				expect(nameBox().value).toBe("A3")
			},
			{ timeout: 5000 }
		)
		expect(bar().value).toBe("three")
	}, 15_000)

	it("cycles Enter within a selection, keeping the selection", async () => {
		await openBook({
			name: "Data",
			rows: [
				["one", "x"],
				["two", "y"]
			]
		})
		await goTo("A1:B2")
		await waitFor(() => {
			expect(bar().value).toBe("one")
		})

		fireEvent.keyDown(await typeInBar("one"), { key: "Enter" })
		await waitFor(
			() => {
				expect(bar().value).toBe("two")
			},
			{ timeout: 5000 }
		)
		// The name box shows the active cell, as Excel's does; the selection kept, the next Enter steps to B1.
		expect(nameBox().value).toBe("A2")
		fireEvent.keyDown(screen.getByRole("grid"), { key: "Enter" })
		await waitFor(() => {
			expect(nameBox().value).toBe("B1")
		})
	}, 15_000)

	it("fills the selection with the entry on Ctrl+Enter", async () => {
		await openBook({ name: "Data", rows: [["x"]] })
		await goTo("B1:B3")

		fireEvent.keyDown(await typeInBar("7"), { key: "Enter", ctrlKey: true })
		await waitFor(
			() => {
				expect(bar().value).toBe("7")
				expect(document.activeElement).not.toBe(bar())
			},
			{ timeout: 5000 }
		)
		await goTo("B3")
		await waitFor(() => {
			expect(bar().value).toBe("7")
		})
	}, 15_000)
})
