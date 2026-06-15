import { NoteType, type Note as SdkNote, type NoteTag as SdkNoteTag } from "@filen/sdk-rs"
import { type Note, type NoteTag, type NoteHistory } from "@/types"
import { noteDisplayTitle, tagDisplayName } from "@/lib/decryption"
import { type ListItem as NoteListItem } from "@/features/notes/components/note"
import { type BlockedUsers } from "@/features/contacts/blockedSelectors"

// Order note history newest-first (latest revision on top). The SDK returns history in
// its own order, so the screen sorts explicitly by editedTimestamp — a bigint (ms),
// compared directly, no Number() precision risk. Pure; does not mutate the input.
export function sortNoteHistoryNewestFirst(history: NoteHistory[]): NoteHistory[] {
	return [...history].sort((a, b) => (a.editedTimestamp < b.editedTimestamp ? 1 : a.editedTimestamp > b.editedTimestamp ? -1 : 0))
}

// Narrows a (grouped) note list to the subset matching the active search query.
// An empty/whitespace query returns the list unchanged. Section headers are dropped
// while a query is active (they carry no searchable content). Matching is
// case-insensitive against `noteDisplayTitle` (which yields the
// `cannot_decrypt_<uuid>` placeholder for undecryptable notes so they stay
// searchable via that text) and the note's content. Pure (no React/store reads) so
// both the list body and the header can derive the SAME visible set from one source
// — otherwise select-all / deselect-all would operate on search-hidden notes.
export function filterNoteListItemsBySearchQuery(notes: NoteListItem[], searchQuery: string): NoteListItem[] {
	const normalized = searchQuery.trim().toLowerCase()

	if (normalized.length === 0) {
		return notes
	}

	return notes.filter(note => {
		if (note.type === "header") {
			return false
		}

		if (noteDisplayTitle(note).toLowerCase().includes(normalized)) {
			return true
		}

		if (note.content && note.content.toLowerCase().includes(normalized)) {
			return true
		}

		return false
	})
}

// Narrows a (sorted) tag list to the subset matching the active search query.
// An empty/whitespace query returns the list unchanged. Matching is case-insensitive
// against `tagDisplayName`. Pure (no React/store reads).
export function filterNoteTagsBySearchQuery(tags: NoteTag[], searchQuery: string): NoteTag[] {
	const normalized = searchQuery.trim().toLowerCase()

	if (normalized.length === 0) {
		return tags
	}

	return tags.filter(tag => tagDisplayName(tag).toLowerCase().includes(normalized))
}

export function wrapSdkNote(sdk: SdkNote): Note {
	return {
		...sdk,
		undecryptable: sdk.encryptionKey === undefined
	}
}

export function wrapSdkNoteTag(sdk: SdkNoteTag): NoteTag {
	return {
		...sdk,
		undecryptable: sdk.name === undefined
	}
}

export type EditorType = "text" | "code" | "markdown" | "richtext"

// Maps a note's type to the TextEditor `type` prop. Checklist notes never render
// through TextEditor (the content view branches them to <Checklist/>), so they fall
// through to "text" here.
export function noteTypeToEditorType(type: NoteType): EditorType {
	switch (type) {
		case NoteType.Code: {
			return "code"
		}

		case NoteType.Md: {
			return "markdown"
		}

		case NoteType.Rich: {
			return "richtext"
		}

		default: {
			return "text"
		}
	}
}

// Tri-state of a tag against a working set of notes:
//   "all"  — every note already carries this tag (tap → remove from all)
//   "some" — some but not all carry it (tap → add to the rest, promoting to "all")
//   "none" — no note carries it yet (tap → add to all)
export type TagState = "all" | "some" | "none"

export function computeTagState({ notes, tag }: { notes: readonly Note[]; tag: NoteTag }): TagState {
	if (notes.length === 0) {
		return "none"
	}

	let tagged = 0

	for (let i = 0; i < notes.length; i++) {
		const note = notes[i]

		if (note && note.tags.some(t => t.uuid === tag.uuid)) {
			tagged++
		}
	}

	if (tagged === 0) {
		return "none"
	}

	if (tagged === notes.length) {
		return "all"
	}

	return "some"
}

// Hides notes shared TO the user by a blocked owner. Owner-based only — a note the user owns is
// never hidden because a participant happens to be blocked. Pure (no React/store reads).
export function filterNotesByBlockedOwner(notes: readonly Note[], blocked: BlockedUsers): Note[] {
	if (blocked.userIds.size === 0) {
		return notes as Note[]
	}

	return notes.filter(note => !blocked.userIds.has(note.ownerId))
}
