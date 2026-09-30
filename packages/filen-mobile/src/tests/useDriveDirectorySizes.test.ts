// @vitest-environment happy-dom

// The size-sort map is rebuilt from the query cache as sizes land. Rebuilds must read exactly what
// getQueryData would, react only to this listing's size type, and coalesce to one per frame.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { renderHook, cleanup, act } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import { serialize } from "@/lib/serializer"

const holder = vi.hoisted(() => ({ client: null as unknown as import("@tanstack/react-query").QueryClient }))

vi.mock("@filen/shared", async () => await import("@/tests/mocks/filenShared"))
vi.mock("@/queries/client", () => ({
	get queryClient() {
		return holder.client
	},
	getCachedQuery: (queryKey: unknown[]) => holder.client.getQueryCache().find({ queryKey, exact: true }),
	queryUpdater: { set: vi.fn() }
}))
vi.mock("@/lib/cache", () => ({ default: {} }))
vi.mock("@/lib/auth", () => ({ default: { getSdkClients: vi.fn() } }))
vi.mock("@/features/offline/offline", () => ({ default: {} }))
vi.mock("@/features/drive/driveSelectors", () => ({
	isDirectoryItem: (item: { type: string }) => item.type === "directory"
}))
vi.mock("@/features/drive/utils", () => ({
	directorySizeTypeForDrivePath: (type: string | null) => (type === "trash" ? "trash" : "normal")
}))
vi.mock("@filen/sdk-rs", () => ({}))

import { useDriveDirectorySizes } from "@/features/drive/hooks/useDriveDirectorySizes"
import { directorySizeQueryOptions, type UseDirectorySizeQueryParams } from "@/features/drive/queries/useDirectorySize.query"
import type { DriveItem } from "@/types"

const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1

function flushFrames(): void {
	act(() => {
		const pending = [...frames.values()]

		frames.clear()

		for (const callback of pending) {
			callback(0)
		}
	})
}

function sizeKey(uuid: string, type: UseDirectorySizeQueryParams["type"]): unknown[] {
	return directorySizeQueryOptions({ uuid, type }).queryKey
}

function land(uuid: string, type: UseDirectorySizeQueryParams["type"], size: number): void {
	holder.client.setQueryData(sizeKey(uuid, type), { size, files: 0, dirs: 0 })
}

const items = [
	{ type: "directory", data: { uuid: "dir-1" } },
	{ type: "directory", data: { uuid: "dir-2" } },
	{ type: "directory", data: { uuid: "dir-3" } },
	{ type: "file", data: { uuid: "file-1" } }
] as unknown as DriveItem[]

function renderSizes() {
	let renders = 0

	const hook = renderHook(() => {
		renders++

		return useDriveDirectorySizes({ items, drivePathType: "drive", enabled: true })
	})

	return { ...hook, renders: () => renders }
}

beforeEach(() => {
	// The app's global queryKeyHashFn.
	holder.client = new QueryClient({ defaultOptions: { queries: { queryKeyHashFn: queryKey => serialize(queryKey), retry: false } } })
	vi.spyOn(holder.client, "prefetchQuery").mockResolvedValue(undefined)

	frames.clear()
	nextFrame = 1

	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		const id = nextFrame++

		frames.set(id, callback)

		return id
	})
	vi.stubGlobal(
		"cancelAnimationFrame",
		vi.fn((id: number) => {
			frames.delete(id)
		})
	)
})

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

describe("useDriveDirectorySizes", () => {
	it("reads exactly what getQueryData returns for this listing's type", () => {
		land("dir-1", "normal", 5)
		land("dir-2", "normal", 7)
		land("dir-3", "trash", 99)

		const { result } = renderSizes()

		const expected = new Map<string, number>()

		for (const uuid of ["dir-1", "dir-2", "dir-3"]) {
			const data = holder.client.getQueryData<{ size: number }>(sizeKey(uuid, "normal"))

			if (data) {
				expected.set(uuid, data.size)
			}
		}

		expect(result.current).toEqual(expected)
		expect(result.current).toEqual(
			new Map([
				["dir-1", 5],
				["dir-2", 7]
			])
		)
	})

	it("does not rebuild for a size of another type", () => {
		const { result, renders } = renderSizes()
		const rendersBefore = renders()

		land("dir-1", "trash", 99)

		expect(frames.size).toBe(0)

		flushFrames()

		expect(renders()).toBe(rendersBefore)
		expect(result.current).toBeUndefined()
	})

	it("coalesces several landings in one frame into one rebuild", () => {
		const { result, renders } = renderSizes()
		const rendersBefore = renders()

		land("dir-1", "normal", 5)
		land("dir-2", "normal", 7)
		land("dir-1", "normal", 6)

		expect(frames.size).toBe(1)

		flushFrames()

		expect(renders()).toBe(rendersBefore + 1)
		expect(result.current).toEqual(
			new Map([
				["dir-1", 6],
				["dir-2", 7]
			])
		)

		land("dir-3", "normal", 1)
		flushFrames()

		expect(renders()).toBe(rendersBefore + 2)
		expect(result.current?.get("dir-3")).toBe(1)
	})

	it("cancels a pending frame on unmount", () => {
		const { unmount } = renderSizes()

		land("dir-1", "normal", 5)

		expect(frames.size).toBe(1)

		unmount()

		expect(cancelAnimationFrame).toHaveBeenCalledTimes(1)
		expect(frames.size).toBe(0)
	})
})
