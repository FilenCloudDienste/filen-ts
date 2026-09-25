import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type {
	Dir,
	DirSizeResponse,
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
import { applyMembershipPatch, removeByUuid, upsertItem } from "@filen/shared"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest — mock it
// down to the methods this module calls, mirroring account.test.ts's mock boundary.
const {
	listDirectory,
	resolveDirectoryName,
	getItemInfo,
	getItemPath,
	getDirSize,
	listFileVersionsOp,
	getDirectoryLinkStatus,
	getFileLinkStatus,
	listSharedInRoot,
	listSharedOutRoot,
	listSharedDirectory
} = vi.hoisted(() => ({
	listDirectory: vi.fn<(target: unknown) => Promise<NormalDirsAndFiles>>(),
	resolveDirectoryName: vi.fn<(uuid: string, hint?: { variant: string; path: string[] }) => Promise<string | null>>(),
	getItemInfo: vi.fn(),
	getItemPath: vi.fn(),
	getDirSize: vi.fn(),
	listFileVersionsOp: vi.fn(),
	getDirectoryLinkStatus: vi.fn(),
	getFileLinkStatus: vi.fn(),
	listSharedInRoot: vi.fn<() => Promise<SharedRootDirsAndFiles>>(),
	listSharedOutRoot: vi.fn<() => Promise<SharedRootDirsAndFiles>>(),
	listSharedDirectory:
		vi.fn<
			(uuid: string, hint?: { variant: string; path: string[] }) => Promise<{ dirs: SharedDir[]; files: File[]; role: SharingRole }>
		>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		listDirectory,
		resolveDirectoryName,
		getItemInfo,
		getItemPath,
		getDirSize,
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
import { socketAuthenticated } from "@/lib/sdk/socketSession"
import {
	LISTING_CREATE_FLUSH_MS,
	applyListingChanges,
	directorySizeQueryKey,
	destinationDirectoryName,
	discardListingPatches,
	driveItemLinkStatusQueryKey,
	driveItemLinkStatusQueryUpdate,
	driveListingQueryKey,
	driveListingQueryOptions,
	driveListingQueryUpdate,
	driveListingQueryUpdateGlobal,
	driveNamesQueryKey,
	fetchDirectoryListing,
	fetchDirectoryName,
	cachedDirectoryName,
	combineDirectoryNames,
	directoryNameScope,
	fetchDirectorySize,
	fetchDriveItemLinkStatus,
	fetchFileVersions,
	fetchItemInfo,
	fetchItemPath,
	fetchSharedListing,
	fileVersionsQueryKey,
	findCachedListingItem,
	findOwnedListingItem,
	flatListingQueryUpdate,
	flushListingCreates,
	invalidateDirectorySize,
	itemInfoQueryKey,
	itemPathQueryKey,
	markDriveListingStale,
	markFlatListingStale,
	normalizeParentUuid,
	projectTreeChildren,
	queueListingCreate,
	toListingTarget,
	useItemInfoQuery,
	type ListingChange
} from "@/features/drive/queries/drive"

// Unlike account.test.ts (one call-count assertion in the whole file), several tests here assert
// exact call counts — clear history between tests so an earlier test's calls can't leak in.
beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
	discardListingPatches()
})

afterEach(() => {
	vi.useRealTimers()
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
		stableUUID: undefined,
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => undefined
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
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

	it.each(["recents", "favorites", "trash", "links"] as const)("targets the flat %s listing regardless of uuid", async variant => {
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

describe("projectTreeChildren", () => {
	it("keeps only directories, dropping files", () => {
		const dirA = mockDir({ uuid: testUuid("dir-a"), meta: { type: "decoded", data: { name: "Alpha" } } })
		const fileA = mockFile({ uuid: testUuid("file-a") })

		const children = projectTreeChildren([narrowItem(dirA), narrowItem(fileA)])

		expect(children).toEqual([{ uuid: testUuid("dir-a"), name: "Alpha", color: "default" }])
	})

	it("carries each directory's color", () => {
		const dir = mockDir({ uuid: testUuid("dir-c"), color: "blue" })

		expect(projectTreeChildren([narrowItem(dir)])[0]?.color).toBe("blue")
	})

	it("sorts children by name, case-insensitively (nameAsc, independent of any listing sort preference)", () => {
		const dirZebra = mockDir({ uuid: testUuid("dir-z"), meta: { type: "decoded", data: { name: "zebra" } } })
		const dirApple = mockDir({ uuid: testUuid("dir-a"), meta: { type: "decoded", data: { name: "Apple" } } })
		const dirMango = mockDir({ uuid: testUuid("dir-m"), meta: { type: "decoded", data: { name: "mango" } } })

		const children = projectTreeChildren([dirZebra, dirApple, dirMango].map(narrowItem))

		expect(children.map(child => child.name)).toEqual(["Apple", "mango", "zebra"])
	})

	it("sorts numeric suffixes naturally (Photos 2 before Photos 10), not lexicographically", () => {
		const photos10 = mockDir({ uuid: testUuid("dir-10"), meta: { type: "decoded", data: { name: "Photos 10" } } })
		const photos2 = mockDir({ uuid: testUuid("dir-2"), meta: { type: "decoded", data: { name: "Photos 2" } } })

		const children = projectTreeChildren([photos10, photos2].map(narrowItem))

		expect(children.map(child => child.name)).toEqual(["Photos 2", "Photos 10"])
	})
})

describe("driveNamesQueryKey", () => {
	it("keys one entry per uuid under its resolution scope", () => {
		expect(driveNamesQueryKey("sharedIn", "a")).toEqual(["drive", "names", "sharedIn", "a"])
	})
})

describe("directoryNameScope", () => {
	it.each(["drive", "recents", "favorites", "trash", "links"] as const)("%s resolves through the owned scope", variant => {
		expect(directoryNameScope(variant)).toBe("drive")
	})

	it.each(["sharedIn", "sharedOut"] as const)("%s keeps its own shared scope", variant => {
		expect(directoryNameScope(variant)).toBe(variant)
	})
})

// A three-level chain a/b/c: each listing holds the next directory, exactly what a click-through
// leaves in the cache.
function seedOwnedChain(a: UuidStr, b: UuidStr, c: UuidStr): void {
	testQueryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: null }), [
		narrowItem(mockDir({ uuid: a, meta: { type: "decoded", data: { name: "A" } } }))
	])
	testQueryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: a }), [
		narrowItem(mockDir({ uuid: b, parent: a, meta: { type: "decoded", data: { name: "B" } } }))
	])
	testQueryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: b }), [
		narrowItem(mockDir({ uuid: c, parent: b, meta: { type: "decoded", data: { name: "C" } } }))
	])
}

// The same chain reached through Shared with me, built by the real fetchSharedListing so the cached
// rows carry exactly the shared arms a live click-through stores.
async function seedSharedInChain(a: UuidStr, b: UuidStr, c: UuidStr): Promise<void> {
	const role = sharerRole(42, "sharer@filen.io")
	const root = mockSharedRootDir(a)

	listSharedInRoot.mockResolvedValueOnce({
		dirs: [{ ...root, inner: { ...root.inner, meta: { type: "decoded", data: { name: "A" } } } }],
		files: []
	})
	listSharedDirectory
		.mockResolvedValueOnce({
			dirs: [{ inner: mockDir({ uuid: b, parent: a, meta: { type: "decoded", data: { name: "B" } } }), sharedTag: true }],
			files: [],
			role
		})
		.mockResolvedValueOnce({
			dirs: [{ inner: mockDir({ uuid: c, parent: b, meta: { type: "decoded", data: { name: "C" } } }), sharedTag: true }],
			files: [],
			role
		})

	testQueryClient.setQueryData(driveListingQueryKey({ variant: "sharedIn", uuid: null }), await fetchSharedListing("sharedIn", null))
	testQueryClient.setQueryData(driveListingQueryKey({ variant: "sharedIn", uuid: a }), await fetchSharedListing("sharedIn", a, [a]))
	testQueryClient.setQueryData(driveListingQueryKey({ variant: "sharedIn", uuid: b }), await fetchSharedListing("sharedIn", b, [a, b]))
	vi.clearAllMocks()
}

describe("cachedDirectoryName", () => {
	it("reads a directory's decrypted name off any cached listing", () => {
		const [a, b, c] = [testUuid("a"), testUuid("b"), testUuid("c")]
		seedOwnedChain(a, b, c)

		expect(cachedDirectoryName(c)).toBe("C")
	})

	it("is undefined for an uncached uuid, a file row, and an undecryptable directory", () => {
		const file = testUuid("file")
		const locked = testUuid("locked")
		testQueryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: null }), [
			narrowItem(mockFile({ uuid: file })),
			narrowItem(mockDir({ uuid: locked, meta: { type: "encrypted", data: "x" } }))
		])

		expect(cachedDirectoryName(testUuid("missing"))).toBeUndefined()
		expect(cachedDirectoryName(file)).toBeUndefined()
		expect(cachedDirectoryName(locked)).toBeUndefined()
	})
})

describe("fetchDirectoryName", () => {
	it("owned click-through: every crumb resolves from cached listings with no worker call", async () => {
		const [a, b, c] = [testUuid("a"), testUuid("b"), testUuid("c")]
		seedOwnedChain(a, b, c)

		const names = await Promise.all([
			fetchDirectoryName("drive", [a]),
			fetchDirectoryName("drive", [a, b]),
			fetchDirectoryName("drive", [a, b, c])
		])

		expect(names).toEqual(["A", "B", "C"])
		expect(resolveDirectoryName).not.toHaveBeenCalled()
		expect(listDirectory).not.toHaveBeenCalled()
	})

	it("shared-in click-through: every crumb resolves from cached shared listings with no worker call", async () => {
		const [a, b, c] = [testUuid("sa"), testUuid("sb"), testUuid("sc")]
		await seedSharedInChain(a, b, c)

		const names = await Promise.all([
			fetchDirectoryName("sharedIn", [a]),
			fetchDirectoryName("sharedIn", [a, b]),
			fetchDirectoryName("sharedIn", [a, b, c])
		])

		expect(names).toEqual(["A", "B", "C"])
		expect(resolveDirectoryName).not.toHaveBeenCalled()
		expect(listSharedInRoot).not.toHaveBeenCalled()
		expect(listSharedDirectory).not.toHaveBeenCalled()
	})

	it("owned cold deep URL: exactly one owned lookup per uncached uuid, with no share hint", async () => {
		const [a, b, c] = [testUuid("a"), testUuid("b"), testUuid("c")]
		resolveDirectoryName.mockImplementation(uuid => Promise.resolve(`name-of-${uuid}`))

		await Promise.all([fetchDirectoryName("drive", [a]), fetchDirectoryName("drive", [a, b]), fetchDirectoryName("drive", [a, b, c])])

		expect(resolveDirectoryName).toHaveBeenCalledTimes(3)
		expect(resolveDirectoryName.mock.calls).toEqual([[a], [b], [c]])
	})

	it("shared cold deep URL: exactly one call per uncached uuid, each hinted with its own shared chain", async () => {
		const [a, b, c] = [testUuid("sa"), testUuid("sb"), testUuid("sc")]
		resolveDirectoryName.mockResolvedValue("name")

		await Promise.all([
			fetchDirectoryName("sharedIn", [a]),
			fetchDirectoryName("sharedIn", [a, b]),
			fetchDirectoryName("sharedOut", [a, b, c])
		])

		expect(resolveDirectoryName.mock.calls).toEqual([
			[a, { variant: "sharedIn", path: [a] }],
			[b, { variant: "sharedIn", path: [a, b] }],
			[c, { variant: "sharedOut", path: [a, b, c] }]
		])
	})

	it("a partially warm path only asks the worker for the crumb no listing holds", async () => {
		const [a, b, c] = [testUuid("a"), testUuid("b"), testUuid("c")]
		seedOwnedChain(a, b, c)
		const deeper = testUuid("d")
		resolveDirectoryName.mockResolvedValueOnce("D")

		const names = await Promise.all([a, b, c, deeper].map((_, index, path) => fetchDirectoryName("drive", path.slice(0, index + 1))))

		expect(names).toEqual(["A", "B", "C", "D"])
		expect(resolveDirectoryName).toHaveBeenCalledExactlyOnceWith(deeper)
	})

	it("an empty path resolves null without a worker call", async () => {
		await expect(fetchDirectoryName("drive", [])).resolves.toBeNull()
		expect(resolveDirectoryName).not.toHaveBeenCalled()
	})

	it("propagates a rejection from the worker unchanged", async () => {
		const error = new Error("no authenticated client")
		resolveDirectoryName.mockRejectedValueOnce(error)

		await expect(fetchDirectoryName("drive", ["uuid-a"])).rejects.toBe(error)
	})
})

// Reached by a deep link or a reveal, a directory's parent listing is often unread, so the breadcrumb's
// entry may be the only place its name already is.
describe("destinationDirectoryName", () => {
	it("prefers a cached listing row, which socket renames keep current", async () => {
		const [a, b, c] = [testUuid("a"), testUuid("b"), testUuid("c")]
		seedOwnedChain(a, b, c)
		testQueryClient.setQueryData(driveNamesQueryKey("drive", c), "Old C")

		await expect(destinationDirectoryName("drive", [a, b, c])).resolves.toBe("C")
		expect(resolveDirectoryName).not.toHaveBeenCalled()
	})

	it("uses the breadcrumb's resolved entry when no listing holds the directory", async () => {
		const [a, b, c] = [testUuid("a"), testUuid("b"), testUuid("c")]
		testQueryClient.setQueryData(driveNamesQueryKey("drive", c), "From the crumb")

		await expect(destinationDirectoryName("drive", [a, b, c])).resolves.toBe("From the crumb")
		expect(resolveDirectoryName).not.toHaveBeenCalled()
	})

	it("reads a shared directory's entry under its own scope", async () => {
		const [a, b] = [testUuid("sa"), testUuid("sb")]
		testQueryClient.setQueryData(driveNamesQueryKey("sharedOut", b), "Shared B")

		await expect(destinationDirectoryName("sharedOut", [a, b])).resolves.toBe("Shared B")
		expect(resolveDirectoryName).not.toHaveBeenCalled()
	})

	it("joins the breadcrumb's resolution while it is still under way instead of asking again", async () => {
		const [a, b] = [testUuid("a"), testUuid("b")]
		const worker = deferred<string | null>()
		resolveDirectoryName.mockReturnValueOnce(worker.promise)

		const crumb = testQueryClient.query({
			queryKey: driveNamesQueryKey("drive", b),
			queryFn: () => fetchDirectoryName("drive", [a, b])
		})
		const name = destinationDirectoryName("drive", [a, b])

		worker.resolve("B")

		await expect(name).resolves.toBe("B")
		await expect(crumb).resolves.toBe("B")
		expect(resolveDirectoryName).toHaveBeenCalledOnce()
	})

	it("asks the worker once when nothing holds the name yet", async () => {
		const [a, b] = [testUuid("a"), testUuid("b")]
		resolveDirectoryName.mockResolvedValueOnce("B")

		await expect(destinationDirectoryName("drive", [a, b])).resolves.toBe("B")
		expect(resolveDirectoryName).toHaveBeenCalledExactlyOnceWith(b)
	})

	it("an empty path resolves null without a worker call", async () => {
		await expect(destinationDirectoryName("drive", [])).resolves.toBeNull()
		expect(resolveDirectoryName).not.toHaveBeenCalled()
	})
})

describe("combineDirectoryNames", () => {
	const done = (data: string | null) => ({ status: "success" as const, data, error: null })
	const loading = { status: "pending" as const, data: undefined, error: null }

	it("maps every resolved uuid to its name and leaves an unresolved one out", () => {
		expect(combineDirectoryNames(["a", "b"], [done("A"), done(null)])).toEqual({ status: "success", data: { a: "A" }, error: null })
	})

	it("is pending while any crumb is still resolving", () => {
		expect(combineDirectoryNames(["a", "b"], [done("A"), loading]).status).toBe("pending")
	})

	it("surfaces the first error over any pending crumb", () => {
		const error = new Error("boom")

		expect(combineDirectoryNames(["a", "b"], [loading, { status: "error", data: undefined, error }])).toEqual({
			status: "error",
			data: undefined,
			error
		})
	})

	it("an empty path is an immediate empty success", () => {
		expect(combineDirectoryNames([], [])).toEqual({ status: "success", data: {}, error: null })
	})
})

describe("itemInfoQueryKey", () => {
	it("builds the [domain, entity, uuid] tuple", () => {
		expect(itemInfoQueryKey("abc")).toEqual(["drive", "itemInfo", "abc"])
	})
})

describe("itemPathQueryKey / fetchItemPath", () => {
	it("keys the reveal's ancestor-chain read under its own entry, not itemInfo's", () => {
		expect(itemPathQueryKey("abc")).toEqual(["drive", "itemPath", "abc"])
	})

	it("passes the item straight to sdkApi.getItemPath", async () => {
		const file = mockFile()
		const result = { path: "Documents/report.pdf", ancestors: [mockDir()] }
		getItemPath.mockResolvedValueOnce(result)

		await expect(fetchItemPath(file)).resolves.toEqual(result)
		expect(getItemPath).toHaveBeenCalledExactlyOnceWith(file)
	})

	it("propagates a rejection unchanged — a failed walk must never degrade to an empty chain here", async () => {
		const error = new Error("item has no navigable ancestry")
		getItemPath.mockRejectedValueOnce(error)

		await expect(fetchItemPath(mockFile())).rejects.toBe(error)
	})
})

describe("fetchItemInfo", () => {
	it("passes the item through to sdkApi.getItemInfo unchanged", async () => {
		const dir = mockDir()
		const result = { path: "Documents/", ancestors: [] }
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
		const result = { path: null, ancestors: [] }
		getItemInfo.mockResolvedValueOnce(result)

		await expect(fetchItemInfo(file)).resolves.toEqual(result)
	})
})

describe("fetchDirectorySize", () => {
	// An owned directory's AnyDirWithContext IS the bare Dir (item.ts's toAnyDirWithContext), so the
	// worker op receives it unchanged.
	it("dispatches an owned directory to sdkApi.getDirSize as its bare Dir", async () => {
		const item = narrowItem(mockDir())
		const result: DirSizeResponse = { size: 4_096n, files: 3n, dirs: 1n }
		getDirSize.mockResolvedValueOnce(result)

		if (item.type !== "directory") {
			throw new Error("expected a directory item")
		}

		await expect(fetchDirectorySize(item)).resolves.toEqual(result)
		expect(getDirSize).toHaveBeenCalledExactlyOnceWith(item.data)
	})

	it("propagates a rejection from sdkApi.getDirSize unchanged", async () => {
		const item = narrowItem(mockDir())
		const error = new Error("no authenticated client")
		getDirSize.mockRejectedValueOnce(error)

		if (item.type !== "directory") {
			throw new Error("expected a directory item")
		}

		await expect(fetchDirectorySize(item)).rejects.toBe(error)
	})
})

describe("invalidateDirectorySize", () => {
	// upload.ts's own trigger: a landed write into a directory stales that directory's cached
	// recursive size (see the export's own comment) — invalidateQueries marks it, it does not refetch
	// (no active per-row observer to refetch for — useDriveDirectorySizes prefetches only).
	it("marks a directory's cached dirSize entry stale", () => {
		const uuid = testUuid("dir")
		const queryKey = directorySizeQueryKey(uuid)
		testQueryClient.setQueryData(queryKey, { size: 1_000n, files: 1n, dirs: 0n })

		expect(testQueryClient.getQueryState(queryKey)?.isInvalidated).toBe(false)

		invalidateDirectorySize(uuid)

		expect(testQueryClient.getQueryState(queryKey)?.isInvalidated).toBe(true)
	})

	it("is a no-op for a null (root) parent — root has no dirSize entry of its own", () => {
		expect(() => {
			invalidateDirectorySize(null)
		}).not.toThrow()
	})
})

describe("useItemInfoQuery", () => {
	// The info dialog disables this query for a trashed item (getItemPath stalls on a
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
	it("leaves a listing nobody has read unread, never calling the updater", () => {
		const updater = vi.fn((prev: DriveItem[]) => [...prev, narrowItem(mockDir({ uuid: testUuid("new") }))])

		driveListingQueryUpdate(null, updater)

		expect(updater).not.toHaveBeenCalled()
		expect(testQueryClient.getQueryCache().find({ queryKey: driveListingQueryKey({ variant: "drive", uuid: null }) })).toBeUndefined()
	})

	it("targets the drive variant's key for the given parent uuid, leaving other parents untouched", () => {
		const otherParentKey = driveListingQueryKey({ variant: "drive", uuid: "other-parent" })
		testQueryClient.setQueryData(otherParentKey, [])
		testQueryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: "this-parent" }), [])
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

		driveListingQueryUpdateGlobal({
			type: "replace",
			uuid: target.data.uuid,
			replace: item => (item.type === "directory" ? { ...item, data: { ...item.data, favorited: true } } : item)
		})

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
		const namesKey = driveNamesQueryKey("drive", "a")
		const sortKey = ["drive", "sortPreferences"] as const
		testQueryClient.setQueryData(namesKey, "Documents")
		testQueryClient.setQueryData(sortKey, { mode: "global", global: "nameAsc", perDirectory: {} })

		driveListingQueryUpdateGlobal({ type: "remove", uuid: testUuid("absent") })

		expect(testQueryClient.getQueryData(namesKey)).toBe("Documents")
		expect(testQueryClient.getQueryData(sortKey)).toEqual({ mode: "global", global: "nameAsc", perDirectory: {} })
	})

	it("never conjures data into a listing key that was never fetched (no cached data yet)", () => {
		const unfetchedKey = driveListingQueryKey({ variant: "drive", uuid: "never-fetched" })
		// Registers the query in the cache (so findAll sees it) without ever giving it data — mirrors a
		// component that mounted a query that hasn't resolved yet.
		void testQueryClient.getQueryCache().build(testQueryClient, { queryKey: unfetchedKey })

		driveListingQueryUpdateGlobal({
			type: "replace",
			uuid: testUuid("new"),
			replace: () => narrowItem(mockDir({ uuid: testUuid("new") }))
		})

		expect(testQueryClient.getQueryData(unfetchedKey)).toBeUndefined()
	})

	it("takes the change a function picks per listing, and leaves one it picks none for as it was", () => {
		const moved = narrowItem(mockDir({ uuid: testUuid("moved") }))
		const renamed = narrowItem(mockDir({ uuid: testUuid("moved"), meta: { type: "decoded", data: { name: "Renamed" } } }))
		const driveKey = driveListingQueryKey({ variant: "drive", uuid: "parent" })
		const favoritesKey = driveListingQueryKey({ variant: "favorites", uuid: null })
		const sharedKey = driveListingQueryKey({ variant: "sharedOut", uuid: null })
		testQueryClient.setQueryData(driveKey, [moved])
		testQueryClient.setQueryData(favoritesKey, [moved])
		testQueryClient.setQueryData(sharedKey, [moved])

		driveListingQueryUpdateGlobal(({ variant }) => {
			switch (variant) {
				case "drive":
					return { type: "remove", uuid: moved.data.uuid }
				case "favorites":
					return { type: "replace", uuid: moved.data.uuid, replace: () => renamed }
				default:
					return undefined
			}
		})

		expect(testQueryClient.getQueryData(driveKey)).toEqual([])
		expect(testQueryClient.getQueryData(favoritesKey)).toEqual([renamed])
		expect(testQueryClient.getQueryData(sharedKey)).toEqual([moved])
	})

	it("applies the same updater independently per key (a filter can remove from one listing and keep another)", () => {
		const keep = narrowItem(mockDir({ uuid: testUuid("keep") }))
		const drop = narrowItem(mockDir({ uuid: testUuid("drop") }))
		const keyA = driveListingQueryKey({ variant: "drive", uuid: null })
		const keyB = driveListingQueryKey({ variant: "trash", uuid: null })
		testQueryClient.setQueryData(keyA, [keep, drop])
		testQueryClient.setQueryData(keyB, [drop])

		driveListingQueryUpdateGlobal({ type: "remove", uuid: drop.data.uuid })

		expect(testQueryClient.getQueryData(keyA)).toEqual([keep])
		expect(testQueryClient.getQueryData(keyB)).toEqual([])
	})

	// A cancelled read reverts and never retries on its own; the read applies the patch to what it
	// returns instead (driveListingRequestCount.test.ts).
	it("never cancels a read under way, on a listing it changes or not", async () => {
		const drop = narrowItem(mockDir({ uuid: testUuid("drop") }))
		const affected = driveListingQueryKey({ variant: "drive", uuid: null })
		const read = deferred<DriveItem[]>()
		testQueryClient.setQueryData(affected, [drop])
		const refetch = testQueryClient.query({ queryKey: affected, queryFn: () => read.promise, staleTime: 0 })

		driveListingQueryUpdateGlobal({ type: "remove", uuid: drop.data.uuid })

		expect(testQueryClient.getQueryState(affected)?.fetchStatus).toBe("fetching")
		expect(testQueryClient.getQueryData(affected)).toEqual([])

		read.resolve([])
		await refetch
	})

	it("keeps a pending refresh pending on a listing it writes", () => {
		const drop = narrowItem(mockDir({ uuid: testUuid("drop") }))
		const key = driveListingQueryKey({ variant: "drive", uuid: null })
		testQueryClient.setQueryData(key, [drop])
		void testQueryClient.invalidateQueries({ queryKey: key, refetchType: "none" })

		driveListingQueryUpdateGlobal({ type: "remove", uuid: drop.data.uuid })

		expect(testQueryClient.getQueryData(key)).toEqual([])
		expect(testQueryClient.getQueryState(key)?.isInvalidated).toBe(true)
	})

	it("does not write to a listing the updater left unchanged", () => {
		const untouched = driveListingQueryKey({ variant: "favorites", uuid: null })
		testQueryClient.setQueryData(untouched, [narrowItem(mockDir({ uuid: testUuid("other") }))])
		const setSpy = vi.spyOn(testQueryClient, "setQueryData")

		driveListingQueryUpdateGlobal({ type: "remove", uuid: testUuid("absent") })
		driveListingQueryUpdateGlobal({ type: "replace", uuid: testUuid("other"), replace: row => row })

		expect(setSpy).not.toHaveBeenCalled()
	})
})

describe("listing patch lookups", () => {
	// Q grows with every persisted row and every dirSize entry a listing prefetches, and a patch per
	// created file used to copy and re-hash all of it, even for a listing nobody had read.
	it("finds a patched listing by its key's hash, never by scanning the query cache", () => {
		const key = driveListingQueryKey({ variant: "drive", uuid: "parent" })
		const created = narrowItem(mockDir({ uuid: testUuid("new") }))
		testQueryClient.setQueryData(key, [])

		for (let i = 0; i < 20; i++) {
			testQueryClient.setQueryData(directorySizeQueryKey(`dir-${String(i)}`), { size: 0n, files: 0n, dirs: 0n })
		}

		const scan = vi.spyOn(testQueryClient.getQueryCache(), "getAll")

		driveListingQueryUpdate("parent", prev => [...prev, created])
		driveListingQueryUpdate("never-read", prev => [...prev, created])
		flatListingQueryUpdate("recents", prev => [...prev, created])

		expect(scan).not.toHaveBeenCalled()
		expect(testQueryClient.getQueryData(key)).toEqual([created])
	})

	it("keeps a pending refresh pending on the listing it writes", () => {
		const key = driveListingQueryKey({ variant: "drive", uuid: "parent" })
		testQueryClient.setQueryData(key, [])
		void testQueryClient.invalidateQueries({ queryKey: key, refetchType: "none" })

		driveListingQueryUpdate("parent", prev => [...prev, narrowItem(mockDir({ uuid: testUuid("new") }))])

		expect(testQueryClient.getQueryState(key)?.isInvalidated).toBe(true)
	})
})

// A read applies the changes that landed while it ran to what it returns.
describe("applyListingChanges", () => {
	function meta(name: string): File["meta"] {
		return { type: "decoded", data: { name, mime: "text/plain", modified: 1n, size: 1n, key: "key", version: 2 } }
	}

	// A file row under the uuid of its label, named after it unless given a name.
	function row(label: string, name: string = label): DriveItem {
		return narrowItem(mockFile({ uuid: testUuid(label), meta: meta(name) }))
	}

	function renamed(name: string): (item: DriveItem) => DriveItem {
		return item => (item.type === "file" ? narrowItem({ ...item.data, meta: meta(name) }) : item)
	}

	function suffixed(suffix: string): (item: DriveItem) => DriveItem {
		return item => renamed(`${item.data.decryptedMeta?.name ?? ""}${suffix}`)(item)
	}

	function names(items: DriveItem[]): (string | undefined)[] {
		return items.map(item => item.data.decryptedMeta?.name)
	}

	// Each change on its own, as the shared list helpers apply it.
	function oneByOne(items: DriveItem[], changes: readonly ListingChange[]): DriveItem[] {
		let result = items

		for (const change of changes) {
			switch (change.type) {
				case "remove":
					result = removeByUuid(result, change.uuid)
					break
				case "replace":
					result = result.map(item => (item.data.uuid === change.uuid ? change.replace(item) : item))
					break
				case "upsert":
					result = change.items.reduce(upsertItem, result)
					break
				case "append":
					result = change.items.reduce((list, item) => applyMembershipPatch(list, item, true), result)
					break
				case "update":
					result = change.update(result)
					break
			}
		}

		return result
	}

	it.each<[string, DriveItem[], ListingChange[], string[]]>([
		[
			"a row removed and upserted again ends last",
			[row("a"), row("b")],
			[
				{ type: "remove", uuid: testUuid("a") },
				{ type: "upsert", items: [row("a")] }
			],
			["b", "a"]
		],
		[
			"an upserted row removed later still kept its name's row out",
			[row("x", "n")],
			[
				{ type: "upsert", items: [row("y", "n")] },
				{ type: "remove", uuid: testUuid("y") }
			],
			[]
		],
		[
			"a row renamed after an upsert into its name stays beside it",
			[row("x", "a")],
			[
				{ type: "upsert", items: [row("y", "b")] },
				{ type: "replace", uuid: testUuid("x"), replace: renamed("b") }
			],
			["b", "b"]
		],
		[
			"a row renamed before an upsert into its name makes way",
			[row("x", "a")],
			[
				{ type: "replace", uuid: testUuid("x"), replace: renamed("b") },
				{ type: "upsert", items: [row("y", "b")] }
			],
			["b"]
		],
		[
			"an appended row changed later keeps its place",
			[row("p"), row("a", "old")],
			[
				{ type: "append", items: [row("a", "new"), row("q")] },
				{ type: "replace", uuid: testUuid("a"), replace: renamed("newer") }
			],
			["p", "newer", "q"]
		],
		[
			"a row appended, removed and appended again ends last",
			[row("a"), row("p")],
			[
				{ type: "append", items: [row("a", "first")] },
				{ type: "remove", uuid: testUuid("a") },
				{ type: "append", items: [row("a", "second")] }
			],
			["p", "second"]
		],
		[
			"replacements of one row apply in order",
			[row("x", "x")],
			[
				{ type: "replace", uuid: testUuid("x"), replace: suffixed("-one") },
				{ type: "replace", uuid: testUuid("x"), replace: suffixed("-two") }
			],
			["x-one-two"]
		],
		[
			"an update applies after the changes before it and before the ones after it",
			[row("a"), row("b")],
			[
				{ type: "remove", uuid: testUuid("a") },
				{ type: "update", update: items => [...items, row("c")] },
				{ type: "remove", uuid: testUuid("c") }
			],
			["b"]
		],
		[
			"upserts and appends keep their order",
			[row("p")],
			[
				{ type: "upsert", items: [row("u")] },
				{ type: "append", items: [row("v")] },
				{ type: "upsert", items: [row("w")] }
			],
			["p", "u", "v", "w"]
		]
	])("%s", (_label, items, changes, expected) => {
		expect(names(applyListingChanges(items, changes))).toEqual(expected)
		expect(applyListingChanges(items, changes)).toEqual(oneByOne(items, changes))
	})

	it("applies only the changes from the given index", () => {
		const changes: ListingChange[] = [
			{ type: "remove", uuid: testUuid("a") },
			{ type: "remove", uuid: testUuid("b") }
		]

		expect(names(applyListingChanges([row("a"), row("b")], changes, 1))).toEqual(["a"])
	})

	// Seeded, so a failing run reproduces.
	it("lands every random burst as it would one change at a time", () => {
		let seed = 7

		const random = (): number => {
			seed = (seed + 0x6d2b79f5) | 0

			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)

			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

			return ((t ^ (t >>> 14)) >>> 0) / 4294967296
		}

		const pick = <T>(values: readonly T[]): T => {
			const value = values[Math.floor(random() * values.length)]

			if (value === undefined) {
				throw new Error("empty pool")
			}

			return value
		}

		const labels = ["a", "b", "c", "d", "e", "f"]
		// Case and spacing variants collide as one name.
		const pool = ["one", "One ", "two", "three"]
		const randomRow = (): DriveItem => row(pick(labels), pick(pool))
		const randomRows = (): DriveItem[] => (random() < 0.5 ? [randomRow()] : [randomRow(), randomRow()])

		const randomChange = (): ListingChange => {
			switch (pick(["remove", "replace", "upsert", "append", "update"])) {
				case "remove":
					return { type: "remove", uuid: testUuid(pick(labels)) }
				case "replace":
					return { type: "replace", uuid: testUuid(pick(labels)), replace: renamed(pick(pool)) }
				case "upsert":
					return { type: "upsert", items: randomRows() }
				case "append":
					return { type: "append", items: randomRows() }
				default:
					return { type: "update", update: items => [...items].reverse() }
			}
		}

		for (let run = 0; run < 2000; run++) {
			const items = labels.filter(() => random() < 0.6).map(label => row(label, pick(pool)))
			const changes = Array.from({ length: Math.floor(random() * 10) }, randomChange)

			expect(applyListingChanges(items, changes), `run ${String(run)}`).toEqual(oneByOne(items, changes))
		}
	})

	// Each change used to take its own pass over every row: a burst of k changes to n rows cost O(k·n)
	// in one task as the read settled.
	it("reads each row a bounded number of times, however many changes land", () => {
		let visits = 0

		const rows = Array.from({ length: 1000 }, (_, index) => {
			const item = row(`row${String(index)}`, `${String(index)}.txt`)
			const data = item.data

			Object.defineProperty(item, "data", {
				enumerable: true,
				get: () => {
					visits++

					return data
				}
			})

			return item
		})

		const changes: ListingChange[] = []

		for (let index = 0; index < 300; index++) {
			changes.push({ type: "remove", uuid: testUuid(`row${String(index * 3)}`) })
		}

		for (let index = 0; index < 100; index++) {
			changes.push({ type: "replace", uuid: testUuid(`row${String(index * 3 + 1)}`), replace: renamed("renamed.txt") })
		}

		for (let index = 0; index < 10; index++) {
			changes.push({ type: "upsert", items: [row(`new${String(index)}`)] })
		}

		const result = applyListingChanges(rows, changes)

		expect(visits).toBeLessThan(5 * rows.length)
		expect(result).toHaveLength(1000 - 300 + 10)
	})
})

describe("queueListingCreate", () => {
	// Named `${name}.txt`, under the uuid of its own label unless given another.
	function namedFile(name: string, uuid: UuidStr = testUuid(name)): DriveItem {
		return narrowItem(
			mockFile({
				uuid,
				meta: {
					type: "decoded",
					data: { name: `${name}.txt`, mime: "text/plain", modified: 1_700_000_000_000n, size: 1n, key: "key", version: 2 }
				}
			})
		)
	}

	function uuids(uuid: string | null, variant: "drive" | "recents" = "drive"): string[] | undefined {
		return testQueryClient
			.getQueryData<DriveItem[]>(driveListingQueryKey({ variant, uuid: variant === "drive" ? uuid : null }))
			?.map(item => item.data.uuid)
	}

	// A copy reports each top-level item and its socket echo repeats it; each used to rewrite and
	// re-render the whole listing on its own.
	it("lands what a window queued for a parent in one write, a re-delivered item once", () => {
		vi.useFakeTimers()

		const key = driveListingQueryKey({ variant: "drive", uuid: "parent" })
		const [a, b] = [namedFile("a"), namedFile("b")]
		testQueryClient.setQueryData(key, [])
		const write = vi.spyOn(testQueryClient, "setQueryData")

		queueListingCreate("parent", a)
		queueListingCreate("parent", b)
		queueListingCreate("parent", a)

		expect(uuids("parent")).toEqual([])

		vi.advanceTimersByTime(LISTING_CREATE_FLUSH_MS)

		expect(write).toHaveBeenCalledOnce()
		expect(uuids("parent")).toEqual([a.data.uuid, b.data.uuid])
	})

	it("replaces a same-name row the way a single upsert does", () => {
		const key = driveListingQueryKey({ variant: "drive", uuid: "parent" })
		const stale = namedFile("a", testUuid("stale"))
		const fresh = namedFile("a")
		testQueryClient.setQueryData(key, [stale])

		queueListingCreate("parent", fresh)
		flushListingCreates()

		expect(uuids("parent")).toEqual([fresh.data.uuid])
	})

	it("never creates a listing nobody has read", () => {
		queueListingCreate("cold", namedFile("a"))
		flushListingCreates()

		expect(testQueryClient.getQueryCache().find({ queryKey: driveListingQueryKey({ variant: "drive", uuid: "cold" }) })).toBeUndefined()
	})

	it("adds a new file to Recents with its batch, deduplicated by uuid alone", () => {
		const sameName = namedFile("a", testUuid("elsewhere"))
		const created = namedFile("a")
		testQueryClient.setQueryData(driveListingQueryKey({ variant: "recents", uuid: null }), [sameName, created])

		queueListingCreate("parent", created, { recent: true })
		queueListingCreate("parent", namedFile("b"))
		flushListingCreates()

		expect(uuids(null, "recents")).toEqual([sameName.data.uuid, created.data.uuid])
	})

	// A file trashed or moved moments after its create must not come back when the window closes.
	it("is applied before any other patch, so nothing that patch removes comes back", () => {
		vi.useFakeTimers()

		const key = driveListingQueryKey({ variant: "drive", uuid: "parent" })
		const created = namedFile("a")
		testQueryClient.setQueryData(key, [])

		queueListingCreate("parent", created)
		driveListingQueryUpdateGlobal({ type: "remove", uuid: created.data.uuid })
		vi.advanceTimersByTime(LISTING_CREATE_FLUSH_MS)

		expect(uuids("parent")).toEqual([])
	})

	it("drops what is queued on logout", () => {
		vi.useFakeTimers()

		const key = driveListingQueryKey({ variant: "drive", uuid: "parent" })
		testQueryClient.setQueryData(key, [])

		queueListingCreate("parent", namedFile("a"))
		discardListingPatches()
		vi.advanceTimersByTime(LISTING_CREATE_FLUSH_MS)
		flushListingCreates()

		expect(uuids("parent")).toEqual([])
	})
})

describe("markDriveListingStale", () => {
	it("marks a read listing for its next mount or focus without writing it", () => {
		const key = driveListingQueryKey({ variant: "drive", uuid: "parent" })
		const rows = [narrowItem(mockDir())]
		testQueryClient.setQueryData(key, rows)

		markDriveListingStale("parent")

		expect(testQueryClient.getQueryState(key)?.isInvalidated).toBe(true)
		expect(testQueryClient.getQueryData(key)).toBe(rows)
	})

	it("leaves a listing nobody has read alone", () => {
		markDriveListingStale("cold")

		expect(testQueryClient.getQueryCache().find({ queryKey: driveListingQueryKey({ variant: "drive", uuid: "cold" }) })).toBeUndefined()
	})
})

describe("findCachedListingItem", () => {
	it("finds the row in whichever cached listing holds it, whatever the variant", () => {
		const item = narrowItem(mockFile({ uuid: testUuid("wanted") }))
		testQueryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: null }), [narrowItem(mockDir())])
		testQueryClient.setQueryData(driveListingQueryKey({ variant: "recents", uuid: null }), [item])

		expect(findCachedListingItem(testUuid("wanted"))).toBe(item)
	})

	it("resolves undefined when no cached listing holds the uuid", () => {
		testQueryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: null }), [narrowItem(mockDir())])

		expect(findCachedListingItem(testUuid("absent"))).toBeUndefined()
	})

	it("ignores a listing key that was registered but never fetched", () => {
		void testQueryClient.getQueryCache().build(testQueryClient, { queryKey: driveListingQueryKey({ variant: "drive", uuid: "cold" }) })

		expect(findCachedListingItem(testUuid("absent"))).toBeUndefined()
	})
})

describe("findOwnedListingItem", () => {
	const wanted = testUuid("wanted")

	// Read from the server under the live socket, so every event since has reached its rows.
	async function readListing(variant: "drive" | "favorites", uuid: string | null, dirs: Dir[]): Promise<void> {
		socketAuthenticated()
		listDirectory.mockResolvedValueOnce({ dirs, files: [] })

		await testQueryClient.query(driveListingQueryOptions(variant, uuid))
	}

	it("prefers the row a current listing holds over one an unread listing, cached first, holds", async () => {
		testQueryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: "parent" }), [
			narrowItem(mockDir({ uuid: wanted, color: "red" }))
		])
		await readListing("favorites", null, [mockDir({ uuid: wanted, color: "blue", favorited: true })])

		const found = findOwnedListingItem(wanted)

		expect(found?.current).toBe(true)
		expect(found?.item.type === "directory" ? found.item.data.color : undefined).toBe("blue")
	})

	it("falls back to an unread listing's row as not current", () => {
		const outdated = narrowItem(mockDir({ uuid: wanted }))

		testQueryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: "parent" }), [outdated])

		expect(findOwnedListingItem(wanted)).toEqual({ item: outdated, current: false })
	})

	it("passes over a shared row for the owned one another listing holds", () => {
		const owned = narrowItem(mockDir({ uuid: wanted }))

		testQueryClient.setQueryData(driveListingQueryKey({ variant: "sharedOut", uuid: null }), [narrowItem(mockSharedRootDir(wanted))])
		testQueryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: "parent" }), [owned])

		expect(findOwnedListingItem(wanted)?.item).toBe(owned)
	})

	it("finds a row still queued to land", () => {
		testQueryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: "parent" }), [])
		queueListingCreate("parent", narrowItem(mockDir({ uuid: wanted })))

		expect(findOwnedListingItem(wanted)?.item.data.uuid).toBe(wanted)
	})

	it("a flat listing marked stale, before or during its read, stops counting as current until a clean read", async () => {
		await readListing("favorites", null, [mockDir({ uuid: wanted, favorited: true })])

		expect(findOwnedListingItem(wanted)?.current).toBe(true)

		markFlatListingStale("favorites")

		expect(findOwnedListingItem(wanted)?.current).toBe(false)

		const pending = deferred<NormalDirsAndFiles>()

		listDirectory.mockReturnValueOnce(pending.promise)

		const read = testQueryClient.query(driveListingQueryOptions("favorites", null))

		markFlatListingStale("favorites")
		pending.resolve({ dirs: [mockDir({ uuid: wanted, favorited: true })], files: [] })
		await read

		expect(findOwnedListingItem(wanted)?.current).toBe(false)

		await readListing("favorites", null, [mockDir({ uuid: wanted, favorited: true })])

		expect(findOwnedListingItem(wanted)?.current).toBe(true)
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

	it.each(["recents", "favorites", "trash", "links"] as const)("maps the flat %s variant to its own kind, ignoring uuid", variant => {
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
		sharedTag: true,
		canMakeThumbnail: false
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

		const items = await fetchSharedListing("sharedIn", "parent-uuid", ["ancestor-uuid", "parent-uuid"])

		expect(listSharedDirectory).toHaveBeenCalledExactlyOnceWith("parent-uuid", {
			variant: "sharedIn",
			path: ["ancestor-uuid", "parent-uuid"]
		})
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

	it("a root listing (uuid null) never sends a path hint", async () => {
		listSharedInRoot.mockResolvedValueOnce({ dirs: [], files: [] })

		await fetchSharedListing("sharedIn", null, ["ignored-uuid"])

		expect(listSharedDirectory).not.toHaveBeenCalled()
	})
})
