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
			const items = [
				makeItem("file", "b.txt"),
				makeItem("file", "a.txt")
			]
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

			expect(result.map(i => i.data.decryptedMeta?.name)).toEqual([
				"file1.txt",
				"file2.txt",
				"file10.txt"
			])
		})

		it("sorts nameDesc in reverse natural order", () => {
			const file1 = makeItem("file", "file1.txt")
			const file2 = makeItem("file", "file2.txt")
			const file10 = makeItem("file", "file10.txt")

			const result = itemSorter.sortItems([file1, file10, file2], "nameDesc")

			expect(result.map(i => i.data.decryptedMeta?.name)).toEqual([
				"file10.txt",
				"file2.txt",
				"file1.txt"
			])
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

			expect(result.map(i => i.data.decryptedMeta?.name)).toEqual([
				"s.txt",
				"m.txt",
				"l.txt"
			])
		})

		it("sorts sizeDesc by file size descending", () => {
			const small = makeItem("file", "s.txt", { size: 100n })
			const large = makeItem("file", "l.txt", { size: 1000n })

			const result = itemSorter.sortItems([small, large], "sizeDesc")

			expect(result.map(i => i.data.decryptedMeta?.name)).toEqual([
				"l.txt",
				"s.txt"
			])
		})

		it("sorts lastModifiedAsc by modification timestamp", () => {
			const old = makeItem("file", "old.txt", { modified: 1000 })
			const recent = makeItem("file", "new.txt", { modified: 9000 })

			const result = itemSorter.sortItems([recent, old], "lastModifiedAsc")

			expect(result.map(i => i.data.decryptedMeta?.name)).toEqual([
				"old.txt",
				"new.txt"
			])
		})

		it("sorts lastModifiedDesc by modification timestamp descending", () => {
			const old = makeItem("file", "old.txt", { modified: 1000 })
			const recent = makeItem("file", "new.txt", { modified: 9000 })

			const result = itemSorter.sortItems([old, recent], "lastModifiedDesc")

			expect(result.map(i => i.data.decryptedMeta?.name)).toEqual([
				"new.txt",
				"old.txt"
			])
		})
	})
})

describe("notesSorter", () => {
	describe("sort", () => {
		it("does not mutate the input array", () => {
			const notes = [
				makeNote({ uuid: "aaa-111", editedTimestamp: 2000n }),
				makeNote({ uuid: "bbb-222", editedTimestamp: 3000n })
			]
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

			expect(result.map(n => n.uuid)).toEqual([
				"ccc-333",
				"bbb-222",
				"aaa-111"
			])
		})
	})
})
