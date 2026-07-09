import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import {
	PencilIcon,
	FolderInputIcon,
	StarIcon,
	StarOffIcon,
	PaletteIcon,
	HistoryIcon,
	InfoIcon,
	LinkIcon,
	CopyIcon,
	UsersIcon,
	UserMinusIcon,
	Trash2Icon,
	RotateCcwIcon,
	DownloadIcon
} from "lucide-react"
import type { Dir, File, SharedDir, SharedFile, SharedRootDir, SharingRole } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

// item-menu.logic.ts imports lib/drive/download.ts (for startDownloads) which in turn touches the
// worker client and query client — unresolvable/unwanted under node vitest, mirrors
// lib/drive/download.test.ts's own mock boundary. startDownloads is replaced, since actually running
// it would reach the (also mocked) worker.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { startDownloadsMock } = vi.hoisted(() => ({ startDownloadsMock: vi.fn() }))

vi.mock("@/features/drive/lib/download", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/lib/download")>()
	return { ...actual, startDownloads: startDownloadsMock }
})

// isFsaAvailable reads `window`, absent entirely under node vitest (a real call would throw) — kept
// REAL otherwise (via importOriginal) so save-download's own other exports stay genuine.
// downloadDescriptor no longer calls it at all (the service-worker zip path made download's enabled
// gate unconditional) — stubbed to both true and false below purely to prove that value no longer
// changes the outcome.
const { isFsaAvailableMock } = vi.hoisted(() => ({ isFsaAvailableMock: vi.fn() }))

vi.mock("@/features/drive/lib/saveDownload", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/lib/saveDownload")>()
	return { ...actual, isFsaAvailable: isFsaAvailableMock }
})

import { driveItemActions, startItemDownload } from "@/features/drive/components/itemMenu.logic"

beforeEach(() => {
	isFsaAvailableMock.mockReturnValue(false)
})

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

// Pins the shared per-action label + icon facts (factored into ACTION_DEFS) so a drift in either the
// map or a builder's reference to it surfaces here — the id-only lists above prove ordering/gating
// but never which label or icon a descriptor carries.
function facts(item: DriveItem, variant: Parameters<typeof driveItemActions>[1]): { id: string; labelKey: string; icon: unknown }[] {
	return driveItemActions(item, variant).map(descriptor => ({ id: descriptor.id, labelKey: descriptor.labelKey, icon: descriptor.icon }))
}

describe("driveItemActions (item menu gating)", () => {
	it("drive variant, directory: rename/move/favorite/color/info/download/share/publicLink/copyLink/trash, in that order (no versions)", () => {
		expect(ids(dirItem(), "drive")).toEqual([
			"rename",
			"move",
			"favorite",
			"color",
			"info",
			"download",
			"share",
			"publicLink",
			"copyLink",
			"trash"
		])
	})

	it("drive variant, file: rename/move/favorite/versions/info/download/share/publicLink/copyLink/trash, in that order (no color)", () => {
		expect(ids(fileItem(), "drive")).toEqual([
			"rename",
			"move",
			"favorite",
			"versions",
			"info",
			"download",
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

	it("undecryptable item outside trash: reduced to info/trash only (download excluded — can never decrypt)", () => {
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

	it("keeps unshare (and info) for an undecryptable shared-root item — pure-uuid disposition, no decrypted metadata needed", () => {
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

		// No trash: sharedOut is a shared surface (isSharedVariant), so the owner-mutating trash push
		// never runs — see the "shared-surface safe subset" describe block below. Download is absent too:
		// an undecryptable item's meta carries no content key, so it can never decrypt.
		expect(ids(undecryptableRootDir, "sharedOut")).toEqual(["info", "unshare"])
	})

	it("unshare dispatches its own confirm dialog kind and is destructive-styled", () => {
		const descriptor = driveItemActions(sharedRootDirItem(), "sharedOut").find(d => d.id === "unshare")

		expect(descriptor).toMatchObject({ run: "dialog", dialogKind: "unshare", destructive: true, icon: UserMinusIcon })
	})

	it("unshare is the last action offered on a decryptable shared-root item, after info (sharedIn has no owner actions)", () => {
		const descriptors = ids(sharedRootFileItem(), "sharedIn")

		expect(descriptors).toEqual(["info", "download", "unshare"])
	})
})

// sharedIn/sharedOut expose only sharing-scoped + read-only actions — every owner-mutating
// action (rename/move/favorite/color/versions/publicLink/copyLink/trash) is gated off both surfaces
// regardless of root/nested item type. sharedIn because the caller doesn't own the item (the SDK would
// reject the mutation); sharedOut as a deliberate safe-subset even though the caller DOES own those
// items — the mutation would succeed but its cache patch downgrades the shared row (losing the
// "Shared with…" badge/Unshare until refetch) and move/link assume base arms. See isSharedVariant.
describe("driveItemActions — shared-surface safe subset (sharedIn/sharedOut)", () => {
	const OWNER_ONLY_IDS = ["rename", "move", "favorite", "color", "versions", "publicLink", "copyLink", "trash"]

	it("sharedIn root: exactly info + download + unshare", () => {
		expect(ids(sharedRootDirItem(), "sharedIn")).toEqual(["info", "download", "unshare"])
		expect(ids(sharedRootFileItem(), "sharedIn")).toEqual(["info", "download", "unshare"])
	})

	it("sharedIn nested: exactly info + download (unshare stays root-only)", () => {
		expect(ids(sharedDirItem(), "sharedIn")).toEqual(["info", "download"])
		expect(ids(sharedFileItem(), "sharedIn")).toEqual(["info", "download"])
	})

	it("sharedOut root: exactly info + download + share + unshare", () => {
		expect(ids(sharedRootDirItem(), "sharedOut")).toEqual(["info", "download", "share", "unshare"])
		expect(ids(sharedRootFileItem(), "sharedOut")).toEqual(["info", "download", "share", "unshare"])
	})

	it("sharedOut nested: exactly info + download + share (unshare stays root-only)", () => {
		expect(ids(sharedDirItem(), "sharedOut")).toEqual(["info", "download", "share"])
		expect(ids(sharedFileItem(), "sharedOut")).toEqual(["info", "download", "share"])
	})

	it("neither shared surface ever offers an owner-mutating action, root or nested", () => {
		const sharedItems = [sharedRootDirItem(), sharedRootFileItem(), sharedDirItem(), sharedFileItem()]

		for (const variant of ["sharedIn", "sharedOut"] as const) {
			for (const item of sharedItems) {
				expect(ids(item, variant).filter(id => OWNER_ONLY_IDS.includes(id))).toEqual([])
			}
		}
	})
})

// Download's single unifying ENABLED gate (mirrored in bulk-action-bar.logic.ts and the drive
// keymap): present on every decryptable, non-trash item, enabled unconditionally now that the
// service-worker zip path covers every dir/multi selection too. PRESENCE has its own separate
// exclusions — trash (see the trash-variant test above) and undecryptable (below). Both FSA states
// are still exercised here as documentation that isFsaAvailable's value no longer matters.
describe("driveItemActions — download gating (enabled unconditionally, transport-agnostic since the sw zip path)", () => {
	it("is present and enabled for a file, regardless of FSA availability", () => {
		const descriptor = driveItemActions(fileItem(), "drive").find(d => d.id === "download")

		expect(descriptor).toMatchObject({ run: "direct", enabled: true, icon: DownloadIcon })
	})

	it("is present and enabled for a directory on a non-FSA browser (isFsaAvailable false) — the sw zip route covers it", () => {
		isFsaAvailableMock.mockReturnValue(false)
		const descriptor = driveItemActions(dirItem(), "drive").find(d => d.id === "download")

		expect(descriptor).toMatchObject({ run: "direct", enabled: true })
	})

	it("is present and enabled for a directory when isFsaAvailable() is true", () => {
		isFsaAvailableMock.mockReturnValue(true)
		const descriptor = driveItemActions(dirItem(), "drive").find(d => d.id === "download")

		expect(descriptor).toMatchObject({ run: "direct", enabled: true })
	})

	it("is absent from the trash-reduced menu (mirrors bulk-bar/keymap's own trash exclusion)", () => {
		expect(ids(fileItem(), "trash")).not.toContain("download")
		expect(ids(dirItem(), "trash")).not.toContain("download")
	})

	it("is absent for an undecryptable item regardless of file/directory type", () => {
		const undecryptableFile = narrowItem(mockFile({ meta: { type: "encrypted", data: "ciphertext" } }))
		const undecryptableDir = narrowItem(mockDir({ meta: { type: "encrypted", data: "ciphertext" } }))

		expect(driveItemActions(undecryptableFile, "drive").find(d => d.id === "download")).toBeUndefined()
		expect(driveItemActions(undecryptableDir, "drive").find(d => d.id === "download")).toBeUndefined()
	})
})

// Every descriptor derived from ACTION_DEFS, pinned to its label + icon across the variants that
// surface it: drive dir (rename/move/favorite/color/info/download/share/publicLink/copyLink/trash),
// drive file (versions), trash (restore/deletePermanently), sharedOut root (unshare), plus the
// favorited-state toggle. A wrong entry in ACTION_DEFS or a mis-wired builder reference fails here.
describe("driveItemActions — descriptor label/icon facts (ACTION_DEFS drift guard)", () => {
	it("drive variant, directory: each descriptor carries its expected label and icon", () => {
		expect(facts(dirItem(), "drive")).toEqual([
			{ id: "rename", labelKey: "driveActionRename", icon: PencilIcon },
			{ id: "move", labelKey: "driveActionMove", icon: FolderInputIcon },
			{ id: "favorite", labelKey: "driveActionFavorite", icon: StarIcon },
			{ id: "color", labelKey: "driveActionColor", icon: PaletteIcon },
			{ id: "info", labelKey: "driveActionInfo", icon: InfoIcon },
			{ id: "download", labelKey: "driveActionDownload", icon: DownloadIcon },
			{ id: "share", labelKey: "driveActionShare", icon: UsersIcon },
			{ id: "publicLink", labelKey: "driveActionPublicLink", icon: LinkIcon },
			{ id: "copyLink", labelKey: "driveActionCopyLink", icon: CopyIcon },
			{ id: "trash", labelKey: "driveActionTrash", icon: Trash2Icon }
		])
	})

	it("drive variant, file: the versions descriptor carries its expected label and icon", () => {
		expect(facts(fileItem(), "drive")).toContainEqual({ id: "versions", labelKey: "driveActionVersions", icon: HistoryIcon })
	})

	it("favorited item: favorite toggles to the Unfavorite label and star-off icon", () => {
		expect(facts(dirItem({ favorited: true }), "drive")).toContainEqual({
			id: "favorite",
			labelKey: "driveActionUnfavorite",
			icon: StarOffIcon
		})
	})

	it("trash variant: restore/deletePermanently/info carry their expected labels and icons", () => {
		expect(facts(dirItem(), "trash")).toEqual([
			{ id: "restore", labelKey: "driveActionRestore", icon: RotateCcwIcon },
			{ id: "deletePermanently", labelKey: "driveActionDeletePermanently", icon: Trash2Icon },
			{ id: "info", labelKey: "driveActionInfo", icon: InfoIcon }
		])
	})

	it("sharedOut root: the unshare descriptor carries its expected label and icon", () => {
		expect(facts(sharedRootDirItem(), "sharedOut")).toContainEqual({
			id: "unshare",
			labelKey: "driveActionUnshare",
			icon: UserMinusIcon
		})
	})
})

describe("startItemDownload", () => {
	it("calls startDownloads with the item wrapped in a single-element array, synchronously (gesture-preserving)", () => {
		const item = fileItem()

		startItemDownload(item)

		expect(startDownloadsMock).toHaveBeenCalledWith([item])
	})
})
