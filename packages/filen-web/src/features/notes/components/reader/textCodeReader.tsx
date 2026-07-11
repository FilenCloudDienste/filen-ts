import { CodeMirrorSource } from "@/features/preview/components/codeMirrorSource"
import { codeMirrorTagForNote } from "@/features/notes/components/reader/reader.logic"
import type { Note } from "@filen/sdk-rs"

// text/code note render — read-only here: NoteReaderByType only mounts this for read-only contexts
// (a trashed/non-writable note, or the history dialog's preview); the editable path is
// noteTextCodeEditor.tsx. Reuses the SAME CodeMirror language-loader/theme plumbing file preview uses,
// never a second copy.
export function TextCodeReader({ note, content }: { note: Note; content: string }) {
	return (
		<CodeMirrorSource
			text={content}
			tag={codeMirrorTagForNote(note)}
			alt={note.title ?? ""}
			editable={false}
		/>
	)
}
