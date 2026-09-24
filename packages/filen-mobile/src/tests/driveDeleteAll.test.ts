// The move/copy pickers reuse a listing read in the current socket session, trusting socket events to
// have patched it. A delete-all (and an event the SDK couldn't read) patches nothing, so those listings
// must read again on their next mount. Real QueryClient, real read tracking, real drive socket handler.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const h = vi.hoisted(() => ({
	fakeCache: {
		rootUuid: "root" as string | null,
		uuidToAnyDriveItem: new Map<string, unknown>(),
		fileUuidToNormalFile: new Map<string, unknown>(),
		directoryUuidToAnyNormalDir: new Map<string, unknown>()
	}
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("expo-router", () => ({ useLocalSearchParams: vi.fn(), useNavigation: vi.fn() }))
vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir_Tags: { Dir: "Dir", Root: "Root" },
	AnyNormalDir: {},
	AnyDirWithContext: {},
	AnySharedDir: {},
	AnySharedDirWithContext: {},
	AnyLinkedDir: {},
	NonRootDir_Tags: {},
	NonRootItem_Tags: { File: "File", NormalDir: "NormalDir" },
	SharingRole: {},
	ErrorKind: {},
	SocketEvent_Tags: { Drive: "Drive" },
	DriveEvent_Tags: {
		FileNew: "FileNew",
		FolderSubCreated: "FolderSubCreated",
		FileMetadataChanged: "FileMetadataChanged",
		FolderMetadataChanged: "FolderMetadataChanged",
		FolderColorChanged: "FolderColorChanged",
		ItemFavorite: "ItemFavorite",
		DeleteAll: "DeleteAll",
		DeleteVersioned: "DeleteVersioned"
	}
}))
vi.mock("@/lib/auth", () => ({ default: { getSdkClients: vi.fn() } }))
vi.mock("@/lib/cache", () => ({ default: h.fakeCache }))
vi.mock("@/features/cameraUpload/cameraUpload", () => ({ default: { getConfig: vi.fn() } }))
vi.mock("@/features/cameraUpload/remoteListing", () => ({ listCameraUploadRemote: vi.fn(), remoteWalkDropsEntries: vi.fn() }))
vi.mock("@/features/offline/offline", () => ({ default: {} }))
vi.mock("@/features/drive/driveMetadata", () => ({ favoritesListingUpdater: vi.fn() }))
vi.mock("@/features/drive/queries/useDirectorySize.query", () => ({ markDirectorySizesStale: vi.fn() }))
vi.mock("@/lib/sdkErrors", () => ({ unwrapSdkError: vi.fn() }))
vi.mock("@/lib/sdkUnwrap", () => ({ unwrapParentUuid: vi.fn() }))
vi.mock("@/hooks/useDrivePath", () => ({
	DRIVE_PATH_TYPES: ["drive", "sharedIn", "recents", "favorites", "trash", "sharedOut", "offline", "links", "photos", "linked"]
}))
vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

	return {
		default: queryClient,
		queryClient,
		DEFAULT_QUERY_OPTIONS: {},
		queryUpdater: { get: vi.fn(), set: vi.fn() },
		preserveArrayIdentity: <T>(_prev: T[], next: T[]): T[] => next
	}
})

import { QueryObserver } from "@tanstack/react-query"
import { queryClient } from "@/queries/client"
import { driveItemsQueryKey } from "@/features/drive/queries/useDriveItems.query"
import { handleDriveEvent, handleDriveMalformedEvent, type DriveSocketEvent } from "@/features/drive/socketHandlers"
import { socketCoveredRefetchOnMount, trackServerReads } from "@/queries/socketSession"
import useSocketStore from "@/stores/useSocket.store"

type Path = Parameters<typeof driveItemsQueryKey>[0]["path"]

const SUB: Path = { type: "drive", uuid: "sub" }
const ROOTS: Path[] = [
	{ type: "drive", uuid: null },
	{ type: "drive", uuid: "root" },
	{ type: "recents", uuid: null },
	{ type: "trash", uuid: null }
]
const PHOTOS: Path = { type: "photos", uuid: "camroot" }

let untrack: () => void = () => {}
const fetches = new Map<string, number>()
const mounted: (() => void)[] = []

function keyOf(path: Path): string {
	return `${path.type}:${path.uuid ?? "-"}`
}

// A screen showing the listing the way the picker reads it: reuse a read from this socket session.
function mount(path: Path): void {
	const observer = new QueryObserver(queryClient, {
		queryKey: driveItemsQueryKey({ path }),
		queryFn: async () => {
			fetches.set(keyOf(path), (fetches.get(keyOf(path)) ?? 0) + 1)

			return []
		},
		staleTime: 0,
		refetchOnMount: socketCoveredRefetchOnMount()
	})

	mounted.push(observer.subscribe(() => {}))
}

function unmountAll(): void {
	for (const unsubscribe of mounted.splice(0)) {
		unsubscribe()
	}
}

async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0))
}

function deleteAll(): DriveSocketEvent {
	return { tag: "Drive", inner: [{ inner: { tag: "DeleteAll", inner: [] } }] } as unknown as DriveSocketEvent
}

beforeEach(() => {
	queryClient.clear()
	fetches.clear()
	untrack = trackServerReads(queryClient.getQueryCache())
	useSocketStore.setState({ state: "disconnected", connectedAt: 0 })
	useSocketStore.getState().setState("connected")
})

afterEach(() => {
	unmountAll()
	untrack()
})

describe("a delete-all", () => {
	it("makes a picker listing read in this socket session read again on its next mount", async () => {
		mount(SUB)
		await settle()
		unmountAll()
		mount(SUB)
		await settle()
		unmountAll()

		expect(fetches.get("drive:sub")).toBe(1)

		await handleDriveEvent({ event: deleteAll() })
		mount(SUB)
		await settle()

		expect(fetches.get("drive:sub")).toBe(2)
	})

	it("reads the mounted roots again now, but not a mounted subdirectory or the Photos grid", async () => {
		for (const path of [...ROOTS, SUB, PHOTOS]) {
			mount(path)
		}

		await settle()
		await handleDriveEvent({ event: deleteAll() })
		await settle()

		for (const path of ROOTS) {
			expect(fetches.get(keyOf(path))).toBe(2)
		}

		expect(fetches.get("drive:sub")).toBe(1)
		expect(fetches.get("photos:camroot")).toBe(1)
	})
})

describe("a drive event the SDK couldn't read", () => {
	it("fetches nothing now, and the listing reads again on its next mount", async () => {
		mount(SUB)
		mount({ type: "drive", uuid: null })
		await settle()
		unmountAll()

		handleDriveMalformedEvent()
		await settle()

		expect([fetches.get("drive:sub"), fetches.get("drive:-")]).toEqual([1, 1])

		mount(SUB)
		await settle()

		expect(fetches.get("drive:sub")).toBe(2)
	})
})
