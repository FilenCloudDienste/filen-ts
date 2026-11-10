import { isPdfCommandEnabled, PDF_BASE_SCALE, type PdfViewerCommand, type PdfViewerState } from "@filen/office/dom/pdf"
import { matchesCombo, type ChordEvent } from "@filen/shared/keymap"
import { PDF_VIEWER_ACTIONS, type PdfViewerAction } from "@/features/preview/lib/keymap"
import { browserZoomKey, zoomKeyAction, type BrowserZoomKey } from "@/lib/keymap/browserZoom"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"

const ZOOM_ACTIONS: Readonly<Record<BrowserZoomKey, PdfViewerAction>> = {
	in: "preview.pdfZoomIn",
	out: "preview.pdfZoomOut",
	reset: "preview.pdfZoomReset"
}

// The PDF viewer action a keydown is, under `combos` (the combos in effect by action id, useBindings), by physical key as every
// shortcut is matched (@filen/shared/keymap). The browser's own zoom keys, read by character, zoom the document ahead
// of the default bindings, so no layout zooms the page in its place or hits another default there (a German keyboard's
// "+" is the US "]", rotate); a key the user bound to an action stays that action.
export function pdfViewerKey(
	event: ChordEvent,
	combos: Readonly<Record<string, string>>,
	mac: boolean = isMacPlatform()
): PdfViewerAction | undefined {
	const zoom = browserZoomKey(event, mac)

	if (zoom !== undefined) {
		return zoomKeyAction(event, PDF_VIEWER_ACTIONS, ZOOM_ACTIONS[zoom], combos, mac)
	}

	return PDF_VIEWER_ACTIONS.find(def => matchesCombo(event, combos[def.id] ?? def.defaultCombo, mac))?.id
}

// The actions the viewer's host runs, not its document: the page field, full screen, the properties dialog.
export type PdfHostAction = "preview.pdfGoToPage" | "preview.pdfFullScreen" | "preview.pdfProperties"

export function isPdfHostAction(action: PdfViewerAction): action is PdfHostAction {
	return action === "preview.pdfGoToPage" || action === "preview.pdfFullScreen" || action === "preview.pdfProperties"
}

// The command an action runs in `state`, or null when it cannot run (zoom at its limit, the last page): the key is
// still the viewer's, so the browser does not zoom or scroll the page in its place.
export function pdfViewerKeyCommand(action: Exclude<PdfViewerAction, PdfHostAction>, state: PdfViewerState): PdfViewerCommand | null {
	let command: PdfViewerCommand

	switch (action) {
		case "preview.pdfNextPage":
			command = { type: "page.next" }
			break
		case "preview.pdfPreviousPage":
			command = { type: "page.previous" }
			break
		case "preview.pdfFirstPage":
			command = { type: "page.first" }
			break
		case "preview.pdfLastPage":
			command = { type: "page.last" }
			break
		case "preview.pdfFitWidth":
			command = { type: "zoom.fitWidth" }
			break
		case "preview.pdfFitPage":
			command = { type: "zoom.fitPage" }
			break
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
