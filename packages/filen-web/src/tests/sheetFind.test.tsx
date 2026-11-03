// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { writeXlsx } from "hucre/xlsx"
import { inThreadSheetHost } from "@filen/office/dom/sheet"
import type { DriveItem } from "@/features/drive/lib/item"
import { matchNear, walkOrder } from "@/features/spreadsheet/find/sheetFind.logic"
import { registerAllActions } from "@/lib/keymap/actions"
import { preview } from "@/locales/en/preview"

// The find bar over a real session on this thread: Mod+F opens it, typing finds and selects the first match after the
// active cell, Enter steps through the matches, and Mod+H replaces (one match, or all of them as one undo step).

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

const FRUIT = [
	["Item", "Note"],
	["apple", "red apple"],
	["pear", "green"],
	["Apple pie", "baked"]
]

async function book(sheets: readonly { readonly name: string; readonly rows: readonly (readonly string[])[] }[]): Promise<Uint8Array> {
	return await writeXlsx({ sheets: sheets.map(sheet => ({ name: sheet.name, rows: sheet.rows.map(row => [...row]) })) })
}

function nameBox(): string {
	return screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSheetNameBox }).value
}

async function openViewer(
	sheets: readonly { readonly name: string; readonly rows: readonly (readonly string[])[] }[] = [{ name: "Fruit", rows: FRUIT }],
	// Shown in a preview overlay, as the app shows it.
	overlay = false
): Promise<HTMLElement> {
	bytes.current = await book(sheets)

	const viewer = (
		<SheetViewer
			item={file("fruit.xlsx")}
			documentKey="find"
			alt="fruit.xlsx"
			editable
			saveRef={{ current: null }}
		/>
	)

	render(
		overlay ? (
			<div
				role="dialog"
				data-open=""
				tabIndex={-1}
				aria-label="Overlay"
			>
				{viewer}
			</div>
		) : (
			viewer
		)
	)

	return await screen.findByRole("grid")
}

describe("walkOrder", () => {
	it("puts matches found from a cell on in walk order from the start, saying where the walk came round", () => {
		// Found from One!A3 on: A4, Two!A1, then round to One!A2.
		const found = Uint32Array.of(0, 3, 0, 1, 0, 0, 0, 1, 0)
		const { cells, shift } = walkOrder(found, [0, 1])

		expect([...cells]).toEqual([0, 1, 0, 0, 3, 0, 1, 0, 0])
		expect(shift).toBe(2)
		expect(walkOrder(Uint32Array.of(0, 1, 0, 0, 2, 0), [0]).shift).toBe(0)
		// Sheets in tab order, not by id.
		expect(walkOrder(Uint32Array.of(0, 0, 0, 1, 0, 0), [1, 0]).shift).toBe(1)
		expect(walkOrder(new Uint32Array(0), [0]).cells.length).toBe(0)
	})

	it("finds the match nearest a cell the way a step goes, coming round past either end", () => {
		// One!A2, One!A4, Two!A1.
		const cells = Uint32Array.of(0, 1, 0, 0, 3, 0, 1, 0, 0)

		expect(matchNear(cells, [0, 1], { sheet: 0, row: 1, col: 0 }, 1)).toBe(1)
		expect(matchNear(cells, [0, 1], { sheet: 0, row: 2, col: 0 }, -1)).toBe(0)
		expect(matchNear(cells, [0, 1], { sheet: 1, row: 5, col: 0 }, 1)).toBe(0)
		expect(matchNear(cells, [0, 1], { sheet: 0, row: 0, col: 0 }, -1)).toBe(2)
		expect(matchNear(new Uint32Array(0), [0], { sheet: 0, row: 0, col: 0 }, 1)).toBe(-1)
	})
})

// An entry typed into the active cell through the formula bar.
async function typeInto(text: string): Promise<void> {
	const bar = screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSpreadsheetCellContents })

	await act(async () => {
		bar.focus()
		await Promise.resolve()
	})
	fireEvent.change(bar, { target: { value: text } })
	fireEvent.keyDown(bar, { key: "Enter" })
	await waitFor(() => {
		expect(bar.value).not.toBe(text)
	})
}

async function goTo(reference: string): Promise<void> {
	const box = screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSheetNameBox })

	fireEvent.focus(box)
	fireEvent.change(box, { target: { value: reference } })
	fireEvent.keyDown(box, { key: "Enter" })
	await waitFor(() => {
		expect(nameBox()).toBe(reference)
	})
}

describe("the spreadsheet find bar", () => {
	it("gives the cells focus with Escape on a ribbon control, keeping the key from closing the preview", async () => {
		await openViewer()

		const tab = screen.getAllByRole("tab")[0]

		if (tab === undefined) throw new Error("no tab")

		act(() => {
			tab.focus()
		})
		expect(fireEvent.keyDown(tab, { key: "Escape" })).toBe(false)
		expect(document.activeElement?.closest('[data-sheet-pane="grid"]')).not.toBeNull()
	})

	it("gives the cells focus with Escape on a sheet tab, keeping the key from closing the preview", async () => {
		await openViewer()

		const tab = screen.getByRole("tab", { name: /Fruit/u })

		act(() => {
			tab.focus()
		})
		expect(fireEvent.keyDown(tab, { key: "Escape" })).toBe(false)
		expect(document.activeElement?.closest('[data-sheet-pane="grid"]')).not.toBeNull()
	})

	it("opens with Mod+F, selects the first match and steps with Enter", async () => {
		const grid = await openViewer()

		fireEvent.keyDown(grid, { key: "f", code: "KeyF", ctrlKey: true })

		const field = await screen.findByRole("searchbox", { name: preview.previewDocxFindPlaceholder })

		expect(screen.getByRole("search", { name: preview.previewSheetFindBar })).toBeTruthy()

		fireEvent.change(field, { target: { value: "apple" } })
		await waitFor(() => {
			expect(nameBox()).toBe("A2")
		})

		fireEvent.keyDown(field, { key: "Enter" })
		await waitFor(() => {
			expect(nameBox()).toBe("B2")
		})

		fireEvent.keyDown(field, { key: "Enter" })
		await waitFor(() => {
			expect(nameBox()).toBe("A4")
		})

		fireEvent.keyDown(field, { key: "Enter", shiftKey: true })
		await waitFor(() => {
			expect(nameBox()).toBe("B2")
		})

		fireEvent.keyDown(field, { key: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("search")).toBeNull()
		})
	})

	it("opens with Mod+F with focus on the preview overlay itself (left there after a click in Safari and macOS Firefox)", async () => {
		await openViewer(undefined, true)

		fireEvent.keyDown(screen.getByRole("dialog", { name: "Overlay" }), { key: "f", code: "KeyF", ctrlKey: true })

		expect(await screen.findByRole("searchbox", { name: preview.previewDocxFindPlaceholder })).toBeTruthy()
	})

	it("finds from the active cell past the most one find lists, and steps on past either end of them", async () => {
		const grid = await openViewer([{ name: "Many", rows: Array.from({ length: 1500 }, () => ["x"]) }])

		await goTo("A1400")
		fireEvent.keyDown(grid, { key: "f", code: "KeyF", ctrlKey: true })

		const field = await screen.findByRole("searchbox", { name: preview.previewDocxFindPlaceholder })

		// Excel's Find Next stands on the first match at the active cell or after it.
		fireEvent.change(field, { target: { value: "x" } })
		await waitFor(() => {
			expect(screen.getByText("1/1,000+")).toBeTruthy()
		})
		expect(nameBox()).toBe("A1400")

		fireEvent.keyDown(field, { key: "Enter" })
		await waitFor(() => {
			expect(nameBox()).toBe("A1401")
		})
	})

	it("steps back past the first of the most one find lists to the last match, and on again past the last", async () => {
		const grid = await openViewer([{ name: "Many", rows: Array.from({ length: 1500 }, () => ["x"]) }])

		fireEvent.keyDown(grid, { key: "f", code: "KeyF", ctrlKey: true })

		const again = await screen.findByRole("searchbox", { name: preview.previewDocxFindPlaceholder })

		fireEvent.change(again, { target: { value: "x" } })
		await waitFor(() => {
			expect(screen.getByText("1/1,000+")).toBeTruthy()
		})
		expect(nameBox()).toBe("A1")
		fireEvent.keyDown(again, { key: "Enter", shiftKey: true })
		await waitFor(() => {
			expect(nameBox()).toBe("A1500")
		})

		// On round to A1, the last match listed, and past it to A2.
		fireEvent.keyDown(again, { key: "Enter" })
		await waitFor(() => {
			expect(nameBox()).toBe("A1")
		})
		fireEvent.keyDown(again, { key: "Enter" })
		await waitFor(() => {
			expect(nameBox()).toBe("A2")
		})
	})

	it("steps to the match after the active cell when the match it stood on was edited away", async () => {
		const grid = await openViewer()

		fireEvent.keyDown(grid, { key: "f", code: "KeyF", ctrlKey: true })

		const field = await screen.findByRole("searchbox", { name: preview.previewDocxFindPlaceholder })

		fireEvent.change(field, { target: { value: "apple" } })
		await waitFor(() => {
			expect(nameBox()).toBe("A2")
		})

		// A2 no longer holds "apple": Find Next goes on from A2 to B2, the next match after it.
		await typeInto("plum")
		await waitFor(() => {
			expect(screen.getByText(/\/2$/)).toBeTruthy()
		})
		await goTo("A2")
		act(() => {
			field.focus()
		})
		fireEvent.keyDown(field, { key: "Enter" })
		await waitFor(() => {
			expect(nameBox()).toBe("B2")
		})
	})

	it("steps past the end of the most one find lists from the active cell, whatever it now holds", async () => {
		const grid = await openViewer([{ name: "Many", rows: Array.from({ length: 1500 }, () => ["x"]) }])

		fireEvent.keyDown(grid, { key: "f", code: "KeyF", ctrlKey: true })

		const field = await screen.findByRole("searchbox", { name: preview.previewDocxFindPlaceholder })

		fireEvent.change(field, { target: { value: "x" } })
		await waitFor(() => {
			expect(screen.getByText("1/1,000+")).toBeTruthy()
		})
		fireEvent.keyDown(field, { key: "Enter", shiftKey: true })
		await waitFor(() => {
			expect(nameBox()).toBe("A1500")
		})

		// The last match listed, edited away: on round to A1, not A2.
		await typeInto("y")
		await goTo("A1500")
		act(() => {
			field.focus()
		})
		fireEvent.keyDown(field, { key: "Enter" })
		await waitFor(() => {
			expect(nameBox()).toBe("A1")
		})
	})

	it("numbers the matches from the start of the sheet when it stands on one past the first", async () => {
		const grid = await openViewer()

		await goTo("A3")
		fireEvent.keyDown(grid, { key: "f", code: "KeyF", ctrlKey: true })

		const field = await screen.findByRole("searchbox", { name: preview.previewDocxFindPlaceholder })

		fireEvent.change(field, { target: { value: "apple" } })
		await waitFor(() => {
			expect(nameBox()).toBe("A4")
		})
		expect(screen.getByText("3/3")).toBeTruthy()
	})

	it("searches another sheet whole, not within the selection searched on the sheet before", async () => {
		const grid = await openViewer([
			{ name: "Fruit", rows: FRUIT },
			{ name: "More", rows: [["apple"], ["x"], ["x"], ["apple"]] }
		])

		await goTo("A1:A3")
		fireEvent.keyDown(grid, { key: "f", code: "KeyF", ctrlKey: true })

		const field = await screen.findByRole("searchbox", { name: preview.previewDocxFindPlaceholder })

		fireEvent.change(field, { target: { value: "apple" } })
		await waitFor(() => {
			expect(screen.getByText("1/1")).toBeTruthy()
		})

		fireEvent.keyDown(grid, { key: "PageDown", code: "PageDown", ctrlKey: true })
		// More!A1 and A4, though A4 lies outside A1:A3.
		await waitFor(() => {
			expect(screen.getByText(/\/2$/)).toBeTruthy()
		})
	})

	it("looks in formulas only while replacing, as Excel's Replace does", async () => {
		const grid = await openViewer()

		fireEvent.keyDown(grid, { key: "h", code: "KeyH", ctrlKey: true })
		await screen.findByRole("searchbox", { name: preview.previewDocxFindPlaceholder })
		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetFindOptions }))

		await screen.findByRole("menuitemradio", { name: preview.previewSheetFindLookInFormulas })
		expect(screen.queryByRole("menuitemradio", { name: preview.previewSheetFindLookInValues })).toBeNull()
	})

	it("searches only a selection of several cells, moving the active cell inside it", async () => {
		const grid = await openViewer()
		const box = screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSheetNameBox })

		fireEvent.focus(box)
		fireEvent.change(box, { target: { value: "A1:A3" } })
		fireEvent.keyDown(box, { key: "Enter" })
		await waitFor(() => {
			expect(nameBox()).toBe("A1:A3")
		})

		fireEvent.keyDown(grid, { key: "f", code: "KeyF", ctrlKey: true })

		const field = await screen.findByRole("searchbox", { name: preview.previewDocxFindPlaceholder })

		// B2 "red apple" and A4 "Apple pie" lie outside it.
		fireEvent.change(field, { target: { value: "apple" } })
		await waitFor(() => {
			expect(screen.getByText("1/1")).toBeTruthy()
		})
		expect(nameBox()).toBe("A1:A3")
		// The active cell is A2 (the grid names it for assistive technology).
		expect(within(grid).getByRole("row").getAttribute("aria-rowindex")).toBe("2")
		expect(within(grid).getByRole("gridcell").getAttribute("aria-colindex")).toBe("1")
	})

	it("replaces every match as one step with Mod+H", async () => {
		const grid = await openViewer()

		fireEvent.keyDown(grid, { key: "h", code: "KeyH", ctrlKey: true })

		const field = await screen.findByRole("searchbox", { name: preview.previewDocxFindPlaceholder })
		const replacement = screen.getByRole("textbox", { name: preview.previewDocxReplacePlaceholder })

		fireEvent.change(field, { target: { value: "apple" } })
		await waitFor(() => {
			expect(nameBox()).toBe("A2")
		})
		fireEvent.change(replacement, { target: { value: "plum" } })

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: preview.previewDocxReplaceAll }))
			await Promise.resolve()
		})

		// Replaced in what was typed, case ignored: "Apple pie" too.
		await waitFor(() => {
			expect(screen.getByText(preview.previewDocxFindNoMatches)).toBeTruthy()
		})

		fireEvent.change(field, { target: { value: "plum" } })
		await waitFor(() => {
			expect(screen.getByText("1/3")).toBeTruthy()
		})

		fireEvent.keyDown(grid, { key: "z", code: "KeyZ", ctrlKey: true })
		await waitFor(() => {
			expect(screen.getByText(preview.previewDocxFindNoMatches)).toBeTruthy()
		})
	})
})
