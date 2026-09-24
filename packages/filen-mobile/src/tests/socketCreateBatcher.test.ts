// The socket create batcher on a fresh instance: one write per window, and the logout close. After
// logout, socket events already queued for JS and a copy's late creates still arrive; none of them may
// patch the ended account's listings.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const h = vi.hoisted(() => ({
	upsertMany: vi.fn(),
	upsertPhotos: vi.fn(),
	updateRecents: vi.fn(),
	markStale: vi.fn(),
	cacheDriveItem: vi.fn()
}))

vi.mock("@/lib/cache", () => ({ default: { cacheDriveItem: h.cacheDriveItem } }))
vi.mock("@/features/drive/queries/useDriveItems.query", () => ({
	driveItemsQueryIsReadForNormalParent: () => true,
	driveItemsQueryUpsertManyForNormalParent: h.upsertMany,
	driveItemsQueryUpsertManyIntoPhotos: h.upsertPhotos,
	driveItemsQueryUpdateForRecents: h.updateRecents
}))
vi.mock("@/features/drive/queries/useDirectorySize.query", () => ({ markDirectorySizesStale: h.markStale }))

import { SocketCreateBatcher, SOCKET_CREATE_FLUSH_MS } from "@/features/drive/socketCreateBatcher"
import type { DriveItem } from "@/types"

function file(uuid: string): DriveItem {
	return { type: "file", data: { uuid, parent: "dest" } } as unknown as DriveItem
}

function writes(): number {
	return (
		h.upsertMany.mock.calls.length +
		h.upsertPhotos.mock.calls.length +
		h.updateRecents.mock.calls.length +
		h.markStale.mock.calls.length
	)
}

beforeEach(() => {
	vi.useFakeTimers()

	for (const spy of Object.values(h)) {
		spy.mockClear()
	}
})

afterEach(() => {
	vi.useRealTimers()
})

describe("SocketCreateBatcher", () => {
	it("writes a window's creates once", () => {
		const batcher = new SocketCreateBatcher()

		batcher.enqueue({ parentUuid: "dest", item: file("a"), recent: true })
		batcher.enqueue({ parentUuid: "dest", item: file("b"), recent: true })

		expect(writes()).toBe(0)

		vi.advanceTimersByTime(SOCKET_CREATE_FLUSH_MS)

		expect(h.upsertMany).toHaveBeenCalledExactlyOnceWith({ parentUuid: "dest", items: [file("a"), file("b")] })
	})

	it("after discard, neither what was queued nor anything enqueued later is written, however it is flushed", () => {
		const batcher = new SocketCreateBatcher()

		batcher.enqueue({ parentUuid: "dest", item: file("queued"), recent: true })
		batcher.discard()
		batcher.enqueue({ parentUuid: "dest", item: file("late"), recent: true })

		vi.advanceTimersByTime(SOCKET_CREATE_FLUSH_MS * 4)
		batcher.flushNow()

		expect(writes()).toBe(0)
		expect(h.cacheDriveItem).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})
})
