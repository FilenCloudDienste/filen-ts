import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File, FileMeta, NormalDirsAndFiles, SocketEvent, UserInfo, UuidStr } from "@filen/sdk-rs"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest — the drive handler
// pulls it in transitively through queries/drive + lib/actions, so it's mocked down to the listing read
// (the handler only ever runs cache patchers, never a worker op; the colour tests read their source
// listings). Mirrors driveActions.test's mock boundary.
const { listDirectory } = vi.hoisted(() => ({ listDirectory: vi.fn<(target: unknown) => Promise<NormalDirsAndFiles>>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listDirectory } }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { logWarn, logError } = vi.hoisted(() => ({ logWarn: vi.fn(), logError: vi.fn() }))

vi.mock("@/lib/log", () => ({ log: { warn: logWarn, error: logError, info: vi.fn(), debug: vi.fn() } }))

import { queryClient as testQueryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { discardListingPatches, driveListingQueryKey, driveListingQueryOptions, flushListingCreates } from "@/features/drive/queries/drive"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { flushDeferredRecents, handleDriveEvent, markDriveEventsMissed } from "@/features/drive/lib/socketHandlers"
import { socketAuthenticated } from "@/lib/sdk/socketSession"
import { useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"
import { subscribePreviewReconcile, type PreviewReconcileEvent } from "@/features/preview/lib/previewReconcile"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const ROOT_UUID = testUuid("root")
const PARENT_A = testUuid("parent-a")
const PARENT_B = testUuid("parent-b")
// The whole-life id every fixture file carries. A content edit moves the lineage to the successor row,
// whose uuid is what a `newUUID` announces; a user trash leaves `newUUID` undefined.
const STABLE_FILE = testUuid("stable-file")
const NEW_FILE = testUuid("new-file")
// What a `fileTrash` carrying `newUUID` really names: the trashed row's OWN freshly minted stable id, not
// the lineage's — the lineage left with the successor's fileNew, so a fileTrash naming it would let a
// stable-keyed consumer tombstone the live file (the SDK's FileTrash doc comment says exactly this, and
// its live socket test asserts the two differ). fileArchived is the opposite: there `stableUUID` IS the
// lineage's on a normal edit, so those fixtures keep STABLE_FILE.
const RETIRED_STABLE = testUuid("retired-stable")

function seedRootUuid(uuid: UuidStr = ROOT_UUID): void {
	testQueryClient.setQueryData<UserInfo>(ACCOUNT_QUERY_KEY, { rootDirUuid: uuid } as UserInfo)
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("file"),
		stableUUID: STABLE_FILE,
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

function seedFavorites(items: DriveItem[]): void {
	testQueryClient.setQueryData(driveListingQueryKey({ variant: "favorites", uuid: null }), items)
}

function getFavorites(): DriveItem[] | undefined {
	return testQueryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "favorites", uuid: null }))
}

function seedRecents(items: DriveItem[]): void {
	testQueryClient.setQueryData(driveListingQueryKey({ variant: "recents", uuid: null }), items)
}

function getRecents(): DriveItem[] | undefined {
	return testQueryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "recents", uuid: null }))
}

function seedFlat(variant: "links" | "sharedOut", items: DriveItem[], uuid: string | null = null): void {
	testQueryClient.setQueryData(driveListingQueryKey({ variant, uuid }), items)
}

function getFlat(variant: "links" | "sharedOut", uuid: string | null = null): DriveItem[] | undefined {
	return testQueryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant, uuid }))
}

function copyRow(status: Transfer["status"]): Transfer {
	return {
		id: "copy",
		direction: "copy",
		name: "2 items",
		size: 0,
		bytesTransferred: 0,
		status,
		paused: false,
		parentUuid: null,
		startedAt: 0
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

// A read of a cached listing that stays under way until settled.
function readUnderWay(queryKey: ReturnType<typeof driveListingQueryKey>) {
	let resolve: (items: DriveItem[]) => void = () => undefined
	const pending = new Promise<DriveItem[]>(r => {
		resolve = r
	})
	const read = testQueryClient.query({ queryKey, queryFn: () => pending, staleTime: 0 })

	return {
		fetchStatus: () => testQueryClient.getQueryState(queryKey)?.fetchStatus,
		settle: async () => {
			resolve([])
			await read
		}
	}
}

beforeEach(() => {
	testQueryClient.clear()
	discardListingPatches()
	useDriveStore.setState({ selectedItems: [] })
	useTransfersStore.setState({ transfers: [], speedSamples: [] })
	flushDeferredRecents()
	vi.clearAllMocks()
})

// Creates land per parent once their window closes (queueListingCreate); these tests read at once.
function handleCreated(inner: Extract<SocketEvent, { type: "drive" }>["inner"]): void {
	handleDriveEvent(driveEvt(inner))
	flushListingCreates()
}

describe("drive socket handlers — additions", () => {
	it("fileNew splices the file into its parent listing", () => {
		seedListing(PARENT_A, [])
		handleCreated({ type: "fileNew", file: mockFile() })

		expect(getListing(PARENT_A).map(i => i.data.uuid)).toEqual([testUuid("file")])
	})

	it("fileNew into the root collapses the real root uuid onto the null-keyed listing", () => {
		seedRootUuid()
		seedListing(null, [])
		handleCreated({ type: "fileNew", file: mockFile({ parent: ROOT_UUID }) })

		expect(getListing(null).map(i => i.data.uuid)).toEqual([testUuid("file")])
	})

	it("folderSubCreated splices the directory into its parent listing", () => {
		seedListing(PARENT_A, [])
		handleCreated({ type: "folderSubCreated", dir: mockDir() })

		expect(getListing(PARENT_A).map(i => i.data.uuid)).toEqual([testUuid("dir")])
	})

	it.each([
		["fileNew", () => driveEvt({ type: "fileNew", file: mockFile() })],
		["folderSubCreated", () => driveEvt({ type: "folderSubCreated", dir: mockDir() })],
		["fileRestore", () => driveEvt({ type: "fileRestore", file: mockFile() })],
		["folderRestore", () => driveEvt({ type: "folderRestore", dir: mockDir() })],
		["fileArchiveRestored", () => driveEvt({ type: "fileArchiveRestored", currentUuid: testUuid("old"), file: mockFile() })]
	])("%s never creates a listing for a parent nobody has read", (_label, buildEvent) => {
		handleDriveEvent(buildEvent())
		flushListingCreates()

		expect(testQueryClient.getQueryData(driveListingQueryKey({ variant: "drive", uuid: PARENT_A }))).toBeUndefined()
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

	it("folderRestore removes the directory everywhere then re-adds it to its parent (trash included)", () => {
		seedTrash([narrowItem(mockDir())])
		seedListing(PARENT_A, [])
		handleDriveEvent(driveEvt({ type: "folderRestore", dir: mockDir() }))

		expect(getTrash()).toEqual([])
		expect(getListing(PARENT_A).map(i => i.data.uuid)).toEqual([testUuid("dir")])
	})

	it("folderRestore splices into the NEW parent the payload carries, not the listing it came from", () => {
		seedListing(PARENT_A, [narrowItem(mockDir())])
		seedListing(PARENT_B, [])
		handleDriveEvent(driveEvt({ type: "folderRestore", dir: mockDir({ parent: PARENT_B }) }))

		expect(getListing(PARENT_A)).toEqual([])
		expect(getListing(PARENT_B).map(i => i.data.uuid)).toEqual([testUuid("dir")])
	})

	it("folderRestore into the root collapses the real root uuid onto the null-keyed listing", () => {
		seedRootUuid()
		seedListing(null, [])
		handleDriveEvent(driveEvt({ type: "folderRestore", dir: mockDir({ parent: ROOT_UUID }) }))

		expect(getListing(null).map(i => i.data.uuid)).toEqual([testUuid("dir")])
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

	it("fileMove keeps a favorite in the cached Favorites listing with its new parent", () => {
		seedListing(PARENT_A, [narrowItem(mockFile({ favorited: true }))])
		seedFavorites([narrowItem(mockFile({ favorited: true }))])
		handleDriveEvent(driveEvt({ type: "fileMove", file: mockFile({ parent: PARENT_B, favorited: true }) }))

		expect(getFavorites()?.map(i => [i.data.uuid, i.data.parent])).toEqual([[testUuid("file"), PARENT_B]])
		expect(getListing(PARENT_A)).toEqual([])
	})

	it("fileMove keeps a recent and a linked row in place with the new parent", () => {
		seedRecents([narrowItem(mockFile())])
		seedFlat("links", [narrowItem(mockFile())])
		handleDriveEvent(driveEvt({ type: "fileMove", file: mockFile({ parent: PARENT_B }) }))

		expect(getRecents()?.map(i => i.data.parent)).toEqual([PARENT_B])
		expect(getFlat("links")?.map(i => i.data.parent)).toEqual([PARENT_B])
	})

	it("folderMove keeps a favorite directory in Favorites with its new parent", () => {
		seedFavorites([narrowItem(mockDir({ favorited: true }))])
		handleDriveEvent(driveEvt({ type: "folderMove", dir: mockDir({ parent: PARENT_B, favorited: true }) }))

		expect(getFavorites()?.map(i => [i.data.uuid, i.data.parent])).toEqual([[testUuid("dir"), PARENT_B]])
	})

	it("a move never adds the row to a flat listing that didn't hold it", () => {
		seedFavorites([])
		seedRecents([])
		handleDriveEvent(driveEvt({ type: "fileMove", file: mockFile({ parent: PARENT_B }) }))

		expect(getFavorites()).toEqual([])
		expect(getRecents()).toEqual([])
	})

	it("a move takes the row out of the trash", () => {
		seedTrash([narrowItem(mockFile())])
		handleDriveEvent(driveEvt({ type: "fileMove", file: mockFile({ parent: PARENT_B }) }))

		expect(getTrash()).toEqual([])
	})

	it("a move keeps a shared root row but drops it from a nested shared listing it left", () => {
		const row = narrowItem(mockFile())

		seedFlat("sharedOut", [row])
		seedFlat("sharedOut", [row], PARENT_A)
		handleDriveEvent(driveEvt({ type: "fileMove", file: mockFile({ parent: PARENT_B }) }))

		expect(getFlat("sharedOut")).toEqual([row])
		expect(getFlat("sharedOut", PARENT_A)).toEqual([])
	})
})

describe("drive socket handlers — favorites rejoin", () => {
	it("fileRestore of a favorited file puts it back in Favorites", () => {
		seedTrash([narrowItem(mockFile({ favorited: true }))])
		seedFavorites([])
		handleDriveEvent(driveEvt({ type: "fileRestore", file: mockFile({ favorited: true }) }))

		expect(getFavorites()?.map(i => i.data.uuid)).toEqual([testUuid("file")])
	})

	it("folderRestore of a favorited directory puts it back in Favorites", () => {
		seedFavorites([])
		handleDriveEvent(driveEvt({ type: "folderRestore", dir: mockDir({ favorited: true }) }))

		expect(getFavorites()?.map(i => i.data.uuid)).toEqual([testUuid("dir")])
	})

	it("an edited favorite's successor replaces it in Favorites", () => {
		seedFavorites([narrowItem(mockFile({ favorited: true }))])
		handleDriveEvent(driveEvt({ type: "fileArchived", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: NEW_FILE }))
		handleDriveEvent(driveEvt({ type: "fileNew", file: mockFile({ uuid: NEW_FILE, favorited: true }) }))

		expect(getFavorites()?.map(i => i.data.uuid)).toEqual([NEW_FILE])
	})

	it("fileArchiveRestored of a favorite swaps the restored version into Favorites", () => {
		seedFavorites([narrowItem(mockFile({ uuid: testUuid("old-current"), favorited: true }))])
		handleDriveEvent(
			driveEvt({ type: "fileArchiveRestored", currentUuid: testUuid("old-current"), file: mockFile({ favorited: true }) })
		)

		expect(getFavorites()?.map(i => i.data.uuid)).toEqual([testUuid("file")])
	})

	it("a new file joins Recents", () => {
		seedRecents([])
		handleCreated({ type: "fileNew", file: mockFile() })

		expect(getRecents()?.map(i => i.data.uuid)).toEqual([testUuid("file")])
	})

	it("while a copy runs, new files leave Recents alone; it is re-read once after the last copy settles", () => {
		seedRecents([])
		useTransfersStore.setState({ transfers: [copyRow("copying"), { ...copyRow("copying"), id: "copy-2" }] })

		handleDriveEvent(driveEvt({ type: "fileNew", file: mockFile() }))
		handleCreated({ type: "fileNew", file: mockFile({ uuid: testUuid("file-2") }) })

		expect(getRecents()).toEqual([])

		const recentsQuery = () =>
			testQueryClient.getQueryCache().find({ queryKey: driveListingQueryKey({ variant: "recents", uuid: null }) })

		// One copy still runs: nothing yet.
		useTransfersStore.setState({ transfers: [copyRow("done"), { ...copyRow("copying"), id: "copy-2" }] })
		flushDeferredRecents()

		expect(recentsQuery()?.state.isInvalidated).toBe(false)

		useTransfersStore.setState({ transfers: [copyRow("done"), { ...copyRow("completedWithErrors"), id: "copy-2" }] })
		flushDeferredRecents()

		expect(recentsQuery()?.state.isInvalidated).toBe(true)
	})

	it("flushing with nothing deferred reads nothing", () => {
		seedRecents([])
		flushDeferredRecents()

		expect(
			testQueryClient.getQueryCache().find({ queryKey: driveListingQueryKey({ variant: "recents", uuid: null }) })?.state
				.isInvalidated
		).toBe(false)
	})

	it("an unfavorited new file leaves Favorites alone", () => {
		seedFavorites([])
		handleCreated({ type: "fileNew", file: mockFile() })

		expect(getFavorites()).toEqual([])
	})
})

describe("drive socket handlers — removals + selection purge", () => {
	it("fileTrash removes the row from every normal listing and purges the selection", () => {
		const item = narrowItem(mockFile())
		seedListing(PARENT_A, [item])
		seedFavorites([item])
		seedRecents([item])
		useDriveStore.setState({ selectedItems: [item] })

		handleDriveEvent(driveEvt({ type: "fileTrash", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: undefined }))

		expect(getListing(PARENT_A)).toEqual([])
		expect(getFavorites()).toEqual([])
		expect(getRecents()).toEqual([])
		expect(useDriveStore.getState().selectedItems).toEqual([])
	})

	it("fileDeletedPermanent removes the row from every listing and purges the selection", () => {
		const item = narrowItem(mockFile())
		seedListing(PARENT_A, [item])
		useDriveStore.setState({ selectedItems: [item] })

		handleDriveEvent(driveEvt({ type: "fileDeletedPermanent", uuid: testUuid("file"), stableUUID: STABLE_FILE }))

		expect(getListing(PARENT_A)).toEqual([])
		expect(useDriveStore.getState().selectedItems).toEqual([])
	})

	it("fileDeletedPermanent WITHOUT stableUUID leaves the live file alone — only an archived version died", () => {
		// Its uuid names the deleted VERSION. A listing cached before a content rotation still holds the old
		// uuid as the live row, so acting on this would make an existing file vanish until the next refetch.
		const item = narrowItem(mockFile())
		seedListing(PARENT_A, [item])
		useDriveStore.setState({ selectedItems: [item] })

		handleDriveEvent(driveEvt({ type: "fileDeletedPermanent", uuid: testUuid("file"), stableUUID: undefined }))

		expect(getListing(PARENT_A).map(i => i.data.uuid)).toEqual([testUuid("file")])
		expect(useDriveStore.getState().selectedItems).toHaveLength(1)
	})

	it("folderDeletedPermanent removes the directory from every listing and purges the selection", () => {
		const item = narrowItem(mockDir())
		seedListing(PARENT_A, [item])
		seedTrash([item])
		useDriveStore.setState({ selectedItems: [item] })

		handleDriveEvent(driveEvt({ type: "folderDeletedPermanent", uuid: testUuid("dir") }))

		expect(getListing(PARENT_A)).toEqual([])
		expect(getTrash()).toEqual([])
		expect(useDriveStore.getState().selectedItems).toEqual([])
	})

	it("folderTrash removes the directory from every normal listing", () => {
		seedListing(PARENT_A, [narrowItem(mockDir())])
		handleDriveEvent(driveEvt({ type: "folderTrash", parent: PARENT_A, uuid: testUuid("dir") }))

		expect(getListing(PARENT_A)).toEqual([])
	})

	it("fileArchived strips the superseded row from every listing and purges the selection", () => {
		const item = narrowItem(mockFile())
		seedListing(PARENT_A, [item])
		seedRecents([item])
		useDriveStore.setState({ selectedItems: [item] })

		handleDriveEvent(driveEvt({ type: "fileArchived", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: NEW_FILE }))

		expect(getListing(PARENT_A)).toEqual([])
		expect(getRecents()).toEqual([])
		expect(useDriveStore.getState().selectedItems).toEqual([])
	})

	// A version rotation is not a trashing: the successor arrives as its own fileNew, so the superseded
	// uuid must never surface in the trash listing.
	it("fileArchived never adds the superseded row to the trash listing", () => {
		const item = narrowItem(mockFile())
		seedListing(PARENT_A, [item])
		seedTrash([])

		handleDriveEvent(driveEvt({ type: "fileArchived", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: NEW_FILE }))

		expect(getTrash()).toEqual([])
	})

	it("deleteVersioned is logged and mutates nothing", () => {
		const item = narrowItem(mockFile())
		seedListing(PARENT_A, [item])
		useDriveStore.setState({ selectedItems: [item] })

		handleDriveEvent(driveEvt({ type: "deleteVersioned" }))

		expect(getListing(PARENT_A).map(i => i.data.uuid)).toEqual([testUuid("file")])
		expect(useDriveStore.getState().selectedItems).toEqual([item])
		expect(logWarn).toHaveBeenCalled()
	})
})

// The realtime echo of a trash (another device, another tab, or this tab's own action) must not make
// the item disappear from the ONE listing it just joined: a fan-out removal alone leaves an already-open
// /trash showing nothing until its next refetch.
describe("drive socket handlers — trash listing membership", () => {
	it("fileTrash moves the row INTO an already-fetched trash listing", () => {
		const item = narrowItem(mockFile())
		seedListing(PARENT_A, [item])
		seedTrash([])

		handleDriveEvent(driveEvt({ type: "fileTrash", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: undefined }))

		expect(getListing(PARENT_A)).toEqual([])
		expect(getTrash()?.map(i => i.data.uuid)).toEqual([testUuid("file")])
	})

	it("fileTrash leaves a row the trash listing already holds in place (a re-delivered echo never drops it)", () => {
		seedTrash([narrowItem(mockFile())])

		handleDriveEvent(driveEvt({ type: "fileTrash", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: undefined }))
		handleDriveEvent(driveEvt({ type: "fileTrash", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: undefined }))

		expect(getTrash()?.map(i => i.data.uuid)).toEqual([testUuid("file")])
	})

	it("fileTrash carrying newUUID never reaches the trash listing — it is a versioning-disabled edit", () => {
		// The SDK documents newUUID as "an edit on a versioning-disabled account, NOT a user trash action".
		// The superseded row still leaves its normal listing (its fileNew successor splices in beside it),
		// but showing a just-saved file in Trash would be plainly wrong.
		const item = narrowItem(mockFile())
		seedListing(PARENT_A, [item])
		seedTrash([])

		handleDriveEvent(driveEvt({ type: "fileTrash", uuid: testUuid("file"), stableUUID: RETIRED_STABLE, newUUID: NEW_FILE }))

		expect(getListing(PARENT_A)).toEqual([])
		expect(getTrash()).toEqual([])
	})

	it("folderTrash moves the directory INTO an already-fetched trash listing", () => {
		seedListing(PARENT_A, [narrowItem(mockDir())])
		seedTrash([])

		handleDriveEvent(driveEvt({ type: "folderTrash", parent: PARENT_A, uuid: testUuid("dir") }))

		expect(getTrash()?.map(i => i.data.uuid)).toEqual([testUuid("dir")])
	})

	it("never conjures a trash listing nobody has opened", () => {
		seedListing(PARENT_A, [narrowItem(mockFile())])

		handleDriveEvent(driveEvt({ type: "fileTrash", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: undefined }))

		expect(getTrash()).toBeUndefined()
	})

	it("applies the removal alone when no cached listing holds the trashed uuid", () => {
		seedTrash([])

		handleDriveEvent(
			driveEvt({ type: "fileTrash", uuid: testUuid("unknown"), stableUUID: testUuid("stable-unknown"), newUUID: undefined })
		)

		expect(getTrash()).toEqual([])
	})

	// The owner trashing a file they shared with this account removes it from the shared listing; it
	// never lands in THIS account's trash.
	it("never moves a shared-in row into this account's trash listing", () => {
		const shared = narrowItem({
			...mockFile({ stableUUID: undefined }),
			sharingRole: { Receiver: { email: "sharer@filen.io", id: 7 } }
		})
		testQueryClient.setQueryData(driveListingQueryKey({ variant: "sharedIn", uuid: null }), [shared])
		seedTrash([])

		handleDriveEvent(driveEvt({ type: "fileTrash", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: undefined }))

		expect(testQueryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "sharedIn", uuid: null }))).toEqual([])
		expect(getTrash()).toEqual([])
	})

	// A cancelled read reverts and never retries on its own; the read applies the insert to its result.
	it("patches membership without cancelling a trash read under way", async () => {
		seedListing(PARENT_A, [narrowItem(mockFile())])
		seedTrash([])
		const read = readUnderWay(driveListingQueryKey({ variant: "trash", uuid: null }))

		handleDriveEvent(driveEvt({ type: "fileTrash", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: undefined }))

		expect(read.fetchStatus()).toBe("fetching")
		expect(getTrash()?.map(i => i.data.uuid)).toEqual([testUuid("file")])

		await read.settle()
	})
})

describe("drive socket handlers — batched creates", () => {
	// A copy or a many-file upload lands one create per item and its echo repeats it; each used to
	// rewrite and re-render the whole parent listing and Recents on its own.
	it("a burst of creates lands in one write per listing once its window closes", () => {
		seedListing(PARENT_A, [])
		seedRecents([])
		const write = vi.spyOn(testQueryClient, "setQueryData")

		for (let i = 0; i < 20; i++) {
			const file = mockFile({
				uuid: testUuid(`file${String(i)}`),
				meta: {
					type: "decoded",
					data: { name: `${String(i)}.pdf`, mime: "application/pdf", modified: 1n, size: 1n, key: "k", version: 2 }
				}
			})

			handleDriveEvent(driveEvt({ type: "fileNew", file }))
			handleDriveEvent(driveEvt({ type: "fileNew", file }))
		}

		handleDriveEvent(driveEvt({ type: "folderSubCreated", dir: mockDir() }))

		expect(write).not.toHaveBeenCalled()

		flushListingCreates()

		expect(write).toHaveBeenCalledTimes(2)
		expect(getListing(PARENT_A)).toHaveLength(21)
		expect(getRecents()).toHaveLength(20)
	})

	// The queued row is what the trash insert is read from, and the trash must not be undone later.
	it("a trash right after a create moves the new row into the trash for good", () => {
		seedListing(PARENT_A, [])
		seedTrash([])

		handleDriveEvent(driveEvt({ type: "fileNew", file: mockFile() }))
		handleDriveEvent(driveEvt({ type: "fileTrash", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: undefined }))
		flushListingCreates()

		expect(getListing(PARENT_A)).toEqual([])
		expect(getTrash()?.map(i => i.data.uuid)).toEqual([testUuid("file")])
	})
})

// The socket's directory move and restore payloads carry no colour: the SDK fills in the default.
describe("drive socket handlers — directory colour on move and restore", () => {
	function colorOf(items: DriveItem[] | undefined, uuid: string): string | undefined {
		const row = items?.find(item => item.data.uuid === uuid)

		return row?.type === "directory" ? row.data.color : undefined
	}

	function isInvalidated(uuid: string | null): boolean | undefined {
		return testQueryClient.getQueryState(driveListingQueryKey({ variant: "drive", uuid }))?.isInvalidated
	}

	function flatInvalidated(variant: "trash" | "favorites"): boolean | undefined {
		return testQueryClient.getQueryState(driveListingQueryKey({ variant, uuid: null }))?.isInvalidated
	}

	// Read from the server under the live socket, so every event since has reached its rows.
	async function readListing(variant: "drive" | "trash" | "favorites", uuid: string | null, dirs: Dir[]): Promise<void> {
		socketAuthenticated()
		listDirectory.mockResolvedValueOnce({ dirs, files: [] })

		await testQueryClient.query(driveListingQueryOptions(variant, uuid))
	}

	it("folderMove keeps the colour its current row holds, in the destination and in Favorites", async () => {
		const blue = mockDir({ color: "blue", favorited: true })
		await readListing("drive", PARENT_A, [blue])
		seedListing(PARENT_B, [])
		seedFavorites([narrowItem(blue)])

		handleDriveEvent(driveEvt({ type: "folderMove", dir: mockDir({ parent: PARENT_B, favorited: true }) }))

		expect(colorOf(getListing(PARENT_B), testUuid("dir"))).toBe("blue")
		expect(colorOf(getFavorites(), testUuid("dir"))).toBe("blue")
		expect(isInvalidated(PARENT_B)).toBe(false)
	})

	it("folderRestore keeps the colour of the row a current trash listing holds", async () => {
		await readListing("trash", null, [mockDir({ color: "green" })])
		seedListing(PARENT_A, [])

		handleDriveEvent(driveEvt({ type: "folderRestore", dir: mockDir() }))

		expect(colorOf(getListing(PARENT_A), testUuid("dir"))).toBe("green")
		expect(getTrash()).toEqual([])
		expect(isInvalidated(PARENT_A)).toBe(false)
	})

	// Restored from disk, it may predate a recolour made while the app was closed.
	it.each([
		[
			"folderMove",
			() => {
				seedListing(PARENT_A, [narrowItem(mockDir({ color: "red" }))])
			},
			() => driveEvt({ type: "folderMove", dir: mockDir({ parent: PARENT_B }) })
		],
		[
			"folderRestore",
			() => {
				seedTrash([narrowItem(mockDir({ color: "red" }))])
			},
			() => driveEvt({ type: "folderRestore", dir: mockDir({ parent: PARENT_B }) })
		]
	])("%s takes no colour from a listing this session hasn't read, and marks its destination stale", (_label, seedSource, buildEvent) => {
		seedSource()
		seedListing(PARENT_B, [])

		handleDriveEvent(buildEvent())

		expect(colorOf(getListing(PARENT_B), testUuid("dir"))).toBe("default")
		expect(isInvalidated(PARENT_B)).toBe(true)
	})

	// Its rows missed whatever changed while the socket was gone.
	it("folderMove takes no colour from a listing a socket drop left stale", async () => {
		await readListing("drive", PARENT_A, [mockDir({ color: "red" })])
		markDriveEventsMissed()
		seedListing(PARENT_B, [])

		handleDriveEvent(driveEvt({ type: "folderMove", dir: mockDir({ parent: PARENT_B }) }))

		expect(colorOf(getListing(PARENT_B), testUuid("dir"))).toBe("default")
		expect(isInvalidated(PARENT_B)).toBe(true)
	})

	// A trash echo carries only the uuid, so its row comes from whichever listing holds it.
	it("a trash listing given a row only an unread listing held lends no colour to the restore", async () => {
		seedListing(PARENT_A, [narrowItem(mockDir({ color: "red" }))])
		await readListing("trash", null, [])
		await readListing("drive", PARENT_B, [])

		handleDriveEvent(driveEvt({ type: "folderTrash", parent: PARENT_A, uuid: testUuid("dir") }))

		expect(colorOf(getTrash(), testUuid("dir"))).toBe("red")
		expect(flatInvalidated("trash")).toBe(true)

		handleDriveEvent(driveEvt({ type: "folderRestore", dir: mockDir({ parent: PARENT_B }) }))

		expect(colorOf(getListing(PARENT_B), testUuid("dir"))).toBe("default")
		expect(isInvalidated(PARENT_B)).toBe(true)
	})

	it("a trash listing given a current row stays current and lends its colour to the restore", async () => {
		// Cached first, so a search that stopped at the first row would take its colour.
		seedListing(PARENT_A, [narrowItem(mockDir({ color: "red" }))])
		await readListing("favorites", null, [mockDir({ color: "blue", favorited: true })])
		await readListing("trash", null, [])
		await readListing("drive", PARENT_B, [])

		handleDriveEvent(driveEvt({ type: "folderTrash", parent: PARENT_A, uuid: testUuid("dir") }))

		expect(colorOf(getTrash(), testUuid("dir"))).toBe("blue")
		expect(flatInvalidated("trash")).toBe(false)

		handleDriveEvent(driveEvt({ type: "folderRestore", dir: mockDir({ parent: PARENT_B }) }))

		expect(colorOf(getListing(PARENT_B), testUuid("dir"))).toBe("blue")
		expect(isInvalidated(PARENT_B)).toBe(false)
	})

	it("a file row from an unread listing leaves the trash listing current", async () => {
		seedListing(PARENT_A, [narrowItem(mockFile())])
		await readListing("trash", null, [])

		handleDriveEvent(driveEvt({ type: "fileTrash", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: undefined }))

		expect(getTrash()?.map(i => i.data.uuid)).toEqual([testUuid("file")])
		expect(flatInvalidated("trash")).toBe(false)
	})

	it("a favorite restored with no colour to keep leaves Favorites lending none to a later move", async () => {
		await readListing("favorites", null, [])
		await readListing("drive", PARENT_A, [])
		await readListing("drive", PARENT_B, [])

		handleDriveEvent(driveEvt({ type: "folderRestore", dir: mockDir({ favorited: true }) }))

		expect(colorOf(getFavorites(), testUuid("dir"))).toBe("default")
		expect(flatInvalidated("favorites")).toBe(true)

		handleDriveEvent(driveEvt({ type: "folderMove", dir: mockDir({ parent: PARENT_B, favorited: true }) }))

		expect(isInvalidated(PARENT_B)).toBe(true)
	})

	// A read under way applies the move to what it returns: writing the payload's default there would
	// overwrite the colour the server just returned, in a read that still counts.
	it("a colourless move leaves a Favorites read's server colour in place, which it then lends", async () => {
		const pending = deferred<NormalDirsAndFiles>()

		socketAuthenticated()
		listDirectory.mockReturnValueOnce(pending.promise)

		const read = testQueryClient.query(driveListingQueryOptions("favorites", null))

		handleDriveEvent(driveEvt({ type: "folderMove", dir: mockDir({ parent: PARENT_B, favorited: true }) }))
		pending.resolve({ dirs: [mockDir({ parent: PARENT_B, favorited: true, color: "blue" })], files: [] })
		await read

		expect(colorOf(getFavorites(), testUuid("dir"))).toBe("blue")

		await readListing("drive", PARENT_A, [])
		handleDriveEvent(driveEvt({ type: "folderMove", dir: mockDir({ parent: PARENT_A, favorited: true }) }))

		expect(colorOf(getListing(PARENT_A), testUuid("dir"))).toBe("blue")
		expect(isInvalidated(PARENT_A)).toBe(false)
	})

	it("a colourless move leaves each flat row its own colour", () => {
		seedFavorites([narrowItem(mockDir({ color: "green", favorited: true }))])
		seedFlat("links", [narrowItem(mockDir({ color: "purple" }))])

		handleDriveEvent(driveEvt({ type: "folderMove", dir: mockDir({ parent: PARENT_B, favorited: true }) }))

		expect(colorOf(getFavorites(), testUuid("dir"))).toBe("green")
		expect(colorOf(getFlat("links"), testUuid("dir"))).toBe("purple")
		expect(getFavorites()?.map(i => i.data.parent)).toEqual([PARENT_B])
	})

	// Nothing to take the colour from: the destination reads again rather than keep a guess.
	it.each([
		["folderMove", () => driveEvt({ type: "folderMove", dir: mockDir({ parent: PARENT_B }) })],
		["folderRestore", () => driveEvt({ type: "folderRestore", dir: mockDir({ parent: PARENT_B }) })]
	])("%s of a directory no listing holds marks its destination stale", (_label, buildEvent) => {
		seedListing(PARENT_B, [])

		handleDriveEvent(buildEvent())

		expect(getListing(PARENT_B).map(i => i.data.uuid)).toEqual([testUuid("dir")])
		expect(isInvalidated(PARENT_B)).toBe(true)
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

describe("drive socket handlers — favorites membership", () => {
	it("itemFavorite ADDS a newly-favorited file to a cached favorites listing", () => {
		seedFavorites([])
		handleDriveEvent(driveEvt({ type: "itemFavorite", item: { type: "file", ...mockFile({ favorited: true }) } }))

		expect(getFavorites()?.map(item => item.data.uuid)).toEqual([testUuid("file")])
	})

	it("itemFavorite ADDS a newly-favorited directory to a cached favorites listing", () => {
		seedFavorites([])
		handleDriveEvent(driveEvt({ type: "itemFavorite", item: { type: "normalDir", ...mockDir({ favorited: true }) } }))

		expect(getFavorites()?.map(item => item.data.uuid)).toEqual([testUuid("dir")])
	})

	it("itemFavorite REMOVES an unfavorited item from the favorites listing", () => {
		seedFavorites([narrowItem(mockFile({ favorited: true }))])
		handleDriveEvent(driveEvt({ type: "itemFavorite", item: { type: "file", ...mockFile({ favorited: false }) } }))

		expect(getFavorites()).toEqual([])
	})

	it("itemFavorite never conjures the favorites listing when it was never fetched", () => {
		handleDriveEvent(driveEvt({ type: "itemFavorite", item: { type: "file", ...mockFile({ favorited: true }) } }))

		expect(getFavorites()).toBeUndefined()
	})

	it("itemFavorite dedups by uuid — a re-delivered event leaves exactly one row", () => {
		seedFavorites([])
		handleDriveEvent(driveEvt({ type: "itemFavorite", item: { type: "file", ...mockFile({ favorited: true }) } }))
		handleDriveEvent(driveEvt({ type: "itemFavorite", item: { type: "file", ...mockFile({ favorited: true }) } }))

		expect(getFavorites()?.map(item => item.data.uuid)).toEqual([testUuid("file")])
	})

	it("itemFavorite patches membership without cancelling a favorites read under way", async () => {
		seedFavorites([])
		const read = readUnderWay(driveListingQueryKey({ variant: "favorites", uuid: null }))

		handleDriveEvent(driveEvt({ type: "itemFavorite", item: { type: "file", ...mockFile({ favorited: true }) } }))

		expect(read.fetchStatus()).toBe("fetching")
		expect(getFavorites()?.map(item => item.data.uuid)).toEqual([testUuid("file")])

		await read.settle()
	})

	it("itemFavorite still replaces the row in place in every other cached listing", () => {
		seedListing(PARENT_A, [narrowItem(mockFile())])
		seedFavorites([])
		handleDriveEvent(driveEvt({ type: "itemFavorite", item: { type: "file", ...mockFile({ favorited: true }) } }))

		expect(getListing(PARENT_A).map(item => item.data.uuid)).toEqual([testUuid("file")])
		expect(getListing(PARENT_A)[0]?.data.favorited).toBe(true)
	})
})

describe("drive socket handlers — recents insertion", () => {
	it("fileNew appends the file to a cached recents listing", () => {
		seedRecents([])
		handleCreated({ type: "fileNew", file: mockFile() })

		expect(getRecents()?.map(item => item.data.uuid)).toEqual([testUuid("file")])
	})

	it("fileNew never conjures a recents listing that was never fetched", () => {
		handleCreated({ type: "fileNew", file: mockFile() })

		expect(getRecents()).toBeUndefined()
	})

	it("fileNew dedups by uuid in recents on a re-delivered event", () => {
		seedRecents([])
		handleDriveEvent(driveEvt({ type: "fileNew", file: mockFile() }))
		handleCreated({ type: "fileNew", file: mockFile() })

		expect(getRecents()?.map(item => item.data.uuid)).toEqual([testUuid("file")])
	})

	// Recents runs staleTime 0 and refetches on mount/focus. A refetch snapshotted before the upload was
	// server-visible gets the insert applied to what it returns (driveListingRequestCount.test.ts).
	it("fileNew patches recents without cancelling a recents read under way", async () => {
		seedRecents([])
		const read = readUnderWay(driveListingQueryKey({ variant: "recents", uuid: null }))

		handleCreated({ type: "fileNew", file: mockFile() })

		expect(read.fetchStatus()).toBe("fetching")
		expect(getRecents()?.map(item => item.data.uuid)).toEqual([testUuid("file")])

		await read.settle()
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
		expect(captureReconcile({ type: "fileTrash", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: undefined })).toEqual([
			{ type: "removed", uuid: testUuid("file") }
		])
	})

	it("fileTrash carrying newUUID emits NO reconcile signal — same reasoning as fileArchived", () => {
		// A versioning-disabled save is fileArchived's twin. Emitting a removal would yank the just-saved
		// file out of an open preview the instant the socket echoed the user's own save.
		expect(captureReconcile({ type: "fileTrash", uuid: testUuid("file"), stableUUID: RETIRED_STABLE, newUUID: NEW_FILE })).toEqual([])
	})

	it("fileMove emits a removed signal so a preview open on it advances or closes", () => {
		expect(captureReconcile({ type: "fileMove", file: mockFile({ parent: PARENT_B }) })).toEqual([
			{ type: "removed", uuid: testUuid("file") }
		])
	})

	it("fileDeletedPermanent emits a removed signal", () => {
		expect(captureReconcile({ type: "fileDeletedPermanent", uuid: testUuid("file"), stableUUID: STABLE_FILE })).toEqual([
			{ type: "removed", uuid: testUuid("file") }
		])
	})

	it("fileDeletedPermanent WITHOUT stableUUID emits nothing — one archived version died, not the file", () => {
		// The SDK: "Absent for archived-version-only deletes — never treat the file as gone then." The uuid
		// names the deleted VERSION; an open preview legitimately still holds a pre-rotation uuid, so a
		// removal here would close a preview of a file that still exists.
		expect(captureReconcile({ type: "fileDeletedPermanent", uuid: testUuid("file"), stableUUID: undefined })).toEqual([])
	})

	it("fileArchived emits NO reconcile signal — the file lives on under its version-rotated successor", () => {
		// A save on an OPEN preview archives the old uuid (its successor arrives as fileNew). Emitting a
		// removal here would yank the just-saved file's slot out of the frozen pager the instant the
		// socket echoed the user's own save — the exact regression this pin guards: the editor keeps
		// serving fresh bytes through its saved-uuid aliases, so the open slot must survive the archive.
		expect(captureReconcile({ type: "fileArchived", uuid: testUuid("file"), stableUUID: STABLE_FILE, newUUID: NEW_FILE })).toEqual([])
	})

	it("fileRestore emits a removed signal (the item leaves the trash preview)", () => {
		expect(captureReconcile({ type: "fileRestore", file: mockFile() })).toEqual([{ type: "removed", uuid: testUuid("file") }])
	})

	it("folderRestore emits a removed signal (the directory leaves the trash listing)", () => {
		expect(captureReconcile({ type: "folderRestore", dir: mockDir() })).toEqual([{ type: "removed", uuid: testUuid("dir") }])
	})

	it("folderDeletedPermanent emits a removed signal", () => {
		expect(captureReconcile({ type: "folderDeletedPermanent", uuid: testUuid("dir") })).toEqual([
			{ type: "removed", uuid: testUuid("dir") }
		])
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
