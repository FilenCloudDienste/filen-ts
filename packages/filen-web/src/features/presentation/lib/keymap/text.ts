import type { TextKeyBindings, TextKeyCommand } from "@filen/office/react/presentation"
import { PREVIEW_ACTIONS } from "@/features/preview/lib/keymap"
import { useOverrides, type ActionDef } from "@/lib/keymap/registry"

// Text editing keys of the presentation editor that a user may rebind, PowerPoint's. Bold, italic, link, find and
// replace are the document editors' own actions (editor.bold, editor.italic, editor.link, editor.find,
// editor.replace), so one binding serves every editor. Center (Mod+E) shares its default with editor.code: the two
// never run together (the code and Markdown editors never mount inside a presentation, and a body being edited takes
// only the keys pressed in it), which lib/keymap/conflicts.ts lists once these actions are registered. The keys
// PowerPoint fixes (Enter, Backspace, Delete, arrows, Escape, Mod+Z/Y) are the text editor's own.
export type PresentationTextAction =
	| "presentation.text.underline"
	| "presentation.text.growFont"
	| "presentation.text.shrinkFont"
	| "presentation.text.alignLeft"
	| "presentation.text.alignCenter"
	| "presentation.text.alignRight"
	| "presentation.text.justify"
	| "presentation.text.lineBreak"
	| "presentation.text.levelDown"
	| "presentation.text.levelUp"

export const PRESENTATION_TEXT_ACTIONS: readonly (ActionDef & { readonly id: PresentationTextAction })[] = [
	{ id: "presentation.text.underline", defaultCombo: "mod+u", scope: "editor", descriptionKey: "preview:previewPptxShortcutUnderline" },
	{
		id: "presentation.text.growFont",
		defaultCombo: "mod+shift+.",
		scope: "editor",
		descriptionKey: "preview:previewPptxShortcutGrowFont"
	},
	{
		id: "presentation.text.shrinkFont",
		defaultCombo: "mod+shift+,",
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
	{ id: "presentation.text.levelUp", defaultCombo: "shift+tab", scope: "editor", descriptionKey: "preview:previewPptxShortcutLevelUp" }
]

// The action each of the text editor's rebindable keys runs: this list's, and the document editors' bold, italic and
// link.
const ACTION_OF: Readonly<Record<TextKeyCommand, string>> = {
	bold: "editor.bold",
	italic: "editor.italic",
	link: "editor.link",
	underline: "presentation.text.underline",
	growFont: "presentation.text.growFont",
	shrinkFont: "presentation.text.shrinkFont",
	alignLeft: "presentation.text.alignLeft",
	alignCenter: "presentation.text.alignCenter",
	alignRight: "presentation.text.alignRight",
	justify: "presentation.text.justify",
	lineBreak: "presentation.text.lineBreak",
	levelDown: "presentation.text.levelDown",
	levelUp: "presentation.text.levelUp"
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
