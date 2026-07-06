import { vi, describe, it, expect, beforeAll, afterAll } from "vitest"

// sort.ts now resolves the fixed group-header labels via the module i18n and derives month
// names from Intl using `intlLanguage`. Mock both so the pure sorter tests don't drag in
// expo-localization / react-i18next (which crash in the node test env on `__DEV__`).
vi.mock("@/lib/i18n", () => ({
	default: {
		t: (key: string) => key
	}
}))

vi.mock("@/lib/time", () => ({
	intlLanguage: "en-US"
}))

import { itemSorter, notesSorter, captureTimestamp, type SortByType } from "@/lib/sort"
import { type DriveItem, type Note, type NoteTag } from "@/types"

function makeItem(
	type: string,
	name: string,
	overrides?: Partial<{
		size: bigint
		timestamp: number
		modified: number
		created: number
		uuid: string
		mime: string
	}>
): DriveItem {
	return {
		type,
		data: {
			uuid: overrides?.uuid ?? crypto.randomUUID(),
			size: overrides?.size ?? 0n,
			timestamp: overrides?.timestamp ?? 1000,
			decryptedMeta: {
				name,
				mime: overrides?.mime ?? "application/octet-stream",
				modified: overrides?.modified ?? overrides?.timestamp ?? 1000,
				created: overrides?.created ?? overrides?.timestamp ?? 1000
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

describe("itemSorter", () => {
	describe("sortItems", () => {
		it("returns empty array for empty input", () => {
			expect(itemSorter.sortItems([], "nameAsc")).toEqual([])
		})

		it("returns same item for single-element input", () => {
			const item = makeItem("file", "only.txt")
			const result = itemSorter.sortItems([item], "nameAsc")

			expect(result).toHaveLength(1)
			expect(result[0]).toBe(item)
		})

		it("does not mutate the input array", () => {
			const items = [makeItem("file", "b.txt"), makeItem("file", "a.txt")]
			const original = [...items]

			itemSorter.sortItems(items, "nameAsc")

			expect(items[0]).toBe(original[0])
			expect(items[1]).toBe(original[1])
		})

		it("sorts nameAsc alphabetically with natural numeric sort", () => {
			const file1 = makeItem("file", "file1.txt")
			const file2 = makeItem("file", "file2.txt")
			const file10 = makeItem("file", "file10.txt")

			const result = itemSorter.sortItems([file10, file2, file1], "nameAsc")

			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["file1.txt", "file2.txt", "file10.txt"])
		})

		it("sorts nameDesc in reverse natural order", () => {
			const file1 = makeItem("file", "file1.txt")
			const file2 = makeItem("file", "file2.txt")
			const file10 = makeItem("file", "file10.txt")

			const result = itemSorter.sortItems([file1, file10, file2], "nameDesc")

			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["file10.txt", "file2.txt", "file1.txt"])
		})

		it("places directories before files regardless of sort direction", () => {
			const dir = makeItem("directory", "zebra")
			const file = makeItem("file", "alpha.txt")

			const asc = itemSorter.sortItems([file, dir], "nameAsc")
			expect(asc[0]!.type).toBe("directory")

			const desc = itemSorter.sortItems([file, dir], "nameDesc")
			expect(desc[0]!.type).toBe("directory")
		})

		it("sorts sizeAsc by file size ascending", () => {
			const small = makeItem("file", "s.txt", { size: 100n })
			const medium = makeItem("file", "m.txt", { size: 500n })
			const large = makeItem("file", "l.txt", { size: 1000n })

			const result = itemSorter.sortItems([large, small, medium], "sizeAsc")

			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["s.txt", "m.txt", "l.txt"])
		})

		it("sorts sizeDesc by file size descending", () => {
			const small = makeItem("file", "s.txt", { size: 100n })
			const large = makeItem("file", "l.txt", { size: 1000n })

			const result = itemSorter.sortItems([small, large], "sizeDesc")

			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["l.txt", "s.txt"])
		})

		it("sorts lastModifiedAsc by modification timestamp", () => {
			const old = makeItem("file", "old.txt", { modified: 1000 })
			const recent = makeItem("file", "new.txt", { modified: 9000 })

			const result = itemSorter.sortItems([recent, old], "lastModifiedAsc")

			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["old.txt", "new.txt"])
		})

		it("sorts lastModifiedDesc by modification timestamp descending", () => {
			const old = makeItem("file", "old.txt", { modified: 1000 })
			const recent = makeItem("file", "new.txt", { modified: 9000 })

			const result = itemSorter.sortItems([old, recent], "lastModifiedDesc")

			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["new.txt", "old.txt"])
		})

		it("sorts directory items by created timestamp under lastModifiedAsc (not modified)", () => {
			// compareLastModified for 'directory' uses decryptedMeta.created ?? data.timestamp — NOT modified
			const olderDir = makeItem("directory", "docs", { created: 1000, timestamp: 9000 })
			const newerDir = makeItem("directory", "images", { created: 5000, timestamp: 1000 })

			const result = itemSorter.sortItems([newerDir, olderDir], "lastModifiedAsc")

			// dirs come before files always; within dirs sorted by created field
			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["docs", "images"])
		})

		it("sorts directory items by created timestamp under lastModifiedDesc", () => {
			const olderDir = makeItem("directory", "docs", { created: 1000, timestamp: 9000 })
			const newerDir = makeItem("directory", "images", { created: 5000, timestamp: 1000 })

			const result = itemSorter.sortItems([olderDir, newerDir], "lastModifiedDesc")

			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["images", "docs"])
		})

		it("treats file and sharedFile as equal rank (both non-directory)", () => {
			const file = makeItem("file", "beta.txt", { uuid: "aaa-111" })
			const shared = makeItem("sharedFile", "alpha.txt", { uuid: "bbb-222" })

			const result = itemSorter.sortItems([file, shared], "nameAsc")

			expect(result[0]!.data.decryptedMeta?.name).toBe("alpha.txt")
			expect(result[1]!.data.decryptedMeta?.name).toBe("beta.txt")
		})

		it("places sharedDirectory before file", () => {
			const sharedDir = makeItem("sharedDirectory", "docs")
			const file = makeItem("file", "alpha.txt")

			const result = itemSorter.sortItems([file, sharedDir], "nameAsc")

			expect(result[0]!.type).toBe("sharedDirectory")
			expect(result[1]!.type).toBe("file")
		})

		it("places sharedRootDirectory before file in compareTypes", () => {
			const sharedRootDir = makeItem("sharedRootDirectory", "shared-root")
			const file = makeItem("file", "alpha.txt")

			const asc = itemSorter.sortItems([file, sharedRootDir], "nameAsc")
			expect(asc[0]!.type).toBe("sharedRootDirectory")
			expect(asc[1]!.type).toBe("file")

			const desc = itemSorter.sortItems([file, sharedRootDir], "nameDesc")
			expect(desc[0]!.type).toBe("sharedRootDirectory")
			expect(desc[1]!.type).toBe("file")
		})

		it("does not crash when decryptedMeta is null (falls back to uuid)", () => {
			const uuid1 = "aaa-111"
			const uuid2 = "bbb-222"

			const item1 = {
				type: "file",
				data: {
					uuid: uuid1,
					size: 0n,
					timestamp: 1000,
					decryptedMeta: null,
					undecryptable: false
				}
			} as unknown as DriveItem

			const item2 = {
				type: "file",
				data: {
					uuid: uuid2,
					size: 0n,
					timestamp: 1000,
					decryptedMeta: null,
					undecryptable: false
				}
			} as unknown as DriveItem

			expect(() => itemSorter.sortItems([item2, item1], "nameAsc")).not.toThrow()

			const result = itemSorter.sortItems([item2, item1], "nameAsc")

			expect(result).toHaveLength(2)
		})

		it("sorts identical-name items by uuid numeric value as tiebreaker (uuid 111 < uuid 222)", () => {
			// compareName returns 0 for identical names; the uuid tiebreaker is applied in compareName via getLowerName fallback.
			// Since compareName uses string comparison on the name/uuid fallback, we verify a distinct case:
			// items with identical names are ordered by uuid numeric value via compareStringsNumeric.
			const a = makeItem("file", "same.txt", { uuid: "aaa-111" })
			const b = makeItem("file", "same.txt", { uuid: "bbb-222" })

			// nameAsc: compareStringsNumeric("same.txt", "same.txt") = 0, so uuid string fallback gives "aaa-111" < "bbb-222"
			// Both items have the same name, result order from sort() with compareName returning 0 = stable by input order.
			// We only check no crash + correct count (sort stability is a Node runtime guarantee).
			const result = itemSorter.sortItems([a, b], "nameAsc")

			expect(result).toHaveLength(2)
			// For the tiebreaker correctness, use uploadDateAsc which explicitly calls getUuidNumber in compareDate:
			// parseNumbersFromString("aaa-111") extracts digits 1,1,1 → 111
			// parseNumbersFromString("bbb-222") extracts digits 2,2,2 → 222
			// ascending: 111 < 222 → a before b
			const withDate = [
				makeItem("file", "same.txt", { uuid: "aaa-111", timestamp: 5000 }),
				makeItem("file", "same.txt", { uuid: "bbb-222", timestamp: 5000 })
			]
			const ascResult = itemSorter.sortItems([withDate[1]!, withDate[0]!], "uploadDateAsc")
			expect(ascResult[0]!.data.uuid).toBe("aaa-111")
			expect(ascResult[1]!.data.uuid).toBe("bbb-222")

			// descending reverses the uuid tiebreaker
			const descResult = itemSorter.sortItems([withDate[0]!, withDate[1]!], "uploadDateDesc")
			expect(descResult[0]!.data.uuid).toBe("bbb-222")
			expect(descResult[1]!.data.uuid).toBe("aaa-111")
		})

		it("does not mutate input array with shared types", () => {
			const items = [makeItem("sharedFile", "b.txt"), makeItem("sharedDirectory", "a-dir"), makeItem("file", "c.txt")]
			const original = [...items]

			itemSorter.sortItems(items, "nameAsc")

			expect(items[0]).toBe(original[0])
			expect(items[1]).toBe(original[1])
			expect(items[2]).toBe(original[2])
		})
	})

	describe("additional sort modes", () => {
		it("sorts by mime type ascending", () => {
			const text = makeItem("file", "readme.txt", { mime: "text/plain" })
			const image = makeItem("file", "photo.png", { mime: "image/png" })
			const app = makeItem("file", "data.bin", { mime: "application/octet-stream" })

			const result = itemSorter.sortItems([text, image, app], "mimeAsc")

			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["data.bin", "photo.png", "readme.txt"])
		})

		it("sorts by mime type descending", () => {
			const text = makeItem("file", "readme.txt", { mime: "text/plain" })
			const image = makeItem("file", "photo.png", { mime: "image/png" })
			const app = makeItem("file", "data.bin", { mime: "application/octet-stream" })

			const result = itemSorter.sortItems([text, image, app], "mimeDesc")

			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["readme.txt", "photo.png", "data.bin"])
		})

		it("places directory before file under mimeAsc and falls back to name for directory mime key", () => {
			// compareMime uses decryptedMeta.name (not mime) for non-file types
			const dir = makeItem("directory", "alpha-dir", { mime: "should-be-ignored" })
			const file = makeItem("file", "zzz.txt", { mime: "application/octet-stream" })

			const result = itemSorter.sortItems([file, dir], "mimeAsc")

			expect(result[0]!.type).toBe("directory")
			expect(result[1]!.type).toBe("file")
		})

		it("sorts two directories by name under mimeAsc (fallback to decryptedMeta.name)", () => {
			const dirA = makeItem("directory", "aaa-dir")
			const dirB = makeItem("directory", "bbb-dir")

			const asc = itemSorter.sortItems([dirB, dirA], "mimeAsc")
			expect(asc.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["aaa-dir", "bbb-dir"])

			const desc = itemSorter.sortItems([dirA, dirB], "mimeDesc")
			expect(desc.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["bbb-dir", "aaa-dir"])
		})

		it("sorts sharedFile items by uploadDateAsc using decryptedMeta.created", () => {
			// compareDate for sharedFile: uses decryptedMeta.created ?? decryptedMeta.modified ?? 0
			const older = makeItem("sharedFile", "old-shared.txt", { created: 1000, timestamp: 9999 })
			const newer = makeItem("sharedFile", "new-shared.txt", { created: 8000, timestamp: 1 })

			const result = itemSorter.sortItems([newer, older], "uploadDateAsc")

			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["old-shared.txt", "new-shared.txt"])
		})

		it("sorts sharedFile items by uploadDateDesc using decryptedMeta.created", () => {
			const older = makeItem("sharedFile", "old-shared.txt", { created: 1000, timestamp: 9999 })
			const newer = makeItem("sharedFile", "new-shared.txt", { created: 8000, timestamp: 1 })

			const result = itemSorter.sortItems([older, newer], "uploadDateDesc")

			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["new-shared.txt", "old-shared.txt"])
		})

		it("sharedFile compareDate falls back to decryptedMeta.modified when created is null/undefined", () => {
			// compareDate for sharedFile: (decryptedMeta.created ?? decryptedMeta.modified ?? 0)
			// ?? is nullish-coalescing: only skips null/undefined, NOT 0.
			// Use null for created so the fallback to modified is exercised.
			const itemA = {
				type: "sharedFile",
				data: {
					uuid: "uuid-a",
					size: 0n,
					timestamp: 9999,
					decryptedMeta: { name: "a.txt", mime: "text/plain", modified: 2000, created: null },
					undecryptable: false
				}
			} as unknown as DriveItem

			const itemB = {
				type: "sharedFile",
				data: {
					uuid: "uuid-b",
					size: 0n,
					timestamp: 9999,
					decryptedMeta: { name: "b.txt", mime: "text/plain", modified: 8000, created: null },
					undecryptable: false
				}
			} as unknown as DriveItem

			// modified: 2000 < 8000, so a.txt sorts first ascending
			const asc = itemSorter.sortItems([itemB, itemA], "uploadDateAsc")
			expect(asc.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["a.txt", "b.txt"])

			// descending: b.txt (modified 8000) sorts first
			const desc = itemSorter.sortItems([itemA, itemB], "uploadDateDesc")
			expect(desc.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["b.txt", "a.txt"])
		})

		it("sorts by upload date ascending", () => {
			const older = makeItem("file", "old.txt", { timestamp: 1000 })
			const newer = makeItem("file", "new.txt", { timestamp: 5000 })

			const result = itemSorter.sortItems([newer, older], "uploadDateAsc")

			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["old.txt", "new.txt"])
		})

		it("sorts by upload date descending", () => {
			const older = makeItem("file", "old.txt", { timestamp: 1000 })
			const newer = makeItem("file", "new.txt", { timestamp: 5000 })

			const result = itemSorter.sortItems([newer, older], "uploadDateDesc")

			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["new.txt", "old.txt"])
		})

		it("sorts by creation date ascending", () => {
			const older = makeItem("file", "old.txt", { created: 1000, timestamp: 9000 })
			const newer = makeItem("file", "new.txt", { created: 5000, timestamp: 1000 })

			const result = itemSorter.sortItems([newer, older], "creationAsc")

			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["old.txt", "new.txt"])
		})

		it("sorts by creation date descending", () => {
			const older = makeItem("file", "old.txt", { created: 1000, timestamp: 9000 })
			const newer = makeItem("file", "new.txt", { created: 5000, timestamp: 1000 })

			const result = itemSorter.sortItems([newer, older], "creationDesc")

			expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["new.txt", "old.txt"])
		})

		// captureTimestamp is exported as the photos grid's DISPLAY date too (#43): the
		// floating date chip must label rows with the same value the timeline sorts by,
		// or clamped-away garbage dates (epoch-zero created) resurface in the UI.
		describe("captureTimestamp (photos date chip)", () => {
			const T_2021 = Date.UTC(2021, 5, 30)
			const T_2024 = Date.UTC(2024, 1, 13)

			it("labels a legacy upload-stamped photo with its modified date, not the upload date", () => {
				const legacy = makeItem("file", "legacy.jpg", { created: T_2024, modified: T_2021, timestamp: T_2024 })

				expect(captureTimestamp(legacy)).toBe(T_2021)
			})

			it("labels an epoch-zero created with the upload date instead of 1970", () => {
				const garbage = makeItem("file", "garbage.jpg", { created: 0, modified: 0, timestamp: T_2024 })

				expect(captureTimestamp(garbage)).toBe(T_2024)
			})

			it("matches the captureDesc sort key exactly (chip and ordering share one source)", () => {
				const item = makeItem("file", "photo.jpg", { created: T_2021, modified: T_2024, timestamp: T_2024 })

				const sorted = itemSorter.sortItems([item], "captureDesc")

				expect(sorted[0]).toBe(item)
				expect(captureTimestamp(item)).toBe(T_2021)
			})
		})

		// capture sorting: best-effort capture time for the photos timeline. Realistic ms
		// timestamps are required — the key discards candidates below its 1980 garbage floor.
		describe("capture sorting (photos timeline)", () => {
			const T_2019 = Date.UTC(2019, 5, 15)
			const T_2021 = Date.UTC(2021, 5, 30)
			const T_2022 = Date.UTC(2022, 2, 10)
			const T_2024 = Date.UTC(2024, 1, 13)

			it("REGRESSION (#39): legacy upload-stamped created falls back to the older modified date", () => {
				// Legacy client stamped created with the upload time (created == timestamp),
				// the real capture date survives in modified.
				const legacy = makeItem("file", "legacy.jpg", { created: T_2024, modified: T_2021, timestamp: T_2024 })
				const healthy = makeItem("file", "healthy.jpg", { created: T_2022, modified: T_2022, timestamp: T_2024 })

				const result = itemSorter.sortItems([legacy, healthy], "captureDesc")

				// creationDesc would strand legacy.jpg at its 2024 upload slot (first); the capture
				// key places it at its 2021 capture date, after the 2022 photo.
				expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["healthy.jpg", "legacy.jpg"])
			})

			it("orders healthy items (created <= modified) identically to creation sorting", () => {
				const older = makeItem("file", "old.jpg", { created: T_2019, modified: T_2021, timestamp: T_2024 })
				const newer = makeItem("file", "new.jpg", { created: T_2022, modified: T_2022, timestamp: T_2024 })

				const capture = itemSorter.sortItems([older, newer], "captureDesc")
				const creation = itemSorter.sortItems([older, newer], "creationDesc")

				expect(capture.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["new.jpg", "old.jpg"])
				expect(capture.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(
					creation.map((i: DriveItem) => i.data.decryptedMeta?.name)
				)
			})

			it("ignores garbage epoch timestamps instead of sinking items to the bottom", () => {
				// modified 0 (epoch) must be discarded, keeping the item at its upload position
				// rather than dropping it below genuinely old photos.
				const garbageMtime = makeItem("file", "garbage.jpg", { created: T_2024, modified: 0, timestamp: T_2024 })
				const old = makeItem("file", "old.jpg", { created: T_2019, modified: T_2019, timestamp: T_2024 })

				const result = itemSorter.sortItems([old, garbageMtime], "captureDesc")

				expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["garbage.jpg", "old.jpg"])
			})

			it("discards client timestamps later than the server upload time", () => {
				// created postdates the upload (broken device clock) — the capture date cannot be
				// after the upload, so modified wins.
				const skewed = makeItem("file", "skewed.jpg", { created: Date.UTC(2099, 0, 1), modified: T_2021, timestamp: T_2022 })
				const anchor = makeItem("file", "anchor.jpg", { created: T_2022, modified: T_2022, timestamp: T_2024 })

				const result = itemSorter.sortItems([skewed, anchor], "captureDesc")

				expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["anchor.jpg", "skewed.jpg"])
			})

			it("falls back to the upload time when no client timestamp is plausible", () => {
				// Both candidates invalid: created in the future, modified at epoch.
				const broken = makeItem("file", "broken.jpg", { created: Date.UTC(2099, 0, 1), modified: 0, timestamp: T_2021 })
				const anchor = makeItem("file", "anchor.jpg", { created: T_2022, modified: T_2022, timestamp: T_2024 })

				const result = itemSorter.sortItems([broken, anchor], "captureAsc")

				expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["broken.jpg", "anchor.jpg"])
			})
		})

		it("uses uuid as tiebreaker for equal upload dates — lower numeric uuid sorts first in ascending", () => {
			// parseNumbersFromString scans up to 16 digits; we place the distinguishing digit early
			// "00000001-0000-0000-0000-000000000000" first 16 digits → 0000000100000000 = 1_000_000_00 → smaller
			// "00000099-0000-0000-0000-000000000000" first 16 digits → 0000009900000000 → larger
			// ascending (isAsc=true): diff = aUuid - bUuid < 0 → a first
			const a = makeItem("file", "a.txt", { uuid: "00000001-0000-0000-0000-000000000000", timestamp: 1000 })
			const b = makeItem("file", "b.txt", { uuid: "00000099-0000-0000-0000-000000000000", timestamp: 1000 })

			const resultAsc = itemSorter.sortItems([b, a], "uploadDateAsc")
			expect(resultAsc[0]!.data.uuid).toBe("00000001-0000-0000-0000-000000000000")
			expect(resultAsc[1]!.data.uuid).toBe("00000099-0000-0000-0000-000000000000")

			// descending reverses: larger numeric uuid sorts first
			const resultDesc = itemSorter.sortItems([a, b], "uploadDateDesc")
			expect(resultDesc[0]!.data.uuid).toBe("00000099-0000-0000-0000-000000000000")
			expect(resultDesc[1]!.data.uuid).toBe("00000001-0000-0000-0000-000000000000")
		})
	})
})

describe("notesSorter", () => {
	describe("sort", () => {
		it("does not mutate the input array", () => {
			const notes = [makeNote({ uuid: "aaa-111", editedTimestamp: 2000n }), makeNote({ uuid: "bbb-222", editedTimestamp: 3000n })]
			const original = [...notes]

			notesSorter.sort(notes)

			expect(notes[0]).toBe(original[0])
			expect(notes[1]).toBe(original[1])
		})

		it("places pinned notes first", () => {
			const pinned = makeNote({ uuid: "aaa-111", editedTimestamp: 1000n, pinned: true })
			const normal = makeNote({ uuid: "bbb-222", editedTimestamp: 9000n })

			const result = notesSorter.sort([normal, pinned])

			expect(result[0]!.uuid).toBe("aaa-111")
		})

		it("places trashed notes last", () => {
			const trashed = makeNote({ uuid: "aaa-111", editedTimestamp: 9000n, trash: true })
			const normal = makeNote({ uuid: "bbb-222", editedTimestamp: 1000n })

			const result = notesSorter.sort([trashed, normal])

			expect(result[0]!.uuid).toBe("bbb-222")
			expect(result[1]!.uuid).toBe("aaa-111")
		})

		it("places archived notes after normal notes", () => {
			const archived = makeNote({ uuid: "aaa-111", editedTimestamp: 9000n, archive: true })
			const normal = makeNote({ uuid: "bbb-222", editedTimestamp: 1000n })

			const result = notesSorter.sort([archived, normal])

			expect(result[0]!.uuid).toBe("bbb-222")
			expect(result[1]!.uuid).toBe("aaa-111")
		})

		it("sorts by editedTimestamp descending within the same group", () => {
			const older = makeNote({ uuid: "aaa-111", editedTimestamp: 1000n })
			const newer = makeNote({ uuid: "bbb-222", editedTimestamp: 5000n })
			const newest = makeNote({ uuid: "ccc-333", editedTimestamp: 9000n })

			const result = notesSorter.sort([older, newest, newer])

			expect(result.map(n => n.uuid)).toEqual(["ccc-333", "bbb-222", "aaa-111"])
		})

		it("sorts notes with identical editedTimestamp by uuid descending: larger uuid number first", () => {
			// parseUuid(b) - parseUuid(a): b.uuid = "bbb-222" → 222, a.uuid = "aaa-111" → 111
			// 222 - 111 > 0 → b comes first (higher numeric uuid first in desc order)
			const noteA = makeNote({ uuid: "aaa-111", editedTimestamp: 5000n })
			const noteB = makeNote({ uuid: "bbb-222", editedTimestamp: 5000n })

			const result = notesSorter.sort([noteA, noteB])

			expect(result[0]!.uuid).toBe("bbb-222")
			expect(result[1]!.uuid).toBe("aaa-111")
		})

		it("produces the same uuid-tiebreaker order regardless of input order", () => {
			const noteA = makeNote({ uuid: "aaa-111", editedTimestamp: 5000n })
			const noteB = makeNote({ uuid: "bbb-222", editedTimestamp: 5000n })
			const noteC = makeNote({ uuid: "ccc-333", editedTimestamp: 5000n })

			const result1 = notesSorter.sort([noteA, noteB, noteC])
			const result2 = notesSorter.sort([noteC, noteA, noteB])

			// ccc-333 (333) > bbb-222 (222) > aaa-111 (111)
			expect(result1.map(n => n.uuid)).toEqual(["ccc-333", "bbb-222", "aaa-111"])
			expect(result2.map(n => n.uuid)).toEqual(["ccc-333", "bbb-222", "aaa-111"])
		})
	})

	describe("group", () => {
		function makeTag(uuid: string, name: string): NoteTag {
			return {
				uuid,
				name,
				favorite: false,
				editedTimestamp: 1000n,
				createdTimestamp: 1000n,
				undecryptable: false
			}
		}

		it("returns empty array for empty input", () => {
			expect(notesSorter.group({ notes: [] })).toEqual([])
		})

		it("groups pinned notes under a pinned header when groupPinned is true", () => {
			const pinned = makeNote({ uuid: "pinned-1", editedTimestamp: BigInt(Date.now()), pinned: true })
			const normal = makeNote({ uuid: "normal-1", editedTimestamp: BigInt(Date.now()) })

			const result = notesSorter.group({ notes: [normal, pinned], groupPinned: true })
			const headerIdx = result.findIndex(item => item.type === "header" && "id" in item && item.id === "header-pinned")

			expect(headerIdx).toBeGreaterThanOrEqual(0)
			expect(result[headerIdx + 1]?.type).toBe("note")
			expect((result[headerIdx + 1] as { uuid?: string }).uuid).toBe("pinned-1")
		})

		it("groups favorited notes under a favorited header when groupFavorited is true", () => {
			const favorited = makeNote({ uuid: "fav-1", editedTimestamp: BigInt(Date.now()), favorite: true })
			const normal = makeNote({ uuid: "normal-1", editedTimestamp: BigInt(Date.now()) })

			const result = notesSorter.group({ notes: [normal, favorited], groupFavorited: true })
			const headerIdx = result.findIndex(item => item.type === "header" && "id" in item && item.id === "header-favorited")

			expect(headerIdx).toBeGreaterThanOrEqual(0)
			expect(result[headerIdx + 1]?.type).toBe("note")
			expect((result[headerIdx + 1] as { uuid?: string }).uuid).toBe("fav-1")
		})

		it("does not emit favorited header when groupFavorited is false (favorite note falls into time buckets)", () => {
			const favorited = makeNote({ uuid: "fav-1", editedTimestamp: BigInt(Date.now()), favorite: true })

			const result = notesSorter.group({ notes: [favorited], groupFavorited: false })
			const favHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-favorited")

			expect(favHeader).toBeUndefined()
			// The note should appear in a time bucket (today)
			const todayHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-today")
			expect(todayHeader).toBeDefined()
		})

		it("header-favorited title is resolved via i18n (mock returns key verbatim)", () => {
			const favorited = makeNote({ uuid: "fav-1", editedTimestamp: BigInt(Date.now()), favorite: true })

			const result = notesSorter.group({ notes: [favorited], groupFavorited: true })
			const header = result.find(item => item.type === "header" && "id" in item && item.id === "header-favorited") as
				| { title?: string }
				| undefined

			expect(header?.title).toBe("favorited")
		})

		it("groups archived notes under archived header when groupArchived is true", () => {
			const archived = makeNote({ uuid: "arch-1", editedTimestamp: BigInt(Date.now()), archive: true })

			const result = notesSorter.group({ notes: [archived], groupArchived: true })
			const headerIdx = result.findIndex(item => item.type === "header" && "id" in item && item.id === "header-archived")

			expect(headerIdx).toBeGreaterThanOrEqual(0)
			expect(result[headerIdx + 1]?.type).toBe("note")
		})

		it("groups trashed notes under trashed header when groupTrashed is true", () => {
			const trashed = makeNote({ uuid: "trash-1", editedTimestamp: BigInt(Date.now()), trash: true })

			const result = notesSorter.group({ notes: [trashed], groupTrashed: true })
			const headerIdx = result.findIndex(item => item.type === "header" && "id" in item && item.id === "header-trashed")

			expect(headerIdx).toBeGreaterThanOrEqual(0)
			expect(result[headerIdx + 1]?.type).toBe("note")
		})

		it("filters notes by tag uuid when tag is provided", () => {
			const matchingTag = makeTag("tag-abc", "work")
			const otherTag = makeTag("tag-xyz", "other")
			const withTag = makeNote({ uuid: "tagged-1", editedTimestamp: BigInt(Date.now()), tags: [matchingTag] })
			const withOther = makeNote({ uuid: "tagged-2", editedTimestamp: BigInt(Date.now()), tags: [otherTag] })
			const noTags = makeNote({ uuid: "no-tags", editedTimestamp: BigInt(Date.now()) })

			const result = notesSorter.group({ notes: [withTag, withOther, noTags], tag: matchingTag })
			const noteItems = result.filter(item => item.type === "note")

			expect(noteItems).toHaveLength(1)
			expect((noteItems[0] as { uuid?: string }).uuid).toBe("tagged-1")
		})

		it("tag filter respects tagged+pinned note: pinned note with matching tag is included", () => {
			const matchingTag = makeTag("tag-abc", "work")
			const taggedAndPinned = makeNote({
				uuid: "pinned-tagged",
				editedTimestamp: BigInt(Date.now()),
				pinned: true,
				tags: [matchingTag]
			})
			const pinnedOnly = makeNote({ uuid: "pinned-only", editedTimestamp: BigInt(Date.now()), pinned: true, tags: [] })

			// Tag filter applied before grouping: pinnedOnly excluded, taggedAndPinned included
			const result = notesSorter.group({ notes: [taggedAndPinned, pinnedOnly], tag: matchingTag, groupPinned: true })
			const noteItems = result.filter(item => item.type === "note")

			expect(noteItems).toHaveLength(1)
			expect((noteItems[0] as { uuid?: string }).uuid).toBe("pinned-tagged")
		})

		it("places a recent note into the today bucket", () => {
			const now = BigInt(Date.now())
			const recent = makeNote({ uuid: "recent-1", editedTimestamp: now })

			const result = notesSorter.group({ notes: [recent] })
			const todayHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-today")

			expect(todayHeader).toBeDefined()
		})

		it("places a note from 2-6 days ago into the last7days bucket", () => {
			const threeDaysAgo = BigInt(Date.now() - 3 * 24 * 60 * 60 * 1000)
			const note = makeNote({ uuid: "note-7d", editedTimestamp: threeDaysAgo })

			const result = notesSorter.group({ notes: [note] })
			const header7d = result.find(item => item.type === "header" && "id" in item && item.id === "header-7days")

			expect(header7d).toBeDefined()
			// Should NOT be in today bucket
			const todayHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-today")
			expect(todayHeader).toBeUndefined()
		})

		it("places a note from 8-29 days ago into the last30days bucket", () => {
			const fifteenDaysAgo = BigInt(Date.now() - 15 * 24 * 60 * 60 * 1000)
			const note = makeNote({ uuid: "note-30d", editedTimestamp: fifteenDaysAgo })

			const result = notesSorter.group({ notes: [note] })
			const header30d = result.find(item => item.type === "header" && "id" in item && item.id === "header-30days")

			expect(header30d).toBeDefined()
			const header7d = result.find(item => item.type === "header" && "id" in item && item.id === "header-7days")
			expect(header7d).toBeUndefined()
		})

		it("places a note ~90 days ago (older than two months) into a calendar-year bucket, not a month bucket", () => {
			// New scheme: a single month bucket covers [twoMonthsAgo, 30 days ago). Anything older
			// than twoMonthsAgo falls into a calendar-year bucket — there is no second month bucket.
			const ninetyDaysAgoMs = Date.now() - 90 * 24 * 60 * 60 * 1000
			const note = makeNote({ uuid: "old-2", editedTimestamp: BigInt(ninetyDaysAgoMs) })

			const result = notesSorter.group({ notes: [note] })

			// It lands in the year bucket for its own calendar year, labelled with that year.
			const expectedYear = new Date(ninetyDaysAgoMs).getFullYear()
			const yearHeader = result.find(item => item.type === "header" && "id" in item && item.id === `header-${expectedYear}`) as
				| { title?: string }
				| undefined

			expect(yearHeader).toBeDefined()
			expect(yearHeader?.title).toBe(String(expectedYear))

			// And NOT in a month bucket.
			const monthHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-month")
			expect(monthHeader).toBeUndefined()
		})

		it("uses a single month bucket then calendar-year buckets (no duplicate month header)", () => {
			const nowMs = Date.now()
			const fortyFiveDaysAgoMs = nowMs - 45 * 24 * 60 * 60 * 1000 // inside the single month bucket
			const oneHundredFiftyDaysAgoMs = nowMs - 150 * 24 * 60 * 60 * 1000 // older than two months → year bucket
			const recentish = makeNote({ uuid: "month-note", editedTimestamp: BigInt(fortyFiveDaysAgoMs) })
			const older = makeNote({ uuid: "year-note", editedTimestamp: BigInt(oneHundredFiftyDaysAgoMs) })

			const result = notesSorter.group({ notes: [recentish, older] })

			// Exactly one month header — the old code emitted two identically-labelled month headers.
			const monthHeaders = result.filter(item => item.type === "header" && "id" in item && item.id === "header-month")
			expect(monthHeaders).toHaveLength(1)

			const olderYear = new Date(oneHundredFiftyDaysAgoMs).getFullYear()
			const yearHeader = result.find(item => item.type === "header" && "id" in item && item.id === `header-${olderYear}`)
			expect(yearHeader).toBeDefined()
		})

		it("places a note older than one year into a year bucket (header-YEAR)", () => {
			// Use a fixed old timestamp that is definitely > 1 year ago
			const twoYearsAgoMs = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000
			const twoYearsAgo = BigInt(twoYearsAgoMs)
			const note = makeNote({ uuid: "very-old", editedTimestamp: twoYearsAgo })

			const result = notesSorter.group({ notes: [note] })
			const expectedYear = new Date(twoYearsAgoMs).getFullYear()
			const yearHeader = result.find(item => item.type === "header" && "id" in item && item.id === `header-${expectedYear}`) as
				| { title?: string }
				| undefined

			expect(yearHeader).toBeDefined()
			expect(yearHeader?.title).toBe(String(expectedYear))

			// Should NOT appear in the (single) month bucket
			const monthHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-month")
			expect(monthHeader).toBeUndefined()
		})

		it("year bucket header contains the correct note", () => {
			const twoYearsAgoMs = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000
			const twoYearsAgo = BigInt(twoYearsAgoMs)
			const note = makeNote({ uuid: "very-old", editedTimestamp: twoYearsAgo })

			const result = notesSorter.group({ notes: [note] })
			const expectedYear = new Date(twoYearsAgoMs).getFullYear()
			const yearHeaderIdx = result.findIndex(item => item.type === "header" && "id" in item && item.id === `header-${expectedYear}`)

			expect(yearHeaderIdx).toBeGreaterThanOrEqual(0)
			expect(result[yearHeaderIdx + 1]?.type).toBe("note")
			expect((result[yearHeaderIdx + 1] as { uuid?: string }).uuid).toBe("very-old")
		})

		it("multiple notes from different past years each get their own year bucket", () => {
			const now = Date.now()
			const twoYearsAgoMs = now - 2 * 365 * 24 * 60 * 60 * 1000
			const threeYearsAgoMs = now - 3 * 365 * 24 * 60 * 60 * 1000

			const note2 = makeNote({ uuid: "two-yrs", editedTimestamp: BigInt(twoYearsAgoMs) })
			const note3 = makeNote({ uuid: "three-yrs", editedTimestamp: BigInt(threeYearsAgoMs) })

			const result = notesSorter.group({ notes: [note3, note2] })
			const year2 = new Date(twoYearsAgoMs).getFullYear()
			const year3 = new Date(threeYearsAgoMs).getFullYear()

			const header2 = result.find(item => item.type === "header" && "id" in item && item.id === `header-${year2}`)
			const header3 = result.find(item => item.type === "header" && "id" in item && item.id === `header-${year3}`)

			expect(header2).toBeDefined()
			expect(header3).toBeDefined()
		})

		it("resolves the fixed bucket header titles through the module i18n (translated, not tbd_)", () => {
			const now = BigInt(Date.now())
			const recent = makeNote({ uuid: "recent-1", editedTimestamp: now })
			const pinned = makeNote({ uuid: "pinned-1", editedTimestamp: now, pinned: true })
			const trashed = makeNote({ uuid: "trash-1", editedTimestamp: now, trash: true })

			const result = notesSorter.group({ notes: [recent, pinned, trashed], groupPinned: true, groupTrashed: true })
			const headerTitle = (id: string) =>
				result.find(item => item.type === "header" && "id" in item && item.id === id) as { title?: string } | undefined

			// Mock t returns the key verbatim; the point is the real catalog key (not a tbd_ token) is used.
			expect(headerTitle("header-today")?.title).toBe("today")
			expect(headerTitle("header-pinned")?.title).toBe("pinned")
			expect(headerTitle("header-trashed")?.title).toBe("trashed")
		})

		it("renders month-bucket headers with a real Intl month name (not a tbd_month_ key)", () => {
			const now = new Date()
			// ~45 days ago lands in the single month bucket (between 30 days and two months ago).
			const fortyFiveDaysAgo = BigInt(now.getTime() - 45 * 24 * 60 * 60 * 1000)
			const note = makeNote({ uuid: "old-1", editedTimestamp: fortyFiveDaysAgo })

			const result = notesSorter.group({ notes: [note] })
			const monthHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-month") as
				| { title?: string }
				| undefined

			expect(monthHeader).toBeDefined()
			expect(monthHeader?.title).not.toContain("tbd_")
			expect(monthHeader?.title).not.toContain("month_")

			// The title must equal the month name of twoMonthsAgo (the bucket's lower boundary),
			// not oneMonthAgo (bug #20 fix: label matches bucket span, not the month above it).
			const expectedMonth = new Intl.DateTimeFormat("en-US", {
				month: "long"
			}).format(new Date(new Date(now.getFullYear(), now.getMonth() - 2, now.getDate()).getTime()))

			expect(monthHeader?.title).toBe(expectedMonth)
		})

		it("month bucket header label matches twoMonthsAgo, not oneMonthAgo (bug #20 regression)", () => {
			const now = new Date()
			// 45 days ago is inside the single month bucket (editedTimestamp >= twoMonthsAgo, < thirtyDaysAgo)
			const fortyFiveDaysAgo = BigInt(now.getTime() - 45 * 24 * 60 * 60 * 1000)
			const note = makeNote({ uuid: "bug20-note", editedTimestamp: fortyFiveDaysAgo })

			const result = notesSorter.group({ notes: [note] })
			const monthHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-month") as
				| { title?: string }
				| undefined

			expect(monthHeader).toBeDefined()

			const twoMonthsAgoLabel = new Intl.DateTimeFormat("en-US", { month: "long" }).format(
				new Date(now.getFullYear(), now.getMonth() - 2, now.getDate())
			)
			const oneMonthAgoLabel = new Intl.DateTimeFormat("en-US", { month: "long" }).format(
				new Date(now.getFullYear(), now.getMonth() - 1, now.getDate())
			)

			// After the fix, the label is twoMonthsAgo, not oneMonthAgo
			expect(monthHeader?.title).toBe(twoMonthsAgoLabel)
			// Only verify the two labels differ when the months are actually different (they may coincide in rare edge-date cases)
			if (twoMonthsAgoLabel !== oneMonthAgoLabel) {
				expect(monthHeader?.title).not.toBe(oneMonthAgoLabel)
			}
		})

		it("year-0 note is not dropped from grouped output (bug #26 regression: falsy !year guard)", () => {
			// Proleptic Gregorian year 0 = 1 BC. new Date(ts).getFullYear() returns 0 for such timestamps.
			// The old `if (!year) { continue }` guard would skip year 0 due to falsy coercion (!0 === true).
			// new Date(-62167219200000).getFullYear() === 0 (0000-01-01T00:00:00.000Z)
			const year0Ts = -62167219200000 // 0000-01-01T00:00:00.000Z, getFullYear() === 0

			// The note must be older than oneYearAgo so it goes into a year bucket, not a monthly bucket.
			// year0Ts is definitely older than oneYearAgo.
			const note = makeNote({ uuid: "year-zero", editedTimestamp: BigInt(year0Ts) })

			const result = notesSorter.group({ notes: [note] })
			const noteItems = result.filter(item => item.type === "note")

			// With the fix, the note must appear in the output (not be silently dropped)
			expect(noteItems).toHaveLength(1)
			expect((noteItems[0] as { uuid?: string }).uuid).toBe("year-zero")

			// It should be under a year header with title "0"
			const yearHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-0") as
				| { title?: string }
				| undefined

			expect(yearHeader).toBeDefined()
			expect(yearHeader?.title).toBe("0")
		})

		// Finding #4: sortDesc editedTimestamp ?? createdTimestamp fallback (coverage gap)
		// Lines 395 and 417 of sort.ts use `?? createdTimestamp` but makeNote() always provides
		// editedTimestamp, so the fallback was never exercised.

		it("note with editedTimestamp undefined uses createdTimestamp for bucket placement", () => {
			// A note whose editedTimestamp is undefined (e.g. fresh SDK note before first edit)
			// must fall back to createdTimestamp when computing the bucket threshold at line 395.
			const nowTs = BigInt(Date.now())
			const noteWithoutEdited = {
				...makeNote({ uuid: "no-edited", editedTimestamp: nowTs }),
				editedTimestamp: undefined as unknown as bigint,
				createdTimestamp: nowTs
			}

			const result = notesSorter.group({ notes: [noteWithoutEdited] })
			// With createdTimestamp === now it must land in the 'today' bucket
			const todayHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-today")

			expect(todayHeader).toBeDefined()
			const noteItems = result.filter(item => item.type === "note")
			expect(noteItems).toHaveLength(1)
			expect((noteItems[0] as { uuid?: string }).uuid).toBe("no-edited")
		})

		it("two notes with editedTimestamp undefined are sorted descending by createdTimestamp within the bucket", () => {
			// sortDesc at line 416-418 uses ?? createdTimestamp; when both have editedTimestamp undefined
			// the order must follow createdTimestamp descending (most-recent first).
			const nowMs = Date.now()
			const olderTs = BigInt(nowMs - 60_000) // 1 minute ago — still today
			const newerTs = BigInt(nowMs - 1_000) // 1 second ago — still today

			const olderNote = {
				...makeNote({ uuid: "older-no-edited", editedTimestamp: newerTs }),
				editedTimestamp: undefined as unknown as bigint,
				createdTimestamp: olderTs
			}
			const newerNote = {
				...makeNote({ uuid: "newer-no-edited", editedTimestamp: olderTs }),
				editedTimestamp: undefined as unknown as bigint,
				createdTimestamp: newerTs
			}

			const result = notesSorter.group({ notes: [olderNote, newerNote] })
			const noteItems = result.filter(item => item.type === "note")

			expect(noteItems).toHaveLength(2)
			// newer createdTimestamp sorts first (descending)
			expect((noteItems[0] as { uuid?: string }).uuid).toBe("newer-no-edited")
			expect((noteItems[1] as { uuid?: string }).uuid).toBe("older-no-edited")
		})

		it("note with editedTimestamp 0n sorts before notes with larger editedTimestamps within bucket", () => {
			// 0n ?? createdTimestamp evaluates to 0n (not nullish), so Number(0n) === 0.
			// A note with editedTimestamp=0n falls into the oldest bucket (year bucket for year 1970
			// or earlier depending on the epoch), and within that bucket it sorts before notes with
			// positive editedTimestamps.
			// Two notes in the same year bucket: one with 0n, one with a small positive timestamp
			// that also resolves to year 1970.
			const ts1970later = BigInt(1_000_000) // still year 1970

			const noteZero = makeNote({ uuid: "ts-zero", editedTimestamp: 0n })
			const notePositive = makeNote({ uuid: "ts-positive", editedTimestamp: ts1970later })

			const result = notesSorter.group({ notes: [noteZero, notePositive] })
			const noteItems = result.filter(item => item.type === "note")

			expect(noteItems).toHaveLength(2)
			// sortDesc: larger editedTimestamp first; ts1970later > 0n, so notePositive comes first
			expect((noteItems[0] as { uuid?: string }).uuid).toBe("ts-positive")
			expect((noteItems[1] as { uuid?: string }).uuid).toBe("ts-zero")
		})

		it("note with editedTimestamp 0n lands in the correct year bucket (year 1970)", () => {
			// 0n is epoch (1970-01-01); new Date(0).getFullYear() === 1970.
			// The note must land in a year bucket for 1970, not be dropped.
			const noteZero = makeNote({ uuid: "epoch-note", editedTimestamp: 0n })

			const result = notesSorter.group({ notes: [noteZero] })
			const noteItems = result.filter(item => item.type === "note")

			expect(noteItems).toHaveLength(1)
			expect((noteItems[0] as { uuid?: string }).uuid).toBe("epoch-note")

			const yearHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-1970") as
				| { title?: string }
				| undefined

			expect(yearHeader).toBeDefined()
			expect(yearHeader?.title).toBe("1970")
		})

		it("note with editedTimestamp undefined mixed with normal note preserves correct grouping", () => {
			// When a undefined-editedTimestamp note and a normal note both fall in today's bucket,
			// the normal note's editedTimestamp and the no-edited note's createdTimestamp drive ordering.
			const nowMs = Date.now()
			const normalTs = BigInt(nowMs - 2_000) // 2 seconds ago
			const noEditedTs = BigInt(nowMs - 500) // 0.5 seconds ago — more recent

			const normalNote = makeNote({ uuid: "normal", editedTimestamp: normalTs })
			const noEditedNote = {
				...makeNote({ uuid: "no-edit", editedTimestamp: normalTs }),
				editedTimestamp: undefined as unknown as bigint,
				createdTimestamp: noEditedTs
			}

			const result = notesSorter.group({ notes: [normalNote, noEditedNote] })
			const todayHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-today")

			expect(todayHeader).toBeDefined()
			const noteItems = result.filter(item => item.type === "note")
			expect(noteItems).toHaveLength(2)
			// noEditedNote.createdTimestamp (nowMs-500) > normalNote.editedTimestamp (nowMs-2000)
			// sortDesc: larger value first → noEditedNote is first
			expect((noteItems[0] as { uuid?: string }).uuid).toBe("no-edit")
			expect((noteItems[1] as { uuid?: string }).uuid).toBe("normal")
		})
	})

	// Finding #185: bucket tests rely on uncontrolled Date.now() — fix with vi.useFakeTimers().
	// All assertions below freeze time so group()'s internal Date.now() and the test's own
	// timestamp computations always agree, eliminating the midnight/month-rollover boundary race.
	describe("group (frozen time)", () => {
		// Fixed anchor: a mid-month Wednesday so no midnight/month-edge ambiguity.
		const FROZEN_NOW = new Date("2025-06-15T12:00:00.000Z").getTime()

		beforeAll(() => {
			vi.useFakeTimers()
			vi.setSystemTime(FROZEN_NOW)
		})

		afterAll(() => {
			vi.useRealTimers()
		})

		it("note edited <24 h ago lands in today bucket", () => {
			const ts = BigInt(FROZEN_NOW - 2 * 60 * 60 * 1000) // 2 h ago
			const note = makeNote({ uuid: "today-note", editedTimestamp: ts })

			const result = notesSorter.group({ notes: [note] })
			const todayHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-today")

			expect(todayHeader).toBeDefined()
			const noteItems = result.filter(item => item.type === "note")
			expect(noteItems).toHaveLength(1)
			expect((noteItems[0] as { uuid?: string }).uuid).toBe("today-note")
		})

		it("note edited 3 days ago lands in last-7-days bucket", () => {
			const ts = BigInt(FROZEN_NOW - 3 * 24 * 60 * 60 * 1000)
			const note = makeNote({ uuid: "7d-note", editedTimestamp: ts })

			const result = notesSorter.group({ notes: [note] })
			const header7d = result.find(item => item.type === "header" && "id" in item && item.id === "header-7days")

			expect(header7d).toBeDefined()
			const todayHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-today")
			expect(todayHeader).toBeUndefined()
		})

		it("note edited 15 days ago lands in last-30-days bucket", () => {
			const ts = BigInt(FROZEN_NOW - 15 * 24 * 60 * 60 * 1000)
			const note = makeNote({ uuid: "30d-note", editedTimestamp: ts })

			const result = notesSorter.group({ notes: [note] })
			const header30d = result.find(item => item.type === "header" && "id" in item && item.id === "header-30days")

			expect(header30d).toBeDefined()
			const header7d = result.find(item => item.type === "header" && "id" in item && item.id === "header-7days")
			expect(header7d).toBeUndefined()
		})

		it("note edited ~45 days ago lands in the single month bucket", () => {
			const ts = BigInt(FROZEN_NOW - 45 * 24 * 60 * 60 * 1000)
			const note = makeNote({ uuid: "month-note", editedTimestamp: ts })

			const result = notesSorter.group({ notes: [note] })
			const monthHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-month") as
				| { title?: string }
				| undefined

			expect(monthHeader).toBeDefined()
			// No 30-days header
			const header30d = result.find(item => item.type === "header" && "id" in item && item.id === "header-30days")
			expect(header30d).toBeUndefined()
		})

		it("month-bucket header title equals the Intl name of two-months-ago (frozen clock)", () => {
			const ts = BigInt(FROZEN_NOW - 45 * 24 * 60 * 60 * 1000)
			const note = makeNote({ uuid: "month-label", editedTimestamp: ts })

			const result = notesSorter.group({ notes: [note] })
			const monthHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-month") as
				| { title?: string }
				| undefined

			expect(monthHeader).toBeDefined()

			// Two months before June 2025 = April 2025
			const frozenDate = new Date(FROZEN_NOW)
			const twoMonthsAgoDate = new Date(frozenDate.getFullYear(), frozenDate.getMonth() - 2, frozenDate.getDate())
			const expectedLabel = new Intl.DateTimeFormat("en-US", { month: "long" }).format(twoMonthsAgoDate)

			expect(monthHeader?.title).toBe(expectedLabel)
		})

		it("note edited 2 years ago lands in the correct year bucket (frozen clock)", () => {
			const twoYearsAgoMs = FROZEN_NOW - 2 * 365 * 24 * 60 * 60 * 1000
			const ts = BigInt(twoYearsAgoMs)
			const note = makeNote({ uuid: "old-year-note", editedTimestamp: ts })

			const result = notesSorter.group({ notes: [note] })
			const expectedYear = new Date(twoYearsAgoMs).getFullYear()
			const yearHeader = result.find(item => item.type === "header" && "id" in item && item.id === `header-${expectedYear}`) as
				| { title?: string }
				| undefined

			expect(yearHeader).toBeDefined()
			expect(yearHeader?.title).toBe(String(expectedYear))

			// Must NOT be in the month bucket
			const monthHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-month")
			expect(monthHeader).toBeUndefined()
		})
	})
})

describe("itemSorter — unknown SortByType fallback", () => {
	// Finding #8: Line 273 of sort.ts: `sortMap[type] ?? sortMap['nameAsc']`.
	// A stale persisted preference that no longer exists in SortByType must fall back to
	// nameAsc silently (no throw, alphabetical result).
	it("unknown SortByType falls back to nameAsc without throwing", () => {
		const a = makeItem("file", "alpha.txt")
		const b = makeItem("file", "beta.txt")
		const c = makeItem("file", "gamma.txt")

		const result = itemSorter.sortItems([c, a, b], "invalidSortKey" as unknown as SortByType)

		expect(result).toHaveLength(3)
		// Verify result matches nameAsc alphabetical order
		expect(result.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(["alpha.txt", "beta.txt", "gamma.txt"])
	})

	it("unknown SortByType result matches explicit nameAsc result", () => {
		const items = [makeItem("file", "zebra.txt"), makeItem("file", "apple.txt"), makeItem("file", "mango.txt")]

		const fallbackResult = itemSorter.sortItems(items, "unknownKey" as unknown as SortByType)
		const nameAscResult = itemSorter.sortItems(items, "nameAsc")

		expect(fallbackResult.map((i: DriveItem) => i.data.decryptedMeta?.name)).toEqual(
			nameAscResult.map((i: DriveItem) => i.data.decryptedMeta?.name)
		)
	})
})

describe("itemSorter — deterministic ties + directory sizes (#49)", () => {
	it("equal-size files sort alphabetically under sizeAsc and fully reversed under sizeDesc", () => {
		const items = [
			makeItem("file", "cherry.txt", { size: 100n, uuid: "cccc-3" }),
			makeItem("file", "apple.txt", { size: 100n, uuid: "aaaa-1" }),
			makeItem("file", "banana.txt", { size: 100n, uuid: "bbbb-2" })
		]

		const asc = itemSorter.sortItems(items, "sizeAsc").map(i => i.data.decryptedMeta?.name)
		const desc = itemSorter.sortItems(items, "sizeDesc").map(i => i.data.decryptedMeta?.name)

		expect(asc).toEqual(["apple.txt", "banana.txt", "cherry.txt"])
		expect(desc).toEqual(["cherry.txt", "banana.txt", "apple.txt"])
	})

	it("output is independent of input order for size and mime ties", () => {
		const build = () => [
			makeItem("directory", "delta", { uuid: "dddd-4" }),
			makeItem("directory", "alpha", { uuid: "aaaa-1" }),
			makeItem("file", "same-size-b.txt", { size: 50n, uuid: "bbbb-2" }),
			makeItem("file", "same-size-a.txt", { size: 50n, uuid: "aaaa-9" }),
			makeItem("file", "photo-b.jpg", { size: 1n, mime: "image/jpeg", uuid: "ffff-6" }),
			makeItem("file", "photo-a.jpg", { size: 2n, mime: "image/jpeg", uuid: "eeee-5" })
		]

		for (const mode of ["sizeAsc", "sizeDesc", "mimeAsc", "mimeDesc"] as const) {
			const forward = itemSorter.sortItems(build(), mode).map(i => i.data.uuid)
			const reversed = itemSorter.sortItems(build().reverse(), mode).map(i => i.data.uuid)
			const rotated = (() => {
				const input = build()

				input.push(input.shift() as (typeof input)[number])

				return itemSorter.sortItems(input, mode).map(i => i.data.uuid)
			})()

			expect(reversed, `mode ${mode} (reversed input)`).toEqual(forward)
			expect(rotated, `mode ${mode} (rotated input)`).toEqual(forward)
		}
	})

	it("mime ties order by name within each mime group", () => {
		const items = [
			makeItem("file", "zeta.jpg", { mime: "image/jpeg", uuid: "zzzz-1" }),
			makeItem("file", "beta.png", { mime: "image/png", uuid: "bbbb-2" }),
			makeItem("file", "alpha.jpg", { mime: "image/jpeg", uuid: "aaaa-3" })
		]

		const asc = itemSorter.sortItems(items, "mimeAsc").map(i => i.data.decryptedMeta?.name)

		expect(asc).toEqual(["alpha.jpg", "zeta.jpg", "beta.png"])
	})

	it("identical names resolve through the uuid chain deterministically", () => {
		const a = makeItem("file", "same.txt", { uuid: "0001-aaaa" })
		const b = makeItem("file", "same.txt", { uuid: "0002-bbbb" })

		const forward = itemSorter.sortItems([b, a], "nameAsc")
		const reversed = itemSorter.sortItems([a, b], "nameAsc")

		expect(forward.map(i => i.data.uuid)).toEqual(["0001-aaaa", "0002-bbbb"])
		expect(reversed.map(i => i.data.uuid)).toEqual(["0001-aaaa", "0002-bbbb"])
	})

	it("directorySizes orders directories by their real sizes under sizeDesc", () => {
		const items = [
			makeItem("directory", "small", { uuid: "dir-small" }),
			makeItem("directory", "huge", { uuid: "dir-huge" }),
			makeItem("directory", "medium", { uuid: "dir-medium" }),
			makeItem("file", "tiny.txt", { size: 1n, uuid: "file-1" })
		]

		const directorySizes = new Map<string, number>([
			["dir-small", 10],
			["dir-huge", 1_000_000],
			["dir-medium", 5_000]
		])

		const desc = itemSorter.sortItems(items, "sizeDesc", { directorySizes }).map(i => i.data.uuid)

		// Dirs-first partition holds; within dirs the REAL sizes decide.
		expect(desc).toEqual(["dir-huge", "dir-medium", "dir-small", "file-1"])
	})

	it("directories missing from the map sort as size 0 and fall back to name order", () => {
		const items = [
			makeItem("directory", "known-large", { uuid: "dir-known" }),
			makeItem("directory", "unknown-b", { uuid: "dir-ub" }),
			makeItem("directory", "unknown-a", { uuid: "dir-ua" })
		]

		const directorySizes = new Map<string, number>([["dir-known", 999]])

		const asc = itemSorter.sortItems(items, "sizeAsc", { directorySizes }).map(i => i.data.decryptedMeta?.name)

		// Unknown dirs (size 0) come first under asc, alphabetical among themselves.
		expect(asc).toEqual(["unknown-a", "unknown-b", "known-large"])
	})

	it("files ignore the directorySizes map even on uuid collision", () => {
		const items = [
			makeItem("file", "big.bin", { size: 100n, uuid: "shared-uuid" }),
			makeItem("file", "small.bin", { size: 1n, uuid: "other-uuid" })
		]

		// A (pathological) file uuid present in the map must not override data.size.
		const directorySizes = new Map<string, number>([["shared-uuid", 0]])

		const asc = itemSorter.sortItems(items, "sizeAsc", { directorySizes }).map(i => i.data.decryptedMeta?.name)

		expect(asc).toEqual(["small.bin", "big.bin"])
	})

	it("non-integral or non-finite map values fall back to data.size instead of throwing", () => {
		const items = [
			makeItem("directory", "nan-dir", { uuid: "dir-nan" }),
			makeItem("directory", "real-dir", { uuid: "dir-real" })
		]

		const directorySizes = new Map<string, number>([
			["dir-nan", Number.NaN],
			["dir-real", 123.75]
		])

		const asc = itemSorter.sortItems(items, "sizeAsc", { directorySizes })

		// NaN → data.size (0n) sorts first; 123.75 truncates to 123n.
		expect(asc.map(i => i.data.decryptedMeta?.name)).toEqual(["nan-dir", "real-dir"])
	})
})
