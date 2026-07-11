import type { Note, NoteTag } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { notesQueryUpdate, notesQueryUpsert } from "@/features/notes/queries/notes"
import { noteTagsQueryUpsert, noteTagsQueryRemove } from "@/features/notes/queries/noteTags"
import { asErrorDTO } from "@/lib/sdk/errors"
import { runOp, type ActionOutcome, type VoidActionOutcome } from "@/lib/actions/outcome"

export type { ActionOutcome, VoidActionOutcome }

// Tag actions — same plain-function, confirm-then-patch shape as lib/actions.ts. Reserved pseudo-tag
// names collide with the sidebar's future All/Favorites/Pinned filter chips; rejected
// case-insensitively, matching old-web's own `createTag` guard.
const RESERVED_TAG_NAMES = new Set(["all", "favorites", "pinned"])

function isReservedTagName(name: string): boolean {
	return RESERVED_TAG_NAMES.has(name.trim().toLowerCase())
}

function reservedNameError(): ActionOutcome<NoteTag> {
	const message = i18n.t("notes:noteTagReservedName")

	return { status: "error", dto: { species: "plain", message, label: message } }
}

// ── Tag CRUD ─────────────────────────────────────────────────────────────

export async function createNoteTag(name: string): Promise<ActionOutcome<NoteTag>> {
	const trimmed = name.trim()

	if (isReservedTagName(trimmed)) {
		return reservedNameError()
	}

	let tag: NoteTag

	try {
		tag = await runOp(sdkApi.createNoteTag(trimmed))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	noteTagsQueryUpsert(tag)

	return { status: "success", item: tag }
}

export async function renameNoteTag(tag: NoteTag, name: string): Promise<ActionOutcome<NoteTag>> {
	const trimmed = name.trim()

	if (isReservedTagName(trimmed)) {
		return reservedNameError()
	}

	let updated: NoteTag

	try {
		updated = await runOp(sdkApi.renameNoteTag(tag, trimmed))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	noteTagsQueryUpsert(updated)
	// The tag's display name is embedded in every note row's own `tags` array (Note.tags), not just
	// the tags-list cache — without this, a renamed tag would show its OLD name on every note carrying
	// it until the next full notes refetch.
	notesQueryUpdate(prev => prev.map(note => ({ ...note, tags: note.tags.map(t => (t.uuid === updated.uuid ? updated : t)) })))

	return { status: "success", item: updated }
}

export async function deleteNoteTag(tag: NoteTag): Promise<VoidActionOutcome> {
	try {
		await runOp(sdkApi.deleteNoteTag(tag))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
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

	let updated: NoteTag

	try {
		updated = await runOp(sdkApi.setNoteTagFavorited(tag, favorite))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	noteTagsQueryUpsert(updated)

	return { status: "success", item: updated }
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

	let result: { note: Note; tag: NoteTag }

	try {
		result = await runOp(sdkApi.addTagToNote(note, tag))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	notesQueryUpsert(result.note)
	noteTagsQueryUpsert(result.tag)

	return { status: "success", item: result.note }
}

export async function removeTagFromNote(note: Note, tag: NoteTag): Promise<ActionOutcome<Note>> {
	if (!noteHasTag(note, tag.uuid)) {
		return { status: "success", item: note }
	}

	let updated: Note

	try {
		updated = await runOp(sdkApi.removeTagFromNote(note, tag))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	notesQueryUpsert(updated)

	return { status: "success", item: updated }
}
