import { describe, expect, it } from "vitest"
import { UserMinusIcon } from "lucide-react"
import type { Dir, File, SharedDir, SharedFile, SharedRootDir, SharingRole } from "@filen/sdk-rs"
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

function sharerRole(id: number, email: string): SharingRole {
	return { Sharer: { email, id } }
}

function mockSharedRootDir(overrides: Partial<SharedRootDir> = {}): SharedRootDir {
	return {
		inner: {
			uuid: "44444444-4444-4444-4444-444444444444",
			color: "default",
			timestamp: 1_700_000_000_000n,
			meta: { type: "decoded", data: { name: "SharedRoot" } }
		},
		sharingRole: sharerRole(42, "sharer@filen.io"),
		writeAccess: true,
		...overrides
	}
}

function mockSharedFile(overrides: Partial<SharedFile> = {}): SharedFile {
	return {
		uuid: "55555555-5555-5555-5555-555555555555",
		size: 2_048n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 2n,
		timestamp: 1_700_000_000_000n,
		meta: {
			type: "decoded",
			data: { name: "shared.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 2_048n, key: "k", version: 2 }
		},
		sharingRole: sharerRole(7, "receiver@filen.io"),
		sharedTag: true,
		...overrides
	}
}

function mockSharedDir(overrides: Partial<SharedDir> = {}): SharedDir {
	return { inner: mockDir({ uuid: "66666666-6666-6666-6666-666666666666" }), sharedTag: true, ...overrides }
}

function sharedRootDirItem(): DriveItem {
	return narrowItem(mockSharedRootDir())
}

function sharedRootFileItem(): DriveItem {
	return narrowItem(mockSharedFile())
}

// Nested shared arms need a spread role to classify (see item.ts) — mirrors item.test.ts's own fixture.
function sharedDirItem(): DriveItem {
	return narrowItem({ ...mockSharedDir(), sharingRole: sharerRole(1, "a@filen.io") })
}

function sharedFileItem(): DriveItem {
	return narrowItem({ ...mockFile({ uuid: "77777777-7777-7777-7777-777777777777" }), sharingRole: sharerRole(1, "a@filen.io") })
}

function ids(item: DriveItem, variant: Parameters<typeof driveItemActions>[1]): string[] {
	return driveItemActions(item, variant).map(descriptor => descriptor.id)
}

describe("driveItemActions (item menu gating)", () => {
	it("drive variant, directory: rename/move/favorite/color/info/share/publicLink/copyLink/trash, in that order (no versions)", () => {
		expect(ids(dirItem(), "drive")).toEqual(["rename", "move", "favorite", "color", "info", "share", "publicLink", "copyLink", "trash"])
	})

	it("drive variant, file: rename/move/favorite/versions/info/share/publicLink/copyLink/trash, in that order (no color)", () => {
		expect(ids(fileItem(), "drive")).toEqual([
			"rename",
			"move",
			"favorite",
			"versions",
			"info",
			"share",
			"publicLink",
			"copyLink",
			"trash"
		])
	})

	it("recents variant mirrors drive's gating", () => {
		expect(ids(fileItem(), "recents")).toEqual(ids(fileItem(), "drive"))
	})

	it("favorites variant mirrors drive's gating", () => {
		expect(ids(dirItem(), "favorites")).toEqual(ids(dirItem(), "drive"))
	})

	// Share is offered on the owned surfaces (drive/recents/favorites/sharedOut) but never on
	// shared-with-me (you can't grant access to an item you don't own) — mirrors mobile's gating.
	it("share is present on every owned variant and absent on sharedIn", () => {
		expect(ids(fileItem(), "drive")).toContain("share")
		expect(ids(fileItem(), "recents")).toContain("share")
		expect(ids(fileItem(), "favorites")).toContain("share")
		expect(ids(fileItem(), "sharedOut")).toContain("share")
		expect(ids(fileItem(), "sharedIn")).not.toContain("share")
	})

	it("share dispatches its own contact-picker dialog kind", () => {
		expect(driveItemActions(dirItem(), "drive").find(d => d.id === "share")).toMatchObject({ run: "dialog", dialogKind: "share" })
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

// Unshare (removeSharedItem) is root-only — gated purely on item.type, never variant alone: only a
// sharedRootDirectory/sharedRootFile arm carries the raw shareSource removeSharedItem needs (item.ts).
describe("driveItemActions — unshare gating (shared-root arms only)", () => {
	it("offers unshare on a sharedRootDirectory (shared-with-others root)", () => {
		expect(ids(sharedRootDirItem(), "sharedOut")).toContain("unshare")
	})

	it("offers unshare on a sharedRootFile (shared-with-me root)", () => {
		expect(ids(sharedRootFileItem(), "sharedIn")).toContain("unshare")
	})

	it("never offers unshare on a nested sharedDirectory or sharedFile", () => {
		expect(ids(sharedDirItem(), "sharedIn")).not.toContain("unshare")
		expect(ids(sharedFileItem(), "sharedIn")).not.toContain("unshare")
	})

	it("never offers unshare on an owned item (drive/recents/favorites)", () => {
		expect(ids(dirItem(), "drive")).not.toContain("unshare")
		expect(ids(fileItem(), "recents")).not.toContain("unshare")
		expect(ids(dirItem(), "favorites")).not.toContain("unshare")
	})

	it("never offers unshare in the trash-reduced menu", () => {
		expect(ids(dirItem(), "trash")).not.toContain("unshare")
		expect(ids(fileItem(), "trash")).not.toContain("unshare")
	})

	it("keeps unshare for an undecryptable shared-root item — pure-uuid disposition, same as trash", () => {
		const undecryptableRootDir = narrowItem(
			mockSharedRootDir({
				inner: {
					uuid: "88888888-8888-8888-8888-888888888888",
					color: "default",
					timestamp: 1_700_000_000_000n,
					meta: { type: "encrypted", data: "ciphertext" }
				}
			})
		)

		expect(ids(undecryptableRootDir, "sharedOut")).toEqual(["info", "trash", "unshare"])
	})

	it("unshare dispatches its own confirm dialog kind and is destructive-styled", () => {
		const descriptor = driveItemActions(sharedRootDirItem(), "sharedOut").find(d => d.id === "unshare")

		expect(descriptor).toMatchObject({ run: "dialog", dialogKind: "unshare", destructive: true, icon: UserMinusIcon })
	})

	it("unshare is the last action offered on a decryptable shared-root item, after trash", () => {
		const descriptors = ids(sharedRootFileItem(), "sharedIn")

		expect(descriptors.at(-1)).toBe("unshare")
		expect(descriptors.at(-2)).toBe("trash")
	})
})
