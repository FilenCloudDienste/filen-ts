import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File, FileMeta, SocketEvent, UserInfo, UuidStr } from "@filen/sdk-rs"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest — the drive handler
// pulls it in transitively through queries/drive + lib/actions, so it's mocked down to nothing (the
// handler only ever runs cache patchers, never a worker op). Mirrors driveActions.test's mock boundary.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { logWarn, logError } = vi.hoisted(() => ({ logWarn: vi.fn(), logError: vi.fn() }))

vi.mock("@/lib/log", () => ({ log: { warn: logWarn, error: logError, info: vi.fn(), debug: vi.fn() } }))

import { queryClient as testQueryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { driveListingQueryKey } from "@/features/drive/queries/drive"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { handleDriveEvent } from "@/features/drive/lib/socketHandlers"
import { subscribePreviewReconcile, type PreviewReconcileEvent } from "@/features/preview/lib/previewReconcile"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const ROOT_UUID = testUuid("root")
const PARENT_A = testUuid("parent-a")
const PARENT_B = testUuid("parent-b")

function seedRootUuid(uuid: UuidStr = ROOT_UUID): void {
	testQueryClient.setQueryData<UserInfo>(ACCOUNT_QUERY_KEY, { rootDirUuid: uuid } as UserInfo)
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("file"),
		parent: PARENT_A,
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
		parent: PARENT_A,
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

function seedListing(uuid: string | null, items: DriveItem[]): void {
	testQueryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid }), items)
}

function getListing(uuid: string | null): DriveItem[] {
	return testQueryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "drive", uuid })) ?? []
}

function seedTrash(items: DriveItem[]): void {
	testQueryClient.setQueryData(driveListingQueryKey({ variant: "trash", uuid: null }), items)
}

function getTrash(): DriveItem[] | undefined {
	return testQueryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "trash", uuid: null }))
}

beforeEach(() => {
	testQueryClient.clear()
	useDriveStore.setState({ selectedItems: [] })
	vi.clearAllMocks()
})

describe("drive socket handlers — additions", () => {
	it("fileNew splices the file into its parent listing", () => {
		seedListing(PARENT_A, [])
		handleDriveEvent(driveEvt({ type: "fileNew", file: mockFile() }))

		expect(getListing(PARENT_A).map(i => i.data.uuid)).toEqual([testUuid("file")])
	})

	it("fileNew into the root collapses the real root uuid onto the null-keyed listing", () => {
		seedRootUuid()
		seedListing(null, [])
		handleDriveEvent(driveEvt({ type: "fileNew", file: mockFile({ parent: ROOT_UUID }) }))

		expect(getListing(null).map(i => i.data.uuid)).toEqual([testUuid("file")])
	})

	it("folderSubCreated splices the directory into its parent listing", () => {
		seedListing(PARENT_A, [])
		handleDriveEvent(driveEvt({ type: "folderSubCreated", dir: mockDir() }))

		expect(getListing(PARENT_A).map(i => i.data.uuid)).toEqual([testUuid("dir")])
	})

	it("fileRestore removes the item everywhere then re-adds it to its parent (trash included)", () => {
		seedTrash([narrowItem(mockFile())])
		seedListing(PARENT_A, [])
		handleDriveEvent(driveEvt({ type: "fileRestore", file: mockFile() }))

		expect(getTrash()).toEqual([])
		expect(getListing(PARENT_A).map(i => i.data.uuid)).toEqual([testUuid("file")])
	})

	it("fileArchiveRestored drops both the restored uuid and the superseded current uuid before splicing", () => {
		const superseded = narrowItem(mockFile({ uuid: testUuid("old-current") }))
		seedListing(PARENT_A, [superseded])
		handleDriveEvent(driveEvt({ type: "fileArchiveRestored", currentUuid: testUuid("old-current"), file: mockFile() }))

		expect(getListing(PARENT_A).map(i => i.data.uuid)).toEqual([testUuid("file")])
	})
})

describe("drive socket handlers — moves", () => {
	it("fileMove removes from wherever it was and adds to the new parent", () => {
		seedListing(PARENT_A, [narrowItem(mockFile())])
		seedListing(PARENT_B, [])
		handleDriveEvent(driveEvt({ type: "fileMove", file: mockFile({ parent: PARENT_B }) }))

		expect(getListing(PARENT_A)).toEqual([])
		expect(getListing(PARENT_B).map(i => i.data.uuid)).toEqual([testUuid("file")])
	})

	it("folderMove removes from wherever it was and adds to the new parent", () => {
		seedListing(PARENT_A, [narrowItem(mockDir())])
		seedListing(PARENT_B, [])
		handleDriveEvent(driveEvt({ type: "folderMove", dir: mockDir({ parent: PARENT_B }) }))

		expect(getListing(PARENT_A)).toEqual([])
		expect(getListing(PARENT_B).map(i => i.data.uuid)).toEqual([testUuid("dir")])
	})
})

describe("drive socket handlers — removals + selection purge", () => {
	it("fileTrash removes the row from every listing and purges the selection", () => {
		const item = narrowItem(mockFile())
		seedListing(PARENT_A, [item])
		useDriveStore.setState({ selectedItems: [item] })

		handleDriveEvent(driveEvt({ type: "fileTrash", uuid: testUuid("file") }))

		expect(getListing(PARENT_A)).toEqual([])
		expect(useDriveStore.getState().selectedItems).toEqual([])
	})

	it("fileDeletedPermanent removes the row from every listing and purges the selection", () => {
		const item = narrowItem(mockFile())
		seedListing(PARENT_A, [item])
		useDriveStore.setState({ selectedItems: [item] })

		handleDriveEvent(driveEvt({ type: "fileDeletedPermanent", uuid: testUuid("file") }))

		expect(getListing(PARENT_A)).toEqual([])
		expect(useDriveStore.getState().selectedItems).toEqual([])
	})

	it("folderTrash removes the directory from every listing", () => {
		seedListing(PARENT_A, [narrowItem(mockDir())])
		handleDriveEvent(driveEvt({ type: "folderTrash", parent: PARENT_A, uuid: testUuid("dir") }))

		expect(getListing(PARENT_A)).toEqual([])
	})
})

describe("drive socket handlers — attribute patches", () => {
	it("folderColorChanged swaps the color in place on the matching directory row", () => {
		seedListing(PARENT_A, [narrowItem(mockDir())])
		handleDriveEvent(driveEvt({ type: "folderColorChanged", uuid: testUuid("dir"), color: "blue" }))

		const row = getListing(PARENT_A)[0]

		expect(row?.type === "directory" ? row.data.color : undefined).toBe("blue")
	})

	it("fileMetadataChanged re-narrows the owned file row from the fresh meta", () => {
		seedListing(PARENT_A, [narrowItem(mockFile())])
		const metadata: FileMeta = {
			type: "decoded",
			data: { name: "renamed.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		}

		handleDriveEvent(driveEvt({ type: "fileMetadataChanged", uuid: testUuid("file"), metadata }))

		expect(getListing(PARENT_A)[0]?.data.decryptedMeta?.name).toBe("renamed.pdf")
	})

	it("folderMetadataChanged re-narrows the owned directory row from the fresh meta", () => {
		seedListing(PARENT_A, [narrowItem(mockDir())])
		handleDriveEvent(
			driveEvt({ type: "folderMetadataChanged", uuid: testUuid("dir"), meta: { type: "decoded", data: { name: "Renamed" } } })
		)

		expect(getListing(PARENT_A)[0]?.data.decryptedMeta?.name).toBe("Renamed")
	})

	it("itemFavorite replaces the row in place with the freshly-flagged file", () => {
		seedListing(PARENT_A, [narrowItem(mockFile())])
		handleDriveEvent(driveEvt({ type: "itemFavorite", item: { type: "file", ...mockFile({ favorited: true }) } }))

		expect(getListing(PARENT_A)[0]?.data.favorited).toBe(true)
	})
})

describe("drive socket handlers — trash-empty + unhandled", () => {
	it("trashEmpty clears a cached trash listing", () => {
		seedTrash([narrowItem(mockFile())])
		handleDriveEvent(driveEvt({ type: "trashEmpty" }))

		expect(getTrash()).toEqual([])
	})

	it("trashEmpty conjures no phantom slice when trash was never opened", () => {
		handleDriveEvent(driveEvt({ type: "trashEmpty" }))

		expect(getTrash()).toBeUndefined()
	})

	it("deleteAll is logged and skipped (no cache mutation)", () => {
		seedListing(PARENT_A, [narrowItem(mockFile())])
		handleDriveEvent(driveEvt({ type: "deleteAll" }))

		expect(getListing(PARENT_A).length).toBe(1)
		expect(logWarn).toHaveBeenCalled()
	})
})

describe("drive socket handlers — open-preview reconcile signals", () => {
	// Dispatches one drive event with a preview-reconcile subscriber attached and returns whatever signals
	// it emitted (empty when the event has no open-preview relevance).
	function captureReconcile(inner: Extract<SocketEvent, { type: "drive" }>["inner"]): PreviewReconcileEvent[] {
		const events: PreviewReconcileEvent[] = []
		const unsubscribe = subscribePreviewReconcile(event => events.push(event))

		try {
			handleDriveEvent(driveEvt(inner))
		} finally {
			unsubscribe()
		}

		return events
	}

	it("fileTrash emits a removed signal for the trashed uuid", () => {
		expect(captureReconcile({ type: "fileTrash", uuid: testUuid("file") })).toEqual([{ type: "removed", uuid: testUuid("file") }])
	})

	it("fileMove emits a removed signal so a preview open on it advances or closes", () => {
		expect(captureReconcile({ type: "fileMove", file: mockFile({ parent: PARENT_B }) })).toEqual([
			{ type: "removed", uuid: testUuid("file") }
		])
	})

	it("fileDeletedPermanent emits a removed signal", () => {
		expect(captureReconcile({ type: "fileDeletedPermanent", uuid: testUuid("file") })).toEqual([
			{ type: "removed", uuid: testUuid("file") }
		])
	})

	it("fileRestore emits a removed signal (the item leaves the trash preview)", () => {
		expect(captureReconcile({ type: "fileRestore", file: mockFile() })).toEqual([{ type: "removed", uuid: testUuid("file") }])
	})

	it("fileArchiveRestored emits a replaced signal keyed by the superseded uuid", () => {
		const events = captureReconcile({ type: "fileArchiveRestored", currentUuid: testUuid("old-current"), file: mockFile() })

		expect(events.length).toBe(1)
		const event = events[0]

		expect(event?.type).toBe("replaced")
		expect(event?.type === "replaced" ? event.previousUuid : "").toBe(testUuid("old-current"))
		expect(event?.type === "replaced" ? event.item.data.uuid : "").toBe(testUuid("file"))
	})

	it("fileMetadataChanged emits a fileMeta signal carrying the fresh meta (rename title)", () => {
		const metadata: FileMeta = {
			type: "decoded",
			data: { name: "renamed.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		}

		expect(captureReconcile({ type: "fileMetadataChanged", uuid: testUuid("file"), metadata })).toEqual([
			{ type: "fileMeta", uuid: testUuid("file"), meta: metadata }
		])
	})

	it("folderMetadataChanged emits a folderMeta signal", () => {
		expect(
			captureReconcile({ type: "folderMetadataChanged", uuid: testUuid("dir"), meta: { type: "decoded", data: { name: "Renamed" } } })
		).toEqual([{ type: "folderMeta", uuid: testUuid("dir"), meta: { type: "decoded", data: { name: "Renamed" } } }])
	})

	it("an attribute-only change (itemFavorite) emits no preview signal", () => {
		expect(captureReconcile({ type: "itemFavorite", item: { type: "file", ...mockFile({ favorited: true }) } })).toEqual([])
	})
})
