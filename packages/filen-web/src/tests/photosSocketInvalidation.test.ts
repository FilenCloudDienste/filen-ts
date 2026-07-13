import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File, SocketEvent, UuidStr } from "@filen/sdk-rs"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { logWarn, logError } = vi.hoisted(() => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock("@/lib/log", () => ({ log: { warn: logWarn, error: logError, info: vi.fn(), debug: vi.fn() } }))

import { queryClient as testQueryClient } from "@/queries/client"
import { photosListingQueryKey } from "@/features/photos/queries/photos"
import { handleDriveEvent } from "@/features/drive/lib/socketHandlers"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const ROOT_UUID = "root-uuid"

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("file"),
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

function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: testUuid("dir"),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

function driveEvt(inner: Extract<SocketEvent, { type: "drive" }>["inner"]): Extract<SocketEvent, { type: "drive" }> {
	return { type: "drive", inner, driveMessageId: 0n }
}

function seedPhotosQuery(): void {
	testQueryClient.setQueryData(photosListingQueryKey(ROOT_UUID), [])
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
		["fileNew", () => driveEvt({ type: "fileNew", file: mockFile() })],
		["fileMove", () => driveEvt({ type: "fileMove", file: mockFile() })],
		["folderMove", () => driveEvt({ type: "folderMove", dir: mockDir() })],
		["fileTrash", () => driveEvt({ type: "fileTrash", uuid: testUuid("file") })],
		["folderTrash", () => driveEvt({ type: "folderTrash", parent: testUuid("parent"), uuid: testUuid("dir") })],
		["fileRestore", () => driveEvt({ type: "fileRestore", file: mockFile() })],
		["folderRestore", () => driveEvt({ type: "folderRestore", dir: mockDir() })],
		["fileArchived", () => driveEvt({ type: "fileArchived", uuid: testUuid("file") })],
		["fileArchiveRestored", () => driveEvt({ type: "fileArchiveRestored", currentUuid: testUuid("old"), file: mockFile() })],
		["fileDeletedPermanent", () => driveEvt({ type: "fileDeletedPermanent", uuid: testUuid("file") })],
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

	it("does NOT invalidate on trashEmpty", () => {
		handleDriveEvent(driveEvt({ type: "trashEmpty" }))

		expect(isPhotosQueryInvalidated()).toBe(false)
	})

	it("is a no-op when no photos query is mounted (never conjures a phantom cache entry)", () => {
		testQueryClient.clear()

		handleDriveEvent(driveEvt({ type: "fileNew", file: mockFile() }))

		expect(testQueryClient.getQueryCache().find({ queryKey: photosListingQueryKey(ROOT_UUID) })).toBeUndefined()
	})
})
