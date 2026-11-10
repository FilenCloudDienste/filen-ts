import type { TextKeyBindings, TextKeyCommand } from "@filen/office/react/presentation"
import { PREVIEW_ACTIONS } from "@/features/preview/lib/keymap"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { useOverrides, type ActionDef } from "@/lib/keymap/registry"

// Text editing keys of the presentation editor that a user may rebind, PowerPoint's. Bold, italic, link, find and
// replace are the document editors' own actions (editor.bold, editor.italic, editor.link, editor.find,
// editor.replace), so one binding serves every editor. Center (Mod+E) shares its default with editor.code: the two
// never run together (the code and Markdown editors never mount inside a presentation, and a body being edited takes
// only the keys pressed in it), which lib/keymap/conflicts.ts lists once these actions are registered. The keys
// PowerPoint fixes (Enter, Backspace, Delete, arrows, Escape, Mod+Z/Y) are the text editor's own.
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
type ParagraphKeys = Pick<TextKeyBindings, "promote" | "demote" | "moveParagraphUp" | "moveParagraphDown" | "nextPlaceholder">

const MAC_PARAGRAPH: ParagraphKeys = {
	promote: "mod+bracketleft",
	demote: "mod+bracketright",
	moveParagraphUp: "",
	moveParagraphDown: "",
	nextPlaceholder: ""
}
const OTHER_PARAGRAPH: ParagraphKeys = {
	promote: "alt+shift+arrowleft",
	demote: "alt+shift+arrowright",
	moveParagraphUp: "alt+shift+arrowup",
	moveParagraphDown: "alt+shift+arrowdown",
	nextPlaceholder: "mod+enter"
}
const PARAGRAPH = isMacPlatform() ? MAC_PARAGRAPH : OTHER_PARAGRAPH

export const PRESENTATION_TEXT_ACTIONS: readonly (ActionDef & { readonly id: PresentationTextAction })[] = [
	{ id: "presentation.text.underline", defaultCombo: "mod+u", scope: "editor", descriptionKey: "preview:previewPptxShortcutUnderline" },
	{
		id: "presentation.text.subscript",
		defaultCombo: "mod+ctrl+equal",
		scope: "editor",
		descriptionKey: "preview:previewPptxShortcutSubscript"
	},
	{
		id: "presentation.text.superscript",
		defaultCombo: "mod+ctrl+shift+equal",
		scope: "editor",
		descriptionKey: "preview:previewPptxShortcutSuperscript"
	},
	{
		id: "presentation.text.clearFormatting",
		defaultCombo: "ctrl+space",
		scope: "editor",
		descriptionKey: "preview:previewPptxShortcutClearFormatting"
	},
	{
		id: "presentation.text.growFont",
		defaultCombo: "mod+shift+period",
		scope: "editor",
		descriptionKey: "preview:previewPptxShortcutGrowFont"
	},
	{
		id: "presentation.text.shrinkFont",
		defaultCombo: "mod+shift+comma",
		scope: "editor",
		descriptionKey: "preview:previewPptxShortcutShrinkFont"
	},
	{ id: "presentation.text.alignLeft", defaultCombo: "mod+l", scope: "editor", descriptionKey: "preview:previewPptxShortcutAlignLeft" },
	{
		id: "presentation.text.alignCenter",
		defaultCombo: "mod+e",
		scope: "editor",
		descriptionKey: "preview:previewPptxShortcutAlignCenter"
	},
	{ id: "presentation.text.alignRight", defaultCombo: "mod+r", scope: "editor", descriptionKey: "preview:previewPptxShortcutAlignRight" },
	{ id: "presentation.text.justify", defaultCombo: "mod+j", scope: "editor", descriptionKey: "preview:previewPptxShortcutJustify" },
	{
		id: "presentation.text.lineBreak",
		defaultCombo: "shift+enter",
		scope: "editor",
		descriptionKey: "preview:previewPptxShortcutLineBreak"
	},
	{ id: "presentation.text.levelDown", defaultCombo: "tab", scope: "editor", descriptionKey: "preview:previewPptxShortcutLevelDown" },
	{ id: "presentation.text.levelUp", defaultCombo: "shift+tab", scope: "editor", descriptionKey: "preview:previewPptxShortcutLevelUp" },
	{
		id: "presentation.text.promote",
		defaultCombo: PARAGRAPH.promote,
		scope: "editor",
		descriptionKey: "preview:previewPptxShortcutPromote"
	},
	{
		id: "presentation.text.demote",
		defaultCombo: PARAGRAPH.demote,
		scope: "editor",
		descriptionKey: "preview:previewPptxShortcutDemote"
	},
	{
		id: "presentation.text.moveParagraphUp",
		defaultCombo: PARAGRAPH.moveParagraphUp,
		scope: "editor",
		descriptionKey: "preview:previewPptxShortcutMoveParagraphUp"
	},
	{
		id: "presentation.text.moveParagraphDown",
		defaultCombo: PARAGRAPH.moveParagraphDown,
		scope: "editor",
		descriptionKey: "preview:previewPptxShortcutMoveParagraphDown"
	},
	{
		id: "presentation.text.nextPlaceholder",
		defaultCombo: PARAGRAPH.nextPlaceholder,
		scope: "editor",
		descriptionKey: "preview:previewPptxShortcutNextPlaceholder"
	}
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
	nextPlaceholder: "presentation.text.nextPlaceholder"
}

const DEFAULTS: ReadonlyMap<string, string> = new Map(
	[...PRESENTATION_TEXT_ACTIONS, ...PREVIEW_ACTIONS].map(action => [action.id, action.defaultCombo] as const)
)

// The text editor's keys with the user's overrides applied (each action's own default otherwise).
export function presentationTextBindings(overrides: Readonly<Record<string, string>>): TextKeyBindings {
	const bindings: Partial<Record<TextKeyCommand, string>> = {}

	for (const command of Object.keys(ACTION_OF) as TextKeyCommand[]) {
		const id = ACTION_OF[command]

		bindings[command] = overrides[id] ?? DEFAULTS.get(id) ?? ""
	}

	return bindings as TextKeyBindings
}

// The bindings for the mounted text editor, following overrides as the user changes them.
export function usePresentationTextBindings(): TextKeyBindings {
	return presentationTextBindings(useOverrides())
}
