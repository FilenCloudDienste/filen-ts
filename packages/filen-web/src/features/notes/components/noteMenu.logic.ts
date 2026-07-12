import { type LucideIcon } from "lucide-react"
import { NOTE_ACTION_DEFS } from "@/features/notes/lib/actionDefs"
import { isNoteOwner } from "@/features/notes/lib/actions"
import { isNoteUndecryptable, isTagUndecryptable } from "@/features/notes/lib/sort"
import type { Note, NoteTag, NoteType } from "@filen/sdk-rs"
import type { NotesKey } from "@/lib/i18n"

// Dialog kinds a note-menu entry can dispatch to the surface-level dialog host (useNoteDialogHost) —
// mirrors drive's ItemActionDialogKind split (itemMenu.logic.ts).
export type NoteActionDialogKind = "rename" | "delete" | "leave" | "createTag" | "participants" | "history"

// Tag-row dialog kinds — disjoint from NoteActionDialogKind so the dialog host's active-dialog union
// discriminates on `kind` alone (a tag dialog carries a NoteTag, not a Note).
export type NoteTagDialogKind = "renameTag" | "deleteTag"

export type NoteActionId =
	| "rename"
	| "duplicate"
	| "export"
	| "copyId"
	| "pin"
	| "favorite"
	| "tags"
	| "type"
	| "participants"
	| "history"
	| "archive"
	| "restore"
	| "trash"
	| "deletePermanently"
	| "leave"

interface NoteActionDescriptorShared {
	id: NoteActionId
	labelKey: NotesKey
	icon: LucideIcon
	destructive?: boolean
}

// "direct" resolves immediately (pin/favorite/duplicate/archive/restore/trash/type-change/tag-toggle);
// "dialog" opens the surface's dialog host on the given kind; "submenu" nests a tags/type picker;
// mutually exclusive by construction, same rationale as drive's own ItemActionDescriptor union.
export type NoteActionDescriptor =
	| (NoteActionDescriptorShared & { run: "direct" })
	| (NoteActionDescriptorShared & { run: "dialog"; dialogKind: NoteActionDialogKind })
	| (NoteActionDescriptorShared & { run: "submenu"; submenu: "type" | "tags" })

const RENAME: NoteActionDescriptor = { id: "rename", ...NOTE_ACTION_DEFS.rename, run: "dialog", dialogKind: "rename" }
const DUPLICATE: NoteActionDescriptor = { id: "duplicate", ...NOTE_ACTION_DEFS.duplicate, run: "direct" }
// Read-only utility actions, grouped right after duplicate — neither mutates the note, so both stay
// available regardless of ownership (unlike participants/archive below).
const EXPORT: NoteActionDescriptor = { id: "export", ...NOTE_ACTION_DEFS.export, run: "direct" }
const COPY_ID: NoteActionDescriptor = { id: "copyId", ...NOTE_ACTION_DEFS.copyId, run: "direct" }
const TAGS: NoteActionDescriptor = { id: "tags", ...NOTE_ACTION_DEFS.tags, run: "submenu", submenu: "tags" }
const TYPE: NoteActionDescriptor = { id: "type", ...NOTE_ACTION_DEFS.type, run: "submenu", submenu: "type" }
const PARTICIPANTS: NoteActionDescriptor = {
	id: "participants",
	...NOTE_ACTION_DEFS.participants,
	run: "dialog",
	dialogKind: "participants"
}
const HISTORY: NoteActionDescriptor = { id: "history", ...NOTE_ACTION_DEFS.history, run: "dialog", dialogKind: "history" }
const ARCHIVE: NoteActionDescriptor = { id: "archive", ...NOTE_ACTION_DEFS.archive, run: "direct" }
const RESTORE: NoteActionDescriptor = { id: "restore", ...NOTE_ACTION_DEFS.restore, run: "direct" }
const TRASH: NoteActionDescriptor = { id: "trash", ...NOTE_ACTION_DEFS.trash, run: "direct" }
const DELETE_PERMANENTLY: NoteActionDescriptor = {
	id: "deletePermanently",
	...NOTE_ACTION_DEFS.deletePermanently,
	run: "dialog",
	dialogKind: "delete"
}
const LEAVE: NoteActionDescriptor = { id: "leave", ...NOTE_ACTION_DEFS.leave, run: "dialog", dialogKind: "leave" }

function pinDescriptor(note: Note): NoteActionDescriptor {
	return note.pinned ? { id: "pin", ...NOTE_ACTION_DEFS.unpin, run: "direct" } : { id: "pin", ...NOTE_ACTION_DEFS.pin, run: "direct" }
}

function favoriteDescriptor(note: Note): NoteActionDescriptor {
	return note.favorite
		? { id: "favorite", ...NOTE_ACTION_DEFS.unfavorite, run: "direct" }
		: { id: "favorite", ...NOTE_ACTION_DEFS.favorite, run: "direct" }
}

// Pure per-note menu builder shared by both the sidebar row's context menu and the editor header's ⋮
// trigger (noteMenu.tsx) — one descriptor list, gated purely on the note's own flags + ownership, so it
// stays trivially testable without rendering anything (mirrors driveItemActions).
export function noteMenuActions(note: Note, currentUserId: bigint | undefined): NoteActionDescriptor[] {
	const owner = isNoteOwner(note, currentUserId)

	// Trashed is the maximally-reduced set (mirrors drive's own trash-variant menu): only recovery or
	// permanent removal, nothing else makes sense on a note already on its way out.
	if (note.trash) {
		return [RESTORE, DELETE_PERMANENTLY]
	}

	// Undecryptable: the note key never unwrapped for this account, so its metadata + content stay
	// ciphertext — every action that needs decrypted data (rename/duplicate/export/copyId/pin/favorite/
	// tags/type/participants/history/archive) is impossible. Only the pure-uuid dispositions survive:
	// the owner can trash it, a participant can leave it. Mirrors drive + chats, where an undecryptable
	// item is likewise reduced to its uuid-only actions (driveItemActions / chatMenuActions).
	if (isNoteUndecryptable(note)) {
		return owner ? [TRASH] : [LEAVE]
	}

	const actions: NoteActionDescriptor[] = [RENAME, DUPLICATE, EXPORT, COPY_ID, pinDescriptor(note), favoriteDescriptor(note), TAGS, TYPE]

	// Participants management is owner-only, matching both mobile and old-web — a participant sees no
	// entry for a dialog they could never act on. History stays open to any participant (mobile parity —
	// anyone with access can view a note's history; only restoring a version is gated further, by the
	// restore-from-history dialog itself).
	if (owner) {
		actions.push(PARTICIPANTS)
	}

	actions.push(HISTORY)

	// Archive/restore are mutually exclusive with each other, not with the rest of the menu — an
	// archived note keeps rename/duplicate/pin/favorite/tags/type, just swaps Archive for Restore.
	// Archive itself is owner-gated (mobile and old-web both gate it on ownerId); restoring OUT of archive
	// is not (mirrors mobile: any participant can restore, only entering archive is owner-only).
	if (note.archive) {
		actions.push(RESTORE)
	} else if (owner) {
		actions.push(ARCHIVE)
	}

	// Trash (owner) vs. Leave (non-owner self-remove) — the two ways a note can vanish from an owner's
	// vs. a participant's own list, mutually exclusive by ownership just like the archive gate above.
	actions.push(owner ? TRASH : LEAVE)

	return actions
}

// Tag-row context-menu descriptors (the sidebar tags view's own small menu) — same pure-builder shape
// as noteMenuActions so the entry list + favorite-label flip stay unit-testable without rendering.
export type TagActionDescriptor =
	| {
			id: "tagRename" | "tagDelete"
			labelKey: NotesKey
			icon: LucideIcon
			destructive?: boolean
			run: "dialog"
			dialogKind: NoteTagDialogKind
	  }
	| { id: "tagFavorite"; labelKey: NotesKey; icon: LucideIcon; run: "direct" }

export function tagMenuActions(tag: NoteTag): TagActionDescriptor[] {
	const del: TagActionDescriptor = { id: "tagDelete", ...NOTE_ACTION_DEFS.tagDelete, run: "dialog", dialogKind: "deleteTag" }

	// Undecryptable tag: its name never decrypted, so rename (needs a decrypted starting value) and
	// favorite (a metadata mutation) make no sense — only the pure-uuid delete survives (mobile parity,
	// tag/menu.tsx's own `tag.undecryptable` branch offers delete alone).
	if (isTagUndecryptable(tag)) {
		return [del]
	}

	const favorite: TagActionDescriptor = tag.favorite
		? { id: "tagFavorite", ...NOTE_ACTION_DEFS.tagUnfavorite, run: "direct" }
		: { id: "tagFavorite", ...NOTE_ACTION_DEFS.tagFavorite, run: "direct" }

	return [{ id: "tagRename", ...NOTE_ACTION_DEFS.tagRename, run: "dialog", dialogKind: "renameTag" }, favorite, del]
}

export interface NoteTagSubmenuEntry {
	tag: NoteTag
	checked: boolean
}

// Tags submenu rows: every account tag, checked when the note already carries it. Pure so the checkmark
// gating is unit-testable without mounting the submenu.
export function noteTagSubmenuEntries(note: Note, allTags: readonly NoteTag[]): NoteTagSubmenuEntry[] {
	const noteTagUuids = new Set(note.tags.map(tag => tag.uuid))

	return allTags.map(tag => ({ tag, checked: noteTagUuids.has(tag.uuid) }))
}

export interface NoteTypeSubmenuEntry {
	noteType: NoteType
	labelKey: NotesKey
}

// Type submenu rows, fixed order over the five note types — a plain constant, not derived from NOTE_ACTION_DEFS
// (that map is keyed by action id, not by NoteType).
export const NOTE_TYPE_SUBMENU: readonly NoteTypeSubmenuEntry[] = [
	{ noteType: "text", labelKey: "noteTypeText" },
	{ noteType: "md", labelKey: "noteTypeMd" },
	{ noteType: "code", labelKey: "noteTypeCode" },
	{ noteType: "rich", labelKey: "noteTypeRich" },
	{ noteType: "checklist", labelKey: "noteTypeChecklist" }
]
