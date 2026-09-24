// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { CopyCounts, CopyReport, Dir, File, NormalDirsAndFiles, SocketEvent, UserInfo, UuidStr } from "@filen/sdk-rs"
import type { CopyJobEvent } from "@/workers/sdk.worker"

const { listDirectory, copyItems, getUserInfo } = vi.hoisted(() => ({
	listDirectory: vi.fn<(target: unknown) => Promise<NormalDirsAndFiles>>(),
	copyItems:
		vi.fn<
			(
				id: string,
				items: unknown,
				destinationUuid: string | null,
				maxBytes: number | undefined,
				onEvent: (event: CopyJobEvent) => void
			) => Promise<CopyReport>
		>(),
	getUserInfo: vi.fn<() => Promise<UserInfo>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listDirectory, copyItems, getUserInfo, releaseCopy: vi.fn() } }))

// The production defaults minus the persister (sqlite, unavailable under vitest).
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({
		defaultOptions: {
			queries: { staleTime: 0, gcTime: Infinity, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true }
		}
	})
}))

vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() } }))

import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { discardListingPatches, driveListingQueryKey, flushListingCreates, useDirectoryListingQuery } from "@/features/drive/queries/drive"
import { handleDriveEvent } from "@/features/drive/lib/socketHandlers"
import { startCopy } from "@/features/drive/lib/copy"
import { getCopyJob } from "@/features/transfers/store/useCopyJobsStore"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { socketAuthenticated } from "@/lib/sdk/socketSession"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const ROOT = testUuid("root")
const TOP = testUuid("top")
const NESTED_DIRS = 40
const FILES_PER_DIR = 25

function mockDir(uuid: UuidStr, parent: UuidStr, name = "dir"): Dir {
	return { uuid, parent, color: "default", timestamp: 1_700_000_000_000n, favorited: false, meta: { type: "decoded", data: { name } } }
}

function mockFile(uuid: UuidStr, parent: UuidStr): File {
	return {
		uuid,
		stableUUID: undefined,
		parent,
		size: 10n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: { name: `${uuid}.txt`, mime: "text/plain", modified: 1_700_000_000_000n, size: 10n, key: "k", version: 2 }
		}
	}
}

function counts(overrides: Partial<CopyCounts> = {}): CopyCounts {
	return {
		dirsCreated: 0n,
		dirsFailed: 0n,
		filesDone: 0n,
		filesFailed: 0n,
		bytesDone: 0n,
		bytesFailed: 0n,
		dirsNotAttempted: 0n,
		filesNotAttempted: 0n,
		bytesNotAttempted: 0n,
		entriesSkipped: 0n,
		bytesSkipped: 0n,
		...overrides
	}
}

function driveEvent(inner: Extract<SocketEvent, { type: "drive" }>["inner"]): Extract<SocketEvent, { type: "drive" }> {
	return { type: "drive", inner, driveMessageId: 0n }
}

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

function listingKeys(): string[] {
	return queryClient
		.getQueryCache()
		.findAll({ queryKey: ["drive", "listing"] })
		.map(query => query.queryHash)
}

// What the socket delivers for a copy of one directory holding NESTED_DIRS directories of
// FILES_PER_DIR files each: the top-level directory's own echo, then every nested create.
function copyEchoes(): void {
	handleDriveEvent(driveEvent({ type: "folderSubCreated", dir: mockDir(TOP, ROOT, "top") }))

	for (let d = 0; d < NESTED_DIRS; d++) {
		const dir = testUuid(`nested${String(d)}`)

		handleDriveEvent(driveEvent({ type: "folderSubCreated", dir: mockDir(dir, TOP) }))

		for (let f = 0; f < FILES_PER_DIR; f++) {
			handleDriveEvent(driveEvent({ type: "fileNew", file: mockFile(testUuid(`file${String(d)}x${String(f)}`), dir) }))
		}
	}
}

beforeEach(() => {
	queryClient.clear()
	discardListingPatches()
	socketAuthenticated()
	useTransfersStore.setState({ transfers: [], speedSamples: [] })
	listDirectory.mockReset()
	listDirectory.mockImplementation(() => Promise.resolve({ dirs: [], files: [] }))
	queryClient.setQueryData<Partial<UserInfo>>(ACCOUNT_QUERY_KEY, { rootDirUuid: ROOT, maxStorage: 1_000_000n, storageUsed: 1_000n })
})

describe("copy request counts", () => {
	it("a large copy into the open directory reads nothing more and creates no listings, and recents reads once after it", async () => {
		renderHook(() => useDirectoryListingQuery("drive", null), { wrapper })
		renderHook(() => useDirectoryListingQuery("recents", null), { wrapper })
		await drain()

		const readsBefore = listDirectory.mock.calls.length
		const keysBefore = listingKeys()
		const finish = deferred<CopyReport>()
		const source = narrowItem(mockDir(testUuid("source"), ROOT, "source"))

		expect(readsBefore).toBe(2)

		copyItems.mockImplementation((_id, _items, _destination, _maxBytes, onEvent) => {
			onEvent({
				type: "created",
				item: { request: 0n, sourceUuid: source.data.uuid, item: { type: "dir", ...mockDir(TOP, ROOT, "top") } }
			})
			copyEchoes()

			return finish.promise
		})

		const id = startCopy([source], { uuid: null, name: "My Drive" })

		await drain()

		const write = vi.spyOn(queryClient, "setQueryData")

		flushListingCreates()

		// Mid-copy: the open listing holds the top-level copy once, taken with its echo in one write;
		// recents is left alone.
		expect(write.mock.calls.filter(([key]) => key[1] === "listing")).toHaveLength(1)
		expect(
			queryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "drive", uuid: null }))?.map(i => i.data.uuid)
		).toEqual([TOP])
		expect(queryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "recents", uuid: null }))).toEqual([])
		expect(listDirectory.mock.calls.length).toBe(readsBefore)
		expect(listingKeys()).toEqual(keysBefore)

		finish.resolve({
			topLevel: [],
			failures: [],
			skipped: [],
			renamed: [],
			totals: { dirs: 41n, files: 1_000n, bytes: 10_000n },
			counts: counts({ dirsCreated: 41n, filesDone: 1_000n, bytesDone: 10_000n }),
			error: undefined
		})
		await drain()

		expect(getCopyJob(id ?? "")?.outcome).toEqual({ status: "done" })
		// Exactly one more read, for recents, now that no copy runs.
		expect(listDirectory.mock.calls.length).toBe(readsBefore + 1)
		expect(listingKeys()).toEqual(keysBefore)
		// The quota came from the cached account; storage used is patched, not re-read.
		expect(copyItems.mock.calls[0]?.[3]).toBe(999_000)
		expect(getUserInfo).not.toHaveBeenCalled()
		expect(queryClient.getQueryData<UserInfo>(ACCOUNT_QUERY_KEY)?.storageUsed).toBe(11_000n)
	})
})
