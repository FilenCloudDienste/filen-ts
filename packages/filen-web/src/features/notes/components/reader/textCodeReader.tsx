import { CodeMirrorSource } from "@/features/preview/components/codeMirrorSource"
import { codeMirrorTagForNote } from "@/features/notes/components/reader/reader.logic"
import type { Note } from "@filen/sdk-rs"

// text/code note render — always read-only this step (editing arrives with the sync outbox next
// wave). Reuses the SAME CodeMirror language-loader/theme plumbing file preview uses, never a second
// copy (spec e1-reader).
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
