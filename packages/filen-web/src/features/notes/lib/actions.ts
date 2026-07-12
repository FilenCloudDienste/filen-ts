import type { Note, NoteType, UserInfo } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { notesQueryUpsert, notesQueryRemove } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { getDefaultNoteType, DEFAULT_NOTE_TYPE } from "@/features/notes/lib/preferences"
import { asErrorDTO } from "@/lib/sdk/errors"
import { runOp, type ActionOutcome, type VoidActionOutcome } from "@/lib/actions/outcome"

export type { ActionOutcome, VoidActionOutcome }

// The note action layer — no content editing (that lives separately in the sync layer). Every helper is a plain
// async function: call the SDK, then (only on success) patch the notes-list cache directly
// (confirm-then-patch, mirroring features/drive/lib/actions.ts and features/contacts/lib/actions.ts).
// Nothing here calls toast — every caller (noteMenu.tsx, the sidebar's new-note button, ...) resolves
// the outcome and surfaces `errorLabel(dto)` itself, same convention as drive's itemMenu.tsx.

// Same rationale as drive's currentRootUuid(): the account query is warm by the time any note surface
// can render, so a cache miss degrades to undefined rather than throwing — every owner-gate below treats
// an unresolved id as "not the owner" (the safer default; the SDK itself is the final authority anyway).
function currentUserId(): bigint | undefined {
	return queryClient.getQueryData<UserInfo>(ACCOUNT_QUERY_KEY)?.id
}

export function isNoteOwner(note: Note, userId: bigint | undefined = currentUserId()): boolean {
	return userId !== undefined && note.ownerId === userId
}

function ownerGateError(): ActionOutcome<Note> {
	const message = i18n.t("notes:noteOwnerOnlyError")

	return { status: "error", dto: { species: "plain", message, label: message } }
}

// ── Create ───────────────────────────────────────────────────────────────

// The SDK creates a note as "text" by default, then a second setNoteType call applies the persisted
// preference only when it differs — no type-picker dialog on create, matching both
// mobile and old-web. `title` is optional (an empty sidebar "New note" click) — the SDK assigns its own
// default title when omitted.
export async function createNote(title?: string): Promise<ActionOutcome<Note>> {
	let note: Note

	try {
		note = await runOp(sdkApi.createNote(title))

		const preferredType = await getDefaultNoteType()

		if (preferredType !== DEFAULT_NOTE_TYPE) {
			note = await runOp(sdkApi.setNoteType(note, preferredType))
		}
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	notesQueryUpsert(note)

	return { status: "success", item: note }
}

// ── Duplicate ────────────────────────────────────────────────────────────

// Mobile semantics: the duplicate's content is copied into the cache for BOTH the
// original and the new row, so an already-open original's editor and a freshly-opened duplicate both
// see content immediately instead of each issuing its own getNoteContent round trip. The original's
// content is read from cache first (already loaded, the common case — the user just duplicated a note
// they have open) and only fetched when that cache is cold.
export async function duplicateNote(note: Note): Promise<ActionOutcome<Note>> {
	let original: Note
	let duplicated: Note

	try {
		;({ original, duplicated } = await runOp(sdkApi.duplicateNote(note)))

		const cachedContent = queryClient.getQueryData<string | undefined>(noteContentQueryKey(original.uuid))
		const content = cachedContent ?? (await runOp(sdkApi.getNoteContent(original)))

		queryClient.setQueryData(noteContentQueryKey(original.uuid), content)
		queryClient.setQueryData(noteContentQueryKey(duplicated.uuid), content)
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	notesQueryUpsert(original)
	notesQueryUpsert(duplicated)

	return { status: "success", item: duplicated }
}

// ── Pin / favorite ───────────────────────────────────────────────────────

// Explicit-target variants (as opposed to togglePinned/toggleFavorited's "flip my own flag" shape)
// — the bulk selection bar needs every selected note driven to the SAME target value, not each
// note's own opposite (see features/notes/lib/bulk.ts's setPinnedNotes/setFavoritedNotes). No-op
// on an already-matching note, same idempotency rule as archiveNote/restoreNote/trashNote below.
export async function setNotePinned(note: Note, pinned: boolean): Promise<ActionOutcome<Note>> {
	if (note.pinned === pinned) {
		return { status: "success", item: note }
	}

	let updated: Note

	try {
		updated = await runOp(sdkApi.setNotePinned(note, pinned))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	notesQueryUpsert(updated)

	return { status: "success", item: updated }
}

export async function togglePinned(note: Note): Promise<ActionOutcome<Note>> {
	return setNotePinned(note, !note.pinned)
}

export async function setNoteFavorited(note: Note, favorited: boolean): Promise<ActionOutcome<Note>> {
	if (note.favorite === favorited) {
		return { status: "success", item: note }
	}

	let updated: Note

	try {
		updated = await runOp(sdkApi.setNoteFavorited(note, favorited))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	notesQueryUpsert(updated)

	return { status: "success", item: updated }
}

export async function toggleFavorited(note: Note): Promise<ActionOutcome<Note>> {
	return setNoteFavorited(note, !note.favorite)
}

// ── Lifecycle: archive / restore / trash / delete ───────────────────────

// Owner-gated (mobile and old-web both gate this action on ownerId). Checked here too, not only in the menu
// builder that hides the entry for a non-owner — defense-in-depth, same rule this codebase already
// applies to connectivity gates (library AND component layer).
export async function archiveNote(note: Note): Promise<ActionOutcome<Note>> {
	if (!isNoteOwner(note)) {
		return ownerGateError()
	}

	if (note.archive || note.trash) {
		return { status: "success", item: note }
	}

	let updated: Note

	try {
		updated = await runOp(sdkApi.archiveNote(note))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	notesQueryUpsert(updated)

	return { status: "success", item: updated }
}

export async function restoreNote(note: Note): Promise<ActionOutcome<Note>> {
	if (!note.archive && !note.trash) {
		return { status: "success", item: note }
	}

	let updated: Note

	try {
		updated = await runOp(sdkApi.restoreNote(note))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	notesQueryUpsert(updated)

	return { status: "success", item: updated }
}

export async function trashNote(note: Note): Promise<ActionOutcome<Note>> {
	if (note.trash) {
		return { status: "success", item: note }
	}

	let updated: Note

	try {
		updated = await runOp(sdkApi.trashNote(note))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	// Trashed notes stay IN the flat list (sort.ts's noteBucket sorts them to the bottom tier) — there is
	// no separate notes-trash view (the sidebar only has the notes/tags views) — so this is a plain
	// upsert, never a removal.
	notesQueryUpsert(updated)

	return { status: "success", item: updated }
}

export interface DeleteNoteOptions {
	// Fired once the SDK confirms the permanent delete, BEFORE the note is stripped from the cache —
	// the caller's chance to navigate away first if this note is the currently-routed one (the nav-race
	// guard mobile solves with a 3s cache-removal defer; our router instead just needs the
	// navigation to have already committed before the row disappears out from under it).
	beforeCacheRemoval?: () => void
}

export async function deleteNote(note: Note, opts?: DeleteNoteOptions): Promise<VoidActionOutcome> {
	// Only a trashed note is a valid permanent-delete target (mirrors mobile's own deleteNote guard) —
	// defense-in-depth, same rule archiveNote/restoreNote/trashNote apply above. The menu only ever
	// surfaces "Delete permanently" once note.trash is true, but this stays safe for any future direct
	// caller (bulk actions, a shortcut, ...) that skips the menu gate.
	if (!note.trash) {
		return { status: "success" }
	}

	try {
		await runOp(sdkApi.deleteNote(note))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	opts?.beforeCacheRemoval?.()
	notesQueryRemove(note.uuid)
	queryClient.removeQueries({ queryKey: noteContentQueryKey(note.uuid) })

	return { status: "success" }
}

// ── Leave (non-owner self-remove) ────────────────────────────────────────

export async function leaveNote(note: Note, opts?: DeleteNoteOptions): Promise<VoidActionOutcome> {
	const userId = currentUserId()

	if (userId === undefined) {
		const message = i18n.t("notes:noteNotSignedInError")
		return { status: "error", dto: { species: "plain", message, label: message } }
	}

	try {
		await runOp(sdkApi.removeNoteParticipant(note, userId))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	opts?.beforeCacheRemoval?.()
	notesQueryRemove(note.uuid)
	queryClient.removeQueries({ queryKey: noteContentQueryKey(note.uuid) })

	return { status: "success" }
}

// ── Rename / type conversion ─────────────────────────────────────────────

// No-op on empty/unchanged (mirrors mobile's setTitle) — a blank or identical value never
// reaches the SDK at all.
export async function setNoteTitle(note: Note, title: string): Promise<ActionOutcome<Note>> {
	const trimmed = title.trim()

	if (trimmed.length === 0 || trimmed === (note.title ?? "")) {
		return { status: "success", item: note }
	}

	let updated: Note

	try {
		updated = await runOp(sdkApi.setNoteTitle(note, trimmed))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	notesQueryUpsert(updated)

	return { status: "success", item: updated }
}

// Passes the current content as `knownContent` when it's already cached (mirrors mobile's setType)
// — the SDK reinterprets it under the new type instead of a redundant fetch. A cold
// cache (content never loaded in this session) passes undefined; the SDK fetches it itself.
export async function setNoteType(note: Note, noteType: NoteType): Promise<ActionOutcome<Note>> {
	if (note.noteType === noteType) {
		return { status: "success", item: note }
	}

	const knownContent = queryClient.getQueryData<string | undefined>(noteContentQueryKey(note.uuid))

	let updated: Note

	try {
		updated = await runOp(sdkApi.setNoteType(note, noteType, knownContent))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	notesQueryUpsert(updated)

	return { status: "success", item: updated }
}
