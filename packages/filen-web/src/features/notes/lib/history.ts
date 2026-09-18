import type { Note, NoteHistory } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import { log } from "@/lib/log"
import { notesQueryUpsert } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import useNotesInflightStore, { endEditingSession } from "@/features/notes/store/useNotesInflight"
import { sync } from "@/features/notes/lib/sync"
import { asErrorDTO } from "@/lib/sdk/errors"
import { runOp, type ActionOutcome } from "@/lib/actions/outcome"

export type { ActionOutcome }

// Restore-from-history — the history dialog's own action. Mirrors mobile's restoreFromHistory
// (notesLifecycle.ts) inflight-clear sequencing VERBATIM: the restored version
// wins outright, so any unsynced local edit for this note must never survive to be pushed back over
// it by the outbox's next pass. This is the same drop-entry/clear-rejections/flush-to-disk seam
// socketHandlers.ts's reloadRemoteEdit already uses for the analogous "server wins" case.
export async function restoreNoteFromHistory(note: Note, history: NoteHistory): Promise<ActionOutcome<Note>> {
	let updated: Note

	try {
		updated = await runOp(sdkApi.restoreNoteFromHistory(note, history))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	notesQueryUpsert(updated)

	// Drop any unsynced local content for this note BEFORE touching the content cache below — the
	// content query is disabled while the user is editing (enabled: !editing), so dropping the entry AND
	// closing the session first re-enables it in time for the cache write/invalidate that follows to
	// actually take effect. A restore is a deliberate reseed, so ending a live session is the point.
	sync.dropEntry(updated.uuid)
	sync.clearRejections(updated.uuid)
	endEditingSession(updated.uuid)

	const flushed = await sync.flushToDisk(useNotesInflightStore.getState().inflightContent)

	if (!flushed) {
		log.warn("notes", "restore from history: outbox flush failed", updated.uuid)
	}

	const contentKey = noteContentQueryKey(updated.uuid)

	if (history.content !== undefined) {
		// Paint the known restored content directly (mobile's own optimistic write) — a plain
		// setQueryData bumps dataUpdatedAt (the editor's remount key), so a mounted editor reseeds with
		// the restored text immediately, no round trip needed.
		queryClient.setQueryData<string>(contentKey, history.content)
	} else {
		// Unknown content (mobile parity: "leave the cached content untouched... let the next per-note
		// fetch reconcile") — invalidate so the now re-enabled query refetches on its next observer.
		void queryClient.invalidateQueries({ queryKey: contentKey })
	}

	return { status: "success", item: updated }
}
