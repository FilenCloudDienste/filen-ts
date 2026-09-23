// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, render, renderHook, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Dir, DirSizeResponse, File, UuidStr } from "@filen/sdk-rs"
import { formatBytes } from "@filen/shared"
import "@/lib/i18n"

const { getItemInfo, getDirSize } = vi.hoisted(() => ({
	getItemInfo: vi.fn<(item: Dir | File) => Promise<{ path: string | null; ancestors: Dir[] }>>(),
	getDirSize: vi.fn<(dir: unknown) => Promise<DirSizeResponse>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getItemInfo, getDirSize } }))

// The production defaults minus the persister (sqlite, unavailable under vitest).
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({
		defaultOptions: {
			queries: { staleTime: 0, gcTime: Infinity, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true }
		}
	})
}))

vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

// The hero thumbnail pipeline and the Location link's router are out of scope for a request count.
vi.mock("@/features/drive/hooks/useThumbnail", () => ({ useThumbnail: () => null }))
vi.mock("@/features/drive/lib/thumbnails", () => ({ invalidateThumbnail: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: ReactNode }) => createElement("a", null, children)
}))

import { queryClient } from "@/queries/client"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { DIRECTORY_SIZE_STALE_TIME, directorySizeQueryKey, invalidateDirectorySize } from "@/features/drive/queries/drive"
import { useDriveDirectorySizes } from "@/features/drive/hooks/useDriveDirectorySizes"
import { InfoDialog } from "@/features/drive/components/infoDialog"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockDir(label: string): Dir {
	return {
		uuid: testUuid(label),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } }
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
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: { name: `${label}.pdf`, mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		}
	}
}

const SIZE: DirSizeResponse = { size: 5_242_880n, files: 7n, dirs: 2n }
const FRESHER_SIZE: DirSizeResponse = { size: 10_485_760n, files: 9n, dirs: 2n }
const PATH = { path: "Documents/Projects/", ancestors: [] }

// Every test uses its own directory uuid: the query cache outlives a test.
let dirCounter = 0

function nextDir(): DriveItem {
	dirCounter++

	return narrowItem(mockDir(`dir${String(dirCounter)}`))
}

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient, children })
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

// The list view's row-size prefetch, exactly as directoryListing.tsx drives it.
async function listViewResolves(item: DriveItem): Promise<void> {
	getDirSize.mockResolvedValueOnce(SIZE)
	renderHook(() => useDriveDirectorySizes({ items: [item], enabled: true }), { wrapper })
	await drain()
}

async function openInfo(item: DriveItem, remoteInfoEnabled = true): Promise<void> {
	render(createElement(InfoDialog, { item, variant: "drive", remoteInfoEnabled, onClose: vi.fn() }), { wrapper })
	await drain()
}

describe("InfoDialog request count", () => {
	it("reuses a size the list view already resolved: 0 extra getDirSize, path still resolved", async () => {
		const item = nextDir()
		await listViewResolves(item)
		expect(getDirSize).toHaveBeenCalledTimes(1)

		getItemInfo.mockResolvedValueOnce(PATH)
		await openInfo(item)

		expect(getDirSize).toHaveBeenCalledTimes(1)
		expect(getItemInfo).toHaveBeenCalledExactlyOnceWith(item.data)
		expect(screen.getByText(formatBytes(Number(SIZE.size)))).toBeTruthy()
		expect(screen.getByText("7")).toBeTruthy()
		expect(screen.getByText("Documents/Projects")).toBeTruthy()
	})

	it("fetches the size once when none is cached", async () => {
		const item = nextDir()
		getDirSize.mockResolvedValueOnce(SIZE)
		getItemInfo.mockResolvedValueOnce(PATH)

		await openInfo(item)

		expect(getDirSize).toHaveBeenCalledTimes(1)
		expect(getItemInfo).toHaveBeenCalledTimes(1)
		expect(screen.getByText(formatBytes(Number(SIZE.size)))).toBeTruthy()
		expect(screen.getByText("Documents/Projects")).toBeTruthy()
	})

	it("refetches a size invalidated by a write (upload) once, and shows the fresh value", async () => {
		const item = nextDir()
		await listViewResolves(item)
		invalidateDirectorySize(item.data.uuid)

		getDirSize.mockResolvedValueOnce(FRESHER_SIZE)
		getItemInfo.mockResolvedValueOnce(PATH)
		await openInfo(item)

		expect(getDirSize).toHaveBeenCalledTimes(2)
		expect(screen.getByText(formatBytes(Number(FRESHER_SIZE.size)))).toBeTruthy()
	})

	it("refetches a size older than the stale time once", async () => {
		const item = nextDir()
		queryClient.setQueryData(directorySizeQueryKey(item.data.uuid), SIZE, {
			updatedAt: Date.now() - DIRECTORY_SIZE_STALE_TIME - 1
		})

		getDirSize.mockResolvedValueOnce(FRESHER_SIZE)
		getItemInfo.mockResolvedValueOnce(PATH)
		await openInfo(item)

		expect(getDirSize).toHaveBeenCalledTimes(1)
		expect(screen.getByText(formatBytes(Number(FRESHER_SIZE.size)))).toBeTruthy()
	})

	it("never reads a size for a file", async () => {
		const item = narrowItem(mockFile("file1"))
		getItemInfo.mockResolvedValueOnce(PATH)

		await openInfo(item)

		expect(getDirSize).not.toHaveBeenCalled()
		expect(getItemInfo).toHaveBeenCalledExactlyOnceWith(item.data)
		expect(screen.getByText("Documents/Projects")).toBeTruthy()
	})

	it("reads nothing and shows no size rows with remote info disabled (trash), even with a cached size", async () => {
		const item = nextDir()
		await listViewResolves(item)

		await openInfo(item, false)

		expect(getDirSize).toHaveBeenCalledTimes(1)
		expect(getItemInfo).not.toHaveBeenCalled()
		expect(screen.queryByText(formatBytes(Number(SIZE.size)))).toBeNull()
		expect(screen.queryByText("Files")).toBeNull()
	})
})
