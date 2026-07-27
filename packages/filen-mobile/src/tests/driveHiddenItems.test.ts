import { vi, describe, it, expect } from "vitest"

// driveHiddenItems.ts exposes secureStore-backed accessors alongside its pure helpers; only the
// helpers are under test here, so no hook rendering and no store are needed.
vi.mock("@/lib/secureStore", () => ({
	default: { get: vi.fn() },
	useSecureStore: vi.fn()
}))

import {
	isHiddenName,
	isHiddenDriveItem,
	isHiddenSearchPath,
	filterHiddenDriveItems,
	DEFAULT_HIDE_HIDDEN_ITEMS,
	HIDE_HIDDEN_ITEMS_SECURE_STORE_KEY
} from "@/features/drive/driveHiddenItems"
import type { DriveItem } from "@/types"

function file(uuid: string, name: string | null, undecryptable = false): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			undecryptable,
			decryptedMeta: name === null ? null : ({ name } as DriveItem["data"]["decryptedMeta"])
		} as DriveItem["data"]
	} as DriveItem
}

function dir(uuid: string, name: string): DriveItem {
	return {
		type: "directory",
		data: {
			uuid,
			undecryptable: false,
			decryptedMeta: { name } as DriveItem["data"]["decryptedMeta"]
		} as DriveItem["data"]
	} as DriveItem
}

// The shared variants carry their decrypted name in the same place (unwrapDirMeta / unwrapFileMeta
// stamp `decryptedMeta` on every variant), so the rule has to hold for them too — they reach the
// listing through sharedIn / sharedOut / links.
function variant(type: DriveItem["type"], uuid: string, name: string): DriveItem {
	return {
		type,
		data: {
			uuid,
			undecryptable: false,
			decryptedMeta: { name } as DriveItem["data"]["decryptedMeta"]
		} as DriveItem["data"]
	} as DriveItem
}

describe("hidden-item preference defaults", () => {
	it("defaults to showing hidden items", () => {
		expect(DEFAULT_HIDE_HIDDEN_ITEMS).toBe(false)
	})

	it("keys off a stable, namespaced secure-store key", () => {
		expect(HIDE_HIDDEN_ITEMS_SECURE_STORE_KEY).toBe("drive.hideHiddenItems")
	})
})

describe("isHiddenName", () => {
	it("matches a leading dot, including one behind stray whitespace", () => {
		expect(isHiddenName(".env")).toBe(true)
		expect(isHiddenName("  .env")).toBe(true)
	})

	it("does not match a dot elsewhere, or an empty name", () => {
		expect(isHiddenName("notes.txt")).toBe(false)
		expect(isHiddenName("archive.tar.gz")).toBe(false)
		expect(isHiddenName("")).toBe(false)
	})
})

describe("isHiddenDriveItem", () => {
	it("treats a leading dot as hidden, for files and directories alike", () => {
		expect(isHiddenDriveItem(file("f1", ".env"))).toBe(true)
		expect(isHiddenDriveItem(dir("d1", ".thumb"))).toBe(true)
	})

	it("applies to every shared variant too", () => {
		for (const type of ["sharedFile", "sharedRootFile", "sharedDirectory", "sharedRootDirectory"] as const) {
			expect(isHiddenDriveItem(variant(type, "u1", ".secret"))).toBe(true)
			expect(isHiddenDriveItem(variant(type, "u2", "Reports"))).toBe(false)
		}
	})

	it("does not treat a dot elsewhere in the name as hidden", () => {
		expect(isHiddenDriveItem(file("f1", "notes.txt"))).toBe(false)
		expect(isHiddenDriveItem(dir("d1", "v1.2"))).toBe(false)
	})

	it("keeps an undecryptable item visible — its real name is unknown and its placeholder is not dotted", () => {
		expect(isHiddenDriveItem(file("f1", null, true))).toBe(false)
	})

	it("keeps an item with no decrypted name visible rather than guessing", () => {
		expect(isHiddenDriveItem(file("f1", null))).toBe(false)
	})
})

describe("isHiddenSearchPath", () => {
	it("treats a direct child of the search root as not hidden", () => {
		expect(isHiddenSearchPath("")).toBe(false)
	})

	it("matches a hidden ancestor at any depth", () => {
		expect(isHiddenSearchPath(".thumb")).toBe(true)
		expect(isHiddenSearchPath("Projects/.git/objects")).toBe(true)
		expect(isHiddenSearchPath("Projects/app/.cache")).toBe(true)
	})

	it("leaves a fully visible ancestry alone", () => {
		expect(isHiddenSearchPath("Projects/app/src")).toBe(false)
		expect(isHiddenSearchPath("v1.2/build")).toBe(false)
	})
})

describe("filterHiddenDriveItems", () => {
	const items = [file("f1", ".env"), file("f2", "notes.txt"), dir("d1", ".thumb"), dir("d2", "Documents")]

	it("returns the input untouched — same reference — when the preference is off", () => {
		expect(filterHiddenDriveItems({ items, hide: false })).toBe(items)
	})

	it("drops every dot-prefixed entry when the preference is on", () => {
		expect(filterHiddenDriveItems({ items, hide: true }).map(item => item.data.uuid)).toEqual(["f2", "d2"])
	})

	it("can empty a listing whose entries are all hidden", () => {
		expect(filterHiddenDriveItems({ items: [file("f1", ".env"), dir("d1", ".git")], hide: true })).toEqual([])
	})

	// Search is recursive: hiding `.thumb` from the browser while its contents flood the results
	// would defeat the point, and the search row prints the hidden directory's name in the path.
	it("drops a visibly-named search hit that lives inside a hidden directory", () => {
		const hits = [file("a", "cover.jpg"), file("b", "notes.txt")]
		const paths = new Map([
			["a", ".thumb"],
			["b", "Documents"]
		])

		expect(filterHiddenDriveItems({ items: hits, hide: true, searchParentPaths: paths }).map(item => item.data.uuid)).toEqual(["b"])
	})

	it("keeps a hit whose path is absent from the map (not a search result)", () => {
		const hits = [file("a", "cover.jpg")]

		expect(filterHiddenDriveItems({ items: hits, hide: true, searchParentPaths: new Map() }).map(item => item.data.uuid)).toEqual(["a"])
	})

	it("ignores ancestry entirely when the preference is off", () => {
		const hits = [file("a", "cover.jpg")]
		const paths = new Map([["a", ".thumb"]])

		expect(filterHiddenDriveItems({ items: hits, hide: false, searchParentPaths: paths })).toBe(hits)
	})
})
