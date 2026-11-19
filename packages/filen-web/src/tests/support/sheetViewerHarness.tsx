import { expect, vi } from "vitest"
import type { ReactElement } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { inThreadSheetHost } from "@filen/office/dom/sheet"
import type { DriveItem } from "@/features/drive/lib/item"
import { preview } from "@/locales/en/preview"

// The spreadsheet viewer over a real session on this thread (the in-thread host stands in for the workers). vi.mock is
// hoisted per file, so each test file keeps its own vi.mock calls and delegates the bodies here through an awaited
// import, composing them with the mocks only it needs:
//
//   vi.mock("@/features/spreadsheet/lib/sheetHosts", async importOriginal =>
//       (await import("@/tests/support/sheetViewerHarness")).sheetHostsMock(await importOriginal<object>()))
//
// The viewer itself is imported only once a test opens it, after every mock applies.

// The bytes the mocked preview hook hands the viewer.
export const sheetBytes: { current: Uint8Array } = { current: new Uint8Array(0) }

export function themeProviderMock(actual: object, theme: () => "light" | "dark" = () => "light"): object {
	return { ...actual, useTheme: () => ({ theme: theme() }) }
}

export function previewBytesMock(): object {
	return { usePreviewBytes: () => ({ status: "success", bytes: sheetBytes.current, refetch: () => undefined }) }
}

// One in-thread host for the file, opening every workbook the viewer asks for.
export function sheetHostsMock(actual: object): object {
	const host = inThreadSheetHost()

	return {
		...actual,
		openSheet: (source: Uint8Array, options: Parameters<typeof host.open>[1], onEvent: Parameters<typeof host.open>[2]) =>
			host.open(source, options, onEvent)
	}
}

// jsdom draws no canvas: the grid sees no context. For each test's beforeEach (restoreMocks undoes the spy).
export function stubSheetCanvas(): void {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
}

export function file(name: string): DriveItem {
	return { type: "file", data: { uuid: `u-${name}`, decryptedMeta: { name }, size: 1n } } as unknown as DriveItem
}

// Open the viewer, editable, over a workbook's bytes; resolves with the grid once the formula bar is up.
export async function openViewer(
	source: Uint8Array,
	{
		name = "book.xlsx",
		documentKey = name,
		wrap = viewer => viewer
	}: { name?: string; documentKey?: string; wrap?: (viewer: ReactElement) => ReactElement } = {}
): Promise<HTMLElement> {
	const { SheetViewer } = await import("@/features/spreadsheet/sheetViewer")

	sheetBytes.current = source

	render(
		wrap(
			<SheetViewer
				item={file(name)}
				documentKey={documentKey}
				alt={name}
				editable
				saveRef={{ current: null }}
			/>
		)
	)

	await screen.findByRole("textbox", { name: preview.previewSpreadsheetCellContents })

	return await screen.findByRole("grid", {}, { timeout: 5000 })
}

export function nameBox(): string {
	return screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSheetNameBox }).value
}

// Go to a reference through the name box. The box then shows the active cell: a range's top left.
export async function goTo(reference: string): Promise<void> {
	const box = screen.getByRole<HTMLInputElement>("textbox", { name: preview.previewSheetNameBox })

	fireEvent.focus(box)
	fireEvent.change(box, { target: { value: reference } })
	fireEvent.keyDown(box, { key: "Enter" })
	await waitFor(() => {
		expect(nameBox()).toBe(reference.split(":")[0])
	})
}

// The formula bar.
export function bar(): HTMLTextAreaElement {
	return screen.getByRole<HTMLTextAreaElement>("textbox", { name: preview.previewSpreadsheetCellContents })
}

// Type into the formula bar without committing.
export async function typeInBar(text: string): Promise<HTMLTextAreaElement> {
	const input = bar()

	await act(async () => {
		input.focus()
		await Promise.resolve()
	})
	fireEvent.input(input, { target: { value: text } })

	return input
}
