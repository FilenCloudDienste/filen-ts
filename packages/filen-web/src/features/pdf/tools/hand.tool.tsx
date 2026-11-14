import { HandIcon } from "lucide-react"
import { HandOverlay } from "@/features/pdf/annotations/annotationOverlays"
import { placingKey } from "@/features/pdf/annotations/annotationKeys"
import { pdfToolAction } from "@/features/pdf/lib/toolKeys"
import type { PdfTool } from "@/features/pdf/tools/registry"

// Home › Hand (H): dragging moves the pages. Holding Space gives every other tool the hand for as long as it is held.

export const HAND_TOOL: PdfTool = {
	id: "annotations.hand",
	ribbon: { tab: "home", group: "annotate", order: 110 },
	labelKey: "previewPdfAnnotToolHand",
	icon: HandIcon,
	toolClass: "annotate",
	actionIds: ["annotations.hand"],
	actions: [pdfToolAction("annotations.hand", "h", "preview:previewPdfKeyToolHand")],
	enabledWhen: () => ({ enabled: true }),
	commands: [],
	onKey: placingKey,
	Overlay: HandOverlay
}
