import { openSearchPanel, searchKeymap } from "@codemirror/search"
import { Prec, type Extension } from "@codemirror/state"
import { keymap, type Command, type EditorView, type KeyBinding } from "@codemirror/view"

// The search panel with its replace field focused; a read-only editor's panel has none and keeps the
// search field.
export const openReplacePanel: Command = view => {
	openSearchPanel(view)

	const replaceField = view.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]")

	replaceField?.focus()
	replaceField?.select()

	return true
}

export { openSearchPanel }

// CodeMirror's own search bindings but find, the next and previous match and go to line (Mod-f, F3, Mod-g, Mod-Alt-g),
// which an app binds to its own, rebindable keys.
const APP_BOUND_KEYS: ReadonlySet<string | undefined> = new Set(["Mod-f", "F3", "Mod-g", "Mod-Alt-g"])
const SEARCH_BINDINGS: readonly KeyBinding[] = searchKeymap.filter(binding => !APP_BOUND_KEYS.has(binding.key))

// Bindings as CodeMirror key names, or as a test of the keydown (an app's own matcher: CodeMirror matches names by
// character, an app may match by physical key); a scope limits one to those parts of the editor.
export interface CodeBinding {
	readonly keys: readonly string[]
	readonly matches?: (event: KeyboardEvent) => boolean
	readonly run: Command
	readonly scope?: string
}

// The editor scope, and the editor plus its search panel's own fields (find and replace answer there too).
export const CODE_EDITOR_SCOPE = "editor"
export const CODE_SEARCH_SCOPE = "editor search-panel"

// The app's bindings ahead of CodeMirror's own, followed by the search panel's.
export function codeKeymap(bindings: readonly CodeBinding[]): Extension {
	const keyBindings: KeyBinding[] = []

	for (const binding of bindings) {
		const { matches, run, scope } = binding

		for (const key of binding.keys) {
			keyBindings.push(scope === undefined ? { key, run } : { key, run, scope })
		}

		// Run for every key ahead of the bindings after it (CodeMirror's `any`), and taken (default prevented) when it ran.
		if (matches !== undefined) {
			const any = (view: EditorView, event: KeyboardEvent): boolean => matches(event) && run(view)

			keyBindings.push(scope === undefined ? { any } : { any, scope })
		}
	}

	keyBindings.push(...SEARCH_BINDINGS)

	return Prec.high(keymap.of(keyBindings))
}
