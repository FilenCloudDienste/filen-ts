/**
 * HARDENING suite for src/lib/sort.ts — contract tripwires added ahead of the perf
 * campaign (2026-06-11), mirroring the offline/cameraUpload lesson: perf rewrites exploit
 * whatever the suite under-specifies.
 *
 * What this file pins that sort.test.ts does not:
 *
 * 1. BIGINT FIELD FIDELITY — production DriveItems carry bigint timestamp/modified/created
 *    (SDK types); sort.test.ts fixtures use plain numbers. Every timestamp mode must order
 *    bigint-fielded items identically to their number-fielded twins.
 * 2. EQUAL-KEY STABILITY AT SCALE — comparator-0 pairs (equal names, equal ts + equal
 *    numeric uuid) must preserve input order across hundreds of items, for asc AND desc.
 *    A rewrite that loses sort stability (or negates "stability" along with the key) dies
 *    here.
 * 3. DIRS-FIRST × ALL 12 MODES on interleaved input — every directory-class item precedes
 *    every file-class item regardless of mode/direction, with class membership exactly
 *    {directory, sharedDirectory, sharedRootDirectory} vs the rest.
 * 4. group() HEADER SEQUENCE with every bucket populated — pinned → favorited → today →
 *    7days → 30days → month → year buckets (descending) → archived → trashed, and the
 *    output contains every input note exactly once (no drops, no duplicates).
 * 5. sort() undefined-editedTimestamp pair takes the uuid tiebreak (undefined === undefined
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

import { itemSorter, notesSorter, type SortByType } from "@/lib/sort"
import { type DriveItem, type Note } from "@/types"

const ALL_MODES: SortByType[] = [
	"nameAsc",
	"nameDesc",
	"sizeAsc",
	"sizeDesc",
	"mimeAsc",
	"mimeDesc",
	"lastModifiedAsc",
	"lastModifiedDesc",
	"uploadDateAsc",
	"uploadDateDesc",
	"creationAsc",
	"creationDesc",
	"captureAsc",
	"captureDesc"
]

const DIR_TYPES = new Set(["directory", "sharedDirectory", "sharedRootDirectory"])

function makeItemWith(
	type: string,
	name: string,
	fields: {
		uuid: string
		size?: bigint
		timestamp?: number | bigint
		modified?: number | bigint
		created?: number | bigint
		mime?: string
	}
): DriveItem {
	return {
		type,
		data: {
			uuid: fields.uuid,
			size: fields.size ?? 0n,
			timestamp: fields.timestamp ?? 1000,
			decryptedMeta: {
				name,
				mime: fields.mime ?? "application/octet-stream",
				modified: fields.modified ?? fields.timestamp ?? 1000,
				created: fields.created ?? fields.timestamp ?? 1000
			},
			undecryptable: false
		}
	} as unknown as DriveItem
}

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

describe("hardening — bigint field fidelity across all timestamp modes", () => {
	const TIMESTAMP_MODES: SortByType[] = [
		"lastModifiedAsc",
		"lastModifiedDesc",
		"uploadDateAsc",
		"uploadDateDesc",
		"creationAsc",
		"creationDesc",
		"captureAsc",
		"captureDesc"
	]

	it("bigint-fielded items order identically to number-fielded twins (500 mixed items, every timestamp mode)", () => {
		const count = 500
		const numberItems: DriveItem[] = []
		const bigintItems: DriveItem[] = []

		for (let i = 0; i < count; i++) {
			// Deterministic scatter; collisions on purpose (every 7th shares a timestamp).
			const ts = 1_700_000_000_000 + (i % 7 === 0 ? 5000 : i * 1337)
			const modified = ts + (i % 11) * 1000
			const created = ts - (i % 5) * 1000
			const type = i % 9 === 0 ? "directory" : i % 13 === 0 ? "sharedFile" : "file"
			const uuid = `${String(i).padStart(8, "0")}-aaaa-bbbb-cccc-000000000000`
			const name = `item_${i}.bin`

			numberItems.push(
				makeItemWith(type, name, {
					uuid,
					timestamp: ts,
					modified,
					created
				})
			)
			bigintItems.push(
				makeItemWith(type, name, {
					uuid,
					timestamp: BigInt(ts),
					modified: BigInt(modified),
					created: BigInt(created)
				})
			)
		}

		for (const mode of TIMESTAMP_MODES) {
			const numberOrder = itemSorter.sortItems(numberItems, mode).map(item => item.data.uuid)
			const bigintOrder = itemSorter.sortItems(bigintItems, mode).map(item => item.data.uuid)

			expect(bigintOrder, `mode ${mode}`).toEqual(numberOrder)
		}
	})

	it("sizeAsc/sizeDesc order bigint sizes exactly (incl. values beyond 2^53)", () => {
		// Two sizes that collapse to the SAME Number() but differ as bigints — a rewrite
		// that converts size to Number for comparison breaks this ordering.
		const base = 2n ** 60n
		const a = makeItemWith("file", "a.bin", { uuid: "aaaa-1111", size: base + 1n })
		const b = makeItemWith("file", "b.bin", { uuid: "bbbb-2222", size: base })
		const c = makeItemWith("file", "c.bin", { uuid: "cccc-3333", size: 1000n })

		const asc = itemSorter.sortItems([a, b, c], "sizeAsc")

		expect(asc.map(item => item.data.uuid)).toEqual(["cccc-3333", "bbbb-2222", "aaaa-1111"])

		const desc = itemSorter.sortItems([c, b, a], "sizeDesc")

		expect(desc.map(item => item.data.uuid)).toEqual(["aaaa-1111", "bbbb-2222", "cccc-3333"])
	})
})

describe("hardening — equal-key stability at scale", () => {
	it("400 equal-name files keep exact input order under nameAsc AND nameDesc", () => {
		const items: DriveItem[] = []

		for (let i = 0; i < 400; i++) {
			items.push(
				makeItemWith("file", "same-name.txt", {
					// Identical numeric value from every uuid so no hidden tiebreak applies.
					uuid: `uuid-${String(i).padStart(4, "0")}`,
					timestamp: 1000
				})
			)
		}

		// All comparator keys equal → a stable sort must return the input order verbatim,
		// for BOTH directions (negating a 0 comparison is still 0).
		const asc = itemSorter.sortItems(items, "nameAsc")
		const desc = itemSorter.sortItems(items, "nameDesc")

		for (let i = 0; i < items.length; i++) {
			expect(asc[i], `asc index ${i}`).toBe(items[i])
			expect(desc[i], `desc index ${i}`).toBe(items[i])
		}
	})

	it("equal-timestamp equal-uuid-number files keep input order under uploadDateAsc/Desc", () => {
		const items: DriveItem[] = []

		for (let i = 0; i < 300; i++) {
			// parseNumbersFromString sees the SAME digits for every uuid → tiebreak diff 0.
			items.push(
				makeItemWith("file", `file-${i}.txt`, {
					uuid: `aaaa-1111-${"x".repeat(i % 7)}`,
					timestamp: 5000
				})
			)
		}

		const asc = itemSorter.sortItems(items, "uploadDateAsc")
		const desc = itemSorter.sortItems(items, "uploadDateDesc")

		for (let i = 0; i < items.length; i++) {
			expect(asc[i], `asc index ${i}`).toBe(items[i])
			expect(desc[i], `desc index ${i}`).toBe(items[i])
		}
	})
})

describe("hardening — dirs-first across ALL 12 modes on interleaved input", () => {
	it("every directory-class item precedes every file-class item in every mode", () => {
		const items: DriveItem[] = []
		const types = ["file", "directory", "sharedFile", "sharedDirectory", "sharedRootFile", "sharedRootDirectory"]

		for (let i = 0; i < 600; i++) {
			const type = types[i % types.length] ?? "file"

			items.push(
				makeItemWith(type, `entry_${(i * 31) % 600}.dat`, {
					uuid: `${String((i * 17) % 600).padStart(6, "0")}-0000-0000-0000-000000000000`,
					size: BigInt((i * 13) % 1000),
					timestamp: 1_700_000_000_000 + ((i * 7919) % 100_000),
					modified: 1_700_000_000_000 + ((i * 104729) % 100_000),
					created: 1_700_000_000_000 + ((i * 1299709) % 100_000)
				})
			)
		}

		const dirCount = items.filter(item => DIR_TYPES.has(item.type)).length

		for (const mode of ALL_MODES) {
			const result = itemSorter.sortItems(items, mode)

			expect(result, `mode ${mode} length`).toHaveLength(items.length)

			for (let i = 0; i < result.length; i++) {
				const isDir = DIR_TYPES.has(result[i]?.type ?? "")

				if (i < dirCount) {
					expect(isDir, `mode ${mode}: index ${i} must be a directory-class item`).toBe(true)
				} else {
					expect(isDir, `mode ${mode}: index ${i} must be a file-class item`).toBe(false)
				}
			}
		}
	})
})

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

		const result = notesSorter.group({
			notes,
			groupPinned: true,
			groupFavorited: true,
			groupArchived: true,
			groupTrashed: true
		})

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
