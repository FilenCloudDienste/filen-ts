// @vitest-environment jsdom

// Data validation in the viewer over a real session on this thread: entries checked one after another while a check
// is still out, each asked about in turn with the grid showing only what the file holds, and a list validation's
// values opened and left from the keyboard.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { inThreadSheetHost } from "@filen/office/dom/sheet"
import { SheetGridModel } from "@filen/office/react/sheet"
import { writeXlsx } from "hucre/xlsx"
import type { DriveItem } from "@/features/drive/lib/item"
import { registerAllActions } from "@/lib/keymap/actions"
import { common } from "@/locales/en/common"
import { preview } from "@/locales/en/preview"

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

// A whole number 1 to 10 in A1:A10 and a list in C1:C10, both stopping an invalid entry.
async function workbook(): Promise<Uint8Array> {
	return await writeXlsx({
		sheets: [
			{
				name: "Data",
				rows: [[1]],
				dataValidations: [
					{ type: "whole", operator: "between", formula1: "1", formula2: "10", range: "A1:A10", showErrorMessage: true },
					{ type: "list", values: ["red", "green", "blue"], range: "C1:C10", showErrorMessage: true }
				]
			}
		]
	})
}

async function openViewer(): Promise<HTMLElement> {
	bytes.current = await workbook()
	render(
		<SheetViewer
			item={file("dv.xlsx")}
			documentKey="dv"
			alt="dv.xlsx"
			editable
			saveRef={{ current: null }}
		/>
	)
	await screen.findByRole("textbox", { name: preview.previewSpreadsheetCellContents })

	return await screen.findByRole("grid", {}, { timeout: 5000 })
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

async function type(grid: HTMLElement, text: string): Promise<void> {
	fireEvent.keyDown(grid, { key: text.slice(0, 1) })

	const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: preview.previewSheetCellEditor })

	fireEvent.change(editor, { target: { value: text } })
	fireEvent.keyDown(editor, { key: "Enter" })
}

describe("data validation in the viewer", () => {
	it("asks about each of two invalid entries committed back to back, the grid showing only what the file holds", async () => {
		const commits = vi.spyOn(SheetGridModel.prototype, "commitEditing")
		const grid = await openViewer()

		await goTo("A2")
		// The second is committed before the first one's check has come back.
		await type(grid, "50")
		await type(grid, "70")

		const asked: string[] = []

		for (let k = 0; k < 2; k++) {
			const alert = await screen.findByRole("alertdialog", {}, { timeout: 3000 })

			asked.push(alert.textContent)
			await act(async () => {
				fireEvent.click(within(alert).getByRole("button", { name: common.cancel }))
				await new Promise(resolve => setTimeout(resolve, 50))
			})
		}

		expect(asked).toHaveLength(2)
		await waitFor(() => {
			expect(document.querySelector("[role=alertdialog]")).toBeNull()
		})

		const contexts: readonly unknown[] = commits.mock.contexts
		const model = contexts.find(context => context instanceof SheetGridModel)

		if (model === undefined) throw new Error("No entry was committed")

		const sheet = model.getSnapshot().sheet
		const settled = await Promise.race([
			Promise.all(commits.mock.results.map((result): unknown => result.value)).then(() => "settled"),
			new Promise(resolve => {
				setTimeout(() => {
					resolve("waiting")
				}, 2000)
			})
		])

		expect({ settled, a2: model.pendingText(sheet, 1, 0), a3: model.pendingText(sheet, 2, 0) }).toEqual({
			settled: "settled",
			a2: undefined,
			a3: undefined
		})
		// Cancelled: typing goes on in the grid.
		expect(document.activeElement).toBe(grid)
	}, 20_000)

	it("opens a list validation's values with Alt+Down, and Esc gives typing back to the grid", async () => {
		const grid = await openViewer()

		await goTo("C2")
		await waitFor(() => {
			expect(document.querySelectorAll("[data-sheet-validation-button]")).toHaveLength(1)
		})
		fireEvent.keyDown(grid, { key: "ArrowDown", code: "ArrowDown", altKey: true })

		const list = await screen.findByRole("listbox", {}, { timeout: 2000 })

		await waitFor(() => {
			expect(screen.getAllByRole("option")).toHaveLength(3)
		})
		fireEvent.keyDown(list, { key: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("listbox")).toBeNull()
		})
		expect(document.activeElement).toBe(grid)
	}, 20_000)
})
