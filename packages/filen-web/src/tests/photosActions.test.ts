import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"

// Mirrors driveActions.test.ts's own mock boundary — only the ops these wrappers (via drive's own
// action helpers) actually call.
const { setFavorited, trashFile, renameFile } = vi.hoisted(() => ({
	setFavorited: vi.fn(),
	trashFile: vi.fn(),
	renameFile: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { setFavorited, trashFile, renameFile } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { narrowItem } from "@/features/drive/lib/item"
import { toggleFavorite, trashItems } from "@/features/drive/lib/actions"
import { photosListingQueryKey } from "@/features/photos/queries/photos"
import { toggleFavoritePhoto, setFavoritedPhotos, trashPhotos, renamePhotoItem } from "@/features/photos/lib/actions"
import { type PhotoItem } from "@/features/photos/lib/captureSort"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const ROOT_UUID = "root-uuid"

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("photo"),
		parent: testUuid("root"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "beach.jpg", mime: "image/jpeg", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		},
		...overrides
	}
}

function photoItem(overrides: Partial<File> = {}): PhotoItem {
	const item = narrowItem(mockFile(overrides))

	if (item.type !== "file") {
		throw new Error("test fixture narrowed to a non-file arm")
	}

	return item
}

function seedPhotosListing(items: PhotoItem[]): void {
	testQueryClient.setQueryData(photosListingQueryKey(ROOT_UUID), items)
}

function getPhotosListing(): PhotoItem[] | undefined {
	return testQueryClient.getQueryData<PhotoItem[]>(photosListingQueryKey(ROOT_UUID))
}

beforeEach(() => {
	testQueryClient.clear()
	vi.clearAllMocks()
})

// The gap these wrappers exist to close: drive's own action helpers only ever patch ["drive",…] keys
// (driveListingQueryUpdate/driveListingQueryUpdateGlobal, see drive/queries/drive.ts). Calling them
// DIRECTLY against a seeded photos cache proves the drive-only updater provably misses the
// ["photos","listing",rootUuid] key it was never told about.
describe("drive's own action helpers do not reach the photos cache (the gap photos/lib/actions.ts closes)", () => {
	it("toggleFavorite leaves a seeded photos listing untouched", async () => {
		const item = photoItem()
		seedPhotosListing([item])
		setFavorited.mockResolvedValueOnce({ ...item.data, favorited: true })

		await toggleFavorite(item)

		expect(getPhotosListing()?.[0]?.data.favorited).toBe(false)
	})

	it("trashItems leaves a seeded photos listing untouched", async () => {
		const item = photoItem()
		seedPhotosListing([item])
		trashFile.mockResolvedValueOnce(undefined)

		await trashItems([item])

		expect(getPhotosListing()).toHaveLength(1)
	})
})

describe("toggleFavoritePhoto", () => {
	it("patches the photos listing's favorited flag in place on success", async () => {
		const item = photoItem()
		seedPhotosListing([item])
		setFavorited.mockResolvedValueOnce({ ...item.data, favorited: true })

		const outcome = await toggleFavoritePhoto(ROOT_UUID, item)

		expect(outcome.status).toBe("success")
		expect(getPhotosListing()?.[0]?.data.favorited).toBe(true)
	})

	it("leaves the photos listing untouched on a rejected mutation", async () => {
		const item = photoItem()
		seedPhotosListing([item])
		setFavorited.mockRejectedValueOnce(new Error("network error"))

		const outcome = await toggleFavoritePhoto(ROOT_UUID, item)

		expect(outcome.status).toBe("error")
		expect(getPhotosListing()?.[0]?.data.favorited).toBe(false)
	})
})

describe("setFavoritedPhotos", () => {
	it("sets every succeeded item's favorited flag to the target value", async () => {
		const a = photoItem({ uuid: testUuid("a") })
		const b = photoItem({ uuid: testUuid("b") })
		seedPhotosListing([a, b])
		setFavorited.mockResolvedValue({ ...a.data, favorited: true })

		await setFavoritedPhotos(ROOT_UUID, [a, b], true)

		const listing = getPhotosListing() ?? []
		expect(listing.every(item => item.data.favorited)).toBe(true)
	})

	it("leaves a failed item's flag untouched", async () => {
		const a = photoItem({ uuid: testUuid("a") })
		seedPhotosListing([a])
		setFavorited.mockRejectedValueOnce(new Error("rejected"))

		await setFavoritedPhotos(ROOT_UUID, [a], true)

		expect(getPhotosListing()?.[0]?.data.favorited).toBe(false)
	})
})

describe("trashPhotos", () => {
	it("removes every succeeded item from the photos listing", async () => {
		const a = photoItem({ uuid: testUuid("a") })
		const b = photoItem({ uuid: testUuid("b") })
		seedPhotosListing([a, b])
		trashFile.mockResolvedValue(undefined)

		await trashPhotos(ROOT_UUID, [a])

		const listing = getPhotosListing() ?? []
		expect(listing.map(item => item.data.uuid)).toEqual([b.data.uuid])
	})

	it("leaves a failed item in the photos listing", async () => {
		const a = photoItem({ uuid: testUuid("a") })
		seedPhotosListing([a])
		trashFile.mockRejectedValueOnce(new Error("rejected"))

		await trashPhotos(ROOT_UUID, [a])

		expect(getPhotosListing()).toHaveLength(1)
	})
})

describe("renamePhotoItem", () => {
	it("patches the renamed item's name in place", async () => {
		const item = photoItem()
		seedPhotosListing([item])
		renameFile.mockResolvedValueOnce(
			mockFile({
				meta: {
					type: "decoded",
					data: { name: "renamed.jpg", mime: "image/jpeg", modified: 1n, size: 1_024n, key: "k", version: 2 }
				}
			})
		)

		const outcome = await renamePhotoItem(ROOT_UUID, item, "renamed.jpg")

		expect(outcome.status).toBe("success")
		expect(getPhotosListing()).toHaveLength(1)
		expect(getPhotosListing()?.[0]?.data.decryptedMeta?.name).toBe("renamed.jpg")
	})
})
