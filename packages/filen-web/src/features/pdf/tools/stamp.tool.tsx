import { CloudIcon, ImageIcon, StampIcon } from "lucide-react"
import { PDF_PRESET_STAMPS } from "@filen/office/core/pdfedit/annotations"
import { StampOverlay } from "@/features/pdf/annotations/annotationOverlays"
import { placingKey } from "@/features/pdf/annotations/annotationKeys"
import { PDF_STAMP_KEYS } from "@/features/pdf/annotations/annotationPopover.logic"
import { toolEnabled, type PdfTool, type PdfToolVariant } from "@/features/pdf/tools/registry"

// Home › Image / stamp ▾: a picture from this device or from Filen (HEIC converted first, scaled down to fit), or one
// of the standard stamps, placed where clicked, dragged or placed from the keyboard. A picture is asked for once its
// place is chosen.

const VARIANTS: readonly PdfToolVariant[] = [
	{ id: "image", labelKey: "previewPdfAnnotToolImage", icon: ImageIcon },
	{ id: "imageFilen", labelKey: "previewPdfAnnotImageFromFilen", icon: CloudIcon },
	...PDF_PRESET_STAMPS.map(name => ({ id: name, labelKey: PDF_STAMP_KEYS[name], icon: StampIcon }))
]

export const STAMP_TOOL: PdfTool = {
	id: "annotations.stamp",
	ribbon: { tab: "home", group: "annotate", order: 600 },
	labelKey: "previewPdfAnnotToolStamp",
	icon: StampIcon,
	toolClass: "annotate",
	actionIds: [],
	actions: [],
	enabledWhen: policy => toolEnabled("annotate", policy),
	commands: ["annotations.image", "annotations.stamp"],
	variants: VARIANTS,
	onKey: placingKey,
	Overlay: StampOverlay
}
