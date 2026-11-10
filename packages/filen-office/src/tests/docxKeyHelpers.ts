import type { DocxEditorCommand, DocxEditorCommandType } from "../core/docx/edit/index"
import { docxKeyBindings, docxKeyFor, type DocxAppKey, type KeyLike } from "../core/docx/paged/keys"

// What a key press runs under Word's default keys on a platform, by kind: the editor command, the host's command, the
// app's key (find, replace, Go To, Repeat).

export function commandForKey(event: KeyLike, apple: boolean, desktop = false): DocxEditorCommand | undefined {
	const run = docxKeyFor(event, docxKeyBindings(apple, desktop), apple)

	return run?.kind === "command" ? run.command : undefined
}

export function hostCommandForKey(event: KeyLike, apple: boolean, desktop = false): DocxEditorCommandType | undefined {
	const run = docxKeyFor(event, docxKeyBindings(apple, desktop), apple)

	return run?.kind === "host" ? run.type : undefined
}

export function appKeyFor(event: KeyLike, apple: boolean, desktop = false): DocxAppKey | undefined {
	const run = docxKeyFor(event, docxKeyBindings(apple, desktop), apple)

	return run?.kind === "app" ? run.key : undefined
}
