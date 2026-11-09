import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { File, SocketEvent } from "@filen/sdk-rs"

// An edited photo saved from the preview: its new version (or its copy) is spliced into the Photos listings where the
// photo it came from is listed, and the save's own socket echo then walks nothing.

const { ownSaves } = vi.hoisted(() => ({ ownSaves: new Set<string>() }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("@/features/preview/lib/ownSaves", () => ({
	isOwnSave: (uuid: string) => ownSaves.has(uuid),
	recordOwnSave: (uuid: string) => ownSaves.add(uuid)
}))

import { queryClient as testQueryClient } from "@/queries/client"
import { photosListingQueryKey, splicePhotoSave, type PhotosListing } from "@/features/photos/queries/photos"
import { handleDriveEvent } from "@/features/drive/lib/socketHandlers"
import { narrowItem } from "@/features/drive/lib/item"
import type { PhotoItem } from "@/features/photos/lib/captureSort"
import { testUuid } from "@/tests/support/uuid"

const ROOT = "root-uuid"

function photoFile(label: string, name = "IMG.jpg"): File {
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
		meta: { type: "decoded", data: { name, mime: "image/jpeg", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 } }
	}
}

function photo(label: string): PhotoItem {
	const item = narrowItem(photoFile(label))

	if (item.type !== "file") {
		throw new Error("not a file")
	}

	return item
}

function listed(): string[] {
	return testQueryClient.getQueryData<PhotosListing>(photosListingQueryKey(ROOT))?.photos.map(row => row.data.uuid) ?? []
}

function invalidated(): boolean {
	return testQueryClient.getQueryCache().find({ queryKey: photosListingQueryKey(ROOT) })?.state.isInvalidated ?? false
}

function fileNew(label: string): Extract<SocketEvent, { type: "drive" }> {
	return { type: "drive", inner: { type: "fileNew", file: photoFile(label) }, driveMessageId: 0n }
}

beforeEach(() => {
	testQueryClient.clear()
	ownSaves.clear()
	testQueryClient.setQueryData(photosListingQueryKey(ROOT), { photos: [photo("before"), photo("old"), photo("after")], folders: {} })
})

describe("splicePhotoSave", () => {
	it("puts a new version in the old row's place", () => {
		splicePhotoSave(testUuid("old"), photo("new"), "replace")

		expect(listed()).toEqual([testUuid("before"), testUuid("new"), testUuid("after")])
	})

	it("puts an edited copy right beside the photo it came from", () => {
		splicePhotoSave(testUuid("old"), photo("copy"), "beside")

		expect(listed()).toEqual([testUuid("before"), testUuid("old"), testUuid("copy"), testUuid("after")])
	})

	it("leaves a listing without the original alone", () => {
		splicePhotoSave(testUuid("elsewhere"), photo("new"), "replace")

		expect(listed()).toEqual([testUuid("before"), testUuid("old"), testUuid("after")])
	})
})

describe("an own save's echo", () => {
	it("walks nothing once the saved version is listed", () => {
		splicePhotoSave(testUuid("old"), photo("new"), "replace")
		ownSaves.add(testUuid("new"))

		handleDriveEvent(fileNew("new"))

		expect(invalidated()).toBe(false)
		expect(listed()).toEqual([testUuid("before"), testUuid("new"), testUuid("after")])
	})

	it("still walks for a new photo that is not this tab's own save", () => {
		splicePhotoSave(testUuid("old"), photo("new"), "replace")

		handleDriveEvent(fileNew("new"))

		expect(invalidated()).toBe(true)
	})
})
