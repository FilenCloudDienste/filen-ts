import {
	sortAndFilterNotes,
	sortNotes,
	filterNotesBySearch,
	sortNoteTags,
	tagDisplayName,
	type NoteTagsSortBy
} from "@/features/notes/lib/sort"
import type { Note, NoteTag } from "@filen/sdk-rs"

// Pure view-model builders for the two-view sidebar. No React, no cache — the
// component feeds in the raw notes/tags lists + the current search/expand/sort state, and gets back the
// exact row model the virtualizer walks. Tested directly against these inputs (notesSidebar.logic.test.ts).

function normalizeSearch(search: string): string {
	return search.trim().toLowerCase()
}

// ── View 1 (notes) ──────────────────────────────────────────────────────────

// The flat note list: filter by search, then the pinned → bucket → editedTimestamp sort. Straight
// reuse of the foundation's sortAndFilterNotes so both views share one search/sort semantics. `bodies`
// is the eager-fetched full-body map (useNoteSearchBodies.ts) — undefined outside an active search.
export function buildNotesView(notes: readonly Note[], search: string, bodies?: ReadonlyMap<string, string | undefined>): Note[] {
	return sortAndFilterNotes(notes, search, bodies)
}

// ── View 2 (tags) ─────────────────────────────────────────────────────────────

// tag uuid → the notes carrying that tag, from each note's own inline `tags` array (the wasm Note
// embeds its NoteTag[] — no separate join needed). A tag with zero notes simply never appears as a key
// here; callers read `notesByTag[uuid] ?? []`. One pass over the notes, O(notes × tags-per-note).
export function buildNotesByTag(notes: readonly Note[]): Record<string, Note[]> {
	const byTag: Record<string, Note[]> = {}

	for (const note of notes) {
		for (const tag of note.tags) {
			const bucket = byTag[tag.uuid] ?? (byTag[tag.uuid] = [])

			bucket.push(note)
		}
	}

	return byTag
}

function tagNameMatches(tag: NoteTag, normalized: string): boolean {
	return tagDisplayName(tag).toLowerCase().includes(normalized)
}

// A tag is shown in the tags view when the search matches its NAME or any of its member notes
// (title or full body — `bodies` is the eager-fetched map, see buildNotesView's own comment). Empty
// search shows all.
export function filterTagsForView(
	tags: readonly NoteTag[],
	notesByTag: Record<string, readonly Note[]>,
	search: string,
	bodies?: ReadonlyMap<string, string | undefined>
): NoteTag[] {
	const normalized = normalizeSearch(search)

	if (normalized.length === 0) {
		return [...tags]
	}

	return tags.filter(tag => {
		if (tagNameMatches(tag, normalized)) {
			return true
		}

		return filterNotesBySearch(notesByTag[tag.uuid] ?? [], search, bodies).length > 0
	})
}

// The notes shown inside an expanded tag group: all of them (sorted) when the search is empty or the
// tag NAME itself matched — a name match reveals the whole group — otherwise only the members that
// match the search. Always sorted by the shared note sort.
function notesForExpandedTag(
	tag: NoteTag,
	notesByTag: Record<string, readonly Note[]>,
	search: string,
	bodies?: ReadonlyMap<string, string | undefined>
): Note[] {
	const notes = notesByTag[tag.uuid] ?? []
	const normalized = normalizeSearch(search)

	if (normalized.length === 0 || tagNameMatches(tag, normalized)) {
		return sortNotes(notes)
	}

	return sortNotes(filterNotesBySearch(notes, search, bodies))
}

// One flattened row model — tag headers and their expanded member notes interleaved — so a SINGLE
// virtualizer covers the whole tags view (never a nested virtualizer per tag). A tag's `noteCount` is
// its TOTAL membership (not the search-narrowed count), the number the collapsed row displays.
export type NotesSidebarRow =
	{ kind: "tag"; tag: NoteTag; noteCount: number; expanded: boolean } | { kind: "note"; note: Note; tagUuid: string }

export interface TagsViewParams {
	tags: readonly NoteTag[]
	notesByTag: Record<string, readonly Note[]>
	expandedTagUuids: ReadonlySet<string>
	search: string
	sortBy: NoteTagsSortBy
	// Eager-fetched full-body map, undefined outside an active search (see buildNotesView).
	bodies?: ReadonlyMap<string, string | undefined>
}

export function buildTagsViewRows({ tags, notesByTag, expandedTagUuids, search, sortBy, bodies }: TagsViewParams): NotesSidebarRow[] {
	const visible = sortNoteTags(filterTagsForView(tags, notesByTag, search, bodies), sortBy, notesByTag)
	const rows: NotesSidebarRow[] = []

	for (const tag of visible) {
		const expanded = expandedTagUuids.has(tag.uuid)

		rows.push({ kind: "tag", tag, noteCount: (notesByTag[tag.uuid] ?? []).length, expanded })

		if (expanded) {
			for (const note of notesForExpandedTag(tag, notesByTag, search, bodies)) {
				rows.push({ kind: "note", note, tagUuid: tag.uuid })
			}
		}
	}

	return rows
}

// Stable virtualizer key per flattened row. A note can appear under multiple tags, so its key is
// scoped by the owning tag uuid — a bare note uuid would collide across groups.
export function sidebarRowKey(row: NotesSidebarRow): string {
	return row.kind === "tag" ? `tag:${row.tag.uuid}` : `note:${row.tagUuid}:${row.note.uuid}`
}

// The ordered, currently-rendered note set BOTH views' rows walk for click-selection — every
// "note"-kind row across whichever view is active, in render order, tag headers excluded (multi-select
// only applies to notes here, not tags). A note appearing under multiple expanded tag groups appears
// once per group, matching what the user actually sees and can shift-click a range across.
export function selectableNotesFromRows(rows: readonly NotesSidebarRow[]): Note[] {
	const notes: Note[] = []

	for (const row of rows) {
		if (row.kind === "note") {
			notes.push(row.note)
		}
	}

	return notes
}

// Maps each note row's unique identity (sidebarRowKey, scoped by owning tag) to its position in
// selectableNotesFromRows' output. Deliberately keyed by row identity rather than by note uuid — a
// note that appears under two expanded tag groups occupies two distinct rows with the SAME uuid, and
// a uuid-keyed lookup would collapse them onto whichever row happens to be built last, misdirecting a
// click on the earlier occurrence onto the later row's position. Range/anchor math (useNotesListSelection)
// needs the row the user actually clicked, not an arbitrary same-uuid stand-in.
export function selectableRowIndexByKey(rows: readonly NotesSidebarRow[]): Map<string, number> {
	const indexByKey = new Map<string, number>()

	for (const row of rows) {
		if (row.kind === "note") {
			indexByKey.set(sidebarRowKey(row), indexByKey.size)
		}
	}

	return indexByKey
}
