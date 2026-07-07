import { describe, expect, it } from "vitest"
import type { Dir, File } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/lib/drive/item"
import { driveItemActions } from "@/components/drive/item-menu.logic"

// Local fixtures mirror item.test.ts / actions.test.ts's own per-file convention (each test file owns
// its minimal Dir/File shape rather than sharing one across files).
function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		parent: "22222222-2222-2222-2222-222222222222",
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: "33333333-3333-3333-3333-333333333333",
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

function dirItem(overrides: Partial<Dir> = {}): DriveItem {
	return narrowItem(mockDir(overrides))
}

function fileItem(overrides: Partial<File> = {}): DriveItem {
	return narrowItem(mockFile(overrides))
}

function ids(item: DriveItem, variant: Parameters<typeof driveItemActions>[1]): string[] {
	return driveItemActions(item, variant).map(descriptor => descriptor.id)
}

describe("driveItemActions (item menu gating)", () => {
	it("drive variant, directory: rename/move/favorite/color/info/publicLink/copyLink/trash, in that order (no versions)", () => {
		expect(ids(dirItem(), "drive")).toEqual(["rename", "move", "favorite", "color", "info", "publicLink", "copyLink", "trash"])
	})

	it("drive variant, file: rename/move/favorite/versions/info/publicLink/copyLink/trash, in that order (no color)", () => {
		expect(ids(fileItem(), "drive")).toEqual(["rename", "move", "favorite", "versions", "info", "publicLink", "copyLink", "trash"])
	})

	it("recents variant mirrors drive's gating", () => {
		expect(ids(fileItem(), "recents")).toEqual(ids(fileItem(), "drive"))
	})

	it("favorites variant mirrors drive's gating", () => {
		expect(ids(dirItem(), "favorites")).toEqual(ids(dirItem(), "drive"))
	})

	it("trash variant: only restore/deletePermanently/info, regardless of type", () => {
		expect(ids(dirItem(), "trash")).toEqual(["restore", "deletePermanently", "info"])
		expect(ids(fileItem(), "trash")).toEqual(["restore", "deletePermanently", "info"])
	})

	it("undecryptable item outside trash: reduced to info/trash only", () => {
		const undecryptable = narrowItem(mockFile({ meta: { type: "encrypted", data: "ciphertext" } }))
		expect(ids(undecryptable, "drive")).toEqual(["info", "trash"])
		expect(ids(undecryptable, "favorites")).toEqual(["info", "trash"])
	})

	it("undecryptable item in trash: identical to a normal trash-variant item (no further reduction)", () => {
		const undecryptable = narrowItem(mockDir({ meta: { type: "encrypted", data: "ciphertext" } }))
		expect(ids(undecryptable, "trash")).toEqual(["restore", "deletePermanently", "info"])
	})

	it("favorite descriptor labels 'Favorite' when not yet favorited", () => {
		const descriptor = driveItemActions(dirItem({ favorited: false }), "drive").find(d => d.id === "favorite")
		expect(descriptor?.labelKey).toBe("driveActionFavorite")
	})

	it("favorite descriptor labels 'Unfavorite' when already favorited", () => {
		const descriptor = driveItemActions(dirItem({ favorited: true }), "drive").find(d => d.id === "favorite")
		expect(descriptor?.labelKey).toBe("driveActionUnfavorite")
	})

	it("favorite and restore run directly (no dialog)", () => {
		const favorite = driveItemActions(dirItem(), "drive").find(d => d.id === "favorite")
		const restore = driveItemActions(dirItem(), "trash").find(d => d.id === "restore")
		expect(favorite?.run).toBe("direct")
		expect(restore?.run).toBe("direct")
	})

	it("rename/move/color/versions/info dispatch their own matching dialog kind", () => {
		const dirDescriptors = driveItemActions(dirItem(), "drive")
		const fileDescriptors = driveItemActions(fileItem(), "drive")
		expect(dirDescriptors.find(d => d.id === "rename")).toMatchObject({ run: "dialog", dialogKind: "rename" })
		expect(dirDescriptors.find(d => d.id === "move")).toMatchObject({ run: "dialog", dialogKind: "move" })
		expect(dirDescriptors.find(d => d.id === "color")).toMatchObject({ run: "dialog", dialogKind: "color" })
		expect(fileDescriptors.find(d => d.id === "versions")).toMatchObject({ run: "dialog", dialogKind: "versions" })
		expect(dirDescriptors.find(d => d.id === "info")).toMatchObject({ run: "dialog", dialogKind: "info" })
	})

	it("public link and copy link both dispatch the link dialog kind (the dialog itself owns the clipboard write)", () => {
		const descriptors = driveItemActions(dirItem(), "drive")
		expect(descriptors.find(d => d.id === "publicLink")).toMatchObject({ run: "dialog", dialogKind: "link" })
		expect(descriptors.find(d => d.id === "copyLink")).toMatchObject({ run: "dialog", dialogKind: "link" })
	})

	it("trash is recoverable (non-destructive); deletePermanently is destructive", () => {
		const trash = driveItemActions(dirItem(), "drive").find(d => d.id === "trash")
		const deletePermanently = driveItemActions(dirItem(), "trash").find(d => d.id === "deletePermanently")
		expect(trash).toMatchObject({ run: "dialog", dialogKind: "trash" })
		expect(trash?.destructive).toBeFalsy()
		expect(deletePermanently).toMatchObject({ run: "dialog", dialogKind: "delete", destructive: true })
	})

	it("returns a fresh array each call (callers may safely treat it as their own)", () => {
		const first = driveItemActions(dirItem(), "drive")
		const second = driveItemActions(dirItem(), "drive")
		expect(first).not.toBe(second)
		expect(first).toEqual(second)
	})
})
