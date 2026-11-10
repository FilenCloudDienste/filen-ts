import type { Command } from "@codemirror/view"
import type { Extension } from "@codemirror/state"
import {
	CODE_EDITOR_SCOPE,
	CODE_SEARCH_SCOPE,
	codeKeymap,
	codeLanguageSupport,
	openReplacePanel,
	openSearchPanel,
	type CodeBinding
} from "@filen/office/dom/code"
import { isCodeLanguageId } from "@filen/office/core/code"
import { insertLink, MARKDOWN_MARKERS, toggleInlineMarker, toggleItalic } from "@filen/office/core/markdown"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { useComboFor } from "@/lib/keymap/registry"
import { editorKeyMatcher } from "@/features/preview/lib/editorKeys.logic"
import "@/features/preview/lib/codeMirrorTheme.css"

const IS_MAC = isMacPlatform()

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
	const bindings: CodeBinding[] = []
	const bind = (combo: string, run: Command, scope: string): void => {
		const matches = editorKeyMatcher(combo, IS_MAC)

		if (matches !== undefined) {
			bindings.push({ keys: [], matches, run, scope })
		}
	}

	// Find and replace also answer with focus in the search panel's own fields.
	bind(find, commands?.find ?? openSearchPanel, CODE_SEARCH_SCOPE)
	bind(replace, commands?.replace ?? openReplacePanel, CODE_SEARCH_SCOPE)

	// Ahead of CodeMirror's own keys for these, which open its panels.
	if (commands !== undefined) {
		bindings.push(
			{ keys: ["F3", "Mod-g"], run: commands.findNext, scope: CODE_EDITOR_SCOPE },
			{ keys: ["Shift-F3", "Mod-Shift-g"], run: commands.findPrevious, scope: CODE_EDITOR_SCOPE },
			{ keys: ["Mod-Alt-g"], run: commands.goToLine, scope: CODE_EDITOR_SCOPE }
		)
	}

	if (markdown) {
		bind(bold, toggleInlineMarker(MARKDOWN_MARKERS.bold), CODE_EDITOR_SCOPE)
		bind(italic, toggleItalic, CODE_EDITOR_SCOPE)
		bind(strikethrough, toggleInlineMarker(MARKDOWN_MARKERS.strikethrough), CODE_EDITOR_SCOPE)
		bind(code, toggleInlineMarker(MARKDOWN_MARKERS.code), CODE_EDITOR_SCOPE)
		bind(link, insertLink, CODE_EDITOR_SCOPE)
	}

	return codeKeymap(bindings)
}
