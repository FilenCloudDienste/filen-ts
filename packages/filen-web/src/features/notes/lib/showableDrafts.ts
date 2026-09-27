import { newestEntry } from "@/features/notes/lib/sync.logic"
import { reseedTabEditor } from "@/features/notes/lib/remoteContent"
import { shownTabEditors, tabEditorBuffer, tabEditorDirty } from "@/features/notes/lib/tabEditors"
import useNotesInflightStore, { TAB_ID, entryIsShowable, type InflightEntry } from "@/features/notes/store/useNotesInflight"
import { useNotesRemoteEditStore } from "@/features/notes/store/useNoteRemoteEdit"

// An entry that becomes showable (an orphan: its tab is gone) under an editor already on screen is a version
// of the note from elsewhere, which that editor never showed: a clean editor takes it, one with typing of
// its own is asked. Otherwise the next keystroke there would replace it unseen.
export function followShowableDrafts(): () => void {
	return useNotesInflightStore.subscribe((state, prev) => {
		for (const uuid of shownTabEditors()) {
			const next = newestShowable(state.inflightContent[uuid])
			const before = newestShowable(prev.inflightContent[uuid])

			if (
				next === undefined ||
				next === before ||
				next.origin === TAB_ID ||
				next.orphan !== true ||
				next.content === before?.content ||
				next.content === tabEditorBuffer(uuid)
			) {
				continue
			}

			if (tabEditorDirty(uuid)) {
				useNotesRemoteEditStore
					.getState()
					.setRemoteEdited(
						uuid,
						next.baseContentHash === undefined ? { theirs: next.content } : { theirs: next.content, base: next.baseContentHash }
					)
			} else {
				reseedTabEditor(uuid, useNotesRemoteEditStore.getState().openNote === uuid)
			}
		}
	})
}

function newestShowable(entries: InflightEntry[] | undefined): InflightEntry | undefined {
	return newestEntry((entries ?? []).filter(entryIsShowable))
}
