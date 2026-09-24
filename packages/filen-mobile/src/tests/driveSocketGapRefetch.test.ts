// The refetch after a copy outran the socket, against a real QueryClient and the real ancestry walk:
// which drive listings it marks stale, and that only mounted ones are fetched. Nested listings reach
// their data only through socket echoes, so a gap leaves them incomplete, not just the destination.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const h = vi.hoisted(() => ({
	getConfig: vi.fn(),
	fakeCache: {
		rootUuid: "root" as string | null,
		directoryUuidToAnyNormalDir: new Map<string, { tag: string; inner: [{ uuid: string; parent: string }] }>()
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
	NonRootDir_Tags: {},
	SharingRole: {},
	ErrorKind: {}
}))
vi.mock("@/lib/auth", () => ({ default: { getSdkClients: vi.fn() } }))
vi.mock("@/lib/cache", () => ({ default: h.fakeCache }))
vi.mock("@/features/cameraUpload/cameraUpload", () => ({ default: { getConfig: h.getConfig } }))
vi.mock("@/features/cameraUpload/remoteListing", () => ({ listCameraUploadRemote: vi.fn(), remoteWalkDropsEntries: vi.fn() }))
vi.mock("@/features/offline/offline", () => ({ default: {} }))
vi.mock("@/features/drive/utils", () => ({ linkPasswordState: vi.fn(), linkedRootOf: vi.fn() }))
vi.mock("@/lib/sdkErrors", () => ({ unwrapSdkError: vi.fn() }))
vi.mock("@/hooks/useDrivePath", () => ({
	DRIVE_PATH_TYPES: ["drive", "sharedIn", "recents", "favorites", "trash", "sharedOut", "offline", "links", "photos", "linked"]
}))
vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapParentUuid: (parent: unknown) => (typeof parent === "string" ? parent : null),
	unwrapFileMeta: vi.fn(),
	unwrapDirMeta: vi.fn(),
	unwrappedFileIntoDriveItem: vi.fn(),
	unwrappedDirIntoDriveItem: vi.fn()
}))
vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

	return {
		default: queryClient,
		queryClient,
		DEFAULT_QUERY_OPTIONS: {},
		queryUpdater: {
			get: (queryKey: unknown[]) => queryClient.getQueryData(queryKey),
			set: (queryKey: unknown[], data: unknown) => queryClient.setQueryData(queryKey, data)
		},
		preserveArrayIdentity: <T>(_prev: T[], next: T[]): T[] => next
	}
})

import { QueryObserver } from "@tanstack/react-query"
import { queryClient } from "@/queries/client"
import { driveItemsQueryKey, driveItemsQueryRefetchAfterSocketGap } from "@/features/drive/queries/useDriveItems.query"

type Params = Parameters<typeof driveItemsQueryKey>[0]

const driveKey = (uuid: string | null) => driveItemsQueryKey({ path: { type: "drive", uuid } } as Params)
const favoritesKey = driveItemsQueryKey({ path: { type: "favorites", uuid: null } } as Params)

// dest ─ f ─ g, dest ─ h, and "elsewhere" beside dest; all directly or indirectly under the root.
function seedTree(): void {
	for (const [uuid, parent] of [
		["dest", "root"],
		["f", "dest"],
		["g", "f"],
		["h", "dest"],
		["elsewhere", "root"]
	] as const) {
		h.fakeCache.directoryUuidToAnyNormalDir.set(uuid, { tag: "Dir", inner: [{ uuid, parent }] })
	}
}

function read(key: unknown[]): void {
	queryClient.setQueryData(key, [])
}

function invalidated(key: unknown[]): boolean | undefined {
	return queryClient.getQueryState(key)?.isInvalidated
}

// A listing a screen shows: an observer with a queryFn that counts its fetches.
function mount(key: unknown[]): { fetches: () => number; unmount: () => void } {
	let fetches = 0
	const observer = new QueryObserver(queryClient, {
		queryKey: key,
		queryFn: async () => {
			fetches++

			return []
		},
		staleTime: Infinity
	})
	const unsubscribe = observer.subscribe(() => {})

	return {
		fetches: () => fetches,
		unmount: unsubscribe
	}
}

beforeEach(() => {
	queryClient.clear()
	h.fakeCache.directoryUuidToAnyNormalDir.clear()
	h.fakeCache.rootUuid = "root"
	h.getConfig.mockReset().mockResolvedValue({ enabled: false, remoteDir: null })
	seedTree()
})

afterEach(() => {
	queryClient.clear()
})

describe("driveItemsQueryRefetchAfterSocketGap", () => {
	it("marks the destination and every listing below it stale, and nothing beside or above it", async () => {
		for (const uuid of ["dest", "f", "g", "h", "elsewhere", "root"]) {
			read(driveKey(uuid))
		}

		read(driveKey(null))
		read(favoritesKey)

		driveItemsQueryRefetchAfterSocketGap("dest")
		await vi.waitFor(() => expect(invalidated(driveKey("g"))).toBe(true))

		expect(invalidated(driveKey("dest"))).toBe(true)
		expect(invalidated(driveKey("f"))).toBe(true)
		expect(invalidated(driveKey("h"))).toBe(true)
		expect(invalidated(driveKey("elsewhere"))).toBe(false)
		expect(invalidated(driveKey("root"))).toBe(false)
		expect(invalidated(driveKey(null))).toBe(false)
		expect(invalidated(favoritesKey)).toBe(false)
	})

	it("a listing whose ancestry isn't cached is left alone", async () => {
		read(driveKey("orphan"))
		read(driveKey("dest"))

		driveItemsQueryRefetchAfterSocketGap("dest")
		await vi.waitFor(() => expect(invalidated(driveKey("dest"))).toBe(true))

		expect(invalidated(driveKey("orphan"))).toBe(false)
	})

	it("the root destination covers every drive listing", async () => {
		for (const uuid of ["dest", "g", "elsewhere", "root"]) {
			read(driveKey(uuid))
		}

		read(driveKey(null))
		read(favoritesKey)

		driveItemsQueryRefetchAfterSocketGap(null)
		await vi.waitFor(() => expect(invalidated(driveKey(null))).toBe(true))

		for (const uuid of ["dest", "g", "elsewhere", "root"]) {
			expect(invalidated(driveKey(uuid))).toBe(true)
		}

		expect(invalidated(favoritesKey)).toBe(false)
	})

	it("fetches only the mounted listings under the destination", async () => {
		const nested = mount(driveKey("g"))
		const beside = mount(driveKey("elsewhere"))

		await vi.waitFor(() => expect(nested.fetches()).toBe(1))
		await vi.waitFor(() => expect(beside.fetches()).toBe(1))

		read(driveKey("f"))

		driveItemsQueryRefetchAfterSocketGap("dest")

		await vi.waitFor(() => expect(nested.fetches()).toBe(2))

		expect(beside.fetches()).toBe(1)
		// Unmounted: marked stale for its next read, not fetched.
		expect(invalidated(driveKey("f"))).toBe(true)
		expect(queryClient.getQueryState(driveKey("f"))?.fetchStatus).toBe("idle")

		nested.unmount()
		beside.unmount()
	})
})
