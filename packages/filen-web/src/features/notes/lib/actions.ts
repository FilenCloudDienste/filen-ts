import type { Note, NoteType } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { removeQueriesAndPersisted } from "@/queries/persist"
import { accountQueryGet } from "@/queries/account"
import { notesQueryUpsert, notesQueryRemove } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { resolveLocalFirstContent, noteUndecryptableError } from "@/features/notes/lib/localContent"
import { recordNotePush } from "@/features/notes/lib/pushEchoes"
import { isNoteOwner } from "@/features/notes/lib/sort"
import { asErrorDTO, plainErrorDTO } from "@/lib/sdk/errors"
import { attemptOp, runOp, type ActionOutcome, type VoidActionOutcome } from "@/lib/actions/outcome"
import { getDefaultNoteType } from "@/features/notes/lib/preferences"
import { log } from "@/lib/log"

export type { ActionOutcome, VoidActionOutcome }

// The note action layer — no content editing (that lives separately in the sync layer). Every helper is a plain
// async function: call the SDK, then (only on success) patch the notes-list cache directly
// (confirm-then-patch, mirroring features/drive/lib/actions.ts and features/contacts/lib/actions.ts).
// Nothing here calls toast — every caller (noteMenu.tsx, the sidebar's new-note button, ...) resolves
// the outcome and surfaces `errorLabel(dto)` itself, same convention as drive's itemMenu.tsx.

function ownerGateError(): ActionOutcome<Note> {
	return { status: "error", dto: plainErrorDTO(i18n.t("notes:noteOwnerOnlyError")) }
}

// ── Create ───────────────────────────────────────────────────────────────

// The SDK creates a "text" note with its own default title — no type-picker dialog on create, matching
// both mobile and old-web. A different default type (Appearance → Notes) retypes it right away; when that retype
// fails the text note stands (it exists either way) and the user can change its type from the note.
export async function createNote(): Promise<ActionOutcome<Note>> {
	// Read before the round trip: the type the user had chosen when they asked for the note.
	const noteType = getDefaultNoteType()
	const outcome = await attemptOp(sdkApi.createNote())

	if (outcome.status !== "success") {
		return outcome
	}

	let note = outcome.item

	if (note.noteType !== noteType) {
		const retyped = await attemptOp(retypeNewNote(note, noteType))

		if (retyped.status === "success") {
			note = retyped.item
		} else {
			log.warn("notes", "default note type not applied", retyped.dto.message)
		}
	}

	notesQueryUpsert(note)

	return { status: "success", item: note }
}

// A just-created note's retype, which writes its content ("" for a new note) again: recorded as this
// browser's own write before it is sent, so a late echo never reads as a save made elsewhere.
export async function retypeNewNote(note: Note, noteType: NoteType): Promise<Note> {
	const forget = recordNotePush(note.uuid, "")

	try {
		return await runOp(sdkApi.setNoteType(note, noteType, ""))
	} catch (e) {
		forget()

		throw e
	}
}

// ── Copy content ─────────────────────────────────────────────────────────

// What gets copied is what the user sees (resolveLocalFirstContent). A fetch failure or undecryptable
// content throws an ErrorDTO — the caller's own try/catch (noteDirectAction.ts's copyContent case) surfaces
// it as an error toast instead of silently copying an empty string.
export async function resolveNoteContent(note: Note): Promise<string> {
	const result = await resolveLocalFirstContent(note)

	if (result.status === "undecryptable") {
		// eslint-disable-next-line @typescript-eslint/only-throw-error -- ErrorDTO is the boundary contract, mirrors runOp's own convention
		throw noteUndecryptableError()
	}

	return result.content
}

// ── Duplicate ────────────────────────────────────────────────────────────

// Mobile semantics: the duplicate's content is copied into the cache for BOTH the
// original and the new row, so an already-open original's editor and a freshly-opened duplicate both
// see content immediately instead of each issuing its own getNoteContent round trip. The original's
// content is read from cache first (already loaded, the common case — the user just duplicated a note
// they have open) and only fetched when that cache is cold. That seeding is best-effort: the duplicate
// exists once the SDK call resolves, so a failed read leaves the caches cold instead of failing it.
export async function duplicateNote(note: Note): Promise<ActionOutcome<Note>> {
	const outcome = await attemptOp(sdkApi.duplicateNote(note))

	if (outcome.status !== "success") {
		return outcome
	}

	const { original, duplicated } = outcome.item

	notesQueryUpsert(original)
	notesQueryUpsert(duplicated)

	await seedDuplicateContent(original, duplicated)

	return { status: "success", item: duplicated }
}

async function seedDuplicateContent(original: Note, duplicated: Note): Promise<void> {
	const cachedContent = queryClient.getQueryData<string | undefined>(noteContentQueryKey(original.uuid))
	let content = cachedContent

	if (content === undefined) {
		try {
			content = await runOp(sdkApi.getNoteContent(original))
		} catch (e) {
			log.warn("notes", "duplicate content not seeded", asErrorDTO(e).message)

			return
		}
	}

	// Undecryptable content resolves undefined: nothing to seed.
	if (content === undefined) {
		return
	}

	// A warm cache already holds exactly this value, and rewriting it would still move dataUpdatedAt,
	// which remounts the original's open editor (caret, scroll and undo lost).
	if (cachedContent === undefined) {
		queryClient.setQueryData(noteContentQueryKey(original.uuid), content)
	}

	queryClient.setQueryData(noteContentQueryKey(duplicated.uuid), content)
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

	const outcome = await attemptOp(sdkApi.setNotePinned(note, pinned))

	if (outcome.status === "success") {
		notesQueryUpsert(outcome.item)
	}

	return outcome
}

export async function togglePinned(note: Note): Promise<ActionOutcome<Note>> {
	return setNotePinned(note, !note.pinned)
}

export async function setNoteFavorited(note: Note, favorited: boolean): Promise<ActionOutcome<Note>> {
	if (note.favorite === favorited) {
		return { status: "success", item: note }
	}

	const outcome = await attemptOp(sdkApi.setNoteFavorited(note, favorited))

	if (outcome.status === "success") {
		notesQueryUpsert(outcome.item)
	}

	return outcome
}

export async function toggleFavorited(note: Note): Promise<ActionOutcome<Note>> {
	return setNoteFavorited(note, !note.favorite)
}

// ── Lifecycle: archive / restore / trash / delete ───────────────────────

// Owner-gated (mobile and old-web both gate this action on ownerId). Checked here too, not only in the menu
// builder that hides the entry for a non-owner — defense-in-depth, same rule this codebase already
// applies to connectivity gates (library AND component layer).
export async function archiveNote(note: Note): Promise<ActionOutcome<Note>> {
	if (!isNoteOwner(note, accountQueryGet()?.id)) {
		return ownerGateError()
	}

	if (note.archive || note.trash) {
		return { status: "success", item: note }
	}

	const outcome = await attemptOp(sdkApi.archiveNote(note))

	if (outcome.status === "success") {
		notesQueryUpsert(outcome.item)
	}

	return outcome
}

export async function restoreNote(note: Note): Promise<ActionOutcome<Note>> {
	if (!note.archive && !note.trash) {
		return { status: "success", item: note }
	}

	const outcome = await attemptOp(sdkApi.restoreNote(note))

	if (outcome.status === "success") {
		notesQueryUpsert(outcome.item)
	}

	return outcome
}

// Out of the archive only. restoreNote also brings a note back from the trash, so a caller that may only
// unarchive (the assistant's set_note_flags, whose card says nothing of the trash) goes through this, which leaves a
// trashed note where it is.
export async function unarchiveNote(note: Note): Promise<ActionOutcome<Note>> {
	if (!note.archive || note.trash) {
		return { status: "success", item: note }
	}

	return restoreNote(note)
}

export async function trashNote(note: Note): Promise<ActionOutcome<Note>> {
	if (note.trash) {
		return { status: "success", item: note }
	}

	const outcome = await attemptOp(sdkApi.trashNote(note))

	// Trashed notes stay IN the flat list (sort.ts's noteBucket sorts them to the bottom tier) — there is
	// no separate notes-trash view (the sidebar only has the notes/tags views) — so this is a plain
	// upsert, never a removal.
	if (outcome.status === "success") {
		notesQueryUpsert(outcome.item)
	}

	return outcome
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

	const outcome = await attemptOp(sdkApi.deleteNote(note))

	if (outcome.status === "error") {
		return outcome
	}

	opts?.beforeCacheRemoval?.()
	notesQueryRemove(note.uuid)
	removeQueriesAndPersisted(queryClient, noteContentQueryKey(note.uuid))

	return { status: "success" }
}

// ── Leave (non-owner self-remove) ────────────────────────────────────────

export async function leaveNote(note: Note, opts?: DeleteNoteOptions): Promise<VoidActionOutcome> {
	const userId = accountQueryGet()?.id

	if (userId === undefined) {
		return { status: "error", dto: plainErrorDTO(i18n.t("notes:noteNotSignedInError")) }
	}

	const outcome = await attemptOp(sdkApi.removeNoteParticipant(note, userId))

	if (outcome.status === "error") {
		return outcome
	}

	opts?.beforeCacheRemoval?.()
	notesQueryRemove(note.uuid)
	removeQueriesAndPersisted(queryClient, noteContentQueryKey(note.uuid))

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

	const outcome = await attemptOp(sdkApi.setNoteTitle(note, trimmed))

	if (outcome.status === "success") {
		notesQueryUpsert(outcome.item)
	}

	return outcome
}

// Passes the current content as `knownContent` when it's already cached (mirrors mobile's setType)
// — the SDK reinterprets it under the new type instead of a redundant fetch. A cold
// cache (content never loaded in this session) passes undefined; the SDK fetches it itself.
export async function setNoteType(note: Note, noteType: NoteType): Promise<ActionOutcome<Note>> {
	if (note.noteType === noteType) {
		return { status: "success", item: note }
	}

	const knownContent = queryClient.getQueryData<string | undefined>(noteContentQueryKey(note.uuid))

	// The retype writes the content again; its echo is this browser's own write. Content the SDK reads
	// itself is not known here.
	const forget = knownContent === undefined ? undefined : recordNotePush(note.uuid, knownContent)
	const outcome = await attemptOp(sdkApi.setNoteType(note, noteType, knownContent))

	if (outcome.status === "error") {
		forget?.()

		return outcome
	}

	notesQueryUpsert(outcome.item)

	return outcome
}
