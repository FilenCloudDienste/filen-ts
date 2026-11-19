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

	it("places a note edited ~45 days ago into the bucket of its own calendar month", () => {
		const note = item({ id: "month-1", ts: FROZEN_NOW - 45 * DAY_MS })

		const result = partitionNotesByBucket([note], FROZEN_NOW, byTsDesc)

		const noteDate = new Date(note.ts)
		const monthStart = new Date(noteDate.getFullYear(), noteDate.getMonth(), 1).getTime()

		expect(result).toEqual([{ bucketId: { kind: "month", monthTimestamp: monthStart, inCurrentYear: true }, notes: [note] }])
	})

	describe("calendar-month buckets", () => {
		// Local components so the bounds hold in every time zone.
		const NOV_18 = new Date(2025, 10, 18, 12).getTime()

		it("buckets notes older than 30 days by their own month, newest month first", () => {
			const oct5 = item({ id: "oct-5", ts: new Date(2025, 9, 5, 12).getTime() })
			const oct18 = item({ id: "oct-18", ts: new Date(2025, 9, 18, 9).getTime() })
			const sep20 = item({ id: "sep-20", ts: new Date(2025, 8, 20, 12).getTime() })
			const sep1 = item({ id: "sep-1", ts: new Date(2025, 8, 1, 0).getTime() })

			const result = partitionNotesByBucket([sep1, sep20, oct5, oct18], NOV_18, byTsDesc)

			expect(result).toEqual([
				{
					bucketId: { kind: "month", monthTimestamp: new Date(2025, 9, 1).getTime(), inCurrentYear: true },
					notes: [oct18, oct5]
				},
				{
					bucketId: { kind: "month", monthTimestamp: new Date(2025, 8, 1).getTime(), inCurrentYear: true },
					notes: [sep20, sep1]
				}
			])
		})

		it("sends a note from before the month two months back to its year bucket", () => {
			const aug31 = item({ id: "aug-31", ts: new Date(2025, 7, 31, 23, 59).getTime() })

			const result = partitionNotesByBucket([aug31], NOV_18, byTsDesc)

			expect(result).toEqual([{ bucketId: { kind: "year", year: 2025 }, notes: [aug31] }])
		})

		it("keeps a note from the first day of a 31-day current month in that month's bucket", () => {
			const oct31 = new Date(2025, 9, 31, 23).getTime()
			const oct1 = item({ id: "oct-1", ts: new Date(2025, 9, 1, 0, 30).getTime() })

			const result = partitionNotesByBucket([oct1], oct31, byTsDesc)

			expect(result).toEqual([
				{ bucketId: { kind: "month", monthTimestamp: new Date(2025, 9, 1).getTime(), inCurrentYear: true }, notes: [oct1] }
			])
		})

		it("marks a month of the previous year so the label can name the year (January now)", () => {
			const jan10 = new Date(2026, 0, 10, 12).getTime()
			const dec5 = item({ id: "dec-5", ts: new Date(2025, 11, 5, 12).getTime() })
			const nov20 = item({ id: "nov-20", ts: new Date(2025, 10, 20, 12).getTime() })
			const oct20 = item({ id: "oct-20", ts: new Date(2025, 9, 20, 12).getTime() })

			const result = partitionNotesByBucket([oct20, nov20, dec5], jan10, byTsDesc)

			expect(result).toEqual([
				{ bucketId: { kind: "month", monthTimestamp: new Date(2025, 11, 1).getTime(), inCurrentYear: false }, notes: [dec5] },
				{ bucketId: { kind: "month", monthTimestamp: new Date(2025, 10, 1).getTime(), inCurrentYear: false }, notes: [nov20] },
				{ bucketId: { kind: "year", year: 2025 }, notes: [oct20] }
			])
		})
	})

	it("places a note older than two months into a calendar-year bucket, not a month bucket", () => {
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
		const yearIds = result.map(bucket =>
			typeof bucket.bucketId === "object" && bucket.bucketId.kind === "year" ? bucket.bucketId.year : null
		)

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
		// Built from local components so the local year is 0 in every time zone. The constructor maps
		// years 0-99 to 1900-1999, hence setFullYear.
		const year0Date = new Date(2000, 5, 15, 12)

		year0Date.setFullYear(0)

		const year0Ts = year0Date.getTime()
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
