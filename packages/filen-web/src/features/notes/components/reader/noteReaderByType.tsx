import type { Note } from "@filen/sdk-rs"
import { TextCodeReader } from "@/features/notes/components/reader/textCodeReader"
import { MarkdownReader } from "@/features/notes/components/reader/markdownReader"
import { RichReader } from "@/features/notes/components/reader/richReader"
import { ChecklistReader } from "@/features/notes/components/reader/checklistReader"

// Per-type read-only dispatch, shared by the live editor's own read-only branch (noteContentBody.tsx —
// a trashed/non-writable note) and the history dialog's version preview (historyDialog.tsx — always
// read-only regardless of the note's own current writable state). One switch over NoteType's 5
// members, exhaustive so a future variant fails to compile until mapped here.
export function NoteReaderByType({ note, content }: { note: Note; content: string }) {
	switch (note.noteType) {
		case "text":
		case "code":
			return (
				<TextCodeReader
					note={note}
					content={content}
				/>
			)
		case "md":
			return (
				<MarkdownReader
					note={note}
					content={content}
				/>
			)
		case "rich":
			return <RichReader content={content} />
		case "checklist":
			return <ChecklistReader content={content} />
	}
}
