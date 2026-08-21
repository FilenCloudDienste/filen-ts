import type { TextEditorType } from "@/components/textEditor"

/**
 * CodeMirror stamps `autocapitalize`, `autocorrect` and `spellcheck` off on its own contenteditable
 * because, in its words, they get in the way in a code editor. A plain-text or markdown note is
 * prose, not code, so those three are handed back to the platform and the keyboard applies whatever
 * the user configured for themselves.
 *
 * `writingsuggestions` is deliberately NOT in this set. Upstream disables it because Safari's
 * completions corrupt the document — a correctness workaround, not a preference.
 *
 * Returns null when the editor is showing code, which keeps CodeMirror's own defaults. Note this
 * must key off the note TYPE, not the filename: a code note may be titled "foo.txt".
 */
export function proseContentAttributes(type: TextEditorType): Record<string, string> | null {
	if (type !== "text" && type !== "markdown") {
		return null
	}

	return {
		autocapitalize: "sentences",
		autocorrect: "on",
		spellcheck: "true"
	}
}
