import { compareIds, contactDisplayName, fastLocaleCompare } from "@filen/shared"
import type { Note, NoteParticipant, NoteTag } from "@filen/sdk-rs"
import { tagDisplayName } from "@/features/notes/lib/sort"
import { formatClockTime, formatShortDate, formatShortWeekday } from "@/lib/formatDate"

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

// The note's own tags, sorted by display name (fastLocaleCompare on tagDisplayName), then uuid — the row's tag-chip
// strip order, matching mobile. Returns a NEW array, never mutates note.tags.
export function noteRowTags(note: Note): NoteTag[] {
	return [...note.tags].sort((a, b) => fastLocaleCompare(tagDisplayName(a), tagDisplayName(b)) || compareIds(a.uuid, b.uuid))
}

// Participants other than the current user — the avatar strip never shows your own avatar (mobile
// filters the same way). When no current user is resolved, every participant passes (userId is never
// undefined), matching mobile's `participant.userId !== stringifiedClient?.userId`.
export function noteRowParticipants(note: Note, currentUserId: bigint | undefined): NoteParticipant[] {
	return note.participants.filter(participant => participant.userId !== currentUserId)
}

const NAME_LIST = new Intl.ListFormat(undefined, { style: "short", type: "conjunction" })

// Display names of the other participants, for the row's shared mark; null when nobody else is on the
// note. The owner is left out when the row already says who shared it.
export function noteRowSharedWithNames(note: Note, currentUserId: bigint | undefined, sharedByEmail: string | null): string | null {
	const names: string[] = []

	for (const participant of note.participants) {
		if (participant.userId !== currentUserId && !(sharedByEmail !== null && participant.isOwner)) {
			names.push(contactDisplayName(participant))
		}
	}

	return names.length > 0 ? NAME_LIST.format(names) : null
}

// Tag chips a row shows before the rest collapse into "+N".
export const NOTE_ROW_MAX_TAGS = 2

const DAY_MS = 24 * 60 * 60 * 1000

// The row's edited time, as precise as its notes-view section is coarse: the clock within the last 24
// hours, the weekday within the last 7 days, the date before that (the sections' own windows).
export function noteRowTime(timestamp: number, now: number): string {
	if (timestamp >= now - DAY_MS) {
		return formatClockTime(timestamp)
	}

	if (timestamp >= now - 7 * DAY_MS) {
		return formatShortWeekday(timestamp)
	}

	return formatShortDate(timestamp)
}
