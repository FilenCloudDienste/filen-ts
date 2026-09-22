/**
 * HARDENING suite for src/lib/sort.ts — contract tripwires added ahead of the perf
 * campaign (2026-06-11), mirroring the offline/cameraUpload lesson: perf rewrites exploit
 * whatever the suite under-specifies.
 *
 * What this file pins (itemSorter's own bigint-fidelity, equal-key-at-scale and dirs-first
 * hardening moved to @filen/shared's driveSortEngine.test.ts with the engine it tests):
 *
 * 1. group() HEADER SEQUENCE with every bucket populated — pinned → favorited → today →
 *    7days → 30days → month → year buckets (descending) → archived → trashed, and the
 *    output contains every input note exactly once (no drops, no duplicates).
 * 2. sort() undefined-editedTimestamp pair takes the uuid tiebreak (undefined === undefined
 *    is the EQUALITY path — a rewrite comparing via Number() would turn it into NaN math).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest"

vi.mock("@/lib/i18n", () => ({
	default: {
		t: (key: string) => key
	}
}))

vi.mock("@/lib/time", () => ({
	intlLanguage: "en-US"
}))

import { notesSorter } from "@/lib/sort"
import { type Note } from "@/types"

function makeNote(overrides: Partial<Note> & { uuid: string; editedTimestamp: bigint }): Note {
	return {
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		trash: false,
		archive: false,
		undecryptable: false,
		createdTimestamp: overrides.editedTimestamp,
		participants: [],
		...overrides
	} as Note
}

describe("hardening — group() full header sequence + completeness", () => {
	const FROZEN_NOW = new Date("2025-06-15T12:00:00.000Z").getTime()

	beforeAll(() => {
		vi.useFakeTimers()
		vi.setSystemTime(FROZEN_NOW)
	})

	afterAll(() => {
		vi.useRealTimers()
	})

	it("with every bucket populated, headers appear in the exact canonical order and no note is dropped or duplicated", () => {
		const day = 24 * 60 * 60 * 1000
		const notes: Note[] = []
		let id = 0

		const push = (tsMs: number, extra?: Partial<Note>) => {
			notes.push(
				makeNote({
					uuid: `note-${String(id++).padStart(4, "0")}`,
					editedTimestamp: BigInt(tsMs),
					...extra
				})
			)
		}

		// 20 per bucket: pinned, favorited, today, 7d, 30d, month, two year buckets,
		// archived, trashed — interleaved so bucket membership is input-order-independent.
		for (let i = 0; i < 20; i++) {
			push(FROZEN_NOW - 1000 - i, { pinned: true })
			push(FROZEN_NOW - 2000 - i, { favorite: true })
			push(FROZEN_NOW - 2 * 60 * 60 * 1000 - i)
			push(FROZEN_NOW - 3 * day - i)
			push(FROZEN_NOW - 15 * day - i)
			push(FROZEN_NOW - 45 * day - i)
			push(new Date("2023-03-10T00:00:00.000Z").getTime() + i)
			push(new Date("2021-08-01T00:00:00.000Z").getTime() + i)
			push(FROZEN_NOW - 5000 - i, { archive: true })
			push(FROZEN_NOW - 6000 - i, { trash: true })
		}

		const result = notesSorter.group(notes)

		const headerIds = result.filter(item => item.type === "header").map(item => ("id" in item ? item.id : ""))

		expect(headerIds).toEqual([
			"header-pinned",
			"header-favorited",
			"header-today",
			"header-7days",
			"header-30days",
			"header-month",
			"header-2023",
			"header-2021",
			"header-archived",
			"header-trashed"
		])

		// Completeness: every input note appears exactly once.
		const outputUuids = result.filter(item => item.type === "note").map(item => ("uuid" in item ? item.uuid : ""))

		expect(outputUuids).toHaveLength(notes.length)
		expect(new Set(outputUuids).size).toBe(notes.length)

		// Within every bucket the notes are ordered by effective timestamp DESCENDING.
		let bucket: number[] = []
		const flushCheck = () => {
			for (let i = 1; i < bucket.length; i++) {
				const prev = bucket[i - 1] ?? 0
				const curr = bucket[i] ?? 0

				expect(prev, "bucket must be timestamp-descending").toBeGreaterThanOrEqual(curr)
			}

			bucket = []
		}

		for (const item of result) {
			if (item.type === "header") {
				flushCheck()
			} else if ("editedTimestamp" in item) {
				bucket.push(Number(item.editedTimestamp ?? 0n))
			}
		}

		flushCheck()
	})
})

describe("hardening — sort() undefined-editedTimestamp equality path", () => {
	it("two notes with undefined editedTimestamp take the uuid tiebreak (undefined === undefined), larger numeric uuid first", () => {
		const noteA = {
			...makeNote({ uuid: "aaa-111", editedTimestamp: 0n }),
			editedTimestamp: undefined as unknown as bigint
		}
		const noteB = {
			...makeNote({ uuid: "bbb-222", editedTimestamp: 0n }),
			editedTimestamp: undefined as unknown as bigint
		}

		// Equality path: undefined === undefined → uuid tiebreak (desc: 222 before 111).
		// A rewrite that compares via Number() first would hit NaN arithmetic instead.
		const result1 = notesSorter.sort([noteA, noteB])
		const result2 = notesSorter.sort([noteB, noteA])

		expect(result1.map(n => n.uuid)).toEqual(["bbb-222", "aaa-111"])
		expect(result2.map(n => n.uuid)).toEqual(["bbb-222", "aaa-111"])
	})

	it("0n editedTimestamp is NOT treated as nullish by sort(): it compares as 0, not via any fallback", () => {
		const zero = makeNote({ uuid: "zero-1", editedTimestamp: 0n, createdTimestamp: 9_999_999n })
		const positive = makeNote({ uuid: "pos-2", editedTimestamp: 5000n, createdTimestamp: 1n })

		const result = notesSorter.sort([zero, positive])

		// Descending by editedTimestamp: 5000n before 0n — createdTimestamp must not leak in.
		expect(result.map(n => n.uuid)).toEqual(["pos-2", "zero-1"])
	})
})
