// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { onlineManager, type QueryClient, type QueryKey } from "@tanstack/react-query"
import type { File, NormalDirsAndFiles, UuidStr } from "@filen/sdk-rs"

const { listPhotosRecursive, directoryRootChain } = vi.hoisted(() => ({
	listPhotosRecursive: vi.fn<(rootUuid: string) => Promise<NormalDirsAndFiles>>(),
	directoryRootChain: vi.fn<(uuid: string) => Promise<{ uuid: string; name: string }[] | null>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listPhotosRecursive, directoryRootChain } }))
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

import { queryClient } from "@/queries/client"
import { queryClientWrapper } from "@/tests/testQueryClient"
import { mergePhotosListings, photosListingQueryKey, usePhotosTimeline, type PhotosListing } from "@/features/photos/queries/photos"
import { directoryRootChainQueryOptions } from "@/lib/directoryRoots"
import { mergePhotosByCaptureDesc, sortPhotosByCaptureDesc, type PhotoItem } from "@/features/photos/lib/captureSort"
import { narrowItem } from "@/features/drive/lib/item"
import { testUuid } from "@/tests/support/uuid"

function mockFile(uuid: UuidStr, parent: UuidStr, uploaded: number): File {
	return {
		uuid,
		stableUUID: undefined,
		parent,
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: BigInt(uploaded),
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: `${uuid}.jpg`, mime: "image/jpeg", modified: BigInt(uploaded), size: 1_024n, key: "k", version: 2 }
		}
	}
}

function photo(name: string, uploaded: number): PhotoItem {
	const item = narrowItem(mockFile(testUuid(name), testUuid("dir"), uploaded))

	if (item.type !== "file") {
		throw new Error("not a file")
	}

	return item
}

const DAY = 86_400_000
const BASE = Date.UTC(2024, 0, 1)

const DRIVE = testUuid("drive")
const PICS = testUuid("pics")
const INNER = testUuid("inner")
const OTHER = testUuid("other")

const CHAINS: Record<string, { uuid: string; name: string }[]> = {
	[PICS]: [
		{ uuid: DRIVE, name: "" },
		{ uuid: PICS, name: "Pictures" }
	],
	[INNER]: [
		{ uuid: DRIVE, name: "" },
		{ uuid: PICS, name: "Pictures" },
		{ uuid: INNER, name: "2024" }
	],
	[OTHER]: [
		{ uuid: DRIVE, name: "" },
		{ uuid: OTHER, name: "Camera" }
	]
}

const wrapper = queryClientWrapper(queryClient)

beforeEach(() => {
	queryClient.clear()
	removedFromDisk.length = 0
	onlineManager.setOnline(true)
	listPhotosRecursive.mockReset()
	directoryRootChain.mockReset()
	directoryRootChain.mockImplementation(uuid => Promise.resolve(CHAINS[uuid] ?? null))
})

describe("merging photos listings", () => {
	it("merges sorted lists into the order a full sort gives, keeping a photo listed twice once", () => {
		const shared = photo("shared", BASE + 2 * DAY)
		const a = sortPhotosByCaptureDesc([photo("a1", BASE + 5 * DAY), photo("a2", BASE + DAY), photo("tie-b", BASE + 3 * DAY), shared])
		const b = sortPhotosByCaptureDesc([photo("b1", BASE + 4 * DAY), photo("tie-a", BASE + 3 * DAY), photo("b2", BASE), shared])

		expect(mergePhotosByCaptureDesc([a, b]).map(item => item.data.uuid)).toEqual(
			sortPhotosByCaptureDesc([...a.filter(item => item !== shared), ...b]).map(item => item.data.uuid)
		)
		expect(mergePhotosByCaptureDesc([])).toEqual([])
	})

	it("a single listing is itself; several join their directory paths", () => {
		const one: PhotosListing = { photos: [photo("x", BASE)], folders: { d1: "Trip" } }
		const two: PhotosListing = { photos: [photo("y", BASE + DAY)], folders: { d2: "Home" } }

		expect(mergePhotosListings([one])).toBe(one)
		expect(mergePhotosListings([one, two]).folders).toEqual({ d1: "Trip", d2: "Home" })
		expect(mergePhotosListings([one, two]).photos.map(item => item.data.uuid)).toEqual([testUuid("y"), testUuid("x")])
	})
})

describe("the photos timeline over several directories", () => {
	it("one directory: walked once, no chain resolved", async () => {
		listPhotosRecursive.mockResolvedValue({ dirs: [], files: [mockFile(testUuid("p"), PICS, BASE)] })

		const view = renderHook(() => usePhotosTimeline([PICS]), { wrapper })

		await waitFor(() => {
			expect(view.result.current.timeline.status).toBe("success")
		})
		expect(listPhotosRecursive).toHaveBeenCalledTimes(1)
		expect(directoryRootChain).not.toHaveBeenCalled()
	})

	it("merges disjoint directories into one timeline, newest first", async () => {
		listPhotosRecursive.mockImplementation(rootUuid =>
			Promise.resolve({
				dirs: [],
				files:
					rootUuid === PICS
						? [mockFile(testUuid("old"), PICS, BASE), mockFile(testUuid("new"), PICS, BASE + 9 * DAY)]
						: [mockFile(testUuid("mid"), OTHER, BASE + 5 * DAY)]
			})
		)

		const view = renderHook(() => usePhotosTimeline([PICS, OTHER]), { wrapper })

		await waitFor(() => {
			expect(view.result.current.timeline.status).toBe("success")
		})

		const timeline = view.result.current.timeline

		expect(timeline.status === "success" ? timeline.listing.photos.map(item => item.data.uuid) : []).toEqual([
			testUuid("new"),
			testUuid("mid"),
			testUuid("old")
		])
		expect(view.result.current.listedRoots).toEqual([PICS, OTHER])
		expect(listPhotosRecursive).toHaveBeenCalledTimes(2)
	})

	it("never walks a directory another one holds when the chains are held (restored from disk)", async () => {
		listPhotosRecursive.mockResolvedValue({ dirs: [], files: [] })

		for (const uuid of [INNER, PICS]) {
			queryClient.setQueryData(directoryRootChainQueryOptions(uuid).queryKey, CHAINS[uuid])
		}

		const view = renderHook(() => usePhotosTimeline([INNER, PICS]), { wrapper })

		await waitFor(() => {
			expect(view.result.current.timeline.status).toBe("success")
		})
		expect(view.result.current.listedRoots).toEqual([PICS])
		expect(listPhotosRecursive.mock.calls.map(([rootUuid]) => rootUuid)).toEqual([PICS])
	})

	it("lists every directory at once while chains are unresolved, then drops a nested one and its listing", async () => {
		let resolveChains: () => void = () => undefined
		const chainsReady = new Promise<void>(resolve => {
			resolveChains = resolve
		})

		directoryRootChain.mockImplementation(async uuid => {
			await chainsReady

			return CHAINS[uuid] ?? null
		})
		listPhotosRecursive.mockImplementation(rootUuid =>
			Promise.resolve({
				dirs: [],
				files: rootUuid === INNER ? [mockFile(testUuid("dup"), INNER, BASE)] : [mockFile(testUuid("dup"), INNER, BASE)]
			})
		)

		const view = renderHook(() => usePhotosTimeline([INNER, PICS]), { wrapper })

		await waitFor(() => {
			expect(view.result.current.timeline.status).toBe("success")
		})
		expect(view.result.current.listedRoots).toEqual([INNER, PICS])

		const timeline = view.result.current.timeline

		// The photo both walks found shows once.
		expect(timeline.status === "success" ? timeline.listing.photos.length : 0).toBe(1)

		await act(async () => {
			resolveChains()
			await chainsReady
		})
		await waitFor(() => {
			expect(view.result.current.listedRoots).toEqual([PICS])
		})
		await waitFor(() => {
			expect(queryClient.getQueryData(photosListingQueryKey(INNER))).toBeUndefined()
		})
		expect(removedFromDisk).toContainEqual(photosListingQueryKey(INNER))
	})

	it("offline, shows the held listings at once though no chain can be resolved", () => {
		queryClient.setQueryData(photosListingQueryKey(PICS), { photos: [photo("held", BASE)], folders: {} })
		queryClient.setQueryData(photosListingQueryKey(OTHER), { photos: [], folders: {} })
		onlineManager.setOnline(false)

		const view = renderHook(() => usePhotosTimeline([PICS, OTHER]), { wrapper })
		const timeline = view.result.current.timeline

		expect(timeline.status).toBe("success")
		expect(timeline.status === "success" ? timeline.listing.photos.map(item => item.data.uuid) : []).toEqual([testUuid("held")])
		expect(directoryRootChain).not.toHaveBeenCalled()
	})

	it("resolves a chain restored from disk again once per session, then reuses it", async () => {
		// Never resolved this session (chains are page-session state).
		const restored = testUuid("restored")

		queryClient.setQueryData(directoryRootChainQueryOptions(restored).queryKey, [{ uuid: DRIVE, name: "" }])

		await queryClient.query(directoryRootChainQueryOptions(restored))
		await queryClient.query(directoryRootChainQueryOptions(restored))

		expect(directoryRootChain).toHaveBeenCalledTimes(1)
	})

	it("shows what listed when one directory fails, and errors only when all do", async () => {
		listPhotosRecursive.mockImplementation(rootUuid =>
			rootUuid === PICS
				? Promise.reject(new Error("boom"))
				: Promise.resolve({ dirs: [], files: [mockFile(testUuid("ok"), OTHER, BASE)] })
		)

		const view = renderHook(() => usePhotosTimeline([PICS, OTHER]), { wrapper })

		await waitFor(() => {
			expect(view.result.current.timeline.status).toBe("success")
		})
		expect(view.result.current.failures.map(failure => failure.rootUuid)).toEqual([PICS])

		view.unmount()
		listPhotosRecursive.mockRejectedValue(new Error("down"))
		queryClient.clear()

		const failing = renderHook(() => usePhotosTimeline([PICS, OTHER]), { wrapper })

		await waitFor(() => {
			expect(failing.result.current.timeline.status).toBe("error")
		})
	})
})
