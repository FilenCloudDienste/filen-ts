// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, cleanup, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const { mockGetDirSize, holder } = vi.hoisted(() => ({
	mockGetDirSize: vi.fn(),
	holder: { client: null as unknown as import("@tanstack/react-query").QueryClient }
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/shared", async () => {
	const real = await import("@/tests/mocks/filenShared")
	const { sortParams } = await import("@filen/shared")

	return {
		...real,
		sortParams
	}
})

// The production defaults that matter here: every mount refetches unless a query overrides it.
vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {
		refetchOnMount: "always",
		staleTime: 0,
		retry: false
	},
	get queryClient() {
		return holder.client
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		directoryUuidToAnyNormalDir: new Map(),
		directoryUuidToAnySharedDirWithContext: new Map(),
		directoryUuidToAnyLinkedDirWithMeta: new Map(),
		uuidToAnyDriveItem: new Map()
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: async () => ({
			authedSdkClient: {
				getDirSize: mockGetDirSize
			}
		})
	}
}))

// Parents in these tests are plain uuid strings.
vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapParentUuid: (parent: unknown) => (typeof parent === "string" ? parent : null)
}))

vi.mock("@/features/offline/offline", () => ({
	default: {
		itemSize: vi.fn()
	}
}))

vi.mock("@/features/drive/driveSelectors", () => ({
	isDirectoryItem: (item: { type?: string }) =>
		item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"
}))

vi.mock("@filen/sdk-rs", () => {
	class Wrapper {
		public inner: unknown[]

		public constructor(v: unknown) {
			this.inner = [v]
		}
	}

	return {
		AnyDirWithContext_Tags: { Normal: "Normal", Shared: "Shared", Linked: "Linked" },
		AnyNormalDir_Tags: { Dir: "Dir", Root: "Root" },
		AnyDirWithContext: {
			Normal: class extends Wrapper {
				tag = "Normal"
			},
			Shared: class extends Wrapper {
				tag = "Shared"
			},
			Linked: class extends Wrapper {
				tag = "Linked"
			}
		},
		AnyNormalDir: {
			Dir: class extends Wrapper {
				tag = "Dir"
			}
		},
		AnySharedDir: {
			Dir: class extends Wrapper {
				tag = "Dir"
			},
			Root: class extends Wrapper {
				tag = "Root"
			}
		},
		AnySharedDirWithContext: { new: (v: unknown) => v },
		ParentUuid: {
			Trash: class {
				tag = "Trash"
			}
		},
		AnyLinkedDirWithContext: { new: (v: unknown) => v }
	}
})

import useDirectorySizeQuery, {
	markDirectorySizesStale,
	refetchMountedDirectorySizes,
	directorySizeQueryOptions,
	type UseDirectorySizeQueryParams
} from "@/features/drive/queries/useDirectorySize.query"
import useSocketStore from "@/stores/useSocket.store"
import { trackServerReads } from "@/queries/socketSession"
import type { DriveItem } from "@/types"
import cache from "@/lib/cache"

const dirItem = { type: "directory", data: { uuid: "dir-1" } } as unknown as DriveItem
const sharedItem = { type: "sharedRootDirectory", data: { uuid: "dir-1", sharingRole: {} } } as unknown as DriveItem

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: holder.client }, children)
}

async function mountAndSettle(params: UseDirectorySizeQueryParams): Promise<void> {
	const { result, unmount } = renderHook(() => useDirectorySizeQuery(params), { wrapper })

	await waitFor(() => expect(result.current.fetchStatus).toBe("idle"))
	await waitFor(() => expect(result.current.data).toBeDefined())

	unmount()
}

const normal: UseDirectorySizeQueryParams = { uuid: "dir-1", type: "normal", item: dirItem }

beforeEach(() => {
	holder.client = new QueryClient()
	trackServerReads(holder.client.getQueryCache())
	mockGetDirSize.mockReset()
	mockGetDirSize.mockResolvedValue({ size: 10n, files: 1n, dirs: 0n })
	useSocketStore.setState({ state: "disconnected", connectedAt: 0 })
	useSocketStore.getState().setState("connected")
})

afterEach(() => {
	cleanup()
	holder.client.clear()
})

describe("useDirectorySizeQuery — request count", () => {
	it("a remount (or the info sheet) within the staleTime issues no second getDirSize", async () => {
		await mountAndSettle(normal)
		await mountAndSettle(normal)
		await mountAndSettle(normal)

		expect(mockGetDirSize).toHaveBeenCalledTimes(1)
	})

	it("refetches once after markDirectorySizesStale", async () => {
		await mountAndSettle(normal)

		markDirectorySizesStale()

		await mountAndSettle(normal)
		await mountAndSettle(normal)

		expect(mockGetDirSize).toHaveBeenCalledTimes(2)
	})

	it("markDirectorySizesStale never fetches for a mounted row", async () => {
		const { result } = renderHook(() => useDirectorySizeQuery(normal), { wrapper })

		await waitFor(() => expect(result.current.data).toBeDefined())

		markDirectorySizesStale()

		await new Promise(resolve => setTimeout(resolve, 10))

		expect(mockGetDirSize).toHaveBeenCalledTimes(1)
	})

	it("a persisted row from an earlier session refetches on its first mount", async () => {
		// Restored rows keep their original timestamp, which predates this connection.
		holder.client.setQueryData(
			directorySizeQueryOptions(normal).queryKey,
			{ size: 1, files: 1, dirs: 0 },
			{ updatedAt: Date.now() - 1000 }
		)
		useSocketStore.setState({ connectedAt: Date.now() })

		await mountAndSettle(normal)
		await mountAndSettle(normal)

		expect(mockGetDirSize).toHaveBeenCalledTimes(1)
	})

	it("a value older than the staleTime refetches", async () => {
		useSocketStore.setState({ connectedAt: 0 })
		holder.client.setQueryData(
			directorySizeQueryOptions(normal).queryKey,
			{ size: 1, files: 1, dirs: 0 },
			{ updatedAt: Date.now() - 16 * 60 * 1000 }
		)

		await mountAndSettle(normal)

		expect(mockGetDirSize).toHaveBeenCalledTimes(1)
	})

	it("refetches on every mount while the socket is down", async () => {
		await mountAndSettle(normal)

		useSocketStore.getState().setState("reconnecting")

		await mountAndSettle(normal)
		await mountAndSettle(normal)

		expect(mockGetDirSize).toHaveBeenCalledTimes(3)
	})

	it("after a reconnect, a value fetched before it refetches once", async () => {
		await mountAndSettle(normal)

		useSocketStore.getState().setState("disconnected")
		await new Promise(resolve => setTimeout(resolve, 2))
		useSocketStore.getState().setState("connected")

		await mountAndSettle(normal)
		await mountAndSettle(normal)

		expect(mockGetDirSize).toHaveBeenCalledTimes(2)
	})

	it("shared-in sizes keep refetching on every mount (no socket covers them)", async () => {
		const sharedIn: UseDirectorySizeQueryParams = { uuid: "dir-1", type: "sharedIn", item: sharedItem }

		await mountAndSettle(sharedIn)
		await mountAndSettle(sharedIn)

		expect(mockGetDirSize).toHaveBeenCalledTimes(2)
	})
})

describe("useSocketStore — connectedAt", () => {
	it("stamps only the transition into connected", () => {
		useSocketStore.setState({ state: "disconnected", connectedAt: 0 })

		useSocketStore.getState().setState("connected")

		const first = useSocketStore.getState().connectedAt

		expect(first).toBeGreaterThan(0)

		useSocketStore.getState().setState("connected")

		expect(useSocketStore.getState().connectedAt).toBe(first)

		useSocketStore.getState().setState("reconnecting")

		expect(useSocketStore.getState().connectedAt).toBe(first)
	})
})

describe("markDirectorySizesStale — drive-derived caches", () => {
	it("records the drive change the playlists (and other drive-derived reads) compare against", async () => {
		const { driveContentChangedSince } = await import("@/lib/driveChanges")
		const before = Date.now() + 1

		expect(driveContentChangedSince(before)).toBe(false)

		await new Promise(resolve => setTimeout(resolve, 2))

		markDirectorySizesStale()

		expect(driveContentChangedSince(before)).toBe(true)
	})
})

describe("refetchMountedDirectorySizes — once a copy or directory upload settles", () => {
	function params(uuid: string): UseDirectorySizeQueryParams {
		return { uuid, type: "normal", item: { type: "directory", data: { uuid } } as unknown as DriveItem }
	}

	function sizedUuids(): string[] {
		return mockGetDirSize.mock.calls.map(call => (call[0] as { inner: [{ inner: [{ uuid: string }] }] }).inner[0].inner[0].uuid)
	}

	beforeEach(() => {
		const dirs = cache.directoryUuidToAnyNormalDir as unknown as Map<string, unknown>

		dirs.clear()
		dirs.set("dest", { tag: "Dir", inner: [{ uuid: "dest", parent: "grandparent" }] })
		dirs.set("grandparent", { tag: "Dir", inner: [{ uuid: "grandparent", parent: "root" }] })
		dirs.set("root", { tag: "Root", inner: [{ uuid: "root" }] })
	})

	it("reads again only the mounted sizes it changed: what it made and every directory above its destination", async () => {
		const mounted = ["made", "dest", "grandparent", "sibling"].map(uuid =>
			renderHook(() => useDirectorySizeQuery(params(uuid)), { wrapper })
		)

		for (const { result } of mounted) {
			await waitFor(() => expect(result.current.data).toBeDefined())
		}

		// An affected size that nothing shows stays for its next mount.
		await mountAndSettle(params("root"))

		mockGetDirSize.mockClear()
		markDirectorySizesStale()

		refetchMountedDirectorySizes({ destinationUuid: "dest", createdDirUuids: ["made"] })

		await waitFor(() => expect(mockGetDirSize).toHaveBeenCalledTimes(3))
		await new Promise(resolve => setTimeout(resolve, 10))

		expect(sizedUuids().sort()).toEqual(["dest", "grandparent", "made"])
	})

	it("nothing mounted, nothing read", async () => {
		await mountAndSettle(params("dest"))

		mockGetDirSize.mockClear()

		refetchMountedDirectorySizes({ destinationUuid: "dest", createdDirUuids: ["made"] })

		await new Promise(resolve => setTimeout(resolve, 10))

		expect(mockGetDirSize).not.toHaveBeenCalled()
	})
})
