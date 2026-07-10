import { describe, expect, it } from "vitest"
import type { Note, NoteTag, UuidStr } from "@filen/sdk-rs"
import {
	buildNotesView,
	buildNotesByTag,
	buildTagsViewRows,
	filterTagsForView,
	sidebarRowKey,
	type NotesSidebarRow
} from "@/features/notes/components/notesSidebar.logic"
import { DEFAULT_NOTE_TAGS_SORT_BY } from "@/features/notes/lib/sort"

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
		// An untagged note contributes to no bucket.
		expect(Object.keys(byTag)).toHaveLength(2)
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
			sortBy: DEFAULT_NOTE_TAGS_SORT_BY
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
			sortBy: DEFAULT_NOTE_TAGS_SORT_BY
		})

		// tag(work) → note(b, edited 5n) → note(a, edited 2n) → tag(home) collapsed.
		expect(rows.map(r => (r.kind === "tag" ? `T:${r.tag.uuid}` : `N:${r.note.uuid}`))).toStrictEqual([
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
			sortBy: DEFAULT_NOTE_TAGS_SORT_BY
		})
		expect(noteRowUuids(nameMatched)).toStrictEqual([b.uuid, a.uuid])

		// "alpha" matches note a only → work stays (member match) and expands to just a; home drops out.
		const memberMatched = buildTagsViewRows({
			tags: [work, home],
			notesByTag,
			expandedTagUuids: new Set([work.uuid, home.uuid]),
			search: "alpha",
			sortBy: DEFAULT_NOTE_TAGS_SORT_BY
		})
		expect(tagRowUuids(memberMatched)).toStrictEqual([work.uuid])
		expect(noteRowUuids(memberMatched)).toStrictEqual([a.uuid])
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
