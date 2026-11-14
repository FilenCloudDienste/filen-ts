import { isCharacterChord, parseCombo, type Chord } from "@filen/shared/keymap"
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

// Where a tool's single-letter key works: on the page surface only, never while typing in a field (a form field, a
// text box being edited, the page number), so the letter is typed there.
export const PDF_PAGE_HINT = "settings:keyboardHintPdfPage" satisfies ShortcutDescriptionKey

// The viewer's single letters, which the editor keeps (next and previous page, full screen): no tool may take them.
export const PDF_VIEWER_LETTERS: ReadonlySet<string> = new Set(["n", "p", "f"])

// A tool's key in the pdfEditor section. A tool's letter (V select, T text box, …) is a bare a–z key, matched only on
// the page surface (pdfToolLetterAllowed).
export function pdfToolAction(id: string, defaultCombo: string, descriptionKey: ShortcutDescriptionKey): ActionDef {
	return { id, defaultCombo, scope: "editor", section: "pdfEditor", descriptionKey, hintKey: PDF_PAGE_HINT }
}

// A tool letter as the rule allows it: one key a–z without modifiers, none of the viewer's.
export function isPdfToolLetter(chord: Chord): boolean {
	return (
		!chord.mod &&
		!chord.meta &&
		!chord.ctrl &&
		!chord.alt &&
		!chord.shift &&
		/^[a-z]$/.test(chord.key) &&
		!PDF_VIEWER_LETTERS.has(chord.key)
	)
}

// Whether a tool's actions keep the rule: each character key in its combos (on every platform) is an allowed tool
// letter and the action says it works on the page only.
export function pdfToolKeysValid(def: ActionDef): boolean {
	const combos = [def.defaultCombo, ...(def.platformDefaults ?? []).map(variant => variant.combo)]
	const chords = combos.flatMap(combo => parseCombo(combo)).filter(isCharacterChord)

	return chords.length === 0 || (chords.every(isPdfToolLetter) && def.hintKey === PDF_PAGE_HINT)
}

const PDF_FIELD_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]'

// Whether a keydown with focus on `target` may run a tool letter: pressed on the page surface, not in a field there
// (input, textarea, select, contenteditable, an ARIA textbox).
export function pdfToolLetterAllowed(target: EventTarget | null, surface: Element): boolean {
	if (!(target instanceof Element) || !surface.contains(target)) {
		return false
	}

	return target.closest(PDF_FIELD_SELECTOR) === null
}

export const PDF_EDITOR_ACTIONS: readonly ActionDef[] = [...PDF_EDITOR_FIXED_ACTIONS, ...PDF_TOOLS.flatMap(tool => tool.actions)]
