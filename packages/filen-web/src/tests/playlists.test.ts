import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File as SdkFile, UuidStr } from "@filen/sdk-rs"

// UuidStr is a template-literal brand — pad a short label the same way drive.test.ts's testUuid does.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const DOT_FILEN_UUID = testUuid("dotfilen")
const PLAYLISTS_DIR_UUID = testUuid("playlistsdir")

const { createDirectory, listDirectory, downloadFileBytes, uploadFileBytes, getFile, deleteFilePermanently } = vi.hoisted(() => ({
	createDirectory: vi.fn(),
	listDirectory: vi.fn(),
	downloadFileBytes: vi.fn(),
	uploadFileBytes: vi.fn(),
	getFile: vi.fn(),
	deleteFilePermanently: vi.fn()
}))

// Mock boundary matching notesQueries.test.ts/drive.test.ts: the real sdk client module imports a Vite
// `?worker`, unresolvable under node vitest.
vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { createDirectory, listDirectory, downloadFileBytes, uploadFileBytes, getFile, deleteFilePermanently }
}))

// A bare, unconfigured QueryClient stands in for the real singleton — same rationale as
// notesQueries.test.ts: only genuine setQueryData/getQueryData/cancelQueries mechanics are needed,
// never the production client's OPFS-backed persistence pipeline.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

// playlists.ts holds module-level session state (the resolved Playlists-dir uuid memo, the
// dead-track-prune-once-per-session set) — vi.resetModules() + a fresh dynamic import per test isolates
// it, mirroring audioKeymap.test.ts's identical need for the keymap registry's own module singleton.
async function freshPlaylists() {
	vi.resetModules()

	const [playlistsLib, playlistsQueries, clientModule] = await Promise.all([
		import("@/features/audio/lib/playlists"),
		import("@/features/audio/queries/playlists"),
		import("@/queries/client")
	])

	return { ...playlistsLib, ...playlistsQueries, queryClient: clientModule.queryClient }
}

function fakeDir(uuid: UuidStr): Dir {
	return { uuid, meta: { type: "decoded", data: { name: uuid } }, timestamp: 0n, color: "default" } as Dir
}

function fakeJsonFile(uuid: UuidStr, name: string): SdkFile {
	return {
		uuid,
		meta: { type: "decoded", data: { name, mime: "application/json", modified: 0n, size: 0n, key: "k", version: 2 } },
		parent: PLAYLISTS_DIR_UUID,
		size: 0n,
		favorited: false,
		region: "r",
		bucket: "b",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false
	}
}

function playlistJsonBytes(playlist: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(playlist))
}

// Every test that reaches the read/write path needs `.filen`/`Playlists` to resolve — wired once here
// so individual tests only configure the calls they actually care about.
function mockDirectoryResolve(): void {
	createDirectory.mockImplementation((parentUuid: string | null, name: string) => {
		if (name === ".filen") {
			return Promise.resolve(fakeDir(DOT_FILEN_UUID))
		}

		if (name === "Playlists" && parentUuid === DOT_FILEN_UUID) {
			return Promise.resolve(fakeDir(PLAYLISTS_DIR_UUID))
		}

		return Promise.reject(new Error(`unexpected createDirectory(${parentUuid ?? "null"}, ${name})`))
	})
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("getPlaylistsDirectoryUuid", () => {
	it("resolves .filen then Playlists and memoizes the result", async () => {
		mockDirectoryResolve()
		const { getPlaylistsDirectoryUuid } = await freshPlaylists()

		await expect(getPlaylistsDirectoryUuid()).resolves.toBe(PLAYLISTS_DIR_UUID)
		await expect(getPlaylistsDirectoryUuid()).resolves.toBe(PLAYLISTS_DIR_UUID)

		expect(createDirectory).toHaveBeenCalledTimes(2) // .filen + Playlists, ONCE despite two calls
	})

	it("clears the memo on a rejection so the next call retries instead of failing forever", async () => {
		createDirectory.mockRejectedValueOnce(new Error("network blip"))
		const { getPlaylistsDirectoryUuid } = await freshPlaylists()

		await expect(getPlaylistsDirectoryUuid()).rejects.toThrow("network blip")

		mockDirectoryResolve()

		await expect(getPlaylistsDirectoryUuid()).resolves.toBe(PLAYLISTS_DIR_UUID)
	})
})

describe("fetchPlaylistEntries", () => {
	it("isolates a per-file failure: one ok, one download-rejected, one parse-invalid — never rejects the whole call", async () => {
		mockDirectoryResolve()

		const okUuid = testUuid("ok")
		const rejectUuid = testUuid("reject")
		const invalidUuid = testUuid("invalid")
		const okPlaylist = { uuid: "playlist-ok", name: "Ok playlist", created: 1000, updated: 1000, files: [] }

		listDirectory.mockResolvedValue({
			dirs: [],
			files: [fakeJsonFile(okUuid, "a.json"), fakeJsonFile(rejectUuid, "b.json"), fakeJsonFile(invalidUuid, "c.json")]
		})

		downloadFileBytes.mockImplementation((file: SdkFile) => {
			if (file.uuid === okUuid) {
				return Promise.resolve(playlistJsonBytes(okPlaylist))
			}

			if (file.uuid === rejectUuid) {
				return Promise.reject(new Error("download failed"))
			}

			// invalidUuid: valid JSON, but structurally not a Playlist.
			return Promise.resolve(playlistJsonBytes({ not: "a playlist" }))
		})
		getFile.mockResolvedValue(fakeDir(testUuid("exists")))

		const { fetchPlaylistEntries } = await freshPlaylists()
		const entries = await fetchPlaylistEntries()

		expect(entries).toHaveLength(3)
		expect(entries.find(e => e.status === "ok")).toMatchObject({ status: "ok", playlist: { uuid: "playlist-ok" } })
		expect(entries.filter(e => e.status === "degraded")).toHaveLength(2)
	})
})

describe("createPlaylist", () => {
	it("uploads the serialized playlist to Playlists/${uuid}.json and upserts the query cache", async () => {
		mockDirectoryResolve()
		uploadFileBytes.mockResolvedValue(fakeJsonFile(testUuid("new"), "new.json"))

		const { createPlaylist, playlistsQueryGet } = await freshPlaylists()
		const playlist = await createPlaylist("Road trip")

		expect(playlist.name).toBe("Road trip")
		expect(playlist.files).toEqual([])
		expect(uploadFileBytes).toHaveBeenCalledExactlyOnceWith(
			PLAYLISTS_DIR_UUID,
			expect.any(Uint8Array),
			`${playlist.uuid}.json`,
			"application/json"
		)
		expect(playlistsQueryGet()).toEqual([{ status: "ok", playlist }])
	})
})

describe("mutatePlaylist (via renamePlaylistAction) — freshest-copy recompose", () => {
	it("re-composes against the FRESHEST cached copy, not the caller's stale snapshot", async () => {
		mockDirectoryResolve()
		uploadFileBytes.mockResolvedValue(fakeJsonFile(testUuid("saved"), "saved.json"))

		const { renamePlaylistAction, playlistsQueryUpsert, playlistsQueryGet } = await freshPlaylists()

		const freshest = {
			uuid: "p-1",
			name: "Stale name",
			created: 1000,
			updated: 1000,
			files: [
				{
					uuid: "a",
					name: "a.mp3",
					mime: "audio/mpeg",
					size: 1,
					bucket: "b",
					key: "k",
					version: 2,
					chunks: 1,
					region: "r",
					playlist: "p-1"
				},
				{
					uuid: "b",
					name: "b.mp3",
					mime: "audio/mpeg",
					size: 1,
					bucket: "b",
					key: "k",
					version: 2,
					chunks: 1,
					region: "r",
					playlist: "p-1"
				}
			]
		}
		// The cache holds a FRESHER copy (2 files) than the caller's own stale snapshot (0 files) —
		// mirrors a concurrent add having landed after the caller captured its own reference.
		playlistsQueryUpsert(freshest)

		const staleFallback = { ...freshest, files: [] }
		const renamed = await renamePlaylistAction(staleFallback, "New name")

		expect(renamed?.files).toHaveLength(2) // recomposed against the fresh 2-file copy, not the stale 0
		expect(renamed?.name).toBe("New name")
		expect(playlistsQueryGet()).toEqual([{ status: "ok", playlist: renamed }])
	})
})

describe("write-lock serialization", () => {
	it("serializes two concurrent mutations on the same playlist — the second sees the first's result", async () => {
		mockDirectoryResolve()
		uploadFileBytes.mockResolvedValue(fakeJsonFile(testUuid("saved"), "saved.json"))

		const { addTracksToPlaylistAction, playlistsQueryGet } = await freshPlaylists()
		const { narrowItem } = await import("@/features/drive/lib/item")

		const base = { uuid: "p-1", name: "Mix", created: 1000, updated: 1000, files: [] }
		const driveItemA = narrowItem(fakeJsonFile(testUuid("a"), "a.mp3"))
		const driveItemB = narrowItem(fakeJsonFile(testUuid("b"), "b.mp3"))

		// Two concurrent adds of DIFFERENT tracks against the SAME base snapshot: without the write lock +
		// freshest recompose, the second upload would overwrite the first's — only one track would survive.
		const [addedA, addedB] = await Promise.all([
			addTracksToPlaylistAction(base, [driveItemA]),
			addTracksToPlaylistAction(base, [driveItemB])
		])

		expect(addedA).toBe(1)
		expect(addedB).toBe(1)

		const entries = playlistsQueryGet()
		const finalPlaylist = entries?.find(entry => entry.status === "ok" && entry.playlist.uuid === "p-1")

		expect(finalPlaylist?.status === "ok" ? finalPlaylist.playlist.files.map(f => f.uuid).sort() : null).toEqual(
			[testUuid("a"), testUuid("b")].sort()
		)
		expect(uploadFileBytes).toHaveBeenCalledTimes(2) // sequential, not merged into one call
	})
})

describe("dead-track prune (once per session)", () => {
	it("checks existence, persists the cleaned copy once, and skips the check entirely on a later read", async () => {
		mockDirectoryResolve()

		const jsonFileUuid = testUuid("playlistfile")
		const storedPlaylist = {
			uuid: "p-1",
			name: "Mix",
			created: 1000,
			updated: 1000,
			files: [
				{
					uuid: "alive",
					name: "alive.mp3",
					mime: "audio/mpeg",
					size: 1,
					bucket: "b",
					key: "k",
					version: 2,
					chunks: 1,
					region: "r",
					playlist: "p-1"
				},
				{
					uuid: "dead",
					name: "dead.mp3",
					mime: "audio/mpeg",
					size: 1,
					bucket: "b",
					key: "k",
					version: 2,
					chunks: 1,
					region: "r",
					playlist: "p-1"
				}
			]
		}

		listDirectory.mockResolvedValue({ dirs: [], files: [fakeJsonFile(jsonFileUuid, "p-1.json")] })
		downloadFileBytes.mockResolvedValue(playlistJsonBytes(storedPlaylist))
		getFile.mockImplementation((uuid: string) => Promise.resolve(uuid === "dead" ? undefined : fakeDir(testUuid("exists"))))
		uploadFileBytes.mockResolvedValue(fakeJsonFile(testUuid("saved"), "saved.json"))

		const { fetchPlaylistEntries } = await freshPlaylists()

		const first = await fetchPlaylistEntries()
		const firstOk = first.find(e => e.status === "ok")

		expect(firstOk?.status === "ok" ? firstOk.playlist.files.map(f => f.uuid) : null).toEqual(["alive"])
		expect(getFile).toHaveBeenCalledTimes(2) // one existence check per stored track

		// Let the fire-and-forget cleanup persist settle before asserting on it.
		await Promise.resolve()
		await Promise.resolve()

		expect(uploadFileBytes).toHaveBeenCalledTimes(1) // the cleanup persist, exactly once

		getFile.mockClear()

		const second = await fetchPlaylistEntries()
		const secondOk = second.find(e => e.status === "ok")

		// Second read within the SAME session: the guard skips the existence check entirely.
		expect(getFile).not.toHaveBeenCalled()
		expect(secondOk?.status === "ok" ? secondOk.playlist.files.map(f => f.uuid) : null).toEqual(["alive", "dead"])
	})
})

describe("queueTracksFromPlaylist", () => {
	it("rebuilds a playable track per entry, converting numeric fields back to the SDK's bigint fields", async () => {
		const { queueTracksFromPlaylist } = await freshPlaylists()

		const playlist = {
			uuid: "p-1",
			name: "Mix",
			created: 1000,
			updated: 1000,
			files: [
				{
					uuid: "a",
					name: "a.mp3",
					mime: "audio/mpeg",
					size: 123_456,
					bucket: "bucket-1",
					key: "key-1",
					version: 2,
					chunks: 3,
					region: "region-1",
					playlist: "p-1"
				}
			]
		}

		const tracks = queueTracksFromPlaylist(playlist)

		expect(tracks).toHaveLength(1)
		expect(tracks[0]).toMatchObject({ uuid: "a", name: "a.mp3", mime: "audio/mpeg" })
		expect(tracks[0]?.file.size).toBe(123_456n)
		expect(tracks[0]?.file.chunks).toBe(3n)
	})
})

describe("deletePlaylistAction", () => {
	it("finds the playlist's own ${uuid}.json file, deletes it, and removes the query row", async () => {
		mockDirectoryResolve()

		const playlist = { uuid: "p-1", name: "Mix", created: 1000, updated: 1000, files: [] }
		const jsonFile = fakeJsonFile(testUuid("jsonfile"), "p-1.json")

		listDirectory.mockResolvedValue({ dirs: [], files: [jsonFile] })
		deleteFilePermanently.mockResolvedValue(undefined)

		const { deletePlaylistAction, playlistsQueryUpsert, playlistsQueryGet } = await freshPlaylists()

		playlistsQueryUpsert(playlist)
		await deletePlaylistAction(playlist)

		expect(deleteFilePermanently).toHaveBeenCalledExactlyOnceWith(jsonFile)
		expect(playlistsQueryGet()).toEqual([])
	})
})
