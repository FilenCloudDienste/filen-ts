import { SquareIcon } from "lucide-react"
import { ShapesOverlay } from "@/features/pdf/annotations/annotationOverlays"
import { placingKey } from "@/features/pdf/annotations/annotationKeys"
import { SHAPE_VARIANTS } from "@/features/pdf/annotations/annotationTools.logic"
import { toolEnabled, type PdfTool } from "@/features/pdf/tools/registry"

// Home › Shapes ▾: a rectangle or ellipse (drag, click or keyboard placement; Shift keeps a square or circle), a line
// or an arrow (drag; Shift snaps to 45°).

export const SHAPES_TOOL: PdfTool = {
	id: "annotations.shape",
	ribbon: { tab: "home", group: "annotate", order: 500 },
	labelKey: "previewPdfAnnotToolShapes",
	icon: SquareIcon,
	toolClass: "annotate",
	actionIds: [],
	actions: [],
	enabledWhen: policy => toolEnabled("annotate", policy),
	commands: ["annotations.shape", "annotations.line"],
	variants: SHAPE_VARIANTS,
	onKey: placingKey,
	Overlay: ShapesOverlay
}
