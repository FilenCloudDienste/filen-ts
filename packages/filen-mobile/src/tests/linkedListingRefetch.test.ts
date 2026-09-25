// A linked subdirectory lists from the link context its parent's read caches. Opened before that read lands, its own
// read fails, and its compiled header builds Save to Cloud Drive again only when the listing's fetch status changes.
// Against a real QueryClient and the real fetchData.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { type TFunction } from "i18next"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const h = vi.hoisted(() => {
	const directoryUuidToAnyLinkedDirWithMeta = new Map<string, { dir: { uuid: string }; meta: unknown }>()
	const uuidToAnyDriveItem = new Map<string, unknown>()

	return {
		fakeCache: {
			rootUuid: "root" as string | null,
			directoryUuidToAnyNormalDir: new Map<string, unknown>(),
			directoryUuidToAnyLinkedDirWithMeta,
			uuidToAnyDriveItem,
			linkedRootByLinkUuid: new Map<string, unknown>(),
			cacheNewLinkedDir: (_dir: unknown, driveItem: { data: { uuid: string } }, meta: unknown) => {
				uuidToAnyDriveItem.set(driveItem.data.uuid, driveItem)

				if (meta) {
					directoryUuidToAnyLinkedDirWithMeta.set(driveItem.data.uuid, { dir: { uuid: driveItem.data.uuid }, meta })
				}
			},
			cacheDriveItemReference: (driveItem: { data: { uuid: string } }) => {
				uuidToAnyDriveItem.set(driveItem.data.uuid, driveItem)
			}
		},
		// s ─ t: listing a directory returns its one subdirectory and one file.
		listLinkedDir: vi.fn(async (dir: { uuid: string }) => ({
			dirs: dir.uuid === "s" ? [{ inner: { uuid: "t" } }] : [],
			files: [{ uuid: `${dir.uuid}-file` }]
		}))
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("expo-router", () => ({ useLocalSearchParams: vi.fn(), useNavigation: vi.fn() }))
vi.mock("@filen/sdk-rs", () => {
	const variant = (tag: string) =>
		class {
			public readonly tag = tag
			public readonly inner: unknown[]

			public constructor(value: unknown) {
				this.inner = [value]
			}
		}

	return {
		AnyNormalDir_Tags: { Dir: "Dir", Root: "Root" },
		AnyNormalDir: {},
		AnyDirWithContext: { Linked: variant("AnyDirWithContext.Linked") },
		AnySharedDir: {},
		AnySharedDirWithContext: {},
		AnyFile: {},
		CopyItem: { Dir: variant("CopyItem.Dir") },
		NonRootDir_Tags: {},
		SharingRole: {},
		ErrorKind: {}
	}
})
vi.mock("@/lib/auth", () => ({ default: { getSdkClients: async () => ({ authedSdkClient: { listLinkedDir: h.listLinkedDir } }) } }))
vi.mock("@/lib/cache", () => ({ default: h.fakeCache }))
vi.mock("@/lib/alerts", () => ({ default: { error: vi.fn() } }))
vi.mock("@/lib/decryption", () => ({ driveItemDisplayName: (item: { data: { uuid: string } }) => `name-${item.data.uuid}` }))
vi.mock("@/features/drive/driveSelectSession", () => ({ selectCopyDestination: vi.fn() }))
vi.mock("@/features/copy/copyRunner", () => ({ default: { startCopyItems: vi.fn() } }))
vi.mock("@/features/cameraUpload/cameraUpload", () => ({ default: { getConfig: vi.fn() } }))
vi.mock("@/features/cameraUpload/remoteListing", () => ({ listCameraUploadRemote: vi.fn(), remoteWalkDropsEntries: vi.fn() }))
vi.mock("@/features/offline/offline", () => ({ default: {} }))
vi.mock("@/features/drive/utils", () => ({ linkPasswordState: (_entered: unknown, current: unknown) => current, linkedRootOf: vi.fn() }))
vi.mock("@/lib/sdkErrors", () => ({ unwrapSdkError: vi.fn() }))
vi.mock("@/hooks/useDrivePath", () => ({
	DRIVE_PATH_TYPES: ["drive", "sharedIn", "recents", "favorites", "trash", "sharedOut", "offline", "links", "photos", "linked"]
}))
vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapParentUuid: vi.fn(),
	unwrapDirMeta: (dir: unknown) => dir,
	unwrapFileMeta: (file: unknown) => file,
	unwrappedDirIntoDriveItem: (dir: { uuid: string }) => ({ type: "directory", data: { uuid: dir.uuid } }),
	unwrappedFileIntoDriveItem: (file: { uuid: string }) => ({ type: "file", data: { uuid: file.uuid } })
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
import { driveItemsQueryKey, fetchData } from "@/features/drive/queries/useDriveItems.query"
import { buildSaveLinkedDirectoryButton } from "@/features/drive/linkedSave"
import events from "@/lib/events"
import type { DrivePath } from "@/hooks/useDrivePath"

const LINKED = { uuid: "link", key: "key", rootName: "Holidays" }
const PARENT_PATH: DrivePath = { type: "linked", uuid: "s", linked: LINKED }
const CHILD_PATH: DrivePath = { type: "linked", uuid: "t", linked: LINKED }
const t = ((key: string) => key) as unknown as TFunction

// The child's screen: its listing restored from an earlier visit, then mounted. Each fetch notes whether the link
// context was cached when it started. Each fetch status change builds Save to Cloud Drive again, as the compiled header
// does, and notes whether it was offered.
function mountChild(): { contextAtFetch: boolean[]; saveOffered: boolean[]; unmount: () => void } {
	const contextAtFetch: boolean[] = []
	const saveOffered: boolean[] = []
	let lastFetchStatus: string | null = null

	queryClient.setQueryData(driveItemsQueryKey({ path: CHILD_PATH }), [{ type: "file", data: { uuid: "restored" } }])

	const observer = new QueryObserver(queryClient, {
		queryKey: driveItemsQueryKey({ path: CHILD_PATH }),
		queryFn: ({ signal }) => {
			contextAtFetch.push(h.fakeCache.directoryUuidToAnyLinkedDirWithMeta.has("t"))

			return fetchData({ path: CHILD_PATH, signal })
		}
	})
	const unsubscribe = observer.subscribe(result => {
		if (result.fetchStatus === lastFetchStatus) {
			return
		}

		lastFetchStatus = result.fetchStatus

		saveOffered.push(buildSaveLinkedDirectoryButton({ drivePath: CHILD_PATH, listingFetchStatus: result.fetchStatus, t }) !== null)
	})

	return {
		contextAtFetch,
		saveOffered,
		unmount: unsubscribe
	}
}

function childState() {
	return queryClient.getQueryState(driveItemsQueryKey({ path: CHILD_PATH }))
}

beforeEach(() => {
	queryClient.clear()
	h.fakeCache.directoryUuidToAnyLinkedDirWithMeta.clear()
	h.fakeCache.uuidToAnyDriveItem.clear()
	h.listLinkedDir.mockClear()
	// The parent's own context, as opening the link cached it for the root's subdirectories.
	h.fakeCache.directoryUuidToAnyLinkedDirWithMeta.set("s", { dir: { uuid: "s" }, meta: { password: "none" } })
})

afterEach(() => {
	queryClient.clear()
})

describe("a linked subdirectory opened before its parent's read cached it", () => {
	it("reads again once that read lands and then offers Save to Cloud Drive, with no retry from the user", async () => {
		const child = mountChild()

		await vi.waitFor(() => expect(childState()?.status).toBe("error"))

		expect(childState()?.fetchStatus).toBe("idle")
		// Stale-while-error: the restored rows stay, so the screen shows no Try again.
		expect(childState()?.data).toEqual([{ type: "file", data: { uuid: "restored" } }])
		expect(child.saveOffered).toEqual([false, false])

		await fetchData({ path: PARENT_PATH })
		await vi.waitFor(() => expect(childState()?.status).toBe("success"))

		expect(child.contextAtFetch).toEqual([false, true])
		expect(child.saveOffered).toEqual([false, false, true, true])
		expect(childState()?.data).toEqual([{ type: "file", data: { uuid: "t-file" } }])

		child.unmount()
	})

	it("a subdirectory that listed fine is not read again by its parent's read", async () => {
		h.fakeCache.directoryUuidToAnyLinkedDirWithMeta.set("t", { dir: { uuid: "t" }, meta: { password: "none" } })

		const child = mountChild()

		await vi.waitFor(() => expect(childState()?.status).toBe("success"))

		await fetchData({ path: PARENT_PATH })

		expect(child.contextAtFetch).toEqual([true])
		expect(h.listLinkedDir).toHaveBeenCalledTimes(2)

		child.unmount()
	})

	it("forgets the failed listings at logout", async () => {
		const child = mountChild()

		await vi.waitFor(() => expect(childState()?.status).toBe("error"))

		events.emit("logout")
		await fetchData({ path: PARENT_PATH })
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(child.contextAtFetch).toEqual([false])
		expect(childState()?.status).toBe("error")

		child.unmount()
	})
})
