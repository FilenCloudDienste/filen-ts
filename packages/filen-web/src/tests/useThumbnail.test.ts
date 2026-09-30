// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook } from "@testing-library/react"
import type { File as SdkFile } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import { testUuid } from "@/tests/support/uuid"

const { getThumbnailUrlMock, peekThumbnailUrlMock } = vi.hoisted(() => ({
	getThumbnailUrlMock: vi.fn<(item: unknown, deps: unknown, signal?: AbortSignal) => Promise<string | null>>(),
	peekThumbnailUrlMock: vi.fn<(uuid: string) => string | null>()
}))

vi.mock("@/features/drive/lib/thumbnails", () => ({ getThumbnailUrl: getThumbnailUrlMock, peekThumbnailUrl: peekThumbnailUrlMock }))
vi.mock("@/features/drive/lib/thumbGenerators", () => ({}))

import { useThumbnail } from "@/features/drive/hooks/useThumbnail"

afterEach(() => {
	cleanup()
	getThumbnailUrlMock.mockReset()
	peekThumbnailUrlMock.mockReset()
})

function imageFile(): SdkFile {
	return {
		uuid: testUuid("thumb"),
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
			data: { name: "photo.jpg", mime: "image/jpeg", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		}
	}
}

describe("useThumbnail", () => {
	// The service drops a queued generation only once every interested cell has withdrawn.
	it("withdraws its interest on unmount", () => {
		getThumbnailUrlMock.mockReturnValue(new Promise(() => undefined))

		const { unmount } = renderHook(() => useThumbnail(narrowItem(imageFile())))
		const signal = getThumbnailUrlMock.mock.calls[0]?.[2]

		expect(signal?.aborted).toBe(false)

		unmount()

		expect(signal?.aborted).toBe(true)
	})

	it("returns a cached url on the first render", () => {
		getThumbnailUrlMock.mockReturnValue(new Promise(() => undefined))
		peekThumbnailUrlMock.mockReturnValue("blob:cached")

		const file = imageFile()
		const { result } = renderHook(() => useThumbnail(narrowItem(file)))

		expect(result.current).toBe("blob:cached")
		expect(peekThumbnailUrlMock).toHaveBeenCalledWith(file.uuid)
	})

	it("starts at null when nothing is cached", () => {
		getThumbnailUrlMock.mockReturnValue(new Promise(() => undefined))
		peekThumbnailUrlMock.mockReturnValue(null)

		const { result } = renderHook(() => useThumbnail(narrowItem(imageFile())))

		expect(result.current).toBeNull()
	})

	// A file whose category lost its thumbnail story keeps rendering its icon even while its url is cached.
	it("never peeks for a category with no thumbnail", () => {
		peekThumbnailUrlMock.mockReturnValue("blob:cached")

		const { result } = renderHook(() => useThumbnail(narrowItem({ ...imageFile(), canMakeThumbnail: false })))

		expect(result.current).toBeNull()
		expect(peekThumbnailUrlMock).not.toHaveBeenCalled()
		expect(getThumbnailUrlMock).not.toHaveBeenCalled()
	})
})
