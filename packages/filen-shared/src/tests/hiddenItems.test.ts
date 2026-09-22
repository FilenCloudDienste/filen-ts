import { describe, it, expect } from "vitest"
import { isHiddenName, isHiddenSearchPath, filterHiddenItems } from "@filen/shared"

describe("isHiddenName", () => {
	it("treats a dot-prefixed name as hidden", () => {
		expect(isHiddenName(".env")).toBe(true)
	})

	it("trims leading whitespace first — another client can create ' .env', the same hidden file to a user", () => {
		expect(isHiddenName(" .env")).toBe(true)
	})

	it("treats a bare dot-entry name as hidden", () => {
		expect(isHiddenName("..")).toBe(true)
	})

	it("leaves an ordinary name alone", () => {
		expect(isHiddenName("env")).toBe(false)
		expect(isHiddenName("a.b")).toBe(false)
		expect(isHiddenName("notes.txt")).toBe(false)
		expect(isHiddenName("archive.tar.gz")).toBe(false)
	})

	it("is false for an empty name", () => {
		expect(isHiddenName("")).toBe(false)
	})
})

describe("isHiddenSearchPath", () => {
	it("is false for a direct child of the search root (empty path)", () => {
		expect(isHiddenSearchPath("")).toBe(false)
	})

	it("is true when any ancestor segment is hidden, at any depth", () => {
		expect(isHiddenSearchPath(".thumb")).toBe(true)
		expect(isHiddenSearchPath("docs/.cache")).toBe(true)
		expect(isHiddenSearchPath(".git/objects")).toBe(true)
		expect(isHiddenSearchPath("Projects/app/.cache")).toBe(true)
	})

	it("is false when no segment is hidden", () => {
		expect(isHiddenSearchPath("docs/cache")).toBe(false)
		expect(isHiddenSearchPath("Projects/app/src")).toBe(false)
		expect(isHiddenSearchPath("v1.2/build")).toBe(false)
	})
})

function item(uuid: string, name: string | null) {
	return { data: { uuid, decryptedMeta: name === null ? null : { name } } }
}

describe("filterHiddenItems", () => {
	it("returns the input untouched — same reference — when hide is false", () => {
		const items = [item("f1", ".env"), item("f2", "notes.txt")]

		expect(filterHiddenItems({ items, hide: false })).toBe(items)
	})

	it("drops every dot-prefixed entry when hide is true", () => {
		const items = [item("f1", ".env"), item("f2", "notes.txt"), item("d1", ".thumb"), item("d2", "Documents")]

		expect(filterHiddenItems({ items, hide: true }).map(entry => entry.data.uuid)).toEqual(["f2", "d2"])
	})

	it("keeps an item with no decrypted name visible — its display name is its uuid, never dot-prefixed", () => {
		const items = [item("f1", null)]

		expect(filterHiddenItems({ items, hide: true })).toEqual(items)
	})

	it("drops a visibly-named search hit that lives inside a hidden directory", () => {
		const hits = [item("a", "cover.jpg"), item("b", "notes.txt")]
		const searchParentPaths = new Map([
			["a", ".thumb"],
			["b", "Documents"]
		])

		expect(filterHiddenItems({ items: hits, hide: true, searchParentPaths }).map(entry => entry.data.uuid)).toEqual(["b"])
	})

	it("keeps a hit whose uuid is absent from searchParentPaths (not a search result)", () => {
		const hits = [item("a", "cover.jpg")]

		expect(filterHiddenItems({ items: hits, hide: true, searchParentPaths: new Map() }).map(entry => entry.data.uuid)).toEqual(["a"])
	})

	it("ignores ancestry entirely when hide is false", () => {
		const hits = [item("a", "cover.jpg")]
		const searchParentPaths = new Map([["a", ".thumb"]])

		expect(filterHiddenItems({ items: hits, hide: false, searchParentPaths })).toBe(hits)
	})
})
