import { describe, it, expect } from "vitest"
import { partitionNotesByBucket, type NoteBucketId } from "@filen/shared"

type TestItem = {
	id: string
	pinned: boolean
	favorite: boolean
	archive: boolean
	trash: boolean
	ts: number
}

function item(overrides: Partial<TestItem> & { id: string; ts: number }): TestItem {
	return {
		pinned: false,
		favorite: false,
		archive: false,
		trash: false,
		...overrides
	}
}

// Newest-first, no tiebreak — mirrors mobile's current within-bucket comparator so the extraction
// changes no observable ordering.
const byTsDesc = (a: TestItem, b: TestItem): number => b.ts - a.ts

const FROZEN_NOW = new Date("2025-06-15T12:00:00.000Z").getTime()
const DAY_MS = 24 * 60 * 60 * 1000

function ids(notes: readonly TestItem[]): string[] {
	return notes.map(note => note.id)
}

describe("partitionNotesByBucket", () => {
	it("returns an empty array for empty input", () => {
		expect(partitionNotesByBucket([], FROZEN_NOW, byTsDesc)).toEqual([])
	})

	it("diverts a pinned note into the pinned bucket ahead of date bucketing", () => {
		const pinned = item({ id: "pinned-1", ts: FROZEN_NOW, pinned: true })

		const result = partitionNotesByBucket([pinned], FROZEN_NOW, byTsDesc)

		expect(result).toEqual([{ bucketId: "pinned", notes: [pinned] }])
	})

	it("diverts a favorited note into the favorited bucket", () => {
		const favorited = item({ id: "fav-1", ts: FROZEN_NOW, favorite: true })

		const result = partitionNotesByBucket([favorited], FROZEN_NOW, byTsDesc)

		expect(result).toEqual([{ bucketId: "favorited", notes: [favorited] }])
	})

	it("diverts an archived note into the archived bucket", () => {
		const archived = item({ id: "arch-1", ts: FROZEN_NOW, archive: true })

		const result = partitionNotesByBucket([archived], FROZEN_NOW, byTsDesc)

		expect(result).toEqual([{ bucketId: "archived", notes: [archived] }])
	})

	it("diverts a trashed note into the trashed bucket", () => {
		const trashed = item({ id: "trash-1", ts: FROZEN_NOW, trash: true })

		const result = partitionNotesByBucket([trashed], FROZEN_NOW, byTsDesc)

		expect(result).toEqual([{ bucketId: "trashed", notes: [trashed] }])
	})

	it("first-match-wins: trash beats archive/pinned/favorite", () => {
		const note = item({ id: "n1", ts: FROZEN_NOW, trash: true, archive: true, pinned: true, favorite: true })

		const result = partitionNotesByBucket([note], FROZEN_NOW, byTsDesc)

		expect(result).toEqual([{ bucketId: "trashed", notes: [note] }])
	})

	it("first-match-wins: archive beats pinned/favorite", () => {
		const note = item({ id: "n1", ts: FROZEN_NOW, archive: true, pinned: true, favorite: true })

		const result = partitionNotesByBucket([note], FROZEN_NOW, byTsDesc)

		expect(result).toEqual([{ bucketId: "archived", notes: [note] }])
	})

	it("first-match-wins: pinned beats favorite", () => {
		const note = item({ id: "n1", ts: FROZEN_NOW, pinned: true, favorite: true })

		const result = partitionNotesByBucket([note], FROZEN_NOW, byTsDesc)

		expect(result).toEqual([{ bucketId: "pinned", notes: [note] }])
	})

	it("places a note edited <24h ago into the today bucket", () => {
		const note = item({ id: "today-1", ts: FROZEN_NOW - 2 * 60 * 60 * 1000 })

		const result = partitionNotesByBucket([note], FROZEN_NOW, byTsDesc)

		expect(result).toEqual([{ bucketId: "today", notes: [note] }])
	})

	it("places a note edited 3 days ago into the previous7Days bucket", () => {
		const note = item({ id: "7d-1", ts: FROZEN_NOW - 3 * DAY_MS })

		const result = partitionNotesByBucket([note], FROZEN_NOW, byTsDesc)

		expect(result).toEqual([{ bucketId: "previous7Days", notes: [note] }])
	})

	it("places a note edited 15 days ago into the previous30Days bucket", () => {
		const note = item({ id: "30d-1", ts: FROZEN_NOW - 15 * DAY_MS })

		const result = partitionNotesByBucket([note], FROZEN_NOW, byTsDesc)

		expect(result).toEqual([{ bucketId: "previous30Days", notes: [note] }])
	})

	it("places a note edited ~45 days ago into the single month bucket, labelled with twoMonthsAgo", () => {
		const note = item({ id: "month-1", ts: FROZEN_NOW - 45 * DAY_MS })

		const result = partitionNotesByBucket([note], FROZEN_NOW, byTsDesc)

		const nowDate = new Date(FROZEN_NOW)
		const twoMonthsAgo = new Date(nowDate.getFullYear(), nowDate.getMonth() - 2, nowDate.getDate()).getTime()

		expect(result).toEqual([{ bucketId: { kind: "month", monthTimestamp: twoMonthsAgo }, notes: [note] }])
	})

	it("places a note older than two months into a calendar-year bucket, not the month bucket", () => {
		const twoYearsAgoMs = FROZEN_NOW - 2 * 365 * DAY_MS
		const note = item({ id: "year-1", ts: twoYearsAgoMs })

		const result = partitionNotesByBucket([note], FROZEN_NOW, byTsDesc)
		const expectedYear = new Date(twoYearsAgoMs).getFullYear()

		expect(result).toEqual([{ bucketId: { kind: "year", year: expectedYear }, notes: [note] }])
	})

	it("emits year buckets in descending year order", () => {
		const threeYearsAgo = item({ id: "3y", ts: FROZEN_NOW - 3 * 365 * DAY_MS })
		const twoYearsAgo = item({ id: "2y", ts: FROZEN_NOW - 2 * 365 * DAY_MS })

		const result = partitionNotesByBucket([threeYearsAgo, twoYearsAgo], FROZEN_NOW, byTsDesc)
		const yearIds = result.map(bucket => (typeof bucket.bucketId === "object" && bucket.bucketId.kind === "year" ? bucket.bucketId.year : null))

		expect(yearIds).toEqual([...yearIds].sort((a, b) => (b ?? 0) - (a ?? 0)))
		expect(result).toHaveLength(2)
	})

	it("skips empty buckets entirely — no header-only entries", () => {
		const note = item({ id: "only", ts: FROZEN_NOW })

		const result = partitionNotesByBucket([note], FROZEN_NOW, byTsDesc)

		expect(result).toEqual([{ bucketId: "today", notes: [note] }])
	})

	it("emits buckets in pinned -> favorited -> today -> 7d -> 30d -> month -> year(desc) -> archived -> trashed order", () => {
		const pinned = item({ id: "pinned", ts: FROZEN_NOW, pinned: true })
		const favorited = item({ id: "favorited", ts: FROZEN_NOW, favorite: true })
		const today = item({ id: "today", ts: FROZEN_NOW })
		const sevenDays = item({ id: "7d", ts: FROZEN_NOW - 3 * DAY_MS })
		const thirtyDays = item({ id: "30d", ts: FROZEN_NOW - 15 * DAY_MS })
		const month = item({ id: "month", ts: FROZEN_NOW - 45 * DAY_MS })
		const year = item({ id: "year", ts: FROZEN_NOW - 2 * 365 * DAY_MS })
		const archived = item({ id: "archived", ts: FROZEN_NOW, archive: true })
		const trashed = item({ id: "trashed", ts: FROZEN_NOW, trash: true })

		const result = partitionNotesByBucket(
			[trashed, archived, year, month, thirtyDays, sevenDays, today, favorited, pinned],
			FROZEN_NOW,
			byTsDesc
		)

		const order: NoteBucketId[] = result.map(bucket => bucket.bucketId)

		expect(order[0]).toBe("pinned")
		expect(order[1]).toBe("favorited")
		expect(order[2]).toBe("today")
		expect(order[3]).toBe("previous7Days")
		expect(order[4]).toBe("previous30Days")
		expect(order[5]).toEqual(expect.objectContaining({ kind: "month" }))
		expect(order[6]).toEqual(expect.objectContaining({ kind: "year" }))
		expect(order[7]).toBe("archived")
		expect(order[8]).toBe("trashed")
	})

	it("sorts each bucket with the injected comparator (newest first, no tiebreak)", () => {
		const older = item({ id: "older", ts: FROZEN_NOW - 60_000 })
		const newer = item({ id: "newer", ts: FROZEN_NOW - 1_000 })

		const result = partitionNotesByBucket([older, newer], FROZEN_NOW, byTsDesc)

		expect(result).toHaveLength(1)
		expect(ids(result[0]?.notes ?? [])).toEqual(["newer", "older"])
	})

	it("honors a different injected comparator (e.g. id ascending) without changing bucket assignment", () => {
		const b = item({ id: "b", ts: FROZEN_NOW })
		const a = item({ id: "a", ts: FROZEN_NOW })

		const byIdAsc = (x: TestItem, y: TestItem): number => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
		const result = partitionNotesByBucket([b, a], FROZEN_NOW, byIdAsc)

		expect(result).toHaveLength(1)
		expect(ids(result[0]?.notes ?? [])).toEqual(["a", "b"])
	})

	it("year-0 note is not dropped (falsy-year guard regression)", () => {
		// Proleptic Gregorian year 0: new Date(-62167219200000).getFullYear() === 0.
		const year0Ts = -62167219200000
		const note = item({ id: "year-zero", ts: year0Ts })

		const result = partitionNotesByBucket([note], FROZEN_NOW, byTsDesc)

		expect(result).toEqual([{ bucketId: { kind: "year", year: 0 }, notes: [note] }])
	})

	it("does not mutate the input array", () => {
		const older = item({ id: "older", ts: FROZEN_NOW - 60_000 })
		const newer = item({ id: "newer", ts: FROZEN_NOW - 1_000 })
		const input = [older, newer]

		partitionNotesByBucket(input, FROZEN_NOW, byTsDesc)

		expect(input).toEqual([older, newer])
	})
})
