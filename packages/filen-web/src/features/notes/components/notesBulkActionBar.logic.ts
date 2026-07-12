import { type LucideIcon } from "lucide-react"
import type { Note, NoteTag } from "@filen/sdk-rs"
import { NOTE_ACTION_DEFS } from "@/features/notes/lib/actionDefs"
import { type NoteSelectionFlags } from "@/features/notes/lib/selectionFlags"
import { type NotesKey } from "@/lib/i18n"

// Dialog kinds the notes bulk-action bar can ask useNoteDialogHost to open — disjoint from
// NoteActionDialogKind (noteMenu.logic.ts) since none of these ever carry a single Note. Trash stays
// direct/unconfirmed for a single note (noteMenuActions' TRASH) but IS confirmed in bulk (mobile's
// own "(destructive, confirmed)" annotation on Trash/Delete/Leave selected) — the one place bulk and
// single-item note dispositions diverge.
export type NoteBulkDialogActionKind = "trashSelected" | "deleteSelected" | "leaveSelected"

interface NoteBulkActionDescriptorShared {
	id: "pin" | "favorite" | "type" | "tags" | "duplicate" | "export" | "archive" | "restore" | "trash" | "delete" | "leave"
	labelKey: NotesKey
	icon: LucideIcon
	destructive?: boolean
}

// "direct" resolves immediately; "dialog" asks the host to open the given bulk-confirm kind;
// "submenu" opens its own small popover (type picker / tri-state tag list) — mirrors
// noteMenu.logic.ts's NoteActionDescriptor union, widened with "dialog" carrying a
// NoteBulkDialogActionKind instead of NoteActionDialogKind.
export type NoteBulkActionDescriptor =
	| (NoteBulkActionDescriptorShared & { run: "direct" })
	| (NoteBulkActionDescriptorShared & { run: "dialog"; dialogKind: NoteBulkDialogActionKind })
	| (NoteBulkActionDescriptorShared & { run: "submenu"; submenu: "type" | "tags" })

// Pure gating builder for the notes bulk-action bar — mirrors bulkActionBar.logic.ts's
// driveBulkActions (variant/flag-gated descriptor list, testable without rendering anything). Ported
// from mobile's notesHeaderMenuBuilders.ts bulk-button gating (behavior only): pin/favorite/type/
// tags/duplicate/export need decrypted metadata (suppressed selection-wide by includesUndecryptable);
// type additionally needs write access to every selected note; archive/restore/trash/delete are
// owner-only lifecycle transitions (everyOwned) further gated by the selection's own archive/trash
// state; leave is the non-owner-participant mirror of trash/delete.
export function noteBulkActions(flags: NoteSelectionFlags): NoteBulkActionDescriptor[] {
	const descriptors: NoteBulkActionDescriptor[] = []

	if (!flags.includesUndecryptable) {
		// Pin/Favorite first — most-tapped, matches mobile's own ordering. SET semantics: the label/icon
		// reflect the value this bar will apply to the WHOLE selection, not any single note's own flag.
		descriptors.push({
			id: "pin",
			...(flags.includesPinned ? NOTE_ACTION_DEFS.unpin : NOTE_ACTION_DEFS.pin),
			run: "direct"
		})
		descriptors.push({
			id: "favorite",
			...(flags.includesFavorited ? NOTE_ACTION_DEFS.unfavorite : NOTE_ACTION_DEFS.favorite),
			run: "direct"
		})

		if (flags.hasWriteAccessToAll) {
			descriptors.push({ id: "type", ...NOTE_ACTION_DEFS.type, run: "submenu", submenu: "type" })
		}

		descriptors.push({ id: "tags", ...NOTE_ACTION_DEFS.tags, run: "submenu", submenu: "tags" })
		descriptors.push({ id: "duplicate", ...NOTE_ACTION_DEFS.duplicate, run: "direct" })
		descriptors.push({ id: "export", ...NOTE_ACTION_DEFS.export, run: "direct" })
	}

	if (flags.everyOwned) {
		// Archive: every note must be active (no archived, no trashed) and none undecryptable — the
		// per-note menu drops Archive for an undecryptable note too, the bulk mirror does the same.
		if (!flags.includesArchived && !flags.includesTrashed && !flags.includesUndecryptable) {
			descriptors.push({ id: "archive", ...NOTE_ACTION_DEFS.archive, run: "direct" })
		}

		// Restore: every note must be archived or trashed. For an undecryptable selection the per-note
		// menu only offers Restore once trashed (Archive itself is impossible on an undecryptable note),
		// so the bulk mirror requires everyTrashed once undecryptable is in the mix.
		if (flags.everyArchivedOrTrashed && (!flags.includesUndecryptable || flags.everyTrashed)) {
			descriptors.push({ id: "restore", ...NOTE_ACTION_DEFS.restore, run: "direct" })
		}

		// Trash: none of the selection may already be trashed. Survives includesUndecryptable — a
		// pure-uuid disposition, same as the per-note TRASH descriptor.
		if (!flags.includesTrashed) {
			descriptors.push({ id: "trash", ...NOTE_ACTION_DEFS.trash, run: "dialog", dialogKind: "trashSelected" })
		}

		// Delete permanently: every note must already be trashed.
		if (flags.everyTrashed) {
			descriptors.push({
				id: "delete",
				...NOTE_ACTION_DEFS.deletePermanently,
				run: "dialog",
				dialogKind: "deleteSelected"
			})
		}
	}

	if (flags.participantOfEveryAndNotOwner) {
		descriptors.push({ id: "leave", ...NOTE_ACTION_DEFS.leave, run: "dialog", dialogKind: "leaveSelected" })
	}

	return descriptors
}

export interface NoteBulkTagSubmenuEntry {
	tag: NoteTag
	// True iff EVERY selected note already carries this tag. The underlying checkbox primitive has no
	// third (indeterminate) state, so a "some but not all" tag renders unchecked here too — clicking it
	// then ADDS the tag to the rest of the selection rather than removing it from the few that have it,
	// the least-surprising binary collapse of a true tri-state.
	checked: boolean
}

// Bulk tags submenu rows: every account tag, checked only when the whole selection already carries
// it. Pure so the tri-state collapse is unit-testable without mounting the submenu.
export function noteBulkTagSubmenuEntries(notes: readonly Note[], allTags: readonly NoteTag[]): NoteBulkTagSubmenuEntry[] {
	return allTags.map(tag => ({
		tag,
		checked: notes.length > 0 && notes.every(note => note.tags.some(t => t.uuid === tag.uuid))
	}))
}
