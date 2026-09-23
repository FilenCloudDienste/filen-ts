// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query"
import type { Dir, File, NormalDirsAndFiles, SocketEvent, UuidStr } from "@filen/sdk-rs"

const { listPhotosRecursive, isOutsidePhotosRoot } = vi.hoisted(() => ({
	listPhotosRecursive: vi.fn<(rootUuid: string) => Promise<NormalDirsAndFiles>>(),
	isOutsidePhotosRoot: vi.fn<(rootUuid: string, dirUuids: string[]) => Promise<boolean>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listPhotosRecursive, isOutsidePhotosRoot } }))

// The production defaults minus the persister (sqlite, unavailable under vitest).
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({
		defaultOptions: {
			queries: { staleTime: 0, gcTime: Infinity, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true }
		}
	})
}))

vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { queryClient } from "@/queries/client"
import { cacheDirs, clearDirectoryCache, isOutsideRoot } from "@/features/drive/lib/cache"
import {
	invalidatePhotosListing,
	markPhotosListingStale,
	photosListingQueryKey,
	photosListingQueryUpdate,
	usePhotosListingQuery
} from "@/features/photos/queries/photos"
import { handleDriveEvent } from "@/features/drive/lib/socketHandlers"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockDir(uuid: UuidStr, parent: UuidStr): Dir {
	return {
		uuid,
		parent,
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Dir" } }
	}
}

function mockFile(uuid: UuidStr, parent: UuidStr, name = "photo.jpg"): File {
	return {
		uuid,
		stableUUID: undefined,
		parent,
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name, mime: "image/jpeg", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		}
	}
}

type DriveInner = Extract<SocketEvent, { type: "drive" }>["inner"]

function driveEvent(inner: DriveInner): Extract<SocketEvent, { type: "drive" }> {
	return { type: "drive", inner, driveMessageId: 0n }
}

// The drive root holds the photos root (-> A -> B) and an unrelated C. A photo lives in B.
const DRIVE_ROOT = testUuid("drive-root")
const A = testUuid("a")
const B = testUuid("b")
const C = testUuid("c")
const PHOTO = testUuid("photo")
const UNLISTED = testUuid("unlisted")

// Read-this-session is page-session state, so every test walks a root of its own.
let rootCounter = 0
let root: UuidStr

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient, children })
}

function mountListing() {
	return renderHook(() => usePhotosListingQuery(root), { wrapper })
}

async function drain(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 20; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
	await waitFor(() => {
		expect(queryClient.isFetching()).toBe(0)
	})
}

function walks(): number {
	return listPhotosRecursive.mock.calls.length
}

function isInvalidated(): boolean {
	return queryClient.getQueryCache().find({ queryKey: photosListingQueryKey(root), exact: true })?.state.isInvalidated ?? false
}

async function mountRead() {
	const view = mountListing()

	await drain()

	expect(walks()).toBe(1)

	return view
}

async function fire(inner: DriveInner): Promise<void> {
	handleDriveEvent(driveEvent(inner))

	await drain()
}

beforeEach(() => {
	queryClient.clear()
	clearDirectoryCache()
	listPhotosRecursive.mockReset()
	isOutsidePhotosRoot.mockReset()

	rootCounter++
	root = testUuid(`root${String(rootCounter)}`)

	cacheDirs([mockDir(root, DRIVE_ROOT), mockDir(A, root), mockDir(B, A), mockDir(C, DRIVE_ROOT)])

	listPhotosRecursive.mockImplementation(() => Promise.resolve({ dirs: [], files: [mockFile(PHOTO, B)] }))
	// The worker op, run against the real dir cache.
	isOutsidePhotosRoot.mockImplementation((rootUuid, dirUuids) => Promise.resolve(isOutsideRoot(dirUuids, rootUuid, DRIVE_ROOT)))
})

afterEach(() => {
	focusManager.setFocused(undefined)
	onlineManager.setOnline(true)
})

describe("photos listing request counts", () => {
	it("walks once across mount, remount and focus; a network reconnect walks again", async () => {
		const first = await mountRead()

		first.unmount()
		mountListing()
		await drain()

		expect(walks()).toBe(1)

		act(() => {
			focusManager.setFocused(false)
			focusManager.setFocused(true)
		})
		await drain()

		expect(walks()).toBe(1)

		act(() => {
			onlineManager.setOnline(false)
			onlineManager.setOnline(true)
		})
		await drain()

		expect(walks()).toBe(2)
	})

	it("a listing restored from disk is walked on its first mount of the session", async () => {
		queryClient.setQueryData(photosListingQueryKey(root), [], { updatedAt: Date.now() })

		const view = mountListing()
		await drain()

		expect(walks()).toBe(1)

		view.unmount()
		mountListing()
		await drain()

		expect(walks()).toBe(1)
	})

	it("an unscoped invalidation still refetches the mounted listing", async () => {
		await mountRead()

		invalidatePhotosListing(null)
		await drain()

		expect(walks()).toBe(2)
	})

	it("a socket drop marks the listing stale without walking; the next focus walks", async () => {
		await mountRead()

		markPhotosListingStale()
		await drain()

		expect(walks()).toBe(1)

		act(() => {
			focusManager.setFocused(false)
			focusManager.setFocused(true)
		})
		await drain()

		expect(walks()).toBe(2)
	})

	it("a local patch keeps a pending refresh pending", async () => {
		const view = await mountRead()

		markPhotosListingStale()
		photosListingQueryUpdate(root, prev => prev)

		expect(isInvalidated()).toBe(true)

		view.unmount()
		mountListing()
		await drain()

		expect(walks()).toBe(2)
	})

	it("a local patch that cancels a walk leaves the listing stale", async () => {
		const view = await mountRead()
		const pending = deferred<NormalDirsAndFiles>()

		listPhotosRecursive.mockImplementationOnce(() => pending.promise)
		invalidatePhotosListing(null)
		photosListingQueryUpdate(root, prev => prev)
		pending.resolve({ dirs: [], files: [] })
		await drain()

		expect(walks()).toBe(2)
		expect(isInvalidated()).toBe(true)

		view.unmount()
		mountListing()
		await drain()

		expect(walks()).toBe(3)
	})
})

describe("photos listing socket scoping", () => {
	it("a new file outside the root does not walk", async () => {
		await mountRead()

		await fire({ type: "fileNew", file: mockFile(UNLISTED, C) })

		expect(isOutsidePhotosRoot).toHaveBeenCalledWith(root, [C])
		expect(walks()).toBe(1)
	})

	it("a new file under the root walks", async () => {
		await mountRead()

		await fire({ type: "fileNew", file: mockFile(UNLISTED, B) })

		expect(walks()).toBe(2)
	})

	it("a new file under an uncached parent walks (fails open)", async () => {
		await mountRead()

		await fire({ type: "fileNew", file: mockFile(UNLISTED, testUuid("uncached")) })

		expect(walks()).toBe(2)
	})

	it("a file moved from outside into the root walks", async () => {
		await mountRead()

		await fire({ type: "fileMove", file: mockFile(UNLISTED, B) })

		expect(walks()).toBe(2)
	})

	it("a listed photo moved out of the root walks", async () => {
		await mountRead()

		await fire({ type: "fileMove", file: mockFile(PHOTO, C) })

		expect(isOutsidePhotosRoot).not.toHaveBeenCalled()
		expect(walks()).toBe(2)
	})

	it("an unlisted file moved to a dir outside the root does not walk", async () => {
		await mountRead()

		await fire({ type: "fileMove", file: mockFile(UNLISTED, C) })

		expect(walks()).toBe(1)
	})

	it("a directory move always walks: its old parent is not in the payload", async () => {
		await mountRead()

		await fire({ type: "folderMove", dir: mockDir(testUuid("moved"), C) })

		expect(isOutsidePhotosRoot).not.toHaveBeenCalled()
		expect(walks()).toBe(2)
	})

	it("a directory trashed out of the root walks, one trashed elsewhere does not", async () => {
		await mountRead()

		await fire({ type: "folderTrash", parent: C, uuid: testUuid("elsewhere") })

		expect(walks()).toBe(1)

		await fire({ type: "folderTrash", parent: B, uuid: testUuid("inside") })

		expect(walks()).toBe(2)
	})

	it("trashing the root itself walks", async () => {
		await mountRead()

		await fire({ type: "folderTrash", parent: DRIVE_ROOT, uuid: root })

		expect(walks()).toBe(2)
	})

	it("a directory restored into the root walks", async () => {
		await mountRead()

		await fire({ type: "folderRestore", dir: mockDir(testUuid("restored"), A) })

		expect(walks()).toBe(2)
	})

	it("trashing a listed photo walks; trashing an unlisted file asks nothing and does not", async () => {
		await mountRead()

		await fire({ type: "fileTrash", uuid: UNLISTED, stableUUID: UNLISTED, newUUID: undefined })

		expect(isOutsidePhotosRoot).not.toHaveBeenCalled()
		expect(walks()).toBe(1)

		await fire({ type: "fileTrash", uuid: PHOTO, stableUUID: PHOTO, newUUID: undefined })

		expect(walks()).toBe(2)
	})

	it("a file rename always walks: it can turn a file under the root into a photo", async () => {
		await mountRead()

		await fire({
			type: "fileMetadataChanged",
			uuid: UNLISTED,
			metadata: { type: "decoded", data: { name: "x.jpg", mime: "image/jpeg", modified: 1n, size: 1n, key: "k", version: 2 } }
		})

		expect(walks()).toBe(2)
	})

	it("a failed check walks (fails open)", async () => {
		await mountRead()

		isOutsidePhotosRoot.mockRejectedValueOnce(new Error("no authenticated client"))
		await fire({ type: "fileNew", file: mockFile(UNLISTED, C) })

		expect(walks()).toBe(2)
	})

	it("an event during a walk restarts it without asking", async () => {
		await mountRead()

		const pending = deferred<NormalDirsAndFiles>()

		listPhotosRecursive.mockImplementationOnce(() => pending.promise)
		invalidatePhotosListing(null)
		handleDriveEvent(driveEvent({ type: "fileNew", file: mockFile(UNLISTED, C) }))
		pending.resolve({ dirs: [], files: [] })
		await drain()

		expect(isOutsidePhotosRoot).not.toHaveBeenCalled()
		expect(walks()).toBe(3)
	})

	it("after a socket drop, an event outside the root walks until the listing is read again", async () => {
		await mountRead()

		markPhotosListingStale()
		await fire({ type: "fileNew", file: mockFile(UNLISTED, C) })

		expect(isOutsidePhotosRoot).not.toHaveBeenCalled()
		expect(walks()).toBe(2)

		await fire({ type: "fileNew", file: mockFile(testUuid("unlisted2"), C) })

		expect(walks()).toBe(2)
	})

	it("an unmounted listing is marked stale without asking, and walks on its next mount", async () => {
		const view = await mountRead()

		view.unmount()
		await fire({ type: "fileNew", file: mockFile(UNLISTED, C) })

		expect(isOutsidePhotosRoot).not.toHaveBeenCalled()
		expect(isInvalidated()).toBe(true)
		expect(walks()).toBe(1)

		mountListing()
		await drain()

		expect(walks()).toBe(2)
	})
})
