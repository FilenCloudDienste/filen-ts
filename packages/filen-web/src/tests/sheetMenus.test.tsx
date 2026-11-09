// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { AxisFlag, SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetCommand, type SheetRange } from "@filen/office/core/sheet"
import type { SheetGridModel, SheetGridState } from "@filen/office/react/sheet"
import { bytesSource } from "@filen/office/core/opc"
import { openXlsx, saveXlsx } from "@filen/office/core/xlsx"
import { inThreadSheetHost } from "@filen/office/dom/sheet"
import { label, openGrid, workbook } from "@/tests/sheetMenusFixtures"
import { GridHarness } from "@/tests/sheetMenusHarness"
import { preview } from "@/locales/en/preview"

// The structure items of the spreadsheet viewer: rows and columns hidden and shown from the grid's
// menu, merges (with Excel's value-loss question), and a text file's frozen panes kept beside it across a reopen.

const { kv } = vi.hoisted(() => ({ kv: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kv.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kv.set(key, structuredClone(value))

		return Promise.resolve()
	},
	kvDelete: (key: string) => {
		kv.delete(key)

		return Promise.resolve()
	}
}))

const { SheetGridMenu } = await import("@/features/spreadsheet/components/sheetGridMenu")
const { useMergeCommands } = await import("@/features/spreadsheet/menus/useMergeCommands")
const { SheetModifyPassword } = await import("@/features/spreadsheet/menus/modifyPassword")
const { freezeTo } = await import("@/features/spreadsheet/menus/structureCommands")
const { structureShortcut } = await import("@/features/spreadsheet/menus/structureShortcuts")

function hiddenRows(model: SheetGridModel): number[] {
	const layout = model.getSnapshot().layout
	const out: number[] = []

	layout?.rows.indices.forEach((index, k) => {
		if (((layout.rows.flags[k] ?? 0) & AxisFlag.HIDDEN) !== 0) {
			out.push(index)
		}
	})

	return out
}

function selectRows(model: SheetGridModel, startRow: number, endRow: number): void {
	act(() => {
		model.select({
			active: { row: startRow, col: 0 },
			anchor: { row: startRow, col: 0 },
			focus: { row: endRow, col: 0 },
			ranges: [{ startRow, startCol: 0, endRow, endCol: 16_383 }]
		})
	})
}

function openMenu(container: HTMLElement): void {
	const trigger = container.querySelector("[data-slot=context-menu-trigger]")

	if (trigger === null) {
		throw new Error("no menu trigger")
	}

	fireEvent.contextMenu(trigger)
}

describe("the grid menu's structure items", () => {
	it("hides the selected rows and shows hidden rows again from a selection around them", async () => {
		const model = await openGrid(await workbook([{ name: "One", rows: [["a"], ["b"], ["c"], ["d"]] }]), "xlsx")
		const run = (command: SheetCommand): void => {
			void model.command(command)
		}
		const view = render(
			<GridHarness model={model}>
				{grid => (
					<SheetGridMenu
						grid={grid}
						canEdit
						run={run}
					>
						<div />
					</SheetGridMenu>
				)}
			</GridHarness>
		)

		selectRows(model, 1, 2)
		openMenu(view.container)
		fireEvent.click(await screen.findByText(/^(Hide 2 rows|previewSheetHideRows)$/))
		await waitFor(() => {
			expect(hiddenRows(model)).toEqual([1, 2])
		})

		selectRows(model, 0, 3)
		openMenu(view.container)
		fireEvent.click(await screen.findByText(label("previewSheetUnhideRows")))
		await waitFor(() => {
			expect(hiddenRows(model)).toEqual([])
		})
	})

	it("deletes the rows of every selected range at once, and inserts above each", async () => {
		const model = await openGrid(await workbook([{ name: "One", rows: [["a"], ["b"], ["c"], ["d"], ["e"]] }]), "xlsx")
		const run = vi.fn<(command: SheetCommand) => void>()
		const view = render(
			<GridHarness model={model}>
				{grid => (
					<SheetGridMenu
						grid={grid}
						canEdit
						run={run}
					>
						<div />
					</SheetGridMenu>
				)}
			</GridHarness>
		)
		const row = (at: number): SheetRange => ({ startRow: at, startCol: 0, endRow: at, endCol: SHEET_MAX_COLS - 1 })

		act(() => {
			model.select({ active: { row: 3, col: 0 }, anchor: { row: 3, col: 0 }, focus: { row: 3, col: 0 }, ranges: [row(1), row(3)] })
		})
		openMenu(view.container)
		fireEvent.click(await screen.findByText(/^(Delete 2 rows|previewSpreadsheetDeleteRows)$/))
		expect(run).toHaveBeenLastCalledWith({
			type: "axis.delete",
			sheet: model.getSnapshot().sheet,
			axis: "rows",
			spans: [
				{ at: 1, count: 1 },
				{ at: 3, count: 1 }
			]
		})

		openMenu(view.container)
		fireEvent.click(await screen.findByText(/^(Insert 2 rows above|previewSpreadsheetInsertRowsAbove)$/))
		expect(run).toHaveBeenLastCalledWith({
			type: "axis.insert",
			sheet: model.getSnapshot().sheet,
			axis: "rows",
			spans: [
				{ at: 1, count: 1 },
				{ at: 3, count: 1 }
			]
		})
	})

	it("offers no unhide where no hidden row is in or next to the selection", async () => {
		const model = await openGrid(await workbook([{ name: "One", rows: [["a"], ["b"]] }]), "xlsx")
		const view = render(
			<GridHarness model={model}>
				{grid => (
					<SheetGridMenu
						grid={grid}
						canEdit
						run={() => undefined}
					>
						<div />
					</SheetGridMenu>
				)}
			</GridHarness>
		)

		selectRows(model, 0, 0)
		openMenu(view.container)

		const item = (await screen.findByText(label("previewSheetUnhideRows"))).closest("[role=menuitem]")

		expect(item?.getAttribute("aria-disabled") ?? item?.hasAttribute("data-disabled")).toBeTruthy()
	})
})

describe("the hide and unhide shortcuts", () => {
	it("hide the selected rows, show them again from a selection around them, and leave other shortcuts alone", async () => {
		const model = await openGrid(await workbook([{ name: "One", rows: [["a"], ["b"], ["c"], ["d"]] }]), "xlsx")

		selectRows(model, 1, 2)
		expect(structureShortcut(stateOf(model), "hideRows", true)).toBe(true)
		await waitFor(() => {
			expect(hiddenRows(model)).toEqual([1, 2])
		})

		selectRows(model, 0, 3)
		expect(structureShortcut(stateOf(model), "unhideRows", true)).toBe(true)
		await waitFor(() => {
			expect(hiddenRows(model)).toEqual([])
		})

		const sent = vi.spyOn(model, "command")

		expect(structureShortcut(stateOf(model), "hideRows", false)).toBe(true)
		expect(structureShortcut(stateOf(model), "find", true)).toBe(false)
		expect(sent).not.toHaveBeenCalled()
	})
})

describe("unhide over the whole sheet", () => {
	it("shows every hidden row and column again from a select-all", async () => {
		const model = await openGrid(
			await workbook([
				{
					name: "One",
					rows: [
						["a", "b", "c"],
						["d", "e", "f"],
						["g", "h", "i"]
					]
				}
			]),
			"xlsx"
		)
		const all = { startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 }
		const hiddenCols = (): number[] => {
			const layout = model.getSnapshot().layout
			const out: number[] = []

			layout?.cols.indices.forEach((index, k) => {
				if (((layout.cols.flags[k] ?? 0) & AxisFlag.HIDDEN) !== 0) {
					out.push(index)
				}
			})

			return out
		}

		void model.intent()
		await model.command({
			type: "axis.hide",
			sheet: model.getSnapshot().sheet,
			axis: "rows",
			spans: [{ start: 1, end: 1 }],
			hidden: true
		})
		await model.command({
			type: "axis.hide",
			sheet: model.getSnapshot().sheet,
			axis: "cols",
			spans: [{ start: 2, end: 2 }],
			hidden: true
		})
		await waitFor(() => {
			expect(hiddenRows(model)).toEqual([1])
			expect(hiddenCols()).toEqual([2])
		})

		act(() => {
			model.select({
				active: { row: 0, col: 0 },
				anchor: { row: 0, col: 0 },
				focus: { row: all.endRow, col: all.endCol },
				ranges: [all]
			})
		})

		const sent = vi.spyOn(model, "command")

		expect(structureShortcut(stateOf(model), "unhideRows", true)).toBe(true)
		expect(structureShortcut(stateOf(model), "unhideColumns", true)).toBe(true)
		expect(sent.mock.calls.map(([command]) => (command.type === "axis.hide" ? command.spans : null))).toEqual([
			[{ start: 0, end: SHEET_MAX_ROWS - 1 }],
			[{ start: 0, end: SHEET_MAX_COLS - 1 }]
		])
		await waitFor(() => {
			expect(hiddenRows(model)).toEqual([])
			expect(hiddenCols()).toEqual([])
		})
	})
})

describe("merging", () => {
	it("asks before dropping values outside the upper-left cell, then merges", async () => {
		const model = await openGrid(await workbook([{ name: "One", rows: [["keep", "lost"]] }]), "xlsx")
		const sent = vi.spyOn(model, "command")

		act(() => {
			model.select({
				active: { row: 0, col: 0 },
				anchor: { row: 0, col: 0 },
				focus: { row: 0, col: 1 },
				ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }]
			})
		})
		render(<GridHarness model={model}>{grid => <Merge grid={grid} />}</GridHarness>)

		fireEvent.click(screen.getByText("merge"))
		await screen.findByText(label("previewSheetMergeLosesBody"))
		expect(model.getSnapshot().layout?.merges.length).toBe(0)
		fireEvent.click(screen.getByRole("button", { name: label("previewSheetMergeCells") }))
		await waitFor(() => {
			expect([...(model.getSnapshot().layout?.merges ?? [])]).toEqual([0, 0, 0, 1])
		})
		expect(sent.mock.calls.map(([command]) => command)).toEqual([
			expect.objectContaining({ type: "merge.cells", mode: "center" }),
			expect.objectContaining({ type: "merge.cells", mode: "center", discard: true })
		])
	})
})

describe("a text file's frozen panes", () => {
	const csv = Uint8Array.from(new TextEncoder().encode("a,b\r\n1,2\r\n3,4\r\n"))

	function shown(model: SheetGridModel) {
		return render(
			<GridHarness model={model}>
				{grid => (
					<SheetGridMenu
						grid={grid}
						canEdit={false}
						run={() => undefined}
						text
						localPane={{ kind: "stable", id: "panes" }}
					>
						<div />
					</SheetGridMenu>
				)}
			</GridHarness>
		)
	}

	it("are kept beside the file and frozen again at the next open", async () => {
		kv.clear()

		const first = await openGrid(csv.slice(), "csv")
		const view = shown(first)

		act(() => {
			freezeTo(stateOf(first), "topRow")
		})
		await waitFor(() => {
			expect(kv.get("spreadsheet.pane.v1.panes")).toEqual({ rows: 1, cols: 0, topRow: 1, leftCol: 0 })
		})
		view.unmount()

		const second = await openGrid(csv.slice(), "csv")

		expect(second.getSnapshot().layout?.pane ?? null).toBeNull()
		shown(second)
		await waitFor(() => {
			expect(second.getSnapshot().layout?.pane).toEqual({ rows: 1, cols: 0, firstRow: 0, firstCol: 0, topRow: 1, leftCol: 0 })
		})
	})
})

describe("the grid menu's clipboard and cell items", () => {
	type Key =
		| "previewSheetTouchCut"
		| "previewSheetTouchCopy"
		| "previewSheetTouchPaste"
		| "previewSheetRibbonPasteValues"
		| "previewSheetRibbonInsertCells"
		| "previewSheetRibbonDeleteCells"
		| "previewSheetFormatCells"

	const KEYS: readonly Key[] = [
		"previewSheetTouchCut",
		"previewSheetTouchCopy",
		"previewSheetTouchPaste",
		"previewSheetRibbonPasteValues",
		"previewSheetRibbonInsertCells",
		"previewSheetRibbonDeleteCells",
		"previewSheetFormatCells"
	]

	// The menu's items by catalog key, in menu order: the English text or, untranslated, the key.
	function shownKeys(): Key[] {
		const texts = screen.getAllByRole("menuitem").map(item => item.textContent)

		return texts.flatMap(text => KEYS.filter(key => text === preview[key] || text === key))
	}

	function item(key: Key): HTMLElement {
		const found = screen.getAllByRole("menuitem").find(entry => entry.textContent === preview[key] || entry.textContent === key)

		if (found === undefined) {
			throw new Error(`no ${key}`)
		}

		return found
	}

	async function open(kind: "xlsx" | "csv", canEdit: boolean, ranges?: SheetRange) {
		const bytes =
			kind === "csv" ? Uint8Array.from(new TextEncoder().encode("a,b\r\n1,2\r\n")) : await workbook([{ name: "One", rows: [["a"]] }])
		const model = await openGrid(bytes, kind)
		const calls: string[] = []
		const actions = {
			copy: (cut: boolean) => calls.push(cut ? "cut" : "copy"),
			paste: (values: boolean) => calls.push(values ? "pasteValues" : "paste"),
			insertCells: () => calls.push("insertCells"),
			deleteCells: () => calls.push("deleteCells"),
			formatCells: () => calls.push("formatCells")
		}
		const view = render(
			<GridHarness model={model}>
				{grid => (
					<SheetGridMenu
						grid={grid}
						canEdit={canEdit}
						run={() => undefined}
						text={kind === "csv"}
						actions={actions}
					>
						<div />
					</SheetGridMenu>
				)}
			</GridHarness>
		)

		if (ranges !== undefined) {
			act(() => {
				const corner = { row: ranges.startRow, col: ranges.startCol }

				model.select({ active: corner, anchor: corner, focus: { row: ranges.endRow, col: ranges.endCol }, ranges: [ranges] })
			})
		}

		openMenu(view.container)
		await screen.findAllByRole("menuitem")

		return calls
	}

	it("leads with Excel's cut, copy and paste, the cell dialogs and format cells, each through the ribbon's handler", async () => {
		const calls = await open("xlsx", true)

		expect(shownKeys()).toEqual([
			"previewSheetTouchCut",
			"previewSheetTouchCopy",
			"previewSheetTouchPaste",
			"previewSheetRibbonPasteValues",
			"previewSheetRibbonInsertCells",
			"previewSheetRibbonDeleteCells",
			"previewSheetFormatCells"
		])
		expect(screen.getAllByRole("menuitem")[0]).toBe(item("previewSheetTouchCut"))

		for (const key of KEYS) {
			if (screen.queryAllByRole("menuitem").length === 0) {
				openMenu(document.body)
				await screen.findAllByRole("menuitem")
			}

			fireEvent.click(item(key))
		}

		expect(calls).toEqual(["cut", "copy", "paste", "pasteValues", "insertCells", "deleteCells", "formatCells"])
	})

	it("offers only copy read-only", async () => {
		await open("xlsx", false)

		expect(shownKeys()).toEqual(["previewSheetTouchCopy"])
	})

	it("offers no paste values or format cells for a text file", async () => {
		await open("csv", true)

		expect(shownKeys()).toEqual([
			"previewSheetTouchCut",
			"previewSheetTouchCopy",
			"previewSheetTouchPaste",
			"previewSheetRibbonInsertCells",
			"previewSheetRibbonDeleteCells"
		])
	})

	it("leaves whole rows to their own insert and delete items", async () => {
		await open("xlsx", true, { startRow: 1, startCol: 0, endRow: 1, endCol: SHEET_MAX_COLS - 1 })

		expect(shownKeys()).not.toContain("previewSheetRibbonInsertCells")
		expect(shownKeys()).not.toContain("previewSheetRibbonDeleteCells")
		expect(shownKeys()).toContain("previewSheetTouchCopy")
	})
})

function Merge({ grid }: { grid: SheetGridState }) {
	const { merge, dialog } = useMergeCommands(grid)

	return (
		<>
			<button
				type="button"
				onClick={() => {
					merge("center")
				}}
			>
				merge
			</button>
			{dialog}
		</>
	)
}

function stateOf(model: SheetGridModel) {
	return { ...model.getSnapshot(), model }
}

describe("a workbook's password to modify", () => {
	it("asks for it and unlocks editing with the right one", async () => {
		const read = await openXlsx(bytesSource(await workbook([{ name: "One", rows: [["a"]] }])))

		if (!read.ok) {
			throw new Error(read.reason)
		}

		read.workbook.fileSharing = { readOnlyRecommended: false, hash: { legacy: "83AF" } }
		read.workbook.changes.workbookSection("fileSharing")

		const saved = await saveXlsx({ opc: read.workbook.opc, workbook: read.workbook })

		if (!saved.ok || saved.bytes === undefined) {
			throw new Error("not saved")
		}

		const host = inThreadSheetHost()
		const opened = await host.open(saved.bytes, { kind: "xlsx" }, () => undefined)

		if (opened.kind !== "opened") {
			throw new Error(opened.kind)
		}

		expect(opened.info.writability).toEqual({ state: "viewOnly", reason: "modifyPassword" })

		const unlocked = vi.fn()

		render(
			<SheetModifyPassword
				session={opened.session}
				name="book.xlsx"
				onUnlock={unlocked}
			/>
		)
		fireEvent.click(screen.getByRole("button", { name: label("previewSheetModifyPasswordEdit") }))

		const field = await screen.findByLabelText(label("previewSheetModifyPasswordLabel"))

		fireEvent.change(field, { target: { value: "Password" } })
		fireEvent.click(screen.getByRole("button", { name: label("previewSheetModifyPasswordSubmit") }))
		await screen.findByText(label("previewSheetModifyPasswordWrong"))
		expect(unlocked).not.toHaveBeenCalled()

		fireEvent.change(field, { target: { value: "password" } })
		fireEvent.click(screen.getByRole("button", { name: label("previewSheetModifyPasswordSubmit") }))
		await waitFor(() => {
			expect(unlocked).toHaveBeenCalledTimes(1)
		})
		opened.session.close()
		host.dispose()
	})
})
