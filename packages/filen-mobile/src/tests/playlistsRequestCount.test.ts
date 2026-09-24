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

function deferred<T>() {
	let resolve: (value: T) => void = () => {}
	let reject: (error: unknown) => void = () => {}
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})

	return { promise, resolve, reject }
}

type Playlists = ReturnType<typeof usePlaylistsQuery>["data"]

function cached(): Playlists {
	return holder.client.getQueryData([BASE_QUERY_KEY])
}

// What savePlaylist does once its upload is done: note the drive change, then patch the list.
function savePatch(saved: typeof playlist, keepInFlightRead?: boolean): void {
	noteDriveContentChanged()
	playlistsQueryUpdate({
		updater: (prev => [...prev.filter(p => p.uuid !== saved.uuid), saved]) as Parameters<typeof playlistsQueryUpdate>[0]["updater"],
		keepInFlightRead
	})
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

	it("a read a playlist save overlapped neither overwrites the save nor is reused by the next mount", async () => {
		const withTrack = { ...playlist, name: "Mix + X" }
		const staleRead = deferred<(typeof playlist)[]>()

		await tick()
		await mountAndSettle()
		await tick()

		// Something forces the next mount (the picker) to read; the detail screen keeps observing the list.
		noteDriveContentChanged()
		mockGetPlaylists.mockImplementationOnce(() => staleRead.promise)

		const picker = renderHook(() => usePlaylistsQuery(), { wrapper })

		await waitFor(() => expect(mockGetPlaylists).toHaveBeenCalledTimes(2))
		await tick()

		// The user adds the track while that read is still out; the read then answers with the old copy.
		savePatch(withTrack)
		staleRead.resolve([playlist])

		await waitFor(() => expect(picker.result.current.fetchStatus).toBe("idle"))

		expect(cached()).toEqual([withTrack])

		picker.unmount()

		await tick()
		await mountAndSettle()

		expect(mockGetPlaylists).toHaveBeenCalledTimes(3)
	})

	it("the dead-track prune's patch during its own read keeps that read", async () => {
		const pruned = { ...playlist, name: "Mix (pruned)" }
		const read = deferred<(typeof playlist)[]>()

		await tick()
		await mountAndSettle()
		await tick()

		noteDriveContentChanged()
		mockGetPlaylists.mockImplementationOnce(() => read.promise)

		const screen = renderHook(() => usePlaylistsQuery(), { wrapper })

		await waitFor(() => expect(mockGetPlaylists).toHaveBeenCalledTimes(2))

		// The read also brings a playlist made on another device; cancelling it would lose that.
		const fromElsewhere = { uuid: "p3", name: "From another device", files: [] }

		savePatch(pruned, true)
		read.resolve([pruned, fromElsewhere])

		await waitFor(() => expect(screen.result.current.fetchStatus).toBe("idle"))

		expect(cached()).toEqual([pruned, fromElsewhere])
		expect(screen.result.current.isError).toBe(false)

		screen.unmount()
	})

	it("a first read (nothing cached yet) is not cancelled by a save landing meanwhile, nor reused after", async () => {
		const read = deferred<(typeof playlist)[]>()

		await tick()

		mockGetPlaylists.mockImplementationOnce(() => read.promise)

		const screen = renderHook(() => usePlaylistsQuery(), { wrapper })

		await waitFor(() => expect(mockGetPlaylists).toHaveBeenCalledTimes(1))

		savePatch({ ...playlist, uuid: "p2", name: "New" })

		await tick()

		read.resolve([playlist])

		await waitFor(() => expect(screen.result.current.fetchStatus).toBe("idle"))

		expect(cached()).toEqual([playlist])

		screen.unmount()

		await tick()
		await mountAndSettle()

		expect(mockGetPlaylists).toHaveBeenCalledTimes(2)
	})

	it("a drive change while a read is out (a track deleted meanwhile) makes the next mount read", async () => {
		const read = deferred<(typeof playlist)[]>()

		await tick()

		mockGetPlaylists.mockImplementationOnce(() => read.promise)

		const screen = renderHook(() => usePlaylistsQuery(), { wrapper })

		await waitFor(() => expect(mockGetPlaylists).toHaveBeenCalledTimes(1))
		await tick()

		noteDriveContentChanged()

		await tick()

		read.resolve([playlist])

		await waitFor(() => expect(screen.result.current.fetchStatus).toBe("idle"))

		screen.unmount()

		await mountAndSettle()

		expect(mockGetPlaylists).toHaveBeenCalledTimes(2)
	})

	it("a failed read after a reusable one makes the next mount read", async () => {
		await tick()

		const { result, unmount } = renderHook(() => usePlaylistsQuery(), { wrapper })

		await waitFor(() => expect(result.current.data).toBeDefined())

		mockGetPlaylists.mockRejectedValueOnce(new Error("offline"))

		await result.current.refetch()

		unmount()

		await mountAndSettle()

		expect(mockGetPlaylists).toHaveBeenCalledTimes(3)
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
