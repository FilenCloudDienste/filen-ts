import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language"
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
	rectangularSelection
} from "@codemirror/view"

export interface CodeEditorSetupOptions {
	// False leaves the line numbers to the app (one it can switch, in a Compartment of its own: codeLineNumbers).
	readonly lineNumbers?: boolean
}

// The line-number gutter, one value so a Compartment holding it compares equal.
export const codeLineNumbers: Extension = lineNumbers()

// CodeMirror's basic setup, without the search keymap: its Mod-f would shadow a rebound find (an app binds
// search through codeKeymap instead). Tab indents, as in every code editor here.
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
		keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap]),
		keymap.of([indentWithTab])
	]
}

// The editor fills its parent, which must be height-bounded; the scroller scrolls inside it.
export const codeFillParent: Extension = EditorView.theme({
	"&": { height: "100%" },
	"& .cm-scroller": { height: "100% !important" }
})

const LOCKED: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false)]
const UNLOCKED: Extension = []

// A read-only, non-editable editor (no caret, no input). One value per state, so its identity is stable.
export function codeReadOnly(readOnly: boolean): Extension {
	return readOnly ? LOCKED : UNLOCKED
}
