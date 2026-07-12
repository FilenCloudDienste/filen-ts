import { describe, expect, it } from "vitest"
import type { File as SdkFile, LinkedDir, LinkedDirsAndFiles, DirPublicInfo } from "@filen/sdk-rs"
import {
	rootCrumb,
	enterCrumb,
	jumpToCrumb,
	toBrowseEntries,
	filterEntries,
	sortEntries,
	entryName,
	DEFAULT_PUBLIC_SORT,
	type BrowseEntry
} from "@/features/publicLinks/lib/browse.logic"

function makeFile(uuid: `${string}-${string}-${string}-${string}`, name: string, size: bigint, modified: bigint): SdkFile {
	return {
		uuid,
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
		password: undefined,
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

describe("filterEntries", () => {
	const entries = toBrowseEntries(listing)

	it("returns everything for a blank query", () => {
		expect(filterEntries(entries, "   ")).toHaveLength(4)
	})

	it("filters case-insensitively by name substring", () => {
		const result = filterEntries(entries, "ap")

		expect(result.map(entryName).sort()).toEqual(["Apple", "apricot.txt"])
	})
})

describe("sortEntries", () => {
	const entries = toBrowseEntries(listing)

	it("always groups folders before files, name-ascending by default", () => {
		const sorted = sortEntries(entries, DEFAULT_PUBLIC_SORT)

		expect(sorted.map(entryName)).toEqual(["Apple", "Zebra", "apricot.txt", "banana.txt"])
	})

	it("sorts files by size within the file group", () => {
		const sorted = sortEntries(entries, { field: "size", direction: "asc" })
		const files = sorted.filter(entry => entry.kind === "file")

		expect(files.map(entryName)).toEqual(["apricot.txt", "banana.txt"])
	})

	it("reverses within groups on descending, folders still first", () => {
		const sorted = sortEntries(entries, { field: "name", direction: "desc" })

		expect(sorted.map(entryName)).toEqual(["Zebra", "Apple", "banana.txt", "apricot.txt"])
	})

	it("sorts files by modified date", () => {
		const sorted = sortEntries(entries, { field: "date", direction: "asc" })
		const files = sorted.filter(entry => entry.kind === "file")

		// banana modified 200 < apricot modified 500
		expect(files.map(entryName)).toEqual(["banana.txt", "apricot.txt"])
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
