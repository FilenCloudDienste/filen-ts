import type { Note } from "@filen/sdk-rs"
import { newestEntry } from "@filen/shared"
import { i18n } from "@/lib/i18n"
import { plainErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { runOp } from "@/lib/actions/outcome"
import { queryClient } from "@/queries/client"
import { noteContentQueryKey, readNoteContent, type NoteContentResult } from "@/features/notes/queries/noteContent"
import { useNotesInflightStore } from "@/features/notes/store/useNotesInflight"

// A note's content AS THIS CLIENT KNOWS IT — the same precedence the editor's seed applies
// (deriveEditorSeed): an unsynced outbox edit first, then the content query cache, `undefined` when
// neither holds it. The cache only advances AFTER a successful push (sync.ts), so any surface that
// hands the user their content — export, copy — must go through here or it reports text the user can
// see is stale, which is exactly the case those affordances stay enabled offline for.
export function localNoteContent(uuid: string): string | undefined {
	return (
		newestEntry(useNotesInflightStore.getState().inflightContent[uuid])?.content ??
		queryClient.getQueryData<string | undefined>(noteContentQueryKey(uuid))
	)
}

// Local-first, then fetch: a note already open in the editor has its content warm, so copy/export cost
// no extra round trip. Content that exists but never decrypted is reported as such, never coalesced to
// "" (an empty export is not a backup). A fetch failure propagates as a thrown ErrorDTO (runOp).
export async function resolveLocalFirstContent(note: Note): Promise<NoteContentResult> {
	const local = localNoteContent(note.uuid)

	if (local !== undefined) {
		return { status: "ok", content: local }
	}

	return runOp(readNoteContent(note))
}

export function noteUndecryptableError(): ErrorDTO {
	return plainErrorDTO(i18n.t("notes:noteContentUndecryptableError"))
}
