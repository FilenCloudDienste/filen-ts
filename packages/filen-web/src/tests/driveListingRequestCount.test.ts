// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query"
import type { Dir, File, NormalDirsAndFiles, SharedRootDirsAndFiles, SocketEvent, UuidStr } from "@filen/sdk-rs"

const { listDirectory, listSharedInRoot, listSharedOutRoot } = vi.hoisted(() => ({
	listDirectory: vi.fn<(target: unknown) => Promise<NormalDirsAndFiles>>(),
	listSharedInRoot: vi.fn<() => Promise<SharedRootDirsAndFiles>>(),
	listSharedOutRoot: vi.fn<() => Promise<SharedRootDirsAndFiles>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listDirectory, listSharedInRoot, listSharedOutRoot } }))

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
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { driveListingQueryKey, driveListingQueryUpdate, useDirectoryListingQuery } from "@/features/drive/queries/drive"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import {
	handleDriveAuthSuccess,
	handleDriveEvent,
	handleDriveReconnecting,
	markDriveEventsMissed
} from "@/features/drive/lib/socketHandlers"
import { socketAuthenticated, socketDropped } from "@/lib/sdk/socketSession"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockFile(label: string, parent: UuidStr): File {
	return {
		uuid: testUuid(label),
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
			data: { name: `${label}.pdf`, mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		}
	}
}

type DriveInner = Extract<SocketEvent, { type: "drive" }>["inner"]

function mockDir(label: string, parent: UuidStr): Dir {
	return {
		uuid: testUuid(label),
		parent,
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } }
	}
}

function driveEvent(inner: DriveInner): Extract<SocketEvent, { type: "drive" }> {
	return { type: "drive", inner, driveMessageId: 0n }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

// Read-this-session is page-session state, so every test lists directories of its own.
let dirCounter = 0

function nextDir(): UuidStr {
	dirCounter++

	return testUuid(`dir${String(dirCounter)}`)
}

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient, children })
}

function mountListing(uuid: string) {
	return renderHook(() => useDirectoryListingQuery("drive", uuid), { wrapper })
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

function reads(): number {
	return listDirectory.mock.calls.length + listSharedInRoot.mock.calls.length + listSharedOutRoot.mock.calls.length
}

function listing(uuid: string): DriveItem[] | undefined {
	return queryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "drive", uuid }))
}

function isInvalidated(uuid: string | null, variant: DriveVariant = "drive"): boolean {
	return (
		queryClient.getQueryCache().find({ queryKey: driveListingQueryKey({ variant, uuid }), exact: true })?.state.isInvalidated ?? false
	)
}

function mountFlat(variant: Exclude<DriveVariant, "drive">) {
	return renderHook(() => useDirectoryListingQuery(variant, null), { wrapper })
}

async function refocus(): Promise<void> {
	act(() => {
		focusManager.setFocused(false)
		focusManager.setFocused(true)
	})
	await drain()
}

async function reconnectNetwork(): Promise<void> {
	act(() => {
		onlineManager.setOnline(false)
		onlineManager.setOnline(true)
	})
	await drain()
}

async function mountRead(uuid: string) {
	const before = reads()
	const view = mountListing(uuid)

	await drain()

	expect(reads()).toBe(before + 1)

	return view
}

// The bridge moves the socket session before its handlers see the event.
function dropSocket(): void {
	socketDropped()
	handleDriveReconnecting()
}

function recoverSocket(): void {
	socketAuthenticated()
	handleDriveAuthSuccess()
}

beforeEach(() => {
	queryClient.clear()
	socketAuthenticated()
	listDirectory.mockReset()
	listDirectory.mockImplementation(() => Promise.resolve({ dirs: [], files: [] }))
	listSharedInRoot.mockReset()
	listSharedInRoot.mockImplementation(() => Promise.resolve({ dirs: [], files: [] }))
	listSharedOutRoot.mockReset()
	listSharedOutRoot.mockImplementation(() => Promise.resolve({ dirs: [], files: [] }))
})

afterEach(() => {
	focusManager.setFocused(undefined)
	onlineManager.setOnline(true)
})

describe("drive listing request counts", () => {
	it("reads once across mount, remount and focus; a network reconnect reads again", async () => {
		const dir = nextDir()
		const first = await mountRead(dir)

		first.unmount()
		mountListing(dir)
		await drain()

		expect(reads()).toBe(1)

		await refocus()
		await refocus()
		await refocus()

		expect(reads()).toBe(1)

		await reconnectNetwork()

		expect(reads()).toBe(2)
	})

	it("a listing restored from disk is read on its first mount of the session", async () => {
		const dir = nextDir()

		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: dir }), [], { updatedAt: Date.now() })

		const view = mountListing(dir)
		await drain()

		expect(reads()).toBe(1)

		view.unmount()
		mountListing(dir)
		await drain()

		expect(reads()).toBe(1)
	})

	it("a listing only a patch created is still read on its first mount", async () => {
		const dir = nextDir()

		driveListingQueryUpdate(dir, prev => [...prev, narrowItem(mockFile("patched", dir))])
		mountListing(dir)
		await drain()

		expect(reads()).toBe(1)
	})

	it("a failed read is retried on the next focus", async () => {
		const dir = nextDir()

		listDirectory.mockRejectedValueOnce(new Error("offline"))
		mountListing(dir)
		await drain()

		expect(reads()).toBe(1)

		await refocus()

		expect(reads()).toBe(2)

		await refocus()

		expect(reads()).toBe(2)
	})
})

describe("flat and shared listing request counts", () => {
	it.each(["favorites", "trash"] as const)(
		"%s reads once across mount, remount and focus; a network reconnect reads again",
		async variant => {
			const first = mountFlat(variant)
			await drain()

			first.unmount()
			mountFlat(variant)
			await drain()
			await refocus()
			await refocus()

			expect(reads()).toBe(1)

			await reconnectNetwork()

			expect(reads()).toBe(2)
		}
	)

	it.each(["favorites", "trash"] as const)("%s is re-read by the authSuccess that ends a socket drop", async variant => {
		mountFlat(variant)
		await drain()

		dropSocket()
		recoverSocket()
		await drain()

		expect(reads()).toBe(2)
	})

	// No event reports a recent aging out, or a link or share made on another device.
	it.each(["recents", "links", "sharedIn", "sharedOut"] as const)("%s reads on every mount, focus and reconnect", async variant => {
		const first = mountFlat(variant)
		await drain()

		expect(reads()).toBe(1)

		first.unmount()
		mountFlat(variant)
		await drain()

		expect(reads()).toBe(2)

		await refocus()

		expect(reads()).toBe(3)

		await reconnectNetwork()

		expect(reads()).toBe(4)
	})

	it("a trashing no cached row can patch marks the trash stale: the next focus reads, once", async () => {
		mountFlat("trash")
		await drain()

		handleDriveEvent(
			driveEvent({ type: "fileTrash", uuid: testUuid("uncached"), stableUUID: testUuid("stable-uncached"), newUUID: undefined })
		)
		await drain()

		expect(reads()).toBe(1)
		expect(isInvalidated(null, "trash")).toBe(true)

		await refocus()
		await refocus()

		expect(reads()).toBe(2)
	})

	it("a trashing a cached row patches is taken in without a read", async () => {
		const dir = nextDir()

		await mountRead(dir)
		driveListingQueryUpdate(dir, () => [narrowItem(mockFile("cached", dir))])
		mountFlat("trash")
		await drain()

		handleDriveEvent(
			driveEvent({ type: "fileTrash", uuid: testUuid("cached"), stableUUID: testUuid("stable-cached"), newUUID: undefined })
		)
		await refocus()

		expect(reads()).toBe(2)
		expect(
			queryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "trash", uuid: null }))?.map(i => i.data.uuid)
		).toEqual([testUuid("cached")])
	})

	it("a folder trashing marks Favorites stale: the next focus reads, once", async () => {
		mountFlat("favorites")
		await drain()

		handleDriveEvent(driveEvent({ type: "folderTrash", parent: nextDir(), uuid: testUuid("folder") }))
		await drain()

		expect(reads()).toBe(1)

		await refocus()
		await refocus()

		expect(reads()).toBe(2)
	})

	it("a remote move of a favorite patches Favorites without a read", async () => {
		const dir = nextDir()
		const favorite = { ...mockDir("fav", dir), favorited: true }

		listDirectory.mockImplementationOnce(() => Promise.resolve({ dirs: [favorite], files: [] }))
		mountFlat("favorites")
		await drain()

		handleDriveEvent(driveEvent({ type: "folderMove", dir: { ...favorite, parent: nextDir() } }))
		await refocus()

		expect(reads()).toBe(1)
		expect(
			queryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "favorites", uuid: null }))?.map(i => i.data.uuid)
		).toEqual([testUuid("fav")])
	})

	it("a stale mark landing during a read keeps the listing stale once the read settles", async () => {
		const pending = deferred<NormalDirsAndFiles>()

		listDirectory.mockImplementationOnce(() => pending.promise)
		mountFlat("favorites")
		handleDriveEvent(driveEvent({ type: "folderTrash", parent: nextDir(), uuid: testUuid("folder") }))
		pending.resolve({ dirs: [], files: [] })
		await drain()

		expect(reads()).toBe(1)

		await refocus()

		expect(reads()).toBe(2)

		await refocus()

		expect(reads()).toBe(2)
	})

	it("a favorite patch landing on a pending refresh keeps it pending", async () => {
		mountFlat("favorites")
		await drain()

		const pending = deferred<NormalDirsAndFiles>()

		listDirectory.mockImplementationOnce(() => pending.promise)
		dropSocket()
		recoverSocket()
		handleDriveEvent(driveEvent({ type: "itemFavorite", item: { type: "file", ...mockFile("fav", nextDir()), favorited: true } }))
		pending.resolve({ dirs: [], files: [] })
		await drain()

		expect(reads()).toBe(2)
		expect(isInvalidated(null, "favorites")).toBe(true)

		await refocus()

		expect(reads()).toBe(3)
	})
})

describe("drive listing reads and the socket session", () => {
	it("a read before the socket first authenticates doesn't count: the next focus reads", async () => {
		const dir = nextDir()

		socketDropped()
		await mountRead(dir)
		recoverSocket()
		await drain()

		expect(reads()).toBe(1)

		await refocus()

		expect(reads()).toBe(2)

		await refocus()

		expect(reads()).toBe(2)
	})

	it("a read a drop interrupts doesn't count, even once the socket is back", async () => {
		const dir = nextDir()
		const pending = deferred<NormalDirsAndFiles>()

		listDirectory.mockImplementationOnce(() => pending.promise)
		mountListing(dir)
		socketDropped()
		pending.resolve({ dirs: [], files: [] })
		await drain()
		socketAuthenticated()

		expect(reads()).toBe(1)

		await refocus()

		expect(reads()).toBe(2)
	})
})

describe("drive listing socket reconcile", () => {
	it("a plain authSuccess triggers nothing", async () => {
		const dir = nextDir()

		await mountRead(dir)

		recoverSocket()
		await drain()

		expect(reads()).toBe(1)
		expect(isInvalidated(dir)).toBe(false)
	})

	it("a drop marks every listing stale; its authSuccess re-reads only the mounted one", async () => {
		const active = nextDir()
		const inactive = nextDir()

		await mountRead(active)
		const unmounted = await mountRead(inactive)
		unmounted.unmount()

		dropSocket()
		await drain()

		expect(reads()).toBe(2)
		expect(isInvalidated(active)).toBe(true)
		expect(isInvalidated(inactive)).toBe(true)

		recoverSocket()
		await drain()

		expect(reads()).toBe(3)
		expect(listDirectory).toHaveBeenLastCalledWith({ kind: "uuid", uuid: active })
		expect(isInvalidated(active)).toBe(false)
		expect(isInvalidated(inactive)).toBe(true)

		mountListing(inactive)
		await drain()

		expect(reads()).toBe(4)

		// The latch is spent: a later authSuccess is not a recovery.
		recoverSocket()
		await drain()

		expect(reads()).toBe(4)
	})

	it("a focus during a drop reads, and the authSuccess that ends it reads again", async () => {
		const dir = nextDir()

		await mountRead(dir)

		dropSocket()
		await refocus()

		expect(reads()).toBe(2)

		recoverSocket()
		await drain()

		expect(reads()).toBe(3)
	})

	it("an undecodable drive event marks the listing stale without reading", async () => {
		const dir = nextDir()

		await mountRead(dir)

		markDriveEventsMissed()
		await drain()

		expect(reads()).toBe(1)

		await refocus()

		expect(reads()).toBe(2)
	})

	it("an account-wide delete re-reads the mounted listing", async () => {
		const dir = nextDir()

		await mountRead(dir)

		handleDriveEvent(driveEvent({ type: "deleteAll" }))
		await drain()

		expect(reads()).toBe(2)
	})

	it("a socket patch that cancels the reconcile keeps the listing stale", async () => {
		const dir = nextDir()

		await mountRead(dir)

		const pending = deferred<NormalDirsAndFiles>()

		listDirectory.mockImplementationOnce(() => pending.promise)
		dropSocket()
		recoverSocket()
		handleDriveEvent(driveEvent({ type: "fileNew", file: mockFile("new", dir) }))
		pending.resolve({ dirs: [], files: [] })
		await drain()

		expect(reads()).toBe(2)
		expect(listing(dir)?.map(item => item.data.uuid)).toEqual([testUuid("new")])
		expect(isInvalidated(dir)).toBe(true)

		await refocus()

		expect(reads()).toBe(3)
	})

	it("a socket patch on a settled listing leaves it fresh", async () => {
		const dir = nextDir()

		await mountRead(dir)

		handleDriveEvent(driveEvent({ type: "fileNew", file: mockFile("new", dir) }))
		await refocus()

		expect(reads()).toBe(1)
		expect(listing(dir)?.map(item => item.data.uuid)).toEqual([testUuid("new")])
	})
})
