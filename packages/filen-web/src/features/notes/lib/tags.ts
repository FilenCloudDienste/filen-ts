import type { Note, NoteTag } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { plainErrorDTO } from "@/lib/sdk/errors"
import { notesQueryUpdate, notesQueryUpsert } from "@/features/notes/queries/notes"
import { noteTagsQueryUpsert, noteTagsQueryRemove } from "@/features/notes/queries/noteTags"
import { attemptOp, type ActionOutcome, type VoidActionOutcome } from "@/lib/actions/outcome"

export type { ActionOutcome, VoidActionOutcome }

// Tag actions — same plain-function, confirm-then-patch shape as lib/actions.ts. Reserved pseudo-tag
// names collide with the sidebar's future All/Favorites/Pinned filter chips; rejected
// case-insensitively, matching old-web's own `createTag` guard.
const RESERVED_TAG_NAMES = new Set(["all", "favorites", "pinned"])

function isReservedTagName(name: string): boolean {
	return RESERVED_TAG_NAMES.has(name.trim().toLowerCase())
}

function reservedNameError(): ActionOutcome<NoteTag> {
	return { status: "error", dto: plainErrorDTO(i18n.t("notes:noteTagReservedName")) }
}

// ── Tag CRUD ─────────────────────────────────────────────────────────────

export async function createNoteTag(name: string): Promise<ActionOutcome<NoteTag>> {
	const trimmed = name.trim()

	if (isReservedTagName(trimmed)) {
		return reservedNameError()
	}

	const outcome = await attemptOp(sdkApi.createNoteTag(trimmed))

	if (outcome.status === "success") {
		noteTagsQueryUpsert(outcome.item)
	}

	return outcome
}

export async function renameNoteTag(tag: NoteTag, name: string): Promise<ActionOutcome<NoteTag>> {
	const trimmed = name.trim()

	if (isReservedTagName(trimmed)) {
		return reservedNameError()
	}

	const outcome = await attemptOp(sdkApi.renameNoteTag(tag, trimmed))

	if (outcome.status === "error") {
		return outcome
	}

	const updated = outcome.item

	noteTagsQueryUpsert(updated)
	// The tag's display name is embedded in every note row's own `tags` array (Note.tags), not just
	// the tags-list cache — without this, a renamed tag would show its OLD name on every note carrying
	// it until the next full notes refetch.
	notesQueryUpdate(prev => prev.map(note => ({ ...note, tags: note.tags.map(t => (t.uuid === updated.uuid ? updated : t)) })))

	return outcome
}

export async function deleteNoteTag(tag: NoteTag): Promise<VoidActionOutcome> {
	const outcome = await attemptOp(sdkApi.deleteNoteTag(tag))

	if (outcome.status === "error") {
		return outcome
	}

	noteTagsQueryRemove(tag.uuid)
	// Strip the tag from every cached note row (mirrors mobile's stripTagFromNotes) — the backend
	// has already un-tagged every note the deleted tag touched, so this only mirrors that locally
	// instead of waiting on a refetch.
	notesQueryUpdate(prev => prev.map(note => ({ ...note, tags: note.tags.filter(t => t.uuid !== tag.uuid) })))

	return { status: "success" }
}

export async function setNoteTagFavorited(tag: NoteTag, favorite: boolean): Promise<ActionOutcome<NoteTag>> {
	if (tag.favorite === favorite) {
		return { status: "success", item: tag }
	}

	const outcome = await attemptOp(sdkApi.setNoteTagFavorited(tag, favorite))

	if (outcome.status === "success") {
		noteTagsQueryUpsert(outcome.item)
	}

	return outcome
}

// ── Note <-> tag membership ──────────────────────────────────────────────

function noteHasTag(note: Note, tagUuid: string): boolean {
	return note.tags.some(t => t.uuid === tagUuid)
}

// Idempotent (mirrors mobile's addTag guard): a note already carrying the tag returns success
// without a wasted round trip.
export async function addTagToNote(note: Note, tag: NoteTag): Promise<ActionOutcome<Note>> {
	if (noteHasTag(note, tag.uuid)) {
		return { status: "success", item: note }
	}

	const outcome = await attemptOp(sdkApi.addTagToNote(note, tag))

	if (outcome.status === "error") {
		return outcome
	}

	notesQueryUpsert(outcome.item.note)
	noteTagsQueryUpsert(outcome.item.tag)

	return { status: "success", item: outcome.item.note }
}

export async function removeTagFromNote(note: Note, tag: NoteTag): Promise<ActionOutcome<Note>> {
	if (!noteHasTag(note, tag.uuid)) {
		return { status: "success", item: note }
	}

	const outcome = await attemptOp(sdkApi.removeTagFromNote(note, tag))

	if (outcome.status === "success") {
		notesQueryUpsert(outcome.item)
	}

	return outcome
}
