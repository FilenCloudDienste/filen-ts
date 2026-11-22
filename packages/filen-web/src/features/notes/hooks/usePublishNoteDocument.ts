import type { Note } from "@filen/sdk-rs"
import { usePublishActiveDocument, type SelectionReader } from "@/lib/activeDocument"
import { readWholeText } from "@/features/preview/lib/documentReaders"
import { tabNoteContent } from "@/features/notes/lib/tabEditors"
import { notePlainText } from "@/features/notes/lib/notePlainText"

// The note in the editor, published as the open document while its editor is mounted: its selection through the
// editor's transform host, its text as this tab holds it (what was typed first), read only when a reader asks.
// Returns what an editor drawing its own selection calls on a selection change.
export function usePublishNoteDocument(note: Note, selection: SelectionReader): () => void {
	return usePublishActiveDocument(
		{ kind: "note", note },
		{
			kind: "note",
			position: {},
			editable: true,
			selection,
			reader: {
				units: () => Promise.resolve(1),
				text: (_range, signal, maxChars) =>
					readWholeText(() => notePlainText(note, tabNoteContent(note.uuid) ?? ""), signal, maxChars)
			}
		}
	)
}
