import { sortAndFilterNotes, sortNotes, filterNotesBySearch, tagDisplayName } from "@/features/notes/lib/sort"
import { isBlocked, type BlockedUsers, sortNoteTags, type NoteTagsSortBy, partitionNotesByBucket, type NoteBucketId } from "@filen/shared"
import type { Note, NoteTag } from "@filen/sdk-rs"

// Pure view-model builders for the two-view sidebar. No React, no cache — the
// component feeds in the raw notes/tags lists + the current search/expand/sort state, and gets back the
// exact row model the virtualizer walks. Tested directly against these inputs (notesSidebar.logic.test.ts).

function normalizeSearch(search: string): string {
	return search.trim().toLowerCase()
}

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

// ── View 1 (notes) ──────────────────────────────────────────────────────────

// The flat note list: filter by search, then the pinned → bucket → editedTimestamp sort. Straight
// reuse of the foundation's sortAndFilterNotes so both views share one search/sort semantics. `bodies`
// is the eager-fetched full-body map (useNoteSearchBodies.ts) — undefined outside an active search.
export function buildNotesView(notes: readonly Note[], search: string, bodies?: ReadonlyMap<string, string | undefined>): Note[] {
	return sortAndFilterNotes(notes, search, bodies)
}

// ── Notes-view date grouping ──────────────────────────────────────────────────
// Classification (first-match-wins: Trashed → Archived → Pinned → Favorited → date buckets) is
// @filen/shared's partitionNotesByBucket, shared with filen-mobile's notesSorter.group — this module
// only resolves the shared core's abstract bucket ids into this app's header rows.

interface GroupEntry {
	id: string
	pinned: boolean
	favorite: boolean
	archive: boolean
	trash: boolean
	ts: number
	note: Note
}

// Newest-first within a bucket — editedTimestamp desc with a uuid tiebreak so equal-timestamp notes
// keep a stable order across refetches (input order is not itself stable). Bigint-safe: never Number()s
// the comparison (reads the original note's bigint field, not the derived `ts`). Mirrors compareNotes'
// own tiebreak, minus its cross-bucket tier (within one date bucket every note already shares that tier).
function compareByEditedDesc(a: GroupEntry, b: GroupEntry): number {
	if (a.note.editedTimestamp !== b.note.editedTimestamp) {
		return a.note.editedTimestamp > b.note.editedTimestamp ? -1 : 1
	}

	return a.note.uuid < b.note.uuid ? -1 : a.note.uuid > b.note.uuid ? 1 : 0
}

// The previous-month header label — the calendar month name of the bucket's lower bound (mobile names
// this `twoMonthsAgo` but it labels the single "one month back" window). `undefined` locale defers to
// the runtime's own, same posture as lib/relativeTime.ts's absolute fallback.
function monthLabel(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, { month: "long" }).format(new Date(timestamp))
}

// Resolves the shared core's abstract bucket id into this app's header row — the presentation layer
// the shared classification core deliberately excludes.
function headerForBucket(bucketId: NoteBucketId): Extract<NotesSidebarRow, { kind: "header" }> {
	if (bucketId === "pinned") {
		return { kind: "header", id: "pinned", label: { kind: "key", key: "notesGroupPinned" }, icon: "pinned" }
	}

	if (bucketId === "favorited") {
		return { kind: "header", id: "favorited", label: { kind: "key", key: "notesGroupFavorited" }, icon: "favorited" }
	}

	if (bucketId === "today") {
		return { kind: "header", id: "today", label: { kind: "key", key: "notesGroupToday" }, icon: "today" }
	}

	if (bucketId === "previous7Days") {
		return { kind: "header", id: "previous7Days", label: { kind: "key", key: "notesGroupPrevious7Days" }, icon: "calendar" }
	}

	if (bucketId === "previous30Days") {
		return { kind: "header", id: "previous30Days", label: { kind: "key", key: "notesGroupPrevious30Days" }, icon: "calendar" }
	}

	if (bucketId === "archived") {
		return { kind: "header", id: "archived", label: { kind: "key", key: "notesGroupArchived" }, icon: "archived" }
	}

	if (bucketId === "trashed") {
		return { kind: "header", id: "trashed", label: { kind: "key", key: "notesGroupTrashed" }, icon: "trashed" }
	}

	if (bucketId.kind === "month") {
		return { kind: "header", id: "month", label: { kind: "literal", text: monthLabel(bucketId.monthTimestamp) }, icon: "calendar" }
	}

	return {
		kind: "header",
		id: `year-${String(bucketId.year)}`,
		label: { kind: "literal", text: String(bucketId.year) },
		icon: "calendar"
	}
}

// Partition + emit. `now` is injected (not read from Date.now inside) so the bucket thresholds are
// deterministic under test.
export function groupNotesForView(notes: readonly Note[], now: number): NotesSidebarRow[] {
	const entries: GroupEntry[] = notes.map(note => ({
		id: note.uuid,
		pinned: note.pinned,
		favorite: note.favorite,
		archive: note.archive,
		trash: note.trash,
		ts: Number(note.editedTimestamp),
		note
	}))

	const buckets = partitionNotesByBucket(entries, now, compareByEditedDesc)
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
export function buildNotesGroupedRows(
	notes: readonly Note[],
	search: string,
	now: number,
	bodies?: ReadonlyMap<string, string | undefined>
): NotesSidebarRow[] {
	return groupNotesForView(filterNotesBySearch(notes, search, bodies), now)
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

// The header row's leading icon, resolved to a concrete lucide icon in the component (the logic layer
// stays React-free).
export type NotesGroupIcon = "pinned" | "favorited" | "today" | "calendar" | "archived" | "trashed"

// One flattened row model — tag headers and their expanded member notes interleaved, OR (notes view)
// date-group section headers interleaved with note rows — so a SINGLE virtualizer covers either view
// (never a nested virtualizer). A tag's `noteCount` is its TOTAL membership (not the search-narrowed
// count), the number the collapsed row displays.
export type NotesSidebarRow =
	| { kind: "tag"; tag: NoteTag; noteCount: number; expanded: boolean }
	| { kind: "note"; note: Note; tagUuid: string }
	| { kind: "header"; id: string; label: NotesGroupLabel; icon: NotesGroupIcon }

export interface TagsViewParams {
	tags: readonly NoteTag[]
	notesByTag: Record<string, readonly Note[]>
	expandedTagUuids: ReadonlySet<string>
	search: string
	sortBy: NoteTagsSortBy
	// Localized label for the synthesized untagged row (the logic layer stays React-free).
	untaggedLabel: string
	// Eager-fetched full-body map, undefined outside an active search (see buildNotesView).
	bodies?: ReadonlyMap<string, string | undefined>
}

export function buildTagsViewRows({
	tags,
	notesByTag,
	expandedTagUuids,
	search,
	sortBy,
	untaggedLabel,
	bodies
}: TagsViewParams): NotesSidebarRow[] {
	const untaggedNotes = notesByTag[UNTAGGED_TAG_UUID] ?? []
	// Appended AFTER the sort — always the bottom row regardless of the tags-sort preference — and run
	// through the SAME search filter as a real tag so it is findable by label or by member note.
	const visible = [
		...sortNoteTags(filterTagsForView(tags, notesByTag, search, bodies), sortBy, notesByTag, tagDisplayName),
		...(untaggedNotes.length > 0 ? filterTagsForView([createUntaggedTag(untaggedLabel)], notesByTag, search, bodies) : [])
	]
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
