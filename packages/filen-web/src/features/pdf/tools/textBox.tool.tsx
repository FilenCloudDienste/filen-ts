import { TypeIcon } from "lucide-react"
import { TextBoxOverlay } from "@/features/pdf/annotations/annotationOverlays"
import { placingKey } from "@/features/pdf/annotations/annotationKeys"
import { pdfToolAction } from "@/features/pdf/lib/toolKeys"
import { toolEnabled, type PdfTool } from "@/features/pdf/tools/registry"

// Home › Text box (T): drag, click or place from the keyboard (Enter), then type; Mod+Enter or a press outside ends
// the box, Escape drops it.

export const TEXT_BOX_TOOL: PdfTool = {
	id: "annotations.textBox",
	ribbon: { tab: "home", group: "annotate", order: 200 },
	labelKey: "previewPdfAnnotToolTextBox",
	icon: TypeIcon,
	toolClass: "annotate",
	actionIds: ["annotations.textBox"],
	actions: [pdfToolAction("annotations.textBox", "t", "preview:previewPdfKeyToolTextBox")],
	enabledWhen: policy => toolEnabled("annotate", policy),
	commands: ["annotations.textBox", "annotations.text", "annotations.delete"],
	onKey: placingKey,
	Overlay: TextBoxOverlay
}
