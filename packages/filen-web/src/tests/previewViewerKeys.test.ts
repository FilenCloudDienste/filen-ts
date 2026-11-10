import { describe, expect, it } from "vitest"
import { PDF_BASE_SCALE, type PdfViewerState } from "@filen/office/dom/pdf"
import { isPdfHostAction, pdfViewerKey, pdfViewerKeyCommand } from "@/features/preview/lib/pdfKeys.logic"
import { imageKeyTransform, imageViewerKey } from "@/features/preview/lib/imageViewerKeys.logic"
import { codeViewKey, codeViewSettingsChange, stepFontSize } from "@/features/preview/lib/codeViewKeys.logic"
import { imageEditorKey, imageOverlayKey } from "@/features/preview/imageEdit/lib/keys"
import { IMAGE_EDITOR_ACTIONS, PREVIEW_ACTIONS } from "@/features/preview/lib/keymap"
import { CODE_DEFAULT_FONT_SIZE } from "@/features/preview/lib/codeViewSettings"

// The viewers' and the code editor's keys: each resolves its default, follows the user's binding, and holds its guard
// (the pan keys only while zoomed in, a turned-off key never matches).

function key(change: { key: string; code: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }) {
	return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...change }
}

// The combos in effect off a Mac in a browser, as the registry resolves them for the defaults.
function defaults(): Record<string, string> {
	const combos: Record<string, string> = {}

	for (const def of PREVIEW_ACTIONS) {
		combos[def.id] = def.platformDefaults?.find(({ on }) => on.mac === false && on.desktop !== true)?.combo ?? def.defaultCombo
	}

	return combos
}

const COMBOS = defaults()

describe("the PDF viewer's page keys", () => {
	it("pages with N and P off a Mac in a browser, which keeps Ctrl+Page Up/Down for its tabs", () => {
		expect(pdfViewerKey(key({ key: "n", code: "KeyN" }), COMBOS, false)).toBe("preview.pdfNextPage")
		expect(pdfViewerKey(key({ key: "p", code: "KeyP" }), COMBOS, false)).toBe("preview.pdfPreviousPage")
		expect(pdfViewerKey(key({ key: "PageDown", code: "PageDown", ctrlKey: true }), COMBOS, false)).toBeUndefined()
		// The shipped default elsewhere (a Mac, the desktop app) adds Mod+Page Down/Up.
		expect(pdfViewerKey(key({ key: "PageDown", code: "PageDown", metaKey: true }), {}, true)).toBe("preview.pdfNextPage")
		expect(pdfViewerKey(key({ key: "Home", code: "Home", ctrlKey: true }), COMBOS, false)).toBe("preview.pdfFirstPage")
		expect(pdfViewerKey(key({ key: "End", code: "End", ctrlKey: true }), COMBOS, false)).toBe("preview.pdfLastPage")
	})

	it("runs the page commands, none past the last page", () => {
		const state = { page: 3, pageCount: 3, scale: PDF_BASE_SCALE, zoomMode: "custom" } as PdfViewerState

		expect(pdfViewerKeyCommand("preview.pdfPreviousPage", state)).toEqual({ type: "page.previous" })
		expect(pdfViewerKeyCommand("preview.pdfFirstPage", state)).toEqual({ type: "page.first" })
		expect(pdfViewerKeyCommand("preview.pdfNextPage", state)).toBeNull()
		expect(pdfViewerKeyCommand("preview.pdfFitPage", state)).toEqual({ type: "zoom.fitPage" })
	})

	it("hands go to page, full screen and properties to the host; fit and properties ship unbound", () => {
		expect(pdfViewerKey(key({ key: "g", code: "KeyG", ctrlKey: true, altKey: true }), COMBOS, false)).toBe("preview.pdfGoToPage")
		expect(pdfViewerKey(key({ key: "f", code: "KeyF" }), COMBOS, false)).toBe("preview.pdfFullScreen")
		expect(isPdfHostAction("preview.pdfGoToPage")).toBe(true)
		expect(isPdfHostAction("preview.pdfNextPage")).toBe(false)
		expect(COMBOS["preview.pdfFitWidth"]).toBe("")
		expect(pdfViewerKey(key({ key: "w", code: "KeyW" }), { ...COMBOS, "preview.pdfFitWidth": "w" }, false)).toBe("preview.pdfFitWidth")
	})
})

describe("the image viewer's keys", () => {
	const container = { width: 1000, height: 500 }
	const natural = { width: 4000, height: 2000 }

	it("zooms on the PDF viewer's keys and fits on Mod+0", () => {
		expect(imageViewerKey(key({ key: "=", code: "Equal", ctrlKey: true }), COMBOS, false, false)).toBe("preview.imageZoomIn")
		expect(imageViewerKey(key({ key: "-", code: "Minus", ctrlKey: true }), COMBOS, false, false)).toBe("preview.imageZoomOut")
		expect(imageViewerKey(key({ key: "0", code: "Digit0", ctrlKey: true }), COMBOS, false, false)).toBe("preview.imageZoomFit")
		expect(imageViewerKey(key({ key: "1", code: "Digit1" }), COMBOS, false, false)).toBe("preview.imageActualSize")
	})

	it("pans with the arrows only while zoomed in, leaving them to the pager at fit", () => {
		const right = key({ key: "ArrowRight", code: "ArrowRight" })

		expect(imageViewerKey(right, COMBOS, false, false)).toBeUndefined()
		expect(imageViewerKey(right, COMBOS, true, false)).toBe("preview.imagePanRight")
	})

	it("zooms about the centre, shows actual size and fits again", () => {
		const fit = { scale: 1, x: 0, y: 0 }
		const zoomed = imageKeyTransform("preview.imageZoomIn", fit, container, natural)

		expect(zoomed.scale).toBeCloseTo(1.25)
		// The fitted image is 1000 × 500, a quarter of its pixels: actual size is 4×.
		expect(imageKeyTransform("preview.imageActualSize", fit, container, natural).scale).toBe(4)
		expect(imageKeyTransform("preview.imageZoomFit", zoomed, container, natural)).toEqual(fit)
		// Zoomed out to fit or below, the pan resets.
		expect(imageKeyTransform("preview.imageZoomOut", { scale: 1.25, x: 20, y: 0 }, container, natural)).toEqual({
			scale: 1,
			x: 0,
			y: 0
		})
	})

	it("scrolls a zoomed image within its edges", () => {
		const at = { scale: 2, x: 0, y: 0 }

		expect(imageKeyTransform("preview.imagePanRight", at, container, natural)).toEqual({ scale: 2, x: -100, y: 0 })
		// At 2× the image overhangs 500 px each side; a step never passes the edge.
		expect(imageKeyTransform("preview.imagePanLeft", { scale: 2, x: 480, y: 0 }, container, natural).x).toBe(500)
	})
})

describe("the code viewers' view keys", () => {
	const settings = { wrap: true, lineNumbers: true, fontSize: CODE_DEFAULT_FONT_SIZE }

	it("toggles word wrap on Alt+Z and sizes the text on the zoom keys", () => {
		expect(codeViewKey(key({ key: "z", code: "KeyZ", altKey: true }), COMBOS, false)).toBe("editor.toggleWordWrap")
		expect(codeViewKey(key({ key: "=", code: "Equal", ctrlKey: true }), COMBOS, false)).toBe("editor.fontSizeIncrease")
		// The browser's zoom key by character: a German keyboard's "+" is the US "]".
		expect(codeViewKey(key({ key: "+", code: "BracketRight", ctrlKey: true }), COMBOS, false)).toBe("editor.fontSizeIncrease")
		expect(codeViewKey(key({ key: "0", code: "Digit0", ctrlKey: true }), COMBOS, false)).toBe("editor.fontSizeReset")
		// Turned off, the zoom key is the browser's again.
		expect(
			codeViewKey(key({ key: "=", code: "Equal", ctrlKey: true }), { ...COMBOS, "editor.fontSizeIncrease": "" }, false)
		).toBeUndefined()
	})

	it("steps the font size along the menu's sizes and changes the settings", () => {
		expect(stepFontSize(13, 1)).toBe(14)
		expect(stepFontSize(13, -1)).toBe(12)
		expect(stepFontSize(24, 1)).toBe(24)
		expect(stepFontSize(11, -1)).toBe(11)
		expect(codeViewSettingsChange("editor.toggleWordWrap", settings)).toEqual({ wrap: false })
		expect(codeViewSettingsChange("editor.fontSizeReset", { ...settings, fontSize: 20 })).toEqual({ fontSize: CODE_DEFAULT_FONT_SIZE })
		expect(codeViewSettingsChange("editor.viewChanges", settings)).toBeNull()
	})
})

describe("the image editor's keys", () => {
	const combos: Record<string, string> = Object.fromEntries(IMAGE_EDITOR_ACTIONS.map(def => [def.id, def.defaultCombo]))

	it("resolves the editor's own keys and the overlay's save as copy and cancel apart", () => {
		expect(imageEditorKey(key({ key: "z", code: "KeyZ", ctrlKey: true }), combos, false)).toBe("preview.imageUndo")
		expect(imageEditorKey(key({ key: "3", code: "Digit3" }), combos, false)).toBe("preview.imageTabFilters")
		expect(imageEditorKey(key({ key: "]", code: "BracketRight", ctrlKey: true }), combos, false)).toBe("preview.imageRotateRight")
		expect(imageEditorKey(key({ key: "\\", code: "Backslash" }), combos, false)).toBe("preview.imageCompare")
		expect(imageEditorKey(key({ key: "Escape", code: "Escape" }), combos, false)).toBeUndefined()
		expect(imageOverlayKey(key({ key: "Escape", code: "Escape" }), combos, false)).toBe("preview.imageCancel")
		expect(imageOverlayKey(key({ key: "S", code: "KeyS", ctrlKey: true, shiftKey: true }), combos, false)).toBe("preview.imageSaveCopy")
	})

	it("ships flips, resets and the markup tools unbound, and follows a binding", () => {
		expect(combos["preview.imageFlipHorizontal"]).toBe("")
		expect(imageEditorKey(key({ key: "h", code: "KeyH" }), combos, false)).toBeUndefined()
		expect(imageEditorKey(key({ key: "h", code: "KeyH" }), { ...combos, "preview.imageFlipHorizontal": "h" }, false)).toBe(
			"preview.imageFlipHorizontal"
		)
	})
})
