import type { Command } from "@codemirror/view"
import type { Extension } from "@codemirror/state"
import {
	CODE_EDITOR_SCOPE,
	CODE_SEARCH_SCOPE,
	codeKeymap,
	codeLanguageSupport,
	openReplacePanel,
	openSearchPanel
} from "@filen/office/dom/code"
import { isCodeLanguageId } from "@filen/office/core/code"
import { insertLink, MARKDOWN_MARKERS, toggleInlineMarker, toggleItalic } from "@filen/office/core/markdown"
import { useComboFor } from "@/lib/keymap/registry"
import { codeMirrorKeys } from "@/features/preview/lib/editorKeys.logic"
import "@/features/preview/lib/codeMirrorTheme.css"

// The language, theme and keymap plumbing every CodeMirror surface shares: the editor/reader
// (codeMirrorSource.tsx) and the remote-change comparison (remoteCompare.tsx). The theme is the package's
// codeTheme: every colour a --fo-code-* variable (codeMirrorTheme.css, loaded here), so a theme change, the
// OS flipping a system theme included, restyles the editors with no reconfiguration.

// `tag` (from codeMirrorLanguageFor) as its language Extension, or null for a tag with no grammar ("": the
// content still renders, just unhighlighted).
export function languageExtensionFor(tag: string): Extension | null {
	return isCodeLanguageId(tag) ? codeLanguageSupport(tag) : null
}

// A host's own find (the text viewers' command bar): find, replace, the next and previous match and go to line, in
// place of CodeMirror's panels. Stable for the editor's life (a new value rebuilds the keymap).
export interface EditorKeymapCommands {
	readonly find: Command
	readonly replace: Command
	readonly findNext: Command
	readonly findPrevious: Command
	readonly goToLine: Command
}

// The editor shortcuts (features/preview/lib/keymap.ts), bound inside CodeMirror so they act on the
// focused editor only, and follow whatever the user rebound them to. The markdown ones only in a markdown
// editor.
export function useEditorKeymap(markdown: boolean, commands?: EditorKeymapCommands): Extension {
	const find = useComboFor("editor.find")
	const replace = useComboFor("editor.replace")
	const bold = useComboFor("editor.bold")
	const italic = useComboFor("editor.italic")
	const strikethrough = useComboFor("editor.strikethrough")
	const code = useComboFor("editor.code")
	const link = useComboFor("editor.link")
	const bindings: { keys: readonly string[]; run: Command; scope: string }[] = [
		// Find and replace also answer with focus in the search panel's own fields.
		{ keys: codeMirrorKeys(find), run: commands?.find ?? openSearchPanel, scope: CODE_SEARCH_SCOPE },
		{ keys: codeMirrorKeys(replace), run: commands?.replace ?? openReplacePanel, scope: CODE_SEARCH_SCOPE }
	]

	// Ahead of CodeMirror's own keys for these, which open its panels.
	if (commands !== undefined) {
		bindings.push(
			{ keys: ["F3", "Mod-g"], run: commands.findNext, scope: CODE_EDITOR_SCOPE },
			{ keys: ["Shift-F3", "Mod-Shift-g"], run: commands.findPrevious, scope: CODE_EDITOR_SCOPE },
			{ keys: ["Mod-Alt-g"], run: commands.goToLine, scope: CODE_EDITOR_SCOPE }
		)
	}

	if (markdown) {
		bindings.push(
			{ keys: codeMirrorKeys(bold), run: toggleInlineMarker(MARKDOWN_MARKERS.bold), scope: CODE_EDITOR_SCOPE },
			{ keys: codeMirrorKeys(italic), run: toggleItalic, scope: CODE_EDITOR_SCOPE },
			{ keys: codeMirrorKeys(strikethrough), run: toggleInlineMarker(MARKDOWN_MARKERS.strikethrough), scope: CODE_EDITOR_SCOPE },
			{ keys: codeMirrorKeys(code), run: toggleInlineMarker(MARKDOWN_MARKERS.code), scope: CODE_EDITOR_SCOPE },
			{ keys: codeMirrorKeys(link), run: insertLink, scope: CODE_EDITOR_SCOPE }
		)
	}

	return codeKeymap(bindings)
}
