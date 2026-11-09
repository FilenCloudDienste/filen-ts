// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { writeXlsx } from "hucre/xlsx"
import { inThreadSheetHost } from "@filen/office/dom/sheet"
import type { DriveItem } from "@/features/drive/lib/item"
import { registerAllActions } from "@/lib/keymap/actions"
import { preview } from "@/locales/en/preview"

// Point mode from the keyboard, as in Excel: in a formula's entry where a reference may go, an arrow points at a cell
// and Shift+arrow widens the reference to a range; elsewhere an arrow commits the entry.

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

// Opens the in-cell editor on A1 and types `text` into it, the caret at its end.
async function typeInCell(text: string): Promise<HTMLTextAreaElement> {
	bytes.current = await writeXlsx({ sheets: [{ name: "Data", rows: [[null, 5], [1], [2]] }] })

	render(
		<SheetViewer
			item={file("point.xlsx")}
			documentKey="point"
			alt="point.xlsx"
			editable
			saveRef={{ current: null }}
		/>
	)

	const grid = await screen.findByRole("grid")

	await act(async () => {
		grid.focus()
		await Promise.resolve()
	})
	fireEvent.keyDown(grid, { key: "=" })

	const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: preview.previewSheetCellEditor })

	fireEvent.change(editor, { target: { value: text } })
	await waitFor(() => {
		expect(editor.value).toBe(text)
	})
	editor.setSelectionRange(text.length, text.length)

	return editor
}

function cellEditor(): HTMLTextAreaElement | null {
	return screen.queryByRole<HTMLTextAreaElement>("textbox", { name: preview.previewSheetCellEditor })
}

describe("arrows in a formula's entry", () => {
	it("point at the cells next to the edited one, Shift widening the reference to a range", async () => {
		const editor = await typeInCell("=SUM(")

		fireEvent.keyDown(editor, { key: "ArrowDown" })
		expect(editor.value).toBe("=SUM(A2")

		fireEvent.keyDown(editor, { key: "ArrowDown" })
		expect(editor.value).toBe("=SUM(A3")

		fireEvent.keyDown(editor, { key: "ArrowUp", shiftKey: true })
		expect(editor.value).toBe("=SUM(A2:A3")

		fireEvent.keyDown(editor, { key: "ArrowRight", shiftKey: true })
		expect(editor.value).toBe("=SUM(A2:B3")
		expect(cellEditor()).toBe(editor)

		// Typed on after it, the reference stays; a new one goes after the separator.
		fireEvent.change(editor, { target: { value: "=SUM(A2:B3," } })
		editor.setSelectionRange(editor.value.length, editor.value.length)
		fireEvent.keyDown(editor, { key: "ArrowRight" })
		expect(editor.value).toBe("=SUM(A2:B3,B1")
	})

	it("commit the entry where no reference may go", async () => {
		const editor = await typeInCell("=12")

		fireEvent.keyDown(editor, { key: "ArrowDown" })

		await waitFor(() => {
			expect(cellEditor()).toBeNull()
		})
	})
})
