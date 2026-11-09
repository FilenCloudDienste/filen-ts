import type { ActionDef } from "@/lib/keymap/registry"
import { comboAlternatives, isMacPlatform } from "@/lib/keymap/kbd.logic"

// The presentation editor's own commands: slides (new, duplicate, delete, move) and undo/redo, PowerPoint's keys.
// New slide is Ctrl+M on every platform, as in PowerPoint for the web (Cmd+M minimizes the window on a Mac).
// Duplicate slide is Mod+Shift+D anywhere and Mod+D in the slide list; on the slide canvas Mod+D duplicates the
// selected objects (the canvas takes it before the editor).
// They act where the editor has focus (its rail and slide), so the editor matches them on its own keydown (the
// spreadsheet grid's precedent) against the combo in effect: the default here, or the user's once the shortcuts
// catalog lists them. Save is the overlay's preview.save (Mod+S). Zoom in is Ctrl+Plus wherever the layout puts "+"
// (US: Ctrl+= or Ctrl+Shift+=, the numpad's, a German keyboard's own key); Zoom to fit is Ctrl+Alt+O.
export type PresentationEditorAction =
	| "presentation.newSlide"
	| "presentation.duplicateSlide"
	| "presentation.deleteSlide"
	| "presentation.moveSlideUp"
	| "presentation.moveSlideDown"
	| "presentation.moveSlideFirst"
	| "presentation.moveSlideLast"
	| "presentation.undo"
	| "presentation.redo"
	| "presentation.selectAllSlides"
	| "presentation.zoomIn"
	| "presentation.zoomOut"
	| "presentation.zoomFit"

export const PRESENTATION_EDITOR_ACTIONS: readonly (ActionDef & { readonly id: PresentationEditorAction })[] = [
	{ id: "presentation.newSlide", defaultCombo: "ctrl+m", scope: "editor", descriptionKey: "preview:previewPptxEditorKeyNewSlide" },
	{
		id: "presentation.duplicateSlide",
		defaultCombo: "mod+d,mod+shift+d",
		scope: "editor",
		descriptionKey: "preview:previewPptxEditorKeyDuplicate"
	},
	{
		id: "presentation.deleteSlide",
		defaultCombo: "delete,backspace",
		scope: "editor",
		descriptionKey: "preview:previewPptxEditorKeyDelete"
	},
	{ id: "presentation.moveSlideUp", defaultCombo: "mod+arrowup", scope: "editor", descriptionKey: "preview:previewPptxEditorKeyMoveUp" },
	{
		id: "presentation.moveSlideDown",
		defaultCombo: "mod+arrowdown",
		scope: "editor",
		descriptionKey: "preview:previewPptxEditorKeyMoveDown"
	},
	{
		id: "presentation.moveSlideFirst",
		defaultCombo: "mod+shift+arrowup",
		scope: "editor",
		descriptionKey: "preview:previewPptxEditorKeyMoveFirst"
	},
	{
		id: "presentation.moveSlideLast",
		defaultCombo: "mod+shift+arrowdown",
		scope: "editor",
		descriptionKey: "preview:previewPptxEditorKeyMoveLast"
	},
	{ id: "presentation.undo", defaultCombo: "mod+z", scope: "editor", descriptionKey: "preview:previewPptxEditorKeyUndo" },
	{ id: "presentation.redo", defaultCombo: "mod+y,mod+shift+z", scope: "editor", descriptionKey: "preview:previewPptxEditorKeyRedo" },
	{ id: "presentation.selectAllSlides", defaultCombo: "mod+a", scope: "editor", descriptionKey: "preview:previewPptxEditorKeySelectAll" },
	{
		id: "presentation.zoomIn",
		defaultCombo: "mod+plus,mod+=,mod+shift+plus",
		scope: "editor",
		descriptionKey: "preview:previewPptxEditorKeyZoomIn"
	},
	{ id: "presentation.zoomOut", defaultCombo: "mod+-", scope: "editor", descriptionKey: "preview:previewPptxEditorKeyZoomOut" },
	{ id: "presentation.zoomFit", defaultCombo: "mod+alt+o", scope: "editor", descriptionKey: "preview:previewPptxEditorKeyZoomFit" }
]

const MODIFIERS = new Set(["mod", "ctrl", "control", "meta", "cmd", "command", "shift", "alt", "option"])

// Key names a combo cannot spell as the character ("+" separates a chord's keys).
const KEY_TOKENS: Readonly<Record<string, string>> = { "+": "plus" }

// The key a chord names: its character, else (with Alt, which turns a Mac's letters and digits into other
// characters, Option+O into "ø") the physical key's letter or digit.
function eventKey(event: { readonly key: string; readonly code?: string; readonly altKey: boolean }): string {
	const key = event.key.toLowerCase()

	if (event.altKey && !/^[a-z0-9]$/u.test(key) && event.code !== undefined) {
		const physical = /^(?:Key([A-Z])|Digit([0-9]))$/u.exec(event.code)
		const name = physical?.[1] ?? physical?.[2]

		if (name !== undefined) return name.toLowerCase()
	}

	return KEY_TOKENS[key] ?? key
}

// Whether `event` is one chord of `combo` ("mod+shift+arrowup", alternatives comma-separated): the same modifiers
// exactly, and the key by its name.
export function matchesCombo(
	event: {
		readonly key: string
		readonly code?: string
		readonly ctrlKey: boolean
		readonly metaKey: boolean
		readonly shiftKey: boolean
		readonly altKey: boolean
	},
	combo: string,
	mac: boolean
): boolean {
	const key = eventKey(event)

	return comboAlternatives(combo).some(tokens => {
		const keys = tokens.filter(token => !MODIFIERS.has(token))
		const has = (...names: string[]): boolean => tokens.some(token => names.includes(token))
		const mod = has("mod")
		const ctrl = has("ctrl", "control") || (mod && !mac)
		const meta = has("meta", "cmd", "command") || (mod && mac)

		return (
			keys.length === 1 &&
			keys[0] === key &&
			event.ctrlKey === ctrl &&
			event.metaKey === meta &&
			event.shiftKey === has("shift") &&
			event.altKey === has("alt", "option")
		)
	})
}

// The editor action a keydown is, under `overrides` (the user's combos by action id).
export function presentationEditorKey(
	event: {
		readonly key: string
		readonly code?: string
		readonly ctrlKey: boolean
		readonly metaKey: boolean
		readonly shiftKey: boolean
		readonly altKey: boolean
	},
	overrides: Readonly<Record<string, string>>,
	mac: boolean = isMacPlatform()
): PresentationEditorAction | undefined {
	const def = PRESENTATION_EDITOR_ACTIONS.find(action => matchesCombo(event, overrides[action.id] ?? action.defaultCombo, mac))

	return def?.id
}

const KEY_NAMES: Readonly<Record<string, readonly [mac: string, other: string]>> = {
	mod: ["⌘", "Ctrl"],
	ctrl: ["⌃", "Ctrl"],
	shift: ["⇧", "Shift"],
	alt: ["⌥", "Alt"],
	arrowup: ["↑", "↑"],
	arrowdown: ["↓", "↓"],
	delete: ["Del", "Del"],
	backspace: ["⌫", "Backspace"],
	plus: ["+", "+"]
}

// The keys of an action's first combo as a tooltip shows them (KbdKeys).
export function presentationShortcutKeys(
	id: PresentationEditorAction,
	overrides: Readonly<Record<string, string>>,
	mac: boolean = isMacPlatform()
): string[] {
	const def = PRESENTATION_EDITOR_ACTIONS.find(action => action.id === id)
	const first = comboAlternatives(overrides[id] ?? def?.defaultCombo ?? "")[0] ?? []

	return first.map(token => {
		const names = KEY_NAMES[token]

		return names === undefined ? token.toUpperCase() : mac ? names[0] : names[1]
	})
}
