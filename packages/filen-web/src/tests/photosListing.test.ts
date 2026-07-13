import { describe, expect, it, vi } from "vitest"
import type { DriveItem } from "@/features/drive/lib/item"

// fetchDirectoryListing's own behavior (uuid resolution, error propagation) is already covered by
// drive.test.ts — this file only proves photos' placeholder queryFn delegates to it unchanged with
// the "drive" variant (the piece that makes a gone root surface the exact
// DIRECTORY_NOT_FOUND_PREFIX message photosRoot.test.ts's isRootGoneError keys off), and that the
// query key is stable ahead of Wave 2 swapping this function's body for the real recursive op.
const { fetchDirectoryListing } = vi.hoisted(() => ({ fetchDirectoryListing: vi.fn<(variant: string, uuid: string | null) => unknown>() }))

vi.mock("@/features/drive/queries/drive", () => ({ fetchDirectoryListing }))

import { fetchPhotosListing, photosListingQueryKey } from "@/features/photos/queries/photos"

describe("photosListingQueryKey", () => {
	it("scopes the key under the photos domain, keyed by rootUuid", () => {
		expect(photosListingQueryKey("root-uuid")).toEqual(["photos", "listing", "root-uuid"])
	})
})

describe("fetchPhotosListing", () => {
	it('delegates to fetchDirectoryListing against the "drive" variant with the given root uuid', async () => {
		const items: DriveItem[] = []
		fetchDirectoryListing.mockResolvedValueOnce(items)

		const result = await fetchPhotosListing("root-uuid")

		expect(fetchDirectoryListing).toHaveBeenCalledWith("drive", "root-uuid")
		expect(result).toBe(items)
	})

	it("propagates a rejection unchanged (a gone root's DIRECTORY_NOT_FOUND_PREFIX error reaches the caller intact)", async () => {
		const error = new Error("directory not found: root-uuid")
		fetchDirectoryListing.mockRejectedValueOnce(error)

		await expect(fetchPhotosListing("root-uuid")).rejects.toBe(error)
	})
})
