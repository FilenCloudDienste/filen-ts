import { EraserIcon } from "lucide-react"
import { toolEnabled, type PdfTool } from "@/features/pdf/tools/registry"

// Fill & Sign › Clear form: every field back to its default value, as one undo step.
export const FORM_RESET_TOOL: PdfTool = {
	id: "forms.reset",
	ribbon: { tab: "fillSign", group: "form", order: 900 },
	labelKey: "previewPdfClearForm",
	icon: EraserIcon,
	toolClass: "formFill",
	actionIds: [],
	actions: [],
	enabledWhen: policy => toolEnabled("formFill", policy),
	commands: ["forms.reset"],
	run: context => {
		context.edit(session => session.dispatch("forms.reset", {}))
	}
}
