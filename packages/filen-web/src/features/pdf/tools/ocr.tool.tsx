import { ScanTextIcon } from "lucide-react"
import { OcrPanel } from "@/features/pdf/ocr/ocrPanel"
import { toolEnabled, whileActive, type PdfTool } from "@/features/pdf/tools/registry"

// Tools › Recognise text (ocr/ocrPanel.tsx): invisible, searchable text over the scanned pages. It adds page content,
// so it is a content edit for the signature policy and the author's restrictions.

export const OCR_TOOL: PdfTool = {
	id: "ocr.recognise",
	ribbon: { tab: "tools", group: "ocr", order: 300 },
	labelKey: "previewPdfOcrMenu",
	icon: ScanTextIcon,
	toolClass: "content",
	actionIds: [],
	actions: [],
	enabledWhen: policy => toolEnabled("content", policy),
	commands: ["ocr.applyPage"],
	Panel: whileActive(OcrPanel),
	panelSlot: "top"
}
