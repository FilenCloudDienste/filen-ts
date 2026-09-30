import { toast } from "sonner"
import { queryClient } from "@/queries/client"
import { cancelCached, invalidateCached } from "@/queries/patch"
import { i18n } from "@/lib/i18n"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { endEditingSession, reseedEditor } from "@/features/notes/store/useNotesInflight"
import { tabEditorBuffer, tabEditorSynced } from "@/features/notes/lib/tabEditors"

// A note's new version, taken in this tab: written straight into the content cache when it came with the
// event (a new dataUpdatedAt reseeds a shown editor, even while its session keeps the query disabled),
// otherwise read again. A note with no editor here is only invalidated: a mounted query reads it, and an
// unmounted one on its next open. `announce`: the note is on screen, and the save came from elsewhere, not
// from another tab of this browser, which would toast at every pause of the typing there.
export function takeRemoteContent(uuid: string, content: string | undefined, announce: boolean): void {
	const contentKey = noteContentQueryKey(uuid)
	const buffer = tabEditorBuffer(uuid)

	// Nothing changes on screen.
	if (buffer !== undefined && buffer === content) {
		tabEditorSynced(uuid, content, undefined)
		followContent(uuid, content)

		return
	}

	if (buffer === undefined) {
		invalidateCached(contentKey)
	} else if (content === undefined) {
		// Re-enables the query, so the invalidation reads.
		endEditingSession(uuid)
		invalidateCached(contentKey)
	} else {
		cancelCached(contentKey)
		queryClient.setQueryData<string>(contentKey, content)
	}

	if (announce) {
		toast(i18n.t("notes:noteUpdatedElsewhere"))
	}
}

// The editor on screen seeds again, from the outbox entry it may now show (useNoteEditor): its remount key
// moves, the content cache untouched (it may hold nothing: the note is never read while a draft is shown).
export function reseedTabEditor(uuid: string, announce: boolean): void {
	reseedEditor(uuid)

	if (announce) {
		toast(i18n.t("notes:noteUpdatedElsewhere"))
	}
}

// The content cache follows `content` without a new dataUpdatedAt, so a shown editor that already holds it
// stays mounted.
export function followContent(uuid: string, content: string): void {
	if (queryClient.getQueryData<string>(noteContentQueryKey(uuid)) === content) {
		return
	}

	writeContentKeepingRemountKey(uuid, content)
}

// Cancels first: a read in flight would otherwise land after the write and advance dataUpdatedAt, the
// editor's remount key.
export function writeContentKeepingRemountKey(uuid: string, content: string): void {
	const contentKey = noteContentQueryKey(uuid)
	const updatedAt = queryClient.getQueryState<string | undefined>(contentKey)?.dataUpdatedAt

	cancelCached(contentKey)
	queryClient.setQueryData<string>(contentKey, content, updatedAt !== undefined ? { updatedAt } : undefined)
}
