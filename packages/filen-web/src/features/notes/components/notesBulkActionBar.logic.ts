import { type LucideIcon } from "lucide-react"
import type { Note, NoteTag } from "@filen/sdk-rs"
import { noteBulkActionAvailability, type NoteSelectionFlags } from "@filen/shared"
import { NOTE_ACTION_DEFS } from "@/features/notes/lib/actionDefs"
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
// driveBulkActions (variant/flag-gated descriptor list, testable without rendering anything). Which
// of the eleven actions the selection permits is the shared decision matrix (identical on mobile);
// this function only attaches the descriptor/icon/label/dispatch apparatus that stays per-app.
export function noteBulkActions(flags: NoteSelectionFlags): NoteBulkActionDescriptor[] {
	const descriptors: NoteBulkActionDescriptor[] = []
	const availability = noteBulkActionAvailability(flags)

	// Pin/Favorite first — most-tapped, matches mobile's own ordering. SET semantics: the label/icon
	// reflect the value this bar will apply to the WHOLE selection, not any single note's own flag.
	if (availability.pin) {
		descriptors.push({
			id: "pin",
			...(flags.includesPinned ? NOTE_ACTION_DEFS.unpin : NOTE_ACTION_DEFS.pin),
			run: "direct"
		})
	}

	if (availability.favorite) {
		descriptors.push({
			id: "favorite",
			...(flags.includesFavorited ? NOTE_ACTION_DEFS.unfavorite : NOTE_ACTION_DEFS.favorite),
			run: "direct"
		})
	}

	if (availability.type) {
		descriptors.push({ id: "type", ...NOTE_ACTION_DEFS.type, run: "submenu", submenu: "type" })
	}

	if (availability.tags) {
		descriptors.push({ id: "tags", ...NOTE_ACTION_DEFS.tags, run: "submenu", submenu: "tags" })
	}

	if (availability.duplicate) {
		descriptors.push({ id: "duplicate", ...NOTE_ACTION_DEFS.duplicate, run: "direct" })
	}

	if (availability.export) {
		descriptors.push({ id: "export", ...NOTE_ACTION_DEFS.export, run: "direct" })
	}

	if (availability.archive) {
		descriptors.push({ id: "archive", ...NOTE_ACTION_DEFS.archive, run: "direct" })
	}

	if (availability.restore) {
		descriptors.push({ id: "restore", ...NOTE_ACTION_DEFS.restore, run: "direct" })
	}

	// Unlike the single-note menu's own (non-destructive) Trash entry, the bulk button IS
	// destructive-styled — the confirm dialog this "dialog" run kind opens makes it a deliberate,
	// confirmed disposition on every selected note at once, so it gets the same red treatment as bulk
	// Delete/Leave rather than inheriting NOTE_ACTION_DEFS.trash's single-note styling.
	if (availability.trash) {
		descriptors.push({
			id: "trash",
			...NOTE_ACTION_DEFS.trash,
			destructive: true,
			run: "dialog",
			dialogKind: "trashSelected"
		})
	}

	if (availability.delete) {
		descriptors.push({
			id: "delete",
			...NOTE_ACTION_DEFS.deletePermanently,
			run: "dialog",
			dialogKind: "deleteSelected"
		})
	}

	if (availability.leave) {
		descriptors.push({ id: "leave", ...NOTE_ACTION_DEFS.leave, run: "dialog", dialogKind: "leaveSelected" })
	}

	return descriptors
}

// The single gate behind BOTH the bar's Trash button and the notes.trash shortcut: reads the same
// shared matrix field the bar's own descriptor list is built from, so the two can never disagree
// about when a bulk trash is offered.
export function canBulkTrashNotes(flags: NoteSelectionFlags): boolean {
	return noteBulkActionAvailability(flags).trash
}

// Bulk ids whose dispatch is an unconditional SDK write. Export is left enabled (cache-first, and the
// zip is built client-side); the descriptor list itself is unchanged, only its rendered enabled state.
const OFFLINE_GATED_BULK_IDS: ReadonlySet<NoteBulkActionDescriptor["id"]> = new Set<NoteBulkActionDescriptor["id"]>([
	"pin",
	"favorite",
	"type",
	"tags",
	"duplicate",
	"archive",
	"restore",
	"trash",
	"delete",
	"leave"
])

export function isNoteBulkActionOfflineDisabled(id: NoteBulkActionDescriptor["id"], isOnline: boolean): boolean {
	return !isOnline && OFFLINE_GATED_BULK_IDS.has(id)
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
