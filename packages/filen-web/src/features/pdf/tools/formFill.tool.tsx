import { SparklesIcon } from "lucide-react"
import { FormFillOverlay, FormFillPanel } from "@/features/pdf/forms/formFillSurface"
import { toolEnabled, whileActive, type PdfTool } from "@/features/pdf/tools/registry"

export const FORM_FILL_TOOL_ID = "forms.fillFromDetails"

// Fill & Sign › Fill this page: the assistant fills the page in view's empty text fields and choices from details the
// user types, in the side panel (forms/formFillSurface.tsx), the values ghosted in their fields until Fill N fields
// writes them as one undo step (one forms.setField gesture). The form banner's "Fill from my details" opens it too.
export const FORM_FILL_TOOL: PdfTool = {
	id: FORM_FILL_TOOL_ID,
	ribbon: { tab: "fillSign", group: "form", order: 800 },
	labelKey: "previewPdfFormFillTool",
	icon: SparklesIcon,
	toolClass: "formFill",
	actions: [],
	enabledWhen: policy => toolEnabled("formFill", policy),
	commands: ["forms.setField"],
	Overlay: FormFillOverlay,
	Panel: whileActive(FormFillPanel)
}
