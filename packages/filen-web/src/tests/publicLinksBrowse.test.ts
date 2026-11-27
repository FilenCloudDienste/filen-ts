import { describe, expect, it } from "vitest"
import type { File as SdkFile, LinkedDir, LinkedDirsAndFiles, DirPublicInfo, DirPublicLink } from "@filen/sdk-rs"
import {
	rootCrumb,
	enterCrumb,
	jumpToCrumb,
	toBrowseEntries,
	sortEntries,
	entryName,
	entryKey,
	browseEntryActions,
	selectedEntries,
	selectionCheck,
	toggleAllSelection,
	toggleSelection,
	selectionBytes,
	browseSaveItems,
	browseSaveGlyph,
	DEFAULT_PUBLIC_SORT,
	EMPTY_SELECTION,
	type BrowseEntry
} from "@/features/publicLinks/lib/browse.logic"
import { sortDriveItems } from "@/features/drive/lib/sort"

function makeFile(uuid: `${string}-${string}-${string}-${string}`, name: string, size: bigint, modified: bigint): SdkFile {
	return {
		uuid,
		stableUUID: undefined,
		meta: { type: "decoded", data: { name, mime: "application/octet-stream", size, key: "k", version: 2, modified } },
		parent: "00000000-0000-0000-0000-000000000000",
		size,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: modified,
		chunks: 1n,
		canMakeThumbnail: false
	}
}

function makeDir(uuid: `${string}-${string}-${string}-${string}`, name: string): LinkedDir {
	return {
		inner: {
			uuid,
			parent: "00000000-0000-0000-0000-000000000000",
			color: "default",
			timestamp: 0n,
			favorited: false,
			meta: { type: "decoded", data: { name } }
		},
		linkedTag: true
	}
}

const listing: LinkedDirsAndFiles = {
	dirs: [makeDir("d0000000-0000-0000-0000-00000000000a", "Zebra"), makeDir("d0000000-0000-0000-0000-00000000000b", "Apple")],
	files: [
		makeFile("f0000000-0000-0000-0000-00000000000a", "banana.txt", 300n, 200n),
		makeFile("f0000000-0000-0000-0000-00000000000b", "apricot.txt", 100n, 500n)
	]
}

const info: DirPublicInfo = {
	root: {
		inner: {
			uuid: "e0000000-0000-0000-0000-000000000001",
			color: "default",
			timestamp: 0n,
			meta: { type: "decoded", data: { name: "Shared" } }
		},
		linkedTag: true
	},
	link: {
		linkUuid: "c0000000-0000-0000-0000-000000000001",
		linkKey: "kk",
		linkKeyVersion: 2,
		password: { type: "none" },
		enableDownload: true,
		salt: "salt"
	},
	hasPassword: false
}

describe("toBrowseEntries", () => {
	it("narrows dirs and files into entries with the raw handle preserved", () => {
		const entries = toBrowseEntries(listing)

		expect(entries).toHaveLength(4)
		expect(entries.filter(entry => entry.kind === "dir")).toHaveLength(2)
		expect(entries.filter(entry => entry.kind === "file")).toHaveLength(2)
	})
})

describe("sortEntries", () => {
	const entries = toBrowseEntries(listing)

	it("always groups folders before files, name-ascending by default", () => {
		const sorted = sortEntries(entries, DEFAULT_PUBLIC_SORT)

		expect(sorted.map(entryName)).toEqual(["Apple", "Zebra", "apricot.txt", "banana.txt"])
	})

	it("sorts files by size within the file group", () => {
		const sorted = sortEntries(entries, "sizeAsc")
		const files = sorted.filter(entry => entry.kind === "file")

		expect(files.map(entryName)).toEqual(["apricot.txt", "banana.txt"])
	})

	it("reverses within groups on descending, folders still first", () => {
		const sorted = sortEntries(entries, "nameDesc")

		expect(sorted.map(entryName)).toEqual(["Zebra", "Apple", "banana.txt", "apricot.txt"])
	})

	it("sorts files by modified date", () => {
		const sorted = sortEntries(entries, "lastModifiedAsc")
		const files = sorted.filter(entry => entry.kind === "file")

		// banana modified 200 < apricot modified 500
		expect(files.map(entryName)).toEqual(["banana.txt", "apricot.txt"])
	})

	it("orders names that compare equal the drive listing's way, whatever order the listing came in", () => {
		const tied: LinkedDirsAndFiles = {
			dirs: [],
			files: [
				makeFile("40000000-0000-0000-0000-000000000000", "a.txt", 1n, 1n),
				makeFile("30000000-0000-0000-0000-000000000000", "A.txt", 1n, 1n),
				makeFile("20000000-0000-0000-0000-000000000000", "file10.txt", 1n, 1n),
				makeFile("10000000-0000-0000-0000-000000000000", "file9.txt", 1n, 1n)
			]
		}
		const forward = toBrowseEntries(tied)
		const reversed = [...forward].reverse()

		for (const sort of [DEFAULT_PUBLIC_SORT, "sizeAsc", "lastModifiedDesc"] as const) {
			const expected = sortDriveItems(
				forward.map(entry => entry.item),
				sort
			).map(item => item.data.uuid)

			expect(sortEntries(forward, sort).map(entry => entry.item.data.uuid)).toEqual(expected)
			expect(sortEntries(reversed, sort).map(entry => entry.item.data.uuid)).toEqual(expected)
		}

		expect(sortEntries(forward, DEFAULT_PUBLIC_SORT).map(entryName).slice(2)).toEqual(["file9.txt", "file10.txt"])
	})
})

describe("navigation stack", () => {
	const dirEntry = toBrowseEntries(listing).find((entry): entry is Extract<BrowseEntry, { kind: "dir" }> => entry.kind === "dir")

	it("starts at the root crumb derived from the link info", () => {
		const crumb = rootCrumb(info)

		expect(crumb.name).toBe("Shared")
		expect(crumb.uuid).toBe("e0000000-0000-0000-0000-000000000001")
	})

	it("pushes a subfolder crumb without mutating the input", () => {
		if (dirEntry === undefined) {
			throw new Error("expected a directory entry")
		}

		const start = [rootCrumb(info)]
		const next = enterCrumb(start, dirEntry)

		expect(next).toHaveLength(2)
		expect(start).toHaveLength(1)
		expect(next[1]?.uuid).toBe(dirEntry.item.data.uuid)
	})

	it("jumps back to an ancestor crumb by index", () => {
		if (dirEntry === undefined) {
			throw new Error("expected a directory entry")
		}

		const deep = enterCrumb(enterCrumb([rootCrumb(info)], dirEntry), dirEntry)

		expect(jumpToCrumb(deep, 0)).toHaveLength(1)
		expect(jumpToCrumb(deep, 1)).toHaveLength(2)
	})

	it("leaves the stack unchanged for an out-of-range jump", () => {
		const start = [rootCrumb(info)]

		expect(jumpToCrumb(start, 5)).toHaveLength(1)
		expect(jumpToCrumb(start, -1)).toHaveLength(1)
	})
})

describe("browseEntryActions", () => {
	it("offers a file Open, Download where the link allows it, and Save where saveable", () => {
		expect(browseEntryActions("file", true, true)).toEqual(["open", "download", "saveToDrive"])
		expect(browseEntryActions("file", true, false)).toEqual(["open", "download"])
		expect(browseEntryActions("file", false, false)).toEqual(["open"])
	})

	it("offers a directory Open and its zip, never a row's own Save", () => {
		expect(browseEntryActions("dir", true, true)).toEqual(["open", "download"])
		expect(browseEntryActions("dir", false, false)).toEqual(["open"])
	})
})

describe("selection", () => {
	const entries = sortEntries(toBrowseEntries(listing), DEFAULT_PUBLIC_SORT)
	const keys = entries.map(entryKey)
	const files = entries.filter(entry => entry.kind === "file")

	it("lists the selected entries in listing order, whatever order they were picked in", () => {
		const selection = new Set([keys[3] ?? "", keys[0] ?? ""])

		expect(selectedEntries(entries, selection).map(entryKey)).toEqual([keys[0], keys[3]])
		expect(selectedEntries(entries, EMPTY_SELECTION)).toEqual([])
	})

	it("ignores a selected uuid the level no longer shows", () => {
		expect(selectedEntries(entries, new Set(["gone", keys[1] ?? ""])).map(entryKey)).toEqual([keys[1]])
	})

	it("checks the header off, mixed, then on", () => {
		expect(selectionCheck(entries, EMPTY_SELECTION)).toBe("off")
		expect(selectionCheck(entries, new Set([keys[0] ?? ""]))).toBe("mixed")
		expect(selectionCheck(entries, new Set(keys))).toBe("on")
		expect(selectionCheck([], new Set(keys))).toBe("off")
	})

	it("selects everything from off or mixed, and nothing once everything is", () => {
		expect([...toggleAllSelection(entries, EMPTY_SELECTION)].sort()).toEqual([...keys].sort())
		expect([...toggleAllSelection(entries, new Set([keys[2] ?? ""]))].sort()).toEqual([...keys].sort())
		expect(toggleAllSelection(entries, new Set(keys)).size).toBe(0)
	})

	it("toggles one uuid without touching the set it was given", () => {
		const before = new Set([keys[0] ?? ""])
		const added = toggleSelection(before, keys[1] ?? "")

		expect([...added]).toEqual([keys[0], keys[1]])
		expect([...toggleSelection(added, keys[0] ?? "")]).toEqual([keys[1]])
		expect([...before]).toEqual([keys[0]])
	})

	it("adds up the selected files, and says nothing once a directory is among them", () => {
		expect(selectionBytes(files)).toBe(files.reduce((sum, entry) => sum + entry.file.size, 0n))
		expect(selectionBytes([])).toBe(0n)
		expect(selectionBytes(entries)).toBeNull()
	})
})

describe("browseSaveItems", () => {
	const link = { enableDownload: true } as unknown as DirPublicLink
	const entries = sortEntries(toBrowseEntries(listing), DEFAULT_PUBLIC_SORT)

	it("hands the SDK a file as listed and a directory with the link it was listed under", () => {
		const items = browseSaveItems(entries, link)

		entries.forEach((entry, index) => {
			expect(items[index]).toStrictEqual(entry.kind === "file" ? entry.file : { dir: entry.dir, link })
		})
	})

	it("names the copy's glyph after one item's kind, or items for several", () => {
		const dir = entries.find(entry => entry.kind === "dir")
		const file = entries.find(entry => entry.kind === "file")

		expect(dir && browseSaveGlyph([dir])).toBe("directory")
		expect(file && browseSaveGlyph([file])).toBe("file")
		expect(browseSaveGlyph(entries)).toBe("items")
	})
})
