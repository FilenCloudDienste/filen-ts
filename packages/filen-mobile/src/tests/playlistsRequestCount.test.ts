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

import usePlaylistsQuery, {
	playlistsQueryUpdate,
	playlistPatchedSinceNow,
	BASE_QUERY_KEY
} from "@/features/audio/queries/usePlaylists.query"
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
function savePatch(saved: typeof playlist): void {
	noteDriveContentChanged()
	playlistsQueryUpdate({
		updater: (prev => [...prev.filter(p => p.uuid !== saved.uuid), saved]) as Parameters<typeof playlistsQueryUpdate>[0]["updater"]
	})
}

// A persisted row from days ago, restored at boot.
function restoreOldRow(playlists: (typeof playlist)[]): void {
	holder.client.setQueryData([BASE_QUERY_KEY], playlists, { updatedAt: Date.now() - 24 * 60 * 60 * 1000 })
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

	it("a save during the open list's read keeps that read, whose answer with the save replaces the restored row", async () => {
		const road = { uuid: "p2", name: "Road", files: [] }
		// Another device changed Road after the row was persisted; here, Mix gets renamed.
		const roadNow = { ...road, name: "Road + c" }
		const renamed = { ...playlist, name: "Mix renamed" }
		const read = deferred<(typeof playlist)[]>()

		restoreOldRow([playlist, road])
		mockGetPlaylists.mockImplementationOnce(() => read.promise)

		const screen = renderHook(() => usePlaylistsQuery(), { wrapper })

		await waitFor(() => expect(mockGetPlaylists).toHaveBeenCalledTimes(1))

		savePatch(renamed)

		// The save shows at once, and the read stays out.
		expect(cached()).toEqual([road, renamed])
		expect(holder.client.getQueryState([BASE_QUERY_KEY])?.fetchStatus).toBe("fetching")

		// It fetched Mix before the save.
		read.resolve([playlist, roadNow])

		// The next edit of Road builds on this, so it must hold the other device's change.
		await waitFor(() => expect(screen.result.current.data).toEqual([roadNow, renamed]))

		expect(mockGetPlaylists).toHaveBeenCalledTimes(1)

		screen.unmount()
	})

	it("edits one after another while the open list reads cost no further read", async () => {
		const road = { ...playlist, uuid: "p2", name: "Road" }
		const fromElsewhere = { ...playlist, uuid: "p3", name: "From another device" }
		const read = deferred<(typeof playlist)[]>()

		restoreOldRow([playlist])
		// Every read is slow.
		mockGetPlaylists.mockImplementation(() => read.promise)

		const screen = renderHook(() => usePlaylistsQuery(), { wrapper })

		await waitFor(() => expect(mockGetPlaylists).toHaveBeenCalledTimes(1))

		// A rename, a new playlist, then another rename, each once the one before has saved.
		savePatch({ ...playlist, name: "Mix 2" })

		await tick()

		savePatch(road)

		await tick()

		savePatch({ ...playlist, name: "Mix 3" })

		await tick()

		read.resolve([playlist, fromElsewhere])

		await waitFor(() => expect(screen.result.current.data).toEqual([fromElsewhere, road, { ...playlist, name: "Mix 3" }]))

		expect(mockGetPlaylists).toHaveBeenCalledTimes(1)

		screen.unmount()
	})

	it("leaving the list mid-read keeps a save made during that read", async () => {
		const renamed = { ...playlist, name: "Mix renamed" }
		const read = deferred<(typeof playlist)[]>()

		restoreOldRow([playlist])
		mockGetPlaylists.mockImplementationOnce(() => read.promise)

		const screen = renderHook(() => usePlaylistsQuery(), { wrapper })

		await waitFor(() => expect(mockGetPlaylists).toHaveBeenCalledTimes(1))

		savePatch(renamed)

		// The last screen showing the list goes, so its read is cancelled: query-core puts the list back as
		// last patched, not as the read began.
		screen.unmount()

		// The next edit builds on this.
		expect(cached()).toEqual([renamed])

		// The cancelled read answers anyway, with the copy from before the save.
		read.resolve([playlist])

		await tick()

		expect(cached()).toEqual([renamed])
	})

	it("a read a pull-to-refresh replaced doesn't count when it answers late", async () => {
		const replaced = deferred<(typeof playlist)[]>()

		await tick()
		await mountAndSettle()
		await tick()

		// Something forces the next mount to read.
		noteDriveContentChanged()
		mockGetPlaylists.mockImplementationOnce(() => replaced.promise)

		const { result, unmount } = renderHook(() => usePlaylistsQuery(), { wrapper })

		await waitFor(() => expect(mockGetPlaylists).toHaveBeenCalledTimes(2))
		await tick()

		// The drive changes after that read began, then a pull-to-refresh's read replaces it.
		noteDriveContentChanged()

		await tick()
		await result.current.refetch()

		replaced.resolve([playlist])

		await tick()

		unmount()

		await mountAndSettle()

		expect(mockGetPlaylists).toHaveBeenCalledTimes(3)
	})

	it("a first read (nothing cached yet) lands with a save made meanwhile, and isn't reused after", async () => {
		const created = { ...playlist, uuid: "p2", name: "New" }
		const read = deferred<(typeof playlist)[]>()

		await tick()

		mockGetPlaylists.mockImplementationOnce(() => read.promise)

		const screen = renderHook(() => usePlaylistsQuery(), { wrapper })

		await waitFor(() => expect(mockGetPlaylists).toHaveBeenCalledTimes(1))

		savePatch(created)

		await tick()

		read.resolve([playlist])

		await waitFor(() => expect(screen.result.current.fetchStatus).toBe("idle"))

		expect(cached()).toEqual([playlist, created])

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

describe("playlistPatchedSinceNow", () => {
	it("tells the playlists saved or deleted after it was asked from the rest", () => {
		const road = { uuid: "p2", name: "Road", files: [] }
		const kept = { uuid: "p3", name: "Kept", files: [] }

		holder.client.setQueryData([BASE_QUERY_KEY], [playlist, road, kept])

		const patchedSince = playlistPatchedSinceNow()

		savePatch({ ...playlist, name: "Mix renamed" })
		playlistsQueryUpdate({ updater: prev => prev.filter(p => p.uuid !== road.uuid) })

		expect(patchedSince(playlist.uuid)).toBe(true)
		expect(patchedSince(road.uuid)).toBe(true)
		expect(patchedSince(kept.uuid)).toBe(false)
		expect(playlistPatchedSinceNow()(playlist.uuid)).toBe(false)
	})
})
