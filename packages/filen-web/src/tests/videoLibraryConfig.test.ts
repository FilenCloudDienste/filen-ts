import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	LIBRARY_CONFIG_FILE_NAME,
	activeLibraryRoots,
	emptyLibraryConfig,
	withLibraryRoot,
	type LibraryConfigDoc
} from "@filen/shared/videos"
import type { Dir, File, FileVersion } from "@filen/sdk-rs"
import { driveEvent, driveFile, hexUuid } from "@/tests/support/videoDrive"

const ACCOUNT = hexUuid()
const DOT_FILEN = hexUuid()
const VIDEOS_DIR = hexUuid()

const { sdkApi } = vi.hoisted(() => ({
	sdkApi: {
		createDirectory: vi.fn<(parent: string | null, name: string) => Promise<Dir>>(),
		findDirectoryUuid: vi.fn<(parent: string | null, name: string) => Promise<string | undefined>>(),
		listDirectory: vi.fn<(target: { uuid: string }) => Promise<{ dirs: Dir[]; files: File[] }>>(),
		downloadFileBytes: vi.fn<(file: File) => Promise<Uint8Array>>(),
		uploadFileBytes: vi.fn<(parent: string, bytes: Uint8Array) => Promise<File>>(),
		listFileVersionsOp: vi.fn<(file: File) => Promise<FileVersion[]>>(),
		directoryRootChain: vi.fn<(uuid: string) => Promise<{ uuid: string; name: string }[] | null>>()
	}
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi }))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
const { persistQuery } = vi.hoisted(() => ({ persistQuery: vi.fn(() => Promise.resolve()) }))

vi.mock("@/queries/persist", () => ({ persister: { persistQuery }, noDiskPersister: undefined }))

import {
	LIBRARY_CONFIG_QUERY_KEY,
	checkLibraryRoot,
	ensureLibraryConfig,
	handleLibraryConfigDriveEvent,
	holdLibraryConfig,
	libraryConfigNeedsRead,
	persistLibraryConfigWatermark,
	resetLibraryConfig,
	setLibraryAccount,
	updateLibraryConfig,
	type LibraryConfigState
} from "@/features/videos/lib/library"
import { resetDotFilen } from "@/lib/dotFilen"
import { forgetDirectoryRootChains } from "@/lib/directoryRoots"
import { listVideosDir } from "@/features/videos/lib/videosDirListing"
import { queryClient } from "@/queries/client"

// The file on the drive: its versions by uuid, newest last.
let versions: { file: File; bytes: Uint8Array }[]
let eventId: bigint

function head(): File | undefined {
	return versions.at(-1)?.file
}

function put(bytes: Uint8Array): File {
	const stableUuid = head()?.stableUUID
	const file = driveFile(VIDEOS_DIR, LIBRARY_CONFIG_FILE_NAME, stableUuid === undefined ? {} : { stableUuid })

	versions.push({ file, bytes })

	return file
}

function encode(doc: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(doc))
}

function remoteDoc(): LibraryConfigDoc {
	return JSON.parse(new TextDecoder().decode(versions.at(-1)?.bytes)) as LibraryConfigDoc
}

function echo(file: File): void {
	handleLibraryConfigDriveEvent(driveEvent(++eventId, { type: "fileNew", file }))
}

function rooted(doc: LibraryConfigDoc, dirUuid: string, t: number, d: string): LibraryConfigDoc {
	return withLibraryRoot({ doc, dirUuid, type: "auto", enabled: true, stamp: { t, d }, now: t })
}

beforeEach(() => {
	queryClient.clear()
	resetLibraryConfig()
	resetDotFilen()
	setLibraryAccount(ACCOUNT)
	versions = []
	eventId = 10n
	sdkApi.createDirectory.mockImplementation((parent, name) =>
		Promise.resolve({ uuid: parent === null ? DOT_FILEN : VIDEOS_DIR, meta: { type: "decoded", data: { name } } } as Dir)
	)
	sdkApi.findDirectoryUuid.mockImplementation(parent => Promise.resolve(parent === null ? DOT_FILEN : VIDEOS_DIR))
	sdkApi.listDirectory.mockImplementation(target => {
		if (target.uuid === DOT_FILEN) {
			return Promise.resolve({ dirs: [{ uuid: VIDEOS_DIR, meta: { type: "decoded", data: { name: "Videos" } } } as Dir], files: [] })
		}

		const file = head()

		return Promise.resolve({ dirs: [], files: file === undefined ? [] : [file] })
	})
	sdkApi.downloadFileBytes.mockImplementation(file =>
		Promise.resolve(versions.find(version => version.file.uuid === file.uuid)?.bytes ?? new Uint8Array())
	)
	sdkApi.uploadFileBytes.mockImplementation((_parent, bytes) => {
		const file = put(bytes)

		echo(file)

		return Promise.resolve(file)
	})
})

describe("library config", () => {
	it("reads an absent file as an empty library and saves the first edit", async () => {
		await ensureLibraryConfig(eventId)

		const saved = await updateLibraryConfig((doc, stamp) =>
			withLibraryRoot({ doc, dirUuid: "root", type: "movies", enabled: true, stamp, now: 1 })
		)

		expect(sdkApi.uploadFileBytes).toHaveBeenCalledTimes(1)
		expect(activeLibraryRoots(remoteDoc()).map(root => root.dirUuid)).toEqual(["root"])
		expect(saved.headUuid).toBe(head()?.uuid)
		expect(libraryConfigNeedsRead()).toBe(false)
	})

	it("an own echo arriving after the upload resolves is not a remote change either", async () => {
		await ensureLibraryConfig(eventId)

		const sent: { file: File | null } = { file: null }

		sdkApi.uploadFileBytes.mockImplementationOnce((_parent, bytes) => {
			sent.file = put(bytes)

			return Promise.resolve(sent.file)
		})

		await updateLibraryConfig((doc, stamp) => rooted(doc, "root", stamp.t, stamp.d))

		if (sent.file !== null) {
			echo(sent.file)
		}

		expect(libraryConfigNeedsRead()).toBe(false)
	})

	it("a save from elsewhere landing after this tab's own, while it is in flight, is a remote change", async () => {
		await ensureLibraryConfig(eventId)

		sdkApi.uploadFileBytes.mockImplementationOnce((_parent, bytes) => {
			const own = put(bytes)

			echo(own)
			echo(put(encode(rooted(emptyLibraryConfig(), "elsewhere", 99, "z"))))

			return Promise.resolve(own)
		})

		await updateLibraryConfig((doc, stamp) => rooted(doc, "root", stamp.t, stamp.d))

		expect(libraryConfigNeedsRead()).toBe(true)
	})

	it("a read merges what another session's save went over back in, and saves the repair", async () => {
		await ensureLibraryConfig(eventId)
		await updateLibraryConfig((doc, stamp) => rooted(doc, "mine", stamp.t, stamp.d))

		// Another device saved its edit over ours, built on a copy without it.
		const theirs = put(encode(rooted(emptyLibraryConfig(), "theirs", 1, "z")))

		echo(theirs)
		sdkApi.uploadFileBytes.mockClear()

		const state = await ensureLibraryConfig(++eventId)

		expect(sdkApi.uploadFileBytes).toHaveBeenCalledTimes(1)
		expect(activeLibraryRoots(state.doc).map(root => root.dirUuid)).toEqual(["theirs", "mine"])
		expect(activeLibraryRoots(remoteDoc()).map(root => root.dirUuid)).toEqual(["theirs", "mine"])
	})

	it("never takes an unreadable head for an empty library: the newest readable version stands in", async () => {
		const good = put(encode(rooted(emptyLibraryConfig(), "root", 1, "a")))

		put(new TextEncoder().encode("{torn"))
		sdkApi.listFileVersionsOp.mockResolvedValue(
			[...versions]
				.reverse()
				.map(version => ({ ...version.file, metadata: version.file.meta, stableUUID: version.file.stableUUID }) as FileVersion)
		)

		const state = await ensureLibraryConfig(eventId)

		expect(activeLibraryRoots(state.doc).map(root => root.dirUuid)).toEqual(["root"])
		expect(sdkApi.downloadFileBytes).toHaveBeenLastCalledWith(expect.objectContaining({ uuid: good.uuid }), expect.any(String))
	})

	it("never saves over a head no version of which parses, nor records a watermark for it", async () => {
		const cachedDoc = rooted(emptyLibraryConfig(), "cached", 1, "a")

		queryClient.setQueryData(LIBRARY_CONFIG_QUERY_KEY, {
			account: ACCOUNT,
			doc: cachedDoc,
			dirUuid: VIDEOS_DIR,
			headUuid: null,
			watermark: null
		} satisfies LibraryConfigState)
		put(new TextEncoder().encode("{torn"))
		sdkApi.listFileVersionsOp.mockResolvedValue([])

		const state = await ensureLibraryConfig(eventId)

		expect(sdkApi.uploadFileBytes).not.toHaveBeenCalled()
		expect(activeLibraryRoots(state.doc).map(root => root.dirUuid)).toEqual(["cached"])
		expect(state.watermark).toBeNull()

		await expect(updateLibraryConfig((doc, stamp) => rooted(doc, "mine", stamp.t, stamp.d))).rejects.toThrow()

		persistQuery.mockClear()
		handleLibraryConfigDriveEvent(driveEvent(++eventId, { type: "trashEmpty" }))
		persistLibraryConfigWatermark()

		expect(sdkApi.uploadFileBytes).not.toHaveBeenCalled()
		expect(persistQuery).not.toHaveBeenCalled()
	})

	it("leaves a head written by a newer version alone, without reading its versions", async () => {
		put(encode(rooted(emptyLibraryConfig(), "old", 1, "a")))
		put(encode({ v: 2, roots: {}, prefs: {}, overrides: {} }))

		await ensureLibraryConfig(eventId)
		await expect(updateLibraryConfig((doc, stamp) => rooted(doc, "mine", stamp.t, stamp.d))).rejects.toThrow()

		expect(sdkApi.listFileVersionsOp).not.toHaveBeenCalled()
		expect(sdkApi.uploadFileBytes).not.toHaveBeenCalled()
		expect(remoteDoc().v).toBe(2)

		// Once another session saves a readable head, edits save again.
		echo(put(encode(rooted(emptyLibraryConfig(), "theirs", 2, "z"))))
		await ensureLibraryConfig(++eventId)
		await updateLibraryConfig((doc, stamp) => rooted(doc, "mine", stamp.t, stamp.d))

		expect(activeLibraryRoots(remoteDoc()).map(root => root.dirUuid)).toEqual(["theirs", "mine"])
	})

	it("takes the version its own save superseded (versioning off) for no change from elsewhere", async () => {
		await ensureLibraryConfig(eventId)
		await updateLibraryConfig((doc, stamp) => rooted(doc, "first", stamp.t, stamp.d))

		const before = head()

		sdkApi.uploadFileBytes.mockImplementationOnce((_parent, bytes) => {
			const own = put(bytes)

			if (before !== undefined) {
				handleLibraryConfigDriveEvent(
					driveEvent(++eventId, { type: "fileTrash", uuid: before.uuid, stableUUID: hexUuid(), newUUID: own.uuid })
				)
			}

			echo(own)

			return Promise.resolve(own)
		})
		await updateLibraryConfig((doc, stamp) => rooted(doc, "second", stamp.t, stamp.d))

		expect(libraryConfigNeedsRead()).toBe(false)
	})

	it("checks a root candidate against `.filen` and the current roots", async () => {
		const chains: Record<string, { uuid: string; name: string }[]> = {
			media: [
				{ uuid: "drive", name: "" },
				{ uuid: "media", name: "Media" }
			],
			movies: [
				{ uuid: "drive", name: "" },
				{ uuid: "media", name: "Media" },
				{ uuid: "movies", name: "Movies" }
			],
			state: [
				{ uuid: "drive", name: "" },
				{ uuid: "dot", name: ".filen" },
				{ uuid: "state", name: "Videos" }
			]
		}

		sdkApi.directoryRootChain.mockImplementation(uuid => Promise.resolve(chains[uuid] ?? null))
		await ensureLibraryConfig(eventId)
		await updateLibraryConfig((doc, stamp) => rooted(doc, "movies", stamp.t, stamp.d))

		await expect(checkLibraryRoot({ uuid: "media", ownDrive: true })).resolves.toEqual({
			ok: false,
			reason: "nested",
			replace: ["movies"]
		})
		await expect(checkLibraryRoot({ uuid: "state", ownDrive: true })).resolves.toEqual({ ok: false, reason: "systemDirectory" })
		await expect(checkLibraryRoot({ uuid: "gone", ownDrive: true })).resolves.toEqual({ ok: false, reason: "notFound" })
		await expect(checkLibraryRoot({ uuid: "media", ownDrive: false })).resolves.toEqual({ ok: false, reason: "notOwnDrive" })
	})

	it("resolves each directory's chain once, and again only after a directory event touching it", async () => {
		const chains: Record<string, { uuid: string; name: string }[]> = {
			media: [
				{ uuid: "drive", name: "" },
				{ uuid: "media", name: "Media" }
			],
			movies: [
				{ uuid: "drive", name: "" },
				{ uuid: "media", name: "Media" },
				{ uuid: "movies", name: "Movies" }
			]
		}

		sdkApi.directoryRootChain.mockClear()
		sdkApi.directoryRootChain.mockImplementation(uuid => Promise.resolve(chains[uuid] ?? null))
		await ensureLibraryConfig(eventId)
		await updateLibraryConfig((doc, stamp) => rooted(doc, "movies", stamp.t, stamp.d))

		await checkLibraryRoot({ uuid: "media", ownDrive: true })
		await checkLibraryRoot({ uuid: "media", ownDrive: true })

		expect(sdkApi.directoryRootChain).toHaveBeenCalledTimes(2)

		// Media trashed: every chain through it is read again.
		forgetDirectoryRootChains(
			driveEvent(++eventId, { type: "folderTrash", parent: hexUuid(), uuid: "media" as `${string}-${string}-${string}-${string}` })
		)
		await checkLibraryRoot({ uuid: "media", ownDrive: true })

		expect(sdkApi.directoryRootChain).toHaveBeenCalledTimes(4)
	})

	it("a save that went over another session's save folds it in and saves again", async () => {
		await ensureLibraryConfig(eventId)

		sdkApi.uploadFileBytes.mockImplementationOnce((_parent, bytes) => {
			// Theirs landed first, ours over it; both echo before ours resolves.
			echo(put(encode(rooted(emptyLibraryConfig(), "theirs", 5, "z"))))

			const own = put(bytes)

			echo(own)

			return Promise.resolve(own)
		})

		const state = await updateLibraryConfig((doc, stamp) => rooted(doc, "mine", stamp.t, stamp.d))

		expect(sdkApi.uploadFileBytes).toHaveBeenCalledTimes(2)
		expect(activeLibraryRoots(remoteDoc()).map(root => root.dirUuid)).toEqual(["theirs", "mine"])
		expect(activeLibraryRoots(state.doc).map(root => root.dirUuid)).toEqual(["theirs", "mine"])
	})

	it("an edit and a read that repairs run one after the other, neither undoing the other", async () => {
		await ensureLibraryConfig(eventId)
		await updateLibraryConfig((doc, stamp) => rooted(doc, "first", stamp.t, stamp.d))

		// Another session's save, made without "first", lands as the head.
		echo(put(encode(rooted(emptyLibraryConfig(), "theirs", 1, "z"))))

		const [edited] = await Promise.all([
			updateLibraryConfig((doc, stamp) => rooted(doc, "second", stamp.t, stamp.d)),
			ensureLibraryConfig(++eventId)
		])

		expect(activeLibraryRoots(remoteDoc()).map(root => root.dirUuid)).toEqual(["theirs", "first", "second"])
		expect(activeLibraryRoots(edited.doc).map(root => root.dirUuid)).toEqual(["theirs", "first", "second"])
	})

	it("doesn't record a watermark while its own save is out, nor once a sign-out started", async () => {
		await ensureLibraryConfig(eventId)

		let release: () => void = () => undefined

		sdkApi.uploadFileBytes.mockImplementationOnce(
			(_parent, bytes) =>
				new Promise(resolve => {
					release = () => {
						resolve(put(bytes))
					}
				})
		)

		const saving = updateLibraryConfig((doc, stamp) => rooted(doc, "root", stamp.t, stamp.d))

		await vi.waitFor(() => {
			expect(sdkApi.uploadFileBytes).toHaveBeenCalled()
		})
		persistQuery.mockClear()
		handleLibraryConfigDriveEvent(driveEvent(++eventId, { type: "trashEmpty" }))
		persistLibraryConfigWatermark()

		expect(persistQuery).not.toHaveBeenCalled()

		release()
		await saving
		persistQuery.mockClear()
		handleLibraryConfigDriveEvent(driveEvent(++eventId, { type: "trashEmpty" }))
		holdLibraryConfig()
		persistLibraryConfigWatermark()

		expect(persistQuery).not.toHaveBeenCalled()
	})

	it("shares one listing of the directory with a reader that asked before the read, never one from before it was asked", async () => {
		const videosListings = (): number => sdkApi.listDirectory.mock.calls.filter(([target]) => target.uuid === VIDEOS_DIR).length
		const before = videosListings()
		const askedBefore = performance.now()

		await ensureLibraryConfig(eventId)

		expect(videosListings()).toBe(before + 1)
		await listVideosDir(VIDEOS_DIR, askedBefore)
		expect(videosListings()).toBe(before + 1)

		// A read asked for later lists again; so does a reader asking after it.
		await updateLibraryConfig((doc, stamp) => rooted(doc, hexUuid(), stamp.t, stamp.d))
		handleLibraryConfigDriveEvent(driveEvent(eventId + 100n, { type: "trashEmpty" }))
		await ensureLibraryConfig(eventId + 200n)

		expect(videosListings()).toBe(before + 2)
		await listVideosDir(VIDEOS_DIR, performance.now())
		expect(videosListings()).toBe(before + 3)
	})

	it("ignores a cached configuration of another account", async () => {
		queryClient.setQueryData(LIBRARY_CONFIG_QUERY_KEY, {
			account: hexUuid(),
			doc: rooted(emptyLibraryConfig(), "someone-elses", 1, "x"),
			dirUuid: VIDEOS_DIR,
			headUuid: null,
			watermark: eventId
		} satisfies LibraryConfigState)

		expect(libraryConfigNeedsRead()).toBe(true)

		const state = await ensureLibraryConfig(eventId)

		// Both levels found by name, then only the Videos directory listed.
		expect(sdkApi.findDirectoryUuid).toHaveBeenCalledTimes(2)
		expect(sdkApi.listDirectory).toHaveBeenCalledExactlyOnceWith({ kind: "uuid", uuid: VIDEOS_DIR })
		expect(activeLibraryRoots(state.doc)).toEqual([])
		expect(sdkApi.uploadFileBytes).not.toHaveBeenCalled()
	})
})
