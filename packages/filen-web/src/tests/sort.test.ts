import { describe, expect, it } from "vitest"
import type { UuidStr } from "@filen/sdk-rs"
import { type DriveItem } from "@/features/drive/lib/item"
import { sortDriveItems, type DriveSortBy } from "@/features/drive/lib/sort"

// A fixed, validly-shaped stand-in for every item's `parent` — sort.ts never reads it.
const PARENT_UUID = "22222222-2222-2222-2222-222222222222" as UuidStr

let uuidCounter = 0

// The counter goes in the FIRST segment, not the last: @filen/utils' parseNumbersFromString (the
// numeric-uuid tiebreak) reads at most the first 16 digit characters of a long string, so a
// counter placed after 16 leading zeros (e.g. "00000000-0000-0000-0000-...0042") would never be
// read at all — every generated uuid would numeric-tiebreak as 0, defeating the very ties these
// fixtures exist to distinguish (the timestamp-mode tiebreak has no further string-level fallback
// — see sort.ts's design note — unlike the size/parts modes, which do).
function nextUuid(): UuidStr {
	uuidCounter += 1

	return `${uuidCounter.toString().padStart(8, "0")}-0000-0000-0000-000000000000` as UuidStr
}

function dirItem(params: { uuid?: UuidStr; name?: string | null; timestamp?: bigint; created?: bigint } = {}): DriveItem {
	const uuid = params.uuid ?? nextUuid()
	const name = params.name === undefined ? `dir-${uuid}` : params.name
	const decryptedMeta = name === null ? null : params.created === undefined ? { name } : { name, created: params.created }

	return {
		type: "directory",
		data: {
			uuid,
			parent: PARENT_UUID,
			color: "default",
			timestamp: params.timestamp ?? 1_700_000_000_000n,
			favorited: false,
			meta: decryptedMeta === null ? { type: "encrypted", data: "ciphertext" } : { type: "decoded", data: decryptedMeta },
			size: 0n,
			undecryptable: decryptedMeta === null,
			decryptedMeta
		}
	}
}

function fileItem(
	params: {
		uuid?: UuidStr
		name?: string | null
		size?: bigint
		timestamp?: bigint
		modified?: bigint
		created?: bigint
		mime?: string
	} = {}
): DriveItem {
	const uuid = params.uuid ?? nextUuid()
	const name = params.name === undefined ? `file-${uuid}` : params.name
	const timestamp = params.timestamp ?? 1_700_000_000_000n
	const size = params.size ?? 0n
	const base = {
		name: name ?? "",
		mime: params.mime ?? "application/octet-stream",
		modified: params.modified ?? timestamp,
		size,
		key: "key",
		version: 2 as const
	}
	const decryptedMeta = name === null ? null : params.created === undefined ? base : { ...base, created: params.created }

	return {
		type: "file",
		data: {
			uuid,
			parent: PARENT_UUID,
			size,
			favorited: false,
			region: "de-1",
			bucket: "filen-1",
			timestamp,
			chunks: 1n,
			canMakeThumbnail: false,
			meta: decryptedMeta === null ? { type: "encrypted", data: "ciphertext" } : { type: "decoded", data: decryptedMeta },
			undecryptable: decryptedMeta === null,
			decryptedMeta
		}
	}
}

function names(items: DriveItem[]): (string | undefined)[] {
	return items.map(item => item.data.decryptedMeta?.name)
}

describe("sortDriveItems", () => {
	describe("dirs-first partitioning", () => {
		it("puts every directory before every file regardless of name order", () => {
			const items = [fileItem({ name: "a" }), dirItem({ name: "z" }), fileItem({ name: "b" }), dirItem({ name: "y" })]
			const sorted = sortDriveItems(items, "nameAsc")

			expect(sorted.map(item => item.type)).toEqual(["directory", "directory", "file", "file"])
			expect(names(sorted)).toEqual(["y", "z", "a", "b"])
		})

		it("holds across every sort mode", () => {
			const modes: DriveSortBy[] = [
				"nameAsc",
				"nameDesc",
				"sizeAsc",
				"sizeDesc",
				"typeAsc",
				"typeDesc",
				"uploadDateAsc",
				"uploadDateDesc",
				"lastModifiedAsc",
				"lastModifiedDesc"
			]
			const items = [
				fileItem({ name: "a", size: 5n }),
				dirItem({ name: "b" }),
				fileItem({ name: "c", size: 1n }),
				dirItem({ name: "d" })
			]

			for (const mode of modes) {
				const sorted = sortDriveItems(items, mode)

				expect(sorted.slice(0, 2).every(item => item.type === "directory")).toBe(true)
				expect(sorted.slice(2).every(item => item.type === "file")).toBe(true)
			}
		})

		it("returns an empty array for empty input", () => {
			expect(sortDriveItems([], "nameAsc")).toEqual([])
		})

		it("handles an all-directory input", () => {
			const items = [dirItem({ name: "b" }), dirItem({ name: "a" })]

			expect(names(sortDriveItems(items, "nameAsc"))).toEqual(["a", "b"])
		})

		it("handles an all-file input", () => {
			const items = [fileItem({ name: "b" }), fileItem({ name: "a" })]

			expect(names(sortDriveItems(items, "nameAsc"))).toEqual(["a", "b"])
		})
	})

	describe("name sort", () => {
		it("nameAsc orders case-insensitively and numeric-aware", () => {
			const items = [fileItem({ name: "Item 10" }), fileItem({ name: "item 2" }), fileItem({ name: "ITEM 1" })]

			expect(names(sortDriveItems(items, "nameAsc"))).toEqual(["ITEM 1", "item 2", "Item 10"])
		})

		it("nameDesc reverses the order", () => {
			const items = [fileItem({ name: "a" }), fileItem({ name: "c" }), fileItem({ name: "b" })]

			expect(names(sortDriveItems(items, "nameDesc"))).toEqual(["c", "b", "a"])
		})

		it("undecryptable items (name falls back to uuid) sort deterministically alongside named items", () => {
			const a = fileItem({ uuid: "aaaaaaaa-0000-0000-0000-000000000001", name: null })
			const b = fileItem({ uuid: "bbbbbbbb-0000-0000-0000-000000000002", name: null })
			const named = fileItem({ name: "middle" })
			const forward = sortDriveItems([a, b, named], "nameAsc")
			const shuffled = sortDriveItems([named, b, a], "nameAsc")

			// Order must be a pure function of the item set, independent of input order.
			expect(forward.map(item => item.data.uuid)).toEqual(shuffled.map(item => item.data.uuid))
			expect(forward.every(item => item.type === "file")).toBe(true)
		})
	})

	describe("size sort", () => {
		it("sizeAsc/sizeDesc order files by size", () => {
			const items = [
				fileItem({ name: "big", size: 300n }),
				fileItem({ name: "small", size: 1n }),
				fileItem({ name: "mid", size: 50n })
			]

			expect(names(sortDriveItems(items, "sizeAsc"))).toEqual(["small", "mid", "big"])
			expect(names(sortDriveItems(items, "sizeDesc"))).toEqual(["big", "mid", "small"])
		})

		it("never coerces size through Number: distinguishes sizes on either side of 2^53", () => {
			// 2^53 is the largest exactly-representable float64 integer; 2^53 + 1 is not representable
			// and rounds down to 2^53 — so both values coerce to the SAME Number, though they differ by
			// 1 as bigints.
			const smaller = 9_007_199_254_740_992n // 2^53
			const larger = 9_007_199_254_740_993n // 2^53 + 1

			expect(Number(smaller)).toBe(Number(larger)) // proves the two sizes are float64-indistinguishable

			const items = [fileItem({ name: "larger", size: larger }), fileItem({ name: "smaller", size: smaller })]

			expect(names(sortDriveItems(items, "sizeAsc"))).toEqual(["smaller", "larger"])
			expect(names(sortDriveItems(items, "sizeDesc"))).toEqual(["larger", "smaller"])
		})

		it("breaks size ties by name, then falls to the uuid tiebreak for equal names", () => {
			const items = [fileItem({ name: "b", size: 10n }), fileItem({ name: "a", size: 10n }), fileItem({ name: "a", size: 10n })]
			const sorted = sortDriveItems(items, "sizeAsc")

			expect(names(sorted)).toEqual(["a", "a", "b"])
			// the two "a" entries are order-independent of input position — reversing input reproduces the same uuid order
			const reversed = sortDriveItems([...items].reverse(), "sizeAsc")

			expect(sorted.map(item => item.data.uuid)).toEqual(reversed.map(item => item.data.uuid))
		})

		it("directories with no directorySizes entry sort by their synthetic 0n size, tiebroken by name", () => {
			const items = [dirItem({ name: "z" }), dirItem({ name: "a" }), fileItem({ name: "irrelevant" })]
			const sorted = sortDriveItems(items, "sizeAsc")

			expect(names(sorted.slice(0, 2))).toEqual(["a", "z"])
		})

		it("honors a supplied directorySizes map for directory entries", () => {
			const bigUuid = "00000000-0000-0000-0000-00000000b1g0" as UuidStr
			const smallUuid = "00000000-0000-0000-0000-0000000sma11" as UuidStr
			const big = dirItem({ uuid: bigUuid, name: "big-dir" })
			const small = dirItem({ uuid: smallUuid, name: "small-dir" })
			const sizes = new Map<string, number>([
				[bigUuid, 1_000_000],
				[smallUuid, 10]
			])

			expect(names(sortDriveItems([big, small], "sizeAsc", sizes))).toEqual(["small-dir", "big-dir"])
		})

		// The async transition this map exists for: a directory's size query hasn't landed yet (absent
		// from the map — still on the synthetic 0n fallback) alongside one that already resolved, mixed
		// with files. Mirrors filen-mobile/src/lib/sort.ts's identical fallback (raw `data.size` + name
		// tiebreak) — an unresolved directory is never placed as if it were "biggest" or dropped last on
		// purpose, it sorts exactly where a real 0-byte item would.
		it("a directory missing from the map sorts by its 0n fallback among resolved dirs and real-sized files", () => {
			const resolvedUuid = "00000000-0000-0000-0000-0000res01ved" as UuidStr
			const unresolvedUuid = "00000000-0000-0000-0000-000unres01ve" as UuidStr
			const resolved = dirItem({ uuid: resolvedUuid, name: "resolved-dir" })
			const unresolved = dirItem({ uuid: unresolvedUuid, name: "unresolved-dir" })
			const zeroByteFile = fileItem({ name: "zero-byte-file", size: 0n })
			const sizes = new Map<string, number>([[resolvedUuid, 1_000]])

			// Dirs-first partitioning keeps the unresolved dir ahead of every file regardless of the
			// file's own size — only the two directories are ordered against each other by the map, and
			// the unresolved one (0n fallback) sorts before the resolved 1,000-byte one.
			expect(names(sortDriveItems([resolved, unresolved, zeroByteFile], "sizeAsc", sizes))).toEqual([
				"unresolved-dir",
				"resolved-dir",
				"zero-byte-file"
			])

			// As the size lands (the map gains an entry for it), the directory re-positions past the
			// previously-larger resolved one — the exact re-sort behavior directoryListing.tsx relies on
			// when useDriveDirectorySizes' query cache subscription bumps mid-listing.
			const nowResolved = new Map<string, number>([
				[resolvedUuid, 1_000],
				[unresolvedUuid, 5_000]
			])

			expect(names(sortDriveItems([resolved, unresolved, zeroByteFile], "sizeAsc", nowResolved))).toEqual([
				"resolved-dir",
				"unresolved-dir",
				"zero-byte-file"
			])
		})
	})

	describe("type sort", () => {
		it("typeAsc groups files by MIME and orders names within a group", () => {
			const items = [
				fileItem({ name: "b.jpg", mime: "image/jpeg" }),
				fileItem({ name: "a.jpg", mime: "image/jpeg" }),
				fileItem({ name: "doc.pdf", mime: "application/pdf" })
			]

			expect(names(sortDriveItems(items, "typeAsc"))).toEqual(["doc.pdf", "a.jpg", "b.jpg"])
		})

		it("typeDesc reverses the MIME grouping", () => {
			const items = [fileItem({ name: "a.jpg", mime: "image/jpeg" }), fileItem({ name: "doc.pdf", mime: "application/pdf" })]

			expect(names(sortDriveItems(items, "typeDesc"))).toEqual(["a.jpg", "doc.pdf"])
		})

		it("directories (no mime) key on name for the type sort", () => {
			const items = [dirItem({ name: "zebra" }), dirItem({ name: "apple" })]

			expect(names(sortDriveItems(items, "typeAsc"))).toEqual(["apple", "zebra"])
		})
	})

	describe("uploadDate sort", () => {
		it("orders by the item's native timestamp for both dirs and files", () => {
			const older = fileItem({ name: "older", timestamp: 1_000n })
			const newer = fileItem({ name: "newer", timestamp: 2_000n })

			expect(names(sortDriveItems([newer, older], "uploadDateAsc"))).toEqual(["older", "newer"])
			expect(names(sortDriveItems([newer, older], "uploadDateDesc"))).toEqual(["newer", "older"])
		})
	})

	describe("lastModified sort", () => {
		it("files key on decryptedMeta.modified, falling back to timestamp when absent", () => {
			const a = fileItem({ name: "a", timestamp: 1_000n, modified: 5_000n })
			const b = fileItem({ name: "b", timestamp: 2_000n, modified: 3_000n })

			expect(names(sortDriveItems([a, b], "lastModifiedAsc"))).toEqual(["b", "a"])
		})

		it("directories key on decryptedMeta.created, falling back to timestamp when absent", () => {
			const a = dirItem({ name: "a", timestamp: 1_000n, created: 9_000n })
			const b = dirItem({ name: "b", timestamp: 2_000n })

			// a.created (9000) > b.timestamp-fallback (2000)
			expect(names(sortDriveItems([a, b], "lastModifiedAsc"))).toEqual(["b", "a"])
		})
	})

	describe("stability and determinism", () => {
		it("produces an identical order for the same item set regardless of input order (every mode)", () => {
			const items = [
				fileItem({ name: "same", size: 10n }),
				fileItem({ name: "same", size: 10n }),
				dirItem({ name: "dup" }),
				dirItem({ name: "dup" }),
				fileItem({ name: "unique", size: 99n })
			]
			const modes: DriveSortBy[] = ["nameAsc", "sizeDesc", "typeAsc", "uploadDateDesc", "lastModifiedAsc"]

			for (const mode of modes) {
				const a = sortDriveItems(items, mode).map(item => item.data.uuid)
				const b = sortDriveItems([...items].reverse(), mode).map(item => item.data.uuid)

				expect(a).toEqual(b)
			}
		})

		it("falls back to nameAsc for an unrecognized sortBy value", () => {
			const items = [fileItem({ name: "b" }), fileItem({ name: "a" })]

			expect(names(sortDriveItems(items, "bogus" as DriveSortBy))).toEqual(["a", "b"])
		})
	})
})
