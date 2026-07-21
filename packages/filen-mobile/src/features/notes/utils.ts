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

// ── Virtual "Untagged" tag (#84) ─────────────────────────────────────────────
//
// The tags view builds its rows from real NoteTags, so notes without any tag were invisible
// there. A VIRTUAL tag row surfaces them: appended after sorting (always at the bottom,
// regardless of the tags sort preference), hidden when no untagged notes exist, and rendered
// with a distinct look (single-tag outline icon, muted italic label) so a real tag the user
// happened to name "Untagged" stays visually distinguishable. Identity can never collide: the
// sentinel is not a server-generated uuid (it merely satisfies the UuidStr template shape),
// and everything downstream keys on uuid.

export const UNTAGGED_TAG_UUID = "virtual-untagged-notes-row" as const

export function isUntaggedTagUuid(uuid: string | null | undefined): boolean {
	return uuid === UNTAGGED_TAG_UUID
}

/**
 * The synthesized row/tag object. Never persisted, never sent to the SDK — navigation carries
 * only the uuid, selection and tag mutations are guarded off, and the create-note flow strips
 * it before attaching tags.
 */
export function createUntaggedTag(name: string): NoteTag {
	return {
		uuid: UNTAGGED_TAG_UUID,
		name,
		favorite: false,
		editedTimestamp: 0n,
		createdTimestamp: 0n,
		undecryptable: false
	}
}

export function filterUntaggedNotes(notes: Note[]): Note[] {
	return notes.filter(note => note.tags.length === 0)
}

/**
 * Appends the virtual tag AFTER the sorted real tags — the row is pinned to the bottom by
 * construction — and only when there is something to show (an empty "Untagged" row would be
 * pure noise). Search filtering runs on the returned array, so the row is findable by its
 * localized label like any real tag.
 */
export function withUntaggedTag(sortedTags: NoteTag[], untaggedCount: number, name: string): NoteTag[] {
	if (untaggedCount === 0) {
		return sortedTags
	}

	return [...sortedTags, createUntaggedTag(name)]
}

// ── Typed export names (#83) ─────────────────────────────────────────────────
//
// Exports write the RAW stored content, so the extension/MIME mapping is pure naming:
// text → .txt, markdown → .md, richtext/checklist → .html (their stored form IS html —
// Quill v1 markup and the checklist <ul data-checked> markup both open readably in a
// browser and reimport byte-exact), code → the title's extension when it looks like one.

/**
 * A usable file extension carried by a code note's title ("script.py" → "py"): 1-10
 * alphanumeric chars containing at least one letter, so "notes v2.1" doesn't export as ".1".
 * The editor's syntax highlighting keys off the same title (loadLanguage), which additionally
 * validates against the known language set inside the WebView — kept there deliberately so the
 * native bundle never imports the CodeMirror language table.
 */
export function noteCodeTitleExtension(title: string | null | undefined): string | null {
	if (!title) {
		return null
	}

	const trimmed = title.trim()
	const dot = trimmed.lastIndexOf(".")

	if (dot <= 0 || dot === trimmed.length - 1) {
		return null
	}

	const ext = trimmed.slice(dot + 1).toLowerCase()

	return /^[a-z0-9]{1,10}$/.test(ext) && /[a-z]/.test(ext) ? ext : null
}

/**
 * Export name + share MIME for a note. `includeUuidSuffix` (bulk zip entries) keeps the
 * uuid-based collision safety: `title_uuid.ext`. A title already ending in the chosen
 * extension is not double-suffixed ("readme.md" exports as "readme.md", not "readme.md.md");
 * an empty title falls back to the uuid. The caller sanitizes for the filesystem.
 */
export function noteExportFileName(
	note: Note,
	opts?: {
		includeUuidSuffix?: boolean
	}
): {
	fileName: string
	mimeType: string
} {
	const { ext, mimeType } = (() => {
		switch (note.noteType) {
			case NoteType.Md: {
				return { ext: "md", mimeType: "text/markdown" }
			}

			case NoteType.Rich:
			case NoteType.Checklist: {
				return { ext: "html", mimeType: "text/html" }
			}

			case NoteType.Code: {
				return { ext: noteCodeTitleExtension(note.title) ?? "txt", mimeType: "text/plain" }
			}

			default: {
				return { ext: "txt", mimeType: "text/plain" }
			}
		}
	})()

	const title = note.title?.trim() ?? ""
	const suffix = `.${ext}`
	const base = (title.toLowerCase().endsWith(suffix) ? title.slice(0, -suffix.length) : title) || note.uuid

	if (opts?.includeUuidSuffix) {
		return {
			fileName: `${base}_${note.uuid}${suffix}`,
			mimeType
		}
	}

	return {
		fileName: `${base}${suffix}`,
		mimeType
	}
}
