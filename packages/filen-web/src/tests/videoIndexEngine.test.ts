import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DirsAndFiles } from "@filen/sdk-rs"
import { CLASSIFIER_VERSION, HLC_SPAN, itemKey, type ItemRec, type LibraryOverride } from "@filen/shared/videos"
import {
	CatalogCallAbandoned,
	VideoIndexEngine,
	type IndexRootConfig,
	type SnapshotStore,
	type SnapshotWatermark
} from "@/workers/videoIndex/engine"
import { SNAPSHOT_HEADER_BYTES, crc32, decodeSnapshot, readSnapshotHeader } from "@/workers/videoIndex/snapshot.logic"
import { LOOKUP_RETRY_MS, WALK_FLOOR_MS } from "@/workers/videoIndex/engine"
import type { VideoTitleView } from "@/workers/videoIndex/view.logic"
import { FakeDrive, driveDir, driveEvent, driveFile, hexUuid } from "@/tests/support/videoDrive"
import { memoryCatalogStore, trackCatalogTitles } from "@/tests/support/videoIndex"
import { decodeCatalog, encodeCatalog, readCatalogHeader } from "@/workers/videoIndex/catalogFile.logic"
import { VideoCatalog, allItems, allTitles, catalogContent, type GridQuery } from "@/workers/videoIndex/catalog.logic"
import { DEFAULT_GRID_PREFS } from "@/features/videos/lib/videoGrid.logic"
import { referenceGrid, referenceHome, referenceSearch } from "@/tests/support/videoReference/compose"

let drive: FakeDrive
let latest: bigint
let snapshots: Map<string, [Uint8Array | null, Uint8Array | null]>
let watermarks: Map<string, SnapshotWatermark>
let slotReads: number
let walkGate: Promise<void>
// Holds back snapshot reads (a large root still loading).
let readGate: Promise<void>
let calls: { walks: number; lastEventIds: number; getFile: number }
let titles: Map<string, VideoTitleView>
let walkFails: number
let walkResult: (raw: DirsAndFiles) => DirsAndFiles
let writeFailures: number
let driveRootUuid: string | null
let lastIdFails: number
let goneRoots: Set<string>
// Holds back snapshot slot writes (a large root still encoding or waiting for the lock).
let writeGate: Promise<void>
let getFileFails: number
// Holds back file lookups (a slow network).
let getFileGate: Promise<void>

function ancestorsOf(uuid: string): string[] {
	const out: string[] = []

	for (let parent = drive.dirs.get(uuid)?.parent; parent !== undefined; parent = drive.dirs.get(parent)?.parent) {
		out.push(parent)
	}

	return out
}

const store: SnapshotStore = {
	readSlot: async (rootUuid, slot) => {
		await readGate
		slotReads++

		return snapshots.get(rootUuid)?.[slot] ?? null
	},
	readWatermark: rootUuid => Promise.resolve(watermarks.get(rootUuid) ?? null),
	writeWatermark: (rootUuid, mark, cancelled) => {
		if (!cancelled()) {
			watermarks.set(rootUuid, mark)
		}

		return Promise.resolve()
	},
	readGenerations: rootUuid => {
		const [a, b] = snapshots.get(rootUuid) ?? [null, null]

		return Promise.resolve([
			a === null ? null : (readSnapshotHeader(a)?.generation ?? null),
			b === null ? null : (readSnapshotHeader(b)?.generation ?? null)
		])
	},
	write: async (rootUuid, slot, bytes, cancelled) => {
		await writeGate

		if (writeFailures > 0) {
			writeFailures--

			throw new Error("quota")
		}

		// As the OPFS store does under its lock: a cancelled write leaves the slot (and its file) as it was.
		if (cancelled()) {
			return
		}

		const slots = snapshots.get(rootUuid) ?? [null, null]

		slots[slot] = bytes
		snapshots.set(rootUuid, slots)
	},
	remove: rootUuid => {
		snapshots.delete(rootUuid)
		watermarks.delete(rootUuid)

		return Promise.resolve()
	}
}

function engineFor(catalogStore = memoryCatalogStore(), yieldSlice = () => Promise.resolve()): VideoIndexEngine {
	const engine = new VideoIndexEngine({
		walkRoot: async uuid => {
			calls.walks++

			const raw: DirsAndFiles = drive.walk(uuid)
			const meta = drive.dirs.get(uuid)?.meta

			await walkGate

			if (goneRoots.has(uuid)) {
				return { type: "gone" }
			}

			if (walkFails > 0) {
				walkFails--

				throw new Error("network")
			}

			return { type: "ok", name: meta?.type === "decoded" ? meta.data.name : "", raw: walkResult(raw), ancestors: ancestorsOf(uuid) }
		},
		walkMark: () => 0,
		walkDir: uuid => Promise.resolve(drive.walk(uuid)),
		lastDriveEventId: () => {
			calls.lastEventIds++

			if (lastIdFails > 0) {
				lastIdFails--

				return Promise.reject(new Error("offline"))
			}

			return Promise.resolve(latest)
		},
		driveRoot: () => driveRootUuid,
		getFile: async uuid => {
			calls.getFile++

			await getFileGate

			if (getFileFails > 0) {
				getFileFails--

				throw new Error("network")
			}

			return drive.files.get(uuid)
		},
		store,
		catalogStore,
		now: () => Date.now(),
		yieldSlice
	})

	engine.onSocketEvent({ type: "authSuccess" })
	trackCatalogTitles(engine, titles)

	return engine
}

async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(6_000)
}

function roots(...entries: [string, IndexRootConfig["type"]][]): IndexRootConfig[] {
	return entries.map(([uuid, type]) => ({ uuid, type, enabled: true }))
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	drive = new FakeDrive()
	latest = 50n
	snapshots = new Map()
	watermarks = new Map()
	slotReads = 0
	walkGate = Promise.resolve()
	readGate = Promise.resolve()
	calls = { walks: 0, lastEventIds: 0, getFile: 0 }
	titles = new Map()
	walkFails = 0
	walkResult = raw => raw
	writeFailures = 0
	driveRootUuid = null
	lastIdFails = 0
	goneRoots = new Set()
	writeGate = Promise.resolve()
	getFileFails = 0
	getFileGate = Promise.resolve()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("library index classification", () => {
	it("merges a title found in two roots by title and year, and keeps a yearless one per root", async () => {
		const a = drive.addDir(hexUuid(), "Films")
		const b = drive.addDir(hexUuid(), "More films")

		drive.addFile(drive.addDir(a, "Heat (1995)"), "Heat (1995).mkv")
		drive.addFile(drive.addDir(b, "Heat (1995)"), "Heat (1995) - 2160p.mkv")
		drive.addFile(drive.addDir(a, "Untitled"), "Untitled.mkv")
		drive.addFile(drive.addDir(b, "Untitled"), "Untitled.mkv")

		const engine = engineFor()

		await engine.configure(roots([a, "auto"], [b, "auto"]))
		await engine.check(latest)
		await settle()

		const heat = [...titles.values()].filter(title => title.title === "Heat")

		expect(heat).toHaveLength(1)
		expect(heat[0]?.roots.sort()).toEqual([a, b].sort())
		expect([...titles.values()].filter(title => title.title === "Untitled")).toHaveLength(2)
	})

	it("honours a root's type override", async () => {
		const root = drive.addDir(hexUuid(), "Stuff")

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")

		const engine = engineFor()

		await engine.configure(roots([root, "other"]))
		await engine.check(latest)
		await settle()

		expect([...titles.values()].map(title => title.kind)).toEqual(["other"])
	})

	it("serves a series' episodes on request, keyless", async () => {
		const root = drive.addDir(hexUuid(), "Shows")
		const season = drive.addDir(drive.addDir(root, "Show"), "Season 1")

		drive.addFile(season, "Show S01E01.mkv")
		drive.addFile(season, "Show S01E02.mkv")
		drive.addFile(season, "Show S01E02.en.srt")

		const engine = engineFor()

		await engine.configure(roots([root, "auto"]))
		await engine.check(latest)
		await settle()

		const show = [...titles.values()].find(title => title.kind === "series")
		const detail = show === undefined ? null : await engine.titleDetail(show.id)

		expect(detail?.kind).toBe("series")

		if (detail?.kind !== "series") {
			return
		}

		const episodes = detail.seasons[0]?.episodes ?? []

		expect(episodes.map(episode => episode.episode)).toEqual([1, 2])
		expect(episodes[1]?.versions[0]?.parts[0]?.subtitles.map(subtitle => subtitle.language)).toEqual(["en"])
		expect(JSON.stringify(detail)).not.toContain('"key"')
	})

	it("answers calls made after a failed classification from what is held, and waits for a rerun under way", async () => {
		const flush = (): Promise<void> =>
			new Promise(resolve => {
				setImmediate(resolve)
			})
		// Holds every slice of the rerun once `slow` lets its slices run out.
		let held: Promise<void> | null = null
		let open = (): void => undefined
		const engine = engineFor(memoryCatalogStore(), () => held ?? Promise.resolve())
		const root = drive.addDir(hexUuid(), "Films")
		const grid = { source: { kind: "movies" as const }, prefs: DEFAULT_GRID_PREFS, query: "", seed: 0 }
		let armed = false

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")
		// A correction the classification throws on, once.
		engine.setOverrides({
			get "m:heat"(): LibraryOverride {
				if (armed) {
					armed = false

					throw new Error("unhandled correction")
				}

				return {}
			}
		})
		armed = true
		await engine.configure(roots([root, "auto"]))
		await flush()

		let answered = false

		void engine.catalogGrid(grid, 0, 10).then(() => {
			answered = true
		})
		void engine.titleDetail("unknown").then(() => undefined)
		await flush()

		expect(armed).toBe(false)
		expect(answered).toBe(true)
		expect(await engine.titleDetail("unknown")).toBeNull()

		// A walk landing classifies again; its slices are held, so a call made meanwhile waits for it.
		let clock = performance.now()
		const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += 50))

		held = new Promise(resolve => {
			open = resolve
		})
		await engine.check(latest)
		await flush()

		let page: Awaited<ReturnType<VideoIndexEngine["catalogGrid"]>> | null = null

		void engine.catalogGrid(grid, 0, 10).then(result => {
			page = result
		})
		await flush()

		expect(page).toBeNull()

		now.mockRestore()
		held = null
		open()
		await settle()
		await flush()

		expect(page).toMatchObject({ total: 1 })
	})
})

describe("library index art", () => {
	it("names a title's art candidates by keyless refs", async () => {
		const root = drive.addDir(hexUuid(), "Films")
		const movie = drive.addDir(root, "Heat (1995)")
		const poster = drive.addFile(movie, "poster.jpg")

		drive.addFile(movie, "Heat (1995).mkv")

		const engine = engineFor()

		await engine.configure(roots([root, "auto"]))
		await engine.check(latest)
		await settle()

		const art = await engine.titleArt([...titles.keys()][0] ?? "", "p")

		expect(art?.candidates[0]).toEqual({ source: "sidecar", file: 0 })
		expect(art?.files[0]).toEqual({ stableUuid: poster.uuid, uuid: poster.uuid, name: "poster.jpg", size: Number(poster.size) })
		expect(JSON.stringify(art)).not.toContain('"key"')
	})

	it("announces a title whose card art alone changed (a video's own thumbnail added), and persists it", async () => {
		const root = drive.addDir(hexUuid(), "Films")
		const movie = drive.addDir(root, "Heat (1995)")

		drive.addFile(movie, "Heat (1995).mkv")
		drive.addFile(movie, "poster.jpg")

		const catalogStore = memoryCatalogStore()
		const engine = engineFor(catalogStore)
		const changed: (string[] | null)[] = []

		engine.setWriter(true)
		await engine.configure(roots([root, "auto"]))
		await engine.check(latest)
		await settle()
		await engine.flush()
		engine.subscribe(update => {
			if (update.type === "catalog") {
				changed.push(update.titles)
			}
		})

		const id = [...titles.keys()][0] ?? ""
		const before = titles.get(id)
		const sidecars = async (): Promise<string[]> =>
			((await engine.titleArt(id, "s"))?.files ?? []).map(file => file.name).filter(name => name.endsWith(".jpg"))

		expect(await sidecars()).toEqual([])

		engine.onSocketEvent(driveEvent(++latest, { type: "fileNew", file: drive.addFile(movie, "Heat (1995)-thumb.jpg") }))
		await settle()
		await engine.flush()

		// The title's view fields are as they were; its card art is not, and neither is its detail
		// hash, the part's thumb being a detail field.
		const now = titles.get(id)

		expect(before).toBeDefined()
		expect({ ...now, detailHash: 0 }).toEqual({ ...before, detailHash: 0 })
		expect(now?.detailHash).not.toBe(before?.detailHash)
		expect(await sidecars()).toEqual(["Heat (1995)-thumb.jpg"])
		// After the current state a subscriber is handed at once: that title alone.
		expect(changed).toEqual([null, [id]])
		expect(catalogStore.writes).toBe(2)
	})
})

describe("library index videos", () => {
	it("lists every version and episode for the home rows and search, keyless and without requests", async () => {
		const root = drive.addDir(hexUuid(), "Library")
		const movie = drive.addDir(root, "Heat (1995)")
		const season = drive.addDir(drive.addDir(root, "Lost"), "Season 1")

		drive.addFile(movie, "Heat (1995) - 1080p.mkv")
		drive.addFile(movie, "Heat (1995) - 2160p.mkv")

		const pilot = drive.addFile(season, "Lost S01E01 - Pilot.mkv")

		drive.addFile(season, "Lost S01E02.mkv")
		drive.addFile(drive.addDir(root, "Holiday Lisbon"), "VID_0001.mp4")

		const engine = engineFor()

		await engine.configure(roots([root, "auto"]))
		await engine.check(latest)
		await settle()

		const before = { ...calls }
		const heat = [...titles.values()].find(title => title.kind === "movie")
		const lost = [...titles.values()].find(title => title.kind === "series")
		const pilotResult = (await engine.catalogSearch("pilot")).groups.find(group => group.kind === "episodes")?.cards[0]?.item
		const lisbon = (await engine.catalogSearch("lisbon")).groups.find(group => group.kind === "other")?.cards[0]

		expect(await engine.catalogMarkTargets(heat?.id ?? "", null)).toHaveLength(2)
		expect(await engine.catalogMarkTargets(lost?.id ?? "", null)).toHaveLength(2)
		expect(pilotResult).toMatchObject({ titleId: lost?.id, season: 1, episode: 1, episodeTitle: "Pilot", folder: "Season 1" })
		expect(lisbon?.title.kind).toBe("other")
		const shown = JSON.stringify([
			await engine.catalogHome({ roots: [root], now: Date.now(), heroPreviousId: null, heroSeed: 0 }),
			await engine.catalogSearch("lost")
		])

		for (const file of drive.files.values()) {
			expect(shown).not.toContain(file.meta.type === "decoded" ? file.meta.data.key : "")
		}

		const still = await engine.itemArt(lost?.id ?? "", pilot.uuid, "s")

		expect(still?.files.map(file => file.uuid)).toEqual([pilot.uuid])
		expect(calls).toEqual(before)
	})
})

describe("library index catalog notices", () => {
	it("tells of each classification's changes, including ones no title view shows", async () => {
		const root = drive.addDir(hexUuid(), "Shows")
		const season = drive.addDir(drive.addDir(root, "Lost"), "Season 1")

		drive.addFile(season, "Lost S01E01.mkv")

		const second = drive.addFile(season, "Lost S01E02 - Tabula Rasa.mkv")
		const engine = engineFor()
		const notices: { version: number; titles: string[] | null }[] = []

		engine.subscribe(update => {
			if (update.type === "catalog") {
				notices.push({ version: update.version, titles: update.titles })
			}
		})

		await engine.configure(roots([root, "auto"]))
		await engine.check(latest)
		await settle()

		const before = notices.length

		expect(notices[0]).toEqual({ version: 1, titles: null })

		// A new version of the second episode: its file rotates, the series' title view stays the same.
		const version = driveFile(season, "Lost S01E02 - Tabula Rasa.mkv", { stableUuid: second.uuid, size: 5 })

		engine.onSocketEvent(
			driveEvent(++latest, { type: "fileArchived", uuid: second.uuid, stableUUID: second.uuid, newUUID: version.uuid })
		)
		engine.onSocketEvent(driveEvent(++latest, { type: "fileNew", file: version }))
		await settle()

		expect(notices.slice(before)).toEqual([{ version: before + 1, titles: [] }])
		expect((await engine.catalogSearch("tabula")).groups[0]?.cards[0]?.item).toMatchObject({ uuid: version.uuid, size: 5 })
	})
})

describe("library index persisted catalog", () => {
	async function firstSession(root: string, catalogStore: ReturnType<typeof memoryCatalogStore>): Promise<void> {
		const first = engineFor(catalogStore)

		first.setWriter(true)
		await first.configure(roots([root, "auto"]))
		await first.check(latest)
		await settle()
		await first.flush()
	}

	it("paints a cold open from the persisted catalog while the snapshots still load, and writes nothing new after", async () => {
		const root = drive.addDir(hexUuid(), "Films")

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")

		const catalogStore = memoryCatalogStore()

		await firstSession(root, catalogStore)

		expect(catalogStore.writes).toBe(1)

		let release = (): void => undefined

		readGate = new Promise(resolve => {
			release = resolve
		})

		const second = engineFor(catalogStore)

		second.setWriter(true)

		const configuring = second.configure(roots([root, "auto"]))
		const home = await second.catalogHome({ roots: [root], now: Date.now(), heroPreviousId: null, heroSeed: 0 })

		expect(home.rows.find(row => row.kind === "movies")?.cards.map(card => card.title.title)).toEqual(["Heat"])
		expect(second.rootStatuses()[0]?.state).toBe("loading")
		expect(calls.walks).toBe(1)

		// A card's art is looked up from the persisted catalog too, before the library is classified again.
		const heat = home.rows.find(row => row.kind === "movies")?.cards[0]?.title.id ?? ""
		const kept = await second.titleArt(heat, "p")

		release()
		await configuring
		await settle()
		await second.flush()

		expect(kept).not.toBeNull()
		expect(kept).toEqual(await second.titleArt(heat, "p"))
		// The classification behind it found the same library: nothing more is written.
		expect(catalogStore.writes).toBe(1)
		expect(second.rootStatuses()[0]?.state).toBe("ready")
	})

	it("answers from the persisted catalog and then the classification as the page's own composition would", async () => {
		const root = drive.addDir(hexUuid(), "Films")
		const heat = drive.addDir(root, "Heat (1995)")
		const season = drive.addDir(drive.addDir(root, "Lost"), "Season 1")

		drive.addFile(heat, "Heat (1995) - 1080p.mkv")
		drive.addFile(heat, "Heat (1995) - 2160p.mkv")
		drive.addFile(drive.addDir(root, "Alien (1979)"), "Alien (1979).mkv")
		drive.addFile(season, "Lost S01E01-E02 - Pilot.mkv")
		drive.addFile(season, "Lost S01E03.mkv")
		drive.addFile(drive.addDir(root, "Holiday Lisbon"), "VID_0001.mp4")

		const catalogStore = memoryCatalogStore()

		await firstSession(root, catalogStore)

		const bytes = catalogStore.slots.find(slot => slot !== null) ?? new Uint8Array(0)
		const decoded = decodeCatalog(bytes, readCatalogHeader(bytes)?.key ?? [0, 0])
		const library = {
			titles: decoded === null ? [] : allTitles(decoded.titles),
			items: decoded === null ? [] : allItems(decoded.items)
		}
		const at = Date.now() - 86_400_000
		const pilot = library.items.find(item => item.episodeEnd > item.episode)
		const version = library.items.find(item => item.label !== "")
		const records: Record<string, ItemRec> = {
			[itemKey(pilot?.stableUuid ?? "")]: {
				p: { t: at * HLC_SPAN, d: "dev", pos: 900, dur: 0, lp: at, u: pilot?.uuid ?? "", sz: pilot?.size ?? 0 }
			},
			[itemKey(version?.stableUuid ?? "")]: { w: { t: at * HLC_SPAN + 1, d: "dev", pl: true, pc: 1 } }
		}
		const facts = new Map([[pilot?.uuid ?? "", { durationSec: 2700, height: 1080 }]])
		const reference = { ...library, records, facts, lastPlayedCeilingMs: Date.now() }
		const homeQuery = { roots: [root], now: Date.now(), heroPreviousId: null, heroSeed: 0.5 }
		const gridQueries: GridQuery[] = [
			{ source: { kind: "movies" }, prefs: DEFAULT_GRID_PREFS, query: "", seed: 1 },
			{ source: { kind: "movies" }, prefs: { ...DEFAULT_GRID_PREFS, sort: "played" }, query: "", seed: 1 },
			{ source: { kind: "shows" }, prefs: { ...DEFAULT_GRID_PREFS, quality: "1080" }, query: "", seed: 1 },
			{ source: { kind: "root", uuid: root }, prefs: { ...DEFAULT_GRID_PREFS, sort: "runtime" }, query: "lo", seed: 1 }
		]
		const expectAsReference = async (engine: VideoIndexEngine): Promise<void> => {
			expect(await engine.catalogHome(homeQuery)).toEqual(referenceHome(reference, homeQuery))

			for (const query of gridQueries) {
				expect((await engine.catalogGrid(query, 0, 100)).cards).toEqual(referenceGrid(reference, query).cards)
			}

			for (const text of ["pilot", "lisbon", "heat"]) {
				expect((await engine.catalogSearch(text)).groups).toEqual(referenceSearch(reference, text))
			}
		}

		let release = (): void => undefined

		readGate = new Promise(resolve => {
			release = resolve
		})

		const second = engineFor(catalogStore)
		const configuring = second.configure(roots([root, "auto"]))

		second.setWatch({ reset: true, upserts: records, removed: [], lastPlayedCeilingMs: reference.lastPlayedCeilingMs })
		await second.setFacts({ reset: true, uuids: [...facts.keys()], durations: [2700], heights: [1080] })

		expect(pilot).toBeDefined()
		expect(version).toBeDefined()
		await expectAsReference(second)
		expect(second.rootStatuses()[0]?.state).toBe("loading")

		release()
		await configuring
		await settle()

		expect(second.rootStatuses()[0]?.state).toBe("ready")
		await expectAsReference(second)
	})

	it("rebuilds the orders when the classification places a title where the persisted catalog did not", async () => {
		const root = drive.addDir(hexUuid(), "Films")

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")
		drive.addFile(drive.addDir(root, "Ronin (1998)"), "Ronin (1998).mkv")

		const clip = drive.addFile(root, "clip.mp4")
		const overrides = { [`s:${clip.uuid}`]: { kind: "movie" as const, title: "A Clip", year: 2001, hidden: true } }
		const catalogStore = memoryCatalogStore()
		const first = engineFor(catalogStore)

		first.setWriter(true)
		first.setOverrides(overrides)
		await first.configure(roots([root, "auto"]))
		await first.check(latest)
		await settle()
		await first.flush()

		// The persisted copy holds the hidden title elsewhere (its own orders consistent with that).
		const slot = catalogStore.slots.findIndex(bytes => bytes !== null) as 0 | 1
		const header = readCatalogHeader(catalogStore.slots[slot] ?? new Uint8Array(0))
		const decoded = header === null ? null : decodeCatalog(catalogStore.slots[slot] ?? new Uint8Array(0), header.key)
		const titles = decoded === null ? [] : allTitles(decoded.titles)
		const moved = [...titles.filter(title => title.hidden === true), ...titles.filter(title => title.hidden !== true)]

		expect(titles.findIndex(title => title.hidden === true)).toBeGreaterThan(0)

		const content = catalogContent(moved, decoded === null ? [] : allItems(decoded.items))
		// The same card art, at the titles' new places.
		const art = {
			at: (index: number, slot: "p" | "s") =>
				decoded?.art.at(
					titles.findIndex(title => title === moved[index]),
					slot
				) ?? null
		}

		catalogStore.slots[slot] = encodeCatalog({
			content: { ...content, art },
			key: header?.key ?? [0, 0],
			generation: (header?.generation ?? 0n) + 1n
		})

		const second = engineFor(catalogStore)

		second.setWriter(true)
		second.setOverrides(overrides)
		await second.configure(roots([root, "auto"]))
		await settle()
		await second.flush()

		const home = await second.catalogHome({ roots: [root], now: Date.now(), heroPreviousId: null, heroSeed: 0 })
		const shown = home.rows.flatMap(row => row.cards.map(card => card.title.title))

		expect(shown).not.toContain("A Clip")
		expect(new Set(shown)).toEqual(new Set(["Heat", "Ronin"]))
		expect(catalogStore.writes).toBe(2)
	})

	it("reads only the newest catalog slot at a cold open, and the other when that one is torn", async () => {
		const root = drive.addDir(hexUuid(), "Films")

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")

		const catalogStore = memoryCatalogStore()

		await firstSession(root, catalogStore)

		const written = catalogStore.slots.findIndex(bytes => bytes !== null) as 0 | 1
		const intact = catalogStore.slots[written] ?? new Uint8Array(0)
		const header = readCatalogHeader(intact)

		// A newer write torn halfway in the other slot.
		const torn = encodeCatalog({
			content: catalogContent([], []),
			key: header?.key ?? [0, 0],
			generation: (header?.generation ?? 0n) + 1n
		})

		catalogStore.slots[written === 0 ? 1 : 0] = torn.slice(0, torn.length - 8)
		catalogStore.reads = 0

		const second = engineFor(catalogStore)

		void second.configure(roots([root, "auto"]))

		const home = await second.catalogHome({ roots: [root], now: Date.now(), heroPreviousId: null, heroSeed: 0 })

		expect(home.rows.some(row => row.cards.some(card => card.title.title === "Heat"))).toBe(true)
		expect(catalogStore.reads).toBe(2)

		catalogStore.slots[written === 0 ? 1 : 0] = null
		catalogStore.reads = 0

		const third = engineFor(catalogStore)

		void third.configure(roots([root, "auto"]))
		await third.catalogHome({ roots: [root], now: Date.now(), heroPreviousId: null, heroSeed: 0 })

		expect(catalogStore.reads).toBe(1)
	})

	it("persists only a catalog that classifies every configured root", async () => {
		const a = drive.addDir(hexUuid(), "Films")
		const b = drive.addDir(hexUuid(), "More films")

		drive.addFile(drive.addDir(a, "Heat (1995)"), "Heat (1995).mkv")
		drive.addFile(drive.addDir(b, "Ronin (1998)"), "Ronin (1998).mkv")

		const catalogStore = memoryCatalogStore()
		const engine = engineFor(catalogStore)

		walkFails = 1
		engine.setWriter(true)
		await engine.configure(roots([a, "auto"], [b, "auto"]))
		await engine.check(latest)
		await settle()
		await engine.flush()

		// One root's walk failed: what is held lacks it, and a cold open (keyed on both) couldn't use it.
		expect(catalogStore.writes).toBe(0)

		await Promise.all([engine.rescan(a), engine.rescan(b)])
		await settle()
		await engine.flush()

		expect(catalogStore.writes).toBe(1)

		// A later change is persisted too.
		engine.onSocketEvent(driveEvent(++latest, { type: "fileNew", file: drive.addFile(a, "Alien (1979).mkv") }))
		await settle()
		await engine.flush()

		expect(catalogStore.writes).toBe(2)
	})

	it("ignores a persisted catalog classified under other corrections, and replaces it", async () => {
		const root = drive.addDir(hexUuid(), "Films")

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")

		const catalogStore = memoryCatalogStore()

		await firstSession(root, catalogStore)

		let release = (): void => undefined

		readGate = new Promise(resolve => {
			release = resolve
		})

		const second = engineFor(catalogStore)
		let answered = false

		second.setWriter(true)
		second.setOverrides({ [`r:${root}`]: { hidden: true } })
		void second.configure(roots([root, "auto"]))
		void second.catalogTitle("none").then(() => {
			answered = true
		})
		await vi.advanceTimersByTimeAsync(0)

		expect(answered).toBe(false)

		release()
		await settle()
		await second.flush()

		expect(answered).toBe(true)
		expect(catalogStore.writes).toBe(2)
	})
})

describe("library index lifecycle", () => {
	it("applies events that land during a walk over its result", async () => {
		const root = drive.addDir(hexUuid(), "Films")
		const heat = drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")
		let release = (): void => undefined

		walkGate = new Promise(resolve => {
			release = resolve
		})

		const engine = engineFor()

		await engine.configure(roots([root, "auto"]))

		const checking = engine.check(latest)

		// The walk read the tree before this trash; the event arrives while it is still out.
		engine.onSocketEvent(driveEvent(++latest, { type: "fileTrash", uuid: heat.uuid, stableUUID: heat.uuid, newUUID: undefined }))
		release()
		await checking
		await settle()

		expect(titles.size).toBe(0)
		expect(engine.rootStatuses()[0]).toMatchObject({ current: true, state: "ready" })
	})

	it("checks once after a reconnect and walks only when something was missed", async () => {
		const root = drive.addDir(hexUuid(), "Films")

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")

		const engine = engineFor()

		await engine.configure(roots([root, "auto"]))
		await engine.check(latest)
		await settle()
		calls = { walks: 0, lastEventIds: 0, getFile: 0 }

		engine.onSocketEvent({ type: "reconnecting" })
		engine.onSocketEvent({ type: "authSuccess" })
		await settle()

		expect(calls).toEqual({ walks: 0, lastEventIds: 1, getFile: 0 })
		expect(engine.rootStatuses()[0]?.current).toBe(true)
	})

	it("needs no walk when the events delivered since the snapshot loaded cover the gap", async () => {
		const root = drive.addDir(hexUuid(), "Films")

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")

		const first = engineFor()

		first.setWriter(true)
		await first.configure(roots([root, "auto"]))
		await first.check(latest)
		await first.flush()

		const second = engineFor()

		await second.configure(roots([root, "auto"]))
		calls = { walks: 0, lastEventIds: 0, getFile: 0 }

		const ronin = drive.addFile(root, "Ronin (1998).mkv")

		second.onSocketEvent(driveEvent(++latest, { type: "trashEmpty" }))
		second.onSocketEvent(driveEvent(++latest, { type: "fileNew", file: ronin }))
		await second.check(latest)
		await settle()

		expect(calls.walks).toBe(0)
		expect(second.rootStatuses()[0]?.current).toBe(true)
		expect([...titles.values()].map(title => title.title).sort()).toEqual(["Heat", "Ronin"])
	})

	it("doesn't replay an event held from before a drop over a walk that already reflects a later one", async () => {
		const root = drive.addDir(hexUuid(), "Films")

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")

		const first = engineFor()

		first.setWriter(true)
		await first.configure(roots([root, "auto"]))
		await first.check(latest)
		await first.flush()
		// Past the walk floor, so the check's walk runs rather than giving up on the held events.
		await vi.advanceTimersByTimeAsync(WALK_FLOOR_MS + 1_000)

		const second = engineFor()

		await second.configure(roots([root, "auto"]))

		// Held while the loaded root is unchecked; the socket then drops, and its trash is never delivered.
		const ronin = drive.addFile(root, "Ronin (1998).mkv")

		second.onSocketEvent(driveEvent(++latest, { type: "fileNew", file: ronin }))
		second.onSocketEvent({ type: "reconnecting" })
		drive.files.delete(ronin.uuid)
		latest += 5n
		second.onSocketEvent(driveEvent(++latest, { type: "trashEmpty" }))
		await second.check(latest)
		await settle()

		expect([...titles.values()].map(title => title.title)).toEqual(["Heat"])
		expect(second.rootStatuses()[0]?.current).toBe(true)
	})

	it("applies an event up to the watermark delivered after the walk's listing was taken", async () => {
		const root = drive.addDir(hexUuid(), "Films")

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")

		const first = engineFor()

		first.setWriter(true)
		await first.configure(roots([root, "auto"]))
		await first.check(latest)
		await first.flush()
		await vi.advanceTimersByTimeAsync(WALK_FLOOR_MS + 1_000)

		const second = engineFor()

		await second.configure(roots([root, "auto"]))

		let release = (): void => undefined

		walkGate = new Promise(resolve => {
			release = resolve
		})

		// The drive's latest id already covers the file, but the listing (shared, begun earlier) read the tree before
		// it; its event reaches the socket only after the listing was taken.
		const ronin = drive.addFile(root, "Ronin (1998).mkv")

		drive.files.delete(ronin.uuid)
		latest++
		calls = { walks: 0, lastEventIds: 0, getFile: 0 }

		const checking = second.check()

		await vi.advanceTimersByTimeAsync(0)
		expect(calls.walks).toBe(1)

		drive.files.set(ronin.uuid, ronin)
		second.onSocketEvent(driveEvent(latest, { type: "fileNew", file: ronin }))
		release()
		await checking
		await settle()

		expect([...titles.values()].map(title => title.title).sort()).toEqual(["Heat", "Ronin"])
		expect(second.rootStatuses()[0]?.current).toBe(true)
	})

	it("rebuilds a playable file for a live indexed video only", async () => {
		const root = drive.addDir(hexUuid(), "Films")
		const heat = drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv", { key: "b".repeat(64) })
		const engine = engineFor()

		await engine.configure(roots([root, "auto"]))
		await engine.check(latest)

		const [file] = await engine.playableFiles([heat.uuid])

		expect(file).toMatchObject({ uuid: heat.uuid, stableUUID: heat.uuid, parent: heat.parent, size: heat.size, chunks: heat.chunks })
		expect(file?.meta).toEqual(heat.meta)

		engine.onSocketEvent(driveEvent(++latest, { type: "fileTrash", uuid: heat.uuid, stableUUID: heat.uuid, newUUID: undefined }))

		expect(await engine.playableFiles([heat.uuid])).toEqual([])
	})

	it("writes snapshots only as the leader, alternating slots with rising generations", async () => {
		const root = drive.addDir(hexUuid(), "Films")
		const engine = engineFor()

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")

		await engine.configure(roots([root, "auto"]))
		await engine.check(latest)
		await vi.advanceTimersByTimeAsync(120_000)

		expect(snapshots.has(root)).toBe(false)

		engine.setWriter(true)
		await vi.advanceTimersByTimeAsync(120_000)

		expect(snapshots.get(root)?.map(slot => (slot === null ? null : readSnapshotHeader(slot)?.generation))).toEqual([1n, null])

		engine.onSocketEvent(driveEvent(++latest, { type: "fileNew", file: drive.addFile(root, "Ronin (1998).mkv") }))
		await engine.flush()

		expect(snapshots.get(root)?.map(slot => (slot === null ? null : readSnapshotHeader(slot)?.generation))).toEqual([1n, 2n])
	})

	it("keeps a root that went missing, flagged", async () => {
		const root = drive.addDir(hexUuid(), "Films")
		const engine = engineFor()

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")

		await engine.configure(roots([root, "auto"]))
		await engine.check(latest)
		await settle()

		engine.onSocketEvent(
			driveEvent(++latest, { type: "folderTrash", parent: hexUuid(), uuid: root as `${string}-${string}-${string}-${string}` })
		)
		await settle()

		expect(engine.rootStatuses()[0]?.state).toBe("missing")
		expect(titles.size).toBe(1)
	})
})

// A root with one movie, indexed and current.
async function indexedRoot(engine: VideoIndexEngine): Promise<string> {
	const root = drive.addDir(hexUuid(), "Films")

	drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")

	await engine.configure(roots([root, "auto"]))
	await engine.check(latest)
	await settle()
	calls = { walks: 0, lastEventIds: 0, getFile: 0 }

	return root
}

describe("library index recovery", () => {
	it("walks a root whose snapshot was written by another classifier, whatever the floor", async () => {
		const first = engineFor()

		first.setWriter(true)

		const root = await indexedRoot(first)

		await first.flush()

		const slot = snapshots.get(root)?.[0]

		if (slot === null || slot === undefined) {
			throw new Error("no snapshot written")
		}

		// The classifier version sits outside the CRC; the kinds signature inside it.
		new DataView(slot.buffer).setUint16(6, 0, true)

		const second = engineFor()

		await second.configure(roots([root, "auto"]))
		await second.check(latest)

		expect(calls.walks).toBe(1)

		new DataView(slot.buffer).setUint16(6, CLASSIFIER_VERSION, true)
		new DataView(slot.buffer).setUint32(92, 1, true)
		new DataView(slot.buffer).setUint32(12, crc32(slot.subarray(16)), true)
		snapshots.set(root, [slot, null])

		const third = engineFor()

		await third.configure(roots([root, "auto"]))
		await third.check(latest)

		expect(calls.walks).toBe(2)
		expect(slot.length).toBeGreaterThan(SNAPSHOT_HEADER_BYTES)
	})

	it("a whole-drive delete empties the index at once and walks whatever the floor", async () => {
		const engine = engineFor()
		const root = await indexedRoot(engine)

		expect(titles.size).toBe(1)

		// The walk it starts doesn't come back during the test: the index is empty before it does.
		walkGate = new Promise(() => undefined)
		drive.dirs.set(root, driveDir(hexUuid(), "Films", root as `${string}-${string}-${string}-${string}`))
		engine.onSocketEvent(driveEvent(++latest, { type: "deleteAll" }))
		await settle()

		expect(calls.walks).toBe(1)
		expect(titles.size).toBe(0)
	})

	it("more directories moved in than are re-listed one by one walk the root, whatever the floor", async () => {
		const engine = engineFor()
		const root = await indexedRoot(engine)

		for (let i = 0; i < 9; i++) {
			const dir = driveDir(root, `Incoming ${String(i)}`)

			drive.dirs.set(dir.uuid, dir)
			engine.onSocketEvent(driveEvent(++latest, { type: "folderMove", dir }))
		}

		await settle()

		expect(calls.walks).toBe(1)
	})

	it("doesn't take the last event id from before a drop for a watermark", async () => {
		const engine = engineFor()
		const root = drive.addDir(hexUuid(), "Films")

		engine.onSocketEvent(driveEvent(60n, { type: "trashEmpty" }))
		engine.onSocketEvent({ type: "reconnecting" })
		engine.onSocketEvent({ type: "authSuccess" })
		await engine.configure(roots([root, "auto"]))
		await engine.rescan(root)

		expect(calls.lastEventIds).toBe(1)
	})

	it("writes a watermark-only change alone when the page goes away, never re-encoding the snapshot", async () => {
		const engine = engineFor()

		engine.setWriter(true)

		const root = await indexedRoot(engine)

		await vi.advanceTimersByTimeAsync(120_000)

		const generations = (): (bigint | null | undefined)[] =>
			snapshots.get(root)?.map(slot => (slot === null ? null : readSnapshotHeader(slot)?.generation)) ?? []

		expect(generations()).toEqual([1n, null])

		engine.onSocketEvent(driveEvent(++latest, { type: "trashEmpty" }))
		await vi.advanceTimersByTimeAsync(120_000)

		expect(watermarks.has(root)).toBe(false)

		await engine.flush()

		expect(generations()).toEqual([1n, null])
		expect(watermarks.get(root)).toMatchObject({ generation: 1n, watermark: latest })

		// The next session starts from it: no walk for what the events already covered.
		const second = engineFor()

		await second.configure(roots([root, "auto"]))
		await second.check(latest)

		expect(calls.walks).toBe(0)
		expect(second.rootStatuses()[0]?.current).toBe(true)

		// A content write supersedes the watermark kept apart.
		engine.onSocketEvent(driveEvent(++latest, { type: "fileNew", file: drive.addFile(root, "Ronin (1998).mkv") }))
		await engine.flush()

		expect(generations()).toEqual([1n, 2n])
	})

	it("loads only the newest snapshot slot, and the other when that one is torn", async () => {
		const first = engineFor()

		first.setWriter(true)

		const root = await indexedRoot(first)

		await first.flush()
		first.onSocketEvent(driveEvent(++latest, { type: "fileNew", file: drive.addFile(root, "Ronin (1998).mkv") }))
		await first.flush()

		expect(snapshots.get(root)?.map(slot => (slot === null ? null : readSnapshotHeader(slot)?.generation))).toEqual([1n, 2n])

		slotReads = 0
		await engineFor().configure(roots([root, "auto"]))

		expect(slotReads).toBe(1)

		const newest = snapshots.get(root)?.[1]

		if (newest !== null && newest !== undefined) {
			newest.set([(newest.at(-1) ?? 0) ^ 0xff], newest.length - 1)
		}

		await settle()
		slotReads = 0
		titles.clear()

		const second = engineFor()

		await second.configure(roots([root, "auto"]))
		await settle()

		expect(slotReads).toBe(2)
		expect(second.rootStatuses()[0]?.state).toBe("ready")
		expect([...titles.values()].map(title => title.title)).toEqual(["Heat"])
	})

	it("keeps a walk that landed while the snapshot still loaded, and walks no root whose snapshot is loading", async () => {
		const first = engineFor()

		first.setWriter(true)

		const root = await indexedRoot(first)

		await first.flush()

		let release = (): void => undefined

		readGate = new Promise(resolve => {
			release = resolve
		})

		const second = engineFor()
		const configuring = second.configure(roots([root, "auto"]))

		await vi.advanceTimersByTimeAsync(0)

		expect(second.needsCheck()).toBe(false)

		await second.check(latest)

		expect(calls.walks).toBe(0)

		// A rescan walks now; the snapshot landing after it doesn't replace its result.
		drive.addFile(drive.addDir(root, "Alien (1979)"), "Alien (1979).mkv")
		await second.rescan(root)
		release()
		await configuring
		await settle()

		expect([...titles.values()].map(title => title.title).sort()).toEqual(["Alien", "Heat"])
	})

	it("doesn't check a root found gone before it was ever walked again, until it is restored", async () => {
		const engine = engineFor()
		const root = drive.addDir(hexUuid(), "Films")

		goneRoots.add(root)
		await engine.configure(roots([root, "auto"]))
		await engine.check(latest)

		expect(engine.rootStatuses()[0]?.state).toBe("missing")
		expect(calls.walks).toBe(1)

		await engine.configure(roots([root, "auto"]))

		expect(engine.needsCheck()).toBe(false)

		await engine.check(latest)

		expect(calls.walks).toBe(1)

		goneRoots.delete(root)
		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")
		engine.onSocketEvent(
			driveEvent(++latest, {
				type: "folderRestore",
				dir: driveDir(hexUuid(), "Films", root as `${string}-${string}-${string}-${string}`)
			})
		)
		await settle()

		expect(calls.walks).toBe(2)
		expect(engine.rootStatuses()[0]?.state).toBe("ready")
	})

	it("stops writing after repeated failures instead of retrying for the session", async () => {
		const engine = engineFor()

		writeFailures = 10
		engine.setWriter(true)

		const root = await indexedRoot(engine)

		for (let i = 0; i < 6; i++) {
			drive.addFile(root, `Clip ${String(i)} (2001).mkv`)
			engine.onSocketEvent(
				driveEvent(++latest, { type: "fileNew", file: [...drive.files.values()].at(-1) ?? driveFile(root, "x.mkv") })
			)
			await vi.advanceTimersByTimeAsync(120_000)
		}

		await engine.flush()

		expect(writeFailures).toBe(7)
	})

	it("looks up a renamed file only when no root knows it", async () => {
		const engine = engineFor()
		const a = drive.addDir(hexUuid(), "Films")
		const b = drive.addDir(hexUuid(), "Shows")
		const known = drive.addFile(a, "heat.part")

		drive.addFile(a, "Ronin (1998).mkv")
		await engine.configure(roots([a, "auto"], [b, "auto"]))
		await engine.check(latest)
		await settle()

		const rename = (uuid: string, name: string) => {
			engine.onSocketEvent(
				driveEvent(++latest, {
					type: "fileMetadataChanged",
					uuid: uuid as `${string}-${string}-${string}-${string}`,
					metadata: { type: "decoded", data: { name, mime: "", modified: 0n, size: 2_000_000_000n, key: "k", version: 3 } }
				})
			)
		}
		const ronin = [...drive.files.values()].find(file => file.meta.type === "decoded" && file.meta.data.name.startsWith("Ronin"))

		calls.getFile = 0
		rename(ronin?.uuid ?? "", "Ronin.1998.mkv")
		await settle()

		expect(calls.getFile).toBe(0)

		rename(known.uuid, "Heat (1995).mkv")
		await settle()

		expect(calls.getFile).toBe(1)
	})

	it("a trashed directory above the root takes the root away", async () => {
		const engine = engineFor()
		const parent = drive.addDir(hexUuid(), "Media")
		const root = drive.addDir(parent, "Films")

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")
		await engine.configure(roots([root, "auto"]))
		await engine.check(latest)
		await settle()

		engine.onSocketEvent(
			driveEvent(++latest, { type: "folderTrash", parent: hexUuid(), uuid: parent as `${string}-${string}-${string}-${string}` })
		)

		expect(engine.rootStatuses()[0]?.state).toBe("missing")
	})

	it("walks a root again once the floor passes when a walk came back partial", async () => {
		const engine = engineFor()

		walkResult = raw => ({ ...raw, files: [...raw.files, driveFile(hexUuid(), "Orphan.mkv")] })

		const root = await indexedRoot(engine)

		walkResult = raw => raw

		expect(engine.rootStatuses().find(status => status.uuid === root)?.current).toBe(false)

		await vi.advanceTimersByTimeAsync(WALK_FLOOR_MS + 1_000)

		expect(calls.walks).toBe(1)
		expect(engine.rootStatuses()[0]?.current).toBe(true)
	})
})

// The stored snapshot with the highest generation, decoded.
function newestSnapshot(root: string): ReturnType<typeof decodeSnapshot> {
	const slots = (snapshots.get(root) ?? [null, null]).filter(slot => slot !== null)
	const newest = slots.sort((a, b) => Number((readSnapshotHeader(b)?.generation ?? 0n) - (readSnapshotHeader(a)?.generation ?? 0n)))[0]

	return newest === undefined ? null : decodeSnapshot(newest, root)
}

function generationsOf(root: string): (bigint | null | undefined)[] {
	return snapshots.get(root)?.map(slot => (slot === null ? null : readSnapshotHeader(slot)?.generation)) ?? []
}

// Moves a directory holding one movie from outside into `root`, as another device would.
function moveMovieIn(engine: VideoIndexEngine, root: string): void {
	const outside = drive.addDir(hexUuid(), "Ronin (1998)")

	drive.addFile(outside, "Ronin (1998).mkv")

	const dir = drive.dirs.get(outside)

	if (dir === undefined) {
		throw new Error("no directory")
	}

	const moved = { ...dir, parent: root as typeof dir.parent }

	drive.dirs.set(outside, moved)
	engine.onSocketEvent(driveEvent(++latest, { type: "folderMove", dir: moved }))
}

describe("library index follow-ups", () => {
	it("re-lists a directory moved in when the socket dropped before it ran and the check finds no gap", async () => {
		const engine = engineFor()

		await indexedRoot(engine)
		moveMovieIn(engine, engine.rootStatuses()[0]?.uuid ?? "")
		engine.onSocketEvent({ type: "reconnecting" })
		await vi.advanceTimersByTimeAsync(3_000)
		engine.onSocketEvent({ type: "authSuccess" })
		await settle()

		expect(calls.walks).toBe(0)
		expect(engine.rootStatuses()[0]?.current).toBe(true)
		expect([...titles.values()].map(title => title.title).sort()).toEqual(["Heat", "Ronin"])
	})

	// Renames a non-video file in `root` into a movie name, as another device would.
	function renameIntoVideo(engine: VideoIndexEngine, root: string): void {
		const part = [...drive.files.values()].find(
			file => file.parent === root && file.meta.type === "decoded" && file.meta.data.name === "ronin.part"
		)
		const renamed = driveFile(root, "Ronin (1998).mkv", { uuid: part?.uuid ?? hexUuid() })

		drive.files.set(renamed.uuid, renamed)
		engine.onSocketEvent(
			driveEvent(++latest, {
				type: "fileMetadataChanged",
				uuid: renamed.uuid,
				metadata: renamed.meta
			})
		)
	}

	it("walks the roots a renamed file may lie in when its lookup fails twice, once the floor passes", async () => {
		const engine = engineFor()
		const root = await indexedRoot(engine)

		drive.addFile(root, "ronin.part")
		getFileFails = 2
		renameIntoVideo(engine, root)
		await settle()

		expect(calls.getFile).toBe(1)

		await vi.advanceTimersByTimeAsync(LOOKUP_RETRY_MS)

		expect(calls.getFile).toBe(2)
		expect(engine.rootStatuses()[0]?.current).toBe(false)

		await vi.advanceTimersByTimeAsync(WALK_FLOOR_MS)

		expect(calls.walks).toBe(1)
		expect([...titles.values()].map(title => title.title).sort()).toEqual(["Heat", "Ronin"])
	})

	it("tries a renamed file's failed lookup again once the socket is back, and walks nothing when that one lands", async () => {
		const engine = engineFor()
		const root = await indexedRoot(engine)

		drive.addFile(root, "ronin.part")
		getFileFails = 1
		renameIntoVideo(engine, root)
		// The network drops: the lookup and the socket fail together.
		engine.onSocketEvent({ type: "reconnecting" })
		await vi.advanceTimersByTimeAsync(LOOKUP_RETRY_MS * 3)

		expect(calls.getFile).toBe(1)

		engine.onSocketEvent({ type: "authSuccess" })
		await settle()
		await vi.advanceTimersByTimeAsync(WALK_FLOOR_MS)

		expect(calls.getFile).toBe(2)
		expect(calls.walks).toBe(0)
		expect(engine.rootStatuses()[0]?.current).toBe(true)
		expect([...titles.values()].map(title => title.title).sort()).toEqual(["Heat", "Ronin"])
	})

	it("walks a root that settled while a failing lookup was out, when its own held rename asked for the same file", async () => {
		const shows = drive.addDir(hexUuid(), "Shows")

		drive.addFile(shows, "ronin.part")

		const first = engineFor()

		first.setWriter(true)
		await first.configure(roots([shows, "auto"]))
		await first.check(latest)
		await settle()
		await first.flush()

		const engine = engineFor()
		const films = await indexedRoot(engine)
		let releaseRead = (): void => undefined
		let releaseLookup = (): void => undefined

		readGate = new Promise(resolve => {
			releaseRead = resolve
		})
		getFileGate = new Promise(resolve => {
			releaseLookup = resolve
		})

		const configuring = engine.configure(roots([films, "auto"], [shows, "auto"]))

		await vi.advanceTimersByTimeAsync(0)
		// Held by the loading root; the loaded one asks for the file.
		renameIntoVideo(engine, shows)
		await vi.advanceTimersByTimeAsync(0)

		expect(calls.getFile).toBe(1)

		releaseRead()
		await configuring
		await engine.check(latest)
		getFileFails = 2
		releaseLookup()
		await settle()
		await vi.advanceTimersByTimeAsync(LOOKUP_RETRY_MS)
		await vi.advanceTimersByTimeAsync(WALK_FLOOR_MS)

		expect(calls.getFile).toBe(2)
		expect([...titles.values()].map(title => title.title).sort()).toEqual(["Heat", "Ronin"])
	})

	it("writes no watermark while a re-listing is out, and the watermark once it landed", async () => {
		const engine = engineFor()

		engine.setWriter(true)

		const root = await indexedRoot(engine)

		moveMovieIn(engine, root)
		await engine.flush()

		expect(newestSnapshot(root)?.header.watermark).toBeNull()

		await settle()
		await engine.flush()

		const mark = watermarks.get(root)
		const written = newestSnapshot(root)

		expect(mark?.generation === written?.header.generation ? mark?.watermark : written?.header.watermark).toBe(latest)
	})

	// The watermark a write leaves, whichever of the snapshot or the record kept apart names the newer generation.
	function writtenWatermark(root: string): bigint | null | undefined {
		const mark = watermarks.get(root)
		const written = newestSnapshot(root)

		return mark?.generation === written?.header.generation ? mark?.watermark : written?.header.watermark
	}

	function gateWalk(): () => void {
		let release = (): void => undefined

		walkGate = new Promise(resolve => {
			release = resolve
		})

		return () => {
			release()
		}
	}

	it("writes no watermark while a walk taking over too many re-listings is out, and the watermark once it landed", async () => {
		const engine = engineFor()

		engine.setWriter(true)

		const root = await indexedRoot(engine)

		await engine.flush()

		const release = gateWalk()

		for (let i = 0; i < 9; i++) {
			moveMovieIn(engine, root)
		}

		await vi.advanceTimersByTimeAsync(0)
		expect(engine.rootStatuses()[0]?.walking).toBe(true)
		await engine.flush()

		expect(writtenWatermark(root)).toBeNull()

		release()
		await settle()
		await engine.flush()

		expect(calls.walks).toBe(1)
		expect(writtenWatermark(root)).toBe(latest)
	})

	it("writes no watermark while a walk under way stands in for a queued re-listing", async () => {
		const engine = engineFor()

		engine.setWriter(true)

		const root = await indexedRoot(engine)

		await engine.flush()
		moveMovieIn(engine, root)

		const release = gateWalk()
		const rescanning = engine.rescan(root)

		// The re-listing's timer fires while the walk is out.
		await settle()
		await engine.flush()

		expect(writtenWatermark(root)).toBeNull()

		release()
		await rescanning
		await settle()
		await engine.flush()

		expect(writtenWatermark(root)).toBe(latest)
		expect([...titles.values()].map(title => title.title).sort()).toEqual(["Heat", "Ronin"])
	})

	it("leaves a root out of date when the walk standing in for its re-listings is stopped", async () => {
		const engine = engineFor()

		engine.setWriter(true)

		const root = await indexedRoot(engine)
		const release = gateWalk()

		for (let i = 0; i < 9; i++) {
			moveMovieIn(engine, root)
		}

		await vi.advanceTimersByTimeAsync(0)
		engine.stopWalk(root)
		release()
		await settle()
		await engine.flush()

		expect(engine.rootStatuses()[0]?.current).toBe(false)
		expect(writtenWatermark(root)).toBeNull()
	})
})

describe("library index snapshot writes", () => {
	it("writes a whole snapshot rather than a watermark naming a generation another writer superseded", async () => {
		const a = engineFor()

		a.setWriter(true)

		const root = await indexedRoot(a)

		await a.flush()

		const b = engineFor()

		await b.configure(roots([root, "auto"]))
		await b.check(latest)

		// Only the writer's index changed (a rescan); then an event that moves both watermarks.
		await a.rescan(root)
		await a.flush()

		const event = driveEvent(++latest, { type: "trashEmpty" })

		a.onSocketEvent(event)
		b.onSocketEvent(event)
		await a.flush()

		expect(watermarks.get(root)).toMatchObject({ generation: 2n, watermark: latest })

		a.setWriter(false)
		b.setWriter(true)

		const next = driveEvent(++latest, { type: "trashEmpty" })

		a.onSocketEvent(next)
		b.onSocketEvent(next)
		await b.flush()

		calls = { walks: 0, lastEventIds: 0, getFile: 0 }

		const c = engineFor()

		await c.configure(roots([root, "auto"]))
		await c.check(latest)

		expect(calls.walks).toBe(0)
		expect(c.rootStatuses()[0]?.current).toBe(true)
	})

	it("overwrites a torn newer slot, never the intact one the snapshot loaded from", async () => {
		const first = engineFor()

		first.setWriter(true)

		const root = await indexedRoot(first)

		await first.flush()
		first.onSocketEvent(driveEvent(++latest, { type: "fileNew", file: drive.addFile(root, "Ronin (1998).mkv") }))
		await first.flush()

		const newest = snapshots.get(root)?.[1]

		if (newest === null || newest === undefined) {
			throw new Error("no second slot")
		}

		newest.set([(newest.at(-1) ?? 0) ^ 0xff], newest.length - 1)

		const second = engineFor()

		second.setWriter(true)
		await second.configure(roots([root, "auto"]))
		second.onSocketEvent(driveEvent(++latest, { type: "fileNew", file: drive.addFile(root, "Heat 2 (2026).mkv") }))
		await second.check(latest)
		await second.flush()

		expect(generationsOf(root)).toEqual([1n, 3n])
	})

	it("leaves no snapshot behind for a root removed while its write was out", async () => {
		let release = (): void => undefined

		writeGate = new Promise(resolve => {
			release = resolve
		})

		const engine = engineFor()

		engine.setWriter(true)

		const root = await indexedRoot(engine)
		const flushing = engine.flush()

		await engine.configure([])
		release()
		await flushing
		await settle()

		expect(snapshots.has(root)).toBe(false)
		expect(watermarks.has(root)).toBe(false)
	})
})

describe("library index scan stop", () => {
	function gateWalks(): () => void {
		let release = (): void => undefined

		walkGate = new Promise(resolve => {
			release = resolve
		})

		return () => {
			release()
		}
	}

	async function firstScanStopped(engine: VideoIndexEngine): Promise<{ root: string; release: () => void; checking: Promise<void> }> {
		const root = drive.addDir(hexUuid(), "Films")

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")

		const release = gateWalks()

		await engine.configure(roots([root, "auto"]))

		const checking = engine.check(latest)

		await vi.advanceTimersByTimeAsync(0)
		expect(engine.rootStatuses()[0]?.walking).toBe(true)
		engine.stopWalk(root)

		return { root, release, checking }
	}

	it("flags a stopped first scan incomplete at once, then drops its result when it lands", async () => {
		const engine = engineFor()
		const { release, checking } = await firstScanStopped(engine)

		expect(engine.rootStatuses()[0]).toMatchObject({ walking: false, incomplete: true, state: "error" })

		release()
		await checking
		await settle()

		expect(titles.size).toBe(0)
		expect(engine.rootStatuses()[0]).toMatchObject({ walking: false, incomplete: true, state: "error", videos: 0 })
	})

	it("walks a stopped root again only when a rescan asks, not on the next check or configuration", async () => {
		const engine = engineFor()
		const { root, release, checking } = await firstScanStopped(engine)

		release()
		await checking
		await settle()

		expect(engine.needsCheck()).toBe(false)
		await engine.configure(roots([root, "movies"]))
		await engine.check(latest)
		await vi.advanceTimersByTimeAsync(WALK_FLOOR_MS + 1_000)
		expect(calls.walks).toBe(1)

		await engine.rescan(root)
		await settle()

		expect(calls.walks).toBe(2)
		expect(engine.rootStatuses()[0]).toMatchObject({ state: "ready", incomplete: false })
	})

	it("keeps the previous index when a rescan is stopped", async () => {
		const engine = engineFor()
		const root = await indexedRoot(engine)

		drive.addFile(drive.addDir(root, "Alien (1979)"), "Alien (1979).mkv")

		const release = gateWalks()
		const rescanning = engine.rescan(root)

		engine.stopWalk(root)

		expect(engine.rootStatuses()[0]).toMatchObject({ walking: false, state: "ready", incomplete: true })

		release()
		await rescanning
		await settle()

		expect([...titles.values()].map(title => title.title)).toEqual(["Heat"])
		expect(engine.rootStatuses()[0]).toMatchObject({ state: "ready", incomplete: true })
	})

	it("a root that was current stays current after a stopped rescan, with the events delivered meanwhile", async () => {
		const engine = engineFor()
		const root = await indexedRoot(engine)

		expect(engine.rootStatuses()[0]?.current).toBe(true)

		const release = gateWalks()
		const rescanning = engine.rescan(root)

		engine.stopWalk(root)

		const alien = drive.addFile(drive.addDir(root, "Alien (1979)"), "Alien (1979).mkv")

		engine.onSocketEvent(driveEvent(++latest, { type: "folderSubCreated", dir: drive.dirs.get(alien.parent) ?? driveDir(root, "x") }))
		engine.onSocketEvent(driveEvent(++latest, { type: "fileNew", file: alien }))
		release()
		await rescanning
		await settle()

		expect(engine.rootStatuses()[0]?.current).toBe(true)
		expect([...titles.values()].map(title => title.title).sort()).toEqual(["Alien", "Heat"])
	})

	it("shows a root trashed while its stopped walk was out as missing", async () => {
		const engine = engineFor()
		const root = await indexedRoot(engine)
		let release = (): void => undefined

		walkGate = new Promise(resolve => {
			release = resolve
		})
		goneRoots.add(root)

		const rescanning = engine.rescan(root)

		engine.stopWalk(root)
		release()
		await rescanning

		expect(engine.rootStatuses()[0]?.state).toBe("missing")
	})

	it("takes a stopped walk back when a rescan is asked for while it is still out", async () => {
		const engine = engineFor()
		const root = await indexedRoot(engine)

		drive.addFile(drive.addDir(root, "Alien (1979)"), "Alien (1979).mkv")

		const release = gateWalks()
		const rescanning = engine.rescan(root)

		engine.stopWalk(root)

		const again = engine.rescan(root)

		expect(engine.rootStatuses()[0]?.walking).toBe(true)

		release()
		await Promise.all([rescanning, again])
		await settle()

		expect(calls.walks).toBe(1)
		expect([...titles.values()].map(title => title.title).sort()).toEqual(["Alien", "Heat"])
		expect(engine.rootStatuses()[0]?.incomplete).toBe(false)
	})

	it("reads a scan as under way until its result is classified, so it ends with the new count", async () => {
		const root = drive.addDir(hexUuid(), "Films")

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")
		drive.addFile(drive.addDir(root, "Alien (1979)"), "Alien (1979).mkv")

		const engine = engineFor()
		const ended: number[] = []
		let walking = false

		engine.subscribe(update => {
			const status = update.type === "roots" ? update.roots[0] : undefined

			if (status === undefined) {
				return
			}

			if (walking && !status.walking) {
				ended.push(status.videos)
			}

			walking = status.walking
		})

		await engine.configure(roots([root, "auto"]))
		await engine.check(latest)
		await settle()

		expect(ended).toEqual([2])
	})

	it("flags a failed walk incomplete until a complete one lands", async () => {
		const engine = engineFor()
		const root = await indexedRoot(engine)

		walkFails = 1
		await engine.rescan(root)

		expect(engine.rootStatuses()[0]).toMatchObject({ state: "ready", incomplete: true })

		await engine.rescan(root)

		expect(engine.rootStatuses()[0]?.incomplete).toBe(false)
	})
})

describe("library index checks", () => {
	it("walks a new root even when the latest event id can't be read, and reports a walk that fails too", async () => {
		const root = drive.addDir(hexUuid(), "Films")

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")

		const engine = engineFor()

		engine.onSocketEvent({ type: "reconnecting" })
		lastIdFails = 1
		await engine.configure(roots([root, "auto"]))
		await engine.check()
		await settle()

		expect(engine.rootStatuses()[0]).toMatchObject({ state: "ready", incomplete: false })
		expect([...titles.values()].map(title => title.title)).toEqual(["Heat"])

		const other = drive.addDir(hexUuid(), "More")

		lastIdFails = 2
		await engine.configure(roots([root, "auto"], [other, "auto"]))
		await engine.check()
		await settle()

		expect(engine.rootStatuses().find(status => status.uuid === other)).toMatchObject({
			state: "error",
			incomplete: true,
			walking: false
		})
	})

	it("reads a root whose only stored walk was partial as incomplete after a reload", async () => {
		const first = engineFor()

		first.setWriter(true)
		walkResult = raw => ({ ...raw, files: [...raw.files, driveFile(hexUuid(), "Orphan.mkv")] })

		const root = drive.addDir(hexUuid(), "Films")

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")
		await first.configure(roots([root, "auto"]))
		await first.check(latest)
		await settle()
		await first.flush()

		expect(first.rootStatuses()[0]?.incomplete).toBe(true)

		const second = engineFor()

		await second.configure(roots([root, "auto"]))

		expect(second.rootStatuses()[0]).toMatchObject({ state: "ready", incomplete: true })
	})

	it("leaves Filen's own directory out of a drive-root library, walked or created later", async () => {
		const driveRoot = hexUuid()
		const dotFilen = drive.addDir(driveRoot, ".filen")

		driveRootUuid = driveRoot
		drive.addFile(drive.addDir(dotFilen, "Chat Uploads"), "clip.mp4")
		drive.addFile(drive.addDir(driveRoot, "Heat (1995)"), "Heat (1995).mkv")

		const engine = engineFor()

		await engine.configure(roots([driveRoot, "auto"]))
		await engine.check(latest)
		await settle()

		expect([...titles.values()].map(title => title.title)).toEqual(["Heat"])

		const again = driveDir(driveRoot, ".Filen")

		engine.onSocketEvent(driveEvent(++latest, { type: "folderSubCreated", dir: again }))
		engine.onSocketEvent(driveEvent(++latest, { type: "fileNew", file: driveFile(again.uuid, "clip 2.mp4") }))
		await settle()

		expect([...titles.values()].map(title => title.title)).toEqual(["Heat"])
	})
})

describe("library catalog queries", () => {
	// Real macrotasks (only timeouts are faked): every pending slice and reaction runs.
	const flush = (): Promise<void> =>
		new Promise(resolve => {
			setImmediate(resolve)
		})

	it("shares a grid order's warm-up, answers only from a held order, and stops a warm-up nobody waits for", async () => {
		// Slices end only when the test lets them, so calls can come and go mid warm-up.
		let releases: (() => void)[] = []
		const release = (): void => {
			const pending = releases

			releases = []
			pending.forEach(resolve => {
				resolve()
			})
		}
		const engine = engineFor(memoryCatalogStore(), () => new Promise(resolve => releases.push(resolve)))
		const root = drive.addDir(hexUuid(), "Films")

		drive.addFile(drive.addDir(root, "Heat (1995)"), "Heat (1995).mkv")
		drive.addFile(drive.addDir(root, "Ronin (1998)"), "Ronin (1998).mkv")

		const configured = engine.configure(roots([root, "auto"])).then(() => engine.check(latest))

		for (let i = 0; i < 50; i++) {
			release()
			await flush()
			await vi.advanceTimersByTimeAsync(1_000)
		}

		await configured

		const grid = Object.getOwnPropertyDescriptor(VideoCatalog.prototype, "grid")?.value as VideoCatalog["grid"]
		const gridWarmSteps = Object.getOwnPropertyDescriptor(VideoCatalog.prototype, "gridWarmSteps")
			?.value as VideoCatalog["gridWarmSteps"]
		const answeredFromHeld: boolean[] = []
		const cancelledSeen: boolean[] = []

		vi.spyOn(VideoCatalog.prototype, "grid").mockImplementation(function (this: VideoCatalog, query, start, count) {
			answeredFromHeld.push(this.hasGrid(query))

			return grid.call(this, query, start, count)
		})

		const warmUps = vi.spyOn(VideoCatalog.prototype, "gridWarmSteps").mockImplementation(function* (
			this: VideoCatalog,
			query,
			cancelled
		) {
			// Three slices' worth of work before the real build.
			for (let step = 0; step < 3; step++) {
				const until = performance.now() + 8

				while (performance.now() < until) {
					// Busy: the slice runs out.
				}

				if (cancelled()) {
					cancelledSeen.push(true)

					return
				}

				yield
			}

			yield* gridWarmSteps.call(this, query, cancelled)
		})

		const byYear: GridQuery = { source: { kind: "movies" }, prefs: { ...DEFAULT_GRID_PREFS, sort: "year" }, query: "", seed: 1 }
		const first = engine.catalogGrid(byYear, 0, 10, 1)
		const second = engine.catalogGrid(byYear, 0, 10, 2)

		await flush()
		engine.catalogAbandon(1)

		await expect(first).rejects.toBeInstanceOf(CatalogCallAbandoned)

		for (let i = 0; i < 10; i++) {
			release()
			await flush()
		}

		expect((await second).total).toBe(2)
		expect(warmUps).toHaveBeenCalledTimes(1)
		expect(cancelledSeen).toEqual([])

		const byAdded: GridQuery = { ...byYear, prefs: { ...DEFAULT_GRID_PREFS, sort: "added" } }
		const third = engine.catalogGrid(byAdded, 0, 10, 3)

		await flush()
		engine.catalogAbandon(3)

		await expect(third).rejects.toBeInstanceOf(CatalogCallAbandoned)

		for (let i = 0; i < 10; i++) {
			release()
			await flush()
		}

		expect(cancelledSeen).toEqual([true])
		expect(answeredFromHeld).toEqual([true])
		vi.restoreAllMocks()
	})
})
