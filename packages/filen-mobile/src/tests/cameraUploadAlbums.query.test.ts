import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockGetAlbumsAsync, mockGetAssetsAsync, mockHasPermissions } = vi.hoisted(() => ({
	mockGetAlbumsAsync: vi.fn(),
	mockGetAssetsAsync: vi.fn(),
	mockHasPermissions: vi.fn()
}))

vi.mock("expo-media-library/legacy", () => ({
	getAlbumsAsync: mockGetAlbumsAsync,
	getAssetsAsync: mockGetAssetsAsync,
	MediaType: {
		photo: "photo",
		video: "video",
		audio: "audio",
		unknown: "unknown"
	}
}))

vi.mock("@/hooks/useMediaPermissions", () => ({
	hasAllNeededMediaPermissions: mockHasPermissions
}))

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {}
}))

import { fetchData } from "@/features/cameraUpload/queries/useCameraUploadAlbums.query"

function album(id: string, assetCount: number) {
	return { id, title: id, assetCount }
}

describe("camera upload albums query", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockHasPermissions.mockResolvedValue(true)
	})

	it("returns an empty list without media permissions", async () => {
		mockHasPermissions.mockResolvedValue(false)

		expect(await fetchData()).toEqual([])
		expect(mockGetAlbumsAsync).not.toHaveBeenCalled()
	})

	it("drops albums whose filtered photo/video count is zero (audio-only buckets)", async () => {
		mockGetAlbumsAsync.mockResolvedValue([album("Camera", 10), album("Music", 42)])
		mockGetAssetsAsync.mockImplementation(async ({ album: a }: { album: { id: string } }) => ({
			totalCount: a.id === "Music" ? 0 : 10
		}))

		const result = await fetchData()

		expect(result.map(a => a.id)).toEqual(["Camera"])
	})

	it("replaces the bucket total with the filtered photo/video count for mixed albums", async () => {
		// A folder with 30 photos + 70 audio files reports assetCount 100 from the OS.
		mockGetAlbumsAsync.mockResolvedValue([album("Mixed", 100)])
		mockGetAssetsAsync.mockResolvedValue({ totalCount: 30 })

		const result = await fetchData()

		expect(result).toHaveLength(1)
		expect(result[0]?.assetCount).toBe(30)
	})

	it("queries the probe with the photo and video media types", async () => {
		mockGetAlbumsAsync.mockResolvedValue([album("Camera", 5)])
		mockGetAssetsAsync.mockResolvedValue({ totalCount: 5 })

		await fetchData()

		expect(mockGetAssetsAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				mediaType: ["photo", "video"],
				first: 1
			})
		)
	})

	it("drops zero-count albums without probing them", async () => {
		mockGetAlbumsAsync.mockResolvedValue([album("Empty", 0)])

		const result = await fetchData()

		expect(result).toEqual([])
		expect(mockGetAssetsAsync).not.toHaveBeenCalled()
	})

	it("keeps an album with its original count when the probe fails (fail open)", async () => {
		mockGetAlbumsAsync.mockResolvedValue([album("Flaky", 7)])
		mockGetAssetsAsync.mockRejectedValue(new Error("mediastore error"))

		const result = await fetchData()

		expect(result).toHaveLength(1)
		expect(result[0]?.assetCount).toBe(7)
	})

	it("filters a large album list without deadlocking the concurrency gate", async () => {
		const albums = Array.from({ length: 25 }, (_, i) => album(`a${i}`, i + 1))

		mockGetAlbumsAsync.mockResolvedValue(albums)
		mockGetAssetsAsync.mockImplementation(async ({ album: a }: { album: { id: string } }) => ({
			totalCount: Number(a.id.slice(1)) % 2 === 0 ? 1 : 0
		}))

		const result = await fetchData()

		expect(result.map(a => a.id)).toEqual(albums.filter(a => Number(a.id.slice(1)) % 2 === 0).map(a => a.id))
	})
})
