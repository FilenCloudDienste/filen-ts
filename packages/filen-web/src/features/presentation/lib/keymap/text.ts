import type { TextKeyBindings, TextKeyCommand } from "@filen/office/react/presentation"
import { PREVIEW_ACTIONS } from "@/features/preview/lib/keymap"
import { PRESENTATION_EDITOR_ACTIONS } from "@/features/presentation/lib/keymap/editor"
import { CURRENT_PLATFORM, defaultComboOn, useBindings, type ActionDef } from "@/lib/keymap/registry"

// Text editing keys of the presentation editor that a user may rebind, PowerPoint's. Bold, italic, link, find and
// replace are the document editors' own actions (editor.bold, editor.italic, editor.link, editor.find,
// editor.replace), so one binding serves every editor. Center (Mod+E) shares its default with editor.code: the two
// never run together (the code and Markdown editors never mount inside a presentation, and a body being edited takes
// only the keys pressed in it), which lib/keymap/conflicts.ts lists once these actions are registered. The keys
// PowerPoint fixes (Enter, Backspace, Delete, arrows, Escape) are the text editor's own; undo and redo there are
// the editor's presentation.undo and presentation.redo.
export type PresentationTextAction =
	| "presentation.text.underline"
	| "presentation.text.subscript"
	| "presentation.text.superscript"
	| "presentation.text.clearFormatting"
	| "presentation.text.growFont"
	| "presentation.text.shrinkFont"
	| "presentation.text.alignLeft"
	| "presentation.text.alignCenter"
	| "presentation.text.alignRight"
	| "presentation.text.justify"
	| "presentation.text.lineBreak"
	| "presentation.text.levelDown"
	| "presentation.text.levelUp"
	| "presentation.text.promote"
	| "presentation.text.demote"
	| "presentation.text.moveParagraphUp"
	| "presentation.text.moveParagraphDown"
	| "presentation.text.nextPlaceholder"

// Promote, demote, moving paragraphs and the next placeholder are PowerPoint's own per platform: Alt+Shift+arrows and
// Ctrl+Enter on Windows, Cmd+[ and Cmd+] on a Mac (Option+Shift+arrows select by word there), as the text editor's
// own defaults (DEFAULT_TEXT_BINDINGS, APPLE_TEXT_BINDINGS; a type-only import keeps the editor out of the keymap).
// Clear formatting is Ctrl+Space, PowerPoint's, except on a Mac, where Ctrl+Space switches the input source:
// Cmd+Shift+Space there.
const ON_MAC = { mac: true } as const

function textAction(
	id: PresentationTextAction,
	defaultCombo: string,
	descriptionKey: ActionDef["descriptionKey"],
	mac?: string
): ActionDef & { readonly id: PresentationTextAction } {
	return {
		id,
		defaultCombo,
		...(mac === undefined ? {} : { platformDefaults: [{ on: ON_MAC, combo: mac }] }),
		scope: "editor",
		section: "presentationText",
		descriptionKey,
		hintKey: "settings:keyboardHintSlideText"
	}
}

export const PRESENTATION_TEXT_ACTIONS: readonly (ActionDef & { readonly id: PresentationTextAction })[] = [
	textAction("presentation.text.underline", "mod+u", "preview:previewPptxShortcutUnderline"),
	textAction("presentation.text.subscript", "mod+ctrl+equal", "preview:previewPptxShortcutSubscript"),
	textAction("presentation.text.superscript", "mod+ctrl+shift+equal", "preview:previewPptxShortcutSuperscript"),
	textAction("presentation.text.clearFormatting", "ctrl+space", "preview:previewPptxShortcutClearFormatting", "mod+shift+space"),
	textAction("presentation.text.growFont", "mod+shift+period", "preview:previewPptxShortcutGrowFont"),
	textAction("presentation.text.shrinkFont", "mod+shift+comma", "preview:previewPptxShortcutShrinkFont"),
	textAction("presentation.text.alignLeft", "mod+l", "preview:previewPptxShortcutAlignLeft"),
	textAction("presentation.text.alignCenter", "mod+e", "preview:previewPptxShortcutAlignCenter"),
	textAction("presentation.text.alignRight", "mod+r", "preview:previewPptxShortcutAlignRight"),
	textAction("presentation.text.justify", "mod+j", "preview:previewPptxShortcutJustify"),
	textAction("presentation.text.lineBreak", "shift+enter", "preview:previewPptxShortcutLineBreak"),
	textAction("presentation.text.levelDown", "tab", "preview:previewPptxShortcutLevelDown"),
	textAction("presentation.text.levelUp", "shift+tab", "preview:previewPptxShortcutLevelUp"),
	textAction("presentation.text.promote", "alt+shift+arrowleft", "preview:previewPptxShortcutPromote", "mod+bracketleft"),
	textAction("presentation.text.demote", "alt+shift+arrowright", "preview:previewPptxShortcutDemote", "mod+bracketright"),
	textAction("presentation.text.moveParagraphUp", "alt+shift+arrowup", "preview:previewPptxShortcutMoveParagraphUp", ""),
	textAction("presentation.text.moveParagraphDown", "alt+shift+arrowdown", "preview:previewPptxShortcutMoveParagraphDown", ""),
	textAction("presentation.text.nextPlaceholder", "mod+enter", "preview:previewPptxShortcutNextPlaceholder", "")
]

// The action each of the text editor's rebindable keys runs: this list's, and the document editors' bold, italic and
// link.
const ACTION_OF: Readonly<Record<TextKeyCommand, string>> = {
	bold: "editor.bold",
	italic: "editor.italic",
	link: "editor.link",
	underline: "presentation.text.underline",
	subscript: "presentation.text.subscript",
	superscript: "presentation.text.superscript",
	clearFormatting: "presentation.text.clearFormatting",
	growFont: "presentation.text.growFont",
	shrinkFont: "presentation.text.shrinkFont",
	alignLeft: "presentation.text.alignLeft",
	alignCenter: "presentation.text.alignCenter",
	alignRight: "presentation.text.alignRight",
	justify: "presentation.text.justify",
	lineBreak: "presentation.text.lineBreak",
	levelDown: "presentation.text.levelDown",
	levelUp: "presentation.text.levelUp",
	promote: "presentation.text.promote",
	demote: "presentation.text.demote",
	moveParagraphUp: "presentation.text.moveParagraphUp",
	moveParagraphDown: "presentation.text.moveParagraphDown",
	nextPlaceholder: "presentation.text.nextPlaceholder",
	// The editor's own undo and redo: one binding steps the history on the slide and in a body being edited.
	undo: "presentation.undo",
	redo: "presentation.redo"
}

const DEFINITIONS: ReadonlyMap<string, ActionDef> = new Map(
	[...PRESENTATION_TEXT_ACTIONS, ...PRESENTATION_EDITOR_ACTIONS, ...PREVIEW_ACTIONS].map(action => [action.id, action] as const)
)

// The text editor's keys from the combos in effect by action id (useBindings; each action's own default on this
// platform where one is missing).
export function presentationTextBindings(combos: Readonly<Record<string, string>>): TextKeyBindings {
	const bindings: Partial<Record<TextKeyCommand, string>> = {}

	for (const command of Object.keys(ACTION_OF) as TextKeyCommand[]) {
		const id = ACTION_OF[command]
		const def = DEFINITIONS.get(id)

		bindings[command] = combos[id] ?? (def === undefined ? "" : defaultComboOn(def, CURRENT_PLATFORM))
	}

	return bindings as TextKeyBindings
}

// One bindings object per keymap record: the store swaps the record only when the user edits a binding, so the text
// editor gets the same object between renders and its combo parse cache keeps hitting.
const BY_BINDINGS = new WeakMap<Readonly<Record<string, string>>, TextKeyBindings>()

// The bindings for the mounted text editor, following the user's changes as they make them.
export function usePresentationTextBindings(): TextKeyBindings {
	const combos = useBindings()
	let bindings = BY_BINDINGS.get(combos)

	if (bindings === undefined) {
		bindings = presentationTextBindings(combos)
		BY_BINDINGS.set(combos, bindings)
	}

	return bindings
}
