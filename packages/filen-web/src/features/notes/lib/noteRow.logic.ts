import { fastLocaleCompare } from "@filen/utils"
import type { Note, NoteParticipant, NoteTag } from "@filen/sdk-rs"

// Pure per-row content derivations, split out of noteRow.tsx so the row's non-trivial rules
// (shared-by ownership, tag ordering, preview omission, self-exclusion) are unit-testable without a
// DOM. Mirrors filen-mobile's note/index.tsx row body.

// The preview snippet for the row, or undefined when the note has none — the row OMITS the line
// entirely in that case (mobile behavior). Deliberately NOT falling back to the title: the row now
// carries other metadata lines, so a blank preview no longer needs papering over with a duplicate.
export function noteRowPreview(note: Note): string | undefined {
	return note.preview !== undefined && note.preview.length > 0 ? note.preview : undefined
}

// The owning participant's email, for the row's "Shared by <email>" line — non-null ONLY when the
// current user is a participant on a note they do NOT own (mobile's isSharedToMe: ownerId !==
// current user). Null when we own the note, no current user is resolved yet (account query cold), or
// no participant is flagged the owner.
export function noteRowSharedByEmail(note: Note, currentUserId: bigint | undefined): string | null {
	if (currentUserId === undefined || note.ownerId === currentUserId) {
		return null
	}

	return note.participants.find(participant => participant.isOwner)?.email ?? null
}

// The note's own tags, sorted by display name (fastLocaleCompare on name ?? uuid) — the row's tag-chip
// strip order, matching mobile. Returns a NEW array, never mutates note.tags.
export function noteRowTags(note: Note): NoteTag[] {
	return [...note.tags].sort((a, b) => fastLocaleCompare(a.name ?? a.uuid, b.name ?? b.uuid))
}

// Participants other than the current user — the avatar strip never shows your own avatar (mobile
// filters the same way). When no current user is resolved, every participant passes (userId is never
// undefined), matching mobile's `participant.userId !== stringifiedClient?.userId`.
export function noteRowParticipants(note: Note, currentUserId: bigint | undefined): NoteParticipant[] {
	return note.participants.filter(participant => participant.userId !== currentUserId)
}

// A participant's avatar URL, but only when it is a real https source — mobile's own guard, since the
// field can carry a non-URL placeholder. Undefined falls the row back to the initials avatar.
export function participantAvatarSource(participant: NoteParticipant): string | undefined {
	return participant.avatar?.startsWith("https://") === true ? participant.avatar : undefined
}
