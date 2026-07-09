import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, DirPublicLinkRW, File, FilePublicLink, FileVersion, UserInfo, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import type { ErrorDTO } from "@/lib/sdk/errors"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest — mock it down
// to the ops these helpers call, mirroring queries/drive.test.ts's mock boundary.
const {
	renameDirectory,
	renameFile,
	moveDirectory,
	moveFile,
	trashDirectory,
	trashFile,
	restoreDirectory,
	restoreFile,
	deleteDirectoryPermanently,
	deleteFilePermanently,
	emptyTrashOp,
	setFavorited,
	setDirectoryColor,
	restoreFileVersionOp,
	deleteFileVersionOp,
	createDirectoryLink,
	createFileLink,
	updateDirectoryLink,
	updateFileLink,
	removeDirectoryLink,
	removeFileLink
} = vi.hoisted(() => ({
	renameDirectory: vi.fn(),
	renameFile: vi.fn(),
	moveDirectory: vi.fn(),
	moveFile: vi.fn(),
	trashDirectory: vi.fn(),
	trashFile: vi.fn(),
	restoreDirectory: vi.fn(),
	restoreFile: vi.fn(),
	deleteDirectoryPermanently: vi.fn(),
	deleteFilePermanently: vi.fn(),
	emptyTrashOp: vi.fn(),
	setFavorited: vi.fn(),
	setDirectoryColor: vi.fn(),
	restoreFileVersionOp: vi.fn(),
	deleteFileVersionOp: vi.fn(),
	createDirectoryLink: vi.fn(),
	createFileLink: vi.fn(),
	updateDirectoryLink: vi.fn(),
	updateFileLink: vi.fn(),
	removeDirectoryLink: vi.fn(),
	removeFileLink: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		renameDirectory,
		renameFile,
		moveDirectory,
		moveFile,
		trashDirectory,
		trashFile,
		restoreDirectory,
		restoreFile,
		deleteDirectoryPermanently,
		deleteFilePermanently,
		emptyTrash: emptyTrashOp,
		setFavorited,
		setDirectoryColor,
		restoreFileVersionOp,
		deleteFileVersionOp,
		createDirectoryLink,
		createFileLink,
		updateDirectoryLink,
		updateFileLink,
		removeDirectoryLink,
		removeFileLink
	}
}))

// A bare, unconfigured QueryClient stands in for the real singleton — same rationale as
// queries/drive.test.ts: these helpers only need genuine setQueryData/getQueryData cache mechanics,
// never the production client's OPFS-backed persistence pipeline.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { driveItemLinkStatusQueryKey, driveListingQueryKey, driveNamesQueryKey } from "@/features/drive/queries/drive"
import {
	createLink,
	deleteItemsPermanently,
	deleteVersion,
	disableLink,
	emptyTrash,
	moveItems,
	renameItem,
	restoreItems,
	restoreVersion,
	setColor,
	setFavoritedItems,
	toggleFavorite,
	trashItems,
	updateLink,
	type DirectoryItem,
	type FileItem
} from "@/features/drive/lib/actions"

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
})

// UuidStr is a template-literal brand requiring at least 3 dashes — pad a short readable test label
// into a shape that satisfies it, mirroring queries/drive.test.ts's own fixture.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const ROOT_UUID = testUuid("root")
const OTHER_PARENT_UUID = testUuid("other-parent")

function seedRootUuid(uuid: UuidStr = ROOT_UUID): void {
	testQueryClient.setQueryData<UserInfo>(ACCOUNT_QUERY_KEY, { rootDirUuid: uuid } as UserInfo)
}

function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: testUuid("dir"),
		parent: OTHER_PARENT_UUID,
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("file"),
		parent: OTHER_PARENT_UUID,
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

function dirItem(overrides: Partial<Dir> = {}): DirectoryItem {
	const item = narrowItem(mockDir(overrides))
	if (item.type !== "directory") {
		throw new Error("expected a directory arm")
	}
	return item
}

function fileItem(overrides: Partial<File> = {}): FileItem {
	const item = narrowItem(mockFile(overrides))
	if (item.type !== "file") {
		throw new Error("expected a file arm")
	}
	return item
}

function mockVersion(overrides: Partial<FileVersion> = {}): FileVersion {
	return {
		bucket: "filen-1",
		region: "de-1",
		chunks: 1n,
		size: 512n,
		metadata: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_600_000_000_000n, size: 512n, key: "old-key", version: 2 }
		},
		timestamp: 1_600_000_000_000n,
		uuid: testUuid("version"),
		...overrides
	}
}

function mockDirLink(overrides: Partial<DirPublicLinkRW> = {}): DirPublicLinkRW {
	return {
		linkUuid: testUuid("dir-link"),
		linkKey: "dir-link-key",
		linkKeyVersion: 1,
		password: { type: "none" },
		expiration: "never",
		enableDownload: true,
		salt: "dir-salt",
		...overrides
	}
}

function mockFileLink(overrides: Partial<FilePublicLink> = {}): FilePublicLink {
	return {
		linkUuid: testUuid("file-link"),
		password: { type: "none" },
		expiration: "never",
		downloadable: true,
		salt: "file-salt",
		...overrides
	}
}

// Worker-boundary errors arrive as plain DTOs (the Comlink proxy throws toErrorDTO output) — mirrors
// createDirectory.test.ts's sdkDto fixture.
function sdkDto(kind: string): ErrorDTO {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

function driveListing(uuid: string | null) {
	return driveListingQueryKey({ variant: "drive", uuid })
}

function trashListing() {
	return driveListingQueryKey({ variant: "trash", uuid: null })
}

function favoritesListing() {
	return driveListingQueryKey({ variant: "favorites", uuid: null })
}

describe("renameItem", () => {
	it("renames a directory, upserts the patched listing (root-normalized), and invalidates the names cache", async () => {
		seedRootUuid()
		const invalidateSpy = vi.spyOn(testQueryClient, "invalidateQueries")
		const original = dirItem({ uuid: testUuid("a"), parent: ROOT_UUID, meta: { type: "decoded", data: { name: "Old" } } })
		testQueryClient.setQueryData(driveListing(null), [original])
		renameDirectory.mockResolvedValueOnce(
			mockDir({ uuid: testUuid("a"), parent: ROOT_UUID, meta: { type: "decoded", data: { name: "New" } } })
		)

		const outcome = await renameItem(original, "New")

		expect(outcome.status).toBe("success")
		expect(renameDirectory).toHaveBeenCalledExactlyOnceWith(original.data, "New")
		const patched = testQueryClient.getQueryData<DriveItem[]>(driveListing(null))
		expect(patched).toHaveLength(1)
		expect(patched?.[0]?.data.decryptedMeta?.name).toBe("New")
		expect(invalidateSpy).toHaveBeenCalledExactlyOnceWith({ queryKey: ["drive", "names"] })
	})

	it("renames a file via renameFile, not renameDirectory", async () => {
		seedRootUuid()
		const original = fileItem({ uuid: testUuid("f"), parent: OTHER_PARENT_UUID })
		renameFile.mockResolvedValueOnce(
			mockFile({
				uuid: testUuid("f"),
				parent: OTHER_PARENT_UUID,
				meta: {
					type: "decoded",
					data: { name: "renamed.pdf", mime: "application/pdf", modified: 1n, size: 1n, key: "k", version: 2 }
				}
			})
		)

		const outcome = await renameItem(original, "renamed.pdf")

		expect(outcome.status).toBe("success")
		expect(renameFile).toHaveBeenCalledExactlyOnceWith(original.data, "renamed.pdf")
		expect(moveDirectory).not.toHaveBeenCalled()
	})

	it("replaces (not duplicates) a stale cached row on the item's own uuid", async () => {
		seedRootUuid()
		const stale = dirItem({ uuid: testUuid("a"), parent: OTHER_PARENT_UUID, favorited: false })
		const sibling = dirItem({
			uuid: testUuid("sibling"),
			parent: OTHER_PARENT_UUID,
			meta: { type: "decoded", data: { name: "Sibling" } }
		})
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [stale, sibling])
		renameDirectory.mockResolvedValueOnce(mockDir({ uuid: testUuid("a"), parent: OTHER_PARENT_UUID, favorited: true }))

		await renameItem(stale, "Renamed")

		const patched = testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))
		expect(patched).toHaveLength(2)
		expect(patched?.find(i => i.data.uuid === testUuid("a"))?.data.favorited).toBe(true)
	})

	it("returns an error outcome without patching the listing or invalidating names on rejection", async () => {
		seedRootUuid()
		const invalidateSpy = vi.spyOn(testQueryClient, "invalidateQueries")
		const original = dirItem({ uuid: testUuid("a"), parent: OTHER_PARENT_UUID })
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [original])
		const dto = sdkDto("DirRenameFileExists")
		renameDirectory.mockRejectedValueOnce(dto)

		const outcome = await renameItem(original, "New")

		expect(outcome).toEqual({ status: "error", dto })
		expect(testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))).toEqual([original])
		expect(invalidateSpy).not.toHaveBeenCalled()
	})

	it("normalizes a plain Error rejection through asErrorDTO", async () => {
		seedRootUuid()
		const original = fileItem({ uuid: testUuid("f") })
		renameFile.mockRejectedValueOnce(new Error("network lost"))

		const outcome = await renameItem(original, "New")

		expect(outcome).toEqual({ status: "error", dto: { species: "plain", message: "network lost", label: "network lost" } })
	})

	// A rename never changes listing membership (same uuid, same parent) — unlike the narrow
	// per-parent patch this replaces, a global replace-in-place also reaches a favorited/recent copy
	// of the same item cached under a different listing key.
	it("fans a rename out to every cached listing the item appears in, including favorites", async () => {
		seedRootUuid()
		const original = dirItem({ uuid: testUuid("a"), parent: OTHER_PARENT_UUID, meta: { type: "decoded", data: { name: "Old" } } })
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [original])
		testQueryClient.setQueryData(favoritesListing(), [original])
		renameDirectory.mockResolvedValueOnce(
			mockDir({ uuid: testUuid("a"), parent: OTHER_PARENT_UUID, meta: { type: "decoded", data: { name: "New" } } })
		)

		await renameItem(original, "New")

		const parentListing = testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))
		const favorites = testQueryClient.getQueryData<DriveItem[]>(favoritesListing())
		expect(parentListing?.[0]?.data.decryptedMeta?.name).toBe("New")
		expect(favorites?.[0]?.data.decryptedMeta?.name).toBe("New")
	})

	it("still resolves a success outcome even when the background names-cache invalidation rejects", async () => {
		seedRootUuid()
		const original = dirItem({ uuid: testUuid("a"), parent: OTHER_PARENT_UUID })
		renameDirectory.mockResolvedValueOnce(mockDir({ uuid: testUuid("a"), parent: OTHER_PARENT_UUID }))
		// renameItem deliberately doesn't await this (fire-and-forget) — the inline catch below only
		// defuses the test process's own unhandledRejection reporting for this discarded promise, it
		// does not give renameItem itself a handler.
		vi.spyOn(testQueryClient, "invalidateQueries").mockImplementationOnce(() => {
			const rejected = Promise.reject(new Error("names invalidation failed"))
			rejected.catch(() => undefined)
			return rejected
		})

		const outcome = await renameItem(original, "New")

		expect(outcome.status).toBe("success")
	})
})

describe("moveItems", () => {
	it("moves a single directory: removes it from the old parent's listing, upserts it into the new one", async () => {
		seedRootUuid()
		const item = dirItem({ uuid: testUuid("a"), parent: OTHER_PARENT_UUID })
		const sibling = dirItem({ uuid: testUuid("sibling"), parent: OTHER_PARENT_UUID })
		const targetUuid = testUuid("target")
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [item, sibling])
		testQueryClient.setQueryData(driveListing(targetUuid), [])
		moveDirectory.mockResolvedValueOnce(mockDir({ uuid: testUuid("a"), parent: targetUuid }))

		const result = await moveItems([item], targetUuid)

		expect(result.succeeded).toEqual([item])
		expect(result.failed).toEqual([])
		expect(moveDirectory).toHaveBeenCalledExactlyOnceWith(item.data, targetUuid)
		expect(testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))).toEqual([sibling])
		expect(testQueryClient.getQueryData<DriveItem[]>(driveListing(targetUuid))?.map(i => i.data.uuid)).toEqual([testUuid("a")])
	})

	it("root-normalizes both ends: moving out of the drive root and into it", async () => {
		seedRootUuid()
		const item = dirItem({ uuid: testUuid("a"), parent: ROOT_UUID })
		testQueryClient.setQueryData(driveListing(null), [item])
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [])
		moveDirectory.mockResolvedValueOnce(mockDir({ uuid: testUuid("a"), parent: OTHER_PARENT_UUID }))

		await moveItems([item], OTHER_PARENT_UUID)

		expect(testQueryClient.getQueryData<DriveItem[]>(driveListing(null))).toEqual([])
		expect(testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))?.map(i => i.data.uuid)).toEqual([testUuid("a")])

		// Moving a second item back to the root: targetParentUuid null must land on the SAME null-keyed
		// key as the root-normalized real uuid above, not a literal "null" segment.
		const second = dirItem({ uuid: testUuid("b"), parent: OTHER_PARENT_UUID })
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [second])
		moveDirectory.mockResolvedValueOnce(mockDir({ uuid: testUuid("b"), parent: ROOT_UUID }))

		await moveItems([second], null)

		expect(testQueryClient.getQueryData<DriveItem[]>(driveListing(null))?.map(i => i.data.uuid)).toEqual([testUuid("b")])
	})

	it("moves a file via moveFile, not moveDirectory", async () => {
		seedRootUuid()
		const item = fileItem({ uuid: testUuid("f"), parent: OTHER_PARENT_UUID })
		moveFile.mockResolvedValueOnce(mockFile({ uuid: testUuid("f"), parent: testUuid("target") }))

		await moveItems([item], testUuid("target"))

		expect(moveFile).toHaveBeenCalledExactlyOnceWith(item.data, testUuid("target"))
		expect(moveDirectory).not.toHaveBeenCalled()
	})

	it("partial success: one item moves, a sibling's rejection lands in failed without aborting or undoing the first", async () => {
		seedRootUuid()
		const ok = dirItem({ uuid: testUuid("ok"), parent: OTHER_PARENT_UUID })
		const bad = dirItem({ uuid: testUuid("bad"), parent: OTHER_PARENT_UUID })
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [ok, bad])
		const targetUuid = testUuid("target")
		testQueryClient.setQueryData(driveListing(targetUuid), [])
		const dto = sdkDto("MoveIntoSelf")
		// items.map dispatches synchronously in array order (each callback's first `await` is the
		// moveDirectory call itself), so [ok, bad] queues these two outcomes in the same order.
		moveDirectory.mockResolvedValueOnce(mockDir({ uuid: testUuid("ok"), parent: targetUuid })).mockRejectedValueOnce(dto)

		const result = await moveItems([ok, bad], targetUuid)

		expect(result.succeeded).toEqual([ok])
		expect(result.failed).toEqual([{ item: bad, error: dto }])
		const oldParent = testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))
		expect(oldParent?.map(i => i.data.uuid)).toEqual([testUuid("bad")]) // only the failed one remains
		expect(testQueryClient.getQueryData<DriveItem[]>(driveListing(targetUuid))?.map(i => i.data.uuid)).toEqual([testUuid("ok")])
	})

	it("resolves to an empty split on an empty selection without calling the worker", async () => {
		seedRootUuid()

		const result = await moveItems([], testUuid("target"))

		expect(result).toEqual({ succeeded: [], failed: [] })
		expect(moveDirectory).not.toHaveBeenCalled()
		expect(moveFile).not.toHaveBeenCalled()
	})
})

describe("trashItems", () => {
	it("removes the item from every listing it was cached in — drive, favorites, and a differently-scoped drive listing", async () => {
		const item = dirItem({ uuid: testUuid("a") })
		const other = dirItem({ uuid: testUuid("other") })
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [item, other])
		testQueryClient.setQueryData(favoritesListing(), [item])
		testQueryClient.setQueryData(driveListing(null), [item])
		trashDirectory.mockResolvedValueOnce(mockDir({ uuid: testUuid("a"), parent: "trash" }))

		const result = await trashItems([item])

		expect(result.succeeded).toEqual([item])
		expect(testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))).toEqual([other])
		expect(testQueryClient.getQueryData<DriveItem[]>(favoritesListing())).toEqual([])
		expect(testQueryClient.getQueryData<DriveItem[]>(driveListing(null))).toEqual([])
	})

	it("never optimistically adds the trashed item to the trash listing itself", async () => {
		const item = fileItem({ uuid: testUuid("f") })
		testQueryClient.setQueryData(trashListing(), [])
		trashFile.mockResolvedValueOnce(mockFile({ uuid: testUuid("f") }))

		await trashItems([item])

		expect(testQueryClient.getQueryData<DriveItem[]>(trashListing())).toEqual([])
	})

	it("trashes a file via trashFile, not trashDirectory", async () => {
		const item = fileItem({ uuid: testUuid("f") })
		trashFile.mockResolvedValueOnce(mockFile({ uuid: testUuid("f") }))

		await trashItems([item])

		expect(trashFile).toHaveBeenCalledExactlyOnceWith(item.data)
		expect(trashDirectory).not.toHaveBeenCalled()
	})

	it("a rejected item is reported as failed and stays wherever it was cached", async () => {
		const item = dirItem({ uuid: testUuid("a") })
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [item])
		const dto = sdkDto("Forbidden")
		trashDirectory.mockRejectedValueOnce(dto)

		const result = await trashItems([item])

		expect(result.failed).toEqual([{ item, error: dto }])
		expect(testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))).toEqual([item])
	})
})

describe("restoreItems", () => {
	it("moves the item from the trash listing into its restored (root-normalized) destination — no self-clobber", async () => {
		seedRootUuid()
		const trashed = dirItem({ uuid: testUuid("a") })
		const siblingInTrash = dirItem({ uuid: testUuid("sibling") })
		testQueryClient.setQueryData(trashListing(), [trashed, siblingInTrash])
		testQueryClient.setQueryData(driveListing(null), [])
		restoreDirectory.mockResolvedValueOnce(mockDir({ uuid: testUuid("a"), parent: ROOT_UUID }))

		const result = await restoreItems([trashed])

		expect(result.succeeded).toEqual([trashed])
		expect(testQueryClient.getQueryData<DriveItem[]>(trashListing())).toEqual([siblingInTrash])
		const destination = testQueryClient.getQueryData<DriveItem[]>(driveListing(null))
		expect(destination?.map(i => i.data.uuid)).toEqual([testUuid("a")]) // present, not stripped back out
	})

	it("restores a file via restoreFile, not restoreDirectory", async () => {
		const item = fileItem({ uuid: testUuid("f") })
		restoreFile.mockResolvedValueOnce(mockFile({ uuid: testUuid("f"), parent: OTHER_PARENT_UUID }))

		await restoreItems([item])

		expect(restoreFile).toHaveBeenCalledExactlyOnceWith(item.data)
		expect(restoreDirectory).not.toHaveBeenCalled()
	})

	it("a failed restore is reported without touching either listing", async () => {
		const trashed = dirItem({ uuid: testUuid("a") })
		testQueryClient.setQueryData(trashListing(), [trashed])
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [])
		const dto = sdkDto("NotFound")
		restoreDirectory.mockRejectedValueOnce(dto)

		const result = await restoreItems([trashed])

		expect(result.failed).toEqual([{ item: trashed, error: dto }])
		expect(testQueryClient.getQueryData<DriveItem[]>(trashListing())).toEqual([trashed])
	})
})

describe("deleteItemsPermanently", () => {
	it("removes the item from every cached listing globally", async () => {
		const item = fileItem({ uuid: testUuid("f") })
		const other = fileItem({ uuid: testUuid("other") })
		testQueryClient.setQueryData(trashListing(), [item, other])
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [item])
		deleteFilePermanently.mockResolvedValueOnce(undefined)

		const result = await deleteItemsPermanently([item])

		expect(result.succeeded).toEqual([item])
		expect(testQueryClient.getQueryData<DriveItem[]>(trashListing())).toEqual([other])
		expect(testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))).toEqual([])
	})

	it("deletes a directory via deleteDirectoryPermanently, not deleteFilePermanently", async () => {
		const item = dirItem({ uuid: testUuid("a") })
		deleteDirectoryPermanently.mockResolvedValueOnce(undefined)

		await deleteItemsPermanently([item])

		expect(deleteDirectoryPermanently).toHaveBeenCalledExactlyOnceWith(item.data)
		expect(deleteFilePermanently).not.toHaveBeenCalled()
	})

	it("a failed delete is reported without removing the item from its listing", async () => {
		const item = dirItem({ uuid: testUuid("a") })
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [item])
		const dto = sdkDto("Forbidden")
		deleteDirectoryPermanently.mockRejectedValueOnce(dto)

		const result = await deleteItemsPermanently([item])

		expect(result.failed).toEqual([{ item, error: dto }])
		expect(testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))).toEqual([item])
	})
})

describe("emptyTrash", () => {
	it("clears only the trash listing's exact key, leaving other variants untouched", async () => {
		const trashedItem = dirItem({ uuid: testUuid("a") })
		const driveItemFixture = dirItem({ uuid: testUuid("b") })
		testQueryClient.setQueryData(trashListing(), [trashedItem])
		testQueryClient.setQueryData(driveListing(null), [driveItemFixture])
		testQueryClient.setQueryData(favoritesListing(), [driveItemFixture])
		emptyTrashOp.mockResolvedValueOnce(undefined)

		const outcome = await emptyTrash()

		expect(outcome).toEqual({ status: "success" })
		expect(testQueryClient.getQueryData(trashListing())).toEqual([])
		expect(testQueryClient.getQueryData(driveListing(null))).toEqual([driveItemFixture])
		expect(testQueryClient.getQueryData(favoritesListing())).toEqual([driveItemFixture])
	})

	it("returns an error outcome and leaves the trash listing untouched on rejection", async () => {
		const trashedItem = dirItem({ uuid: testUuid("a") })
		testQueryClient.setQueryData(trashListing(), [trashedItem])
		const dto = sdkDto("Forbidden")
		emptyTrashOp.mockRejectedValueOnce(dto)

		const outcome = await emptyTrash()

		expect(outcome).toEqual({ status: "error", dto })
		expect(testQueryClient.getQueryData(trashListing())).toEqual([trashedItem])
	})
})

describe("toggleFavorite", () => {
	it("favoriting adds the item to the favorites listing and flips the flag everywhere else it's cached", async () => {
		const item = dirItem({ uuid: testUuid("a"), favorited: false })
		const other = dirItem({ uuid: testUuid("other"), favorited: false })
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [item, other])
		testQueryClient.setQueryData(favoritesListing(), [])
		setFavorited.mockResolvedValueOnce({ type: "dir", ...mockDir({ uuid: testUuid("a"), favorited: true }) })

		const outcome = await toggleFavorite(item)

		expect(outcome.status).toBe("success")
		expect(setFavorited).toHaveBeenCalledExactlyOnceWith(item.data, true)
		expect(
			testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))?.find(i => i.data.uuid === testUuid("a"))?.data
				.favorited
		).toBe(true)
		expect(
			testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))?.find(i => i.data.uuid === testUuid("other"))?.data
				.favorited
		).toBe(false)
		expect(testQueryClient.getQueryData<DriveItem[]>(favoritesListing())?.map(i => i.data.uuid)).toEqual([testUuid("a")])
	})

	it("unfavoriting removes the item from the favorites listing", async () => {
		const item = dirItem({ uuid: testUuid("a"), favorited: true })
		const other = dirItem({ uuid: testUuid("other"), favorited: true })
		testQueryClient.setQueryData(favoritesListing(), [item, other])
		setFavorited.mockResolvedValueOnce({ type: "dir", ...mockDir({ uuid: testUuid("a"), favorited: false }) })

		await toggleFavorite(item)

		expect(setFavorited).toHaveBeenCalledExactlyOnceWith(item.data, false)
		expect(testQueryClient.getQueryData<DriveItem[]>(favoritesListing())?.map(i => i.data.uuid)).toEqual([testUuid("other")])
	})

	it("never conjures the favorites listing into existence when it has not been fetched yet", async () => {
		const item = fileItem({ uuid: testUuid("f"), favorited: false })
		setFavorited.mockResolvedValueOnce({ type: "file", ...mockFile({ uuid: testUuid("f"), favorited: true }) })

		await toggleFavorite(item)

		expect(testQueryClient.getQueryData(favoritesListing())).toBeUndefined()
	})

	it("works on a file via the tagged file arm", async () => {
		const item = fileItem({ uuid: testUuid("f"), favorited: false })
		setFavorited.mockResolvedValueOnce({ type: "file", ...mockFile({ uuid: testUuid("f"), favorited: true }) })

		const outcome = await toggleFavorite(item)

		expect(outcome.status).toBe("success")
		if (outcome.status === "success") {
			expect(outcome.item.type).toBe("file")
		}
	})

	it("returns an error outcome without patching any listing on rejection", async () => {
		const item = dirItem({ uuid: testUuid("a"), favorited: false })
		testQueryClient.setQueryData(favoritesListing(), [])
		const dto = sdkDto("Forbidden")
		setFavorited.mockRejectedValueOnce(dto)

		const outcome = await toggleFavorite(item)

		expect(outcome).toEqual({ status: "error", dto })
		expect(testQueryClient.getQueryData(favoritesListing())).toEqual([])
	})

	// Favorites aggregates across every directory (unlike every other upsert call site, which targets
	// a single drive-parent where the backend already enforces name-uniqueness) — two distinct items
	// from different parents legitimately share a name, so the add path must dedup on uuid alone.
	it("favoriting a same-named item does not evict other distinct-uuid favorites sharing that name from a different directory", async () => {
		const sharedMeta = {
			type: "decoded" as const,
			data: { name: "budget.xlsx", mime: "application/pdf", modified: 1n, size: 1n, key: "k", version: 2 as const }
		}
		const favoriteFromDirA = fileItem({ uuid: testUuid("fav-a"), parent: testUuid("dir-a"), favorited: true, meta: sharedMeta })
		const favoriteFromDirB = fileItem({ uuid: testUuid("fav-b"), parent: testUuid("dir-b"), favorited: true, meta: sharedMeta })
		testQueryClient.setQueryData(favoritesListing(), [favoriteFromDirA, favoriteFromDirB])
		const incoming = fileItem({ uuid: testUuid("fav-c"), parent: testUuid("dir-c"), favorited: false, meta: sharedMeta })
		setFavorited.mockResolvedValueOnce({
			type: "file",
			...mockFile({ uuid: testUuid("fav-c"), parent: testUuid("dir-c"), favorited: true, meta: sharedMeta })
		})

		await toggleFavorite(incoming)

		const favorites = testQueryClient.getQueryData<DriveItem[]>(favoritesListing())
		expect(favorites?.map(i => i.data.uuid).sort()).toEqual([testUuid("fav-a"), testUuid("fav-b"), testUuid("fav-c")].sort())
	})
})

describe("setFavoritedItems", () => {
	it("sets favorited=true on every item — a SET, not a per-item toggle — and patches each into the favorites listing", async () => {
		const a = dirItem({ uuid: testUuid("a"), favorited: false })
		const b = fileItem({ uuid: testUuid("b"), favorited: false })
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [a, b])
		testQueryClient.setQueryData(favoritesListing(), [])
		setFavorited.mockResolvedValueOnce({ type: "dir", ...mockDir({ uuid: testUuid("a"), favorited: true }) })
		setFavorited.mockResolvedValueOnce({ type: "file", ...mockFile({ uuid: testUuid("b"), favorited: true }) })

		const result = await setFavoritedItems([a, b], true)

		expect(result.succeeded).toHaveLength(2)
		expect(result.failed).toEqual([])
		expect(setFavorited).toHaveBeenCalledWith(a.data, true)
		expect(setFavorited).toHaveBeenCalledWith(b.data, true)
		expect(testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))?.map(i => i.data.favorited)).toEqual([true, true])
		expect(
			testQueryClient
				.getQueryData<DriveItem[]>(favoritesListing())
				?.map(i => i.data.uuid)
				.sort()
		).toEqual([testUuid("a"), testUuid("b")].sort())
	})

	it("sets favorited=false on every item regardless of each item's own current flag — the bar always passes an explicit target", async () => {
		const a = dirItem({ uuid: testUuid("a"), favorited: true })
		const b = fileItem({ uuid: testUuid("b"), favorited: true })
		testQueryClient.setQueryData(favoritesListing(), [a, b])
		setFavorited.mockResolvedValueOnce({ type: "dir", ...mockDir({ uuid: testUuid("a"), favorited: false }) })
		setFavorited.mockResolvedValueOnce({ type: "file", ...mockFile({ uuid: testUuid("b"), favorited: false }) })

		await setFavoritedItems([a, b], false)

		expect(setFavorited).toHaveBeenCalledWith(a.data, false)
		expect(setFavorited).toHaveBeenCalledWith(b.data, false)
		expect(testQueryClient.getQueryData<DriveItem[]>(favoritesListing())).toEqual([])
	})

	it("partial success: one item's rejection lands in failed without aborting or undoing the other's patch", async () => {
		const ok = dirItem({ uuid: testUuid("ok"), favorited: false })
		const bad = dirItem({ uuid: testUuid("bad"), favorited: false })
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [ok, bad])
		testQueryClient.setQueryData(favoritesListing(), [])
		const dto = sdkDto("Forbidden")
		// items.map dispatches synchronously in array order (each callback's first `await` is the
		// setFavorited call itself), so [ok, bad] queues these two outcomes in the same order.
		setFavorited
			.mockResolvedValueOnce({ type: "dir", ...mockDir({ uuid: testUuid("ok"), favorited: true }) })
			.mockRejectedValueOnce(dto)

		const result = await setFavoritedItems([ok, bad], true)

		expect(result.succeeded).toEqual([ok])
		expect(result.failed).toEqual([{ item: bad, error: dto }])
		expect(
			testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))?.find(i => i.data.uuid === testUuid("ok"))?.data
				.favorited
		).toBe(true)
		expect(
			testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))?.find(i => i.data.uuid === testUuid("bad"))?.data
				.favorited
		).toBe(false)
		expect(testQueryClient.getQueryData<DriveItem[]>(favoritesListing())?.map(i => i.data.uuid)).toEqual([testUuid("ok")])
	})

	it("resolves to an empty split on an empty selection without calling the worker", async () => {
		const result = await setFavoritedItems([], true)

		expect(result).toEqual({ succeeded: [], failed: [] })
		expect(setFavorited).not.toHaveBeenCalled()
	})

	it("leaves toggleFavorite's own per-item behavior unaffected (still derives the target from the item's current flag)", async () => {
		const item = dirItem({ uuid: testUuid("a"), favorited: false })
		setFavorited.mockResolvedValueOnce({ type: "dir", ...mockDir({ uuid: testUuid("a"), favorited: true }) })

		await toggleFavorite(item)

		expect(setFavorited).toHaveBeenCalledExactlyOnceWith(item.data, true)
	})
})

describe("setColor", () => {
	it("recolors a directory and refreshes it wherever it is cached, without adding it to listings that never had it", async () => {
		const dir = dirItem({ uuid: testUuid("a"), color: "default" })
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [dir])
		testQueryClient.setQueryData(trashListing(), []) // never held this directory
		setDirectoryColor.mockResolvedValueOnce(mockDir({ uuid: testUuid("a"), color: "blue" }))

		const outcome = await setColor(dir, "blue")

		expect(outcome.status).toBe("success")
		expect(setDirectoryColor).toHaveBeenCalledExactlyOnceWith(dir.data, "blue")
		expect(
			testQueryClient
				.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))
				?.find((i): i is DirectoryItem => i.type === "directory")?.data.color
		).toBe("blue")
		expect(testQueryClient.getQueryData<DriveItem[]>(trashListing())).toEqual([])
	})

	it("returns an error outcome without patching on rejection", async () => {
		const dir = dirItem({ uuid: testUuid("a"), color: "default" })
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [dir])
		const dto = sdkDto("Forbidden")
		setDirectoryColor.mockRejectedValueOnce(dto)

		const outcome = await setColor(dir, "blue")

		expect(outcome).toEqual({ status: "error", dto })
		expect(
			testQueryClient
				.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))
				?.find((i): i is DirectoryItem => i.type === "directory")?.data.color
		).toBe("default")
	})
})

describe("restoreVersion", () => {
	it("replaces the old uuid with the rotated new one in the same (root-normalized) listing — no duplicate", async () => {
		seedRootUuid()
		const file = fileItem({ uuid: testUuid("old"), parent: ROOT_UUID })
		testQueryClient.setQueryData(driveListing(null), [file])
		const version = mockVersion()
		// A different name than `file`'s default, so upsertDriveItem's own name-collision dedup cannot
		// account for the old row's removal — proves the explicit old-uuid drop below is load-bearing.
		restoreFileVersionOp.mockResolvedValueOnce(
			mockFile({
				uuid: testUuid("new"),
				parent: ROOT_UUID,
				meta: {
					type: "decoded",
					data: { name: "restored.pdf", mime: "application/pdf", modified: 1n, size: 1n, key: "k", version: 2 }
				}
			})
		)

		const outcome = await restoreVersion(file, version)

		expect(outcome.status).toBe("success")
		expect(restoreFileVersionOp).toHaveBeenCalledExactlyOnceWith(file.data, version)
		const patched = testQueryClient.getQueryData<DriveItem[]>(driveListing(null))
		expect(patched?.map(i => i.data.uuid)).toEqual([testUuid("new")])
	})

	it("drops the old uuid even when the file is undecryptable (no name for the intrinsic dedup to match on)", async () => {
		seedRootUuid()
		const undecryptable = (() => {
			const item = narrowItem({ ...mockFile({ uuid: testUuid("old") }), meta: { type: "encrypted", data: "cipher" } })
			if (item.type !== "file") {
				throw new Error("expected a file arm")
			}
			return item
		})()
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [undecryptable])
		const version = mockVersion()
		// The restored version is decryptable under the (now current) key, unlike the stale row.
		restoreFileVersionOp.mockResolvedValueOnce(mockFile({ uuid: testUuid("new"), parent: OTHER_PARENT_UUID }))

		await restoreVersion(undecryptable, version)

		const patched = testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))
		expect(patched).toHaveLength(1)
		expect(patched?.[0]?.data.uuid).toBe(testUuid("new"))
	})

	it("returns an error outcome without patching the listing on rejection", async () => {
		seedRootUuid()
		const file = fileItem({ uuid: testUuid("old"), parent: OTHER_PARENT_UUID })
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [file])
		const dto = sdkDto("NotFound")
		restoreFileVersionOp.mockRejectedValueOnce(dto)

		const outcome = await restoreVersion(file, mockVersion())

		expect(outcome).toEqual({ status: "error", dto })
		expect(testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))).toEqual([file])
	})
})

describe("deleteVersion", () => {
	it("calls deleteFileVersionOp with only the version, and leaves every listing untouched", async () => {
		const file = fileItem({ uuid: testUuid("f"), parent: OTHER_PARENT_UUID })
		testQueryClient.setQueryData(driveListing(OTHER_PARENT_UUID), [file])
		const version = mockVersion()
		deleteFileVersionOp.mockResolvedValueOnce(undefined)

		const outcome = await deleteVersion(file, version)

		expect(outcome).toEqual({ status: "success" })
		expect(deleteFileVersionOp).toHaveBeenCalledExactlyOnceWith(version)
		expect(testQueryClient.getQueryData<DriveItem[]>(driveListing(OTHER_PARENT_UUID))).toEqual([file])
	})

	it("returns an error outcome on rejection", async () => {
		const file = fileItem({ uuid: testUuid("f") })
		const dto = sdkDto("NotFound")
		deleteFileVersionOp.mockRejectedValueOnce(dto)

		const outcome = await deleteVersion(file, mockVersion())

		expect(outcome).toEqual({ status: "error", dto })
	})

	// Defense-in-depth: deleteFileVersionOp deletes by the version's uuid alone, and the live
	// version's uuid IS the file's own current storage blob — the versions panel already disables
	// this per row, but a caller reaching this helper directly (bypassing that UI guard) must still
	// be refused before the worker is ever called.
	it("refuses to delete the file's own live version without calling the worker", async () => {
		const file = fileItem({ uuid: testUuid("live") })
		const liveVersion = mockVersion({ uuid: testUuid("live") })

		const outcome = await deleteVersion(file, liveVersion)

		expect(outcome).toEqual({
			status: "error",
			dto: {
				species: "plain",
				message: "This is the current version and can't be deleted.",
				label: "This is the current version and can't be deleted."
			}
		})
		expect(deleteFileVersionOp).not.toHaveBeenCalled()
	})
})

describe("createLink", () => {
	it("directory: calls createDirectoryLink with a Comlink-proxied callback and patches the link-status cache", async () => {
		const dir = dirItem({ uuid: testUuid("a") })
		const status = mockDirLink()
		createDirectoryLink.mockResolvedValueOnce(status)

		const outcome = await createLink(dir, vi.fn())

		expect(outcome).toEqual({ status: "success", link: { type: "directory", status } })
		expect(createDirectoryLink).toHaveBeenCalledTimes(1)
		expect(createDirectoryLink.mock.calls[0]?.[0]).toBe(dir.data)
		expect(testQueryClient.getQueryData(driveItemLinkStatusQueryKey(testUuid("a")))).toEqual({ type: "directory", status })
		expect(createFileLink).not.toHaveBeenCalled()
	})

	it("directory: the progress callback passed to createDirectoryLink still calls through to the caller's onProgress", async () => {
		const dir = dirItem({ uuid: testUuid("a") })
		createDirectoryLink.mockImplementationOnce((_dir: Dir, onProgress: (a: number, b: number | undefined) => void) => {
			onProgress(50, 100)
			return mockDirLink()
		})
		const seen: [number, number | undefined][] = []

		await createLink(dir, (downloaded, total) => {
			seen.push([downloaded, total])
		})

		expect(seen).toEqual([[50, 100]])
	})

	it("file: calls createFileLink (no progress callback), not createDirectoryLink", async () => {
		const file = fileItem({ uuid: testUuid("f") })
		const status = mockFileLink()
		createFileLink.mockResolvedValueOnce(status)

		const outcome = await createLink(file, vi.fn())

		expect(outcome).toEqual({ status: "success", link: { type: "file", status } })
		expect(createFileLink).toHaveBeenCalledExactlyOnceWith(file.data)
		expect(createDirectoryLink).not.toHaveBeenCalled()
		expect(testQueryClient.getQueryData(driveItemLinkStatusQueryKey(testUuid("f")))).toEqual({ type: "file", status })
	})

	it("returns an error outcome without patching the cache on rejection", async () => {
		const dir = dirItem({ uuid: testUuid("a") })
		const dto = sdkDto("Forbidden")
		createDirectoryLink.mockRejectedValueOnce(dto)

		const outcome = await createLink(dir, vi.fn())

		expect(outcome).toEqual({ status: "error", dto })
		expect(testQueryClient.getQueryData(driveItemLinkStatusQueryKey(testUuid("a")))).toBeUndefined()
	})
})

describe("updateLink", () => {
	it("directory: calls updateDirectoryLink with the merged status and patches the cache", async () => {
		const dir = dirItem({ uuid: testUuid("a") })
		const merged = mockDirLink({ expiration: "7d" })
		updateDirectoryLink.mockResolvedValueOnce(merged)

		const outcome = await updateLink(dir, { type: "directory", status: merged })

		expect(outcome).toEqual({ status: "success", link: { type: "directory", status: merged } })
		expect(updateDirectoryLink).toHaveBeenCalledExactlyOnceWith(dir.data, merged)
		expect(testQueryClient.getQueryData(driveItemLinkStatusQueryKey(testUuid("a")))).toEqual({ type: "directory", status: merged })
	})

	it("file: calls updateFileLink, not updateDirectoryLink", async () => {
		const file = fileItem({ uuid: testUuid("f") })
		const merged = mockFileLink({ downloadable: false })
		updateFileLink.mockResolvedValueOnce(merged)

		const outcome = await updateLink(file, { type: "file", status: merged })

		expect(outcome).toEqual({ status: "success", link: { type: "file", status: merged } })
		expect(updateFileLink).toHaveBeenCalledExactlyOnceWith(file.data, merged)
		expect(updateDirectoryLink).not.toHaveBeenCalled()
	})

	it("an item/link type mismatch is refused as an error without calling either worker op", async () => {
		const dir = dirItem({ uuid: testUuid("a") })

		const outcome = await updateLink(dir, { type: "file", status: mockFileLink() })

		expect(outcome.status).toBe("error")
		expect(updateDirectoryLink).not.toHaveBeenCalled()
		expect(updateFileLink).not.toHaveBeenCalled()
	})

	it("returns an error outcome without patching the cache on rejection", async () => {
		const dir = dirItem({ uuid: testUuid("a") })
		const dto = sdkDto("NotFound")
		updateDirectoryLink.mockRejectedValueOnce(dto)

		const outcome = await updateLink(dir, { type: "directory", status: mockDirLink() })

		expect(outcome).toEqual({ status: "error", dto })
		expect(testQueryClient.getQueryData(driveItemLinkStatusQueryKey(testUuid("a")))).toBeUndefined()
	})
})

describe("disableLink", () => {
	it("directory: calls removeDirectoryLink with only the directory (asymmetric — no link arg)", async () => {
		const dir = dirItem({ uuid: testUuid("a") })
		removeDirectoryLink.mockResolvedValueOnce(undefined)

		const outcome = await disableLink(dir, { type: "directory", status: mockDirLink() })

		expect(outcome).toEqual({ status: "success" })
		expect(removeDirectoryLink).toHaveBeenCalledExactlyOnceWith(dir.data)
		expect(removeFileLink).not.toHaveBeenCalled()
		expect(testQueryClient.getQueryData(driveItemLinkStatusQueryKey(testUuid("a")))).toBeNull()
	})

	it("file: calls removeFileLink with the file AND the live link object (asymmetric)", async () => {
		const file = fileItem({ uuid: testUuid("f") })
		const link = mockFileLink()
		removeFileLink.mockResolvedValueOnce(undefined)

		const outcome = await disableLink(file, { type: "file", status: link })

		expect(outcome).toEqual({ status: "success" })
		expect(removeFileLink).toHaveBeenCalledExactlyOnceWith(file.data, link)
		expect(removeDirectoryLink).not.toHaveBeenCalled()
		expect(testQueryClient.getQueryData(driveItemLinkStatusQueryKey(testUuid("f")))).toBeNull()
	})

	it("an item/link type mismatch is refused as an error without calling either worker op", async () => {
		const file = fileItem({ uuid: testUuid("f") })

		const outcome = await disableLink(file, { type: "directory", status: mockDirLink() })

		expect(outcome.status).toBe("error")
		expect(removeDirectoryLink).not.toHaveBeenCalled()
		expect(removeFileLink).not.toHaveBeenCalled()
	})

	it("returns an error outcome without patching the cache on rejection", async () => {
		const dir = dirItem({ uuid: testUuid("a") })
		const dto = sdkDto("Forbidden")
		removeDirectoryLink.mockRejectedValueOnce(dto)

		const outcome = await disableLink(dir, { type: "directory", status: mockDirLink() })

		expect(outcome).toEqual({ status: "error", dto })
		expect(testQueryClient.getQueryData(driveItemLinkStatusQueryKey(testUuid("a")))).toBeUndefined()
	})
})

// Sanity: driveNamesQueryKey stays importable/used the same way renameItem's own invalidation targets
// it (a 2-element prefix filter matches any uuids array) — proven directly in queries/drive.test.ts;
// this just confirms the shape actions.ts's rename patch is invalidating against.
describe("names query key shape", () => {
	it("is a 3-tuple whose first two elements are the prefix renameItem invalidates", () => {
		expect(driveNamesQueryKey(["a", "b"]).slice(0, 2)).toEqual(["drive", "names"])
	})
})
