import { HighlighterIcon } from "lucide-react"
import { MarkupOverlay } from "@/features/pdf/annotations/annotationOverlays"
import { placingKey } from "@/features/pdf/annotations/annotationKeys"
import { MARKUP_VARIANTS } from "@/features/pdf/annotations/annotationTools.logic"
import { pdfToolAction } from "@/features/pdf/lib/toolKeys"
import { toolEnabled, type PdfTool } from "@/features/pdf/tools/registry"

// Home › Highlight ▾ (U): drag over text to highlight, underline, strike through or squiggle it. The marked quads come
// from the editor's own text between the drag's ends; the draft follows the text shown.

export const MARKUP_TOOL: PdfTool = {
	id: "annotations.markup",
	ribbon: { tab: "home", group: "annotate", order: 400 },
	labelKey: "previewPdfAnnotToolHighlight",
	icon: HighlighterIcon,
	toolClass: "annotate",
	actionIds: ["annotations.markup"],
	actions: [pdfToolAction("annotations.markup", "u", "preview:previewPdfKeyToolHighlight")],
	enabledWhen: policy => toolEnabled("annotate", policy),
	commands: ["annotations.markup"],
	variants: MARKUP_VARIANTS,
	onKey: placingKey,
	Overlay: MarkupOverlay
}
