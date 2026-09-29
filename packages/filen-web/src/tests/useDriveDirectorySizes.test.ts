// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { Dir, DirSizeResponse, UuidStr } from "@filen/sdk-rs"

const { getDirSize } = vi.hoisted(() => ({ getDirSize: vi.fn<(dir: unknown) => Promise<DirSizeResponse>>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getDirSize } }))
vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client({ defaultOptions: { queries: { retry: false } } }) }
})

import { queryClient } from "@/queries/client"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { directorySizeQueryKey } from "@/features/drive/queries/drive"
import { useDriveDirectorySizes } from "@/features/drive/hooks/useDriveDirectorySizes"

// Every test uses its own directory uuids: the query cache outlives a test.
let dirCounter = 0

function nextDir(): DriveItem {
	dirCounter++

	return narrowItem({
		uuid: `dir${String(dirCounter)}-0000-0000-0000-000000000000` as UuidStr,
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: `dir${String(dirCounter)}` } }
	} satisfies Dir)
}

function sizeOf(bytes: number): DirSizeResponse {
	return { size: BigInt(bytes), files: 1n, dirs: 0n }
}

function nextFrame(): Promise<void> {
	return act(async () => {
		await new Promise(resolve => {
			requestAnimationFrame(resolve)
		})
	})
}

describe("useDriveDirectorySizes", () => {
	it("coalesces size results landing within one frame into a single re-render", async () => {
		const items = [nextDir(), nextDir(), nextDir()]
		getDirSize.mockReturnValue(new Promise(() => undefined))
		let renders = 0

		const { result } = renderHook(() => {
			renders++

			return useDriveDirectorySizes({ items, enabled: true })
		})
		const rendersBefore = renders

		act(() => {
			items.forEach((item, index) => {
				queryClient.setQueryData(directorySizeQueryKey(item.data.uuid), sizeOf(index + 1))
			})
		})

		expect(renders).toBe(rendersBefore)

		await nextFrame()

		expect(renders).toBe(rendersBefore + 1)
		expect(result.current).toEqual(new Map(items.map((item, index) => [item.data.uuid, index + 1])))
		getDirSize.mockReset()
	})

	it("with prefetch off fires no size walk but still reads sizes already cached", async () => {
		const cached = nextDir()
		const uncached = nextDir()
		queryClient.setQueryData(directorySizeQueryKey(cached.data.uuid), sizeOf(42))

		const { result } = renderHook(() => useDriveDirectorySizes({ items: [cached, uncached], enabled: true, prefetch: false }))

		await nextFrame()

		expect(getDirSize).not.toHaveBeenCalled()
		expect(result.current).toEqual(new Map([[cached.data.uuid, 42]]))
	})

	it("prefetches every uncached directory by default", async () => {
		const items = [nextDir(), nextDir()]
		getDirSize.mockResolvedValue(sizeOf(7))

		const { result } = renderHook(() => useDriveDirectorySizes({ items, enabled: true }))

		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0))
		})
		await nextFrame()

		expect(getDirSize).toHaveBeenCalledTimes(2)
		expect(result.current).toEqual(new Map(items.map(item => [item.data.uuid, 7])))
		getDirSize.mockReset()
	})
})
