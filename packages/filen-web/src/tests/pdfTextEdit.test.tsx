// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
	})
}))

vi.mock("@/lib/keymap/kbd.logic", () => ({ isMacPlatform: () => false }))

const { PdfTextEditor } = await import("@/features/pdf/textEdit/pdfTextEditor")
const { PdfTextEditNotice } = await import("@/features/pdf/textEdit/pdfTextEditNotice")
const { cssColor, editorFontFamily, editorKey, editorPlacement, textRows } = await import("@/features/pdf/textEdit/textEdit.logic")
type Source = import("@/features/pdf/textEdit/textEdit.logic").TextEditorSource

function source(overrides: Partial<Source> = {}): Source {
	return {
		text: "Hello world",
		frame: { origin: [72, 120], direction: [1, 0], width: null, lineHeight: 14.4 },
		bounds: [72, 109, 190, 125],
		angle: 0,
		size: 12,
		color: 0x336699,
		font: { family: "tinos", label: "Tinos", bold: true, italic: false, substitute: true, original: "Garamond" },
		...overrides
	}
}

const KEY = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, sinceCompositionEnd: Infinity }

describe("text editor geometry and keys", () => {
	it("places the box over the first line at the page's zoom", () => {
		const placement = editorPlacement(source(), 2)

		expect(placement.left).toBeCloseTo(144)
		expect(placement.top).toBeCloseTo((120 - 0.9 * 12) * 2)
		expect(placement.width).toBeCloseTo(118 * 2 + 4)
		expect(placement.fontSize).toBe(24)
		expect(placement.lineHeight).toBeCloseTo(28.8)
		expect(placement.angle).toBe(0)
	})

	it("uses the frame's width and grows with the lines", () => {
		const placement = editorPlacement(
			source({ text: "a\nb\nc", frame: { origin: [72, 120], direction: [1, 0], width: 200, lineHeight: 14 } }),
			1
		)

		expect(placement.width).toBe(204)
		expect(placement.height).toBeCloseTo(12 * 1.2 + 28)
	})

	it("turns with a rotated baseline about the first line's top-left", () => {
		const placement = editorPlacement(
			source({
				frame: { origin: [100, 100], direction: [0, 1], width: null, lineHeight: 14 },
				bounds: [90, 100, 100, 160],
				angle: 90
			}),
			1
		)

		expect(placement.left).toBeCloseTo(100 + 0.9 * 12)
		expect(placement.top).toBeCloseTo(100)
		expect(placement.width).toBeCloseTo(64)
		expect(placement.angle).toBe(90)
	})

	it("cancels on Escape, finishes on Mod+Enter, and leaves composition keys alone", () => {
		expect(editorKey({ ...KEY, key: "Escape" }, false)).toBe("cancel")
		expect(editorKey({ ...KEY, key: "Enter", ctrlKey: true }, false)).toBe("done")
		expect(editorKey({ ...KEY, key: "Enter", metaKey: true }, true)).toBe("done")
		expect(editorKey({ ...KEY, key: "Enter", metaKey: true }, false)).toBeNull()
		expect(editorKey({ ...KEY, key: "Enter" }, false)).toBeNull()
		expect(editorKey({ ...KEY, key: "Enter", ctrlKey: true, isComposing: true }, false)).toBeNull()
		expect(editorKey({ ...KEY, key: "Escape", sinceCompositionEnd: 5 }, false)).toBeNull()
		expect(editorKey({ ...KEY, key: "Escape", sinceCompositionEnd: 500 }, false)).toBe("cancel")
	})

	it("formats colours, fonts and rows", () => {
		expect(cssColor(0x00ff0a)).toBe("#00ff0a")
		expect(editorFontFamily("cousine", "Cousine")).toBe('"Cousine", monospace')
		expect(textRows("")).toBe(1)
		expect(textRows("a\nb")).toBe(2)
	})
})

describe("PdfTextEditor", () => {
	it("shows the font chip with the substitute mark and explains it", () => {
		render(
			<PdfTextEditor
				source={source()}
				scale={1}
				onDone={() => undefined}
				onCancel={() => undefined}
			/>
		)

		expect(screen.getByText(/previewPdfTextEditFontChip \{"font":"Tinos"\} previewPdfTextEditSubstituteMark/u)).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "previewPdfTextEditFontInfo" }))
		expect(screen.getByText('previewPdfTextEditSubstitute {"font":"Tinos"}')).toBeTruthy()
	})

	it("has no substitute mark or explanation for the original's own widths", () => {
		render(
			<PdfTextEditor
				source={source({
					font: { family: "arimo", label: "Arimo", bold: false, italic: false, substitute: false, original: "Arial" }
				})}
				scale={1}
				onDone={() => undefined}
				onCancel={() => undefined}
			/>
		)

		expect(screen.queryByText(/previewPdfTextEditSubstituteMark/u)).toBeNull()
		expect(screen.queryByRole("button", { name: "previewPdfTextEditFontInfo" })).toBeNull()
	})

	it("hands over the edited text on Done and on Mod+Enter, not during composition", () => {
		const onDone = vi.fn()

		render(
			<PdfTextEditor
				source={source()}
				scale={1}
				onDone={onDone}
				onCancel={() => undefined}
			/>
		)

		const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "previewPdfTextEditField" })

		expect(field.value).toBe("Hello world")
		expect(document.activeElement).toBe(field)
		expect(field.style.color).toBe("rgb(51, 102, 153)")
		expect(field.style.fontWeight).toBe("700")

		fireEvent.change(field, { target: { value: "Hello there\nfriend" } })
		fireEvent.input(field)
		expect(field.rows).toBe(2)

		fireEvent.keyDown(field, { key: "Enter", ctrlKey: true, isComposing: true })
		expect(onDone).not.toHaveBeenCalled()

		fireEvent.keyDown(field, { key: "Enter", ctrlKey: true })
		expect(onDone).toHaveBeenLastCalledWith("Hello there\nfriend")

		// Safari: the key ending a composition arrives just after compositionend, no longer composing.
		fireEvent.compositionEnd(field)
		fireEvent.keyDown(field, { key: "Enter", ctrlKey: true })
		expect(onDone).toHaveBeenCalledTimes(1)

		fireEvent.click(screen.getByRole("button", { name: "previewPdfTextEditDone" }))
		expect(onDone).toHaveBeenCalledTimes(2)
	})

	it("cancels on Escape without letting the key reach the viewer", () => {
		const onCancel = vi.fn()
		const outer = vi.fn()

		render(
			<div onKeyDown={outer}>
				<PdfTextEditor
					source={source()}
					scale={1}
					onDone={() => undefined}
					onCancel={onCancel}
				/>
			</div>
		)

		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" })
		expect(onCancel).toHaveBeenCalledTimes(1)
		expect(outer).not.toHaveBeenCalled()
	})

	it("is read-only and shows progress while the edit applies", () => {
		const onDone = vi.fn()

		render(
			<PdfTextEditor
				source={source()}
				scale={1}
				busy
				onDone={onDone}
				onCancel={() => undefined}
			/>
		)

		expect(screen.getByRole<HTMLTextAreaElement>("textbox").readOnly).toBe(true)
		expect(screen.getByText("previewPdfTextEditApplying")).toBeTruthy()
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true })
		expect(onDone).not.toHaveBeenCalled()
	})
})

describe("PdfTextEditNotice", () => {
	it.each([
		["cantEdit", "previewPdfTextEditNotPossible"],
		["unsafe", "previewPdfTextEditUnsafe"],
		["noText", "previewPdfTextEditNoText"]
	] as const)("says %s in one line", (kind, key) => {
		const onDismiss = vi.fn()

		render(
			<PdfTextEditNotice
				kind={kind}
				onDismiss={onDismiss}
			/>
		)

		expect(screen.getByRole("status").textContent).toContain(key)
		fireEvent.click(screen.getByRole("button", { name: "previewPdfTextEditDismiss" }))
		expect(onDismiss).toHaveBeenCalledTimes(1)
	})
})
