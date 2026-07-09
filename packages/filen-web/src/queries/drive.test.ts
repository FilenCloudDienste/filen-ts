import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type {
	AnyDirWithContext,
	Dir,
	DirPublicLinkRW,
	File,
	FilePublicLink,
	NormalDirsAndFiles,
	SharedRootDirsAndFiles,
	SharedDir,
	SharedFile,
	SharedRootDir,
	SharingRole,
	UuidStr
} from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest — mock it
// down to the methods this module calls, mirroring account.test.ts's mock boundary.
const {
	listDirectory,
	resolveDirectoryNames,
	getItemInfo,
	listFileVersionsOp,
	getDirectoryLinkStatus,
	getFileLinkStatus,
	listSharedInRoot,
	listSharedOutRoot,
	listSharedDirectory
} = vi.hoisted(() => ({
	listDirectory: vi.fn<(target: unknown) => Promise<NormalDirsAndFiles>>(),
	resolveDirectoryNames: vi.fn<(uuids: string[]) => Promise<Record<string, string>>>(),
	getItemInfo: vi.fn(),
	listFileVersionsOp: vi.fn(),
	getDirectoryLinkStatus: vi.fn(),
	getFileLinkStatus: vi.fn(),
	listSharedInRoot: vi.fn<() => Promise<SharedRootDirsAndFiles>>(),
	listSharedOutRoot: vi.fn<() => Promise<SharedRootDirsAndFiles>>(),
	listSharedDirectory: vi.fn<(uuid: string) => Promise<{ dirs: SharedDir[]; files: File[]; role: SharingRole }>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		listDirectory,
		resolveDirectoryNames,
		getItemInfo,
		listFileVersionsOp,
		getDirectoryLinkStatus,
		getFileLinkStatus,
		listSharedInRoot,
		listSharedOutRoot,
		listSharedDirectory
	}
}))

// Every other hook wrapper below is a one-line pass-through no node-environment test can render (no
// DOM — see vitest.config.ts). useItemInfoQuery's `enabled` default is worth covering directly
// anyway: get the fallback wrong (e.g. defaulting to false) and every existing caller silently stops
// fetching. This only intercepts useQuery itself — real `useQuery` internals are never exercised,
// just whether our wrapper forwards `enabled` into its options — so QueryClient (used below to build
// testQueryClient) and the rest of the module stay real.
const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }))

vi.mock("@tanstack/react-query", async importOriginal => {
	const actual = await importOriginal<typeof import("@tanstack/react-query")>()
	return { ...actual, useQuery }
})

// A bare, unconfigured QueryClient (no persister, no retry/logging wiring) stands in for the real
// singleton — driveListingQueryUpdate only needs genuine setQueryData/getQueryData cache mechanics,
// never the production client's OPFS-backed persistence pipeline (out of scope for a unit test, and
// unavailable under node vitest anyway). `QueryClient` is a plain top-level import (not a locally
// declared variable), so referencing it directly inside the factory is fine — vi.hoisted is only
// needed to share a locally-declared value with a factory, which is why the instance is re-imported
// by its mocked name below instead.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import {
	driveItemLinkStatusQueryKey,
	driveItemLinkStatusQueryUpdate,
	driveListingQueryKey,
	driveListingQueryUpdate,
	driveListingQueryUpdateGlobal,
	driveNamesQueryKey,
	fetchDirectoryListing,
	fetchDirectoryNames,
	fetchDriveItemLinkStatus,
	fetchFileVersions,
	fetchItemInfo,
	fetchSharedListing,
	fileVersionsQueryKey,
	itemInfoQueryKey,
	normalizeParentUuid,
	toListingTarget,
	useItemInfoQuery
} from "@/queries/drive"

// Unlike account.test.ts (one call-count assertion in the whole file), several tests here assert
// exact call counts — clear history between tests so an earlier test's calls can't leak in.
beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
})

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — pad a short
// readable test label into a shape that satisfies it, mirroring sort.test.ts's own uuid fixtures.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

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

describe("driveListingQueryKey", () => {
	it("builds the [domain, entity, params] tuple", () => {
		expect(driveListingQueryKey({ variant: "drive", uuid: "abc" })).toEqual(["drive", "listing", { variant: "drive", uuid: "abc" }])
	})
})

describe("fetchDirectoryListing", () => {
	it("targets root for the drive variant with a null uuid", async () => {
		listDirectory.mockResolvedValueOnce({ dirs: [], files: [] })

		await fetchDirectoryListing("drive", null)

		expect(listDirectory).toHaveBeenCalledTimes(1)
		expect(listDirectory).toHaveBeenCalledWith({ kind: "root" })
	})

	it("targets the given uuid for the drive variant with a non-null uuid", async () => {
		listDirectory.mockResolvedValueOnce({ dirs: [], files: [] })

		await fetchDirectoryListing("drive", "some-uuid")

		expect(listDirectory).toHaveBeenCalledTimes(1)
		expect(listDirectory).toHaveBeenCalledWith({ kind: "uuid", uuid: "some-uuid" })
	})

	it.each(["recents", "favorites", "trash"] as const)("targets the flat %s listing regardless of uuid", async variant => {
		listDirectory.mockResolvedValueOnce({ dirs: [], files: [] })

		await fetchDirectoryListing(variant, "some-uuid")

		expect(listDirectory).toHaveBeenCalledTimes(1)
		expect(listDirectory).toHaveBeenCalledWith({ kind: variant })
	})

	it("narrows dirs before files, preserving each group's own order", async () => {
		const dirAUuid = testUuid("dir-a")
		const dirBUuid = testUuid("dir-b")
		const fileAUuid = testUuid("file-a")
		const dirA = mockDir({ uuid: dirAUuid })
		const dirB = mockDir({ uuid: dirBUuid })
		const fileA = mockFile({ uuid: fileAUuid })
		listDirectory.mockResolvedValueOnce({ dirs: [dirA, dirB], files: [fileA] })

		const items = await fetchDirectoryListing("drive", null)

		expect(items.map(item => item.data.uuid)).toEqual([dirAUuid, dirBUuid, fileAUuid])
		expect(items.map(item => item.type)).toEqual(["directory", "directory", "file"])
	})

	it("propagates a rejection from sdkApi.listDirectory unchanged", async () => {
		const error = new Error("boom")
		listDirectory.mockRejectedValueOnce(error)

		await expect(fetchDirectoryListing("drive", null)).rejects.toBe(error)
	})
})

describe("driveNamesQueryKey", () => {
	it("builds the [domain, entity, uuids] tuple", () => {
		expect(driveNamesQueryKey(["a", "b"])).toEqual(["drive", "names", ["a", "b"]])
	})
})

describe("fetchDirectoryNames", () => {
	it("returns an empty record without calling the worker for an empty uuid list", async () => {
		const result = await fetchDirectoryNames([])

		expect(result).toEqual({})
		expect(resolveDirectoryNames).not.toHaveBeenCalled()
	})

	it("passes the uuids through to sdkApi.resolveDirectoryNames unchanged", async () => {
		resolveDirectoryNames.mockResolvedValueOnce({})

		await fetchDirectoryNames(["uuid-a", "uuid-b"])

		expect(resolveDirectoryNames).toHaveBeenCalledTimes(1)
		expect(resolveDirectoryNames).toHaveBeenCalledWith(["uuid-a", "uuid-b"])
	})

	it("returns the worker's resolved record unchanged, including a partial result", async () => {
		resolveDirectoryNames.mockResolvedValueOnce({ "uuid-a": "Documents" })

		const result = await fetchDirectoryNames(["uuid-a", "uuid-b"])

		expect(result).toEqual({ "uuid-a": "Documents" })
	})

	it("propagates a rejection from sdkApi.resolveDirectoryNames unchanged", async () => {
		const error = new Error("no authenticated client")
		resolveDirectoryNames.mockRejectedValueOnce(error)

		await expect(fetchDirectoryNames(["uuid-a"])).rejects.toBe(error)
	})
})

describe("itemInfoQueryKey", () => {
	it("builds the [domain, entity, uuid] tuple", () => {
		expect(itemInfoQueryKey("abc")).toEqual(["drive", "itemInfo", "abc"])
	})
})

describe("fetchItemInfo", () => {
	it("passes the item through to sdkApi.getItemInfo unchanged", async () => {
		const dir = mockDir()
		const result = { path: "Documents/", ancestors: [], size: { size: 0n, files: 0n, dirs: 0n } }
		getItemInfo.mockResolvedValueOnce(result)

		await expect(fetchItemInfo(dir)).resolves.toEqual(result)
		expect(getItemInfo).toHaveBeenCalledExactlyOnceWith(dir)
	})

	it("propagates a rejection from sdkApi.getItemInfo unchanged", async () => {
		const error = new Error("no authenticated client")
		getItemInfo.mockRejectedValueOnce(error)

		await expect(fetchItemInfo(mockFile())).rejects.toBe(error)
	})

	// A null path is a resolved value, not a rejection (see sdk.worker.ts's getItemInfo: it absorbs a
	// trashed item's unresolvable getItemPath itself rather than failing the whole read) — this layer
	// is a plain pass-through either way, so a null path needs no special handling here either.
	it("passes a null path through unchanged (a trashed item's path can be individually unresolvable)", async () => {
		const file = mockFile()
		const result = { path: null, ancestors: [], size: null }
		getItemInfo.mockResolvedValueOnce(result)

		await expect(fetchItemInfo(file)).resolves.toEqual(result)
	})

	// dirContext is what a shared directory's caller (info-dialog.tsx, via item.ts's
	// toAnyDirWithContext) passes so getDirSize dispatches through the SDK's Shared arm instead of the
	// owned one a bare Dir would land on — forwarded as a second argument only when given, so the
	// "unchanged" pass-through above still exercises the plain owned-directory call shape.
	it("forwards dirContext to sdkApi.getItemInfo as a second argument when given", async () => {
		const dir = mockDir()
		const dirContext: AnyDirWithContext = mockDir({ uuid: testUuid("shared-ctx") })
		const result = { path: "Documents/", ancestors: [], size: { size: 0n, files: 0n, dirs: 0n } }
		getItemInfo.mockResolvedValueOnce(result)

		await expect(fetchItemInfo(dir, dirContext)).resolves.toEqual(result)
		expect(getItemInfo).toHaveBeenCalledExactlyOnceWith(dir, dirContext)
	})
})

describe("useItemInfoQuery", () => {
	// The info dialog disables this query for a trashed item (getItemPath/getDirSize stall on a
	// trashed item's unresolvable ancestry rather than reject — see fetchItemInfo's own tests above
	// and sdk.worker.ts's getItemInfo), so `enabled` reaching useQuery unchanged is the one thing
	// this thin wrapper must get right.
	it("forwards enabled: false through to useQuery, unmodified", () => {
		useQuery.mockReturnValue({ status: "pending" })
		const dir = mockDir()

		useItemInfoQuery(dir, { enabled: false })

		expect(useQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: false }))
	})

	// Every caller besides the info dialog's trash case omits `options` entirely — a wrong default
	// here would silently stop every one of them from ever fetching.
	it("defaults enabled to true when no options are given", () => {
		useQuery.mockReturnValue({ status: "pending" })
		const dir = mockDir()

		useItemInfoQuery(dir)

		expect(useQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: true }))
	})
})

describe("fileVersionsQueryKey", () => {
	it("builds the [domain, entity, uuid] tuple", () => {
		expect(fileVersionsQueryKey("abc")).toEqual(["drive", "fileVersions", "abc"])
	})
})

describe("fetchFileVersions", () => {
	it("passes the file through to sdkApi.listFileVersionsOp unchanged", async () => {
		const file = mockFile()
		listFileVersionsOp.mockResolvedValueOnce([])

		await expect(fetchFileVersions(file)).resolves.toEqual([])
		expect(listFileVersionsOp).toHaveBeenCalledExactlyOnceWith(file)
	})

	it("propagates a rejection from sdkApi.listFileVersionsOp unchanged", async () => {
		const error = new Error("no authenticated client")
		listFileVersionsOp.mockRejectedValueOnce(error)

		await expect(fetchFileVersions(mockFile())).rejects.toBe(error)
	})
})

describe("driveItemLinkStatusQueryKey", () => {
	it("builds the [domain, entity, uuid] tuple", () => {
		expect(driveItemLinkStatusQueryKey("abc")).toEqual(["drive", "linkStatus", "abc"])
	})
})

describe("fetchDriveItemLinkStatus", () => {
	it("calls getDirectoryLinkStatus and tags the result 'directory' for a directory item", async () => {
		const dir = narrowItem(mockDir())
		const status = mockDirLink()
		getDirectoryLinkStatus.mockResolvedValueOnce(status)

		await expect(fetchDriveItemLinkStatus(dir)).resolves.toEqual({ type: "directory", status })
		expect(getDirectoryLinkStatus).toHaveBeenCalledExactlyOnceWith(dir.data)
		expect(getFileLinkStatus).not.toHaveBeenCalled()
	})

	it("calls getFileLinkStatus and tags the result 'file' for a file item", async () => {
		const file = narrowItem(mockFile())
		const status = mockFileLink()
		getFileLinkStatus.mockResolvedValueOnce(status)

		await expect(fetchDriveItemLinkStatus(file)).resolves.toEqual({ type: "file", status })
		expect(getFileLinkStatus).toHaveBeenCalledExactlyOnceWith(file.data)
		expect(getDirectoryLinkStatus).not.toHaveBeenCalled()
	})

	it("returns null (no link) when the worker resolves undefined, for either item type", async () => {
		getDirectoryLinkStatus.mockResolvedValueOnce(undefined)
		getFileLinkStatus.mockResolvedValueOnce(undefined)

		await expect(fetchDriveItemLinkStatus(narrowItem(mockDir()))).resolves.toBeNull()
		await expect(fetchDriveItemLinkStatus(narrowItem(mockFile()))).resolves.toBeNull()
	})

	it("propagates a rejection from the worker unchanged", async () => {
		const error = new Error("no authenticated client")
		getDirectoryLinkStatus.mockRejectedValueOnce(error)

		await expect(fetchDriveItemLinkStatus(narrowItem(mockDir()))).rejects.toBe(error)
	})
})

describe("driveItemLinkStatusQueryUpdate", () => {
	it("sets the link status at the item's own uuid key", () => {
		const status = mockFileLink()

		driveItemLinkStatusQueryUpdate("some-uuid", { type: "file", status })

		expect(testQueryClient.getQueryData(driveItemLinkStatusQueryKey("some-uuid"))).toEqual({ type: "file", status })
	})

	it("can patch back to null (disable)", () => {
		testQueryClient.setQueryData(driveItemLinkStatusQueryKey("some-uuid"), { type: "file", status: mockFileLink() })

		driveItemLinkStatusQueryUpdate("some-uuid", null)

		expect(testQueryClient.getQueryData(driveItemLinkStatusQueryKey("some-uuid"))).toBeNull()
	})

	it("never touches a differently-scoped uuid's key", () => {
		testQueryClient.setQueryData(driveItemLinkStatusQueryKey("other-uuid"), null)

		driveItemLinkStatusQueryUpdate("some-uuid", { type: "directory", status: mockDirLink() })

		expect(testQueryClient.getQueryData(driveItemLinkStatusQueryKey("other-uuid"))).toBeNull()
	})
})

describe("driveListingQueryUpdate", () => {
	it("defaults an uncached listing to [] before applying the updater", () => {
		const created = narrowItem(mockDir({ uuid: testUuid("new") }))

		driveListingQueryUpdate(null, prev => [...prev, created])

		expect(testQueryClient.getQueryData(driveListingQueryKey({ variant: "drive", uuid: null }))).toEqual([created])
	})

	it("targets the drive variant's key for the given parent uuid, leaving other parents untouched", () => {
		const otherParentKey = driveListingQueryKey({ variant: "drive", uuid: "other-parent" })
		testQueryClient.setQueryData(otherParentKey, [])
		const created = narrowItem(mockDir({ uuid: testUuid("new") }))

		driveListingQueryUpdate("this-parent", prev => [...prev, created])

		expect(testQueryClient.getQueryData(driveListingQueryKey({ variant: "drive", uuid: "this-parent" }))).toEqual([created])
		expect(testQueryClient.getQueryData(otherParentKey)).toEqual([])
	})

	it("passes the previously cached array through to the updater unchanged", () => {
		const key = driveListingQueryKey({ variant: "drive", uuid: null })
		const existingA = narrowItem(mockDir({ uuid: testUuid("a") }))
		const existingB = narrowItem(mockDir({ uuid: testUuid("b") }))
		testQueryClient.setQueryData(key, [existingA, existingB])

		let seenPrev: unknown
		driveListingQueryUpdate(null, prev => {
			seenPrev = prev
			return prev
		})

		expect(seenPrev).toEqual([existingA, existingB])
	})

	it("never touches a differently-scoped variant's key (e.g. recents) for the same uuid", () => {
		const recentsKey = driveListingQueryKey({ variant: "recents", uuid: null })
		testQueryClient.setQueryData(recentsKey, [])

		driveListingQueryUpdate(null, prev => [...prev, narrowItem(mockDir({ uuid: testUuid("new") }))])

		expect(testQueryClient.getQueryData(recentsKey)).toEqual([])
	})
})

describe("driveListingQueryUpdateGlobal", () => {
	it("patches every instantiated listing key regardless of variant or uuid, including the null-root", () => {
		const target = narrowItem(mockDir({ uuid: testUuid("target"), favorited: false }))
		const other = narrowItem(mockDir({ uuid: testUuid("other"), favorited: false }))
		const driveRootKey = driveListingQueryKey({ variant: "drive", uuid: null })
		const driveSubKey = driveListingQueryKey({ variant: "drive", uuid: "some-parent" })
		const favoritesKey = driveListingQueryKey({ variant: "favorites", uuid: null })
		const trashKey = driveListingQueryKey({ variant: "trash", uuid: null })
		testQueryClient.setQueryData(driveRootKey, [target, other])
		testQueryClient.setQueryData(driveSubKey, [target])
		testQueryClient.setQueryData(favoritesKey, [target])
		testQueryClient.setQueryData(trashKey, [other])

		driveListingQueryUpdateGlobal(items =>
			items.map(item => {
				if (item.type !== "directory" || item.data.uuid !== target.data.uuid) {
					return item
				}
				return { ...item, data: { ...item.data, favorited: true } }
			})
		)

		expect(testQueryClient.getQueryData<DriveItem[]>(driveRootKey)?.find(i => i.data.uuid === target.data.uuid)?.data.favorited).toBe(
			true
		)
		expect(testQueryClient.getQueryData<DriveItem[]>(driveSubKey)?.[0]?.data.favorited).toBe(true)
		expect(testQueryClient.getQueryData<DriveItem[]>(favoritesKey)?.[0]?.data.favorited).toBe(true)
		// `other` is untouched by the updater everywhere it appears, including the trash listing.
		expect(testQueryClient.getQueryData<DriveItem[]>(trashKey)?.[0]?.data.favorited).toBe(false)
		expect(testQueryClient.getQueryData<DriveItem[]>(driveRootKey)?.find(i => i.data.uuid === other.data.uuid)?.data.favorited).toBe(
			false
		)
	})

	it("leaves a non-listing key (e.g. drive names or sort preferences) completely untouched", () => {
		const namesKey = driveNamesQueryKey(["a", "b"])
		const sortKey = ["drive", "sortPreferences"] as const
		testQueryClient.setQueryData(namesKey, { a: "Documents" })
		testQueryClient.setQueryData(sortKey, { mode: "global", global: "nameAsc", perDirectory: {} })

		driveListingQueryUpdateGlobal(items => items)

		expect(testQueryClient.getQueryData(namesKey)).toEqual({ a: "Documents" })
		expect(testQueryClient.getQueryData(sortKey)).toEqual({ mode: "global", global: "nameAsc", perDirectory: {} })
	})

	it("never conjures data into a listing key that was never fetched (no cached data yet)", () => {
		const unfetchedKey = driveListingQueryKey({ variant: "drive", uuid: "never-fetched" })
		// Registers the query in the cache (so findAll sees it) without ever giving it data — mirrors a
		// component that mounted a query that hasn't resolved yet.
		void testQueryClient.getQueryCache().build(testQueryClient, { queryKey: unfetchedKey })

		driveListingQueryUpdateGlobal(items => [...items, narrowItem(mockDir({ uuid: testUuid("new") }))])

		expect(testQueryClient.getQueryData(unfetchedKey)).toBeUndefined()
	})

	it("applies the same updater independently per key (a filter can remove from one listing and keep another)", () => {
		const keep = narrowItem(mockDir({ uuid: testUuid("keep") }))
		const drop = narrowItem(mockDir({ uuid: testUuid("drop") }))
		const keyA = driveListingQueryKey({ variant: "drive", uuid: null })
		const keyB = driveListingQueryKey({ variant: "trash", uuid: null })
		testQueryClient.setQueryData(keyA, [keep, drop])
		testQueryClient.setQueryData(keyB, [drop])

		driveListingQueryUpdateGlobal(items => items.filter(item => item.data.uuid !== drop.data.uuid))

		expect(testQueryClient.getQueryData(keyA)).toEqual([keep])
		expect(testQueryClient.getQueryData(keyB)).toEqual([])
	})
})

describe("normalizeParentUuid", () => {
	it("maps the account's root uuid to null", () => {
		expect(normalizeParentUuid("root-uuid", "root-uuid")).toBeNull()
	})

	it("leaves a non-root uuid unchanged", () => {
		expect(normalizeParentUuid("some-directory-uuid", "root-uuid")).toBe("some-directory-uuid")
	})

	it("leaves null unchanged (already the root sentinel)", () => {
		expect(normalizeParentUuid(null, "root-uuid")).toBeNull()
	})
})

describe("toListingTarget", () => {
	it("maps the drive variant to root for a null uuid and to a uuid target otherwise", () => {
		expect(toListingTarget("drive", null)).toEqual({ kind: "root" })
		expect(toListingTarget("drive", "abc")).toEqual({ kind: "uuid", uuid: "abc" })
	})

	it.each(["recents", "favorites", "trash"] as const)("maps the flat %s variant to its own kind, ignoring uuid", variant => {
		expect(toListingTarget(variant, "ignored")).toEqual({ kind: variant })
	})

	it.each(["sharedIn", "sharedOut"] as const)("throws for the %s variant (it lists via its own ops)", variant => {
		expect(() => toListingTarget(variant, null)).toThrow()
	})
})

function sharerRole(id: number, email: string): SharingRole {
	return { Sharer: { email, id } }
}

function mockSharedRootDir(uuid: UuidStr): SharedRootDir {
	return {
		inner: { uuid, color: "default", timestamp: 1_700_000_000_000n, meta: { type: "decoded", data: { name: "SharedRoot" } } },
		sharingRole: sharerRole(42, "sharer@filen.io"),
		writeAccess: true
	}
}

function mockSharedFile(uuid: UuidStr): SharedFile {
	return {
		uuid,
		size: 2_048n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 2n,
		timestamp: 1_700_000_000_000n,
		meta: {
			type: "decoded",
			data: { name: "shared.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 2_048n, key: "k", version: 2 }
		},
		sharingRole: sharerRole(42, "sharer@filen.io"),
		sharedTag: true
	}
}

function mockSharedDir(uuid: UuidStr): SharedDir {
	return { inner: mockDir({ uuid }), sharedTag: true }
}

describe("fetchSharedListing", () => {
	it("lists the sharedIn root and narrows into the shared-root arms", async () => {
		const dirUuid = testUuid("sroot-dir")
		const fileUuid = testUuid("sroot-file")
		listSharedInRoot.mockResolvedValueOnce({ dirs: [mockSharedRootDir(dirUuid)], files: [mockSharedFile(fileUuid)] })

		const items = await fetchSharedListing("sharedIn", null)

		expect(listSharedInRoot).toHaveBeenCalledTimes(1)
		expect(listSharedOutRoot).not.toHaveBeenCalled()
		expect(items.map(item => item.type)).toEqual(["sharedRootDirectory", "sharedRootFile"])
		expect(items.map(item => item.data.uuid)).toEqual([dirUuid, fileUuid])
	})

	it("routes the sharedOut root through listSharedOutRoot", async () => {
		listSharedOutRoot.mockResolvedValueOnce({ dirs: [], files: [] })

		await fetchSharedListing("sharedOut", null)

		expect(listSharedOutRoot).toHaveBeenCalledTimes(1)
		expect(listSharedInRoot).not.toHaveBeenCalled()
	})

	it("context-tags every nested item with the parent role before narrowing", async () => {
		const role = sharerRole(99, "owner@filen.io")
		const dirUuid = testUuid("nested-dir")
		const fileUuid = testUuid("nested-file")
		listSharedDirectory.mockResolvedValueOnce({ dirs: [mockSharedDir(dirUuid)], files: [mockFile({ uuid: fileUuid })], role })

		const items = await fetchSharedListing("sharedIn", "parent-uuid")

		expect(listSharedDirectory).toHaveBeenCalledExactlyOnceWith("parent-uuid")
		expect(items.map(item => item.type)).toEqual(["sharedDirectory", "sharedFile"])
		// The parent role is spread onto each nested item — this is the whole point of the context-tag.
		const [dir, file] = items
		expect(dir?.type === "sharedDirectory" && dir.data.sharingRole).toEqual(role)
		expect(file?.type === "sharedFile" && file.data.sharingRole).toEqual(role)
	})

	it("propagates a rejection from the worker unchanged", async () => {
		const error = new Error("shared directory not found: parent-uuid")
		listSharedDirectory.mockRejectedValueOnce(error)

		await expect(fetchSharedListing("sharedIn", "parent-uuid")).rejects.toBe(error)
	})
})
