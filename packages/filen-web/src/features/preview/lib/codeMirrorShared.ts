import type { Command } from "@codemirror/view"
import { redo, toggleComment, undo } from "@codemirror/commands"
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language"
import { findNext, findPrevious, gotoLine } from "@codemirror/search"
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

// Undo and redo keep the key with nothing left to undo, as CodeMirror's own keys do: the browser's would act instead.
function takeAlways(command: Command): Command {
	return view => {
		command(view)

		return true
	}
}

const UNDO = takeAlways(undo)
const REDO = takeAlways(redo)

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
	const undoCombo = useComboFor("editor.undo")
	const redoCombo = useComboFor("editor.redo")
	const findNextCombo = useComboFor("editor.findNext")
	const findPreviousCombo = useComboFor("editor.findPrevious")
	const goToLine = useComboFor("editor.goToLine")
	const comment = useComboFor("editor.toggleComment")
	const fold = useComboFor("editor.fold")
	const unfold = useComboFor("editor.unfold")
	const foldAllCombo = useComboFor("editor.foldAll")
	const unfoldAllCombo = useComboFor("editor.unfoldAll")
	const bindings: CodeBinding[] = []
	const bind = (combo: string, run: Command, scope: string): void => {
		const matches = editorKeyMatcher(combo, IS_MAC)

		if (matches !== undefined) {
			bindings.push({ keys: [], matches, run, scope })
		}
	}

	// Find, replace and the next and previous match also answer with focus in the search panel's own fields. A host's
	// own find takes CodeMirror's panel's place.
	bind(find, commands?.find ?? openSearchPanel, CODE_SEARCH_SCOPE)
	bind(replace, commands?.replace ?? openReplacePanel, CODE_SEARCH_SCOPE)
	bind(findNextCombo, commands?.findNext ?? findNext, CODE_SEARCH_SCOPE)
	bind(findPreviousCombo, commands?.findPrevious ?? findPrevious, CODE_SEARCH_SCOPE)
	bind(goToLine, commands?.goToLine ?? gotoLine, CODE_EDITOR_SCOPE)
	// CodeMirror's own commands, on the user's keys (dom/code's setup leaves CodeMirror's keys for them out).
	bind(undoCombo, UNDO, CODE_EDITOR_SCOPE)
	bind(redoCombo, REDO, CODE_EDITOR_SCOPE)
	bind(comment, toggleComment, CODE_EDITOR_SCOPE)
	bind(fold, foldCode, CODE_EDITOR_SCOPE)
	bind(unfold, unfoldCode, CODE_EDITOR_SCOPE)
	bind(foldAllCombo, foldAll, CODE_EDITOR_SCOPE)
	bind(unfoldAllCombo, unfoldAll, CODE_EDITOR_SCOPE)

	if (markdown) {
		bind(bold, toggleInlineMarker(MARKDOWN_MARKERS.bold), CODE_EDITOR_SCOPE)
		bind(italic, toggleItalic, CODE_EDITOR_SCOPE)
		bind(strikethrough, toggleInlineMarker(MARKDOWN_MARKERS.strikethrough), CODE_EDITOR_SCOPE)
		bind(code, toggleInlineMarker(MARKDOWN_MARKERS.code), CODE_EDITOR_SCOPE)
		bind(link, insertLink, CODE_EDITOR_SCOPE)
	}

	return codeKeymap(bindings)
}
