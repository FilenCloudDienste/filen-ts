// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query"
import type { Dir, File as SdkFile, SocketEvent, UuidStr } from "@filen/sdk-rs"

const { createDirectory, listDirectory, downloadFileBytes, uploadFileBytes, subscribeToSocket, socket } = vi.hoisted(() => {
	// The bridge subscribes once per module life, so the callback it hands over is kept here.
	const socket: { emit: (event: SocketEvent) => void } = { emit: () => undefined }

	return {
		createDirectory: vi.fn(),
		listDirectory: vi.fn(),
		downloadFileBytes: vi.fn(),
		uploadFileBytes: vi.fn(),
		subscribeToSocket: vi.fn((callback: (event: SocketEvent) => void) => {
			socket.emit = callback

			return Promise.resolve()
		}),
		socket
	}
})

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { createDirectory, listDirectory, downloadFileBytes, uploadFileBytes, subscribeToSocket } }))

// The production defaults minus the persister (sqlite, unavailable under vitest). The same instance
// backs the provider below AND the write path's cache patches.
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({
		defaultOptions: {
			queries: { staleTime: 0, gcTime: Infinity, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true }
		}
	})
}))

import { queryClient } from "@/queries/client"
import { markPlaylistsUnsynced, PLAYLISTS_QUERY_KEY, PLAYLISTS_STALE_TIME, usePlaylistsQuery } from "@/features/audio/queries/playlists"
import { createPlaylist } from "@/features/audio/lib/playlists"
import { handlePlaylistsDriveEvent, registerPlaylistSocketHandlers } from "@/features/audio/lib/socketHandlers"
import { socketBridge } from "@/lib/sdk/socket"

type DriveEvent = Extract<SocketEvent, { type: "drive" }>["inner"]

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const DOT_FILEN_UUID = testUuid("dotfilen")
const PLAYLISTS_DIR_UUID = testUuid("playlistsdir")
const FIRST_PLAYLIST_FILE_UUID = testUuid("pl1")
const PLAYLIST_FILE_UUIDS = [FIRST_PLAYLIST_FILE_UUID, testUuid("pl2"), testUuid("pl3")]

function fakeDir(uuid: UuidStr): Dir {
	return { uuid, meta: { type: "decoded", data: { name: uuid } }, timestamp: 0n, color: "default" } as Dir
}

function fakeJsonFile(uuid: UuidStr, parent: UuidStr = PLAYLISTS_DIR_UUID): SdkFile {
	return {
		uuid,
		stableUUID: undefined,
		meta: { type: "decoded", data: { name: `${uuid}.json`, mime: "application/json", modified: 0n, size: 0n, key: "k", version: 2 } },
		parent,
		size: 0n,
		favorited: false,
		region: "r",
		bucket: "b",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false
	}
}

// Empty track lists keep the once-per-session dead-track check out of the counts.
function playlistBytes(file: SdkFile): Uint8Array {
	return new TextEncoder().encode(JSON.stringify({ uuid: `playlist-${file.uuid}`, name: file.uuid, created: 1, updated: 1, files: [] }))
}

function driveEvent(inner: DriveEvent): Extract<SocketEvent, { type: "drive" }> {
	return { type: "drive", inner, driveMessageId: 0n }
}

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient, children })
}

function counts() {
	return { list: listDirectory.mock.calls.length, download: downloadFileBytes.mock.calls.length }
}

// useQuery returns a tracked proxy, so the fetch count is read off the client rather than the result.
async function settle(): Promise<void> {
	await waitFor(() => {
		expect(queryClient.isFetching()).toBe(0)
	})
}

async function mountLoaded() {
	const view = renderHook(() => usePlaylistsQuery(), { wrapper })

	await waitFor(() => {
		expect(view.result.current.isSuccess).toBe(true)
	})
	await settle()

	return view
}

async function focus(): Promise<void> {
	act(() => {
		focusManager.setFocused(false)
		focusManager.setFocused(true)
	})
	await settle()
}

async function reconnect(): Promise<void> {
	act(() => {
		onlineManager.setOnline(false)
		onlineManager.setOnline(true)
	})
	await settle()
}

beforeEach(() => {
	queryClient.clear()
	vi.clearAllMocks()

	createDirectory.mockImplementation((parentUuid: string | null, name: string) =>
		Promise.resolve(fakeDir(name === "Playlists" && parentUuid === DOT_FILEN_UUID ? PLAYLISTS_DIR_UUID : DOT_FILEN_UUID))
	)
	listDirectory.mockImplementation(() => Promise.resolve({ dirs: [], files: PLAYLIST_FILE_UUIDS.map(uuid => fakeJsonFile(uuid)) }))
	downloadFileBytes.mockImplementation((file: SdkFile) => Promise.resolve(playlistBytes(file)))
	uploadFileBytes.mockImplementation(() => Promise.resolve(fakeJsonFile(testUuid("ownsave"))))

	// The sync markers are module state that outlives a test; a signal starts each one unsynced, as a
	// page load does.
	markPlaylistsUnsynced()
})

afterEach(() => {
	focusManager.setFocused(undefined)
	onlineManager.setOnline(true)
	vi.useRealTimers()
})

describe("usePlaylistsQuery request counts", () => {
	it("reads the directory once and each playlist once on first mount", async () => {
		await mountLoaded()

		expect(counts()).toEqual({ list: 1, download: 3 })
	})

	it("serves a remount, a window focus and a reconnect from the synced cache", async () => {
		const first = await mountLoaded()

		first.unmount()
		await mountLoaded()
		await focus()
		await reconnect()

		expect(counts()).toEqual({ list: 1, download: 3 })
	})

	it("reads again on focus once the stale window has passed", async () => {
		vi.useFakeTimers({ toFake: ["Date"] })
		await mountLoaded()

		vi.setSystemTime(Date.now() + PLAYLISTS_STALE_TIME + 1)
		await focus()

		expect(counts()).toEqual({ list: 2, download: 6 })
	})

	it("still reads once per page load when the cache was restored from disk", async () => {
		queryClient.setQueryData(PLAYLISTS_QUERY_KEY, [])

		await mountLoaded()
		await focus()

		expect(counts()).toEqual({ list: 1, download: 3 })
	})

	it("keeps retrying a playlist whose download failed, as before", async () => {
		downloadFileBytes.mockImplementationOnce(() => Promise.reject(new Error("network blip")))

		await mountLoaded()
		await focus()

		expect(counts()).toEqual({ list: 2, download: 6 })
	})

	it("a playlist created elsewhere is read on the next focus, not while the list is open", async () => {
		await mountLoaded()

		act(() => {
			handlePlaylistsDriveEvent(driveEvent({ type: "fileNew", file: fakeJsonFile(testUuid("remote")) }))
		})
		await settle()

		expect(counts()).toEqual({ list: 1, download: 3 })

		await focus()

		expect(counts()).toEqual({ list: 2, download: 6 })
	})

	it.each<{ name: string; inner: DriveEvent }>([
		{
			name: "trashed",
			inner: { type: "fileTrash", uuid: FIRST_PLAYLIST_FILE_UUID, stableUUID: testUuid("stable"), newUUID: undefined }
		},
		{ name: "deleted", inner: { type: "fileDeletedPermanent", uuid: FIRST_PLAYLIST_FILE_UUID, stableUUID: testUuid("stable") } },
		{ name: "moved out", inner: { type: "fileMove", file: fakeJsonFile(FIRST_PLAYLIST_FILE_UUID, testUuid("elsewhere")) } },
		{ name: "moved in", inner: { type: "fileMove", file: fakeJsonFile(testUuid("incoming")) } },
		{ name: "restored", inner: { type: "fileRestore", file: fakeJsonFile(testUuid("restored")) } }
	])("a playlist file $name elsewhere is read on the next focus", async ({ inner }) => {
		await mountLoaded()

		handlePlaylistsDriveEvent(driveEvent(inner))
		await focus()

		expect(counts()).toEqual({ list: 2, download: 6 })
	})

	it.each<{ name: string; inner: DriveEvent }>([
		{
			name: "a file created in another directory",
			inner: { type: "fileNew", file: fakeJsonFile(testUuid("other"), testUuid("elsewhere")) }
		},
		{
			name: "an old version of a playlist file deleted",
			inner: { type: "fileDeletedPermanent", uuid: FIRST_PLAYLIST_FILE_UUID, stableUUID: undefined }
		},
		{
			name: "an edit retiring a playlist file's old version",
			inner: { type: "fileTrash", uuid: FIRST_PLAYLIST_FILE_UUID, stableUUID: testUuid("stable"), newUUID: testUuid("successor") }
		},
		{
			name: "an unrelated file trashed",
			inner: { type: "fileTrash", uuid: testUuid("unrelated"), stableUUID: testUuid("stable"), newUUID: undefined }
		}
	])("ignores $name", async ({ inner }) => {
		await mountLoaded()

		handlePlaylistsDriveEvent(driveEvent(inner))
		await focus()

		expect(counts()).toEqual({ list: 1, download: 3 })
	})

	it("a save landing mid-read leaves the cache unsynced, so the next focus reads again", async () => {
		let releaseListing: () => void = () => undefined

		listDirectory.mockImplementationOnce(
			() =>
				new Promise(resolve => {
					releaseListing = () => {
						resolve({ dirs: [], files: PLAYLIST_FILE_UUIDS.map(uuid => fakeJsonFile(uuid)) })
					}
				})
		)

		renderHook(() => usePlaylistsQuery(), { wrapper })
		await waitFor(() => {
			expect(listDirectory).toHaveBeenCalledTimes(1)
		})

		await act(async () => {
			await createPlaylist("Road trip")
		})
		releaseListing()
		await settle()
		await focus()

		expect(counts()).toEqual({ list: 2, download: 6 })
	})

	// Through the real bridge, so the registration's categories are what is under test.
	it.each<SocketEvent>([
		{ type: "reconnecting" },
		{ type: "authSuccess" },
		{ type: "driveMalformed", driveMessageId: 0n },
		driveEvent({ type: "fileNew", file: fakeJsonFile(testUuid("remote")) })
	])("a socket $type reaching the registered handlers is read on the next focus", async event => {
		const unregister = registerPlaylistSocketHandlers()

		await socketBridge.start()
		await mountLoaded()

		socket.emit(event)
		await focus()
		unregister()

		expect(counts()).toEqual({ list: 2, download: 6 })
	})

	it("ignores this tab's own save echoing back", async () => {
		await mountLoaded()

		await act(async () => {
			await createPlaylist("Road trip")
		})
		handlePlaylistsDriveEvent(driveEvent({ type: "fileNew", file: fakeJsonFile(testUuid("ownsave")) }))
		await focus()

		expect(uploadFileBytes).toHaveBeenCalledTimes(1)
		expect(counts()).toEqual({ list: 1, download: 3 })
	})
})
