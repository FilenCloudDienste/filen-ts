import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { File as SdkFile, SharedFile, SharingRole, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import type { SdkThumbnailResult } from "@/workers/sdk.worker"

// End to end over the REAL decision code — thumbnailCategory, the thumbnail service, the registered
// sdk generator and download.ts's narrowToAnyFile — with only the worker boundary and browser-only
// modules replaced, so a shared file is followed from the listing row to the SDK thumbnail call.
const { makeSdkThumbnailMock, storeThumbnailMock } = vi.hoisted(() => ({
	makeSdkThumbnailMock:
		vi.fn<(file: unknown, maxWidth: number, maxHeight: number, lossyQuality: number) => Promise<SdkThumbnailResult>>(),
	storeThumbnailMock: vi.fn<(uuid: string, bytes: Uint8Array) => Promise<void>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		makeSdkThumbnail: makeSdkThumbnailMock,
		storeThumbnail: storeThumbnailMock,
		downloadFileBytes: vi.fn(),
		makeSdkThumbnailFromFile: vi.fn()
	}
}))

vi.mock("@/features/drive/lib/thumbCache", () => ({
	readThumbnailBlob: vi.fn(() => Promise.resolve(null)),
	deleteThumbnail: vi.fn(() => Promise.resolve())
}))

// download.ts's own browser/UI imports, replaced exactly as download.test.ts does.
vi.mock("@/features/drive/lib/saveDownload", () => ({ saveDownload: vi.fn(), isPickerCancelled: vi.fn(), triggerSwDownload: vi.fn() }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/features/drive/lib/downloadZip", () => ({ startZipDownload: vi.fn() }))
vi.mock("@/features/preview/lib/previewStream", () => ({ waitForMediaStream: vi.fn(), previewStreamUrl: vi.fn() }))
vi.mock("@/features/preview/lib/mediaType", () => ({ allowedMediaContentType: vi.fn() }))

import { getThumbnailUrl, defaultThumbnailDeps, type ThumbnailServiceDeps } from "@/features/drive/lib/thumbnails"
import { THUMB_MAX_DIM, THUMB_SDK_LOSSY_QUALITY, THUMB_SDK_MAX_HEIGHT } from "@/features/drive/lib/thumbnails.logic"
// Side effect: registers the real generators, as useThumbnail does.
import "@/features/drive/lib/thumbGenerators"

const ROLE: SharingRole = { Sharer: { email: "sharer@filen.io", id: 42 } }

let uuidCounter = 0

function nextUuid(): UuidStr {
	uuidCounter += 1

	return `s${uuidCounter.toString()}-0000-0000-0000-000000000000` as UuidStr
}

const IMAGE_META = {
	type: "decoded",
	data: { name: "photo.jpg", mime: "image/jpeg", modified: 1_700_000_000_000n, size: 2_048n, key: "file-key", version: 2 }
} as const

// A file shared straight into the account — the Shared with me root.
function sharedRootFileItem(): DriveItem {
	const raw: SharedFile = {
		uuid: nextUuid(),
		size: 2_048n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 1n,
		timestamp: 1_700_000_000_000n,
		meta: IMAGE_META,
		sharingRole: ROLE,
		sharedTag: true,
		canMakeThumbnail: true
	}

	return narrowItem(raw)
}

// A file inside a shared directory: listSharedDir returns a plain File and the fetcher spreads the
// parent's role onto it (queries/drive.ts's fetchSharedListing).
function nestedSharedFileItem(): DriveItem {
	const raw: SdkFile = {
		uuid: nextUuid(),
		stableUUID: undefined,
		parent: nextUuid(),
		size: 2_048n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: IMAGE_META
	}

	return narrowItem({ ...raw, sharingRole: ROLE })
}

function testDeps(): ThumbnailServiceDeps {
	return {
		readThumbnailBlob: vi.fn(() => Promise.resolve(null)),
		deleteThumbnail: vi.fn(() => Promise.resolve()),
		storeThumbnail: vi.fn(() => Promise.resolve()),
		createObjectUrl: vi.fn(() => "blob:shared-thumb"),
		revokeObjectUrl: vi.fn(),
		// The real registry, filled by thumbGenerators' import above.
		getGenerator: defaultThumbnailDeps.getGenerator
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	makeSdkThumbnailMock.mockResolvedValue({
		type: "thumbnail",
		bytes: new Uint8Array([1, 2, 3]),
		width: 384,
		height: 256,
		fromEmbeddedPreview: false
	})
})

describe("Shared with me thumbnails, end to end", () => {
	it.each([
		["sharedRootFile", sharedRootFileItem],
		["sharedFile", nestedSharedFileItem]
	] as const)("a %s image reaches the SDK thumbnail call and renders", async (type, build) => {
		const item = build()
		const deps = testDeps()

		expect(item.type).toBe(type)
		await expect(getThumbnailUrl(item, deps)).resolves.toBe("blob:shared-thumb")

		expect(makeSdkThumbnailMock).toHaveBeenCalledTimes(1)
		const [file, maxWidth, maxHeight, lossyQuality] = makeSdkThumbnailMock.mock.calls[0] ?? []
		expect([maxWidth, maxHeight, lossyQuality]).toEqual([THUMB_MAX_DIM, THUMB_SDK_MAX_HEIGHT, THUMB_SDK_LOSSY_QUALITY])

		// AnyFile is the untagged union LinkedFile | SharedFile | File. The value carries every field
		// SharedFile requires (so it matches that arm, the shared read path) and none of LinkedFile's.
		expect(file).toMatchObject({
			uuid: item.data.uuid,
			size: 2_048n,
			region: "de-1",
			bucket: "filen-1",
			chunks: 1n,
			timestamp: 1_700_000_000_000n,
			meta: IMAGE_META,
			sharingRole: ROLE,
			sharedTag: true,
			canMakeThumbnail: true
		})
		expect(file).not.toHaveProperty("linkedTag")
		expect(file).not.toHaveProperty("fileKey")

		// Persisted under the file's own uuid, the same cache key an owned file uses.
		expect(deps.storeThumbnail).toHaveBeenCalledWith(item.data.uuid, expect.any(Uint8Array))
	})

	it("a shared file the SDK cannot thumbnail never reaches the SDK", async () => {
		const item = sharedRootFileItem()

		if (item.type !== "sharedRootFile") {
			throw new Error("expected a sharedRootFile")
		}

		await expect(getThumbnailUrl({ ...item, data: { ...item.data, canMakeThumbnail: false } }, testDeps())).resolves.toBeNull()
		expect(makeSdkThumbnailMock).not.toHaveBeenCalled()
	})
})
