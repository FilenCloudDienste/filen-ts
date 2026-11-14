import { PenLineIcon } from "lucide-react"
import { DrawOverlay } from "@/features/pdf/annotations/annotationOverlays"
import { placingKey } from "@/features/pdf/annotations/annotationKeys"
import { pdfToolAction } from "@/features/pdf/lib/toolKeys"
import { toolEnabled, type PdfTool } from "@/features/pdf/tools/registry"

// Home › Draw (D): freehand ink, smoothed when each stroke ends. A page's strokes join one drawing while nothing else
// changes the document, each stroke its own undo step; pen pressure is ignored, touch draws (no scrolling meanwhile).

export const DRAW_TOOL: PdfTool = {
	id: "annotations.draw",
	ribbon: { tab: "home", group: "annotate", order: 300 },
	labelKey: "previewPdfAnnotToolDraw",
	icon: PenLineIcon,
	toolClass: "annotate",
	actionIds: ["annotations.draw"],
	actions: [pdfToolAction("annotations.draw", "d", "preview:previewPdfKeyToolDraw")],
	enabledWhen: policy => toolEnabled("annotate", policy),
	commands: ["annotations.ink", "annotations.inkStroke"],
	onKey: placingKey,
	Overlay: DrawOverlay
}
