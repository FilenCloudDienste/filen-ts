import { useNoteContentQuery } from "@/features/notes/queries/noteContent"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import type { Note } from "@filen/sdk-rs"

// Read-side wrapper the reader dispatches on — same discriminated-result shape usePreviewBytes uses,
// so the reader's pending/error branches read identically to every other buffered-content viewer in
// this app. `note === undefined` folds into "pending" (the editor route's first render, before the
// notes list query has resolved the selection) rather than a fourth state no caller needs to branch on.
export type NoteContentResult =
	{ status: "pending" } | { status: "success"; content: string; dataUpdatedAt: number } | { status: "error"; dto: ErrorDTO }

export function useNoteContent(note: Note | undefined): NoteContentResult {
	const query = useNoteContentQuery(note)

	if (query.isPending) {
		return { status: "pending" }
	}

	if (query.isError) {
		return { status: "error", dto: asErrorDTO(query.error) }
	}

	// getNoteContent resolves `undefined` for a note with no content yet (fresh create) — the reader
	// treats that identically to an empty string, never a loading/error state.
	return { status: "success", content: query.data ?? "", dataUpdatedAt: query.dataUpdatedAt }
}
