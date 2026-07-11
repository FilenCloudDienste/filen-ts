import { extensionOf, codeMirrorLanguageFor } from "@/features/drive/lib/preview.logic"
import type { Note } from "@filen/sdk-rs"

// CodeMirror language tag for a "code"/"md" note's read-only render. There is no per-note language
// field on the SDK, so a "code" note derives its tag from the note's OWN title extension — the same
// extension->language map file preview uses for a drive file's name (features/drive/lib/preview.logic)
// — so naming a code note "foo.rs" highlights it as Rust with no new SDK surface. "md" is always the
// "markdown" grammar regardless of title; "text" renders unhighlighted ("").
export function codeMirrorTagForNote(note: Note): string {
	if (note.noteType === "md") {
		return "markdown"
	}

	if (note.noteType === "code") {
		return codeMirrorLanguageFor(extensionOf(note.title ?? ""))
	}

	return ""
}
