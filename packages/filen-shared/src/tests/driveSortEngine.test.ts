import { describe, it, expect } from "vitest"
import { sortPartition, sortItems, type SortMode, type SortEngineAccessors } from "@filen/shared"

// Minimal structural fixture — deliberately NOT a DriveItem: the engine is generic over any
// shape, and these tests pin the engine's own mechanics (mode branches, tiebreak chains,
// dirs-first partitioning, bigint size handling) independent of either app's field layout.
interface FakeItem {
	uuid: string
	name: string
	size: bigint
	ts: number
	category: string
	isDir: boolean
}

function makeItem(overrides: Partial<FakeItem> & { uuid: string }): FakeItem {
	return {
		name: overrides.uuid,
		size: 0n,
		ts: 1000,
		category: "a",
		isDir: false,
		...overrides
	}
}

const accessors: SortEngineAccessors<FakeItem> = {
	getUuid: item => item.uuid,
	getSize: item => item.size,
	isDirectory: item => item.isDir,
	nameKey: item => item.name
}

function accessorsWithDirectorySizes(directorySizes: ReadonlyMap<string, number>): SortEngineAccessors<FakeItem> {
	return { ...accessors, directorySizes }
}

const nameAsc: SortMode<FakeItem> = { kind: "parts", isAsc: true, stringKey: item => item.name }
const nameDesc: SortMode<FakeItem> = { kind: "parts", isAsc: false, stringKey: item => item.name }
const categoryAsc: SortMode<FakeItem> = { kind: "parts", isAsc: true, stringKey: item => item.category, tiebreakByName: true }
const categoryDesc: SortMode<FakeItem> = { kind: "parts", isAsc: false, stringKey: item => item.category, tiebreakByName: true }
const sizeAsc: SortMode<FakeItem> = { kind: "size", isAsc: true }
const sizeDesc: SortMode<FakeItem> = { kind: "size", isAsc: false }
const timestampAsc: SortMode<FakeItem> = { kind: "timestamp", isAsc: true, timestampKey: item => item.ts }
const timestampDesc: SortMode<FakeItem> = { kind: "timestamp", isAsc: false, timestampKey: item => item.ts }

const ALL_MODES: SortMode<FakeItem>[] = [nameAsc, nameDesc, categoryAsc, categoryDesc, sizeAsc, sizeDesc, timestampAsc, timestampDesc]

function names(items: FakeItem[]): string[] {
	return items.map(item => item.name)
}

function uuids(items: FakeItem[]): string[] {
	return items.map(item => item.uuid)
}

describe("sortPartition", () => {
	it("no-ops on an empty or single-element partition", () => {
		const empty: FakeItem[] = []
		sortPartition(empty, nameAsc, accessors)
		expect(empty).toEqual([])

		const single = [makeItem({ uuid: "a", name: "only" })]
		sortPartition(single, nameAsc, accessors)
		expect(single.map(i => i.name)).toEqual(["only"])
	})

	it("mutates the partition array in place", () => {
		const partition = [makeItem({ uuid: "b", name: "b.txt" }), makeItem({ uuid: "a", name: "a.txt" })]
		const originalRef = partition

		sortPartition(partition, nameAsc, accessors)

		expect(partition).toBe(originalRef)
		expect(names(partition)).toEqual(["a.txt", "b.txt"])
	})

	it("throws for a parts mode missing stringKey", () => {
		const malformed = { kind: "parts", isAsc: true } as SortMode<FakeItem>
		const partition = [makeItem({ uuid: "a" }), makeItem({ uuid: "b" })]

		expect(() => sortPartition(partition, malformed, accessors)).toThrow()
	})

	it("throws for a timestamp mode missing timestampKey", () => {
		const malformed = { kind: "timestamp", isAsc: true } as SortMode<FakeItem>
		const partition = [makeItem({ uuid: "a" }), makeItem({ uuid: "b" })]

		expect(() => sortPartition(partition, malformed, accessors)).toThrow()
	})

	describe("parts mode", () => {
		it("orders ascending with natural (numeric-aware) string comparison", () => {
			const partition = [
				makeItem({ uuid: "10", name: "file10.txt" }),
				makeItem({ uuid: "2", name: "file2.txt" }),
				makeItem({ uuid: "1", name: "file1.txt" })
			]

			sortPartition(partition, nameAsc, accessors)

			expect(names(partition)).toEqual(["file1.txt", "file2.txt", "file10.txt"])
		})

		it("orders descending as the exact reverse", () => {
			const partition = [
				makeItem({ uuid: "1", name: "file1.txt" }),
				makeItem({ uuid: "10", name: "file10.txt" }),
				makeItem({ uuid: "2", name: "file2.txt" })
			]

			sortPartition(partition, nameDesc, accessors)

			expect(names(partition)).toEqual(["file10.txt", "file2.txt", "file1.txt"])
		})

		it("tiebreakByName: groups by the primary key, ordering names within each group", () => {
			const partition = [
				makeItem({ uuid: "1", name: "zeta.jpg", category: "image/jpeg" }),
				makeItem({ uuid: "2", name: "beta.png", category: "image/png" }),
				makeItem({ uuid: "3", name: "alpha.jpg", category: "image/jpeg" })
			]

			sortPartition(partition, categoryAsc, accessors)

			expect(names(partition)).toEqual(["alpha.jpg", "zeta.jpg", "beta.png"])
		})

		it("without tiebreakByName, a primary-key tie falls straight through to the uuid chain (skips the name secondary)", () => {
			// Both items share the primary key ("same-category") but have DIFFERENT names — if the
			// name secondary fired it would decide the order; since tiebreakByName is unset here, the
			// primary-key tie instead resolves via the deterministic uuid chain.
			const withoutTiebreak: SortMode<FakeItem> = { kind: "parts", isAsc: true, stringKey: item => item.category }
			const a = makeItem({ uuid: "0000-1111", name: "zzz", category: "same-category" })
			const b = makeItem({ uuid: "0000-2222", name: "aaa", category: "same-category" })

			const partition = [b, a]
			sortPartition(partition, withoutTiebreak, accessors)

			// Numeric-uuid chain: both share digits "0000" then "1111"/"2222" differ -> a (1111) first.
			expect(uuids(partition)).toEqual(["0000-1111", "0000-2222"])
		})

		it("primary-key ties resolve through the deterministic uuid chain, independent of input order", () => {
			const a = makeItem({ uuid: "0001-aaaa", name: "same.txt" })
			const b = makeItem({ uuid: "0002-bbbb", name: "same.txt" })

			const forward = [b, a]
			sortPartition(forward, nameAsc, accessors)

			const reversed = [a, b]
			sortPartition(reversed, nameAsc, accessors)

			expect(uuids(forward)).toEqual(["0001-aaaa", "0002-bbbb"])
			expect(uuids(reversed)).toEqual(["0001-aaaa", "0002-bbbb"])
		})
	})

	describe("size mode", () => {
		it("orders ascending/descending by size", () => {
			const asc = [
				makeItem({ uuid: "3", name: "l.txt", size: 1000n }),
				makeItem({ uuid: "1", name: "s.txt", size: 100n }),
				makeItem({ uuid: "2", name: "m.txt", size: 500n })
			]
			sortPartition(asc, sizeAsc, accessors)
			expect(names(asc)).toEqual(["s.txt", "m.txt", "l.txt"])

			const desc = [makeItem({ uuid: "1", name: "s.txt", size: 100n }), makeItem({ uuid: "2", name: "l.txt", size: 1000n })]
			sortPartition(desc, sizeDesc, accessors)
			expect(names(desc)).toEqual(["l.txt", "s.txt"])
		})

		it("orders bigint sizes exactly, including values beyond 2^53 that Number() would collapse", () => {
			const base = 2n ** 60n
			const a = makeItem({ uuid: "aaaa-1111", name: "a.bin", size: base + 1n })
			const b = makeItem({ uuid: "bbbb-2222", name: "b.bin", size: base })
			const c = makeItem({ uuid: "cccc-3333", name: "c.bin", size: 1000n })

			const asc = [a, b, c]
			sortPartition(asc, sizeAsc, accessors)
			expect(uuids(asc)).toEqual(["cccc-3333", "bbbb-2222", "aaaa-1111"])

			const desc = [c, b, a]
			sortPartition(desc, sizeDesc, accessors)
			expect(uuids(desc)).toEqual(["aaaa-1111", "bbbb-2222", "cccc-3333"])
		})

		it("equal sizes fall back to the lazy name tiebreak, then the uuid chain", () => {
			const partition = [
				makeItem({ uuid: "cccc-3", name: "cherry.txt", size: 100n }),
				makeItem({ uuid: "aaaa-1", name: "apple.txt", size: 100n }),
				makeItem({ uuid: "bbbb-2", name: "banana.txt", size: 100n })
			]

			sortPartition(partition, sizeAsc, accessors)

			expect(names(partition)).toEqual(["apple.txt", "banana.txt", "cherry.txt"])
		})

		describe("directorySizes substitution", () => {
			it("substitutes the map's real size for directory items", () => {
				const partition = [
					makeItem({ uuid: "dir-small", name: "small", isDir: true }),
					makeItem({ uuid: "dir-huge", name: "huge", isDir: true }),
					makeItem({ uuid: "dir-medium", name: "medium", isDir: true }),
					makeItem({ uuid: "file-1", name: "tiny.txt", size: 1n })
				]
				const directorySizes = new Map<string, number>([
					["dir-small", 10],
					["dir-huge", 1_000_000],
					["dir-medium", 5_000]
				])

				sortPartition(partition, sizeDesc, accessorsWithDirectorySizes(directorySizes))

				expect(uuids(partition)).toEqual(["dir-huge", "dir-medium", "dir-small", "file-1"])
			})

			it("a directory missing from the map falls back to its raw size and the name tiebreak", () => {
				const partition = [
					makeItem({ uuid: "dir-known", name: "known-large", isDir: true }),
					makeItem({ uuid: "dir-ub", name: "unknown-b", isDir: true }),
					makeItem({ uuid: "dir-ua", name: "unknown-a", isDir: true })
				]
				const directorySizes = new Map<string, number>([["dir-known", 999]])

				sortPartition(partition, sizeAsc, accessorsWithDirectorySizes(directorySizes))

				expect(names(partition)).toEqual(["unknown-a", "unknown-b", "known-large"])
			})

			it("files ignore the map even on a uuid collision with a directory entry", () => {
				const partition = [
					makeItem({ uuid: "shared-uuid", name: "big.bin", size: 100n }),
					makeItem({ uuid: "other-uuid", name: "small.bin", size: 1n })
				]
				const directorySizes = new Map<string, number>([["shared-uuid", 0]])

				sortPartition(partition, sizeAsc, accessorsWithDirectorySizes(directorySizes))

				expect(names(partition)).toEqual(["small.bin", "big.bin"])
			})

			it("a non-integral or non-finite map value falls back to the raw size instead of throwing", () => {
				const partition = [
					makeItem({ uuid: "dir-nan", name: "nan-dir", isDir: true }),
					makeItem({ uuid: "dir-real", name: "real-dir", isDir: true })
				]
				const directorySizes = new Map<string, number>([
					["dir-nan", Number.NaN],
					["dir-real", 123.75]
				])

				sortPartition(partition, sizeAsc, accessorsWithDirectorySizes(directorySizes))

				// NaN -> raw size (0n) sorts first; 123.75 truncates to 123n.
				expect(names(partition)).toEqual(["nan-dir", "real-dir"])
			})
		})
	})

	describe("timestamp mode", () => {
		it("orders ascending/descending by the timestamp key", () => {
			const asc = [makeItem({ uuid: "1", name: "new.txt", ts: 9000 }), makeItem({ uuid: "2", name: "old.txt", ts: 1000 })]
			sortPartition(asc, timestampAsc, accessors)
			expect(names(asc)).toEqual(["old.txt", "new.txt"])

			const desc = [makeItem({ uuid: "1", name: "old.txt", ts: 1000 }), makeItem({ uuid: "2", name: "new.txt", ts: 9000 })]
			sortPartition(desc, timestampDesc, accessors)
			expect(names(desc)).toEqual(["new.txt", "old.txt"])
		})

		it("a bigint-sourced key (Number(bigint)) orders identically to the equivalent number-sourced key", () => {
			// Mirrors production DriveItems, whose timestamp/modified/created fields are bigint —
			// callers convert with Number() inside their own timestampKey; the engine only ever
			// sees the resulting number, so this pins that conversion path end-to-end.
			interface RawItem {
				uuid: string
				ts: number | bigint
			}
			const rawAccessors: SortEngineAccessors<RawItem> = {
				getUuid: item => item.uuid,
				getSize: () => 0n,
				isDirectory: () => false,
				nameKey: item => item.uuid
			}
			const rawTimestampAsc: SortMode<RawItem> = { kind: "timestamp", isAsc: true, timestampKey: item => Number(item.ts) }

			const numberItems: RawItem[] = []
			const bigintItems: RawItem[] = []

			for (let i = 0; i < 200; i++) {
				// Deterministic scatter; collisions on purpose (every 7th shares a timestamp).
				const ts = 1_700_000_000_000 + (i % 7 === 0 ? 5000 : i * 1337)
				const uuid = `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`

				numberItems.push({ uuid, ts })
				bigintItems.push({ uuid, ts: BigInt(ts) })
			}

			sortPartition(numberItems, rawTimestampAsc, rawAccessors)
			sortPartition(bigintItems, rawTimestampAsc, rawAccessors)

			expect(bigintItems.map(i => i.uuid)).toEqual(numberItems.map(i => i.uuid))
		})

		it("ties resolve through the numeric-uuid chain ONLY — no string-uuid fallback (shorter than parts/size)", () => {
			// Every uuid here shares the same digit runs ("1111"), so getUuidNumber ties at 0 for
			// every pair. Unlike parts/size mode's compareUuids (which falls back to a string
			// compare on a numeric tie), timestamp mode stops at the numeric tiebreak — Array.sort
			// is stable, so a comparator that returns exactly 0 for every pair preserves input order.
			const items: FakeItem[] = []

			for (let i = 0; i < 50; i++) {
				items.push(makeItem({ uuid: `aaaa-1111-${"x".repeat(i % 7)}`, name: `file-${i}.txt`, ts: 5000 }))
			}

			const asc = items.slice()
			sortPartition(asc, timestampAsc, accessors)
			expect(asc).toEqual(items)

			const desc = items.slice()
			sortPartition(desc, timestampDesc, accessors)
			expect(desc).toEqual(items)
		})

		it("by contrast, parts/size mode's uuid chain DOES fall back to a string compare on a numeric tie", () => {
			const a = makeItem({ uuid: "aaaa-1111-x", name: "same.txt" })
			const b = makeItem({ uuid: "aaaa-1111-y", name: "same.txt" })

			const partition = [b, a]
			sortPartition(partition, nameAsc, accessors)

			// getUuidNumber ties (same digits "1111"); the string chain then decides: "...-x" < "...-y".
			expect(uuids(partition)).toEqual(["aaaa-1111-x", "aaaa-1111-y"])
		})
	})
})

describe("sortItems", () => {
	it("returns an empty array for empty input", () => {
		expect(sortItems([], nameAsc, accessors)).toEqual([])
	})

	it("returns the same item for single-element input", () => {
		const item = makeItem({ uuid: "1", name: "only.txt" })

		const result = sortItems([item], nameAsc, accessors)

		expect(result).toHaveLength(1)
		expect(result[0]).toBe(item)
	})

	it("does not mutate the input array", () => {
		const items = [makeItem({ uuid: "1", name: "b.txt" }), makeItem({ uuid: "2", name: "a.txt" })]
		const original = [...items]

		sortItems(items, nameAsc, accessors)

		expect(items[0]).toBe(original[0])
		expect(items[1]).toBe(original[1])
	})

	it("partitions directories before files, then sorts each partition independently", () => {
		const dir = makeItem({ uuid: "1", name: "zebra", isDir: true })
		const file = makeItem({ uuid: "2", name: "alpha.txt" })

		const asc = sortItems([file, dir], nameAsc, accessors)
		expect(asc[0]!.isDir).toBe(true)

		const desc = sortItems([file, dir], nameDesc, accessors)
		expect(desc[0]!.isDir).toBe(true)
	})

	it("dirs-first holds across every mode kind and direction, on interleaved input", () => {
		const items: FakeItem[] = []

		for (let i = 0; i < 300; i++) {
			items.push(
				makeItem({
					uuid: `${String((i * 17) % 300).padStart(6, "0")}-0000-0000-0000-000000000000`,
					name: `entry_${(i * 31) % 300}.dat`,
					size: BigInt((i * 13) % 1000),
					ts: 1_700_000_000_000 + ((i * 7919) % 100_000),
					category: i % 3 === 0 ? "x" : "y",
					isDir: i % 4 === 0
				})
			)
		}

		const dirCount = items.filter(item => item.isDir).length

		for (const mode of ALL_MODES) {
			const result = sortItems(items, mode, accessors)

			expect(result, `mode ${mode.kind}/${mode.isAsc}`).toHaveLength(items.length)

			for (let i = 0; i < result.length; i++) {
				const isDir = result[i]!.isDir

				if (i < dirCount) {
					expect(isDir, `mode ${mode.kind}/${mode.isAsc}: index ${i} must be a directory`).toBe(true)
				} else {
					expect(isDir, `mode ${mode.kind}/${mode.isAsc}: index ${i} must be a file`).toBe(false)
				}
			}
		}
	})

	it("equal-key ties at scale resolve deterministically through the uuid chain, independent of input order (#49)", () => {
		const items: FakeItem[] = []

		for (let i = 0; i < 400; i++) {
			items.push(makeItem({ uuid: `uuid-${String(i).padStart(4, "0")}`, name: "same-name.txt", ts: 1000 }))
		}

		// Equal keys must NOT fall through to input order — the input is raw query data whose
		// order is not stable across refetches (#49). The tiebreak chain ends at the uuid, so any
		// input permutation produces the same output, and desc is the exact reverse of asc.
		const asc = uuids(sortItems(items, nameAsc, accessors))
		const desc = uuids(sortItems(items, nameDesc, accessors))
		const ascFromReversedInput = uuids(sortItems(items.slice().reverse(), nameAsc, accessors))

		// These uuids carry ascending digit runs, so the uuid-number chain yields construction order.
		expect(asc).toEqual(items.map(item => item.uuid))
		expect(desc).toEqual(asc.slice().reverse())
		expect(ascFromReversedInput).toEqual(asc)
	})

	it("output is independent of input order (forward / reversed / rotated) for size and category ties", () => {
		const build = (): FakeItem[] => [
			makeItem({ uuid: "dddd-4", name: "delta", isDir: true }),
			makeItem({ uuid: "aaaa-1", name: "alpha", isDir: true }),
			makeItem({ uuid: "bbbb-2", name: "same-size-b.txt", size: 50n }),
			makeItem({ uuid: "aaaa-9", name: "same-size-a.txt", size: 50n }),
			makeItem({ uuid: "ffff-6", name: "photo-b.jpg", size: 1n, category: "image/jpeg" }),
			makeItem({ uuid: "eeee-5", name: "photo-a.jpg", size: 2n, category: "image/jpeg" })
		]

		for (const mode of [sizeAsc, sizeDesc, categoryAsc, categoryDesc]) {
			const forward = uuids(sortItems(build(), mode, accessors))
			const reversed = uuids(sortItems(build().reverse(), mode, accessors))
			const rotated = (() => {
				const input = build()

				input.push(input.shift() as (typeof input)[number])

				return uuids(sortItems(input, mode, accessors))
			})()

			expect(reversed, `mode ${mode.kind}/${mode.isAsc} (reversed input)`).toEqual(forward)
			expect(rotated, `mode ${mode.kind}/${mode.isAsc} (rotated input)`).toEqual(forward)
		}
	})
})
