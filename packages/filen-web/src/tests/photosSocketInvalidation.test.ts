import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { File, SocketEvent } from "@filen/sdk-rs"

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { logWarn, logError } = vi.hoisted(() => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock("@/lib/log", () => ({ log: { warn: logWarn, error: logError, info: vi.fn(), debug: vi.fn() } }))

import { queryClient as testQueryClient } from "@/queries/client"
import { photosListingQueryKey } from "@/features/photos/queries/photos"
import { handleDriveEvent } from "@/features/drive/lib/socketHandlers"
import { testUuid } from "@/tests/support/uuid"
import { mockDir } from "@/tests/fixtures/sdk"

const ROOT_UUID = "root-uuid"
// The fixture file's whole-life id, and the uuid a content edit rotates the lineage onto (what `newUUID`
// announces on fileArchived; a user trash leaves it undefined).
const STABLE_FILE = testUuid("stable-file")
const NEW_FILE = testUuid("new-file")

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("file"),
		stableUUID: STABLE_FILE,
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
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		},
		...overrides
	}
}

function mockPhoto(overrides: Partial<File> = {}): File {
	return mockFile({
		meta: {
			type: "decoded",
			data: { name: "IMG_0001.jpg", mime: "image/jpeg", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		},
		...overrides
	})
}

function driveEvt(inner: Extract<SocketEvent, { type: "drive" }>["inner"]): Extract<SocketEvent, { type: "drive" }> {
	return { type: "drive", inner, driveMessageId: 0n }
}

function seedPhotosQuery(): void {
	testQueryClient.setQueryData(photosListingQueryKey(ROOT_UUID), { photos: [], folders: {} })
}

function isPhotosQueryInvalidated(): boolean {
	return testQueryClient.getQueryCache().find({ queryKey: photosListingQueryKey(ROOT_UUID) })?.state.isInvalidated ?? false
}

beforeEach(() => {
	testQueryClient.clear()
	vi.clearAllMocks()
	seedPhotosQuery()
})

describe("handleDriveEvent — coarse photos invalidation", () => {
	it.each([
		["fileNew", () => driveEvt({ type: "fileNew", file: mockPhoto() })],
		["fileMove", () => driveEvt({ type: "fileMove", file: mockPhoto() })],
		["folderMove", () => driveEvt({ type: "folderMove", dir: mockDir() })],
		["fileTrash", () => driveEvt({ type: "fileTrash", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: undefined })],
		["folderTrash", () => driveEvt({ type: "folderTrash", parent: testUuid("parent"), uuid: testUuid("dir") })],
		["fileRestore", () => driveEvt({ type: "fileRestore", file: mockPhoto() })],
		["folderRestore", () => driveEvt({ type: "folderRestore", dir: mockDir() })],
		["fileArchived", () => driveEvt({ type: "fileArchived", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: NEW_FILE })],
		["fileArchiveRestored", () => driveEvt({ type: "fileArchiveRestored", currentUuid: testUuid("old"), file: mockFile() })],
		["fileDeletedPermanent", () => driveEvt({ type: "fileDeletedPermanent", uuid: testUuid("file"), stableUUID: STABLE_FILE })],
		["folderDeletedPermanent", () => driveEvt({ type: "folderDeletedPermanent", uuid: testUuid("dir") })],
		[
			"fileMetadataChanged",
			() =>
				driveEvt({
					type: "fileMetadataChanged",
					uuid: testUuid("file"),
					metadata: {
						type: "decoded",
						data: { name: "renamed.jpg", mime: "image/jpeg", modified: 1n, size: 1n, key: "k", version: 2 }
					}
				})
		],
		[
			"folderMetadataChanged",
			() => driveEvt({ type: "folderMetadataChanged", uuid: testUuid("dir"), meta: { type: "decoded", data: { name: "Renamed" } } })
		]
	])("invalidates the photos query on a %s event", (_label, buildEvent) => {
		expect(isPhotosQueryInvalidated()).toBe(false)

		handleDriveEvent(buildEvent())

		expect(isPhotosQueryInvalidated()).toBe(true)
	})

	it("does NOT invalidate on itemFavorite (an attribute-only patch the photos cache doesn't need a full refetch for)", () => {
		handleDriveEvent(driveEvt({ type: "itemFavorite", item: { type: "file", ...mockFile({ favorited: true }) } }))

		expect(isPhotosQueryInvalidated()).toBe(false)
	})

	it("does NOT invalidate on folderColorChanged (never affects photos membership)", () => {
		handleDriveEvent(driveEvt({ type: "folderColorChanged", uuid: testUuid("dir"), color: "blue" }))

		expect(isPhotosQueryInvalidated()).toBe(false)
	})

	it.each([
		["fileNew", () => driveEvt({ type: "fileNew", file: mockFile() })],
		["fileMove", () => driveEvt({ type: "fileMove", file: mockFile() })],
		["fileRestore", () => driveEvt({ type: "fileRestore", file: mockFile() })]
	])("does NOT invalidate on a %s of a non-photo file (a playlist save into .filen, say)", (_label, buildEvent) => {
		handleDriveEvent(buildEvent())

		expect(isPhotosQueryInvalidated()).toBe(false)
	})

	it("does NOT invalidate on a fileNew of an undecryptable file", () => {
		handleDriveEvent(driveEvt({ type: "fileNew", file: mockFile({ meta: { type: "encrypted", data: "x" } }) }))

		expect(isPhotosQueryInvalidated()).toBe(false)
	})

	it("does NOT invalidate on trashEmpty", () => {
		handleDriveEvent(driveEvt({ type: "trashEmpty" }))

		expect(isPhotosQueryInvalidated()).toBe(false)
	})

	it("is a no-op when no photos query is mounted (never conjures a phantom cache entry)", () => {
		testQueryClient.clear()

		handleDriveEvent(driveEvt({ type: "fileNew", file: mockPhoto() }))

		expect(testQueryClient.getQueryCache().find({ queryKey: photosListingQueryKey(ROOT_UUID) })).toBeUndefined()
	})
})
