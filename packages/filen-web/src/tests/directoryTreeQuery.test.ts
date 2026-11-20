// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { focusManager, onlineManager } from "@tanstack/react-query"
import type { Dir, File, NormalDirsAndFiles } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"

const { listDirectory } = vi.hoisted(() => ({
	listDirectory: vi.fn<(target: unknown) => Promise<NormalDirsAndFiles>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listDirectory } }))

// The same instance backs the provider below AND driveListingQueryUpdate, so a patch lands where the
// hooks read.
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))

import { queryClient } from "@/queries/client"
import { queryClientWrapper } from "@/tests/testQueryClient"
import {
	cachedDirectoryTreeChildren,
	driveListingQueryKey,
	driveListingQueryUpdate,
	useDirectoryListingQuery,
	useDirectoryTreeChildrenQuery,
	useDirectoryTreeLevelsQuery
} from "@/features/drive/queries/drive"
import { socketAuthenticated } from "@/lib/sdk/socketSession"
import { testUuid } from "@/tests/support/uuid"

function mockDir(label: string, name: string): Dir {
	return {
		uuid: testUuid(label),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	}
}

function mockFile(label: string): File {
	return {
		uuid: testUuid(label),
		stableUUID: undefined,
		parent: testUuid("parent"),
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
		}
	}
}

const LISTING: NormalDirsAndFiles = { dirs: [mockDir("zeta", "Zeta"), mockDir("alpha", "Alpha")], files: [mockFile("file")] }

const wrapper = queryClientWrapper(queryClient)

function renderTreeAndListing(uuid: string | null) {
	return renderHook(
		() => ({
			listing: useDirectoryListingQuery("drive", uuid),
			tree: useDirectoryTreeChildrenQuery(uuid)
		}),
		{ wrapper }
	)
}

beforeEach(() => {
	queryClient.clear()
	socketAuthenticated()
	listDirectory.mockImplementation(() => Promise.resolve(LISTING))
})

afterEach(() => {
	focusManager.setFocused(undefined)
	onlineManager.setOnline(true)
})

describe("useDirectoryTreeChildrenQuery shares the drive listing's cache entry", () => {
	it("dedupes the concurrent mount of the tree and the listing into one listDirectory", async () => {
		const { result } = renderTreeAndListing(null)

		await waitFor(() => {
			expect(result.current.tree.isSuccess).toBe(true)
			expect(result.current.listing.isSuccess).toBe(true)
		})

		expect(listDirectory).toHaveBeenCalledTimes(1)
		expect(listDirectory).toHaveBeenCalledWith({ kind: "root" })
		expect(result.current.listing.data).toHaveLength(3)
		expect(result.current.tree.data).toEqual([
			{ uuid: testUuid("alpha"), name: "Alpha", color: "default" },
			{ uuid: testUuid("zeta"), name: "Zeta", color: "default" }
		])
	})

	it("skips the refetch on window focus and refetches once, not once per observer, on reconnect", async () => {
		const { result } = renderTreeAndListing(null)

		await waitFor(() => {
			expect(result.current.tree.isSuccess).toBe(true)
		})
		expect(listDirectory).toHaveBeenCalledTimes(1)

		act(() => {
			focusManager.setFocused(false)
			focusManager.setFocused(true)
		})
		await waitFor(() => {
			expect(queryClient.isFetching()).toBe(0)
		})
		expect(listDirectory).toHaveBeenCalledTimes(1)

		act(() => {
			onlineManager.setOnline(false)
			onlineManager.setOnline(true)
		})
		await waitFor(() => {
			expect(queryClient.isFetching()).toBe(0)
		})
		expect(listDirectory).toHaveBeenCalledTimes(2)
	})

	it("serves a node already listed in the main pane from that entry, with only the one stale-mount refetch", async () => {
		const uuid = testUuid("opened")
		const key = driveListingQueryKey({ variant: "drive", uuid })
		queryClient.setQueryData(key, [narrowItem(mockDir("child", "Child"))])

		const { result } = renderHook(() => useDirectoryTreeChildrenQuery(uuid), { wrapper })

		// Rendered straight from the listing's cached data before any fetch resolves.
		expect(result.current.data).toEqual([{ uuid: testUuid("child"), name: "Child", color: "default" }])

		await waitFor(() => {
			expect(queryClient.isFetching()).toBe(0)
		})

		expect(listDirectory).toHaveBeenCalledTimes(1)
		expect(listDirectory).toHaveBeenCalledWith({ kind: "uuid", uuid })
		// The listing's entry alone, beside the `.filen` visibility preference every tree node reads.
		expect(
			queryClient
				.getQueryCache()
				.findAll({ queryKey: ["drive"] })
				.map(query => query.queryKey[1])
		).toEqual(["listing", "showDotFilenPreference"])
	})

	it("picks up a listing patch without a fetch", async () => {
		const { result } = renderHook(() => useDirectoryTreeChildrenQuery(null), { wrapper })

		// Reading `data` here also subscribes to it: the result is a tracked proxy, and a component
		// reads `data` while rendering, which a bare renderHook callback never does.
		await waitFor(() => {
			expect(result.current.data?.map(child => child.name)).toEqual(["Alpha", "Zeta"])
		})

		act(() => {
			driveListingQueryUpdate(null, prev => [...prev, narrowItem(mockDir("beta", "Beta"))])
		})

		await waitFor(() => {
			expect(result.current.data?.map(child => child.name)).toEqual(["Alpha", "Beta", "Zeta"])
		})
		expect(listDirectory).toHaveBeenCalledTimes(1)
	})
})

describe("useDirectoryTreeLevelsQuery observes every open level in one hook", () => {
	it("serves each level from its listing's entry, in order, and keeps its result while nothing changes", async () => {
		const opened = testUuid("opened")
		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: opened }), [narrowItem(mockDir("child", "Child"))])

		const { result, rerender } = renderHook(() => useDirectoryTreeLevelsQuery([null, opened]), { wrapper })

		// Rendered straight from the listing's cached data before any fetch resolves.
		expect(result.current[1]).toMatchObject({
			status: "success",
			data: [{ uuid: testUuid("child"), name: "Child", color: "default" }]
		})

		await waitFor(() => {
			expect(queryClient.isFetching()).toBe(0)
		})

		expect(result.current[0]?.data?.map(child => child.name)).toEqual(["Alpha", "Zeta"])
		expect(listDirectory).toHaveBeenCalledWith({ kind: "root" })

		const settled = result.current

		rerender()
		expect(result.current).toBe(settled)
	})
})

describe("cachedDirectoryTreeChildren reads a level the tree does not observe yet", () => {
	it("projects a held listing as the level's query would, and never fetches", () => {
		const held = testUuid("held")

		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: held }), [
			narrowItem(mockDir("zeta", "Zeta")),
			narrowItem(mockFile("file")),
			narrowItem(mockDir("alpha", "Alpha"))
		])

		expect(cachedDirectoryTreeChildren(held)?.map(child => child.name)).toEqual(["Alpha", "Zeta"])
		expect(cachedDirectoryTreeChildren(testUuid("unlisted"))).toBeUndefined()
		expect(listDirectory).not.toHaveBeenCalled()
	})
})
