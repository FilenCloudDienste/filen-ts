import { CropIcon } from "lucide-react"
import { PdfCropToolOverlay, PdfCropToolPanel } from "@/features/pdf/pages/cropTool"
import { pdfToolAction } from "@/features/pdf/lib/toolKeys"
import { toolEnabled, whileActive, type PdfTool } from "@/features/pdf/tools/registry"

// Tools › Crop (K): handles on the current page and the scope bar (pages/cropTool.tsx). Cropping sets crop boxes; the
// bar's option to delete what lies outside also removes that content (a redaction of the outside, saved in full).
export const CROP_TOOL: PdfTool = {
	id: "crop",
	ribbon: { tab: "tools", group: "crop", order: 100 },
	labelKey: "previewPdfCrop",
	icon: CropIcon,
	toolClass: "pages",
	actionIds: ["pdf.tool.crop"],
	actions: [pdfToolAction("pdf.tool.crop", "k", "preview:previewPdfKeyCrop")],
	enabledWhen: policy => toolEnabled("pages", policy),
	commands: ["crop.set", "crop.toContent", "crop.removeOutside"],
	Overlay: PdfCropToolOverlay,
	Panel: whileActive(PdfCropToolPanel),
	panelSlot: "top"
}
