import { describe, expect, it } from "vitest"
import type { Note, NoteTag, UuidStr } from "@filen/sdk-rs"
import {
	buildNotesView,
	buildNotesGroupedRows,
	groupNotesForView,
	buildNotesByTag,
	buildTagsViewRows,
	filterTagsForView,
	filterNotesByBlockedOwner,
	sidebarRowKey,
	selectableNotesFromRows,
	selectableRowIndexByKey,
	isUntaggedTagUuid,
	UNTAGGED_TAG_UUID,
	type NotesSidebarRow
} from "@/features/notes/components/notesSidebar.logic"
import { DEFAULT_NOTE_TAGS_SORT_BY, type NoteTagsSortBy } from "@/features/notes/lib/sort"
import { deriveBlockedUsers, EMPTY_BLOCKED_USERS } from "@/features/contacts/lib/blocking"

// UuidStr is a template-literal brand requiring at least 3 dashes — pad a short label, same as notesSort.test.ts.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockTag(overrides: Partial<NoteTag> = {}): NoteTag {
	return {
		uuid: testUuid("tag"),
		name: "tag",
		favorite: false,
		editedTimestamp: 0n,
		createdTimestamp: 0n,
		...overrides
	}
}

function mockNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: testUuid("note"),
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		title: "title",
		preview: "preview",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: [],
		...overrides
	}
}

// Helpers: the note-row / tag-row uuids in a flattened tags-view result.
function noteRowUuids(rows: NotesSidebarRow[]): string[] {
	return rows.filter((row): row is Extract<NotesSidebarRow, { kind: "note" }> => row.kind === "note").map(row => row.note.uuid)
}

function tagRowUuids(rows: NotesSidebarRow[]): string[] {
	return rows.filter((row): row is Extract<NotesSidebarRow, { kind: "tag" }> => row.kind === "tag").map(row => row.tag.uuid)
}

describe("notesSidebar.logic — notes view", () => {
	it("filters by title/preview and sorts pinned first", () => {
		const pinned = mockNote({ uuid: testUuid("a"), title: "alpha", pinned: true, editedTimestamp: 1n })
		const recent = mockNote({ uuid: testUuid("b"), title: "beta", editedTimestamp: 9n })
		const older = mockNote({ uuid: testUuid("c"), title: "gamma", editedTimestamp: 2n })

		const all = buildNotesView([recent, older, pinned], "")

		// Pinned bucket wins regardless of timestamp, then editedTimestamp desc.
		expect(all.map(n => n.uuid)).toStrictEqual([pinned.uuid, recent.uuid, older.uuid])

		// Search narrows to title/preview matches.
		expect(buildNotesView([recent, older, pinned], "beta").map(n => n.uuid)).toStrictEqual([recent.uuid])
		expect(buildNotesView([recent, older, pinned], "preview")).toHaveLength(3)
	})

	it("narrows by full body via the bodies map when neither title nor preview matches", () => {
		const note = mockNote({ uuid: testUuid("body-only"), title: "gamma", preview: "preview" })
		const bodies = new Map([[note.uuid, "a term buried deep in the note body"]])

		expect(buildNotesView([note], "buried", bodies).map(n => n.uuid)).toStrictEqual([note.uuid])
		expect(buildNotesView([note], "buried")).toHaveLength(0)
	})
})

describe("notesSidebar.logic — buildNotesByTag count math", () => {
	it("groups notes by each inline tag, counting membership (a note under multiple tags counts in each)", () => {
		const work = mockTag({ uuid: testUuid("work"), name: "work" })
		const home = mockTag({ uuid: testUuid("home"), name: "home" })

		const n1 = mockNote({ uuid: testUuid("n1"), tags: [work] })
		const n2 = mockNote({ uuid: testUuid("n2"), tags: [work, home] })
		const n3 = mockNote({ uuid: testUuid("n3"), tags: [] })

		const byTag = buildNotesByTag([n1, n2, n3])

		expect(byTag[work.uuid]?.map(n => n.uuid)).toStrictEqual([n1.uuid, n2.uuid])
		expect(byTag[home.uuid]?.map(n => n.uuid)).toStrictEqual([n2.uuid])
		// Two real tag buckets plus the synthesized untagged one.
		expect(Object.keys(byTag)).toHaveLength(3)
	})

	it("collects the zero-tag notes into the untagged bucket", () => {
		const work = mockTag({ uuid: testUuid("work"), name: "work" })
		const tagged = mockNote({ uuid: testUuid("n1"), tags: [work] })
		const bare1 = mockNote({ uuid: testUuid("n2"), tags: [] })
		const bare2 = mockNote({ uuid: testUuid("n3"), tags: [] })

		const byTag = buildNotesByTag([tagged, bare1, bare2])

		expect(byTag[UNTAGGED_TAG_UUID]?.map(n => n.uuid)).toStrictEqual([bare1.uuid, bare2.uuid])
	})

	it("omits the untagged key entirely when every note carries a tag", () => {
		const work = mockTag({ uuid: testUuid("work"), name: "work" })

		const byTag = buildNotesByTag([mockNote({ uuid: testUuid("n1"), tags: [work] })])

		expect(UNTAGGED_TAG_UUID in byTag).toBe(false)
	})
})

describe("notesSidebar.logic — tags view filtering", () => {
	const work = mockTag({ uuid: testUuid("work"), name: "work" })
	const home = mockTag({ uuid: testUuid("home"), name: "home" })
	const groceries = mockNote({ uuid: testUuid("g"), title: "groceries", preview: "milk", tags: [home] })
	const standup = mockNote({ uuid: testUuid("s"), title: "standup", preview: "notes", tags: [work] })
	const notesByTag = buildNotesByTag([groceries, standup])

	it("keeps a tag when its NAME matches", () => {
		const kept = filterTagsForView([work, home], notesByTag, "work")

		expect(kept.map(t => t.uuid)).toStrictEqual([work.uuid])
	})

	it("keeps a tag when a MEMBER note matches even though the tag name does not", () => {
		const kept = filterTagsForView([work, home], notesByTag, "groceries")

		expect(kept.map(t => t.uuid)).toStrictEqual([home.uuid])
	})

	it("empty search keeps every tag", () => {
		expect(filterTagsForView([work, home], notesByTag, "")).toHaveLength(2)
	})

	// A member note's full body (not just its title/preview) can also qualify its tag.
	it("keeps a tag when a MEMBER note's full body matches, via the bodies map", () => {
		const bodies = new Map([[standup.uuid, "quarterly roadmap review"]])

		const kept = filterTagsForView([work, home], notesByTag, "roadmap", bodies)

		expect(kept.map(t => t.uuid)).toStrictEqual([work.uuid])
	})
})

describe("notesSidebar.logic — buildTagsViewRows flattening", () => {
	const work = mockTag({ uuid: testUuid("work"), name: "work" })
	const home = mockTag({ uuid: testUuid("home"), name: "home" })
	const a = mockNote({ uuid: testUuid("a"), title: "alpha", tags: [work], editedTimestamp: 2n })
	const b = mockNote({ uuid: testUuid("b"), title: "beta", tags: [work], editedTimestamp: 5n })
	const c = mockNote({ uuid: testUuid("c"), title: "gamma", tags: [home] })
	const notesByTag = buildNotesByTag([a, b, c])

	it("emits one tag row per tag with the total count and no member rows when collapsed", () => {
		const rows = buildTagsViewRows({
			tags: [work, home],
			notesByTag,
			expandedTagUuids: new Set(),
			search: "",
			sortBy: DEFAULT_NOTE_TAGS_SORT_BY,
			untaggedLabel: "Untagged"
		})

		expect(rows.every(r => r.kind === "tag")).toBe(true)
		const workRow = rows.find((r): r is Extract<NotesSidebarRow, { kind: "tag" }> => r.kind === "tag" && r.tag.uuid === work.uuid)
		expect(workRow?.noteCount).toBe(2)
	})

	it("interleaves a tag's member notes (sorted) inline when expanded — one flat row model, never nested", () => {
		const rows = buildTagsViewRows({
			tags: [work, home],
			notesByTag,
			expandedTagUuids: new Set([work.uuid]),
			search: "",
			sortBy: DEFAULT_NOTE_TAGS_SORT_BY,
			untaggedLabel: "Untagged"
		})

		// tag(work) → note(b, edited 5n) → note(a, edited 2n) → tag(home) collapsed.
		expect(rows.map(r => (r.kind === "tag" ? `T:${r.tag.uuid}` : r.kind === "note" ? `N:${r.note.uuid}` : `H:${r.id}`))).toStrictEqual([
			`T:${work.uuid}`,
			`N:${b.uuid}`,
			`N:${a.uuid}`,
			`T:${home.uuid}`
		])
	})

	it("under search, an expanded name-matched tag reveals all members; a member-matched tag reveals only matches", () => {
		// "work" name matches → both its notes show even though neither title contains "work".
		const nameMatched = buildTagsViewRows({
			tags: [work, home],
			notesByTag,
			expandedTagUuids: new Set([work.uuid, home.uuid]),
			search: "work",
			sortBy: DEFAULT_NOTE_TAGS_SORT_BY,
			untaggedLabel: "Untagged"
		})
		expect(noteRowUuids(nameMatched)).toStrictEqual([b.uuid, a.uuid])

		// "alpha" matches note a only → work stays (member match) and expands to just a; home drops out.
		const memberMatched = buildTagsViewRows({
			tags: [work, home],
			notesByTag,
			expandedTagUuids: new Set([work.uuid, home.uuid]),
			search: "alpha",
			sortBy: DEFAULT_NOTE_TAGS_SORT_BY,
			untaggedLabel: "Untagged"
		})
		expect(tagRowUuids(memberMatched)).toStrictEqual([work.uuid])
		expect(noteRowUuids(memberMatched)).toStrictEqual([a.uuid])
	})

	it("the bodies map threads through to a member-matched tag's own expansion", () => {
		const bodies = new Map([[a.uuid, "a rare term nowhere in the title"]])

		const rows = buildTagsViewRows({
			tags: [work, home],
			notesByTag,
			expandedTagUuids: new Set([work.uuid, home.uuid]),
			search: "rare term",
			sortBy: DEFAULT_NOTE_TAGS_SORT_BY,
			untaggedLabel: "Untagged",
			bodies
		})

		expect(tagRowUuids(rows)).toStrictEqual([work.uuid])
		expect(noteRowUuids(rows)).toStrictEqual([a.uuid])
	})
})

describe("notesSidebar.logic — sidebarRowKey", () => {
	it("scopes a note row's key by its owning tag so the same note under two tags never collides", () => {
		const tagA = mockTag({ uuid: testUuid("ta") })
		const tagB = mockTag({ uuid: testUuid("tb") })
		const note = mockNote({ uuid: testUuid("n") })

		const keyA = sidebarRowKey({ kind: "note", note, tagUuid: tagA.uuid })
		const keyB = sidebarRowKey({ kind: "note", note, tagUuid: tagB.uuid })

		expect(keyA).not.toBe(keyB)
		expect(sidebarRowKey({ kind: "tag", tag: tagA, noteCount: 0, expanded: false })).toBe(`tag:${tagA.uuid}`)
	})
})

describe("notesSidebar.logic — selectableNotesFromRows (click-selection range)", () => {
	it("extracts only note-kind rows, in order, tag headers excluded", () => {
		const tag = mockTag({ uuid: testUuid("t") })
		const noteA = mockNote({ uuid: testUuid("a") })
		const noteB = mockNote({ uuid: testUuid("b") })
		const rows: NotesSidebarRow[] = [
			{ kind: "tag", tag, noteCount: 2, expanded: true },
			{ kind: "note", note: noteA, tagUuid: tag.uuid },
			{ kind: "note", note: noteB, tagUuid: tag.uuid }
		]

		expect(selectableNotesFromRows(rows)).toEqual([noteA, noteB])
	})

	it("returns an empty array when every row is a tag header", () => {
		const tag = mockTag()

		expect(selectableNotesFromRows([{ kind: "tag", tag, noteCount: 0, expanded: false }])).toEqual([])
	})

	it("includes the same note once per tag group it appears under (notes view has one row per note)", () => {
		const tagA = mockTag({ uuid: testUuid("ta") })
		const tagB = mockTag({ uuid: testUuid("tb") })
		const note = mockNote({ uuid: testUuid("n") })
		const rows: NotesSidebarRow[] = [
			{ kind: "note", note, tagUuid: tagA.uuid },
			{ kind: "note", note, tagUuid: tagB.uuid }
		]

		expect(selectableNotesFromRows(rows)).toEqual([note, note])
	})
})

// ── Notes-view date grouping ──────────────────────────────────────────────────

// A fixed "now" so bucket thresholds are deterministic. Timestamps below stay comfortably inside each
// bucket window (never near a day/month boundary) so the result is stable regardless of the runner's
// local timezone.
const GROUP_NOW = new Date("2026-07-12T12:00:00.000Z").getTime()
const GROUP_DAY = 24 * 60 * 60 * 1000

function headerIds(rows: NotesSidebarRow[]): string[] {
	return rows.filter((row): row is Extract<NotesSidebarRow, { kind: "header" }> => row.kind === "header").map(row => row.id)
}

function groupedNoteUuids(rows: NotesSidebarRow[]): string[] {
	return rows.filter((row): row is Extract<NotesSidebarRow, { kind: "note" }> => row.kind === "note").map(row => row.note.uuid)
}

describe("notesSidebar.logic — groupNotesForView (date grouping)", () => {
	it("emits every bucket in the mobile order, one header per distinct year (desc)", () => {
		const notes = [
			mockNote({ uuid: testUuid("pin"), pinned: true, editedTimestamp: BigInt(GROUP_NOW) }),
			mockNote({ uuid: testUuid("fav"), favorite: true, editedTimestamp: BigInt(GROUP_NOW) }),
			mockNote({ uuid: testUuid("today"), editedTimestamp: BigInt(GROUP_NOW - 60 * 60 * 1000) }),
			mockNote({ uuid: testUuid("d7"), editedTimestamp: BigInt(GROUP_NOW - 3 * GROUP_DAY) }),
			mockNote({ uuid: testUuid("d30"), editedTimestamp: BigInt(GROUP_NOW - 15 * GROUP_DAY) }),
			mockNote({ uuid: testUuid("month"), editedTimestamp: BigInt(GROUP_NOW - 45 * GROUP_DAY) }),
			mockNote({ uuid: testUuid("y2025"), editedTimestamp: BigInt(new Date("2025-06-15T12:00:00.000Z").getTime()) }),
			mockNote({ uuid: testUuid("y2024"), editedTimestamp: BigInt(new Date("2024-06-15T12:00:00.000Z").getTime()) }),
			mockNote({ uuid: testUuid("arch"), archive: true, editedTimestamp: BigInt(GROUP_NOW) }),
			mockNote({ uuid: testUuid("trash"), trash: true, editedTimestamp: BigInt(GROUP_NOW) })
		]

		expect(headerIds(groupNotesForView(notes, GROUP_NOW))).toStrictEqual([
			"pinned",
			"favorited",
			"today",
			"previous7Days",
			"previous30Days",
			"month",
			"year-2025",
			"year-2024",
			"archived",
			"trashed"
		])
	})

	it("pins/favorites/archives/trashes remove a note from its date bucket (first-match-wins)", () => {
		// A pinned note whose edited time is 'today' shows ONLY under Pinned — never also under Today.
		expect(headerIds(groupNotesForView([mockNote({ pinned: true, editedTimestamp: BigInt(GROUP_NOW) })], GROUP_NOW))).toStrictEqual([
			"pinned"
		])
		expect(headerIds(groupNotesForView([mockNote({ favorite: true, editedTimestamp: BigInt(GROUP_NOW) })], GROUP_NOW))).toStrictEqual([
			"favorited"
		])
	})

	it("ranks trash/archive above pin/favorite for membership (a trashed pinned note is Trashed)", () => {
		const notes = [
			mockNote({ uuid: testUuid("tp"), trash: true, pinned: true, editedTimestamp: BigInt(GROUP_NOW) }),
			mockNote({ uuid: testUuid("ap"), archive: true, pinned: true, editedTimestamp: BigInt(GROUP_NOW) })
		]

		// Neither shows under Pinned; archived emits before trashed.
		expect(headerIds(groupNotesForView(notes, GROUP_NOW))).toStrictEqual(["archived", "trashed"])
	})

	it("never renders an empty section", () => {
		expect(headerIds(groupNotesForView([mockNote({ editedTimestamp: BigInt(GROUP_NOW - 60 * 60 * 1000) })], GROUP_NOW))).toStrictEqual([
			"today"
		])
	})

	it("buckets on editedTimestamp, not createdTimestamp (an old note edited today is 'Today')", () => {
		const note = mockNote({
			createdTimestamp: BigInt(new Date("2020-01-01T00:00:00.000Z").getTime()),
			editedTimestamp: BigInt(GROUP_NOW)
		})

		expect(headerIds(groupNotesForView([note], GROUP_NOW))).toStrictEqual(["today"])
	})

	it("orders notes newest-first within a bucket, uuid as the equal-timestamp tiebreak", () => {
		const older = mockNote({ uuid: testUuid("older"), editedTimestamp: BigInt(GROUP_NOW - 2 * 60 * 60 * 1000) })
		const newer = mockNote({ uuid: testUuid("newer"), editedTimestamp: BigInt(GROUP_NOW - 1 * 60 * 60 * 1000) })
		const tieA = mockNote({ uuid: testUuid("a-tie"), editedTimestamp: BigInt(GROUP_NOW - 3 * 60 * 60 * 1000) })
		const tieB = mockNote({ uuid: testUuid("b-tie"), editedTimestamp: BigInt(GROUP_NOW - 3 * 60 * 60 * 1000) })

		const rows = groupNotesForView([older, tieB, newer, tieA], GROUP_NOW)

		// newer → older → (equal ts) a-tie before b-tie by uuid.
		expect(groupedNoteUuids(rows)).toStrictEqual([newer.uuid, older.uuid, tieA.uuid, tieB.uuid])
	})

	it("gives the previous-month header a computed literal label, not a catalog key", () => {
		const rows = groupNotesForView([mockNote({ editedTimestamp: BigInt(GROUP_NOW - 45 * GROUP_DAY) })], GROUP_NOW)
		const header = rows.find((row): row is Extract<NotesSidebarRow, { kind: "header" }> => row.kind === "header")

		expect(header?.label.kind).toBe("literal")
	})
})

describe("notesSidebar.logic — buildNotesGroupedRows (search then group)", () => {
	it("filters by search before grouping", () => {
		// Distinct previews so a title-only search ("alpha") can't accidentally match beta's preview.
		const alpha = mockNote({ uuid: testUuid("alpha"), title: "alpha", preview: "one", editedTimestamp: BigInt(GROUP_NOW) })
		const beta = mockNote({ uuid: testUuid("beta"), title: "beta", preview: "two", editedTimestamp: BigInt(GROUP_NOW) })

		const rows = buildNotesGroupedRows([alpha, beta], "alpha", GROUP_NOW)

		expect(groupedNoteUuids(rows)).toStrictEqual([alpha.uuid])
		expect(headerIds(rows)).toStrictEqual(["today"])
	})

	it("returns an empty row model (no headers) when nothing matches", () => {
		const note = mockNote({ title: "gamma", preview: "delta" })

		expect(buildNotesGroupedRows([note], "nomatch", GROUP_NOW)).toStrictEqual([])
	})
})

describe("notesSidebar.logic — sidebarRowKey (header rows)", () => {
	it("keys a header row by its id", () => {
		expect(sidebarRowKey({ kind: "header", id: "today", label: { kind: "key", key: "notesGroupToday" }, icon: "today" })).toBe(
			"header:today"
		)
	})
})

describe("notesSidebar.logic — selectableRowIndexByKey (click target resolution)", () => {
	it("maps each note row to its own position, even across duplicate rows for the same note", () => {
		// A uuid-keyed map would collapse both rows for `note` onto whichever is built last (index 2),
		// so clicking the FIRST occurrence would be misresolved onto the SECOND row's position.
		// Row-identity keys (sidebarRowKey) keep them distinct.
		const tagA = mockTag({ uuid: testUuid("ta") })
		const tagB = mockTag({ uuid: testUuid("tb") })
		const note = mockNote({ uuid: testUuid("n") })
		const other = mockNote({ uuid: testUuid("o") })
		const rows: NotesSidebarRow[] = [
			{ kind: "note", note, tagUuid: tagA.uuid },
			{ kind: "note", note: other, tagUuid: tagA.uuid },
			{ kind: "note", note, tagUuid: tagB.uuid }
		]

		const indexByKey = selectableRowIndexByKey(rows)

		expect(indexByKey.get(sidebarRowKey({ kind: "note", note, tagUuid: tagA.uuid }))).toBe(0)
		expect(indexByKey.get(sidebarRowKey({ kind: "note", note: other, tagUuid: tagA.uuid }))).toBe(1)
		expect(indexByKey.get(sidebarRowKey({ kind: "note", note, tagUuid: tagB.uuid }))).toBe(2)
	})

	it("skips tag header rows when assigning positions, matching selectableNotesFromRows' own indices", () => {
		const tag = mockTag({ uuid: testUuid("t") })
		const noteA = mockNote({ uuid: testUuid("a") })
		const noteB = mockNote({ uuid: testUuid("b") })
		const rows: NotesSidebarRow[] = [
			{ kind: "tag", tag, noteCount: 2, expanded: true },
			{ kind: "note", note: noteA, tagUuid: tag.uuid },
			{ kind: "note", note: noteB, tagUuid: tag.uuid }
		]

		const indexByKey = selectableRowIndexByKey(rows)

		expect(indexByKey.get(sidebarRowKey({ kind: "note", note: noteA, tagUuid: tag.uuid }))).toBe(0)
		expect(indexByKey.get(sidebarRowKey({ kind: "note", note: noteB, tagUuid: tag.uuid }))).toBe(1)
		expect(selectableNotesFromRows(rows)[indexByKey.get(sidebarRowKey({ kind: "note", note: noteB, tagUuid: tag.uuid })) ?? -1]).toBe(
			noteB
		)
	})
})

describe("filterNotesByBlockedOwner", () => {
	it("hides a note whose ownerId is in the blocked set", () => {
		const blockedOwnerNote = mockNote({ uuid: testUuid("a"), ownerId: 2n })
		const okNote = mockNote({ uuid: testUuid("b"), ownerId: 3n })
		const blocked = deriveBlockedUsers([{ uuid: testUuid("bc"), userId: 2n, email: "owner@x.io", nickName: "", timestamp: 0n }])

		expect(filterNotesByBlockedOwner([blockedOwnerNote, okNote], blocked)).toEqual([okNote])
	})

	it("owner-based only: a blocked PARTICIPANT (not the owner) never hides the note", () => {
		// Mirrors mobile's filterNotesByBlockedOwner exactly — only note.ownerId is checked, a blocked
		// co-participant on a note owned by someone else (or by you) has no bearing on this filter.
		const note = mockNote({
			uuid: testUuid("a"),
			ownerId: 3n,
			participants: [{ userId: 2n, isOwner: false, email: "p@x.io", nickName: "", permissionsWrite: true, addedTimestamp: 0n }]
		})
		const blocked = deriveBlockedUsers([{ uuid: testUuid("bc"), userId: 2n, email: "p@x.io", nickName: "", timestamp: 0n }])

		expect(filterNotesByBlockedOwner([note], blocked)).toEqual([note])
	})

	it("is a no-op (same notes, unfiltered) when the blocked set is empty", () => {
		const notes = [mockNote({ uuid: testUuid("a") }), mockNote({ uuid: testUuid("b"), ownerId: 2n })]

		expect(filterNotesByBlockedOwner(notes, EMPTY_BLOCKED_USERS)).toEqual(notes)
	})
})

describe("notesSidebar.logic — untagged virtual row", () => {
	const work = mockTag({ uuid: testUuid("work"), name: "work" })
	const zebra = mockTag({ uuid: testUuid("zebra"), name: "zebra" })
	const tagged = mockNote({ uuid: testUuid("a"), title: "alpha", tags: [work], editedTimestamp: 9n })
	const zTagged = mockNote({ uuid: testUuid("z"), title: "zulu", tags: [zebra], editedTimestamp: 8n })
	const bare = mockNote({ uuid: testUuid("b"), title: "beta", tags: [], editedTimestamp: 2n })
	const bare2 = mockNote({ uuid: testUuid("c"), title: "gamma", tags: [], editedTimestamp: 1n })

	function rowsFor(params: { search?: string; sortBy?: NoteTagsSortBy; expanded?: ReadonlySet<string>; notes?: Note[] }) {
		const notes = params.notes ?? [tagged, zTagged, bare, bare2]

		return buildTagsViewRows({
			tags: [work, zebra],
			notesByTag: buildNotesByTag(notes),
			expandedTagUuids: params.expanded ?? new Set(),
			search: params.search ?? "",
			sortBy: params.sortBy ?? DEFAULT_NOTE_TAGS_SORT_BY,
			untaggedLabel: "Untagged"
		})
	}

	it("appends the virtual row LAST, after the sorted real tags, for every sort order", () => {
		for (const sortBy of ["nameAsc", "nameDesc", "lastActivityDesc", "notesCountAsc"] as const) {
			const uuids = tagRowUuids(rowsFor({ sortBy }))

			expect(uuids.at(-1)).toBe(UNTAGGED_TAG_UUID)
			expect(uuids).toHaveLength(3)
		}
	})

	it("carries the untagged count on its own row", () => {
		const row = rowsFor({}).find(
			(r): r is Extract<NotesSidebarRow, { kind: "tag" }> => r.kind === "tag" && isUntaggedTagUuid(r.tag.uuid)
		)

		expect(row?.noteCount).toBe(2)
		expect(row?.tag.name).toBe("Untagged")
		expect(row?.tag.favorite).toBe(false)
	})

	it("hides the row when nothing is untagged", () => {
		expect(tagRowUuids(rowsFor({ notes: [tagged], sortBy: "nameAsc" }))).toStrictEqual([work.uuid, zebra.uuid])
	})

	it("is filtered by search exactly like a real tag — by its label, or by one of its member notes", () => {
		expect(tagRowUuids(rowsFor({ search: "untag" }))).toStrictEqual([UNTAGGED_TAG_UUID])
		expect(tagRowUuids(rowsFor({ search: "gamma" }))).toStrictEqual([UNTAGGED_TAG_UUID])
		expect(tagRowUuids(rowsFor({ search: "nothing matches this" }))).toStrictEqual([])
	})

	it("expands into its member note rows, keyed uniquely against every real group", () => {
		const rows = rowsFor({ expanded: new Set([work.uuid, UNTAGGED_TAG_UUID]) })
		const noteRows = rows.filter((r): r is Extract<NotesSidebarRow, { kind: "note" }> => r.kind === "note")
		const untaggedRows = noteRows.filter(r => r.tagUuid === UNTAGGED_TAG_UUID)

		expect(untaggedRows.map(r => r.note.uuid)).toStrictEqual([bare.uuid, bare2.uuid])
		expect(new Set(noteRows.map(sidebarRowKey)).size).toBe(noteRows.length)
	})

	it("a real tag literally named Untagged keeps its own uuid and is never collapsed into the virtual row", () => {
		const impostor = mockTag({ uuid: testUuid("impostor"), name: "Untagged" })
		const note = mockNote({ uuid: testUuid("i"), tags: [impostor] })

		const rows = buildTagsViewRows({
			tags: [impostor],
			notesByTag: buildNotesByTag([note, bare]),
			expandedTagUuids: new Set(),
			search: "",
			sortBy: DEFAULT_NOTE_TAGS_SORT_BY,
			untaggedLabel: "Untagged"
		})

		expect(tagRowUuids(rows)).toStrictEqual([impostor.uuid, UNTAGGED_TAG_UUID])
		expect(isUntaggedTagUuid(impostor.uuid)).toBe(false)
		expect(isUntaggedTagUuid(UNTAGGED_TAG_UUID)).toBe(true)
	})
})
