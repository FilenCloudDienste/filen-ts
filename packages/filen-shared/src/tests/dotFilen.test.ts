import { describe, it, expect } from "vitest"
import {
	DOT_FILEN_SUBDIRS,
	dotFilenSubdirLookupNames,
	dotFilenSubdirRename,
	filterHiddenItems,
	isDotFilenName,
	isDotFilenSearchPath,
	isDotFilenSubdirName,
	isRootDotFilen,
	type RootDotFilenFilter
} from "@filen/shared"

const ROOT = "root-uuid"

describe("DOT_FILEN_SUBDIRS", () => {
	it("names every subdirectory in lowercase", () => {
		for (const name of Object.values(DOT_FILEN_SUBDIRS)) {
			expect(name).toBe(name.toLowerCase())
		}
	})
})

describe("dotFilenSubdirLookupNames", () => {
	it("looks chat-uploads up under its legacy name after the canonical one", () => {
		expect(dotFilenSubdirLookupNames(DOT_FILEN_SUBDIRS.chatUploads)).toEqual(["chat-uploads", "Chat Uploads"])
	})

	it("looks every other subdirectory up under its own name alone", () => {
		expect(dotFilenSubdirLookupNames(DOT_FILEN_SUBDIRS.videos)).toEqual(["videos"])
		expect(dotFilenSubdirLookupNames("anything")).toEqual(["anything"])
	})
})

describe("isDotFilenSubdirName", () => {
	it("matches the canonical name case-insensitively", () => {
		expect(isDotFilenSubdirName("Videos", "videos")).toBe(true)
		expect(isDotFilenSubdirName("PLAYLISTS", "playlists")).toBe(true)
	})

	it("matches a legacy name", () => {
		expect(isDotFilenSubdirName("Chat Uploads", "chat-uploads")).toBe(true)
		expect(isDotFilenSubdirName("chat uploads", "chat-uploads")).toBe(true)
	})

	it("matches nothing else", () => {
		expect(isDotFilenSubdirName("Videos2", "videos")).toBe(false)
		expect(isDotFilenSubdirName("Chat Uploads", "videos")).toBe(false)
	})
})

describe("dotFilenSubdirRename", () => {
	it("renames a case variant to the canonical name", () => {
		expect(dotFilenSubdirRename("Videos", "videos")).toBe("videos")
		expect(dotFilenSubdirRename("Office", "office")).toBe("office")
	})

	it("renames the legacy chat uploads directory", () => {
		expect(dotFilenSubdirRename("Chat Uploads", "chat-uploads")).toBe("chat-uploads")
	})

	it("leaves a canonical name alone", () => {
		expect(dotFilenSubdirRename("videos", "videos")).toBeNull()
		expect(dotFilenSubdirRename("chat-uploads", "chat-uploads")).toBeNull()
	})

	it("never renames a directory that is not the one looked up", () => {
		expect(dotFilenSubdirRename("Movies", "videos")).toBeNull()
	})
})

describe("isRootDotFilen", () => {
	it("matches .filen directly under the drive root, in any case", () => {
		expect(isRootDotFilen({ name: ".filen", parentUuid: ROOT, rootUuid: ROOT })).toBe(true)
		expect(isRootDotFilen({ name: ".Filen", parentUuid: ROOT, rootUuid: ROOT })).toBe(true)
	})

	it("ignores a .filen nested elsewhere", () => {
		expect(isRootDotFilen({ name: ".filen", parentUuid: "other", rootUuid: ROOT })).toBe(false)
	})

	it("ignores anything that isn't an own directory, and an unknown root", () => {
		expect(isRootDotFilen({ name: ".filen", parentUuid: null, rootUuid: ROOT })).toBe(false)
		expect(isRootDotFilen({ name: ".filen", parentUuid: "", rootUuid: "" })).toBe(false)
		expect(isRootDotFilen({ name: ".filen", parentUuid: null, rootUuid: null })).toBe(false)
	})

	it("ignores other names", () => {
		expect(isRootDotFilen({ name: ".filen2", parentUuid: ROOT, rootUuid: ROOT })).toBe(false)
		expect(isRootDotFilen({ name: " .filen", parentUuid: ROOT, rootUuid: ROOT })).toBe(false)
	})
})

describe("isDotFilenName / isDotFilenSearchPath", () => {
	it("folds case", () => {
		expect(isDotFilenName(".FILEN")).toBe(true)
		expect(isDotFilenName("filen")).toBe(false)
	})

	it("judges a search hit's ancestry by its first segment", () => {
		expect(isDotFilenSearchPath(".filen")).toBe(true)
		expect(isDotFilenSearchPath(".filen/videos")).toBe(true)
		expect(isDotFilenSearchPath("Docs/.filen")).toBe(false)
		expect(isDotFilenSearchPath("")).toBe(false)
	})
})

interface Item {
	type: "directory" | "file"
	data: { uuid: string; parent: string; decryptedMeta: { name: string } | null }
}

function item(uuid: string, name: string | null, parent = ROOT, type: Item["type"] = "directory"): Item {
	return { type, data: { uuid, parent, decryptedMeta: name === null ? null : { name } } }
}

function rootFilter(searchAtDriveRoot = false): RootDotFilenFilter<Item> {
	return {
		rootUuid: ROOT,
		directoryParentOf: entry => (entry.type === "directory" ? entry.data.parent : null),
		searchAtDriveRoot
	}
}

describe("filterHiddenItems with rootDotFilen", () => {
	const dotFilen = item("a", ".filen")
	const docs = item("b", "Docs")
	const env = item("c", ".env")
	const nested = item("d", ".filen", "b")
	const file = item("e", ".filen", ROOT, "file")

	it("removes the root .filen without the dot-prefix toggle", () => {
		expect(filterHiddenItems({ items: [dotFilen, docs, env, nested, file], hide: false, rootDotFilen: rootFilter() })).toEqual([
			docs,
			env,
			nested,
			file
		])
	})

	it("combines with the dot-prefix toggle", () => {
		expect(filterHiddenItems({ items: [dotFilen, docs, env], hide: true, rootDotFilen: rootFilter() })).toEqual([docs])
	})

	it("returns the input itself when neither applies", () => {
		const items = [dotFilen, docs]

		expect(filterHiddenItems({ items, hide: false })).toBe(items)
	})

	it("removes search hits inside .filen only for a search rooted at the drive root", () => {
		const inside = item("f", "library.v1.json", "x", "file")
		const paths = new Map([
			["f", ".filen/videos"],
			["b", ""]
		])

		expect(filterHiddenItems({ items: [inside, docs], hide: false, searchParentPaths: paths, rootDotFilen: rootFilter(true) })).toEqual([
			docs
		])
		expect(filterHiddenItems({ items: [inside, docs], hide: false, searchParentPaths: paths, rootDotFilen: rootFilter(false) })).toEqual([
			inside,
			docs
		])
	})

	it("returns the input itself when a filter applies but removes nothing", () => {
		const items = [docs, env]

		expect(filterHiddenItems({ items, hide: false, rootDotFilen: rootFilter() })).toBe(items)
		const plain = [docs]

		expect(filterHiddenItems({ items: plain, hide: true })).toBe(plain)
	})

	it("drops items inside .filen in a flat listing, as the platform knows them", () => {
		const settings = item("h", "library.v1.json", "videos-dir", "file")
		const filter = { ...rootFilter(), insideDotFilen: (entry: Item) => entry.data.parent === "videos-dir" }

		expect(filterHiddenItems({ items: [settings, docs], hide: false, rootDotFilen: filter })).toEqual([docs])
	})

	it("keeps an undecryptable directory visible", () => {
		const undecryptable = item("g", null)

		expect(filterHiddenItems({ items: [undecryptable], hide: false, rootDotFilen: rootFilter() })).toEqual([undecryptable])
	})
})
