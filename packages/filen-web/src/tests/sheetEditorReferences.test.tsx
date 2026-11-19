// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { flushSync } from "react-dom"
import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { writeXlsx } from "hucre/xlsx"
import { highlightedReferences } from "@filen/office/core/sheet"
import type { GridCanvas, GridPaintScene } from "@filen/office/react/sheet"
import { REFERENCE_COLORS, referenceColors } from "@/features/spreadsheet/formulaBar/referenceColors"
import { referenceLayer } from "@/features/spreadsheet/formulaBar/referenceLayer"
import { registerAllActions } from "@/lib/keymap/actions"
import { preview } from "@/locales/en/preview"
import { openViewer as openSheetViewer, stubSheetCanvas } from "@/tests/support/sheetViewerHarness"

// A formula typed in the cell shows its references in the colours the formula bar shows them in and the grid outlines
// them in, drawn under the editor's clear text and following its scroll; other entries stay plain.

const { theme } = vi.hoisted(() => {
	const scheme: { current: "light" | "dark" } = { current: "light" }

	return { theme: scheme }
})

vi.mock("@/providers/themeProvider", async importOriginal =>
	(await import("@/tests/support/sheetViewerHarness")).themeProviderMock(await importOriginal<object>(), () => theme.current)
)

vi.mock("@/features/preview/hooks/usePreviewBytes", async () => (await import("@/tests/support/sheetViewerHarness")).previewBytesMock())

vi.mock("@/features/spreadsheet/lib/sheetHosts", async importOriginal =>
	(await import("@/tests/support/sheetViewerHarness")).sheetHostsMock(await importOriginal<object>())
)

registerAllActions()

beforeEach(() => {
	stubSheetCanvas()
	theme.current = "light"
	vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
		return [
			{ left: this.startOffset * ADVANCE, top: 0, width: (this.endOffset - this.startOffset) * ADVANCE, height: 20 }
		] as unknown as DOMRectList
	})
})

async function openViewer(): Promise<HTMLElement> {
	return await openSheetViewer(await writeXlsx({ sheets: [{ name: "Data", rows: [["Amount"], [1], [2]] }] }), {
		name: "refs.xlsx",
		documentKey: "refs"
	})
}

// Opens the in-cell editor on the active cell and types `text` into it.
async function typeInCell(text: string): Promise<HTMLTextAreaElement> {
	const grid = await openViewer()

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

	return editor
}

// A colour as the DOM gives it back from a style.
function computed(color: string): string {
	const probe = document.createElement("span")

	probe.style.color = color

	return probe.style.color
}

// A reference's box as laid out: 7px a character on one line (jsdom lays nothing out).
const ADVANCE = 7

// The coloured text under an editor: its text, and the colour layers clipped to its glyphs, each with where it sits
// (the references' first, the rest of the text's last).
function colored(backdrop: Element | null): { text: string | null; layers: string[] } {
	const text = [...(backdrop?.querySelectorAll("div") ?? [])].find(element => element.style.backgroundImage !== "")

	if (text === undefined) return { text: null, layers: [] }

	const images = [...text.style.backgroundImage.matchAll(/linear-gradient\((rgb\([^)]*\)|[a-z]+),/g)].map(match => match[1] ?? "")
	const positions = text.style.backgroundPosition.split(", ")
	const sizes = text.style.backgroundSize.split(", ")

	return {
		text: text.textContent,
		layers: images.map((image, index) => `${image} at ${positions[index] ?? ""} size ${sizes[index] ?? ""}`)
	}
}

function at(start: number, end: number): string {
	return `${String(start * ADVANCE)}px 0px size ${String((end - start) * ADVANCE)}px 20px`
}

// The edge colour the grid outlines each of `text`'s references in, in the order they appear.
function outlines(text: string, colors: readonly string[]): string[] {
	const strokes: string[] = []
	const canvas = {
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 1,
		fillRect: () => undefined,
		beginPath: () => undefined,
		rect: () => undefined,
		stroke() {
			strokes.push(computed(this.strokeStyle))
		}
	}
	const scene = { rangeRects: () => [{ x: 0, y: 0, width: 10, height: 10 }] }

	for (const reference of highlightedReferences(text, REFERENCE_COLORS))
		referenceLayer({ references: [reference], ownSheet: "Data", shownSheet: "Data", colors }).paint(
			canvas as unknown as GridCanvas,
			scene as unknown as GridPaintScene
		)

	return strokes
}

describe("references typed in the cell", () => {
	for (const scheme of ["light", "dark"] as const)
		it(`are coloured as in the formula bar and on the grid (${scheme})`, async () => {
			theme.current = scheme

			const text = "=A1+SUM(B2:C3)*a1"
			const editor = await typeInCell(text)
			const backdrop = document.querySelector(".fo-sheet-editor-backdrop")
			const colors = referenceColors(scheme === "dark")
			const outlined = outlines(text, colors)

			expect(backdrop?.textContent).toBe(editor.value)
			expect(colored(backdrop)).toEqual({
				text,
				layers: [
					`${outlined[0] ?? ""} at ${at(1, 3)}`,
					`${outlined[1] ?? ""} at ${at(8, 13)}`,
					`${outlined[2] ?? ""} at ${at(15, 17)}`,
					"currentcolor at 0px 0px size 100% 100%"
				]
			})
			expect(outlined[0]).toBe(outlined[2])
			expect(outlined[0]).not.toBe(outlined[1])
			// The formula bar draws the same.
			expect(colored(screen.getByRole("textbox", { name: preview.previewSpreadsheetCellContents }).parentElement)).toEqual(
				colored(backdrop)
			)
			expect(editor.parentElement?.hasAttribute("data-colored")).toBe(true)
		})

	it("follow the editor's scroll", async () => {
		const editor = await typeInCell(`=A1+${"B2+".repeat(60)}C3`)

		editor.scrollLeft = 90
		fireEvent.scroll(editor)

		expect((document.querySelector(".fo-sheet-editor-backdrop")?.firstElementChild as HTMLElement).style.transform).toBe(
			"translate(-90px, 0px)"
		)
	})

	it("leave an entry that is not a formula plain", async () => {
		const editor = await typeInCell("A1 and B2")

		expect(document.querySelector(".fo-sheet-editor-backdrop")).toBeNull()
		expect(editor.parentElement?.hasAttribute("data-colored")).toBe(false)
	})
})

describe("typing in the cell", () => {
	// A browser runs microtasks between an input event's listeners, so an update another listener queued as the
	// input arrived commits before the editor reads the input; flushSync stands in for that checkpoint here.
	it("keeps each character typed after the one that opened the entry, the view rendering as the input arrives", async () => {
		const grid = await openViewer()

		await act(async () => {
			grid.focus()
			await Promise.resolve()
		})
		fireEvent.keyDown(grid, { key: "=" })

		const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: preview.previewSheetCellEditor })
		const checkpoint = (): void => {
			flushSync(() => undefined)
		}

		document.addEventListener("input", checkpoint, true)

		try {
			for (const text of ["=B", "=B2", "=B2+", "=B2+C", "=B2+C3"]) {
				editor.setSelectionRange(editor.value.length, editor.value.length)
				fireEvent.input(editor, { target: { value: text } })
			}
		} finally {
			document.removeEventListener("input", checkpoint, true)
		}

		await waitFor(() => {
			expect(editor.value).toBe("=B2+C3")
		})
	})
})
