import { TextCursorInputIcon, TypeIcon } from "lucide-react"
import { AddTextOverlay, EditTextOverlay, TextToolPanel } from "@/features/pdf/textEdit/textEditTool"
import { toolEnabled, whileActive, type PdfTool } from "@/features/pdf/tools/registry"

// Tools › Edit text and Add text (textEdit/textEditTool.tsx): click a text block to edit its words in place, or a
// place on the page to add text. Content edits, as the signature policy and the author's restrictions see them.

export const TEXT_EDIT_TOOL: PdfTool = {
	id: "textEdit.edit",
	ribbon: { tab: "tools", group: "text", order: 200 },
	labelKey: "previewPdfTextEditTool",
	icon: TextCursorInputIcon,
	toolClass: "content",
	actionIds: [],
	actions: [],
	enabledWhen: policy => toolEnabled("content", policy),
	commands: ["textEdit.replace"],
	Overlay: EditTextOverlay,
	Panel: whileActive(TextToolPanel),
	panelSlot: "top"
}

export const TEXT_ADD_TOOL: PdfTool = {
	id: "textEdit.add",
	ribbon: { tab: "tools", group: "text", order: 210 },
	labelKey: "previewPdfTextAddTool",
	icon: TypeIcon,
	toolClass: "content",
	actionIds: [],
	actions: [],
	enabledWhen: policy => toolEnabled("content", policy),
	commands: ["textEdit.add"],
	Overlay: AddTextOverlay,
	Panel: whileActive(TextToolPanel),
	panelSlot: "top"
}
