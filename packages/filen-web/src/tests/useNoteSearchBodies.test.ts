import { describe, expect, it } from "vitest"
import type { Note, UuidStr } from "@filen/sdk-rs"
import { noteSearchBodyCandidates, buildNoteBodiesMap } from "@/features/notes/hooks/useNoteSearchBodies.logic"

// UuidStr is a template-literal brand requiring at least 3 dashes — mirrors notesSort.test.ts's own
// testUuid helper.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
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

describe("noteSearchBodyCandidates", () => {
	it("returns no candidates at all for a blank query — the whole opt-in gate", () => {
		const notes = [mockNote({ uuid: testUuid("a"), title: "Groceries" })]

		expect(noteSearchBodyCandidates(notes, "")).toEqual([])
		expect(noteSearchBodyCandidates(notes, "   ")).toEqual([])
	})

	it("excludes a note whose title already matches — its body never needs fetching", () => {
		const titleMatch = mockNote({ uuid: testUuid("title-match"), title: "Quarterly Report" })
		const titleMiss = mockNote({ uuid: testUuid("title-miss"), title: "Unrelated" })

		expect(noteSearchBodyCandidates([titleMatch, titleMiss], "quarterly")).toEqual([titleMiss])
	})

	it("includes every note when no title matches at all", () => {
		const a = mockNote({ uuid: testUuid("a"), title: "Alpha" })
		const b = mockNote({ uuid: testUuid("b"), title: "Beta" })

		expect(noteSearchBodyCandidates([a, b], "zzz")).toEqual([a, b])
	})
})

describe("buildNoteBodiesMap", () => {
	it("zips candidates to their positionally-parallel fetched bodies", () => {
		const a = mockNote({ uuid: testUuid("a") })
		const b = mockNote({ uuid: testUuid("b") })

		const map = buildNoteBodiesMap([a, b], ["body a", "body b"])

		expect(map.get(testUuid("a"))).toBe("body a")
		expect(map.get(testUuid("b"))).toBe("body b")
	})

	it("keeps a still-in-flight fetch's slot as undefined rather than dropping the entry", () => {
		const a = mockNote({ uuid: testUuid("a") })

		const map = buildNoteBodiesMap([a], [undefined])

		expect(map.has(testUuid("a"))).toBe(true)
		expect(map.get(testUuid("a"))).toBeUndefined()
	})

	it("returns an empty map for no candidates", () => {
		expect(buildNoteBodiesMap([], [])).toEqual(new Map())
	})
})
