// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LIBRARY_CONFIG_FILE_NAME, emptyLibraryConfig, withLibraryRoot, type LibraryConfigDoc } from "@filen/shared/videos"
import type { Dir, DirsAndFiles, File } from "@filen/sdk-rs"
import { VideoIndexEngine, WALK_FLOOR_MS, type SnapshotStore } from "@/workers/videoIndex/engine"
import { readSnapshotHeader } from "@/workers/videoIndex/snapshot.logic"
import { WalkCoordinator } from "@/workers/walkCoordinator"
import { FakeDrive, driveEvent, driveFile, hexUuid } from "@/tests/support/videoDrive"
import { catalogTitles, memoryCatalogStore } from "@/tests/support/videoIndex"

// Every network call the library makes, by kind. Walks count the coordinator's runs: a joined walk is not a
// second request.
const counts = vi.hoisted(() => ({
	walks: 0,
	lastEventIds: 0,
	getFile: 0,
	findDirectoryUuid: 0,
	createDirectory: 0,
	// `.filen` listed, which finding its Videos directory never needs; listDirectory counts the Videos directory's.
	listDotFilen: 0,
	listDirectory: 0,
	downloads: 0,
	uploads: 0,
	probes: 0
}))

const { sdkApi } = vi.hoisted(() => ({ sdkApi: {} }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi }))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
vi.mock("@/lib/storage/leader", () => ({ storageRole: () => "leader", onStorageLeadershipChange: () => () => undefined }))
vi.mock("@/queries/persist", () => ({
	noDiskPersister: (queryFn: (context: unknown) => unknown, context: unknown) => queryFn(context),
	persister: { persistQuery: () => Promise.resolve() }
}))

import { queryClient } from "@/queries/client"
import { videoLibrary } from "@/features/videos/lib/index"
import {
	LIBRARY_CONFIG_QUERY_KEY,
	handleLibraryConfigDriveEvent,
	resetLibraryConfig,
	type LibraryConfigState
} from "@/features/videos/lib/library"
import { saveLibraryConfig } from "@/features/videos/queries/library"
import { resetDotFilen } from "@/lib/dotFilen"

const ACCOUNT = hexUuid()
const DOT_FILEN = hexUuid()
const VIDEOS_DIR = hexUuid()

let drive: FakeDrive
let latest: bigint
let clock: number
let snapshots: Map<string, [Uint8Array | null, Uint8Array | null]>
let catalogStore: ReturnType<typeof memoryCatalogStore>
let engine: VideoIndexEngine
let coordinator: WalkCoordinator<DirsAndFiles>
let rootA: string
let rootB: string
let configFile: File | null
// What exists of `.filen/videos` on the server: neither, `.filen` alone, or both.
let existing: "none" | "dotFilen" | "both"

function requests(): number {
	return (
		counts.walks +
		counts.lastEventIds +
		counts.getFile +
		counts.findDirectoryUuid +
		counts.createDirectory +
		counts.listDotFilen +
		counts.listDirectory +
		counts.downloads +
		counts.uploads
	)
}

function resetCounts(): void {
	for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
		counts[key] = 0
	}
}

const store: SnapshotStore = {
	readSlot: (rootUuid, slot) => Promise.resolve(snapshots.get(rootUuid)?.[slot] ?? null),
	readGenerations: rootUuid => {
		const [a, b] = snapshots.get(rootUuid) ?? [null, null]

		return Promise.resolve([
			a === null ? null : (readSnapshotHeader(a)?.generation ?? null),
			b === null ? null : (readSnapshotHeader(b)?.generation ?? null)
		])
	},
	readWatermark: () => Promise.resolve(null),
	writeWatermark: () => Promise.resolve(),
	write: (rootUuid, slot, bytes) => {
		const slots = snapshots.get(rootUuid) ?? [null, null]

		slots[slot] = bytes
		snapshots.set(rootUuid, slots)

		return Promise.resolve()
	},
	remove: rootUuid => {
		snapshots.delete(rootUuid)

		return Promise.resolve()
	}
}

// A fresh worker: a new engine over the same drive and the same OPFS snapshots.
function startWorker(): void {
	coordinator = new WalkCoordinator(uuid => {
		counts.walks++

		return Promise.resolve(drive.walk(uuid))
	})
	engine = new VideoIndexEngine({
		walkRoot: async (uuid, startedAfter) => ({
			type: "ok",
			name: "Root",
			raw: await coordinator.walk(uuid, startedAfter),
			ancestors: []
		}),
		walkMark: () => coordinator.mark(),
		walkDir: uuid => coordinator.walk(uuid),
		lastDriveEventId: () => {
			counts.lastEventIds++

			return Promise.resolve(latest)
		},
		driveRoot: () => null,
		getFile: uuid => {
			counts.getFile++

			return Promise.resolve(drive.files.get(uuid))
		},
		store,
		catalogStore,
		now: () => clock,
		yieldSlice: () => Promise.resolve()
	})

	Object.assign(sdkApi, {
		videoCatalogSetWatch: (update: Parameters<VideoIndexEngine["setWatch"]>[0]) => {
			engine.setWatch(update)

			return Promise.resolve()
		},
		videoCatalogSetFacts: (update: Parameters<VideoIndexEngine["setFacts"]>[0]) => engine.setFacts(update),
		videoIndexAccount: () => Promise.resolve(ACCOUNT),
		getLastDriveEventId: () => {
			counts.lastEventIds++

			return Promise.resolve(latest)
		},
		videoIndexConfigure: engine.configure.bind(engine),
		videoIndexCheck: engine.check.bind(engine),
		videoIndexSubscribe: (listener: Parameters<VideoIndexEngine["subscribe"]>[0]) => {
			engine.subscribe(listener)
		},
		videoIndexSetWriter: engine.setWriter.bind(engine),
		videoIndexFlush: engine.flush.bind(engine),
		listVideoRoot: async (uuid: string, options: { rescan: boolean }) => {
			await (options.rescan ? engine.rescan(uuid) : engine.check())

			return null
		},
		readVideoProbe: () => {
			counts.probes++

			return Promise.resolve(null)
		},
		findDirectoryUuid: (parent: string | null) => {
			counts.findDirectoryUuid++

			if (parent === null) {
				return Promise.resolve(existing === "none" ? undefined : DOT_FILEN)
			}

			return Promise.resolve(existing === "both" ? VIDEOS_DIR : undefined)
		},
		createDirectory: (parent: string | null, name: string) => {
			counts.createDirectory++

			existing = parent === null ? (existing === "none" ? "dotFilen" : existing) : "both"

			return Promise.resolve({ uuid: parent === null ? DOT_FILEN : VIDEOS_DIR, meta: { type: "decoded", data: { name } } } as Dir)
		},
		listDirectory: (target: { uuid: string }) => {
			if (target.uuid === DOT_FILEN) {
				counts.listDotFilen++

				return Promise.resolve({
					dirs: existing === "both" ? [{ uuid: VIDEOS_DIR, meta: { type: "decoded", data: { name: "Videos" } } } as Dir] : [],
					files: []
				})
			}

			counts.listDirectory++

			return Promise.resolve({ dirs: [], files: configFile === null ? [] : [configFile] })
		},
		downloadFileBytes: () => {
			counts.downloads++

			return Promise.resolve(new TextEncoder().encode(JSON.stringify(currentDoc)))
		},
		uploadFileBytes: async (_parent: string, bytes: Uint8Array) => {
			counts.uploads++
			currentDoc = JSON.parse(new TextDecoder().decode(bytes)) as LibraryConfigDoc
			configFile = driveFile(VIDEOS_DIR, LIBRARY_CONFIG_FILE_NAME)
			// The upload's own echo, before the call resolves.
			deliver(driveEvent(++latest, { type: "fileNew", file: configFile }))
			await Promise.resolve()

			return configFile
		}
	})
}

let currentDoc: LibraryConfigDoc

function deliver(event: Parameters<VideoIndexEngine["onSocketEvent"]>[0]): void {
	if (event.type === "drive" || event.type === "driveMalformed") {
		coordinator.invalidate()
	}

	engine.onSocketEvent(event)

	if (event.type === "drive") {
		handleLibraryConfigDriveEvent(event)
	}
}

// The page going away: pending snapshot writes and the configuration's watermark land.
async function pageHide(): Promise<void> {
	window.dispatchEvent(new Event("pagehide"))
	await vi.advanceTimersByTimeAsync(0)
}

// A new page load: the worker, the main-thread caches and the module state start over; the drive, the OPFS
// snapshots and the persisted query cache stay.
function reload(): void {
	const persisted = queryClient.getQueryData<LibraryConfigState>(LIBRARY_CONFIG_QUERY_KEY)

	videoLibrary.reset()
	resetLibraryConfig()
	resetDotFilen()
	queryClient.clear()

	if (persisted !== undefined) {
		queryClient.setQueryData(LIBRARY_CONFIG_QUERY_KEY, persisted)
	}

	startWorker()
	engine.onSocketEvent({ type: "authSuccess" })
}

async function open(): Promise<void> {
	await videoLibrary.open()
	await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
	resetCounts()
	drive = new FakeDrive()
	latest = 1_000n
	clock = 1_800_000_000_000
	snapshots = new Map()
	catalogStore = memoryCatalogStore()
	configFile = null
	existing = "both"
	rootA = drive.addDir(hexUuid(), "Movies")
	rootB = drive.addDir(hexUuid(), "Shows")

	const heat = drive.addDir(rootA, "Heat (1995)")

	drive.addFile(heat, "Heat (1995).mkv")
	drive.addFile(heat, "poster.jpg")
	drive.addFile(rootA, "holiday.jpg")
	drive.addFile(rootA, "notes.txt")

	const season = drive.addDir(drive.addDir(rootB, "Show"), "Season 1")

	drive.addFile(season, "Show S01E01.mkv")
	drive.addFile(season, "Show S01E02.mkv")

	currentDoc = [rootA, rootB].reduce(
		(doc, dirUuid, index) =>
			withLibraryRoot({ doc, dirUuid, type: "auto", enabled: true, stamp: { t: index + 1, d: "seed" }, now: index }),
		emptyLibraryConfig()
	)

	// The configuration as a previous session read it, current to the drive's present state.
	queryClient.setQueryData(LIBRARY_CONFIG_QUERY_KEY, {
		account: ACCOUNT,
		doc: currentDoc,
		dirUuid: VIDEOS_DIR,
		headUuid: null,
		watermark: latest
	} satisfies LibraryConfigState)
	configFile = driveFile(VIDEOS_DIR, LIBRARY_CONFIG_FILE_NAME)
	reload()
})

afterEach(() => {
	videoLibrary.reset()
	vi.useRealTimers()
})

async function firstSession(): Promise<void> {
	await open()
	await pageHide()
	resetCounts()
}

describe("video library request counts", () => {
	it("first open: one event-id request, one walk per root, no configuration read when the drive hasn't changed", async () => {
		await open()

		expect(counts).toMatchObject({ walks: 2, lastEventIds: 1, listDirectory: 0, downloads: 0, uploads: 0 })
		expect((await catalogTitles(engine)).map(title => title.title).sort()).toEqual(["Heat", "Show"])
	})

	it("an open in a later session is one request and no walk when the watermark matches", async () => {
		await firstSession()
		reload()
		await open()

		expect(requests()).toBe(1)
		expect(counts.lastEventIds).toBe(1)
		expect(await catalogTitles(engine)).toHaveLength(2)
	})

	it("a later session walks again when the drive changed meanwhile (past the floor)", async () => {
		await firstSession()
		reload()
		latest += 5n
		clock += WALK_FLOOR_MS

		await open()

		expect(counts).toMatchObject({ walks: 2, lastEventIds: 1 })
	})

	it("opening again within the session costs nothing", async () => {
		await firstSession()
		await open()

		expect(requests()).toBe(0)
	})

	it("events outside every root cost nothing and keep the index current", async () => {
		await firstSession()

		const elsewhere = drive.addDir(hexUuid(), "Elsewhere")

		for (let i = 0; i < 20; i++) {
			const file = drive.addFile(elsewhere, `clip ${String(i)}.mkv`)

			deliver(driveEvent(++latest, { type: "fileNew", file }))
		}

		await vi.advanceTimersByTimeAsync(10_000)
		await open()

		expect(requests()).toBe(0)

		// The next session finds the snapshots and the configuration current to the latest event.
		await pageHide()
		reload()
		await open()

		expect(requests()).toBe(1)
	})

	it("a new video in a root is patched in without a request", async () => {
		await firstSession()

		const file = drive.addFile(rootA, "Ronin (1998).mkv")

		deliver(driveEvent(++latest, { type: "fileNew", file }))
		await vi.advanceTimersByTimeAsync(5_000)

		expect(requests()).toBe(0)
		expect((await catalogTitles(engine)).map(title => title.title)).toContain("Ronin")
	})

	it("a file renamed into a video name anywhere costs one lookup", async () => {
		await firstSession()

		const file = drive.addFile(rootA, "ronin.part")

		deliver(
			driveEvent(++latest, {
				type: "fileMetadataChanged",
				uuid: file.uuid,
				metadata: {
					type: "decoded",
					data: { name: "Ronin (1998).mkv", mime: "video/x-matroska", modified: 0n, size: 2_000_000_000n, key: "k", version: 3 }
				}
			})
		)
		await vi.advanceTimersByTimeAsync(5_000)

		expect(counts.getFile).toBe(1)
		expect(requests()).toBe(1)
	})

	it("never probes a file while scanning", async () => {
		await open()

		expect(counts.probes).toBe(0)
	})

	it("its own configuration save is no reason to read the configuration again", async () => {
		await firstSession()
		await saveLibraryConfig((doc, stamp) => withLibraryRoot({ doc, dirUuid: rootB, type: "shows", enabled: true, stamp, now: clock }))

		expect(counts.uploads).toBe(1)
		resetCounts()

		await open()

		expect(requests()).toBe(0)
	})

	it("an edit that changes nothing uploads nothing", async () => {
		await firstSession()
		await saveLibraryConfig(doc => doc)

		expect(counts.uploads).toBe(0)
	})

	it("another session's save is read once, on the next open", async () => {
		await firstSession()

		const foreign = driveFile(VIDEOS_DIR, LIBRARY_CONFIG_FILE_NAME)

		configFile = foreign
		deliver(driveEvent(++latest, { type: "fileNew", file: foreign }))

		await open()

		expect(counts).toMatchObject({ listDirectory: 1, downloads: 1, uploads: 0 })
	})

	it("a gap in the event stream walks the root again, at most once per floor", async () => {
		await firstSession()

		latest += 2n
		deliver(driveEvent(latest, { type: "trashEmpty" }))
		await vi.advanceTimersByTimeAsync(0)

		// Both roots were walked moments ago: the floor holds the walk back until it passes.
		expect(counts.walks).toBe(0)

		clock += WALK_FLOOR_MS
		await vi.advanceTimersByTimeAsync(WALK_FLOOR_MS)

		expect(counts.walks).toBe(2)
	})
})

describe("sign-out in another tab", () => {
	it("stops this tab's snapshot writes and watermark persistence", async () => {
		await open()

		localStorage.setItem("filen.signOutPending", "1")
		window.dispatchEvent(new StorageEvent("storage", { key: "filen.signOutPending", newValue: "1" }))
		// The walk's snapshot write was due in seconds.
		await vi.advanceTimersByTimeAsync(120_000)

		expect(snapshots.size).toBe(0)

		await pageHide()

		expect(snapshots.size).toBe(0)

		localStorage.removeItem("filen.signOutPending")
	})
})

describe("walk sharing", () => {
	it("a Photos walk and a Videos walk of the same root are one request", async () => {
		await open()

		// Photos joins the walk the index just made; a drive event ends the sharing.
		await coordinator.walk(rootA)
		expect(counts.walks).toBe(2)

		deliver(driveEvent(++latest, { type: "trashEmpty" }))
		await coordinator.walk(rootA)
		expect(counts.walks).toBe(3)
	})

	it("the index doesn't adopt a walk begun before it read the watermark, nor one from before a reconnect", async () => {
		await coordinator.walk(rootA)
		await open()

		// rootA's earlier walk may predate the watermark the index stamps its walk with.
		expect(counts.walks).toBe(3)

		await coordinator.walk(rootB)
		engine.onSocketEvent({ type: "reconnecting" })
		coordinator.invalidate()
		await coordinator.walk(rootB)

		expect(counts.walks).toBe(4)
	})

	it("a walk is not reused once its reuse window has passed", async () => {
		await coordinator.walk(rootA)
		await vi.advanceTimersByTimeAsync(10_001)
		await coordinator.walk(rootA)

		expect(counts.walks).toBe(2)
	})

	it("a fresh account's first open is the event id and one existence check, and creates nothing", async () => {
		existing = "none"
		configFile = null
		queryClient.clear()
		reload()

		await open()

		expect(counts).toMatchObject({ lastEventIds: 1, findDirectoryUuid: 1, createDirectory: 0, listDirectory: 0, walks: 0 })
		expect(existing).toBe("none")
	})

	it("an account with `.filen` but no Videos directory checks both levels and still creates nothing", async () => {
		existing = "dotFilen"
		configFile = null
		queryClient.clear()
		reload()

		await open()

		// One find per level, no listing of `.filen`.
		expect(counts).toMatchObject({ lastEventIds: 1, findDirectoryUuid: 2, createDirectory: 0, listDotFilen: 0, listDirectory: 0 })
		expect(existing).toBe("dotFilen")
	})

	it("the first save creates the directory", async () => {
		existing = "none"
		configFile = null
		queryClient.clear()
		reload()
		await open()
		resetCounts()

		await saveLibraryConfig((doc, stamp) => withLibraryRoot({ doc, dirUuid: rootA, type: "movies", enabled: true, stamp, now: clock }))

		// The open's empty find stands: both levels are created without finding again.
		expect(counts).toMatchObject({ findDirectoryUuid: 0, createDirectory: 2, uploads: 1 })
		expect(existing).toBe("both")
	})

	it("a configuration first saved elsewhere while the directory was unknown is read on the next open", async () => {
		existing = "none"
		configFile = null
		queryClient.clear()
		reload()
		await open()

		existing = "both"
		configFile = driveFile(VIDEOS_DIR, LIBRARY_CONFIG_FILE_NAME)
		deliver(driveEvent(++latest, { type: "fileNew", file: configFile }))
		await pageHide()
		reload()
		resetCounts()
		await open()

		expect(counts.listDirectory).toBe(1)
		expect(counts.downloads).toBe(1)
		expect(
			videoLibrary
				.getSnapshot()
				.roots.map(root => root.uuid)
				.sort()
		).toEqual([rootA, rootB].sort())
	})
})
