import { describe, it, expect } from "vitest"
import { itemSorter, notesSorter } from "@/lib/sort"
import { type DriveItem } from "@/types"
import { type Note } from "@filen/sdk-rs"

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
			}
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

		it("does not crash when decryptedMeta is null (falls back to uuid)", () => {
			const uuid1 = "aaa-111"
			const uuid2 = "bbb-222"

			const item1 = {
				type: "file",
				data: {
					uuid: uuid1,
					size: 0n,
					timestamp: 1000,
					decryptedMeta: null
				}
			} as unknown as DriveItem

			const item2 = {
				type: "file",
				data: {
					uuid: uuid2,
					size: 0n,
					timestamp: 1000,
					decryptedMeta: null
				}
			} as unknown as DriveItem

			expect(() => itemSorter.sortItems([item2, item1], "nameAsc")).not.toThrow()

			const result = itemSorter.sortItems([item2, item1], "nameAsc")

			expect(result).toHaveLength(2)
		})

		it("produces consistent ordering for items with identical names", () => {
			const a = makeItem("file", "same.txt", { uuid: "aaa-111" })
			const b = makeItem("file", "same.txt", { uuid: "bbb-222" })
			const c = makeItem("file", "same.txt", { uuid: "ccc-333" })

			const result1 = itemSorter.sortItems([a, b, c], "nameAsc")
			const result2 = itemSorter.sortItems([a, b, c], "nameAsc")

			expect(result1.map(i => i.data.uuid)).toEqual(result2.map(i => i.data.uuid))
			expect(result1).toHaveLength(3)
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

		it("produces stable order for notes with identical editedTimestamp (uuid tiebreaker)", () => {
			const noteA = makeNote({ uuid: "aaa-111", editedTimestamp: 5000n })
			const noteB = makeNote({ uuid: "bbb-222", editedTimestamp: 5000n })
			const noteC = makeNote({ uuid: "ccc-333", editedTimestamp: 5000n })

			const result1 = notesSorter.sort([noteA, noteB, noteC])
			const result2 = notesSorter.sort([noteC, noteA, noteB])

			expect(result1.map(n => n.uuid)).toEqual(result2.map(n => n.uuid))
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

		it("uses uuid as tiebreaker for equal upload dates", () => {
			const a = makeItem("file", "a.txt", { uuid: "00000000-0000-0000-0000-000000000001", timestamp: 1000 })
			const b = makeItem("file", "b.txt", { uuid: "00000000-0000-0000-0000-000000000099", timestamp: 1000 })

			const resultAsc = itemSorter.sortItems([b, a], "uploadDateAsc")
			const resultDesc = itemSorter.sortItems([a, b], "uploadDateDesc")

			// Both items have equal timestamps, so uuid determines order
			// Ascending and descending should produce opposite orders
			const ascNames = resultAsc.map((i: DriveItem) => i.data.decryptedMeta?.name)
			const descNames = resultDesc.map((i: DriveItem) => i.data.decryptedMeta?.name)

			expect(ascNames).toHaveLength(2)
			expect(descNames).toHaveLength(2)
			expect(ascNames[0]).toBe(descNames[1])
			expect(ascNames[1]).toBe(descNames[0])
		})
	})
})
