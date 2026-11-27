// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { PaletteIcon, RotateCcwIcon, StarIcon, StarOffIcon, Trash2Icon, UserMinusIcon } from "lucide-react"
import { driveItemName } from "@filen/shared"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { mockDirItem, mockFileItem, mockSharedFile, mockSharedRootDir } from "@/tests/fixtures/sdk"
import { testUuid } from "@/tests/support/uuid"

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: Object.assign(toast, { success: toastSuccess, error: toastError, dismiss: vi.fn() }) }))

const { setFavoritedItemsMock, startDownloadsMock, toggleFavoriteMock, copyTextMock, toast, toastSuccess, toastError } = vi.hoisted(() => ({
	setFavoritedItemsMock: vi.fn(),
	startDownloadsMock: vi.fn(),
	toggleFavoriteMock: vi.fn(),
	copyTextMock: vi.fn(),
	toast: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn()
}))

vi.mock("@/features/drive/lib/actions", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/lib/actions")>()
	return { ...actual, setFavoritedItems: setFavoritedItemsMock }
})

vi.mock("@/features/drive/lib/download", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/lib/download")>()
	return { ...actual, startDownloads: startDownloadsMock }
})

vi.mock("@/features/drive/lib/favorite", () => ({ toggleItemFavorite: toggleFavoriteMock }))
vi.mock("@/lib/copyText", async importOriginal => {
	const actual = await importOriginal<typeof import("@/lib/copyText")>()
	return { ...actual, copyText: copyTextMock }
})

import "@/lib/i18n"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import {
	DRIVE_ACTION_SHORTCUTS,
	driveDeleteKeyTarget,
	driveSelectionActions,
	offersAction,
	type DriveActionDescriptor,
	type DriveActionId
} from "@/features/drive/lib/selectionActions"
import { runBulkFavorite, runDriveAction, type DriveActionHandlers } from "@/features/drive/lib/selectionDispatch"

beforeEach(() => {
	vi.clearAllMocks()
	useDriveStore.setState({ selectedItems: [] })
})

function file(name = "report.pdf", overrides: Parameters<typeof mockFileItem>[0] = {}): DriveItem {
	return mockFileItem({
		uuid: testUuid(`f-${name}`),
		meta: {
			type: "decoded",
			data: { name, mime: "application/octet-stream", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	})
}

function dir(name = "Documents", overrides: Parameters<typeof mockDirItem>[0] = {}): DriveItem {
	return mockDirItem({ uuid: testUuid(`d-${name}`), meta: { type: "decoded", data: { name } }, ...overrides })
}

function undecryptable(): DriveItem {
	return mockFileItem({ uuid: testUuid("undecryptable"), meta: { type: "encrypted", data: "ciphertext" } })
}

function ids(items: DriveItem[], variant: DriveVariant, options: { open?: boolean; isOnline?: boolean } = {}): DriveActionId[] {
	return driveSelectionActions(items, variant, { isOnline: true, ...options }).map(descriptor => descriptor.id)
}

const TWO_FILES = (): DriveItem[] => [file("a.pdf"), file("b.pdf")]

describe("driveSelectionActions — one item gets its own menu, several the selection's", () => {
	it("one file: the single-only entries (rename, versions, info, copy ID, public link) are there", () => {
		expect(ids([file()], "drive", { open: true })).toEqual([
			"open",
			"rename",
			"move",
			"copy",
			"compress",
			"favorite",
			"versions",
			"info",
			"copyId",
			"download",
			"share",
			"publicLink",
			"trash"
		])
	})

	it("one directory: Open, then Color in Versions' place", () => {
		expect(ids([dir()], "drive", { open: true })).toEqual([
			"open",
			"rename",
			"move",
			"copy",
			"compress",
			"favorite",
			"color",
			"info",
			"copyId",
			"download",
			"share",
			"publicLink",
			"trash"
		])
	})

	it("several files: the single-only entries are gone, the same order otherwise", () => {
		expect(ids(TWO_FILES(), "drive", { open: true })).toEqual(["move", "copy", "compress", "favorite", "download", "share", "trash"])
	})

	it("several directories: Color applies to all of them", () => {
		const descriptors = driveSelectionActions([dir("a"), dir("b")], "drive", { isOnline: true })

		expect(descriptors.map(descriptor => descriptor.id)).toEqual([
			"move",
			"copy",
			"compress",
			"favorite",
			"color",
			"download",
			"share",
			"trash"
		])
		expect(descriptors.find(descriptor => descriptor.id === "color")).toMatchObject({
			run: "dialog",
			dialogKind: "color",
			icon: PaletteIcon
		})
	})

	it("files and directories mixed: neither Color nor Versions", () => {
		expect(ids([file(), dir()], "drive")).toEqual(["move", "copy", "compress", "favorite", "download", "share", "trash"])
	})

	it("every one an archive: Extract leads, as the destination picker for several and the options dialog for one", () => {
		const several = driveSelectionActions([file("a.zip"), file("b.zip")], "drive", { isOnline: true })
		const one = driveSelectionActions([file("a.zip")], "drive", { isOnline: true })

		expect(several[0]).toMatchObject({ id: "extract", run: "dialog", dialogKind: "extractTo" })
		expect(one[0]).toMatchObject({ id: "extract", run: "dialog", dialogKind: "extract" })
		expect(ids([file("a.zip"), file("b.pdf")], "drive")).not.toContain("extract")
	})

	it("a playable song anywhere in the selection adds Add to playlist", () => {
		expect(ids([file("a.mp3"), file("b.pdf")], "drive")).toContain("addToPlaylist")
	})

	it("nothing selected offers nothing", () => {
		expect(ids([], "drive")).toEqual([])
	})
})

describe("driveSelectionActions — the trash", () => {
	it("one item restores directly and keeps Info and Copy ID", () => {
		const descriptors = driveSelectionActions([file()], "trash", { isOnline: true })

		expect(descriptors.map(descriptor => descriptor.id)).toEqual(["restore", "deletePermanently", "info", "copyId"])
		expect(descriptors[0]).toMatchObject({ run: "direct", icon: RotateCcwIcon })
	})

	it("several confirm the restore and delete, whatever they hold", () => {
		const descriptors = driveSelectionActions([file(), undecryptable()], "trash", { isOnline: true })

		expect(descriptors).toMatchObject([
			{ id: "restore", run: "dialog", dialogKind: "restoreSelected" },
			{ id: "deletePermanently", run: "dialog", dialogKind: "delete", destructive: true, icon: Trash2Icon }
		])
	})
})

describe("driveSelectionActions — links, shared views and undecryptable items", () => {
	it("Links: no Move, Copy link and Disable link for one, Disable link for several", () => {
		expect(ids([file()], "links")).toEqual([
			"rename",
			"copy",
			"compress",
			"favorite",
			"versions",
			"info",
			"copyId",
			"download",
			"share",
			"publicLink",
			"copyLink",
			"disableLink",
			"trash"
		])
		expect(ids(TWO_FILES(), "links")).toEqual(["copy", "compress", "favorite", "download", "share", "disableLink", "trash"])
	})

	it("Shared with me: read actions only, and Unshare for share roots", () => {
		expect(ids(TWO_FILES(), "sharedIn")).toEqual(["download", "copy", "compress"])

		const roots = [narrowItem(mockSharedRootDir()), narrowItem(mockSharedFile())]

		expect(ids(roots, "sharedIn")).toEqual(["download", "copy", "compress", "unshare"])
	})

	it("Shared by me: the owner set plus Unshare for share roots, which take no Color", () => {
		const roots = [narrowItem(mockSharedRootDir()), narrowItem(mockSharedFile())]
		const descriptors = driveSelectionActions(roots, "sharedOut", { isOnline: true })

		expect(descriptors.map(descriptor => descriptor.id)).toEqual([
			"move",
			"copy",
			"compress",
			"favorite",
			"download",
			"share",
			"trash",
			"unshare"
		])
		expect(descriptors.at(-1)).toMatchObject({ run: "dialog", dialogKind: "unshare", destructive: true, icon: UserMinusIcon })
	})

	it("an undecryptable item keeps only the uuid entries, alone or in a selection", () => {
		expect(ids([undecryptable()], "drive", { open: true })).toEqual(["info", "copyId", "trash"])
		expect(ids([file(), undecryptable()], "drive")).toEqual(["trash"])
		expect(ids([file(), undecryptable()], "links")).toEqual(["disableLink", "trash"])
	})
})

describe("driveSelectionActions — Favorite sets one state on a selection", () => {
	it("favorites when none is, unfavorites when any is", () => {
		const none = driveSelectionActions(TWO_FILES(), "drive", { isOnline: true }).find(descriptor => descriptor.id === "favorite")
		const some = driveSelectionActions([file("a"), file("b", { favorited: true })], "drive", { isOnline: true }).find(
			descriptor => descriptor.id === "favorite"
		)

		expect(none).toMatchObject({ labelKey: "driveActionFavorite", icon: StarIcon })
		expect(some).toMatchObject({ labelKey: "driveActionUnfavorite", icon: StarOffIcon })
	})
})

describe("driveSelectionActions — offline, keys and the bar's pinned set", () => {
	it("offline disables every network entry with the offline reason, alone or in a selection", () => {
		for (const items of [[file()], TWO_FILES()]) {
			const descriptors = driveSelectionActions(items, "drive", { isOnline: false })
			const enabled = descriptors.filter(descriptor => descriptor.enabled !== false).map(descriptor => descriptor.id)

			expect(enabled.filter(id => id !== "info" && id !== "copyId" && id !== "versions")).toEqual([])

			for (const descriptor of descriptors.filter(each => each.enabled === false)) {
				expect(descriptor.disabledReasonKey).toBe("common:offlineActionDisabled")
			}
		}
	})

	it("each entry carries the listing's key, Delete on whatever removes the selection here", () => {
		const descriptors = driveSelectionActions(TWO_FILES(), "drive", { isOnline: true, shortcuts: DRIVE_ACTION_SHORTCUTS })
		const kbd = Object.fromEntries(descriptors.map(descriptor => [descriptor.id, descriptor.kbdAction]))

		expect(kbd).toMatchObject({ move: "drive.move", copy: "drive.copyTo", compress: "drive.compress", trash: "drive.trash" })

		const links = driveSelectionActions(TWO_FILES(), "links", { isOnline: true, shortcuts: DRIVE_ACTION_SHORTCUTS })

		expect(links.find(descriptor => descriptor.id === "disableLink")?.kbdAction).toBe("drive.trash")
		expect(links.find(descriptor => descriptor.id === "trash")?.kbdAction).toBeUndefined()
	})

	it("pins Download, Share, Move, Copy, Favorite and Trash (Restore and Delete permanently in the trash)", () => {
		const pinned = (items: DriveItem[], variant: DriveVariant) =>
			driveSelectionActions(items, variant, { isOnline: true })
				.filter(descriptor => descriptor.pinned === true)
				.map(descriptor => descriptor.id)

		expect(pinned([dir()], "drive")).toEqual(["move", "copy", "favorite", "download", "share", "trash"])
		expect(pinned(TWO_FILES(), "drive")).toEqual(["move", "copy", "favorite", "download", "share", "trash"])
		expect(pinned(TWO_FILES(), "trash")).toEqual(["restore", "deletePermanently"])
	})

	it("offersAction finds only enabled entries", () => {
		expect(offersAction(driveSelectionActions(TWO_FILES(), "drive", { isOnline: false }), "trash")).toBeUndefined()
		expect(offersAction(driveSelectionActions(TWO_FILES(), "drive", { isOnline: true }), "trash")?.id).toBe("trash")
	})
})

describe("driveDeleteKeyTarget", () => {
	function target(items: DriveItem[], variant: DriveVariant) {
		return driveDeleteKeyTarget(driveSelectionActions(items, variant, { isOnline: true }))
	}

	it("trashes in the owned listings, alone or in a selection", () => {
		for (const variant of ["drive", "recents", "favorites"] as const) {
			expect(target(TWO_FILES(), variant), variant).toBe("trash")
			expect(target([file()], variant), variant).toBe("trash")
		}
	})

	it("stops a share at either shared root, trashes otherwise inside Shared by me, nothing in Shared with me", () => {
		const roots = [narrowItem(mockSharedRootDir()), narrowItem(mockSharedFile())]

		expect(target(roots, "sharedIn")).toBe("unshare")
		expect(target(roots, "sharedOut")).toBe("unshare")
		expect(target(TWO_FILES(), "sharedOut")).toBe("trash")
		expect(target(TWO_FILES(), "sharedIn")).toBeNull()
	})

	it("disables the link in Links and does nothing in the trash", () => {
		expect(target(TWO_FILES(), "links")).toBe("disableLink")
		expect(target([file()], "links")).toBe("disableLink")
		expect(target(TWO_FILES(), "trash")).toBeNull()
	})
})

describe("runDriveAction", () => {
	function handlers(overrides: Partial<DriveActionHandlers> = {}): DriveActionHandlers {
		return { variant: "drive", onDialogAction: vi.fn(), navigate: vi.fn(), ...overrides }
	}

	function descriptorFor(items: DriveItem[], id: DriveActionId, variant: DriveVariant = "drive"): DriveActionDescriptor {
		const descriptor = driveSelectionActions(items, variant, { isOnline: true, open: true }).find(each => each.id === id)

		if (descriptor === undefined) {
			throw new Error(`no ${id} descriptor`)
		}

		return descriptor
	}

	it("starts a download synchronously, without a dialog", () => {
		const items = TWO_FILES()
		const host = handlers()

		runDriveAction(descriptorFor(items, "download"), items, host)

		expect(startDownloadsMock).toHaveBeenCalledExactlyOnceWith(items)
		expect(host.onDialogAction).not.toHaveBeenCalled()
	})

	it("copies one item's uuid synchronously", () => {
		const item = file()

		runDriveAction(descriptorFor([item], "copyId"), [item], handlers())

		expect(copyTextMock).toHaveBeenCalledExactlyOnceWith(item.data.uuid, expect.any(String))
	})

	it("toggles one item's favorite and SETs a selection's", () => {
		const item = file()
		const items = TWO_FILES()
		setFavoritedItemsMock.mockResolvedValueOnce({ succeeded: [], failed: [] })

		runDriveAction(descriptorFor([item], "favorite"), [item], handlers())
		runDriveAction(descriptorFor(items, "favorite"), items, handlers())

		expect(toggleFavoriteMock).toHaveBeenCalledExactlyOnceWith(item, "drive", undefined)
		expect(setFavoritedItemsMock).toHaveBeenCalledExactlyOnceWith(items, true, expect.any(Function))
	})

	it("runs Open through the surface's own open", () => {
		const item = dir()
		const onOpen = vi.fn()

		runDriveAction(descriptorFor([item], "open"), [item], handlers({ onOpen }))

		expect(onOpen).toHaveBeenCalledOnce()
	})

	it("hands every dialog entry to the host on the items it was offered for", () => {
		const items = [dir("a"), dir("b")]
		const host = handlers()

		runDriveAction(descriptorFor(items, "color"), items, host)
		runDriveAction(descriptorFor(items, "trash"), items, host)
		runDriveAction(descriptorFor(items, "restore", "trash"), items, host)

		expect(host.onDialogAction).toHaveBeenNthCalledWith(1, "color", items)
		expect(host.onDialogAction).toHaveBeenNthCalledWith(2, "trash", items)
		expect(host.onDialogAction).toHaveBeenNthCalledWith(3, "restoreSelected", items)
	})

	it("leaves the submenu entries to their submenus", () => {
		const items = [file("a.mp3")]
		const host = handlers()

		runDriveAction(descriptorFor(items, "addToPlaylist"), items, host)

		expect(host.onDialogAction).not.toHaveBeenCalled()
	})
})

describe("runBulkFavorite", () => {
	it("applies the SET target !includesFavorited to every item", async () => {
		const mixed = [file("a", { favorited: true }), file("b")]
		setFavoritedItemsMock.mockResolvedValueOnce({ succeeded: [], failed: [] })

		await runBulkFavorite(mixed)

		expect(setFavoritedItemsMock).toHaveBeenCalledExactlyOnceWith(mixed, false, expect.any(Function))
	})

	it("prunes only succeeded uuids from the selection", async () => {
		const ok = file("ok")
		const bad = file("bad")
		useDriveStore.setState({ selectedItems: [ok, bad] })
		setFavoritedItemsMock.mockResolvedValueOnce({
			succeeded: [ok],
			failed: [{ item: bad, dto: { species: "plain", message: "no", label: "no" } }]
		})

		await runBulkFavorite([ok, bad])

		expect(useDriveStore.getState().selectedItems.map(item => item.data.uuid)).toEqual([bad.data.uuid])
	})

	it("runs as an activity in the words of the SET it applies", async () => {
		const item = file("fav", { favorited: true })
		setFavoritedItemsMock.mockResolvedValueOnce({ succeeded: [item], failed: [] })

		await runBulkFavorite([item])

		expect(toastSuccess).toHaveBeenCalledExactlyOnceWith(`Removed ${driveItemName(item)} from favorites`, expect.anything())
		expect(toast).toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})
})
