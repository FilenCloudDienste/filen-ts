import { chordLabels, matchesCombo, parseCombo, type ChordEvent, type KeyboardLayout } from "@filen/shared/keymap"
import type { ActionDef } from "@/lib/keymap/registry"
import { browserZoomKey, matchesOverride } from "@/lib/keymap/browserZoom"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"

// The presentation editor's own commands: slides (new, duplicate, delete, move) and undo/redo, PowerPoint's keys.
// New slide is Ctrl+M on every platform, as in PowerPoint for the web (Cmd+M minimizes the window on a Mac).
// Duplicate slide is Mod+Shift+D anywhere and Mod+D in the slide list; on the slide canvas Mod+D duplicates the
// selected objects (the canvas takes it before the editor).
// They act where the editor has focus (its rail and slide), so the editor matches them on its own keydown (the
// spreadsheet grid's precedent) against the combo in effect: the default here, or the user's once the shortcuts
// catalog lists them. Save is the overlay's preview.save (Mod+S). Zoom in is Mod with the key a US layout types "="
// and "+" on (Shift or not) or the numpad's +, zoom out Mod with "-" or the numpad's -: keys are physical
// (@filen/shared/keymap); the browser's own zoom keys, by character, zoom the slide too (lib/keymap/browserZoom.ts).
// Zoom to fit is Mod+Alt+O.
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
	| "presentation.selectionPane"
	| "presentation.copyFormat"
	| "presentation.pasteFormat"

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
		defaultCombo: "mod+equal,mod+shift+equal,mod+add",
		scope: "editor",
		descriptionKey: "preview:previewPptxEditorKeyZoomIn"
	},
	{
		id: "presentation.zoomOut",
		defaultCombo: "mod+minus,mod+subtract",
		scope: "editor",
		descriptionKey: "preview:previewPptxEditorKeyZoomOut"
	},
	{ id: "presentation.zoomFit", defaultCombo: "mod+alt+o", scope: "editor", descriptionKey: "preview:previewPptxEditorKeyZoomFit" },
	// PowerPoint's Alt+F10 (Home ▸ Arrange ▸ Selection Pane).
	{
		id: "presentation.selectionPane",
		defaultCombo: "alt+f10",
		scope: "editor",
		descriptionKey: "preview:previewPptxEditorKeySelectionPane"
	},
	// PowerPoint's Copy and Paste Formatting, on the slide and in a body being edited only: Mod+Shift+V stays the
	// notes' and other fields' paste as plain text, Mod+Shift+C the browser's elsewhere.
	{
		id: "presentation.copyFormat",
		defaultCombo: "mod+shift+c",
		scope: "editor",
		descriptionKey: "preview:previewPptxEditorKeyCopyFormat"
	},
	{
		id: "presentation.pasteFormat",
		defaultCombo: "mod+shift+v",
		scope: "editor",
		descriptionKey: "preview:previewPptxEditorKeyPasteFormat"
	}
]

// The editor action a keydown is, under `overrides` (the user's combos by action id). The browser's own zoom keys,
// read by character, zoom the slide ahead of the default bindings, so no layout zooms the page in its place; a key the
// user bound to an action stays that action.
export function presentationEditorKey(
	event: ChordEvent,
	overrides: Readonly<Record<string, string>>,
	mac: boolean = isMacPlatform()
): PresentationEditorAction | undefined {
	const zoom = browserZoomKey(event, mac)

	if (zoom === "in" || zoom === "out") {
		return (
			PRESENTATION_EDITOR_ACTIONS.find(action => matchesOverride(event, overrides[action.id], mac))?.id ??
			(zoom === "in" ? "presentation.zoomIn" : "presentation.zoomOut")
		)
	}

	return PRESENTATION_EDITOR_ACTIONS.find(action => matchesCombo(event, overrides[action.id] ?? action.defaultCombo, mac))?.id
}

// The keys of an action's first combo as a tooltip shows them (KbdKeys), labelled for `layout` when it is known.
export function presentationShortcutKeys(
	id: PresentationEditorAction,
	overrides: Readonly<Record<string, string>>,
	layout: KeyboardLayout | null = null,
	mac: boolean = isMacPlatform()
): string[] {
	const def = PRESENTATION_EDITOR_ACTIONS.find(action => action.id === id)
	const [first] = parseCombo(overrides[id] ?? def?.defaultCombo ?? "")

	return first === undefined ? [] : chordLabels(first, mac, layout)
}
