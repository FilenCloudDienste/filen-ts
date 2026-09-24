// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, cleanup, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const { mockGetPlaylists, holder } = vi.hoisted(() => ({
	mockGetPlaylists: vi.fn(),
	holder: { client: null as unknown as import("@tanstack/react-query").QueryClient }
}))

// The production defaults that matter here, and queryUpdater.set's restamp-unless-given contract.
vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {
		refetchOnMount: "always",
		staleTime: 0,
		retry: false
	},
	get queryClient() {
		return holder.client
	},
	queryUpdater: {
		get: (queryKey: unknown[]) => holder.client.getQueryData(queryKey),
		set: (queryKey: unknown[], updater: (prev: unknown) => unknown, dataUpdatedAt?: number) => {
			holder.client.setQueryData(queryKey, updater, {
				updatedAt: typeof dataUpdatedAt === "number" ? dataUpdatedAt : Date.now()
			})
		}
	}
}))

// getPlaylists stands for the whole read: 3 listDirs, a download per playlist, a check per track.
vi.mock("@/features/audio/audio", () => ({
	default: {
		getPlaylists: mockGetPlaylists
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		uuidToAnyDriveItem: new Map()
	}
}))

import usePlaylistsQuery, { playlistsQueryUpdate, BASE_QUERY_KEY } from "@/features/audio/queries/usePlaylists.query"
import { noteDriveContentChanged } from "@/lib/driveChanges"

const playlist = { uuid: "p1", name: "Mix", files: [] }

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: holder.client }, children)
}

// The Playlists tab and the "Add to playlist" picker mount the same screen, i.e. this hook.
async function mountAndSettle(): Promise<ReturnType<typeof usePlaylistsQuery>> {
	const { result, unmount } = renderHook(() => usePlaylistsQuery(), { wrapper })

	await waitFor(() => expect(result.current.fetchStatus).toBe("idle"))
	await waitFor(() => expect(result.current.data).toBeDefined())

	const current = result.current

	unmount()

	return current
}

async function tick(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 2))
}

beforeEach(() => {
	holder.client = new QueryClient()
	mockGetPlaylists.mockReset()
	mockGetPlaylists.mockResolvedValue([playlist])
})

afterEach(() => {
	cleanup()
	holder.client.clear()
})

describe("usePlaylistsQuery — request count", () => {
	it("the tab then the Add-to-playlist picker within a minute read the playlists once", async () => {
		await tick()
		await mountAndSettle()
		await mountAndSettle()

		expect(mockGetPlaylists).toHaveBeenCalledTimes(1)
	})

	it("a persisted list older than a minute reads on its first mount", async () => {
		holder.client.setQueryData([BASE_QUERY_KEY], [playlist], { updatedAt: Date.now() - 61 * 1000 })

		await mountAndSettle()
		await mountAndSettle()

		expect(mockGetPlaylists).toHaveBeenCalledTimes(1)
	})

	it("a drive change after the read (a track may be gone) makes the next mount read", async () => {
		await tick()
		await mountAndSettle()
		await tick()

		noteDriveContentChanged()

		await mountAndSettle()

		expect(mockGetPlaylists).toHaveBeenCalledTimes(2)
	})

	it("pull-to-refresh always reads", async () => {
		await tick()

		const { result, unmount } = renderHook(() => usePlaylistsQuery(), { wrapper })

		await waitFor(() => expect(result.current.data).toBeDefined())
		await result.current.refetch()

		expect(mockGetPlaylists).toHaveBeenCalledTimes(2)

		unmount()
	})
})

describe("playlistsQueryUpdate", () => {
	it("keeps the last read's time, so a local edit doesn't make the rest look fresh", async () => {
		const readAt = Date.now() - 30 * 1000

		holder.client.setQueryData([BASE_QUERY_KEY], [playlist], { updatedAt: readAt })

		playlistsQueryUpdate({ updater: prev => [...prev, { uuid: "p2", name: "New", files: [] } as never] })

		const state = holder.client.getQueryState<unknown[]>([BASE_QUERY_KEY])

		expect(state?.data).toHaveLength(2)
		expect(state?.dataUpdatedAt).toBe(readAt)
	})

	it("an edit before any read leaves the list stale, so the first mount still reads", async () => {
		playlistsQueryUpdate({ updater: prev => [...prev, playlist as never] })

		expect(holder.client.getQueryState([BASE_QUERY_KEY])?.dataUpdatedAt).toBe(0)

		await mountAndSettle()

		expect(mockGetPlaylists).toHaveBeenCalledTimes(1)
	})
})
