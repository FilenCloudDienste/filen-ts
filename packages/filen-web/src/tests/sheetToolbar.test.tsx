// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { writeXlsx } from "hucre/xlsx"
import { inThreadSheetHost } from "@filen/office/dom/sheet"
import type { SheetOpened, SheetRenderStyle } from "@filen/office/core/sheet"
import { createSheetGrid, useSheetGrid, type SheetGridModel } from "@filen/office/react/sheet"
import { act } from "react"
import type { SheetRibbonCommands } from "@/features/spreadsheet/components/sheetExtension"
import { borderShortcut, setFormatCellsOpen } from "@/features/spreadsheet/toolbar/formatCellsState"
import type { SheetRibbonActions } from "@/features/spreadsheet/toolbar/sheetToolbar"
import { ribbonActions } from "@/tests/sheetMenusFixtures"

// The spreadsheet's ribbon over a real session on this thread: it shows the active cell's format, and what its
// controls do reaches the session (formats, borders, indents, angles, decimals, rows and columns, clearing, filling,
// the Format Cells dialog's code); what the view and the features own goes through the ribbon's actions.

const size = vi.hoisted(() => ({ width: 2000 }))

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: size.width, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

// What the grid's last frame drew for a General number it rounded (a narrow cell), as the ribbon asks it.
const rounded = vi.hoisted(() => ({ text: undefined as string | undefined }))

vi.mock("@filen/office/react/sheet", async importOriginal => ({
	...(await importOriginal<typeof import("@filen/office/react/sheet")>()),
	roundedGeneral: () => rounded.text
}))

// What the Insert tab and the sheet commands ask the features and the sheet tabs for.
const requests = vi.hoisted(() => ({ image: vi.fn(), chart: vi.fn(), tab: vi.fn() }))

vi.mock("@/features/spreadsheet/objects/insertRequests", () => ({ requestImage: requests.image }))
vi.mock("@/features/spreadsheet/charts/chartRequests", () => ({ requestChart: requests.chart }))
vi.mock("@/features/spreadsheet/tabs/tabRequests", () => ({ requestSheetTab: requests.tab }))

const { SheetToolbar } = await import("@/features/spreadsheet/toolbar/sheetToolbar")

afterEach(() => {
	cleanup()
	size.width = 2000
	rounded.text = undefined
	requests.image.mockClear()
	requests.chart.mockClear()
	requests.tab.mockClear()
	vi.restoreAllMocks()
})

async function opened(): Promise<SheetOpened> {
	const bytes = await writeXlsx({
		sheets: [
			{
				name: "Sheet1",
				rows: [
					[3.14159, "text"],
					[2, 3]
				]
			}
		]
	})
	const result = await inThreadSheetHost().open(bytes, { kind: "xlsx" }, () => undefined)

	if (result.kind !== "opened") {
		throw new Error(result.kind)
	}

	await result.session.intent()

	return result
}

function Harness({
	open,
	onModel,
	disabled = false,
	viewOnly = false,
	actions
}: {
	open: SheetOpened
	onModel: (model: SheetGridModel) => void
	disabled?: boolean
	viewOnly?: boolean
	actions: SheetRibbonActions
}) {
	const [model] = useState(() => {
		const created = createSheetGrid(open)

		// The grid's first tile, as a drawn grid would hold it: changes patch it and bring their styles.
		created.need(open.info.activeSheet, [0, 0])
		onModel(created)

		return created
	})
	const grid = useSheetGrid(model)

	return (
		<SheetToolbar
			grid={grid}
			disabled={disabled}
			viewOnly={viewOnly}
			formats
			actions={actions}
			onFormat={patch => {
				void model.command({ type: "format.apply", sheet: grid.sheet, ranges: grid.selection.ranges, patch })
			}}
		/>
	)
}

async function mounted(commands: SheetRibbonCommands = {}): Promise<{
	model: SheetGridModel
	open: SheetOpened
	actions: SheetRibbonActions
	style: () => Promise<SheetRenderStyle>
	numFmt: () => Promise<string>
	text: (row: number, col: number) => Promise<string>
}> {
	const open = await opened()
	const actions = { ...ribbonActions(), commands }
	let model: SheetGridModel | null = null

	render(
		<Harness
			open={open}
			actions={actions}
			onModel={created => {
				model = created
			}}
		/>
	)

	const grid = model as unknown as SheetGridModel
	const cell = () => open.session.query("cell", { sheet: open.info.activeSheet, row: 0, col: 0 })

	await waitFor(() => {
		expect(grid.entry(open.info.activeSheet, 0, 0)).not.toBeNull()
	})

	// The controls turn on once the active cell's format is known.
	await waitFor(() => {
		expect(screen.getByRole("button", { name: "Bold" }).hasAttribute("disabled")).toBe(false)
	})

	return {
		model: grid,
		open,
		actions,
		style: async () => grid.style((await cell()).style),
		numFmt: async () => (await cell()).numFmt,
		text: async (row, col) => (await open.session.query("cell", { sheet: open.info.activeSheet, row, col })).input
	}
}

function commands(): HTMLElement {
	return screen.getByRole("toolbar", { name: "Commands" })
}

async function pick(menu: string, item: string, role = "menuitem"): Promise<void> {
	fireEvent.click(within(commands()).getByRole("button", { name: menu }))
	fireEvent.click(await screen.findByRole(role, { name: item }))
}

describe("spreadsheet ribbon", () => {
	it("lays out Excel's tabs and Home's groups: undo, clipboard, font, formatting, alignment, number, cells, editing", async () => {
		await mounted()

		expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Home", "Insert", "Data", "Review", "View"])
		expect(
			within(commands())
				.getAllByRole("group")
				.map(group => group.getAttribute("aria-label"))
		).toEqual(["Undo", "Clipboard", "Font", "Formatting", "Alignment", "Number", "Cells", "Editing"])
	})

	it("toggles bold on the selection as the active cell shows it", async () => {
		const { style } = await mounted()

		fireEvent.click(screen.getByRole("button", { name: "Bold" }))
		await waitFor(async () => {
			expect((await style()).bold).toBe(true)
		})
		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Bold" }).getAttribute("aria-pressed")).toBe("true")
		})
		fireEvent.click(screen.getByRole("button", { name: "Bold" }))
		await waitFor(async () => {
			expect((await style()).bold).toBeUndefined()
		})
	})

	it("pastes, pastes values, cuts and copies through the view's clipboard", async () => {
		const { actions } = await mounted()

		await pick("Paste", "Paste values")
		expect(actions.paste).toHaveBeenLastCalledWith(true)
		await pick("Paste", "Paste")
		expect(actions.paste).toHaveBeenLastCalledWith(false)
		fireEvent.click(screen.getByRole("button", { name: "Cut" }))
		expect(actions.copy).toHaveBeenLastCalledWith(true)
		fireEvent.click(screen.getByRole("button", { name: "Copy" }))
		expect(actions.copy).toHaveBeenLastCalledWith(false)
	})

	it("adds a decimal place to a General number from the places it shows", async () => {
		const { numFmt } = await mounted()

		fireEvent.click(screen.getByRole("button", { name: "Increase decimal" }))
		await waitFor(async () => {
			expect(await numFmt()).toBe("0.000000")
		})
		fireEvent.click(screen.getByRole("button", { name: "Decrease decimal" }))
		await waitFor(async () => {
			expect(await numFmt()).toBe("0.00000")
		})
	})

	it("adds a decimal place to a General number a narrow cell rounds from the places the cell shows", async () => {
		const { numFmt } = await mounted()

		rounded.text = "3.14"
		fireEvent.click(screen.getByRole("button", { name: "Increase decimal" }))
		await waitFor(async () => {
			expect(await numFmt()).toBe("0.000")
		})
	})

	it("indents the cell a level at a time, aligning General text left as Excel does", async () => {
		const { style } = await mounted()

		expect(screen.getByRole("button", { name: "Decrease indent" }).hasAttribute("disabled")).toBe(true)
		fireEvent.click(screen.getByRole("button", { name: "Increase indent" }))
		await waitFor(async () => {
			const look = await style()

			expect([look.indent, look.align]).toEqual([1, "left"])
		})
		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Decrease indent" }).hasAttribute("disabled")).toBe(false)
		})
		fireEvent.click(screen.getByRole("button", { name: "Decrease indent" }))
		await waitFor(async () => {
			expect((await style()).indent).toBeUndefined()
		})
	})

	it("turns the text to an angle and back from Orientation, and shrinks it to fit", async () => {
		const { style } = await mounted()

		await pick("Orientation", "Angle clockwise", "menuitemcheckbox")
		await waitFor(async () => {
			expect((await style()).rotation).toBe(-45)
		})
		await waitFor(async () => {
			fireEvent.click(within(commands()).getByRole("button", { name: "Orientation" }))
			expect((await screen.findByRole("menuitemcheckbox", { name: "Angle clockwise" })).getAttribute("aria-checked")).toBe("true")
		})
		fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Angle clockwise" }))
		await waitFor(async () => {
			expect((await style()).rotation).toBeUndefined()
		})
		await pick("Orientation", "Shrink to fit", "menuitemcheckbox")
		await waitFor(async () => {
			expect((await style()).shrink).toBe(true)
		})
	})

	it("draws all borders from the Borders menu in the chosen line style", async () => {
		const { style } = await mounted()

		fireEvent.click(screen.getByRole("button", { name: "Borders" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Line style" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Dashed" }))
		fireEvent.click(screen.getByRole("button", { name: "Borders" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "All borders" }))
		await waitFor(async () => {
			const look = await style()

			expect([look.top?.style, look.right?.style, look.bottom?.style, look.left?.style]).toEqual([
				"dashed",
				"dashed",
				"dashed",
				"dashed"
			])
		})
	})

	it("names the Borders menu's groups for screen readers", async () => {
		await mounted()

		fireEvent.click(screen.getByRole("button", { name: "Borders" }))

		for (const name of ["Edges", "Outlines", "Top and bottom", "Inside and diagonal"]) {
			expect(await screen.findByRole("group", { name })).toBeTruthy()
		}
	})

	it("draws an outline and takes borders off with the shortcuts' command", async () => {
		const { model, open, style } = await mounted()
		const ranges = [{ startRow: 0, startCol: 0, endRow: 1, endCol: 1 }]

		await model.command(borderShortcut("borderOutline", open.info.activeSheet, ranges))
		await waitFor(async () => {
			const look = await style()

			expect([look.top?.style, look.left?.style, look.bottom, look.right]).toEqual(["thin", "thin", undefined, undefined])
		})
		await model.command(borderShortcut("borderNone", open.info.activeSheet, ranges))
		await waitFor(async () => {
			const look = await style()

			expect([look.top, look.left]).toEqual([undefined, undefined])
		})
	})

	it("applies a number format from the menu, Comma style, and a custom code from the Format Cells dialog", async () => {
		const { numFmt } = await mounted()

		fireEvent.click(screen.getByRole("button", { name: "Number format" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Percentage/u }))
		await waitFor(async () => {
			expect(await numFmt()).toBe("0.00%")
		})
		fireEvent.click(screen.getByRole("button", { name: "Comma style" }))
		await waitFor(async () => {
			expect(await numFmt()).toContain("#,##0.00")
		})
		fireEvent.click(screen.getByRole("button", { name: "Format cells…" }))

		const code = await screen.findByRole("textbox", { name: "Format code" })

		fireEvent.change(code, { target: { value: '0.0" kg' } })
		expect(await screen.findByText("Close every quote and bracket, and follow \\, _ and * with a character.")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true)
		// A pasted control character: a file cannot hold it, so the dialog refuses it as the session would.
		fireEvent.change(code, { target: { value: "0.0\u0001" } })
		expect(await screen.findByText("Remove the control characters from the format code.")).toBeTruthy()
		fireEvent.change(code, { target: { value: '0.0" kg"' } })
		expect(screen.getByLabelText("Sample").textContent).toBe("3.1 kg")
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		await waitFor(async () => {
			expect(await numFmt()).toBe('0.0" kg"')
		})
	})

	it("opens Format Cells from what opens it outside the ribbon (Ctrl+1)", async () => {
		const { model } = await mounted()

		expect(screen.queryByRole("dialog")).toBeNull()
		act(() => {
			setFormatCellsOpen(model, true)
		})
		expect(await screen.findByRole("dialog", { name: "Format cells" })).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		await waitFor(() => {
			expect(screen.queryByRole("dialog", { name: "Format cells" })).toBeNull()
		})
	})

	it("does not keep Ctrl+1 waiting while the ribbon has no cell format to start from", async () => {
		const open = await opened()
		const actions = ribbonActions()
		let model: SheetGridModel | null = null
		const onModel = (created: SheetGridModel): void => {
			model = created
		}
		const { rerender } = render(
			<Harness
				open={open}
				onModel={onModel}
				actions={actions}
				disabled
			/>
		)
		const grid = model as unknown as SheetGridModel

		await waitFor(() => {
			expect(grid.entry(open.info.activeSheet, 0, 0)).not.toBeNull()
		})
		act(() => {
			setFormatCellsOpen(grid, true)
		})
		rerender(
			<Harness
				open={open}
				onModel={onModel}
				actions={actions}
			/>
		)
		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Text color" }).hasAttribute("disabled")).toBe(false)
		})
		expect(screen.queryByRole("dialog", { name: "Format cells" })).toBeNull()
	})

	it("inserts and deletes whole rows and columns, and asks the view for the cell dialogs and the sheet's name", async () => {
		const { actions, text } = await mounted()

		await pick("Insert", "Insert sheet rows")
		await waitFor(async () => {
			expect(await text(1, 0)).toBe("3.14159")
		})
		await pick("Delete", "Delete sheet rows")
		await waitFor(async () => {
			expect(await text(0, 0)).toBe("3.14159")
		})
		await pick("Insert", "Insert cells…")
		expect(actions.insertCells).toHaveBeenCalledTimes(1)
		await pick("Delete", "Delete sheet")
		await pick("Format", "Rename sheet")
		expect(requests.tab.mock.calls.map((call: unknown[]) => call[1])).toEqual(["delete", "rename"])
		await pick("Format", "AutoFit column width")
		expect(actions.autofit).toHaveBeenLastCalledWith("cols")
	})

	it("clears formats keeping contents, then contents, from Clear", async () => {
		const { style, numFmt, text } = await mounted()

		fireEvent.click(screen.getByRole("button", { name: "Bold" }))
		await waitFor(async () => {
			expect((await style()).bold).toBe(true)
		})
		await pick("Clear", "Clear formats")
		await waitFor(async () => {
			expect((await style()).bold).toBeUndefined()
		})
		expect(await numFmt()).toBe("General")
		expect(await text(0, 0)).toBe("3.14159")
		await pick("Clear", "Clear contents")
		await waitFor(async () => {
			expect(await text(0, 0)).toBe("")
		})
	})

	it("sums with AutoSum through the view, fills down, and offers Series… once the fill feature does", async () => {
		const fillSeries = vi.fn()
		const { actions } = await mounted({ fillSeries })

		fireEvent.click(screen.getByRole("button", { name: "AutoSum" }))
		expect(actions.shortcut).toHaveBeenLastCalledWith("autoSum")
		await pick("Fill", "Series…")
		expect(fillSeries).toHaveBeenCalledTimes(1)
	})

	it("asks for a chart, a picture, a link and a note from the Insert tab", async () => {
		const { model, actions } = await mounted()

		fireEvent.click(screen.getByRole("tab", { name: "Insert" }))
		await pick("Insert chart", "Pie")
		expect(requests.chart).toHaveBeenLastCalledWith(model, "pie")
		await pick("Pictures", "Image from drive…")
		expect(requests.image).toHaveBeenLastCalledWith(model, "drive")
		fireEvent.click(screen.getByRole("button", { name: "Link…" }))
		expect(actions.shortcut).toHaveBeenLastCalledWith("hyperlink")
		fireEvent.click(screen.getByRole("button", { name: "Note" }))
		expect(actions.shortcut).toHaveBeenLastCalledWith("note")
		// No comment without the annotations feature offering one.
		expect(screen.getByRole("button", { name: "New comment" }).hasAttribute("disabled")).toBe(true)
	})

	it("offers data validation from the Data tab once the feature does, and the note and protection on Review", async () => {
		const dataValidation = vi.fn()
		const toggle = vi.fn()

		await mounted({ dataValidation, note: { exists: true, shown: false, toggle, remove: vi.fn() } })
		fireEvent.click(screen.getByRole("tab", { name: "Data" }))
		fireEvent.click(screen.getByRole("button", { name: "Data validation…" }))
		expect(dataValidation).toHaveBeenCalledTimes(1)
		fireEvent.click(screen.getByRole("tab", { name: "Review" }))
		expect(screen.getByRole("button", { name: "Edit note" })).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Show note" }))
		expect(toggle).toHaveBeenCalledTimes(1)
		fireEvent.click(screen.getByRole("button", { name: "Protect sheet…" }))
		expect(requests.tab).toHaveBeenLastCalledWith(expect.anything(), "protectSheet")
	})

	it("zooms and shows formulas from the View tab, the zoom shown at the tab row's end", async () => {
		const { model } = await mounted()
		const setZoom = vi.spyOn(model, "setZoom")

		fireEvent.click(screen.getByRole("tab", { name: "View" }))
		fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
		expect(setZoom).toHaveBeenLastCalledWith(125)
		expect(screen.getByRole("button", { name: "Zoom 125%, back to 100%" }).textContent).toBe("125%")
		fireEvent.click(screen.getByRole("button", { name: "Show formulas" }))
		await waitFor(() => {
			expect(model.getSnapshot().showFormulas).toBe(true)
		})
		expect(screen.getByRole("button", { name: "Show formulas" }).getAttribute("aria-pressed")).toBe("true")
	})

	it("shows the Chart tab while a chart is selected", async () => {
		const editChart = vi.fn()
		const remove = vi.fn()

		await mounted({ object: { chart: true, altText: undefined, remove }, editChart })
		fireEvent.click(screen.getByRole("tab", { name: "Chart" }))
		fireEvent.click(screen.getByRole("button", { name: "Edit chart…" }))
		expect(editChart).toHaveBeenCalledTimes(1)
		fireEvent.click(screen.getByRole("button", { name: "Delete object" }))
		expect(remove).toHaveBeenCalledTimes(1)
		expect(screen.getByRole("button", { name: "Edit alt text…" }).hasAttribute("disabled")).toBe(true)
	})

	it("keeps what reads for a file nothing edits here: copying and finding on Home, zooming on View", async () => {
		const open = await opened()

		render(
			<Harness
				open={open}
				onModel={() => undefined}
				actions={ribbonActions()}
				disabled
				viewOnly
			/>
		)

		expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Home", "View"])
		expect(
			within(commands())
				.getAllByRole("group")
				.map(group => group.getAttribute("aria-label"))
		).toEqual(["Clipboard", "Editing"])
		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Copy" }).hasAttribute("disabled")).toBe(false)
		})
		expect(screen.getByRole("button", { name: "Find" }).hasAttribute("disabled")).toBe(false)
		fireEvent.click(screen.getByRole("tab", { name: "View" }))
		expect(
			within(commands())
				.getAllByRole("group")
				.map(group => group.getAttribute("aria-label"))
		).toEqual(["Zoom", "Show"])
	})

	it("collapses groups into dropdowns on a narrow row and keeps them working there", async () => {
		size.width = 1000

		const { style } = await mounted()
		const row = commands()

		expect(within(row).getByRole("group", { name: "Font" })).toBeTruthy()
		expect(within(row).queryByRole("group", { name: "Alignment" })).toBeNull()
		fireEvent.click(within(row).getByRole("button", { name: "Alignment" }))
		fireEvent.click(within(await screen.findByRole("toolbar", { name: "Alignment" })).getByRole("button", { name: "Wrap text" }))
		await waitFor(async () => {
			expect((await style()).wrap).toBe(true)
		})
	})

	it("keeps undo and the character formats in a phone's row, the rest in the overflow menu", async () => {
		vi.spyOn(window, "matchMedia").mockImplementation(
			query =>
				({
					matches: query.includes("max-width"),
					media: query,
					addEventListener: () => undefined,
					removeEventListener: () => undefined
				}) as unknown as MediaQueryList
		)
		size.width = 360
		await mounted()
		expect(
			within(commands())
				.getAllByRole("group")
				.map(group => group.getAttribute("aria-label"))
		).toEqual(["Undo", "Formatting"])
		fireEvent.click(within(commands()).getByRole("button", { name: "More commands" }))
		expect(await screen.findByRole("toolbar", { name: "Number" })).toBeTruthy()
	})
})
