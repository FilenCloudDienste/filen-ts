import { describe, expect, it } from "vitest"
import { PDF_BASE_SCALE, PDF_MAX_SCALE, type PdfViewerState } from "@filen/office/dom/pdf"
import { pdfViewerKey, pdfViewerKeyCommand } from "@/features/preview/lib/pdfKeys.logic"

// The PDF viewer's keys on Mac and elsewhere, by the key's character, and the command each runs.

function key(change: { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }) {
	return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...change }
}

function state(change: Partial<PdfViewerState>): PdfViewerState {
	return { scale: PDF_BASE_SCALE, zoomMode: "custom", ...change } as PdfViewerState
}

describe("pdfViewerKey", () => {
	it("zooms in on Mod+Plus wherever the layout puts it", () => {
		expect(pdfViewerKey(key({ key: "=", ctrlKey: true }), {}, false)).toBe("preview.pdfZoomIn")
		expect(pdfViewerKey(key({ key: "+", ctrlKey: true, shiftKey: true }), {}, false)).toBe("preview.pdfZoomIn")
		// The numpad's, and a German keyboard's own key.
		expect(pdfViewerKey(key({ key: "+", code: "BracketRight", ctrlKey: true }), {}, false)).toBe("preview.pdfZoomIn")
		expect(pdfViewerKey(key({ key: "=", metaKey: true }), {}, true)).toBe("preview.pdfZoomIn")
	})

	it("zooms out, resets, toggles the fit and rotates", () => {
		expect(pdfViewerKey(key({ key: "-", ctrlKey: true }), {}, false)).toBe("preview.pdfZoomOut")
		expect(pdfViewerKey(key({ key: "0", ctrlKey: true }), {}, false)).toBe("preview.pdfZoomReset")
		expect(pdfViewerKey(key({ key: "\\", metaKey: true }), {}, true)).toBe("preview.pdfToggleFit")
		expect(pdfViewerKey(key({ key: "]", ctrlKey: true }), {}, false)).toBe("preview.pdfRotateCw")
		expect(pdfViewerKey(key({ key: "[", metaKey: true }), {}, true)).toBe("preview.pdfRotateCcw")
	})

	it("needs the platform's own modifier and no other", () => {
		expect(pdfViewerKey(key({ key: "=" }), {}, false)).toBeUndefined()
		expect(pdfViewerKey(key({ key: "=", ctrlKey: true }), {}, true)).toBeUndefined()
		expect(pdfViewerKey(key({ key: "0", ctrlKey: true, altKey: true }), {}, false)).toBeUndefined()
		expect(pdfViewerKey(key({ key: "s", ctrlKey: true }), {}, false)).toBeUndefined()
	})

	it("follows the user's combo", () => {
		const overrides = { "preview.pdfRotateCw": "mod+shift+r" }

		expect(pdfViewerKey(key({ key: "]", ctrlKey: true }), overrides, false)).toBeUndefined()
		expect(pdfViewerKey(key({ key: "R", ctrlKey: true, shiftKey: true }), overrides, false)).toBe("preview.pdfRotateCw")
	})
})

describe("pdfViewerKeyCommand", () => {
	it("maps each action to the viewer's command", () => {
		expect(pdfViewerKeyCommand("preview.pdfZoomIn", state({}))).toEqual({ type: "zoom.in" })
		expect(pdfViewerKeyCommand("preview.pdfZoomOut", state({}))).toEqual({ type: "zoom.out" })
		expect(pdfViewerKeyCommand("preview.pdfZoomReset", state({ scale: 3 }))).toEqual({ type: "zoom.set", scale: PDF_BASE_SCALE })
		expect(pdfViewerKeyCommand("preview.pdfRotateCw", state({}))).toEqual({ type: "rotate.clockwise" })
		expect(pdfViewerKeyCommand("preview.pdfRotateCcw", state({}))).toEqual({ type: "rotate.counterClockwise" })
	})

	it("toggles between fit to width and fit to page", () => {
		expect(pdfViewerKeyCommand("preview.pdfToggleFit", state({ zoomMode: "custom" }))).toEqual({ type: "zoom.fitWidth" })
		expect(pdfViewerKeyCommand("preview.pdfToggleFit", state({ zoomMode: "fitPage" }))).toEqual({ type: "zoom.fitWidth" })
		expect(pdfViewerKeyCommand("preview.pdfToggleFit", state({ zoomMode: "fitWidth" }))).toEqual({ type: "zoom.fitPage" })
	})

	it("runs nothing at a zoom limit", () => {
		expect(pdfViewerKeyCommand("preview.pdfZoomIn", state({ scale: PDF_MAX_SCALE }))).toBeNull()
	})
})
