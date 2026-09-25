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
import {
	discardListingPatches,
	driveListingQueryKey,
	driveListingQueryUpdate,
	driveListingQueryUpdateGlobal,
	flushListingCreates,
	useDirectoryListingQuery
} from "@/features/drive/queries/drive"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import {
	flushDeferredRecents,
	handleDriveAuthSuccess,
	handleDriveEvent,
	handleDriveReconnecting,
	markDriveEventsMissed
} from "@/features/drive/lib/socketHandlers"
import { socketAuthenticated, socketDropped } from "@/lib/sdk/socketSession"
import { useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"

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

function isInvalidated(uuid: string): boolean {
	return (
		queryClient.getQueryCache().find({ queryKey: driveListingQueryKey({ variant: "drive", uuid }), exact: true })?.state
			.isInvalidated ?? false
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

// Creates land once their window closes (queueListingCreate); these tests don't wait it out.
function fire(inner: DriveInner): void {
	handleDriveEvent(driveEvent(inner))
	flushListingCreates()
}

function uuids(uuid: string): string[] | undefined {
	return listing(uuid)?.map(item => item.data.uuid)
}

function named(file: File, name: string): File {
	return { ...file, meta: { type: "decoded", data: { name, mime: "application/pdf", modified: 1n, size: 1n, key: "k", version: 2 } } }
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
	discardListingPatches()
	useTransfersStore.setState({ transfers: [], speedSamples: [] })
	flushDeferredRecents()
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

	it("a patch never creates a listing: the first mount reads it whole, without flashing the patched row alone", async () => {
		const dir = nextDir()

		driveListingQueryUpdate(dir, prev => [...prev, narrowItem(mockFile("patched", dir))])

		expect(listing(dir)).toBeUndefined()

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
	// No event reports a recent aging out, a link or share made on another device, or the server purging
	// an item 30 days after it was trashed (a favorite inside a trashed directory goes with it).
	it.each(["favorites", "trash", "recents", "links", "sharedIn", "sharedOut"] as const)(
		"%s reads on every mount, focus and reconnect",
		async variant => {
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
		}
	)

	it("a trashing a cached row patches lands in the open trash listing without a read", async () => {
		const dir = nextDir()

		await mountRead(dir)
		driveListingQueryUpdate(dir, () => [narrowItem(mockFile("cached", dir))])
		mountFlat("trash")
		await drain()

		handleDriveEvent(
			driveEvent({ type: "fileTrash", uuid: testUuid("cached"), stableUUID: testUuid("stable-cached"), newUUID: undefined })
		)
		await drain()

		expect(reads()).toBe(2)
		expect(
			queryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "trash", uuid: null }))?.map(i => i.data.uuid)
		).toEqual([testUuid("cached")])
	})

	it("a remote move of a favorite patches the open Favorites listing without a read", async () => {
		const dir = nextDir()
		const favorite = { ...mockDir("fav", dir), favorited: true }

		listDirectory.mockImplementationOnce(() => Promise.resolve({ dirs: [favorite], files: [] }))
		mountFlat("favorites")
		await drain()

		handleDriveEvent(driveEvent({ type: "folderMove", dir: { ...favorite, parent: nextDir() } }))
		await drain()

		expect(reads()).toBe(1)
		expect(
			queryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "favorites", uuid: null }))?.map(i => i.data.uuid)
		).toEqual([testUuid("fav")])
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

	it("an undecodable drive event landing during a read keeps the listing stale once the read settles", async () => {
		const dir = nextDir()
		const pending = deferred<NormalDirsAndFiles>()

		listDirectory.mockImplementationOnce(() => pending.promise)
		mountListing(dir)
		markDriveEventsMissed()
		pending.resolve({ dirs: [], files: [] })
		await drain()

		expect(reads()).toBe(1)

		await refocus()

		expect(reads()).toBe(2)

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

	// The reconcile is the only read of what changed during the drop; an event landing meanwhile used to
	// cancel it with revert, losing that change until the next focus.
	it("a socket patch during the reconcile keeps it: the drop's row and the patch both land, with no further read", async () => {
		const dir = nextDir()

		await mountRead(dir)

		const pending = deferred<NormalDirsAndFiles>()

		listDirectory.mockImplementationOnce(() => pending.promise)
		dropSocket()
		recoverSocket()
		fire({ type: "fileNew", file: named(mockFile("new", dir), "new.pdf") })

		expect(uuids(dir)).toEqual([testUuid("new")])

		pending.resolve({ dirs: [], files: [named(mockFile("dropped", dir), "dropped.pdf")] })
		await drain()

		expect(reads()).toBe(2)
		expect(uuids(dir)).toEqual([testUuid("dropped"), testUuid("new")])
		expect(isInvalidated(dir)).toBe(false)

		await refocus()

		expect(reads()).toBe(2)
	})

	it("a socket patch on a settled listing leaves it fresh", async () => {
		const dir = nextDir()

		await mountRead(dir)

		fire({ type: "fileNew", file: mockFile("new", dir) })
		await refocus()

		expect(reads()).toBe(1)
		expect(uuids(dir)).toEqual([testUuid("new")])
	})
})

// A read snapshots the server at some point while it runs; a patch landing meanwhile may be missing
// from what it returns, so the read applies the patch to its result. Without that, the patch was lost
// and the listing, counted as current, stayed without it for the session.
describe("drive listing patches that land during a read", () => {
	it("a first read gets the file created and the row trashed while it ran, and still counts", async () => {
		const dir = nextDir()
		const pending = deferred<NormalDirsAndFiles>()

		listDirectory.mockImplementationOnce(() => pending.promise)
		mountListing(dir)
		fire({ type: "fileNew", file: named(mockFile("created", dir), "created.pdf") })
		fire({ type: "fileTrash", uuid: testUuid("trashed"), stableUUID: testUuid("stable-trashed"), newUUID: undefined })
		pending.resolve({
			dirs: [],
			files: [named(mockFile("trashed", dir), "trashed.pdf"), named(mockFile("kept", dir), "kept.pdf")]
		})
		await drain()

		expect(reads()).toBe(1)
		expect(uuids(dir)).toEqual([testUuid("kept"), testUuid("created")])

		await refocus()

		expect(reads()).toBe(1)
	})

	it("a rename by uuid alone reaches a first read's rows", async () => {
		const dir = nextDir()
		const pending = deferred<NormalDirsAndFiles>()

		listDirectory.mockImplementationOnce(() => pending.promise)
		mountListing(dir)
		fire({
			type: "fileMetadataChanged",
			uuid: testUuid("renamed"),
			metadata: {
				type: "decoded",
				data: { name: "after.pdf", mime: "application/pdf", modified: 1n, size: 1n, key: "k", version: 2 }
			}
		})
		pending.resolve({ dirs: [], files: [named(mockFile("renamed", dir), "before.pdf")] })
		await drain()

		expect(listing(dir)?.map(item => item.data.decryptedMeta?.name)).toEqual(["after.pdf"])
		expect(reads()).toBe(1)
	})

	it("many creates during one read cost no further read", async () => {
		const dir = nextDir()
		const pending = deferred<NormalDirsAndFiles>()

		listDirectory.mockImplementationOnce(() => pending.promise)
		mountListing(dir)

		for (let i = 0; i < 50; i++) {
			handleDriveEvent(driveEvent({ type: "fileNew", file: named(mockFile(`burst${String(i)}`, dir), `${String(i)}.pdf`) }))
		}

		flushListingCreates()
		pending.resolve({ dirs: [], files: [] })
		await drain()

		expect(reads()).toBe(1)
		expect(listing(dir)).toHaveLength(50)

		await refocus()

		expect(reads()).toBe(1)
	})

	// A move or restore echo carries no colour, so its row may be wrong where the read's was right.
	it("a directory move with no colour to keep doesn't let the destination's read count", async () => {
		const dir = nextDir()
		const pending = deferred<NormalDirsAndFiles>()

		listDirectory.mockImplementationOnce(() => pending.promise)
		mountListing(dir)
		fire({ type: "folderMove", dir: mockDir("moved", dir) })
		pending.resolve({ dirs: [{ ...mockDir("moved", dir), color: "blue" }], files: [] })
		await drain()

		expect(reads()).toBe(1)

		await refocus()

		expect(reads()).toBe(2)
	})

	it("a burst of trashes, renames, recolours, moves and creates lands as it would one at a time", async () => {
		const dir = nextDir()
		const elsewhere = nextDir()
		const pending = deferred<NormalDirsAndFiles>()

		listDirectory.mockImplementationOnce(() => pending.promise)
		mountListing(dir)
		fire({ type: "fileTrash", uuid: testUuid("f1"), stableUUID: testUuid("stable-f1"), newUUID: undefined })
		fire({
			type: "fileMetadataChanged",
			uuid: testUuid("f2"),
			metadata: {
				type: "decoded",
				data: { name: "renamed.pdf", mime: "application/pdf", modified: 1n, size: 1n, key: "k", version: 2 }
			}
		})
		fire({ type: "folderColorChanged", uuid: testUuid("d1"), color: "blue" })
		fire({ type: "fileNew", file: mockFile("f5", dir) })
		fire({ type: "fileMove", file: mockFile("f3", elsewhere) })
		fire({ type: "fileMove", file: mockFile("g1", dir) })
		fire({ type: "fileTrash", uuid: testUuid("f5"), stableUUID: testUuid("stable-f5"), newUUID: undefined })
		pending.resolve({
			dirs: [mockDir("d1", dir)],
			files: [mockFile("f1", dir), mockFile("f2", dir), mockFile("f3", dir), mockFile("f4", dir)]
		})
		await drain()

		const rows = listing(dir)?.map(item => [
			item.data.uuid,
			item.data.decryptedMeta?.name,
			"color" in item.data ? item.data.color : null
		])

		expect(rows).toEqual([
			[testUuid("d1"), "d1", "blue"],
			[testUuid("f2"), "renamed.pdf", null],
			[testUuid("f4"), "f4.pdf", null],
			[testUuid("g1"), "g1.pdf", null]
		])

		await refocus()

		expect(reads()).toBe(1)
	})

	// A reconnect re-reads the mounted listings, replacing any refetch under way. The replaced read still
	// ran to its end: it used to replay every change logged meanwhile, and record its read, for a result
	// query-core throws away.
	it("a read another replaced neither replays its changes nor records itself", async () => {
		const dir = nextDir()
		const kept = mockFile("kept", dir)

		listDirectory.mockImplementation(() => Promise.resolve({ dirs: [], files: [kept] }))
		await mountRead(dir)

		const replaced = deferred<NormalDirsAndFiles>()
		const replace = vi.fn((row: DriveItem) => row)

		listDirectory.mockImplementationOnce(() => replaced.promise)
		void queryClient.invalidateQueries({ queryKey: driveListingQueryKey({ variant: "drive", uuid: dir }) })
		driveListingQueryUpdateGlobal({ type: "replace", uuid: kept.uuid, replace })
		dropSocket()
		recoverSocket()
		await drain()
		replaced.resolve({ dirs: [], files: [kept] })
		await drain()

		expect(reads()).toBe(3)
		expect(replace).toHaveBeenCalledOnce()

		await refocus()

		expect(reads()).toBe(3)
	})

	it("a shared listing's read gets a patch that landed while it ran", async () => {
		const pending = deferred<SharedRootDirsAndFiles>()
		const { meta, size, region, bucket, chunks, timestamp, canMakeThumbnail } = mockFile("gone", nextDir())

		listSharedOutRoot.mockImplementationOnce(() => pending.promise)
		mountFlat("sharedOut")
		fire({ type: "fileDeletedPermanent", uuid: testUuid("gone"), stableUUID: testUuid("stable-gone") })
		pending.resolve({
			dirs: [],
			files: [
				{
					uuid: testUuid("gone"),
					meta,
					size,
					region,
					bucket,
					chunks,
					timestamp,
					canMakeThumbnail,
					sharedTag: true,
					sharingRole: { Receiver: { email: "friend@filen.io", id: 7 } }
				}
			]
		})
		await drain()

		expect(reads()).toBe(1)
		expect(queryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "sharedOut", uuid: null }))).toEqual([])
	})
})

// A move or restore echo carries no colour, so the directory keeps the one a current row holds. A row no
// read under the live socket has kept current may predate a recolour made elsewhere; the destination then
// reads again rather than keep a colour the server doesn't have.
describe("directory colour on a move or restore echo", () => {
	function colorOf(uuid: string, item: string): string | undefined {
		const row = listing(uuid)?.find(candidate => candidate.data.uuid === item)

		return row?.type === "directory" ? row.data.color : undefined
	}

	function coloredDir(label: string, parent: UuidStr, color: string): Dir {
		return { ...mockDir(label, parent), color }
	}

	it("a listing read this session lends its colour, and the destination stays current", async () => {
		const source = nextDir()
		const destination = nextDir()

		listDirectory.mockImplementationOnce(() => Promise.resolve({ dirs: [coloredDir("moved", source, "red")], files: [] }))
		await mountRead(source)
		await mountRead(destination)
		fire({ type: "folderMove", dir: mockDir("moved", destination) })

		expect(colorOf(destination, testUuid("moved"))).toBe("red")

		await refocus()

		expect(reads()).toBe(2)
	})

	it("a listing restored from disk lends none: the destination's read no longer counts", async () => {
		const source = nextDir()
		const destination = nextDir()

		const restored = [narrowItem(coloredDir("moved", source, "red"))]

		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: source }), restored, { updatedAt: Date.now() })
		await mountRead(destination)
		fire({ type: "folderMove", dir: mockDir("moved", destination) })

		expect(colorOf(destination, testUuid("moved"))).toBe("default")
		expect(isInvalidated(destination)).toBe(true)

		await refocus()

		expect(reads()).toBe(2)
	})

	it("a listing a socket drop left stale lends none: the destination's read no longer counts", async () => {
		const source = nextDir()
		const destination = nextDir()

		listDirectory.mockImplementationOnce(() => Promise.resolve({ dirs: [coloredDir("moved", source, "red")], files: [] }))

		const unmounted = await mountRead(source)

		unmounted.unmount()
		await mountRead(destination)
		dropSocket()
		recoverSocket()
		await drain()

		expect(reads()).toBe(3)

		fire({ type: "folderMove", dir: mockDir("moved", destination) })
		await refocus()

		expect(reads()).toBe(4)
	})

	it("a trash listing read this session lends its colour to a restore", async () => {
		const destination = nextDir()

		listDirectory.mockImplementationOnce(() => Promise.resolve({ dirs: [coloredDir("restored", destination, "green")], files: [] }))
		mountFlat("trash")
		await drain()
		await mountRead(destination)
		fire({ type: "folderRestore", dir: mockDir("restored", destination) })

		expect(colorOf(destination, testUuid("restored"))).toBe("green")
		expect(isInvalidated(destination)).toBe(false)
	})

	it("a trash listing restored from disk lends none to a restore: the destination's read no longer counts", async () => {
		const destination = nextDir()

		const restored = [narrowItem(coloredDir("restored", destination, "green"))]

		queryClient.setQueryData(driveListingQueryKey({ variant: "trash", uuid: null }), restored, { updatedAt: Date.now() })
		await mountRead(destination)
		fire({ type: "folderRestore", dir: mockDir("restored", destination) })

		expect(colorOf(destination, testUuid("restored"))).toBe("default")
		expect(isInvalidated(destination)).toBe(true)

		await refocus()

		expect(reads()).toBe(2)
	})

	// A trash echo carries only the uuid: its row came from a listing restored from disk.
	it("a trash listing given a disk-restored row lends none to its restore: the destination's read no longer counts", async () => {
		const source = nextDir()
		const destination = nextDir()

		const restored = [narrowItem(coloredDir("trashed", source, "red"))]

		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: source }), restored, { updatedAt: Date.now() })

		const trash = mountFlat("trash")

		await drain()
		trash.unmount()
		await mountRead(destination)
		fire({ type: "folderTrash", parent: source, uuid: testUuid("trashed") })
		fire({ type: "folderRestore", dir: mockDir("trashed", destination) })

		expect(colorOf(destination, testUuid("trashed"))).toBe("default")

		await refocus()

		expect(reads()).toBe(3)
	})

	// The read applies the colourless move to what it returns, where the payload's default would overwrite
	// the colour the server returned in a read that still counts.
	it("a Favorites read under way keeps the colour it returns through a colourless move, and lends it", async () => {
		const pending = deferred<NormalDirsAndFiles>()
		const home = nextDir()
		const destination = nextDir()

		listDirectory.mockImplementationOnce(() => pending.promise)

		const favorites = mountFlat("favorites")

		fire({ type: "folderMove", dir: { ...mockDir("fav", home), favorited: true } })
		pending.resolve({ dirs: [{ ...coloredDir("fav", home, "blue"), favorited: true }], files: [] })
		await drain()
		favorites.unmount()
		await mountRead(destination)
		fire({ type: "folderMove", dir: { ...mockDir("fav", destination), favorited: true } })

		expect(colorOf(destination, testUuid("fav"))).toBe("blue")

		await refocus()

		expect(reads()).toBe(2)
	})
})

describe("recents after a copy", () => {
	function copyRow(status: Transfer["status"]): Transfer {
		return {
			id: "copy",
			direction: "copy",
			name: "copy",
			size: 0,
			bytesTransferred: 0,
			status,
			paused: false,
			parentUuid: null,
			startedAt: 0
		}
	}

	// The copy's last echo typically follows its settle at once; it used to cancel the one post-copy
	// read, leaving Recents without everything deferred during the copy.
	it("the post-copy read and a trailing echo converge", async () => {
		mountFlat("recents")
		await drain()

		const dir = nextDir()
		const pending = deferred<NormalDirsAndFiles>()

		useTransfersStore.setState({ transfers: [copyRow("copying")] })
		fire({ type: "fileNew", file: named(mockFile("copied", dir), "copied.pdf") })
		useTransfersStore.setState({ transfers: [copyRow("done")] })
		listDirectory.mockImplementationOnce(() => pending.promise)
		flushDeferredRecents()
		fire({ type: "fileNew", file: named(mockFile("trailing", dir), "trailing.pdf") })
		pending.resolve({ dirs: [], files: [named(mockFile("copied", dir), "copied.pdf")] })
		await drain()

		expect(reads()).toBe(2)
		expect(
			queryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "recents", uuid: null }))?.map(item => item.data.uuid)
		).toEqual([testUuid("copied"), testUuid("trailing")])
	})
})
