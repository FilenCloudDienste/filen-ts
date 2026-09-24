// Drive cache hygiene against a REAL QueryClient and the real listing helpers, socket create batcher,
// Recents deferral and drive socket handler: counts listing writes, camera-upload config reads and
// SDK listing calls for a copy-sized storm of create echoes, and checks the Photos gap when a directory
// leaves the camera-upload tree. The SDK boundary is spied; nothing in here may fetch.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const h = vi.hoisted(() => {
	type Item = { type: string; data: { uuid: string; parent: string | null; decryptedMeta: { name: string } | null } }

	return {
		sdk: {
			listDir: vi.fn(),
			listRecents: vi.fn(),
			listDirRecursive: vi.fn()
		},
		getConfig: vi.fn(),
		markDirectorySizesStale: vi.fn(),
		fakeCache: {
			rootUuid: "root" as string | null,
			uuidToAnyDriveItem: new Map<string, Item>(),
			fileUuidToNormalFile: new Map<string, Item["data"]>(),
			directoryUuidToAnyNormalDir: new Map<string, { tag: string; inner: [Item["data"]] }>(),
			cacheDriveItem(item: Item) {
				this.uuidToAnyDriveItem.set(item.data.uuid, item)

				if (item.type === "directory") {
					this.directoryUuidToAnyNormalDir.set(item.data.uuid, { tag: "Dir", inner: [item.data] })
				} else {
					this.fileUuidToNormalFile.set(item.data.uuid, item.data)
				}
			},
			cacheDriveItemReference(item: Item) {
				this.uuidToAnyDriveItem.set(item.data.uuid, item)
			},
			cacheNewFile(file: Item["data"], item: Item) {
				this.uuidToAnyDriveItem.set(file.uuid, item)
				this.fileUuidToNormalFile.set(file.uuid, file)
			},
			cacheNewNormalDir(dir: Item["data"], item: Item) {
				this.uuidToAnyDriveItem.set(dir.uuid, item)
				this.directoryUuidToAnyNormalDir.set(dir.uuid, { tag: "Dir", inner: [dir] })
			},
			forgetItem(uuid: string) {
				this.uuidToAnyDriveItem.delete(uuid)
				this.fileUuidToNormalFile.delete(uuid)
				this.directoryUuidToAnyNormalDir.delete(uuid)
			}
		}
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("expo-router", () => ({ useLocalSearchParams: vi.fn(), useNavigation: vi.fn() }))

vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir_Tags: { Dir: "Dir", Root: "Root" },
	AnyNormalDir: {},
	AnyDirWithContext: {},
	AnySharedDir: {},
	AnySharedDirWithContext: {},
	AnyLinkedDir: {},
	NonRootDir_Tags: {},
	NonRootItem_Tags: { File: "File", NormalDir: "NormalDir" },
	SharingRole: {},
	ErrorKind: {},
	SocketEvent_Tags: { Drive: "Drive" },
	DriveEvent_Tags: {
		FileArchiveRestored: "FileArchiveRestored",
		FileRestore: "FileRestore",
		FileNew: "FileNew",
		FileArchived: "FileArchived",
		FileDeletedPermanent: "FileDeletedPermanent",
		FolderDeletedPermanent: "FolderDeletedPermanent",
		FileMetadataChanged: "FileMetadataChanged",
		FileMove: "FileMove",
		FolderMove: "FolderMove",
		FolderMetadataChanged: "FolderMetadataChanged",
		FileTrash: "FileTrash",
		FolderTrash: "FolderTrash",
		FolderColorChanged: "FolderColorChanged",
		FolderRestore: "FolderRestore",
		FolderSubCreated: "FolderSubCreated",
		ItemFavorite: "ItemFavorite",
		TrashEmpty: "TrashEmpty",
		DeleteAll: "DeleteAll",
		DeleteVersioned: "DeleteVersioned"
	}
}))

vi.mock("@/lib/auth", () => ({ default: { getSdkClients: async () => ({ authedSdkClient: h.sdk }) } }))
vi.mock("@/lib/cache", () => ({ default: h.fakeCache }))
vi.mock("@/features/cameraUpload/cameraUpload", () => ({ default: { getConfig: h.getConfig } }))
vi.mock("@/features/cameraUpload/remoteListing", () => ({ listCameraUploadRemote: vi.fn(), remoteWalkDropsEntries: vi.fn() }))
vi.mock("@/features/offline/offline", () => ({ default: {} }))
vi.mock("@/features/drive/utils", () => ({ linkPasswordState: vi.fn() }))
vi.mock("@/features/drive/driveMetadata", () => ({ favoritesListingUpdater: vi.fn() }))
vi.mock("@/features/drive/queries/useDirectorySize.query", () => ({ markDirectorySizesStale: h.markDirectorySizesStale }))
vi.mock("@/lib/sdkErrors", () => ({ unwrapSdkError: vi.fn() }))
vi.mock("@/hooks/useDrivePath", () => ({
	DRIVE_PATH_TYPES: ["drive", "sharedIn", "recents", "favorites", "trash", "sharedOut", "offline", "links", "photos", "linked"]
}))

// Raw socket payloads here are already item-shaped: `{ uuid, parent, name }`.
vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapParentUuid: (parent: unknown) => (typeof parent === "string" ? parent : null),
	unwrapFileMeta: (file: unknown) => file,
	unwrapDirMeta: (dir: unknown) => dir,
	unwrappedFileIntoDriveItem: (file: { uuid: string; parent: string; name: string }) => ({
		type: "file",
		data: { uuid: file.uuid, parent: file.parent, decryptedMeta: { name: file.name } }
	}),
	unwrappedDirIntoDriveItem: (dir: { uuid: string; parent: string; name: string }) => ({
		type: "directory",
		data: { uuid: dir.uuid, parent: dir.parent, decryptedMeta: { name: dir.name } }
	})
}))

// The real TanStack client, minus the SQLite persister; queryUpdater.set is spied to count writes.
vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	const set = vi.fn((queryKey: unknown[], data: unknown) => queryClient.setQueryData(queryKey, data))

	return {
		default: queryClient,
		queryClient,
		DEFAULT_QUERY_OPTIONS: {},
		queryUpdater: {
			get: (queryKey: unknown[]) => queryClient.getQueryData(queryKey),
			set
		},
		preserveArrayIdentity: <T>(prev: T[], next: T[]): T[] =>
			prev.length === next.length && prev.every((item, i) => item === next[i]) ? prev : next
	}
})

import { queryClient, queryUpdater } from "@/queries/client"
import { driveItemsQueryKey, driveItemsQueryRemoveDirectoryFromPhotos, driveItemsQueryUpdateForNormalParent } from "@/features/drive/queries/useDriveItems.query"
import socketCreateBatcher, { SOCKET_CREATE_FLUSH_MS } from "@/features/drive/socketCreateBatcher"
import copyActivity from "@/features/drive/copyActivity"
import { handleDriveEvent, type DriveSocketEvent } from "@/features/drive/socketHandlers"
import type { DriveItem } from "@/types"

const CAMERA_ROOT = "camroot"

type Params = Parameters<typeof driveItemsQueryKey>[0]

const driveKey = (uuid: string | null) => driveItemsQueryKey({ path: { type: "drive", uuid } } as Params)
const recentsKey = driveItemsQueryKey({ path: { type: "recents", uuid: null } } as Params)
const photosKey = driveItemsQueryKey({ path: { type: "photos", uuid: CAMERA_ROOT } } as Params)

function file(uuid: string, parent: string, name = uuid): DriveItem {
	return { type: "file", data: { uuid, parent, decryptedMeta: { name } } } as unknown as DriveItem
}

function event(tag: string, inner: unknown): DriveSocketEvent {
	return { tag: "Drive", inner: [{ inner: { tag, inner: [inner] } }] } as unknown as DriveSocketEvent
}

function listing(key: unknown[]): DriveItem[] | undefined {
	return queryClient.getQueryData<DriveItem[]>(key)
}

function writesTo(key: unknown[]): number {
	const hash = JSON.stringify(key)

	return vi.mocked(queryUpdater.set).mock.calls.filter(call => JSON.stringify(call[0]) === hash).length
}

function allWrites(): number {
	return vi.mocked(queryUpdater.set).mock.calls.length
}

// Lets the batch timer fire and the one camera-upload config read settle.
async function flushWindow(): Promise<void> {
	await vi.advanceTimersByTimeAsync(SOCKET_CREATE_FLUSH_MS)
	await vi.advanceTimersByTimeAsync(0)
}

function seedCacheDir(uuid: string, parent: string, tag = "Dir"): void {
	h.fakeCache.directoryUuidToAnyNormalDir.set(uuid, {
		tag,
		inner: [{ uuid, parent, decryptedMeta: { name: uuid } }]
	})
}

beforeEach(() => {
	vi.useFakeTimers()
	queryClient.clear()
	vi.mocked(queryUpdater.set).mockClear()
	h.getConfig.mockReset().mockResolvedValue({ enabled: true, remoteDir: { inner: [{ uuid: CAMERA_ROOT }] } })
	h.markDirectorySizesStale.mockClear()
	h.sdk.listDir.mockClear()
	h.sdk.listRecents.mockClear()
	h.sdk.listDirRecursive.mockClear()
	h.fakeCache.uuidToAnyDriveItem.clear()
	h.fakeCache.fileUuidToNormalFile.clear()
	h.fakeCache.directoryUuidToAnyNormalDir.clear()
	h.fakeCache.rootUuid = "root"

	while (copyActivity.isActive()) {
		copyActivity.end()
	}
})

afterEach(() => {
	socketCreateBatcher.flushNow()
	vi.useRealTimers()
})

describe("socket create storm (a copy of 40 directories × 25 files plus 5k top-level files)", () => {
	function replayStorm(): void {
		for (let d = 0; d < 40; d++) {
			void handleDriveEvent({ event: event("FolderSubCreated", { dir: { uuid: `d${d}`, parent: "dest", name: `dir ${d}` } }) })

			for (let f = 0; f < 25; f++) {
				void handleDriveEvent({ event: event("FileNew", { file: { uuid: `d${d}f${f}`, parent: `d${d}`, name: `f${f}` } }) })
			}
		}

		for (let f = 0; f < 5000; f++) {
			void handleDriveEvent({ event: event("FileNew", { file: { uuid: `top${f}`, parent: "dest", name: `top ${f}` } }) })
		}
	}

	it("writes each read listing once per window, creates no listing, fetches nothing", async () => {
		queryClient.setQueryData(driveKey("dest"), [file("existing", "dest")])
		queryClient.setQueryData(recentsKey, [])

		replayStorm()

		// Nothing is written until the window closes.
		expect(allWrites()).toBe(0)

		await flushWindow()

		expect(writesTo(driveKey("dest"))).toBe(1)
		expect(writesTo(recentsKey)).toBe(1)
		// The 40 new directories were never read: no listing appears for them.
		for (let d = 0; d < 40; d++) {
			expect(listing(driveKey(`d${d}`))).toBeUndefined()
		}
		// Photos was never read either.
		expect(listing(photosKey)).toBeUndefined()
		expect(allWrites()).toBe(2)
		expect(listing(driveKey("dest"))).toHaveLength(1 + 40 + 5000)
		expect(listing(recentsKey)).toHaveLength(40 * 25 + 5000)
		expect(h.getConfig).toHaveBeenCalledTimes(1)
		expect(h.markDirectorySizesStale).toHaveBeenCalledTimes(1)
		expect(h.sdk.listDir).not.toHaveBeenCalled()
		expect(h.sdk.listRecents).not.toHaveBeenCalled()
		expect(h.sdk.listDirRecursive).not.toHaveBeenCalled()
	})

	it("while a copy runs: Recents is not patched but invalidated once at the end; files under unread listings stay out of memory", async () => {
		queryClient.setQueryData(driveKey("dest"), [])
		queryClient.setQueryData(recentsKey, [])

		const invalidate = vi.spyOn(queryClient, "invalidateQueries")

		copyActivity.begin()
		replayStorm()
		await flushWindow()

		expect(writesTo(recentsKey)).toBe(0)
		expect(invalidate).not.toHaveBeenCalled()
		// Directories are always kept (navigation, ancestry walks); files only under a read listing.
		expect(h.fakeCache.directoryUuidToAnyNormalDir.has("d7")).toBe(true)
		expect(h.fakeCache.fileUuidToNormalFile.has("d7f3")).toBe(false)
		expect(h.fakeCache.fileUuidToNormalFile.has("top42")).toBe(true)

		copyActivity.end()

		expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: recentsKey, exact: true, refetchType: "active" })
		expect(h.sdk.listRecents).not.toHaveBeenCalled()

		invalidate.mockRestore()
	})

	it("windows apart, each flush writes once more", async () => {
		queryClient.setQueryData(driveKey("dest"), [])

		void handleDriveEvent({ event: event("FileNew", { file: { uuid: "a", parent: "dest", name: "a" } }) })
		await flushWindow()
		void handleDriveEvent({ event: event("FileNew", { file: { uuid: "b", parent: "dest", name: "b" } }) })
		await flushWindow()

		expect(writesTo(driveKey("dest"))).toBe(2)
		expect(h.getConfig).toHaveBeenCalledTimes(2)
	})

	it("a trash arriving inside the window lands after the create it follows", async () => {
		queryClient.setQueryData(driveKey("dest"), [])

		await handleDriveEvent({ event: event("FileNew", { file: { uuid: "doomed", parent: "dest", name: "doomed" } }) })
		await handleDriveEvent({ event: event("FileTrash", { uuid: "doomed" }) })
		await flushWindow()

		expect(listing(driveKey("dest"))).toEqual([])
	})

	it("new files under the camera-upload root reach a read Photos grid in one write", async () => {
		seedCacheDir("album", CAMERA_ROOT)
		queryClient.setQueryData(photosKey, [])

		for (let f = 0; f < 50; f++) {
			void handleDriveEvent({ event: event("FileNew", { file: { uuid: `p${f}`, parent: "album", name: `p${f}` } }) })
		}

		void handleDriveEvent({ event: event("FileNew", { file: { uuid: "elsewhere", parent: "unrelated", name: "x" } }) })
		await flushWindow()

		expect(writesTo(photosKey)).toBe(1)
		expect(listing(photosKey)).toHaveLength(50)
		expect(h.getConfig).toHaveBeenCalledTimes(1)
	})
})

describe("local writes patch only read listings", () => {
	it("an upload or new directory into a directory nobody has read leaves it unread", () => {
		driveItemsQueryUpdateForNormalParent({ parentUuid: "unread", updater: prev => [...prev, file("new", "unread")] })

		expect(queryClient.getQueryCache().find({ queryKey: driveKey("unread"), exact: true })).toBeUndefined()
		expect(allWrites()).toBe(0)
	})

	it("the same write into a read directory patches it", () => {
		queryClient.setQueryData(driveKey("read"), [])

		driveItemsQueryUpdateForNormalParent({ parentUuid: "read", updater: prev => [...prev, file("new", "read")] })

		expect(listing(driveKey("read"))).toHaveLength(1)
	})
})

describe("Photos: a directory leaving the camera-upload tree", () => {
	beforeEach(() => {
		// camroot ─ a ─ b, camroot ─ c, and "outside" directly under the drive root.
		seedCacheDir(CAMERA_ROOT, "root")
		seedCacheDir("a", CAMERA_ROOT)
		seedCacheDir("b", "a")
		seedCacheDir("c", CAMERA_ROOT)
		seedCacheDir("outside", "root")
		h.fakeCache.directoryUuidToAnyNormalDir.set("root", { tag: "Root", inner: [{ uuid: "root", parent: null, decryptedMeta: null }] })
		queryClient.setQueryData(photosKey, [file("in-a", "a"), file("in-b", "b"), file("in-c", "c"), file("orphan", "uncached")])
	})

	function photoUuids(): string[] {
		return (listing(photosKey) ?? []).map(item => item.data.uuid)
	}

	it("trashing a directory drops every photo under it, keeps the rest", async () => {
		await handleDriveEvent({ event: event("FolderTrash", { uuid: "a", parent: CAMERA_ROOT }) })
		await vi.advanceTimersByTimeAsync(0)

		expect(photoUuids()).toEqual(["in-c", "orphan"])
	})

	it("permanently deleting a directory drops them too", async () => {
		await handleDriveEvent({ event: event("FolderDeletedPermanent", { uuid: "c" }) })
		await vi.advanceTimersByTimeAsync(0)

		expect(photoUuids()).toEqual(["in-a", "in-b", "orphan"])
	})

	it("moving a directory outside the tree drops them; within the tree or to an uncached place keeps them", async () => {
		driveItemsQueryRemoveDirectoryFromPhotos({ dirUuid: "b", newParentUuid: "c" })
		await vi.advanceTimersByTimeAsync(0)
		driveItemsQueryRemoveDirectoryFromPhotos({ dirUuid: "b", newParentUuid: "somewhere-uncached" })
		await vi.advanceTimersByTimeAsync(0)

		expect(photoUuids()).toEqual(["in-a", "in-b", "in-c", "orphan"])

		driveItemsQueryRemoveDirectoryFromPhotos({ dirUuid: "a", newParentUuid: "outside" })
		await vi.advanceTimersByTimeAsync(0)

		expect(photoUuids()).toEqual(["in-c", "orphan"])
	})

	it("a Photos grid nobody has read is left alone", async () => {
		queryClient.removeQueries({ queryKey: photosKey })

		driveItemsQueryRemoveDirectoryFromPhotos({ dirUuid: "a" })
		await vi.advanceTimersByTimeAsync(0)

		expect(listing(photosKey)).toBeUndefined()
		expect(allWrites()).toBe(0)
	})
})
