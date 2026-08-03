import { describe, expect, it } from "vitest"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { filterHiddenDriveItems, hiddenFilterAppliesTo, isHiddenName, isHiddenSearchPath } from "@/features/drive/lib/hiddenItems"

// Pure module — no mocks at all: the kv half of this feature lives in lib/preferences.ts, so nothing
// here touches storage.

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function dirItem(name: string, uuid = testUuid("dir")): DriveItem {
	const dir: Dir = {
		uuid,
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	}

	return narrowItem(dir)
}

function undecryptableItem(uuid = testUuid("opaque")): DriveItem {
	const dir: Dir = {
		uuid,
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "encrypted", data: "ciphertext" }
	}

	return narrowItem(dir)
}

function fileItem(name: string, uuid = testUuid("file")): DriveItem {
	const file: File = {
		uuid,
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name, mime: "text/plain", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		}
	}

	return narrowItem(file)
}

describe("isHiddenName", () => {
	it("treats a dot-prefixed name as hidden", () => {
		expect(isHiddenName(".env")).toBe(true)
	})

	it("trims leading whitespace first — another client can create ' .env', the same hidden file to a user", () => {
		expect(isHiddenName(" .env")).toBe(true)
	})

	it("leaves an ordinary name alone", () => {
		expect(isHiddenName("env")).toBe(false)
		expect(isHiddenName("a.b")).toBe(false)
	})

	it("is false for an empty name", () => {
		expect(isHiddenName("")).toBe(false)
	})

	it("treats a bare dot-entry name as hidden", () => {
		expect(isHiddenName("..")).toBe(true)
	})
})

describe("isHiddenSearchPath", () => {
	it("is false for a direct child of the search root (empty path)", () => {
		expect(isHiddenSearchPath("")).toBe(false)
	})

	it("is true when any ancestor segment is hidden", () => {
		expect(isHiddenSearchPath("docs/.cache")).toBe(true)
		expect(isHiddenSearchPath(".git/objects")).toBe(true)
	})

	it("is false when no segment is hidden", () => {
		expect(isHiddenSearchPath("docs/cache")).toBe(false)
	})
})

describe("filterHiddenDriveItems", () => {
	it("returns everything when hide is false", () => {
		const items = [dirItem(".secret"), fileItem("report.pdf")]

		expect(filterHiddenDriveItems({ items, hide: false })).toEqual(items)
	})

	it("hides an item by its own dot-prefixed display name", () => {
		const visible = fileItem("report.pdf")
		const items = [dirItem(".secret"), visible]

		expect(filterHiddenDriveItems({ items, hide: true })).toEqual([visible])
	})

	it("hides a search hit whose ancestor chain contains a hidden directory, keeping its siblings", () => {
		const buried = fileItem("notes.txt", testUuid("buried"))
		const sibling = fileItem("readme.txt", testUuid("sibling"))
		const searchParentPaths = new Map([
			[buried.data.uuid, "docs/.cache"],
			[sibling.data.uuid, "docs"]
		])

		expect(filterHiddenDriveItems({ items: [buried, sibling], hide: true, searchParentPaths })).toEqual([sibling])
	})

	it("keeps an undecryptable row — its display name is its uuid, and hiding something unidentifiable strands it", () => {
		const opaque = undecryptableItem()

		expect(filterHiddenDriveItems({ items: [opaque], hide: true })).toEqual([opaque])
	})

	it("keeps an item with no searchParentPaths entry", () => {
		const item = fileItem("report.pdf")

		expect(filterHiddenDriveItems({ items: [item], hide: true, searchParentPaths: new Map() })).toEqual([item])
	})
})

describe("hiddenFilterAppliesTo", () => {
	it("applies only to the two surfaces you browse your own content on", () => {
		const variants: DriveVariant[] = ["drive", "recents", "favorites", "trash", "links", "sharedIn", "sharedOut"]

		expect(variants.filter(hiddenFilterAppliesTo)).toEqual(["drive", "recents"])
	})
})
