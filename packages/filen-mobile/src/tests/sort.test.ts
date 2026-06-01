import { vi, describe, it, expect } from "vitest"

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

import { itemSorter, notesSorter } from "@/lib/sort"
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

		it("sorts identical-name items in stable (input-preserving) order", () => {
			const a = makeItem("file", "same.txt", { uuid: "aaa-111" })
			const b = makeItem("file", "same.txt", { uuid: "bbb-222" })
			const c = makeItem("file", "same.txt", { uuid: "ccc-333" })

			// compareName returns 0 for identical names; stable sort must preserve input order
			const result = itemSorter.sortItems([a, b, c], "nameAsc")

			expect(result[0]).toBe(a)
			expect(result[1]).toBe(b)
			expect(result[2]).toBe(c)
			expect(result).toHaveLength(3)
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

		it("places a recent note into the today bucket", () => {
			const now = BigInt(Date.now())
			const recent = makeNote({ uuid: "recent-1", editedTimestamp: now })

			const result = notesSorter.group({ notes: [recent] })
			const todayHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-today")

			expect(todayHeader).toBeDefined()
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
			// ~45 days ago lands in the previousMonth1 bucket (between 30 days and two months ago).
			const fortyFiveDaysAgo = BigInt(now.getTime() - 45 * 24 * 60 * 60 * 1000)
			const note = makeNote({ uuid: "old-1", editedTimestamp: fortyFiveDaysAgo })

			const result = notesSorter.group({ notes: [note] })
			const monthHeader = result.find(item => item.type === "header" && "id" in item && item.id === "header-month1") as
				| { title?: string }
				| undefined

			expect(monthHeader).toBeDefined()
			expect(monthHeader?.title).not.toContain("tbd_")
			expect(monthHeader?.title).not.toContain("month_")

			// The title must equal a locale-formatted long month name.
			const expectedMonth = new Intl.DateTimeFormat("en-US", {
				month: "long"
			}).format(new Date(new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()).getTime()))

			expect(monthHeader?.title).toBe(expectedMonth)
		})
	})
})
