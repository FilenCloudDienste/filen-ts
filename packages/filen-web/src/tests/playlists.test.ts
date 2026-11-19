import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File as SdkFile, SocketEvent, UuidStr } from "@filen/sdk-rs"
import { DIRECTORY_NOT_FOUND_PREFIX, PARENT_NOT_FOUND_PREFIX, type ErrorDTO } from "@/lib/sdk/errors"
import { testUuid } from "@/tests/support/uuid"
import type { Playlist } from "@filen/shared"

const DOT_FILEN_UUID = testUuid("dotfilen")
const PLAYLISTS_DIR_UUID = testUuid("playlistsdir")

const { createDirectory, findDirectoryUuid, listDirectory, downloadFileBytes, uploadFileBytes, getFile, deleteFilePermanently } =
	vi.hoisted(() => ({
		createDirectory: vi.fn(),
		findDirectoryUuid: vi.fn(),
		listDirectory: vi.fn(),
		downloadFileBytes: vi.fn(),
		uploadFileBytes: vi.fn(),
		getFile: vi.fn(),
		deleteFilePermanently: vi.fn()
	}))

// Mock boundary matching notesQueries.test.ts/drive.test.ts: the real sdk client module imports a Vite
// `?worker`, unresolvable under node vitest.
vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { createDirectory, findDirectoryUuid, listDirectory, downloadFileBytes, uploadFileBytes, getFile, deleteFilePermanently }
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

	const [playlistsLib, playlistsQueries, socketHandlers, dotFilen, clientModule] = await Promise.all([
		import("@/features/audio/lib/playlists"),
		import("@/features/audio/queries/playlists"),
		import("@/features/audio/lib/socketHandlers"),
		import("@/lib/dotFilen"),
		import("@/queries/client")
	])

	return {
		...playlistsLib,
		...playlistsQueries,
		// Both drive handlers, in the order the socket host registers them: a `.filen` directory event is the
		// shared resolver's, which tells playlists.
		handlePlaylistsDriveEvent: (event: Parameters<typeof socketHandlers.handlePlaylistsDriveEvent>[0]) => {
			socketHandlers.handlePlaylistsDriveEvent(event)
			dotFilen.handleDotFilenDriveEvent(event)
		},
		queryClient: clientModule.queryClient
	}
}

function fakeDir(uuid: UuidStr): Dir {
	return { uuid, meta: { type: "decoded", data: { name: uuid } }, timestamp: 0n, color: "default" } as Dir
}

function fakeJsonFile(uuid: UuidStr, name: string): SdkFile {
	return {
		uuid,
		stableUUID: undefined,
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

// Every test that reaches the read/write path needs `.filen`/`playlists` to resolve — wired once here
// so individual tests only configure the calls they actually care about. Both exist, so they are found.
function mockDirectoryResolve(): void {
	findDirectoryUuid.mockImplementation((parentUuid: string | null, name: string) => {
		if (name === ".filen" && parentUuid === null) {
			return Promise.resolve(DOT_FILEN_UUID)
		}

		if (name === "playlists" && parentUuid === DOT_FILEN_UUID) {
			return Promise.resolve(PLAYLISTS_DIR_UUID)
		}

		return Promise.reject(new Error(`unexpected findDirectoryUuid(${parentUuid ?? "null"}, ${name})`))
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

		expect(findDirectoryUuid).toHaveBeenCalledTimes(2) // .filen + Playlists, ONCE despite two calls
		expect(createDirectory).not.toHaveBeenCalled()
	})

	it("creates only Playlists when `.filen` exists without it", async () => {
		findDirectoryUuid.mockImplementation((parentUuid: string | null) =>
			Promise.resolve(parentUuid === null ? DOT_FILEN_UUID : undefined)
		)
		createDirectory.mockResolvedValueOnce(fakeDir(PLAYLISTS_DIR_UUID))
		const { getPlaylistsDirectoryUuid } = await freshPlaylists()

		await expect(getPlaylistsDirectoryUuid()).resolves.toBe(PLAYLISTS_DIR_UUID)

		expect(createDirectory).toHaveBeenCalledExactlyOnceWith(DOT_FILEN_UUID, "playlists")
	})

	it("clears the memo on a rejection so the next call retries instead of failing forever", async () => {
		findDirectoryUuid.mockRejectedValueOnce(new Error("network blip"))
		const { getPlaylistsDirectoryUuid } = await freshPlaylists()

		await expect(getPlaylistsDirectoryUuid()).rejects.toThrow("network blip")

		mockDirectoryResolve()

		await expect(getPlaylistsDirectoryUuid()).resolves.toBe(PLAYLISTS_DIR_UUID)
	})
})

describe("fetchPlaylistEntries", () => {
	it("lists nothing and creates nothing when `.filen` or Playlists is missing", async () => {
		findDirectoryUuid.mockImplementation((parentUuid: string | null) =>
			Promise.resolve(parentUuid === null ? DOT_FILEN_UUID : undefined)
		)
		const { fetchPlaylistEntries } = await freshPlaylists()

		await expect(fetchPlaylistEntries()).resolves.toEqual([])

		findDirectoryUuid.mockResolvedValue(undefined)

		const { fetchPlaylistEntries: fetchWithoutDotFilen } = await freshPlaylists()

		await expect(fetchWithoutDotFilen()).resolves.toEqual([])
		expect(createDirectory).not.toHaveBeenCalled()
		expect(listDirectory).not.toHaveBeenCalled()
	})

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
	function okTrackUuids(entries: Awaited<ReturnType<Awaited<ReturnType<typeof freshPlaylists>>["fetchPlaylistEntries"]>>) {
		return entries.map(entry => (entry.status === "ok" ? entry.playlist.files.map(file => file.uuid) : null))
	}

	// One stored playlist ["alive", "dead"] whose file keeps its uuid, as when the cleanup upload failed or a
	// listing raced it.
	function mockAliveDead(): void {
		mockDirectoryResolve()
		listDirectory.mockResolvedValue({ dirs: [], files: [fakeJsonFile(testUuid("playlistfile"), "p-1.json")] })
		downloadFileBytes.mockResolvedValue(playlistJsonBytes(playlistWith("p-1", ["alive", "dead"])))
		getFile.mockImplementation((uuid: string) => Promise.resolve(uuid === "dead" ? undefined : fakeDir(testUuid("exists"))))
		uploadFileBytes.mockResolvedValue(fakeJsonFile(testUuid("saved"), "saved.json"))
	}

	it("checks existence after the read, persists the cleaned copy once, and keeps later reads pruned", async () => {
		mockAliveDead()

		const { fetchPlaylistEntries } = await freshPlaylists()

		expect(okTrackUuids(await fetchPlaylistEntries())).toEqual([["alive", "dead"]])

		await vi.waitFor(() => {
			expect(uploadFileBytes).toHaveBeenCalledTimes(1)
		})

		expect(getFile).toHaveBeenCalledTimes(2) // one existence check per stored track
		expect(uploadedPlaylist(0).files.map(file => file.uuid)).toEqual(["alive"])

		getFile.mockClear()

		// Same session, same file uuid: no check, no download, and the dead track stays out.
		expect(okTrackUuids(await fetchPlaylistEntries())).toEqual([["alive"]])
		expect(getFile).not.toHaveBeenCalled()
		expect(downloadFileBytes).toHaveBeenCalledTimes(1)
		expect(uploadFileBytes).toHaveBeenCalledTimes(1)
	})

	it("keeps a read pruned after the cleanup upload failed, without checking again", async () => {
		mockAliveDead()
		uploadFileBytes.mockRejectedValueOnce(new Error("connection dropped"))

		const { fetchPlaylistEntries } = await freshPlaylists()

		await fetchPlaylistEntries()
		await vi.waitFor(() => {
			expect(uploadFileBytes).toHaveBeenCalledTimes(1)
		})
		await new Promise(resolve => setTimeout(resolve, 0))
		getFile.mockClear()

		expect(okTrackUuids(await fetchPlaylistEntries())).toEqual([["alive"]])
		expect(getFile).not.toHaveBeenCalled()
	})

	it("does not drop a track added back after the check", async () => {
		mockAliveDead()

		const { fetchPlaylistEntries } = await freshPlaylists()

		await fetchPlaylistEntries()
		await vi.waitFor(() => {
			expect(uploadFileBytes).toHaveBeenCalledTimes(1)
		})

		// The cleaned copy lands, then the file comes back (restored) and is added again.
		listDirectory.mockResolvedValue({ dirs: [], files: [fakeJsonFile(testUuid("cleaned"), "p-1.json")] })
		downloadFileBytes.mockResolvedValueOnce(playlistJsonBytes(playlistWith("p-1", ["alive"])))
		await fetchPlaylistEntries()

		listDirectory.mockResolvedValue({ dirs: [], files: [fakeJsonFile(testUuid("readded"), "p-1.json")] })
		downloadFileBytes.mockResolvedValueOnce(playlistJsonBytes(playlistWith("p-1", ["alive", "dead"], 2000)))
		getFile.mockClear()

		expect(okTrackUuids(await fetchPlaylistEntries())).toEqual([["alive", "dead"]])
		expect(getFile).not.toHaveBeenCalled()
	})

	it("keeps a track added back after the cleanup when no read came in between", async () => {
		const dead = testUuid("dead")

		mockDirectoryResolve()
		listDirectory.mockResolvedValue({ dirs: [], files: [fakeJsonFile(testUuid("playlistfile"), "p-1.json")] })
		downloadFileBytes.mockResolvedValue(playlistJsonBytes(playlistWith("p-1", ["alive", dead])))
		getFile.mockImplementation((uuid: string) => Promise.resolve(uuid === dead ? undefined : fakeDir(testUuid("exists"))))
		uploadFileBytes.mockResolvedValue(fakeJsonFile(testUuid("saved"), "saved.json"))

		const { fetchPlaylistEntries, addTracksToPlaylistAction } = await freshPlaylists()
		const { narrowItem } = await import("@/features/drive/lib/item")

		await fetchPlaylistEntries()
		await vi.waitFor(() => {
			expect(uploadFileBytes).toHaveBeenCalledTimes(1)
		})
		await flushTasks()

		await expect(addTracksToPlaylistAction(uploadedPlaylist(0), [narrowItem(fakeJsonFile(dead, "dead.mp3"))])).resolves.toBe(1)
		expect(uploadedPlaylist(1).files.map(file => file.uuid)).toEqual(["alive", dead])

		// The re-added copy listed under its new file uuid, with no read of the cleaned one in between.
		listDirectory.mockResolvedValue({ dirs: [], files: [fakeJsonFile(testUuid("readded"), "p-1.json")] })
		downloadFileBytes.mockResolvedValue(playlistJsonBytes(uploadedPlaylist(1)))
		getFile.mockClear()

		expect(okTrackUuids(await fetchPlaylistEntries())).toEqual([["alive", dead]])
		expect(getFile).not.toHaveBeenCalled()
	})

	it("keeps a track added back while the checks were out", async () => {
		const dead = testUuid("dead")
		let releaseDeadCheck: () => void = () => undefined

		mockDirectoryResolve()
		listDirectory.mockResolvedValue({ dirs: [], files: [fakeJsonFile(testUuid("playlistfile"), "p-1.json")] })
		downloadFileBytes.mockResolvedValue(playlistJsonBytes(playlistWith("p-1", ["alive", dead])))
		getFile.mockImplementation((uuid: string) =>
			uuid === dead
				? new Promise(resolve => {
						releaseDeadCheck = () => {
							resolve(undefined)
						}
					})
				: Promise.resolve(fakeDir(testUuid("exists")))
		)
		uploadFileBytes.mockResolvedValue(fakeJsonFile(testUuid("saved"), "saved.json"))

		const { fetchPlaylistEntries, addTracksToPlaylistAction } = await freshPlaylists()
		const { narrowItem } = await import("@/features/drive/lib/item")

		await fetchPlaylistEntries()
		await vi.waitFor(() => {
			expect(getFile).toHaveBeenCalledTimes(2)
		})

		// Removed and picked again while its check is out: the track is live after all.
		await addTracksToPlaylistAction(playlistWith("p-1", ["alive"], 2000), [narrowItem(fakeJsonFile(dead, "dead.mp3"))])
		releaseDeadCheck()
		await flushTasks()

		expect(uploadFileBytes).toHaveBeenCalledTimes(1) // the add only, no cleanup
		expect(uploadedPlaylist(0).files.map(file => file.uuid)).toEqual(["alive", dead])
	})

	it("a read during an unfinished pass neither checks again nor marks it done", async () => {
		mockAliveDead()

		let releaseDeadCheck: () => void = () => undefined

		getFile.mockImplementation((uuid: string) =>
			uuid === "dead"
				? new Promise(resolve => {
						releaseDeadCheck = () => {
							resolve(undefined)
						}
					})
				: Promise.resolve(fakeDir(testUuid("exists")))
		)

		const { fetchPlaylistEntries } = await freshPlaylists()

		await fetchPlaylistEntries()
		await vi.waitFor(() => {
			expect(getFile).toHaveBeenCalledTimes(2)
		})

		expect(okTrackUuids(await fetchPlaylistEntries())).toEqual([["alive", "dead"]])
		await new Promise(resolve => setTimeout(resolve, 0))
		expect(getFile).toHaveBeenCalledTimes(2)

		releaseDeadCheck()
		await vi.waitFor(() => {
			expect(uploadFileBytes).toHaveBeenCalledTimes(1)
		})

		expect(okTrackUuids(await fetchPlaylistEntries())).toEqual([["alive"]])
		expect(getFile).toHaveBeenCalledTimes(2)
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

describe("the remembered Playlists directory", () => {
	type DriveEvent = Extract<SocketEvent, { type: "drive" }>["inner"]

	function driveEvent(inner: DriveEvent): Extract<SocketEvent, { type: "drive" }> {
		return { type: "drive", inner, driveMessageId: 0n }
	}

	function renamed(uuid: UuidStr, name: string): DriveEvent {
		return { type: "folderMetadataChanged", uuid, meta: { type: "decoded", data: { name } } }
	}

	// Resolving costs two finds (.filen, then Playlists), so four means it re-resolved.
	async function resolveCountAfter(act: (modules: Awaited<ReturnType<typeof freshPlaylists>>) => Promise<void>): Promise<number> {
		mockDirectoryResolve()
		const modules = await freshPlaylists()

		await modules.getPlaylistsDirectoryUuid()
		await act(modules)
		await expect(modules.getPlaylistsDirectoryUuid()).resolves.toBe(PLAYLISTS_DIR_UUID)

		return findDirectoryUuid.mock.calls.length
	}

	it.each<{ name: string; inner: DriveEvent }>([
		{ name: "Playlists is trashed", inner: { type: "folderTrash", parent: DOT_FILEN_UUID, uuid: PLAYLISTS_DIR_UUID } },
		{ name: ".filen is trashed", inner: { type: "folderTrash", parent: testUuid("root"), uuid: DOT_FILEN_UUID } },
		{ name: "Playlists is deleted", inner: { type: "folderDeletedPermanent", uuid: PLAYLISTS_DIR_UUID } },
		{ name: ".filen is deleted", inner: { type: "folderDeletedPermanent", uuid: DOT_FILEN_UUID } },
		{ name: "Playlists is moved", inner: { type: "folderMove", dir: fakeDir(PLAYLISTS_DIR_UUID) } },
		{ name: ".filen is moved", inner: { type: "folderMove", dir: fakeDir(DOT_FILEN_UUID) } },
		{ name: "Playlists is renamed", inner: renamed(PLAYLISTS_DIR_UUID, "Old playlists") },
		{ name: ".filen is renamed", inner: renamed(DOT_FILEN_UUID, "filen-backup") },
		{ name: "the whole drive is deleted", inner: { type: "deleteAll" } }
	])("is re-resolved after $name", async ({ inner }) => {
		const count = await resolveCountAfter(({ handlePlaylistsDriveEvent }) => {
			handlePlaylistsDriveEvent(driveEvent(inner))

			return Promise.resolve()
		})

		expect(count).toBe(4)
	})

	it.each<{ name: string; inner: DriveEvent }>([
		{ name: "another directory is trashed", inner: { type: "folderTrash", parent: DOT_FILEN_UUID, uuid: testUuid("other") } },
		{ name: "another directory is moved", inner: { type: "folderMove", dir: fakeDir(testUuid("other")) } },
		{ name: "Playlists is renamed by case only", inner: renamed(PLAYLISTS_DIR_UUID, "playlists") },
		{
			name: "a playlist file is trashed",
			inner: { type: "fileTrash", uuid: testUuid("file"), stableUUID: testUuid("s"), newUUID: undefined }
		}
	])("is kept after $name", async ({ inner }) => {
		const count = await resolveCountAfter(({ handlePlaylistsDriveEvent }) => {
			handlePlaylistsDriveEvent(driveEvent(inner))

			return Promise.resolve()
		})

		expect(count).toBe(2)
	})

	// The first lookup's `.filen` call is held open, so an event can land while the uuids are still unknown.
	function holdFirstLookup(): { release: () => void; fail: () => void } {
		const gate: { release: () => void; fail: () => void } = { release: () => undefined, fail: () => undefined }

		findDirectoryUuid.mockImplementationOnce(
			() =>
				new Promise((resolve, reject) => {
					gate.release = () => {
						resolve(DOT_FILEN_UUID)
					}
					gate.fail = () => {
						reject(new Error("network blip"))
					}
				})
		)

		return gate
	}

	it.each<{ name: string; inner: DriveEvent; expected: number }>([
		{
			name: "re-resolved after a directory is trashed",
			inner: { type: "folderTrash", parent: testUuid("root"), uuid: testUuid("x") },
			expected: 4
		},
		{ name: "re-resolved after a directory is deleted", inner: { type: "folderDeletedPermanent", uuid: testUuid("x") }, expected: 4 },
		{ name: "re-resolved after a directory is moved", inner: { type: "folderMove", dir: fakeDir(testUuid("x")) }, expected: 4 },
		{ name: "re-resolved after a directory is renamed", inner: renamed(testUuid("x"), "Old playlists"), expected: 4 },
		{ name: "re-resolved after the whole drive is deleted", inner: { type: "deleteAll" }, expected: 4 },
		{
			name: "kept after a file is trashed",
			inner: { type: "fileTrash", uuid: testUuid("file"), stableUUID: testUuid("s"), newUUID: undefined },
			expected: 2
		},
		{ name: "kept after a directory is renamed to Playlists", inner: renamed(testUuid("x"), "playlists"), expected: 2 }
	])("is $name mid-lookup", async ({ inner, expected }) => {
		mockDirectoryResolve()
		const gate = holdFirstLookup()
		const { getPlaylistsDirectoryUuid, handlePlaylistsDriveEvent } = await freshPlaylists()
		const pending = getPlaylistsDirectoryUuid()

		handlePlaylistsDriveEvent(driveEvent(inner))
		gate.release()

		// Its own caller still gets an answer; only remembering it is withheld.
		await expect(pending).resolves.toBe(PLAYLISTS_DIR_UUID)
		await expect(getPlaylistsDirectoryUuid()).resolves.toBe(PLAYLISTS_DIR_UUID)

		expect(findDirectoryUuid).toHaveBeenCalledTimes(expected)
	})

	it("keeps the successor's memo when a lookup forgotten mid-flight later fails", async () => {
		mockDirectoryResolve()
		const gate = holdFirstLookup()
		const { getPlaylistsDirectoryUuid, handlePlaylistsDriveEvent } = await freshPlaylists()
		const forgotten = getPlaylistsDirectoryUuid()

		handlePlaylistsDriveEvent(driveEvent({ type: "folderTrash", parent: testUuid("root"), uuid: testUuid("x") }))
		await expect(getPlaylistsDirectoryUuid()).resolves.toBe(PLAYLISTS_DIR_UUID)

		gate.fail()
		await expect(forgotten).rejects.toThrow("network blip")
		await expect(getPlaylistsDirectoryUuid()).resolves.toBe(PLAYLISTS_DIR_UUID)

		expect(findDirectoryUuid).toHaveBeenCalledTimes(3) // the held call + one full successor lookup
	})

	const goneListing: ErrorDTO = {
		species: "plain",
		message: `${DIRECTORY_NOT_FOUND_PREFIX}${PLAYLISTS_DIR_UUID}`,
		label: `${DIRECTORY_NOT_FOUND_PREFIX}${PLAYLISTS_DIR_UUID}`
	}
	const goneParent: ErrorDTO = {
		species: "plain",
		message: `${PARENT_NOT_FOUND_PREFIX}${PLAYLISTS_DIR_UUID}`,
		label: `${PARENT_NOT_FOUND_PREFIX}${PLAYLISTS_DIR_UUID}`
	}
	const sdkFolderNotFound: ErrorDTO = { species: "sdk", kind: "FolderNotFound", message: "folder not found", label: "folder not found" }
	const transient: ErrorDTO = { species: "sdk", kind: "Reqwest", message: "network", label: "network" }

	it.each<{ name: string; error: ErrorDTO; op: "list" | "upload" | "delete"; expected: number }>([
		{ name: "re-resolved after a listing of a gone directory", error: goneListing, op: "list", expected: 4 },
		{ name: "re-resolved after an upload into a gone parent", error: goneParent, op: "upload", expected: 4 },
		{ name: "re-resolved after the SDK reports the folder gone", error: sdkFolderNotFound, op: "upload", expected: 4 },
		{ name: "re-resolved after a delete's listing finds it gone", error: goneListing, op: "delete", expected: 4 },
		{ name: "kept after a failure that isn't a gone directory", error: transient, op: "list", expected: 2 }
	])("is $name", async ({ error, op, expected }) => {
		const failing = op === "upload" ? uploadFileBytes : listDirectory

		failing.mockRejectedValueOnce(error)

		const count = await resolveCountAfter(async ({ fetchPlaylistEntries, createPlaylist, deletePlaylistAction }) => {
			const run =
				op === "list"
					? fetchPlaylistEntries()
					: op === "upload"
						? createPlaylist("Mix")
						: deletePlaylistAction({ uuid: "p-1", name: "Mix", created: 1, updated: 1, files: [] })

			await expect(run).rejects.toBe(error)
		})

		expect(count).toBe(expected)
	})
})

function playlistFile(uuid: string, playlistUuid: string) {
	return {
		uuid,
		name: `${uuid}.mp3`,
		mime: "audio/mpeg",
		size: 1,
		bucket: "b",
		key: "k",
		version: 2,
		chunks: 1,
		region: "r",
		playlist: playlistUuid
	}
}

function playlistWith(uuid: string, trackUuids: string[], updated = 1000) {
	return { uuid, name: uuid, created: 1000, updated, files: trackUuids.map(trackUuid => playlistFile(trackUuid, uuid)) }
}

// Lets detached passes (a task after the read, then their awaited checks and lock) run to the end.
async function flushTasks(): Promise<void> {
	for (let task = 0; task < 5; task++) {
		await new Promise(resolve => setTimeout(resolve, 0))
	}
}

function uploadedPlaylist(call: number): Playlist {
	const bytes = uploadFileBytes.mock.calls[call]?.[1] as Uint8Array

	return JSON.parse(new TextDecoder().decode(bytes)) as Playlist
}

describe("reorderPlaylistFileAction", () => {
	it("moves the dragged track by uuid, even when an earlier save reordered the list it was dragged in", async () => {
		mockDirectoryResolve()
		uploadFileBytes.mockResolvedValue(fakeJsonFile(testUuid("saved"), "saved.json"))

		const { reorderPlaylistFileAction, playlistsQueryUpsert, playlistsQueryGet } = await freshPlaylists()

		// The displayed snapshot still shows A..E; the cache already holds the first drag's E-first order.
		const displayed = playlistWith("p-1", ["A", "B", "C", "D", "E"])

		playlistsQueryUpsert(playlistWith("p-1", ["E", "A", "B", "C", "D"], 2000))

		// D dropped onto B's row.
		const next = await reorderPlaylistFileAction(displayed, "D", "B")

		expect(next?.files.map(file => file.uuid)).toEqual(["E", "A", "D", "B", "C"])
		expect(playlistsQueryGet()).toEqual([{ status: "ok", playlist: next }])
	})

	it("is a no-op when either track has left the playlist", async () => {
		mockDirectoryResolve()

		const { reorderPlaylistFileAction } = await freshPlaylists()

		await expect(reorderPlaylistFileAction(playlistWith("p-1", ["A", "B"]), "gone", "A")).resolves.toBeNull()
		expect(uploadFileBytes).not.toHaveBeenCalled()
	})
})

describe("dead-track prune during a list read", () => {
	it("checks a track shared by several playlists once per read", async () => {
		mockDirectoryResolve()

		listDirectory.mockResolvedValue({
			dirs: [],
			files: [fakeJsonFile(testUuid("pl1"), "p-1.json"), fakeJsonFile(testUuid("pl2"), "p-2.json")]
		})
		downloadFileBytes.mockImplementation((file: SdkFile) =>
			Promise.resolve(
				playlistJsonBytes(
					file.uuid === testUuid("pl1") ? playlistWith("p-1", ["a", "b", "a"]) : playlistWith("p-2", ["b", "a", "c"])
				)
			)
		)
		getFile.mockResolvedValue(fakeDir(testUuid("exists")))

		const { fetchPlaylistEntries } = await freshPlaylists()

		await fetchPlaylistEntries()
		await vi.waitFor(() => {
			expect(getFile).toHaveBeenCalledTimes(3)
		})
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(getFile.mock.calls.map(call => call[0] as string).sort()).toEqual(["a", "b", "c"])
	})

	it("returns the rows before any check settles, then persists the cleaned copy", async () => {
		mockDirectoryResolve()

		let releaseChecks: () => void = () => undefined
		const held = new Promise<void>(resolve => {
			releaseChecks = resolve
		})

		listDirectory.mockResolvedValue({
			dirs: [],
			files: [fakeJsonFile(testUuid("pl1"), "p-1.json"), fakeJsonFile(testUuid("pl2"), "p-2.json")]
		})
		downloadFileBytes.mockImplementation((file: SdkFile) =>
			Promise.resolve(
				playlistJsonBytes(file.uuid === testUuid("pl1") ? playlistWith("p-1", ["alive", "dead"]) : playlistWith("p-2", ["slow"]))
			)
		)
		getFile.mockImplementation(async (uuid: string) => {
			await held

			return uuid === "dead" ? undefined : fakeDir(testUuid("exists"))
		})
		uploadFileBytes.mockResolvedValue(fakeJsonFile(testUuid("saved"), "saved.json"))

		const { fetchPlaylistEntries } = await freshPlaylists()
		const entries = await fetchPlaylistEntries()

		expect(entries.map(entry => (entry.status === "ok" ? entry.playlist.files.map(file => file.uuid) : null))).toEqual([
			["alive", "dead"],
			["slow"]
		])
		expect(uploadFileBytes).not.toHaveBeenCalled()

		releaseChecks()
		await vi.waitFor(() => {
			expect(uploadFileBytes).toHaveBeenCalledTimes(1)
		})

		expect(uploadedPlaylist(0).files.map(file => file.uuid)).toEqual(["alive"])
	})

	it("does not upload a playlist deleted while its checks were out", async () => {
		mockDirectoryResolve()

		let releaseChecks: () => void = () => undefined
		const held = new Promise<void>(resolve => {
			releaseChecks = resolve
		})
		const jsonFile = fakeJsonFile(testUuid("pl1"), "p-1.json")

		listDirectory.mockResolvedValue({ dirs: [], files: [jsonFile] })
		downloadFileBytes.mockResolvedValue(playlistJsonBytes(playlistWith("p-1", ["alive", "dead"])))
		getFile.mockImplementation(async (uuid: string) => {
			await held

			return uuid === "dead" ? undefined : fakeDir(testUuid("exists"))
		})
		deleteFilePermanently.mockResolvedValue(undefined)
		uploadFileBytes.mockResolvedValue(fakeJsonFile(testUuid("saved"), "saved.json"))

		const { fetchPlaylistEntries, deletePlaylistAction, playlistsQueryGet, playlistsQueryUpdate } = await freshPlaylists()

		// Fake timers hold the unobserved row against collection, as a mounted list would.
		vi.useFakeTimers()

		try {
			const entries = await fetchPlaylistEntries()

			// Stands in for the query committing the read's rows.
			playlistsQueryUpdate(() => entries)
			await vi.advanceTimersByTimeAsync(0)
			expect(getFile).toHaveBeenCalledTimes(2)

			await deletePlaylistAction(playlistWith("p-1", ["alive", "dead"]))
			releaseChecks()
			await vi.advanceTimersByTimeAsync(0)

			expect(deleteFilePermanently).toHaveBeenCalledExactlyOnceWith(jsonFile)
			expect(uploadFileBytes).not.toHaveBeenCalled()
			expect(playlistsQueryGet()).toEqual([])
		} finally {
			vi.useRealTimers()
		}
	})

	it("drops the dead track from the listed row even when the cleanup upload fails", async () => {
		mockDirectoryResolve()
		listDirectory.mockResolvedValue({ dirs: [], files: [fakeJsonFile(testUuid("pl1"), "p-1.json")] })
		downloadFileBytes.mockResolvedValue(playlistJsonBytes(playlistWith("p-1", ["alive", "dead"])))
		getFile.mockImplementation((uuid: string) => Promise.resolve(uuid === "dead" ? undefined : fakeDir(testUuid("exists"))))
		uploadFileBytes.mockRejectedValue(new Error("connection dropped"))

		const { fetchPlaylistEntries, playlistsQueryGet, playlistsQueryUpdate } = await freshPlaylists()

		// Fake timers hold the unobserved row against collection, as a mounted list would.
		vi.useFakeTimers()

		try {
			const entries = await fetchPlaylistEntries()

			// Stands in for the query committing the read's rows.
			playlistsQueryUpdate(() => entries)

			for (let task = 0; task < 5; task++) {
				await vi.advanceTimersByTimeAsync(0)
			}

			expect(uploadFileBytes).toHaveBeenCalledTimes(1)
			expect(playlistsQueryGet()?.map(entry => (entry.status === "ok" ? entry.playlist.files.map(file => file.uuid) : null))).toEqual(
				[["alive"]]
			)
		} finally {
			vi.useRealTimers()
		}
	})

	it("prunes the downloaded copy, not an older cached one restored from a previous session", async () => {
		mockDirectoryResolve()

		listDirectory.mockResolvedValue({ dirs: [], files: [fakeJsonFile(testUuid("pl1"), "p-1.json")] })
		downloadFileBytes.mockResolvedValue(playlistJsonBytes(playlistWith("p-1", ["new", "dead"], 2000)))
		getFile.mockImplementation((uuid: string) => Promise.resolve(uuid === "dead" ? undefined : fakeDir(testUuid("exists"))))
		uploadFileBytes.mockResolvedValue(fakeJsonFile(testUuid("saved"), "saved.json"))

		const { fetchPlaylistEntries, playlistsQueryUpsert } = await freshPlaylists()

		playlistsQueryUpsert(playlistWith("p-1", ["old", "dead"], 1000))
		uploadFileBytes.mockClear()

		await fetchPlaylistEntries()
		await vi.waitFor(() => {
			expect(uploadFileBytes).toHaveBeenCalledTimes(1)
		})

		expect(uploadedPlaylist(0).files.map(file => file.uuid)).toEqual(["new"])
	})
})
