import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Dir, SocketEvent, UuidStr } from "@filen/sdk-rs"
import { testUuid } from "@/tests/support/uuid"
import { driveFile } from "@/tests/support/videoDrive"

const DOT_FILEN = testUuid("dotfilen")
const SUBDIRS: Record<string, UuidStr> = {
	playlists: testUuid("playlists"),
	videos: testUuid("videos"),
	"chat-uploads": testUuid("chatuploads")
}

const { createDirectory, findDirectoryUuid, forgetFoundDirectories, getDirectory, listDirectory, renameDirectory, subscribeToSocket, kv } =
	vi.hoisted(() => ({
		getDirectory: vi.fn<(uuid: string) => Promise<Dir | undefined>>(),
		renameDirectory: vi.fn<(dir: Dir, name: string) => Promise<Dir>>(),
		kv: new Map<string, unknown>(),
		forgetFoundDirectories: vi.fn(() => Promise.resolve()),
		createDirectory: vi.fn<(parent: string | null, name: string) => Promise<Dir>>(),
		findDirectoryUuid: vi.fn<(parent: string | null, name: string) => Promise<string | undefined>>(),
		listDirectory: vi.fn<(target: { kind: "uuid"; uuid: string }) => Promise<{ dirs: Dir[]; files: [] }>>(),
		subscribeToSocket: vi.fn<(onEvent: (event: SocketEvent) => void) => Promise<void>>()
	}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { createDirectory, findDirectoryUuid, forgetFoundDirectories, getDirectory, listDirectory, renameDirectory, subscribeToSocket }
}))
vi.mock("@/lib/storage/adapter", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/storage/adapter")>()),
	kvGetJson: (key: string) => Promise.resolve(kv.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kv.set(key, value)

		return Promise.resolve()
	}
}))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
vi.mock("@/queries/persist", () => ({ persister: { persistQuery: () => Promise.resolve() } }))

function dir(uuid: UuidStr, name: string = uuid): Dir {
	return { uuid, meta: { type: "decoded", data: { name } }, timestamp: 0n, color: "default" } as Dir
}

// What exists on the server: `.filen` and, by name, its subdirectories.
let existing: { dotFilen: boolean; subdirs: Set<string> }

function find(parent: string | null, name: string): Promise<string | undefined> {
	if (parent === null) {
		return Promise.resolve(name === ".filen" && existing.dotFilen ? DOT_FILEN : undefined)
	}

	return Promise.resolve(parent === DOT_FILEN && existing.subdirs.has(name) ? SUBDIRS[name] : undefined)
}

function lookups(): number {
	return findDirectoryUuid.mock.calls.length + createDirectory.mock.calls.length
}

async function fresh() {
	vi.resetModules()

	return import("@/lib/dotFilen")
}

function driveEvent(inner: Extract<SocketEvent, { type: "drive" }>["inner"]): Extract<SocketEvent, { type: "drive" }> {
	return { type: "drive", inner, driveMessageId: 0n }
}

beforeEach(() => {
	vi.clearAllMocks()
	kv.clear()
	existing = { dotFilen: true, subdirs: new Set(Object.keys(SUBDIRS)) }
	findDirectoryUuid.mockImplementation(find)
	createDirectory.mockImplementation((parent, name) => {
		if (parent === null) {
			existing.dotFilen = true

			return Promise.resolve(dir(DOT_FILEN))
		}

		const uuid = SUBDIRS[name]

		if (uuid === undefined) {
			return Promise.reject(new Error(`unexpected ${name}`))
		}

		existing.subdirs.add(name)

		return Promise.resolve(dir(uuid))
	})
})

describe(".filen subdirectories", () => {
	it("resolves .filen once for every subdirectory", async () => {
		const { getDotFilenSubdir } = await fresh()

		await expect(Promise.all([getDotFilenSubdir("playlists"), getDotFilenSubdir("videos")])).resolves.toEqual([
			SUBDIRS["playlists"],
			SUBDIRS["videos"]
		])
		await getDotFilenSubdir("chat-uploads")

		// .filen once, then one find per subdirectory; everything exists, so nothing is created.
		expect(findDirectoryUuid).toHaveBeenCalledTimes(4)
		expect(findDirectoryUuid).toHaveBeenNthCalledWith(1, null, ".filen")
		expect(createDirectory).not.toHaveBeenCalled()
		expect(listDirectory).not.toHaveBeenCalled()
	})

	it("a write creates only the level that is missing", async () => {
		const { getDotFilenSubdir } = await fresh()

		existing.subdirs.delete("playlists")

		await expect(getDotFilenSubdir("playlists")).resolves.toBe(SUBDIRS["playlists"])

		expect(findDirectoryUuid.mock.calls).toEqual([
			[null, ".filen"],
			[DOT_FILEN, "playlists"]
		])
		expect(createDirectory).toHaveBeenCalledExactlyOnceWith(DOT_FILEN, "playlists")
	})

	it("a first write on a fresh account creates both levels, finding only `.filen`", async () => {
		const { getDotFilenSubdir } = await fresh()

		existing = { dotFilen: false, subdirs: new Set() }

		await expect(getDotFilenSubdir("playlists")).resolves.toBe(SUBDIRS["playlists"])

		// A `.filen` just created has nothing to find in it.
		expect(findDirectoryUuid).toHaveBeenCalledExactlyOnceWith(null, ".filen")
		expect(createDirectory.mock.calls).toEqual([
			[null, ".filen"],
			[DOT_FILEN, "playlists"]
		])
	})

	it("knows the resolved directories synchronously", async () => {
		const { getDotFilenSubdir, isDotFilenSystemDir, dotFilenSubdirUuid } = await fresh()

		expect(dotFilenSubdirUuid("videos")).toBeNull()

		await getDotFilenSubdir("videos")

		expect(dotFilenSubdirUuid("videos")).toBe(SUBDIRS["videos"])
		expect(isDotFilenSystemDir(DOT_FILEN)).toBe(true)
		expect(isDotFilenSystemDir(SUBDIRS["videos"] ?? "")).toBe(true)
		expect(isDotFilenSystemDir(testUuid("other"))).toBe(false)
	})

	it("forgets only the subdirectory an event concerns, and tells its feature", async () => {
		const { getDotFilenSubdir, handleDotFilenDriveEvent, onDotFilenSubdirForgotten, dotFilenSubdirUuid } = await fresh()
		const forgotten = vi.fn()

		onDotFilenSubdirForgotten("videos", forgotten)
		await getDotFilenSubdir("videos")
		await getDotFilenSubdir("playlists")

		handleDotFilenDriveEvent(driveEvent({ type: "folderTrash", parent: DOT_FILEN, uuid: SUBDIRS["videos"] ?? DOT_FILEN }))

		expect(forgotten).toHaveBeenCalledTimes(1)
		expect(dotFilenSubdirUuid("videos")).toBeNull()
		expect(dotFilenSubdirUuid("playlists")).toBe(SUBDIRS["playlists"])
	})

	it("forgets everything when .filen itself goes", async () => {
		const { getDotFilenSubdir, handleDotFilenDriveEvent, dotFilenSubdirUuid } = await fresh()

		await getDotFilenSubdir("videos")
		await getDotFilenSubdir("playlists")

		handleDotFilenDriveEvent(
			driveEvent({ type: "folderMetadataChanged", uuid: DOT_FILEN, meta: { type: "decoded", data: { name: "old" } } })
		)

		expect(dotFilenSubdirUuid("videos")).toBeNull()
		expect(dotFilenSubdirUuid("playlists")).toBeNull()
	})

	it("remembers files saved into a system directory, so a later uuid-only event is known as app data", async () => {
		const { getDotFilenSubdir, handleDotFilenDriveEvent, isDotFilenSystemFile } = await fresh()
		const file = testUuid("state")

		await getDotFilenSubdir("videos")

		expect(isDotFilenSystemFile(file)).toBe(false)

		handleDotFilenDriveEvent(
			driveEvent({
				type: "fileNew",
				file: {
					uuid: file,
					stableUUID: file,
					parent: SUBDIRS["videos"] ?? DOT_FILEN,
					size: 1n,
					favorited: false,
					region: "r",
					bucket: "b",
					timestamp: 0n,
					chunks: 1n,
					canMakeThumbnail: false,
					meta: {
						type: "decoded",
						data: { name: "library.v1.json", mime: "application/json", modified: 0n, size: 1n, key: "k", version: 2 }
					}
				}
			})
		)

		expect(isDotFilenSystemFile(file)).toBe(true)
	})

	it("drops everything at logout, a lookup in flight included", async () => {
		const { getDotFilenSubdir, resetDotFilen, dotFilenSubdirUuid } = await fresh()
		const pending = getDotFilenSubdir("videos")

		resetDotFilen()

		await expect(pending).resolves.toBe(SUBDIRS["videos"])
		expect(dotFilenSubdirUuid("videos")).toBeNull()

		await getDotFilenSubdir("videos")

		expect(findDirectoryUuid).toHaveBeenCalledTimes(4)
	})

	it("a `.filen` event reaches every consumer whatever order the socket host registered them in", async () => {
		vi.resetModules()

		const socket = await import("@/lib/sdk/socket")
		const dotFilen = await import("@/lib/dotFilen")
		const playlists = await import("@/features/audio/lib/playlists")
		const audioHandlers = await import("@/features/audio/lib/socketHandlers")
		const library = await import("@/features/videos/lib/library")
		let deliver: (event: SocketEvent) => void = () => undefined

		subscribeToSocket.mockImplementation(onEvent => {
			deliver = onEvent

			return Promise.resolve()
		})

		// The socket host's order: playlists' handler ahead of the `.filen` one and the library's.
		const unregister = [
			audioHandlers.registerPlaylistSocketHandlers(),
			dotFilen.registerDotFilenSocketHandlers(),
			library.registerLibraryConfigSocketHandlers()
		]

		await socket.socketBridge.start()
		await playlists.getPlaylistsDirectoryUuid()
		await dotFilen.getDotFilenSubdir("videos")
		await dotFilen.getDotFilenSubdir("chat-uploads")

		const playlistsForgotten = vi.fn()

		dotFilen.onDotFilenSubdirForgotten("playlists", playlistsForgotten)

		deliver(driveEvent({ type: "folderTrash", parent: testUuid("root"), uuid: DOT_FILEN }))

		expect(["playlists", "videos", "chat-uploads"].map(name => dotFilen.dotFilenSubdirUuid(name))).toEqual([null, null, null])
		expect(dotFilen.isDotFilenSystemDir(DOT_FILEN)).toBe(false)
		expect(playlistsForgotten).toHaveBeenCalledTimes(1)

		// Nothing is saved into the trashed directories: every lookup starts over from `.filen`.
		findDirectoryUuid.mockClear()
		await dotFilen.getDotFilenSubdir("chat-uploads")
		expect(findDirectoryUuid).toHaveBeenCalledTimes(2)

		for (const off of unregister) {
			off()
		}

		await socket.socketBridge.stop().catch(() => undefined)
	})

	it("forgetting one subdirectory keeps `.filen` while a sibling is resolved under it", async () => {
		const { getDotFilenSubdir, forgetDotFilenSubdir, isDotFilenSystemDir } = await fresh()

		await getDotFilenSubdir("videos")
		await getDotFilenSubdir("playlists")
		forgetDotFilenSubdir("playlists")

		expect(isDotFilenSystemDir(DOT_FILEN)).toBe(true)

		findDirectoryUuid.mockClear()
		await getDotFilenSubdir("playlists")
		expect(findDirectoryUuid).toHaveBeenCalledExactlyOnceWith(DOT_FILEN, "playlists")
	})

	it("a directory trashed elsewhere while a subdirectory lookup is out forgets nothing", async () => {
		const { getDotFilenSubdir, handleDotFilenDriveEvent, dotFilenSubdirUuid } = await fresh()
		const forgotten = vi.fn()

		await getDotFilenSubdir("playlists")

		let release: () => void = () => undefined

		findDirectoryUuid.mockImplementationOnce(
			(_parent, name) =>
				new Promise(resolve => {
					release = () => {
						resolve(SUBDIRS[name])
					}
				})
		)

		const { onDotFilenSubdirForgotten } = await import("@/lib/dotFilen")

		onDotFilenSubdirForgotten("playlists", forgotten)

		const pending = getDotFilenSubdir("videos")

		await Promise.resolve()
		// Its parent isn't `.filen`: it can't be the Videos directory being looked up.
		handleDotFilenDriveEvent(driveEvent({ type: "folderTrash", parent: testUuid("elsewhere"), uuid: testUuid("x") }))
		release()
		await pending

		expect(dotFilenSubdirUuid("videos")).toBe(SUBDIRS["videos"])
		expect(dotFilenSubdirUuid("playlists")).toBe(SUBDIRS["playlists"])
		expect(forgotten).not.toHaveBeenCalled()
	})

	it("only files that can't be photos count as app data, and one moved out stops counting", async () => {
		const { getDotFilenSubdir, handleDotFilenDriveEvent, isDotFilenSystemFile } = await fresh()
		const uploads = SUBDIRS["chat-uploads"] ?? DOT_FILEN

		await getDotFilenSubdir("chat-uploads")

		const json = driveFile(uploads, "state.json")
		const photo = driveFile(uploads, "holiday.jpg")

		handleDotFilenDriveEvent(driveEvent({ type: "fileNew", file: json }))
		handleDotFilenDriveEvent(driveEvent({ type: "fileNew", file: photo }))

		expect(isDotFilenSystemFile(json.uuid)).toBe(true)
		expect(isDotFilenSystemFile(photo.uuid)).toBe(false)

		handleDotFilenDriveEvent(driveEvent({ type: "fileMove", file: { ...json, parent: testUuid("elsewhere") } }))

		expect(isDotFilenSystemFile(json.uuid)).toBe(false)
	})

	it("a find creates nothing where nothing exists, and remembers no absence", async () => {
		const { findDotFilenSubdir, dotFilenSubdirUuid } = await fresh()

		existing = { dotFilen: false, subdirs: new Set() }

		await expect(findDotFilenSubdir("videos")).resolves.toBeNull()
		await expect(findDotFilenSubdir("videos")).resolves.toBeNull()

		expect(createDirectory).not.toHaveBeenCalled()
		expect(listDirectory).not.toHaveBeenCalled()
		expect(findDirectoryUuid.mock.calls).toEqual([
			[null, ".filen"],
			[null, ".filen"]
		])
		expect(dotFilenSubdirUuid("videos")).toBeNull()
	})

	it("a find of a missing subdirectory is one request per level and creates nothing", async () => {
		const { findDotFilenSubdir, isDotFilenSystemDir } = await fresh()

		existing.subdirs.clear()

		await expect(findDotFilenSubdir("videos")).resolves.toBeNull()

		expect(findDirectoryUuid.mock.calls).toEqual([
			[null, ".filen"],
			[DOT_FILEN, "videos"]
		])
		expect(createDirectory).not.toHaveBeenCalled()
		expect(listDirectory).not.toHaveBeenCalled()
		// The `.filen` it found is remembered.
		expect(isDotFilenSystemDir(DOT_FILEN)).toBe(true)
	})

	it("a found directory is remembered like a created one", async () => {
		const { findDotFilenSubdir, getDotFilenSubdir, dotFilenSubdirUuid } = await fresh()

		await expect(findDotFilenSubdir("videos")).resolves.toBe(SUBDIRS["videos"])
		expect(dotFilenSubdirUuid("videos")).toBe(SUBDIRS["videos"])

		const calls = lookups()

		await expect(getDotFilenSubdir("videos")).resolves.toBe(SUBDIRS["videos"])
		await expect(findDotFilenSubdir("videos")).resolves.toBe(SUBDIRS["videos"])
		expect(lookups()).toBe(calls)
	})

	it("a create joining a find that comes back empty creates", async () => {
		const { findDotFilenSubdir, getDotFilenSubdir } = await fresh()

		existing = { dotFilen: false, subdirs: new Set() }

		const finding = findDotFilenSubdir("videos")
		const creating = getDotFilenSubdir("videos")

		await expect(finding).resolves.toBeNull()
		await expect(creating).resolves.toBe(SUBDIRS["videos"])
		expect(createDirectory).toHaveBeenCalledTimes(2)
		// Only the find's own `.filen`: the create trusts its empty answer.
		expect(findDirectoryUuid).toHaveBeenCalledExactlyOnceWith(null, ".filen")
	})

	it("a write after an empty read creates without finding again; a read still finds", async () => {
		const { findDotFilenSubdir, getDotFilenSubdir } = await fresh()

		existing.subdirs.delete("videos")

		await expect(findDotFilenSubdir("videos")).resolves.toBeNull()
		findDirectoryUuid.mockClear()

		await expect(getDotFilenSubdir("videos")).resolves.toBe(SUBDIRS["videos"])

		expect(findDirectoryUuid).not.toHaveBeenCalled()
		expect(createDirectory).toHaveBeenCalledExactlyOnceWith(DOT_FILEN, "videos")
	})

	it("a read finds again after an empty one; a directory created elsewhere makes the next write find first", async () => {
		const { findDotFilenSubdir, getDotFilenSubdir, handleDotFilenDriveEvent } = await fresh()

		existing.subdirs.delete("videos")

		await expect(findDotFilenSubdir("videos")).resolves.toBeNull()
		await expect(findDotFilenSubdir("videos")).resolves.toBeNull()
		// `.filen` once (remembered), Videos twice.
		expect(findDirectoryUuid).toHaveBeenCalledTimes(3)

		existing.subdirs.add("videos")
		handleDotFilenDriveEvent(
			driveEvent({ type: "folderSubCreated", dir: { ...dir(SUBDIRS["videos"] ?? DOT_FILEN, "videos"), parent: DOT_FILEN } })
		)
		findDirectoryUuid.mockClear()

		await expect(getDotFilenSubdir("videos")).resolves.toBe(SUBDIRS["videos"])

		expect(findDirectoryUuid).toHaveBeenCalledExactlyOnceWith(DOT_FILEN, "videos")
		expect(createDirectory).not.toHaveBeenCalled()
	})

	it("a socket gap forgets every level and the worker's found directories, so the next use finds again", async () => {
		const { getDotFilenSubdir, handleDotFilenReconnecting, handleDotFilenAuthSuccess, dotFilenSubdirUuid, onDotFilenSubdirForgotten } =
			await fresh()
		const forgotten = vi.fn()

		onDotFilenSubdirForgotten("playlists", forgotten)

		// The session's first authSuccess forgets nothing.
		await getDotFilenSubdir("playlists")
		handleDotFilenAuthSuccess()
		expect(dotFilenSubdirUuid("playlists")).toBe(SUBDIRS["playlists"])
		expect(forgetFoundDirectories).not.toHaveBeenCalled()

		handleDotFilenReconnecting()

		expect(dotFilenSubdirUuid("playlists")).toBeNull()
		expect(forgetFoundDirectories).toHaveBeenCalledOnce()
		// The feature re-reads on reconnect itself.
		expect(forgotten).not.toHaveBeenCalled()

		// A lookup during the gap is forgotten again once it ends.
		await getDotFilenSubdir("playlists")
		handleDotFilenAuthSuccess()
		expect(dotFilenSubdirUuid("playlists")).toBeNull()
		expect(forgetFoundDirectories).toHaveBeenCalledTimes(2)

		findDirectoryUuid.mockClear()
		await getDotFilenSubdir("playlists")
		expect(findDirectoryUuid.mock.calls).toEqual([
			[null, ".filen"],
			[DOT_FILEN, "playlists"]
		])
		expect(createDirectory).not.toHaveBeenCalled()
	})

	it("with `.filen` unknown, a restored directory of a subdirectory's name forgets nothing", async () => {
		const { findDotFilenSubdir, handleDotFilenDriveEvent, onDotFilenSubdirForgotten } = await fresh()
		const forgotten = vi.fn()

		existing = { dotFilen: false, subdirs: new Set() }
		onDotFilenSubdirForgotten("videos", forgotten)
		await findDotFilenSubdir("videos")

		handleDotFilenDriveEvent(
			driveEvent({ type: "folderRestore", dir: { ...dir(testUuid("restored"), "videos"), parent: testUuid("anywhere") } })
		)

		expect(forgotten).not.toHaveBeenCalled()
	})

	it("a find under way when the directories are forgotten isn't remembered", async () => {
		const { findDotFilenSubdir, dotFilenSubdirUuid, forgetDotFilenSubdir } = await fresh()
		const finding = findDotFilenSubdir("videos")

		forgetDotFilenSubdir("videos")

		await expect(finding).resolves.toBe(SUBDIRS["videos"])
		expect(dotFilenSubdirUuid("videos")).toBeNull()
	})

	it("a restored subdirectory is found again and its feature told; a sibling and `.filen` are kept", async () => {
		const { getDotFilenSubdir, handleDotFilenDriveEvent, onDotFilenSubdirForgotten, dotFilenSubdirUuid, isDotFilenSystemDir } =
			await fresh()
		const forgotten = vi.fn()

		onDotFilenSubdirForgotten("videos", forgotten)
		await getDotFilenSubdir("videos")
		await getDotFilenSubdir("playlists")
		findDirectoryUuid.mockClear()

		handleDotFilenDriveEvent(driveEvent({ type: "folderRestore", dir: { ...dir(testUuid("restored"), "videos"), parent: DOT_FILEN } }))

		expect(forgotten).toHaveBeenCalledTimes(1)
		expect(dotFilenSubdirUuid("videos")).toBeNull()
		expect(dotFilenSubdirUuid("playlists")).toBe(SUBDIRS["playlists"])
		expect(isDotFilenSystemDir(DOT_FILEN)).toBe(true)

		await getDotFilenSubdir("videos")

		expect(findDirectoryUuid).toHaveBeenCalledExactlyOnceWith(DOT_FILEN, "videos")
		expect(createDirectory).not.toHaveBeenCalled()
	})

	it("a directory of a subdirectory's name restored elsewhere forgets nothing", async () => {
		const { getDotFilenSubdir, handleDotFilenDriveEvent, onDotFilenSubdirForgotten, dotFilenSubdirUuid } = await fresh()
		const forgotten = vi.fn()

		onDotFilenSubdirForgotten("videos", forgotten)
		await getDotFilenSubdir("videos")

		handleDotFilenDriveEvent(
			driveEvent({ type: "folderRestore", dir: { ...dir(testUuid("restored"), "videos"), parent: testUuid("elsewhere") } })
		)

		expect(forgotten).not.toHaveBeenCalled()
		expect(dotFilenSubdirUuid("videos")).toBe(SUBDIRS["videos"])
	})

	it("a `.filen` restored at the drive root forgets everything; one restored deeper forgets nothing", async () => {
		const { getDotFilenSubdir, handleDotFilenDriveEvent, onDotFilenSubdirForgotten, dotFilenSubdirUuid } = await fresh()
		const { queryClient } = await import("@/queries/client")
		const { ACCOUNT_QUERY_KEY } = await import("@/queries/account")
		const root = testUuid("root")
		const forgotten = vi.fn()

		queryClient.setQueryData(ACCOUNT_QUERY_KEY, { rootDirUuid: root })
		onDotFilenSubdirForgotten("playlists", forgotten)
		await getDotFilenSubdir("videos")
		await getDotFilenSubdir("playlists")

		handleDotFilenDriveEvent(
			driveEvent({ type: "folderRestore", dir: { ...dir(testUuid("nested"), ".filen"), parent: testUuid("elsewhere") } })
		)

		expect(forgotten).not.toHaveBeenCalled()
		expect(dotFilenSubdirUuid("videos")).toBe(SUBDIRS["videos"])

		handleDotFilenDriveEvent(driveEvent({ type: "folderRestore", dir: { ...dir(testUuid("restored"), ".filen"), parent: root } }))

		expect(forgotten).toHaveBeenCalledTimes(1)
		expect(dotFilenSubdirUuid("videos")).toBeNull()
		expect(dotFilenSubdirUuid("playlists")).toBeNull()
	})
})

describe(".filen subdirectory names", () => {
	// What a found subdirectory is actually called on the server.
	function named(names: Record<string, string>): void {
		getDirectory.mockImplementation(uuid => {
			const entry = Object.entries(SUBDIRS).find(([, value]) => value === uuid)

			return Promise.resolve(entry === undefined ? undefined : dir(entry[1], names[entry[0]] ?? entry[0]))
		})
		renameDirectory.mockImplementation((target, name) => Promise.resolve(dir(target.uuid, name)))
	}

	it("renames a subdirectory found under another case to its canonical name, once per device", async () => {
		named({ videos: "Videos" })

		const first = await fresh()

		await expect(first.getDotFilenSubdir("videos")).resolves.toBe(SUBDIRS["videos"])
		await vi.waitFor(() => {
			expect(renameDirectory).toHaveBeenCalledExactlyOnceWith(dir(SUBDIRS["videos"] ?? DOT_FILEN, "Videos"), "videos")
		})

		const second = await fresh()

		await second.getDotFilenSubdir("videos")
		await Promise.resolve()

		expect(getDirectory).toHaveBeenCalledOnce()
	})

	it("fetches nothing for a subdirectory a create handed back", async () => {
		existing.subdirs.delete("playlists")
		named({})

		const { getDotFilenSubdir } = await fresh()

		await getDotFilenSubdir("playlists")
		await Promise.resolve()

		expect(getDirectory).not.toHaveBeenCalled()
		expect(renameDirectory).not.toHaveBeenCalled()
	})

	it("still uses the subdirectory when the rename fails", async () => {
		named({ videos: "Videos" })
		renameDirectory.mockRejectedValue(new Error("offline"))

		const { findDotFilenSubdir } = await fresh()

		await expect(findDotFilenSubdir("videos")).resolves.toBe(SUBDIRS["videos"])
		await vi.waitFor(() => {
			expect(renameDirectory).toHaveBeenCalledOnce()
		})
	})

	it("falls back to the legacy Chat Uploads, renaming it rather than creating chat-uploads", async () => {
		existing.subdirs.delete("chat-uploads")
		findDirectoryUuid.mockImplementation((parent, name) =>
			parent !== null && name === "Chat Uploads" ? Promise.resolve(SUBDIRS["chat-uploads"]) : find(parent, name)
		)
		named({ "chat-uploads": "Chat Uploads" })

		const { getDotFilenSubdir } = await fresh()

		await expect(getDotFilenSubdir("chat-uploads")).resolves.toBe(SUBDIRS["chat-uploads"])
		expect(createDirectory).not.toHaveBeenCalled()
		await vi.waitFor(() => {
			expect(renameDirectory).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ uuid: SUBDIRS["chat-uploads"] }),
				"chat-uploads"
			)
		})
	})

	it("keeps chat-uploads when a legacy Chat Uploads stands beside it, looking no further", async () => {
		named({})

		const { getDotFilenSubdir } = await fresh()

		await getDotFilenSubdir("chat-uploads")

		expect(findDirectoryUuid.mock.calls).toEqual([
			[null, ".filen"],
			[DOT_FILEN, "chat-uploads"]
		])
	})

	it("keeps the memo through the rename's own echo", async () => {
		named({ videos: "Videos" })

		const { getDotFilenSubdir, dotFilenSubdirUuid, handleDotFilenDriveEvent } = await fresh()

		await getDotFilenSubdir("videos")
		handleDotFilenDriveEvent(
			driveEvent({
				type: "folderMetadataChanged",
				uuid: SUBDIRS["videos"] ?? DOT_FILEN,
				meta: { type: "decoded", data: { name: "videos" } }
			})
		)

		expect(dotFilenSubdirUuid("videos")).toBe(SUBDIRS["videos"])
	})
})
