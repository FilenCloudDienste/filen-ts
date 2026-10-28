import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	PHOTOS_LIBRARY_FILE_NAME,
	activePhotosRoots,
	emptyPhotosLibrary,
	parsePhotosLibrary,
	serializePhotosLibrary,
	withPhotosRoot,
	withoutPhotosRoot
} from "@filen/shared"
import type { QueryClient, QueryKey } from "@tanstack/react-query"
import { driveEvent, driveFile } from "@/tests/support/videoDrive"

const PHOTOS_DIR = "00000000-0000-4000-8000-0000000000f3"

// A drive whose `.filen/photos` holds the library file once uploaded (or `text` from the start), and kv.
const drive = vi.hoisted(() => ({
	text: undefined as string | undefined,
	uploads: [] as string[],
	counter: 0,
	offline: false,
	failUpload: false,
	kv: new Map<string, unknown>()
}))

vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
// Disk rows are out of reach here: the removal is recorded, and the memory half done for real.
const { removedFromDisk } = vi.hoisted(() => ({ removedFromDisk: [] as unknown[] }))
vi.mock("@/queries/persist", async importOriginal => ({
	...(await importOriginal<typeof import("@/queries/persist")>()),
	removeQueriesAndPersisted: (client: QueryClient, queryKey: QueryKey) => {
		removedFromDisk.push(queryKey)
		client.removeQueries({ queryKey })
	}
}))

vi.mock("@/lib/dotFilen", () => ({
	dotFilenSubdirUuid: () => (drive.text === undefined ? null : PHOTOS_DIR),
	findDotFilenSubdir: () =>
		drive.offline ? Promise.reject(new Error("offline")) : Promise.resolve(drive.text === undefined ? null : PHOTOS_DIR),
	getDotFilenSubdir: () => Promise.resolve(PHOTOS_DIR),
	noteDotFilenFile: () => undefined,
	onDotFilenSubdirForgotten: () => () => undefined
}))

vi.mock("@/lib/sdk/socket", () => ({ registerSocketHandler: () => () => undefined }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(drive.kv.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		drive.kv.set(key, value)

		return Promise.resolve()
	},
	kvDelete: (key: string) => {
		drive.kv.delete(key)

		return Promise.resolve()
	}
}))

function headFile() {
	return driveFile(PHOTOS_DIR, PHOTOS_LIBRARY_FILE_NAME, {
		uuid: `00000000-0000-4000-8000-${String(drive.counter).padStart(12, "0")}`,
		timestamp: drive.counter,
		size: drive.text?.length ?? 0
	})
}

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		listDirectory: () => Promise.resolve({ files: drive.text === undefined ? [] : [headFile()], dirs: [] }),
		downloadFileBytes: () => Promise.resolve(new TextEncoder().encode(drive.text ?? "{}")),
		uploadFileBytes: (_parent: string, bytes: Uint8Array) => {
			if (drive.failUpload) {
				return Promise.reject(new Error("upload failed"))
			}

			drive.text = new TextDecoder().decode(bytes)
			drive.uploads.push(drive.text)
			drive.counter++

			return Promise.resolve(headFile())
		}
	}
}))

const { addPhotosRoot, loadPhotosLibrary, photosLibrary, photosLibraryView, removePhotosRoot, resetPhotosLibrary } =
	await import("@/features/photos/lib/library")

const { queryClient } = await import("@/queries/client")
const { photosListingQueryKey } = await import("@/features/photos/queries/photos")
const { SyncedFileReadOnlyError } = await import("@/lib/syncedDotFilenFile")

const LEGACY_KEY = "photos.rootUuid.v1"
const COPY_KEY = "photos.library.v1"

function uploadedRoots(): string[] {
	return activePhotosRoots(parsePhotosLibrary(drive.uploads.at(-1) ?? "{}")).map(root => root.dirUuid)
}

function remoteDoc(roots: string[]): string {
	let doc = emptyPhotosLibrary()

	for (const [index, dirUuid] of roots.entries()) {
		doc = withPhotosRoot({ doc, dirUuid, stamp: { t: index + 1, d: "remote" }, now: index + 1 })
	}

	return serializePhotosLibrary(doc)
}

describe("photos library", () => {
	beforeEach(() => {
		resetPhotosLibrary()
		drive.text = undefined
		drive.uploads = []
		drive.counter = 0
		drive.offline = false
		drive.failUpload = false
		drive.kv.clear()
		removedFromDisk.length = 0
		queryClient.clear()
	})

	it("is unknown until read, then empty for a new account", async () => {
		expect(photosLibraryView().roots).toBeNull()

		await loadPhotosLibrary()

		expect(photosLibraryView()).toEqual({ roots: [], loaded: true, readOnly: false })
		expect(drive.uploads).toEqual([])
	})

	it("moves the legacy local root into a file that never held a root, once, then forgets the kv key", async () => {
		drive.kv.set(LEGACY_KEY, "legacy-root")

		await loadPhotosLibrary()
		expect(drive.kv.has(LEGACY_KEY)).toBe(false)

		expect(photosLibraryView().roots).toEqual(["legacy-root"])
		expect(drive.uploads).toHaveLength(1)
		expect(uploadedRoots()).toEqual(["legacy-root"])
	})

	it("never seeds the legacy root into a file that already held roots, even removed ones", async () => {
		const removed = withoutPhotosRoot({
			doc: parsePhotosLibrary(remoteDoc(["gone"])),
			dirUuid: "gone",
			stamp: { t: 10, d: "remote" },
			at: 10
		})

		drive.text = serializePhotosLibrary(removed)
		drive.counter = 1
		drive.kv.set(LEGACY_KEY, "legacy-root")

		await loadPhotosLibrary()
		expect(drive.kv.has(LEGACY_KEY)).toBe(false)

		expect(photosLibraryView().roots).toEqual([])
		expect(drive.uploads).toEqual([])
	})

	it("shows the legacy root while offline, before the file could be read", async () => {
		drive.offline = true
		drive.kv.set(LEGACY_KEY, "legacy-root")

		await loadPhotosLibrary()

		expect(photosLibraryView()).toEqual({ roots: ["legacy-root"], loaded: false, readOnly: false })
		expect(drive.kv.has(LEGACY_KEY)).toBe(true)
	})

	it("keeps the last read copy locally, and opens on it offline", async () => {
		drive.text = remoteDoc(["a", "b"])
		drive.counter = 1

		await loadPhotosLibrary()
		expect(drive.kv.has(COPY_KEY)).toBe(true)

		resetPhotosLibrary()
		drive.offline = true
		await loadPhotosLibrary()

		expect(photosLibraryView()).toEqual({ roots: ["a", "b"], loaded: false, readOnly: false })
	})

	it("offline with no local copy, the library reads as unset", async () => {
		drive.offline = true

		await loadPhotosLibrary()

		expect(photosLibraryView().roots).toEqual([])
	})

	it("adds a directory in place of the ones it holds, and removes one", async () => {
		drive.text = remoteDoc(["inner-a", "inner-b", "other"])
		drive.counter = 1

		await addPhotosRoot({ uuid: "outer", replace: ["inner-a", "inner-b"] })

		expect(photosLibraryView().roots).toEqual(["other", "outer"])
		expect(uploadedRoots()).toEqual(["other", "outer"])

		await removePhotosRoot("other")

		expect(uploadedRoots()).toEqual(["outer"])
	})

	it("a removal here and an add on another device both land, and the removed root stays removed", async () => {
		drive.text = remoteDoc(["a", "b"])
		drive.counter = 1
		await loadPhotosLibrary()

		// Another device adds c (its upload lands first); this one removes a without having seen it.
		drive.text = serializePhotosLibrary(
			withPhotosRoot({ doc: parsePhotosLibrary(drive.text), dirUuid: "c", stamp: { t: Date.now() * 1000, d: "other" }, now: 3 })
		)
		drive.counter++
		photosLibrary.handleDriveEvent(driveEvent(1n, { type: "fileNew", file: headFile() }))

		await removePhotosRoot("a")

		expect(uploadedRoots()).toEqual(["b", "c"])
		expect(photosLibraryView().roots).toEqual(["b", "c"])
	})

	it("an edit fails while the file can't be read, changing nothing", async () => {
		drive.offline = true

		await expect(addPhotosRoot({ uuid: "x", replace: [] })).rejects.toThrow("offline")
		expect(drive.uploads).toEqual([])
	})

	it("keeps the legacy key when the seeding upload fails, and moves it on a later read", async () => {
		drive.kv.set(LEGACY_KEY, "legacy-root")
		drive.failUpload = true

		await loadPhotosLibrary()
		expect(photosLibraryView().roots).toEqual(["legacy-root"])

		expect(drive.kv.has(LEGACY_KEY)).toBe(true)
		expect(drive.uploads).toEqual([])

		// The next read (another session saved, a reconnect) brings the pending root to the file.
		drive.failUpload = false
		photosLibrary.markStale()
		await loadPhotosLibrary()
		expect(drive.kv.has(LEGACY_KEY)).toBe(false)
		expect(uploadedRoots()).toEqual(["legacy-root"])
	})

	it("a file of a newer version is shown, never written: edits reject and the legacy key stays", async () => {
		drive.text = JSON.stringify({ v: 2, roots: {} })
		drive.counter = 1
		drive.kv.set(LEGACY_KEY, "legacy-root")

		await loadPhotosLibrary()

		expect(photosLibraryView().readOnly).toBe(true)
		await expect(addPhotosRoot({ uuid: "x", replace: [] })).rejects.toBeInstanceOf(SyncedFileReadOnlyError)
		await expect(removePhotosRoot("x")).rejects.toBeInstanceOf(SyncedFileReadOnlyError)
		expect(photosLibraryView().roots).toEqual([])
		expect(drive.uploads).toEqual([])
		expect(drive.kv.has(LEGACY_KEY)).toBe(true)
	})

	it("drops the listings of roots no longer in the library, from memory and disk", async () => {
		drive.text = remoteDoc(["a", "b"])
		drive.counter = 1

		for (const root of ["a", "b", "stale"]) {
			queryClient.setQueryData(photosListingQueryKey(root), { photos: [], folders: {} })
		}

		await loadPhotosLibrary()

		expect(queryClient.getQueryData(photosListingQueryKey("stale"))).toBeUndefined()
		expect(queryClient.getQueryData(photosListingQueryKey("a"))).toBeDefined()

		await addPhotosRoot({ uuid: "outer", replace: ["a"] })

		expect(queryClient.getQueryData(photosListingQueryKey("a"))).toBeUndefined()
		expect(queryClient.getQueryData(photosListingQueryKey("b"))).toBeDefined()
		expect(removedFromDisk).toEqual([photosListingQueryKey("stale"), photosListingQueryKey("a")])
	})
})
