import { MessageSquarePlusIcon, MessagesSquareIcon, PaperclipIcon } from "lucide-react"
import { NoteOverlay } from "@/features/pdf/annotations/annotationOverlays"
import { placingKey } from "@/features/pdf/annotations/annotationKeys"
import { annotationStoreOf } from "@/features/pdf/annotations/annotationStore"
import { pdfToolAction } from "@/features/pdf/lib/toolKeys"
import { toolEnabled, type PdfPolicyState, type PdfTool, type PdfToolVerdict } from "@/features/pdf/tools/registry"

// Home › Comment (C): a click (or Enter on the page in view) places a sticky note, written in the Comments panel. The
// Comments button shows every thread (replies, resolve, edit, delete); Attachments lists the files the document carries,
// each only downloadable. Reading threads and attachments needs the editor, so either starts it.

// Reading needs the editor's engine, which reads the file from Filen.
function readable(policy: PdfPolicyState): PdfToolVerdict {
	return policy.online ? { enabled: true } : { enabled: false, reasonKey: "previewPdfToolOffline" }
}

export const NOTE_TOOL: PdfTool = {
	id: "annotations.note",
	ribbon: { tab: "home", group: "comment", order: 700 },
	labelKey: "previewPdfAnnotToolNote",
	icon: MessageSquarePlusIcon,
	toolClass: "annotate",
	actionIds: ["annotations.note"],
	actions: [pdfToolAction("annotations.note", "c", "preview:previewPdfKeyToolNote")],
	enabledWhen: policy => toolEnabled("annotate", policy),
	commands: ["annotations.note", "annotations.reply", "annotations.state", "annotations.text", "annotations.delete"],
	onKey: placingKey,
	Overlay: NoteOverlay
}

export const COMMENTS_TOOL: PdfTool = {
	id: "annotations.comments",
	ribbon: { tab: "home", group: "comment", order: 710 },
	labelKey: "previewPdfCommentsTitle",
	icon: MessagesSquareIcon,
	toolClass: "annotate",
	actionIds: [],
	actions: [],
	enabledWhen: readable,
	commands: [],
	run: context => {
		const store = annotationStoreOf(context.swap)

		store.openComments(!store.getState().commentsOpen)
		context.swap.warm()
	}
}

export const ATTACHMENTS_TOOL: PdfTool = {
	id: "annotations.attachments",
	ribbon: { tab: "home", group: "comment", order: 720 },
	labelKey: "previewPdfAnnotAttachments",
	icon: PaperclipIcon,
	toolClass: "annotate",
	actionIds: [],
	actions: [],
	enabledWhen: readable,
	commands: [],
	run: context => {
		annotationStoreOf(context.swap).openAttachments(true)
		context.swap.warm()
	}
}
