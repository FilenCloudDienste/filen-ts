import { MousePointer2Icon } from "lucide-react"
import { SelectOverlay } from "@/features/pdf/annotations/annotationOverlays"
import { PdfAnnotationsHost } from "@/features/pdf/annotations/annotationsHost"
import { selectionKey } from "@/features/pdf/annotations/annotationKeys"
import { pdfToolAction } from "@/features/pdf/lib/toolKeys"
import type { PdfTool } from "@/features/pdf/tools/registry"

// Home › Select (V): the tool in effect while no other is. A click selects an annotation (its popover: colour,
// opacity, width, comment, delete), a drag moves or resizes it, a double click edits a text box's text. Selecting
// changes nothing, so it is offered wherever the document is shown; its changes are refused where editing isn't
// allowed. Its panel keeps what every annotation tool shares (the Comments panel, the author prompt).

export const SELECT_TOOL: PdfTool = {
	id: "annotations.select",
	ribbon: { tab: "home", group: "annotate", order: 100 },
	labelKey: "previewPdfAnnotToolSelect",
	icon: MousePointer2Icon,
	toolClass: "annotate",
	actionIds: ["annotations.select"],
	actions: [pdfToolAction("annotations.select", "v", "preview:previewPdfKeyToolSelect")],
	enabledWhen: () => ({ enabled: true }),
	commands: ["annotations.move", "annotations.resize", "annotations.style", "annotations.text", "annotations.delete"],
	idle: true,
	run: context => {
		context.finish()
	},
	onKey: selectionKey,
	Overlay: SelectOverlay,
	Panel: PdfAnnotationsHost
}
