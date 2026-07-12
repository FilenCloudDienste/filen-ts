import {
	sortAndFilterNotes,
	sortNotes,
	filterNotesBySearch,
	sortNoteTags,
	tagDisplayName,
	type NoteTagsSortBy
} from "@/features/notes/lib/sort"
import { isBlocked, type BlockedUsers } from "@/features/contacts/lib/blocking"
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
// Ports filen-mobile's notesSorter.group (lib/sort.ts) onto the wasm Note shape, notes view only.
// First-match-wins partition per note: Trashed → Archived → Pinned → Favorited → Today (24h) →
// Previous 7 days → Previous 30 days → previous-month (Intl month name) → year buckets (desc) —
// where Pinned/Favorited/Archived/Trashed REMOVE the note from its date bucket. Emitted in this
// order: Pinned → Favorited → Today → Previous 7 days → Previous 30 days → month → year(s) desc →
// Archived → Trashed. Every bucket is sorted newest-first (editedTimestamp desc, uuid tiebreak) and an
// empty bucket emits no header at all — there is never a blank section. Bucketing reads
// editedTimestamp unconditionally (the wasm field is a non-optional bigint, so mobile's
// createdTimestamp fallback is dead code here).

const DAY_MS = 24 * 60 * 60 * 1000

// Newest-first within a bucket — editedTimestamp desc with a uuid tiebreak so equal-timestamp notes
// keep a stable order across refetches (input order is not itself stable). Bigint-safe: never Number()s
// the comparison. Mirrors compareNotes' own tiebreak, minus its cross-bucket tier (within one date
// bucket every note already shares that tier).
function compareByEditedDesc(a: Note, b: Note): number {
	if (a.editedTimestamp !== b.editedTimestamp) {
		return a.editedTimestamp > b.editedTimestamp ? -1 : 1
	}

	return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0
}

// The previous-month header label — the calendar month name of the bucket's lower bound (mobile names
// this `twoMonthsAgo` but it labels the single "one month back" window). `undefined` locale defers to
// the runtime's own, same posture as lib/relativeTime.ts's absolute fallback.
function monthLabel(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, { month: "long" }).format(new Date(timestamp))
}

// Partition + emit. `now` is injected (not read from Date.now inside) so the bucket thresholds are
// deterministic under test.
export function groupNotesForView(notes: readonly Note[], now: number): NotesSidebarRow[] {
	const todayAgo = now - DAY_MS
	const sevenDaysAgo = now - 7 * DAY_MS
	const thirtyDaysAgo = now - 30 * DAY_MS
	const nowDate = new Date(now)
	const twoMonthsAgo = new Date(nowDate.getFullYear(), nowDate.getMonth() - 2, nowDate.getDate()).getTime()

	const pinned: Note[] = []
	const favorited: Note[] = []
	const today: Note[] = []
	const last7Days: Note[] = []
	const last30Days: Note[] = []
	const previousMonth: Note[] = []
	const archived: Note[] = []
	const trashed: Note[] = []
	const yearBuckets = new Map<number, Note[]>()

	for (const note of notes) {
		if (note.trash) {
			trashed.push(note)
			continue
		}

		if (note.archive) {
			archived.push(note)
			continue
		}

		if (note.pinned) {
			pinned.push(note)
			continue
		}

		if (note.favorite) {
			favorited.push(note)
			continue
		}

		const ts = Number(note.editedTimestamp)

		if (ts >= todayAgo) {
			today.push(note)
		} else if (ts >= sevenDaysAgo) {
			last7Days.push(note)
		} else if (ts >= thirtyDaysAgo) {
			last30Days.push(note)
		} else if (ts >= twoMonthsAgo) {
			previousMonth.push(note)
		} else {
			const year = new Date(ts).getFullYear()
			const bucket = yearBuckets.get(year)

			if (bucket !== undefined) {
				bucket.push(note)
			} else {
				yearBuckets.set(year, [note])
			}
		}
	}

	const rows: NotesSidebarRow[] = []

	const emit = (bucket: Note[], header: Extract<NotesSidebarRow, { kind: "header" }>): void => {
		if (bucket.length === 0) {
			return
		}

		bucket.sort(compareByEditedDesc)
		rows.push(header)

		for (const note of bucket) {
			rows.push({ kind: "note", note, tagUuid: "" })
		}
	}

	emit(pinned, { kind: "header", id: "pinned", label: { kind: "key", key: "notesGroupPinned" }, icon: "pinned" })
	emit(favorited, { kind: "header", id: "favorited", label: { kind: "key", key: "notesGroupFavorited" }, icon: "favorited" })
	emit(today, { kind: "header", id: "today", label: { kind: "key", key: "notesGroupToday" }, icon: "today" })
	emit(last7Days, { kind: "header", id: "previous7Days", label: { kind: "key", key: "notesGroupPrevious7Days" }, icon: "calendar" })
	emit(last30Days, { kind: "header", id: "previous30Days", label: { kind: "key", key: "notesGroupPrevious30Days" }, icon: "calendar" })
	emit(previousMonth, { kind: "header", id: "month", label: { kind: "literal", text: monthLabel(twoMonthsAgo) }, icon: "calendar" })

	const years = [...yearBuckets.keys()].sort((a, b) => b - a)

	for (const year of years) {
		emit(yearBuckets.get(year) ?? [], {
			kind: "header",
			id: `year-${String(year)}`,
			label: { kind: "literal", text: String(year) },
			icon: "calendar"
		})
	}

	emit(archived, { kind: "header", id: "archived", label: { kind: "key", key: "notesGroupArchived" }, icon: "archived" })
	emit(trashed, { kind: "header", id: "trashed", label: { kind: "key", key: "notesGroupTrashed" }, icon: "trashed" })

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
