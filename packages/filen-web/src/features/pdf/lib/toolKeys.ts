import { isCharacterChord, parseCombo, type Chord } from "@filen/shared/keymap"
import type { ActionDef, ShortcutDescriptionKey } from "@/lib/keymap/registry"

// The rule for the PDF tools' single-letter keys, apart from the keymap (lib/keymap.ts collects every tool's actions
// from tools/index.ts, and the tool modules build theirs with pdfToolAction here: no import cycle).

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
