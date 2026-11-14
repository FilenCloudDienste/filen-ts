import { PDF_TOOLS } from "@/features/pdf/tools"
import type { ActionDef, PlatformDefault, ShortcutDescriptionKey } from "@/lib/keymap/registry"

// The PDF editor's keys (section pdfEditor): its own (undo, redo, delete, Escape, page rotate) and every tool's. The
// viewer's keys stay as they are once the editor has the document (zoom, fit, view rotate Mod+] / Mod+[, the pages
// incl. N and P, full screen F); Save is preview.save (Mod+S), Print office.print (Mod+P). Page rotate turns the pages
// in the file, Acrobat's Mod+Alt+] / Mod+Alt+[ beside the view's keys; redo is Mod+Shift+Z, plus Ctrl+Y off a Mac.
export type PdfEditorAction = "pdf.undo" | "pdf.redo" | "pdf.delete" | "pdf.escape" | "pdf.rotatePagesCw" | "pdf.rotatePagesCcw"

type Def<Id extends string> = ActionDef & { readonly id: Id }

function editorAction(
	id: PdfEditorAction,
	defaultCombo: string,
	descriptionKey: ShortcutDescriptionKey,
	extra?: Pick<ActionDef, "platformDefaults" | "hintKey">
): Def<PdfEditorAction> {
	return { id, defaultCombo, scope: "editor", section: "pdfEditor", descriptionKey, ...extra }
}

const OFF_MAC_REDO: readonly PlatformDefault[] = [{ on: { mac: false }, combo: "mod+shift+z,mod+y" }]

export const PDF_EDITOR_FIXED_ACTIONS: readonly Def<PdfEditorAction>[] = [
	editorAction("pdf.undo", "mod+z", "preview:previewPdfKeyUndo"),
	editorAction("pdf.redo", "mod+shift+z", "preview:previewPdfKeyRedo", { platformDefaults: OFF_MAC_REDO }),
	editorAction("pdf.delete", "delete,backspace", "preview:previewPdfKeyDelete"),
	editorAction("pdf.escape", "escape", "preview:previewPdfKeyEscape"),
	editorAction("pdf.rotatePagesCw", "mod+alt+bracketright", "preview:previewPdfKeyRotatePagesCw", {
		hintKey: "settings:keyboardHintPdfPages"
	}),
	editorAction("pdf.rotatePagesCcw", "mod+alt+bracketleft", "preview:previewPdfKeyRotatePagesCcw", {
		hintKey: "settings:keyboardHintPdfPages"
	})
]

// The tool letters' rule (toolKeys.ts), for the keymap's users and tests.
export {
	isPdfToolLetter,
	PDF_PAGE_HINT,
	PDF_VIEWER_LETTERS,
	pdfToolAction,
	pdfToolKeysValid,
	pdfToolLetterAllowed
} from "@/features/pdf/lib/toolKeys"

export const PDF_EDITOR_ACTIONS: readonly ActionDef[] = [...PDF_EDITOR_FIXED_ACTIONS, ...PDF_TOOLS.flatMap(tool => tool.actions)]
