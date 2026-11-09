import { isPdfCommandEnabled, PDF_BASE_SCALE, type PdfViewerCommand, type PdfViewerState } from "@filen/office/dom/pdf"
import { matchesCombo } from "@/features/presentation/lib/keymap/editor"
import { PDF_VIEWER_ACTIONS, type PdfViewerAction } from "@/features/preview/lib/keymap"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"

type KeyEvent = Parameters<typeof matchesCombo>[0]

// The PDF viewer action a keydown is, under `overrides` (the user's combos by action id). Matched by the key's
// character, as the browser's own page zoom is, so the layout that puts "+" elsewhere still zooms the document.
export function pdfViewerKey(
	event: KeyEvent,
	overrides: Readonly<Record<string, string>>,
	mac: boolean = isMacPlatform()
): PdfViewerAction | undefined {
	return PDF_VIEWER_ACTIONS.find(action => matchesCombo(event, overrides[action.id] ?? action.defaultCombo, mac))?.id
}

// The command an action runs in `state`, or null when it cannot run (zoom at its limit): the key is still the
// viewer's, so the browser does not zoom the page in its place.
export function pdfViewerKeyCommand(action: PdfViewerAction, state: PdfViewerState): PdfViewerCommand | null {
	let command: PdfViewerCommand

	switch (action) {
		case "preview.pdfZoomIn":
			command = { type: "zoom.in" }
			break
		case "preview.pdfZoomOut":
			command = { type: "zoom.out" }
			break
		case "preview.pdfZoomReset":
			command = { type: "zoom.set", scale: PDF_BASE_SCALE }
			break
		case "preview.pdfToggleFit":
			command = { type: state.zoomMode === "fitWidth" ? "zoom.fitPage" : "zoom.fitWidth" }
			break
		case "preview.pdfRotateCw":
			command = { type: "rotate.clockwise" }
			break
		case "preview.pdfRotateCcw":
			command = { type: "rotate.counterClockwise" }
			break
	}

	return isPdfCommandEnabled(state, command.type) ? command : null
}
