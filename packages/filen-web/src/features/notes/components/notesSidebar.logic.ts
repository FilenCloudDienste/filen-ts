import {
	sortAndFilterNotes,
	sortNotes,
	filterNotesBySearch,
	normalizeSearch,
	noteTitleMatchesSearch,
	tagDisplayName,
	compareEditedDescThenUuid
} from "@/features/notes/lib/sort"
import {
	isBlocked,
	matchesNameSearch,
	type BlockedUsers,
	sortNoteTags,
	type NoteTagsSortBy,
	partitionNotesByBucket,
	type NoteBucketId
} from "@filen/shared"
import type { Note, NoteTag } from "@filen/sdk-rs"
import type { NoteSearchHits } from "@/features/notes/lib/searchIndex.logic"

// Pure view-model builders for the two-view sidebar. No React, no cache — the
// component feeds in the raw notes/tags lists + the current search/expand/sort state, and gets back the
// exact row model the virtualizer walks. Tested directly against these inputs (notesSidebar.logic.test.ts).

// A note whose OWNER is a blocked contact is silently hidden from both views, even though the
// note itself isn't deleted (mirrors filen-mobile's filterNotesByBlockedOwner: owner-based only, so a
// note you own is never hidden just because one of ITS participants happens to be blocked). The caller
// (notesSidebar.tsx) applies this to the raw notes list before either view builds its rows, so a
// blocked note also drops out of any active selection for free (the selection is re-derived from the
// same filtered set every render, the same ghost-purge mechanism the live notes query already drives).
export function filterNotesByBlockedOwner(notes: readonly Note[], blocked: BlockedUsers): Note[] {
	if (blocked.userIds.size === 0) {
		return notes as Note[]
	}

	return notes.filter(note => !isBlocked({ userId: note.ownerId }, blocked))
}

// ── Notes-view date grouping ──────────────────────────────────────────────────
// Classification (first-match-wins: Trashed → Archived → Pinned → Favorited → date buckets) is
// @filen/shared's partitionNotesByBucket, shared with filen-mobile's notesSorter.group — this module
// only resolves the shared core's abstract bucket ids into this app's header rows.

interface GroupEntry {
	pinned: boolean
	favorite: boolean
	archive: boolean
	trash: boolean
	ts: number
	note: Note
}

// Within one date bucket every note already shares compareNotes' cross-bucket tier; reads the note's
// bigint field, never the derived `ts`.
function compareByEditedDesc(a: GroupEntry, b: GroupEntry): number {
	return compareEditedDescThenUuid(a.note, b.note)
}

// A month bucket's header label: the name of the notes' own calendar month, with the year when that
// month lies in the previous year. `undefined` locale defers to the runtime's own, same posture as
// lib/relativeTime.ts's absolute fallback.
function monthLabel(timestamp: number, inCurrentYear: boolean): string {
	return new Intl.DateTimeFormat(undefined, inCurrentYear ? { month: "long" } : { month: "long", year: "numeric" }).format(
		new Date(timestamp)
	)
}

// Header label key for every string bucket id; the Record keeps it exhaustive over the shared ids.
const FIXED_BUCKET_HEADERS: Record<Extract<NoteBucketId, string>, Extract<NotesGroupLabel, { kind: "key" }>["key"]> = {
	pinned: "notesGroupPinned",
	favorited: "notesGroupFavorited",
	today: "notesGroupToday",
	previous7Days: "notesGroupPrevious7Days",
	previous30Days: "notesGroupPrevious30Days",
	archived: "notesGroupArchived",
	trashed: "notesGroupTrashed"
}

// Resolves the shared core's abstract bucket id into this app's header row — the presentation layer
// the shared classification core deliberately excludes.
function headerForBucket(bucketId: NoteBucketId): Extract<NotesSidebarRow, { kind: "header" }> {
	if (typeof bucketId === "string") {
		return { kind: "header", id: bucketId, label: { kind: "key", key: FIXED_BUCKET_HEADERS[bucketId] } }
	}

	if (bucketId.kind === "month") {
		return {
			kind: "header",
			id: `month-${String(bucketId.monthTimestamp)}`,
			label: { kind: "literal", text: monthLabel(bucketId.monthTimestamp, bucketId.inCurrentYear) }
		}
	}

	return { kind: "header", id: `year-${String(bucketId.year)}`, label: { kind: "literal", text: String(bucketId.year) } }
}

// A search's order inside a section: title matches first, then body matches best first, then preview matches;
// edited time breaks ties.
function searchTier(note: Note, key: string, hits: NoteSearchHits | undefined): number {
	if (noteTitleMatchesSearch(note, key)) {
		return -1
	}

	return hits?.body.get(note.uuid)?.rank ?? Number.MAX_SAFE_INTEGER
}

// Partition + emit. `now` is injected (not read from Date.now inside) so the bucket thresholds are
// deterministic under test. With a search `key`, each section is in searchTier order.
export function groupNotesForView(notes: readonly Note[], now: number, key = "", hits?: NoteSearchHits): NotesSidebarRow[] {
	const entries: GroupEntry[] = notes.map(note => ({
		pinned: note.pinned,
		favorite: note.favorite,
		archive: note.archive,
		trash: note.trash,
		ts: Number(note.editedTimestamp),
		note
	}))

	const tiers = key.length > 0 ? new Map(notes.map(note => [note.uuid, searchTier(note, key, hits)])) : null
	const compare =
		tiers === null
			? compareByEditedDesc
			: (a: GroupEntry, b: GroupEntry): number =>
					(tiers.get(a.note.uuid) ?? 0) - (tiers.get(b.note.uuid) ?? 0) || compareByEditedDesc(a, b)
	const buckets = partitionNotesByBucket(entries, now, compare)
	const rows: NotesSidebarRow[] = []

	for (const bucket of buckets) {
		rows.push(headerForBucket(bucket.bucketId))

		for (const entry of bucket.notes) {
			rows.push({ kind: "note", note: entry.note, tagUuid: "" })
		}
	}

	return rows
}

// The notes view's full row model: search-filter first (narrowing the set grouping then walks), then
// partition into the interleaved header + note rows. `now` is injected for deterministic bucketing.
// `hits` is the search's index view (see filterNotesBySearch), which also ranks each section.
export function buildNotesGroupedRows(notes: readonly Note[], search: string, now: number, hits?: NoteSearchHits): NotesSidebarRow[] {
	return groupNotesForView(filterNotesBySearch(notes, search, hits), now, normalizeSearch(search), hits)
}

// ── View 2 (tags) ─────────────────────────────────────────────────────────────

// The synthesized bottom row grouping every note that carries no tag (mobile's own sentinel literal, so
// both platforms agree). A real server uuid carries 5 dash-separated segments and can never collide.
export const UNTAGGED_TAG_UUID = "virtual-untagged-notes-row" as const

export function isUntaggedTagUuid(uuid: string): boolean {
	return uuid === UNTAGGED_TAG_UUID
}

// Never persisted, never sent to the SDK: it exists only inside this module's row model, so no tag
// mutation, note-menu tag submenu or bulk tag picker can ever reach it (they all read the real
// listNoteTags cache). `name` is the caller's localized label so the row is findable by search like a
// real tag.
function createUntaggedTag(name: string): NoteTag {
	return { uuid: UNTAGGED_TAG_UUID, name, favorite: false, editedTimestamp: 0n, createdTimestamp: 0n }
}

// tag uuid → the notes carrying that tag, from each note's own inline `tags` array (the wasm Note
// embeds its NoteTag[] — no separate join needed). A tag with zero notes simply never appears as a key
// here; callers read `notesByTag[uuid] ?? []`. One pass over the notes, O(notes × tags-per-note).
export function buildNotesByTag(notes: readonly Note[]): Record<string, Note[]> {
	const byTag: Record<string, Note[]> = {}
	const untagged: Note[] = []

	for (const note of notes) {
		if (note.tags.length === 0) {
			untagged.push(note)
		}

		for (const tag of note.tags) {
			const bucket = byTag[tag.uuid] ?? (byTag[tag.uuid] = [])

			bucket.push(note)
		}
	}

	// The virtual row reads its notes through the same index as a real tag. Keyed only when non-empty so
	// buildTagsViewRows can read the count off this map without a second pass over the notes.
	if (untagged.length > 0) {
		byTag[UNTAGGED_TAG_UUID] = untagged
	}

	return byTag
}

function tagNameMatches(tag: NoteTag, normalized: string): boolean {
	return matchesNameSearch(tagDisplayName(tag), normalized)
}

// A tag is shown in the tags view when the search matches its NAME or any of its member notes
// (title or indexed body — `hits`, from useNoteSearch, undefined outside an active search). Empty search shows all.
export function filterTagsForView(
	tags: readonly NoteTag[],
	notesByTag: Record<string, readonly Note[]>,
	search: string,
	hits?: NoteSearchHits
): NoteTag[] {
	const normalized = normalizeSearch(search)

	if (normalized.length === 0) {
		return [...tags]
	}

	return tags.filter(tag => {
		if (tagNameMatches(tag, normalized)) {
			return true
		}

		return filterNotesBySearch(notesByTag[tag.uuid] ?? [], search, hits).length > 0
	})
}

// The notes shown inside an expanded tag group: all of them (sorted) when the search is empty or the
// tag NAME itself matched — a name match reveals the whole group — otherwise only the members that
// match the search. Always sorted by the shared note sort.
function notesForExpandedTag(tag: NoteTag, notesByTag: Record<string, readonly Note[]>, search: string, hits?: NoteSearchHits): Note[] {
	const notes = notesByTag[tag.uuid] ?? []
	const normalized = normalizeSearch(search)

	if (normalized.length === 0 || tagNameMatches(tag, normalized)) {
		return sortNotes(notes)
	}

	return sortAndFilterNotes(notes, search, hits)
}

// A notes-view section header's label: either a static catalog key (Pinned/Favorited/Today/…) or a
// computed literal (the previous-month name via Intl, or a bare year) that has no fixed key.
export type NotesGroupLabel =
	| {
			kind: "key"
			key:
				| "notesGroupPinned"
				| "notesGroupFavorited"
				| "notesGroupToday"
				| "notesGroupPrevious7Days"
				| "notesGroupPrevious30Days"
				| "notesGroupArchived"
				| "notesGroupTrashed"
	  }
	| { kind: "literal"; text: string }

// One flattened row model — tag headers and their expanded member notes interleaved, OR (notes view)
// date-group section headers interleaved with note rows — so a SINGLE virtualizer covers either view
// (never a nested virtualizer). A tag's `noteCount` is its TOTAL membership (not the search-narrowed
// count), the number the collapsed row displays.
export type NotesSidebarRow =
	| { kind: "tag"; tag: NoteTag; noteCount: number; expanded: boolean }
	| { kind: "note"; note: Note; tagUuid: string }
	| { kind: "header"; id: string; label: NotesGroupLabel }

export interface TagsViewParams {
	tags: readonly NoteTag[]
	notesByTag: Record<string, readonly Note[]>
	expandedTagUuids: ReadonlySet<string>
	search: string
	sortBy: NoteTagsSortBy
	// Localized label for the synthesized untagged row (the logic layer stays React-free).
	untaggedLabel: string
	// The search's index view, undefined outside an active search (see filterTagsForView).
	hits?: NoteSearchHits | undefined
}

export function buildTagsViewRows({
	tags,
	notesByTag,
	expandedTagUuids,
	search,
	sortBy,
	untaggedLabel,
	hits
}: TagsViewParams): NotesSidebarRow[] {
	const untaggedNotes = notesByTag[UNTAGGED_TAG_UUID] ?? []
	// Appended AFTER the sort — always the bottom row regardless of the tags-sort preference — and run
	// through the SAME search filter as a real tag so it is findable by label or by member note.
	const visible = [
		...sortNoteTags(filterTagsForView(tags, notesByTag, search, hits), sortBy, notesByTag, tagDisplayName),
		...(untaggedNotes.length > 0 ? filterTagsForView([createUntaggedTag(untaggedLabel)], notesByTag, search, hits) : [])
	]
	const rows: NotesSidebarRow[] = []

	for (const tag of visible) {
		const expanded = expandedTagUuids.has(tag.uuid)

		rows.push({ kind: "tag", tag, noteCount: (notesByTag[tag.uuid] ?? []).length, expanded })

		if (expanded) {
			for (const note of notesForExpandedTag(tag, notesByTag, search, hits)) {
				rows.push({ kind: "note", note, tagUuid: tag.uuid })
			}
		}
	}

	return rows
}

// Stable virtualizer key per flattened row. A note can appear under multiple tags, so its key is
// scoped by the owning tag uuid — a bare note uuid would collide across groups. Section-header ids are
// already unique within a build (one per bucket / distinct year).
export function sidebarRowKey(row: NotesSidebarRow): string {
	if (row.kind === "tag") {
		return `tag:${row.tag.uuid}`
	}

	if (row.kind === "header") {
		return `header:${row.id}`
	}

	return `note:${row.tagUuid}:${row.note.uuid}`
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

// What an arrow key, Home or End does on the row at `from` of the sidebar list: move focus to another row (headers
// are labels, never stops), or expand or collapse the tag row it is on. Right expands a collapsed tag, Left collapses
// an expanded one and, on a note inside a tag, goes up to that tag. null: the key does nothing there.
export type NotesRowKeyResult = { kind: "focus"; index: number } | { kind: "toggleTag" } | null

export function notesRowKeyTarget(rows: readonly NotesSidebarRow[], from: number, key: string): NotesRowKeyResult {
	const row = rows[from]

	switch (key) {
		case "ArrowDown":
			return focusResult(stopFrom(rows, from + 1, 1))
		case "ArrowUp":
			return focusResult(stopFrom(rows, from - 1, -1))
		case "Home":
			return focusResult(stopFrom(rows, 0, 1))
		case "End":
			return focusResult(stopFrom(rows, rows.length - 1, -1))
		case "ArrowRight":
			return row?.kind === "tag" && !row.expanded ? { kind: "toggleTag" } : null
		case "ArrowLeft": {
			if (row?.kind === "tag") {
				return row.expanded ? { kind: "toggleTag" } : null
			}

			for (let index = from - 1; index >= 0; index--) {
				if (rows[index]?.kind === "tag") {
					return { kind: "focus", index }
				}
			}

			return null
		}
		default:
			return null
	}
}

// Indices of the section-header rows, ascending: what the pinned header searches while scrolling.
export function headerRowIndices(rows: readonly NotesSidebarRow[]): number[] {
	const indices: number[] = []

	for (let index = 0; index < rows.length; index++) {
		if (rows[index]?.kind === "header") {
			indices.push(index)
		}
	}

	return indices
}

// The section header to pin over the list: the last header at or above the first visible row, or -1 when
// there is none (the tags view). Binary search, run once per scrolled range.
export function activeHeaderIndex(headerIndices: readonly number[], firstVisible: number): number {
	let low = 0
	let high = headerIndices.length - 1
	let found = -1

	while (low <= high) {
		const mid = (low + high) >>> 1
		const index = headerIndices[mid] ?? Number.POSITIVE_INFINITY

		if (index <= firstVisible) {
			found = index
			low = mid + 1
		} else {
			high = mid - 1
		}
	}

	return found
}

// The first section header after the one at `index`, or undefined when it is the last.
export function nextHeaderIndex(headerIndices: readonly number[], index: number): number | undefined {
	return headerIndices.find(header => header > index)
}

// How far the pinned header gives way to the next one: by as much as that header has entered the band the pinned
// one covers at the top, so the incoming header pushes it up instead of sliding beneath it. 0 while the next one
// (if any) is still below that band.
export function pinnedHeaderPush(pinnedSize: number, nextHeaderStart: number | undefined, scrollOffset: number): number {
	if (nextHeaderStart === undefined) {
		return 0
	}

	return Math.min(pinnedSize, Math.max(0, pinnedSize - (nextHeaderStart - scrollOffset)))
}

function stopFrom(rows: readonly NotesSidebarRow[], start: number, step: 1 | -1): number {
	for (let index = start; index >= 0 && index < rows.length; index += step) {
		if (rows[index]?.kind !== "header") {
			return index
		}
	}

	return -1
}

function focusResult(index: number): NotesRowKeyResult {
	return index === -1 ? null : { kind: "focus", index }
}
