import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, toggleComment, undo } from "@codemirror/commands"
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting } from "@codemirror/language"
import { lintKeymap } from "@codemirror/lint"
import { highlightSelectionMatches } from "@codemirror/search"
import { EditorState, type Extension } from "@codemirror/state"
import {
	drawSelection,
	dropCursor,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
	type KeyBinding
} from "@codemirror/view"

export interface CodeEditorSetupOptions {
	// False leaves the line numbers to the app (one it can switch, in a Compartment of its own: codeLineNumbers).
	readonly lineNumbers?: boolean
}

// The line-number gutter, one value so a Compartment holding it compares equal.
export const codeLineNumbers: Extension = lineNumbers()

// CodeMirror's keys an app binds itself through codeKeymap, on keys its user can change: undo and redo, toggle comment
// and the fold keys. Left in, they would keep firing on CodeMirror's keys after a rebind.
const APP_BOUND_COMMANDS: ReadonlySet<unknown> = new Set([undo, redo, toggleComment])
const EDITOR_KEYMAP: readonly KeyBinding[] = [
	...closeBracketsKeymap,
	...defaultKeymap.filter(binding => !APP_BOUND_COMMANDS.has(binding.run)),
	...historyKeymap.filter(binding => !APP_BOUND_COMMANDS.has(binding.run)),
	...completionKeymap,
	...lintKeymap
]

// CodeMirror's basic setup, without the search keymap (its Mod-f would shadow a rebound find), the fold keys and the
// commands above: an app binds those through codeKeymap instead. Tab indents, as in every code editor here.
export function codeEditorSetup(options?: CodeEditorSetupOptions): Extension {
	return [
		options?.lineNumbers === false ? [] : codeLineNumbers,
		highlightActiveLineGutter(),
		highlightSpecialChars(),
		history(),
		foldGutter(),
		drawSelection(),
		dropCursor(),
		EditorState.allowMultipleSelections.of(true),
		indentOnInput(),
		syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
		bracketMatching(),
		closeBrackets(),
		autocompletion(),
		rectangularSelection(),
		highlightActiveLine(),
		highlightSelectionMatches(),
		keymap.of(EDITOR_KEYMAP),
		keymap.of([indentWithTab])
	]
}

// Every English string the installed CodeMirror extensions read through state.phrase (view, language, search, merge,
// autocomplete, commands, lint): the keys an app's codePhrases map translates. "$" is a number CodeMirror fills in.
// tests/codeEditor.dom.test.tsx checks the list against the installed sources, so an upgrade that adds or drops one fails.
export const CODE_PHRASES = [
	"Control character",
	"close",
	"folded code",
	"unfold",
	"Fold line",
	"Unfold line",
	"Folded lines",
	"Unfolded lines",
	"to",
	"Find",
	"Replace",
	"next",
	"previous",
	"all",
	"match case",
	"regexp",
	"by word",
	"replace",
	"replace all",
	"current match",
	"on line",
	"replaced match on line $",
	"replaced $ matches",
	"Go to line",
	"go",
	"$ unchanged lines",
	"Accept",
	"Reject",
	"Revert this chunk",
	"Completions",
	"Selection deleted",
	"Diagnostics",
	"No diagnostics"
] as const

export type CodePhrase = (typeof CODE_PHRASES)[number]

// CodeMirror's own labels and announcements in the app's language. A new map (a language change) redraws the editor.
export function codePhrases(map: Readonly<Record<CodePhrase, string>>): Extension {
	return EditorState.phrases.of(map)
}

// The editor fills its parent, which must be height-bounded; the scroller scrolls inside it.
export const codeFillParent: Extension = EditorView.theme({
	"&": { height: "100%" },
	"& .cm-scroller": { height: "100% !important" }
})

// Still a Tab and F6 stop: browsers focus a non-editable element only with a tab index, and the text is read with the
// keyboard (scrolled, selected, copied) as when it can be edited.
const LOCKED: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ tabindex: "0" })]
const UNLOCKED: Extension = []

// A read-only, non-editable editor (no caret, no input). One value per state, so its identity is stable.
export function codeReadOnly(readOnly: boolean): Extension {
	return readOnly ? LOCKED : UNLOCKED
}
