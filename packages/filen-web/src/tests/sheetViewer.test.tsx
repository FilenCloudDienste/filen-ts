// @vitest-environment jsdom

import "@/tests/support/officeKeys"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createRef } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { writeXlsx } from "hucre/xlsx"
import { inThreadSheetHost } from "@filen/office/dom/sheet"
import { isSealedOfficeFile } from "@filen/office/dom/encryption"
import type { SheetFileKind, SheetOpenResult } from "@filen/office/core/sheet"
import type { DriveItem } from "@/features/drive/lib/item"
import type { SpreadsheetSnapshot } from "@/features/spreadsheet/save/sheetSave.logic"
import { WORKBOOK_PASSWORD, encryptedWorkbook } from "@/tests/encryptedWorkbookFixtures"
import { preview } from "@/locales/en/preview"

// The spreadsheet viewer over real sessions, on this thread (the in-thread host stands in for the workers):
// what is typed in the formula bar reaches the session, and the overlay's save hands out what it holds.

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

beforeEach(() => {
	// jsdom lays nothing out and draws no canvas: the grid sees neither a size nor a context.
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

async function budget(): Promise<Uint8Array> {
	return await writeXlsx({
		sheets: [
			{
				name: "Budget",
				rows: [
					["Item", "Cost"],
					["Rent", 1200],
					["Food", 300],
					["Total", 1500]
				],
				cells: new Map([["3,1", { value: 1500, type: "formula", formula: "SUM(B2:B3)", formulaResult: 1500 }]])
			}
		]
	})
}

// A cell of `saved` as a fresh session shows it: its text, and what editing it starts from.
async function cellOf(saved: Uint8Array, kind: SheetFileKind, row: number, col: number, password?: string) {
	const host = inThreadSheetHost()
	let opened: SheetOpenResult = await host.open(saved.slice(), { kind }, () => undefined)

	if (opened.kind === "needsPassword" && password !== undefined) {
		const unlocked = await opened.locked.unlock(password)

		if (!unlocked.ok) throw new Error(unlocked.reason)

		opened = { kind: "opened", session: unlocked.session, info: unlocked.info }
	}

	if (opened.kind !== "opened") throw new Error(opened.kind)

	const sheet = opened.info.activeSheet
	const { tiles } = await opened.session.tiles(sheet, Uint32Array.of(0, 0))
	const tile = tiles[0]
	const position = tile?.positions.indexOf(row * 32 + col) ?? -1
	const at = (index: number | undefined) => (tile === undefined || index === undefined || index < 0 ? undefined : tile.strings[index])
	const text = position < 0 ? "" : (at(tile?.texts[position]) ?? "")
	const input = position < 0 ? "" : (at(tile?.inputs[position]) ?? text)

	host.dispose()

	return { text, input }
}

// Types `text` into the cell the name box goes to, through the formula bar, and commits it.
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

describe("the spreadsheet viewer", () => {
	it("edits a workbook through the formula bar and saves it for the overlay", async () => {
		bytes.current = await budget()

		const saveRef = createRef<(() => Promise<SpreadsheetSnapshot>) | null>() as { current: (() => Promise<SpreadsheetSnapshot>) | null }
		const dirty = vi.fn()

		render(
			<SheetViewer
				item={file("b.xlsx")}
				documentKey="k1"
				alt="b.xlsx"
				editable
				saveRef={saveRef}
				onDirtyChange={dirty}
			/>
		)

		await screen.findByRole("textbox", { name: preview.previewSpreadsheetCellContents })
		await enter("B2", "500")
		await waitFor(() => {
			expect(dirty).toHaveBeenLastCalledWith(true)
		})
		await enter("B5", "=B4*2")
		await waitFor(() => {
			expect(saveRef.current).not.toBeNull()
		})

		const snapshot = await act(() => saveRef.current?.() ?? Promise.reject(new Error("no save")))

		expect(await cellOf(snapshot.bytes, "xlsx", 1, 1)).toMatchObject({ text: "500" })
		expect(await cellOf(snapshot.bytes, "xlsx", 3, 1)).toMatchObject({ text: "800" })
		expect(await cellOf(snapshot.bytes, "xlsx", 4, 1)).toEqual({ text: "1600", input: "=B4*2" })

		act(() => {
			snapshot.commit()
		})
		await waitFor(() => {
			expect(dirty).toHaveBeenLastCalledWith(false)
		})
	})

	it("opens a password-protected workbook with its password and saves it sealed", async () => {
		bytes.current = await encryptedWorkbook("agile")

		const saveRef = { current: null as (() => Promise<SpreadsheetSnapshot>) | null }

		render(
			<SheetViewer
				item={file("locked.xlsx")}
				documentKey="k2"
				alt="locked.xlsx"
				editable
				saveRef={saveRef}
			/>
		)

		const field = await screen.findByLabelText(preview.previewDocxPasswordLabel, {}, { timeout: 20_000 })

		fireEvent.change(field, { target: { value: "wrong" } })
		fireEvent.click(screen.getByRole("button", { name: preview.previewDocxPasswordSubmit }))
		await screen.findByText(preview.previewDocxPasswordWrong, {}, { timeout: 20_000 })

		fireEvent.change(field, { target: { value: WORKBOOK_PASSWORD } })
		fireEvent.click(screen.getByRole("button", { name: preview.previewDocxPasswordSubmit }))
		await screen.findByRole("button", { name: preview.previewDocxPasswordProtected }, { timeout: 20_000 })

		await enter("A2", "Sealed edit")
		await waitFor(() => {
			expect(saveRef.current).not.toBeNull()
		})

		const snapshot = await act(() => saveRef.current?.() ?? Promise.reject(new Error("no save")))

		expect(isSealedOfficeFile(snapshot.bytes)).toBe(true)
		expect(await cellOf(snapshot.bytes, "xlsx", 1, 0, WORKBOOK_PASSWORD)).toMatchObject({ text: "Sealed edit" })
	}, 60_000)

	it("keeps a file whose name is not a spreadsheet's read-only, saying why", async () => {
		// This realm's array: jsdom's TextEncoder answers in its own.
		bytes.current = Uint8Array.from(new TextEncoder().encode("a,b\r\n1,2\r\n"))

		const saveRef = { current: null as (() => Promise<SpreadsheetSnapshot>) | null }

		render(
			<SheetViewer
				item={file("data.bin")}
				documentKey="k3"
				alt="data.bin"
				editable
				saveRef={saveRef}
			/>
		)

		await screen.findByText(preview.previewSpreadsheetReadOnlyUnnamed)
		expect(screen.queryByRole("textbox", { name: preview.previewSpreadsheetCellContents })).toBeNull()
		expect(saveRef.current).toBeNull()
	})
})
