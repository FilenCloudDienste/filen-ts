import { chordLabels, matchesCombo, parseCombo, type ChordEvent, type KeyboardLayout } from "@filen/shared/keymap"
import type { ActionDef } from "@/lib/keymap/registry"
import { browserZoomKey, zoomKeyAction } from "@/lib/keymap/browserZoom"
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

// The slide list's commands say so; the rest act anywhere in the editor.
const SLIDE_LIST: ReadonlySet<PresentationEditorAction> = new Set([
	"presentation.duplicateSlide",
	"presentation.deleteSlide",
	"presentation.moveSlideUp",
	"presentation.moveSlideDown",
	"presentation.moveSlideFirst",
	"presentation.moveSlideLast",
	"presentation.selectAllSlides"
])

function editorAction(
	id: PresentationEditorAction,
	defaultCombo: string,
	descriptionKey: ActionDef["descriptionKey"]
): ActionDef & { readonly id: PresentationEditorAction } {
	return {
		id,
		defaultCombo,
		scope: "editor",
		section: "presentation",
		descriptionKey,
		...(SLIDE_LIST.has(id) ? { hintKey: "settings:keyboardHintSlideList" as const } : {})
	}
}

export const PRESENTATION_EDITOR_ACTIONS: readonly (ActionDef & { readonly id: PresentationEditorAction })[] = [
	editorAction("presentation.newSlide", "ctrl+m", "preview:previewPptxEditorKeyNewSlide"),
	editorAction("presentation.duplicateSlide", "mod+d,mod+shift+d", "preview:previewPptxEditorKeyDuplicate"),
	editorAction("presentation.deleteSlide", "delete,backspace", "preview:previewPptxEditorKeyDelete"),
	editorAction("presentation.moveSlideUp", "mod+arrowup", "preview:previewPptxEditorKeyMoveUp"),
	editorAction("presentation.moveSlideDown", "mod+arrowdown", "preview:previewPptxEditorKeyMoveDown"),
	editorAction("presentation.moveSlideFirst", "mod+shift+arrowup", "preview:previewPptxEditorKeyMoveFirst"),
	editorAction("presentation.moveSlideLast", "mod+shift+arrowdown", "preview:previewPptxEditorKeyMoveLast"),
	editorAction("presentation.selectAllSlides", "mod+a", "preview:previewPptxEditorKeySelectAll"),
	editorAction("presentation.undo", "mod+z", "preview:previewPptxEditorKeyUndo"),
	editorAction("presentation.redo", "mod+y,mod+shift+z", "preview:previewPptxEditorKeyRedo"),
	editorAction("presentation.zoomIn", "mod+equal,mod+shift+equal,mod+add", "preview:previewPptxEditorKeyZoomIn"),
	editorAction("presentation.zoomOut", "mod+minus,mod+subtract", "preview:previewPptxEditorKeyZoomOut"),
	editorAction("presentation.zoomFit", "mod+alt+o", "preview:previewPptxEditorKeyZoomFit"),
	// PowerPoint's Alt+F10 (Home ▸ Arrange ▸ Selection Pane).
	editorAction("presentation.selectionPane", "alt+f10", "preview:previewPptxEditorKeySelectionPane"),
	// PowerPoint's Copy and Paste Formatting, on the slide and in a body being edited only: Mod+Shift+V stays the
	// notes' and other fields' paste as plain text, Mod+Shift+C the browser's elsewhere.
	editorAction("presentation.copyFormat", "mod+shift+c", "preview:previewPptxEditorKeyCopyFormat"),
	editorAction("presentation.pasteFormat", "mod+shift+v", "preview:previewPptxEditorKeyPasteFormat")
]

// The editor action a keydown is, under `combos` (the combos in effect by action id, useBindings; an action's default
// where one is missing). The browser's own zoom keys,
// read by character, zoom the slide ahead of the default bindings, so no layout zooms the page in its place; a key the
// user bound to an action stays that action.
export function presentationEditorKey(
	event: ChordEvent,
	combos: Readonly<Record<string, string>>,
	mac: boolean = isMacPlatform()
): PresentationEditorAction | undefined {
	const zoom = browserZoomKey(event, mac)

	if (zoom === "in" || zoom === "out") {
		return zoomKeyAction(
			event,
			PRESENTATION_EDITOR_ACTIONS,
			zoom === "in" ? "presentation.zoomIn" : "presentation.zoomOut",
			combos,
			mac
		)
	}

	return PRESENTATION_EDITOR_ACTIONS.find(action => matchesCombo(event, combos[action.id] ?? action.defaultCombo, mac))?.id
}

// The keys of an action's first combo as a tooltip shows them (KbdKeys), labelled for `layout` when it is known.
export function presentationShortcutKeys(
	id: PresentationEditorAction,
	combos: Readonly<Record<string, string>>,
	layout: KeyboardLayout | null = null,
	mac: boolean = isMacPlatform()
): string[] {
	const def = PRESENTATION_EDITOR_ACTIONS.find(action => action.id === id)
	const [first] = parseCombo(combos[id] ?? def?.defaultCombo ?? "")

	return first === undefined ? [] : chordLabels(first, mac, layout)
}
