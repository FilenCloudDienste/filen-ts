import { canZoomIn, canZoomOut, clampZoom, stepZoom } from "@filen/office/dom/docx"
import { wheelZoom } from "@/features/preview/components/docxEditorFind.logic"

// The editor's slide zoom, as PowerPoint's: fit to the window (following its size) or a zoom held while the window
// changes (1 = slide px), the document editor's steps and limits. Never saved to the file.
export type PresentationZoom = "fit" | number

// A step in or out, fit to the window, or a zoom.
export type PresentationZoomChange = "in" | "out" | "fit" | number

// The zoom after `change` from `previous`, the slide shown at `scale` (screen px per slide px; 0 while unmeasured).
// A step past a limit, or from a slide not measured yet, keeps the zoom.
export function presentationZoom(previous: PresentationZoom, scale: number, change: PresentationZoomChange): PresentationZoom {
	if (change === "fit") return "fit"

	if (typeof change === "number") return clampZoom(change)

	if (!(scale > 0) || (change === "in" ? !canZoomIn(scale) : !canZoomOut(scale))) return previous

	return stepZoom(scale, change === "in" ? 1 : -1)
}

// The zoom after one Ctrl/Cmd+wheel step (a trackpad pinch included) from the slide shown at `scale`.
export function presentationWheelZoom(previous: PresentationZoom, scale: number, deltaY: number): PresentationZoom {
	return scale > 0 ? wheelZoom(previous, scale, deltaY) : previous
}
