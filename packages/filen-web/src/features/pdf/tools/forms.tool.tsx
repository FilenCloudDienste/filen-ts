import { EraserIcon } from "lucide-react"
import { toolEnabled, type PdfTool } from "@/features/pdf/tools/registry"

// Fill & Sign › Clear form: every field back to its default value, as one undo step (so no confirmation). The fields
// themselves are filled on the page (session/fieldOverlay.tsx), each edit one forms.setField step; a hybrid form's XFA
// data is removed (forms.removeXfa) by the save, after the user confirmed (forms/formSave.tsx).
export const FORMS_TOOL: PdfTool = {
	id: "forms.reset",
	ribbon: { tab: "fillSign", group: "form", order: 900 },
	labelKey: "previewPdfClearForm",
	icon: EraserIcon,
	toolClass: "formFill",
	actionIds: [],
	actions: [],
	enabledWhen: policy => toolEnabled("formFill", policy),
	commands: ["forms.reset", "forms.setField", "forms.removeXfa"],
	run: context => {
		context.edit(session => session.dispatch("forms.reset", {}))
	}
}
