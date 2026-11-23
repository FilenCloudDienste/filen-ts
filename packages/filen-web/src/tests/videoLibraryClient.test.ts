// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type, type Type } from "arktype"
import { emptyLibraryConfig, type ItemRec } from "@filen/shared/videos"
import type { VideoIndexUpdate } from "@/workers/videoIndex/view.logic"
import type { FactsResult, FactsUpdate, GridQuery, WatchUpdate } from "@/workers/videoIndex/catalog.logic"
import { DEFAULT_GRID_PREFS } from "@/features/videos/lib/videoGrid.logic"
import type { ProbeRecord } from "@/features/videos/lib/probeService.logic"

// The main thread's side of the library: it holds the worker's root statuses, counts and catalog version (never the
// library itself), refetches what the screens show when the catalog changes, and hands the watch state and probe
// facts to the worker as they change.

interface WatchSnapshot {
	doc: { v: 1; items: Record<string, ItemRec>; series: Record<string, never> }
	loaded: boolean
	unsynced: boolean
	dirty: boolean
	lastPlayedCeilingMs: number | undefined
}

function emptyWatchSnapshot(): WatchSnapshot {
	return { doc: { v: 1, items: {}, series: {} }, loaded: true, unsynced: false, dirty: false, lastPlayedCeilingMs: undefined }
}

const { sdkApi, listener, watch, probes, kvEntriesJsonInSlices } = vi.hoisted(() => ({
	sdkApi: {
		videoIndexSubscribe: vi.fn(),
		videoIndexSetWriter: vi.fn(() => Promise.resolve()),
		videoIndexSetOverrides: vi.fn(() => Promise.resolve()),
		videoIndexConfigure: vi.fn(() => Promise.resolve(false)),
		videoCatalogSetWatch: vi.fn<(update: WatchUpdate) => Promise<void>>(() => Promise.resolve()),
		videoCatalogSetFacts: vi.fn<(update: FactsUpdate) => Promise<FactsResult>>(() =>
			Promise.resolve({ changed: true, affectsWatch: false })
		)
	},
	listener: { current: null as ((update: VideoIndexUpdate) => void) | null },
	watch: {
		listeners: new Set<() => void>(),
		snapshot: emptyWatchSnapshot()
	},
	probes: { listener: null as ((uuid: string, record: ProbeRecord) => void) | null },
	kvEntriesJsonInSlices: vi.fn<(prefix: string, schema: Type, map: (key: string, value: unknown) => unknown) => Promise<unknown[]>>()
}))

// Stored rows as the adapter serves them: validated by the caller's schema, each reduced by its map.
function serveRows(rows: readonly (readonly [string, unknown])[]): void {
	kvEntriesJsonInSlices.mockImplementation((_prefix, schema, map) =>
		Promise.resolve(
			rows.flatMap(([key, value]) => {
				const out: unknown = schema(value)

				return out instanceof type.errors ? [] : [map(key, out)]
			})
		)
	)
}

vi.mock("@/lib/sdk/client", () => ({ sdkApi }))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
vi.mock("@/queries/persist", () => ({ persister: { persistQuery: () => Promise.resolve() } }))
vi.mock("@/lib/storage/adapter", async importOriginal => ({ ...(await importOriginal<object>()), kvEntriesJsonInSlices }))
vi.mock("@/features/videos/lib/watchState", () => ({
	watchState: {
		subscribe: (listener: () => void) => {
			watch.listeners.add(listener)

			return () => watch.listeners.delete(listener)
		},
		getSnapshot: () => watch.snapshot
	}
}))
vi.mock("@/features/videos/lib/probeService", () => ({
	probeService: {
		onRecord: (listener: (uuid: string, record: ProbeRecord) => void) => {
			probes.listener = listener

			return () => undefined
		}
	}
}))

import { queryClient } from "@/queries/client"
import { VIDEO_CATALOG_KEY_PREFIX, VIDEO_TITLE_DETAIL_KEY_PREFIX, videoLibrary } from "@/features/videos/lib/index"

function setWatch(items: Record<string, ItemRec>, ceiling?: number): void {
	watch.snapshot = { ...watch.snapshot, doc: { ...watch.snapshot.doc, items }, lastPlayedCeilingMs: ceiling }

	for (const notify of watch.listeners) {
		notify()
	}
}

function record(durationSec: number, h: number): ProbeRecord {
	return {
		probe: {
			v: 1,
			container: "mkv",
			durationSec,
			index: "cues",
			video: { codec: null, fourcc: "", codecString: null, w: 0, h, par: 1, rotation: 0, bitDepth: null, transfer: "sdr" },
			audio: [],
			subs: [],
			chapters: [],
			cover: null,
			coverLand: null,
			partial: false
		},
		tiers: { card: true, full: false, cover: false },
		at: 1
	}
}

const STAMP = { t: 1000, d: "dev" }

beforeEach(async () => {
	videoLibrary.reset()
	vi.clearAllMocks()
	watch.listeners.clear()
	watch.snapshot = { ...watch.snapshot, doc: { v: 1, items: { "s:a": { w: { ...STAMP, pl: true, pc: 1 } } }, series: {} } }
	sdkApi.videoIndexSubscribe.mockImplementation((callback: (update: VideoIndexUpdate) => void) => {
		listener.current = callback
	})
	serveRows([["videos.v1.probe.p1", record(6000, 1080)]])
	await videoLibrary.configure(emptyLibraryConfig())
})

afterEach(() => {
	videoLibrary.reset()
})

describe("video library client", () => {
	it("holds the worker's counts and version, and refetches the screens' queries on each catalog change", async () => {
		queryClient.setQueryData([...VIDEO_CATALOG_KEY_PREFIX, "home"], { rows: [] })
		queryClient.setQueryData([...VIDEO_TITLE_DETAIL_KEY_PREFIX, "a"], null)
		queryClient.setQueryData([...VIDEO_TITLE_DETAIL_KEY_PREFIX, "b"], null)

		const total = { movies: 2, shows: 1, other: 0, episodes: 10 }

		listener.current?.({
			type: "catalog",
			version: 3,
			titles: ["a"],
			summary: { titleCount: 3, total, byRoot: [["r", total]], hiddenCount: 1 }
		})
		await Promise.resolve()

		expect(videoLibrary.getSnapshot()).toMatchObject({ loaded: true, version: 3, summary: { titleCount: 3, hiddenCount: 1, total } })
		expect(videoLibrary.getSnapshot().summary.byRoot.get("r")).toEqual(total)
		expect(queryClient.getQueryState([...VIDEO_CATALOG_KEY_PREFIX, "home"])?.isInvalidated).toBe(true)
		expect(queryClient.getQueryState([...VIDEO_TITLE_DETAIL_KEY_PREFIX, "a"])?.isInvalidated).toBe(true)
		expect(queryClient.getQueryState([...VIDEO_TITLE_DETAIL_KEY_PREFIX, "b"])?.isInvalidated).toBe(false)
	})

	it("ignores an update the worker sent before a sign-out reset, arriving after it", () => {
		const before = listener.current
		const total = { movies: 2, shows: 1, other: 0, episodes: 10 }

		if (before === null) {
			throw new Error("not subscribed")
		}

		videoLibrary.reset()

		// The callback's own port keeps no order with the reset's call: the update comes in last.
		before({ type: "catalog", version: 3, titles: null, summary: { titleCount: 3, total, byRoot: [["r", total]], hiddenCount: 1 } })

		expect(videoLibrary.getSnapshot()).toMatchObject({ loaded: false })
		expect(videoLibrary.getSnapshot().summary.titleCount).toBe(0)
	})

	it("writes snapshots only once it holds the writer lock, and gives it up at logout", async () => {
		const pending: (() => Promise<void> | undefined)[] = []
		let released = false

		Object.defineProperty(navigator, "locks", {
			configurable: true,
			value: {
				request: (_name: string, callback: () => Promise<void> | undefined) => {
					pending.push(callback)

					return Promise.resolve()
				}
			}
		})

		try {
			videoLibrary.reset()
			sdkApi.videoIndexSetWriter.mockClear()
			await videoLibrary.configure(emptyLibraryConfig())

			// Another tab writes: nothing here until it lets go.
			expect(sdkApi.videoIndexSetWriter).not.toHaveBeenCalled()

			void pending[0]?.()?.then(() => {
				released = true
			})

			expect(sdkApi.videoIndexSetWriter).toHaveBeenCalledExactlyOnceWith(true)

			videoLibrary.reset()
			await Promise.resolve()

			expect(released).toBe(true)
		} finally {
			Reflect.deleteProperty(navigator, "locks")
		}
	})

	it("hands the watch state over once in full, then only what changed", async () => {
		expect(sdkApi.videoCatalogSetWatch.mock.calls).toEqual([
			[{ reset: true, upserts: { "s:a": { w: { ...STAMP, pl: true, pc: 1 } } }, removed: [], lastPlayedCeilingMs: undefined }]
		])

		// A new document with an equal record and a new one: only the new one goes.
		setWatch({ "s:a": { w: { ...STAMP, pl: true, pc: 1 } }, "s:b": { w: { ...STAMP, pl: true, pc: 1 } } })
		// Unchanged: nothing goes.
		setWatch({ ...watch.snapshot.doc.items })
		setWatch({ "s:b": { w: { ...STAMP, pl: true, pc: 1 } } }, 5)
		await Promise.resolve()

		expect(sdkApi.videoCatalogSetWatch.mock.calls.slice(1)).toEqual([
			[{ reset: false, upserts: { "s:b": { w: { ...STAMP, pl: true, pc: 1 } } }, removed: [], lastPlayedCeilingMs: undefined }],
			[{ reset: false, upserts: {}, removed: ["s:a"], lastPlayedCeilingMs: 5 }]
		])
	})

	it("hands every stored probe's facts over once per session, and new probes' together as they land", async () => {
		vi.useFakeTimers()

		await Promise.all([videoLibrary.loadProbeFacts(), videoLibrary.loadProbeFacts()])

		probes.listener?.("p2", record(120, 2160))
		await vi.advanceTimersByTimeAsync(100)
		probes.listener?.("p3", record(60, 720))
		await vi.advanceTimersByTimeAsync(100)

		expect(sdkApi.videoCatalogSetFacts).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(100)
		vi.useRealTimers()

		expect(kvEntriesJsonInSlices).toHaveBeenCalledTimes(1)
		expect(sdkApi.videoCatalogSetFacts.mock.calls).toEqual([
			[{ reset: false, uuids: ["p1"], durations: [6000], heights: [1080] }],
			[{ reset: false, uuids: ["p2", "p3"], durations: [120, 60], heights: [2160, 720] }]
		])

		// A sign-out: the next session scans again.
		videoLibrary.reset()
		await videoLibrary.loadProbeFacts()

		expect(kvEntriesJsonInSlices).toHaveBeenCalledTimes(2)
	})

	it("hands many stored facts over in parts, the screens refetching once after the last", async () => {
		const rows = Array.from({ length: 9000 }, (_, index) => [`videos.v1.probe.p${String(index)}`, record(index, 1080)] as const)
		const key = [...VIDEO_CATALOG_KEY_PREFIX, "home"]
		let refetchedBeforeLast = false

		serveRows(rows)
		queryClient.setQueryData(key, {})
		sdkApi.videoCatalogSetFacts.mockImplementation(() => {
			refetchedBeforeLast ||= queryClient.getQueryState(key)?.isInvalidated === true

			return Promise.resolve({ changed: true, affectsWatch: true })
		})

		await videoLibrary.loadProbeFacts()

		expect(sdkApi.videoCatalogSetFacts.mock.calls.map(([update]) => update.uuids.length)).toEqual([4000, 4000, 1000])
		expect(refetchedBeforeLast).toBe(false)
		expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
		sdkApi.videoCatalogSetFacts.mockImplementation(() => Promise.resolve({ changed: true, affectsWatch: false }))
	})

	it("refetches only the grids whose order reads probe facts, and everything when the facts reach watched titles", async () => {
		const grid = (prefs: GridQuery["prefs"]) =>
			[...VIDEO_CATALOG_KEY_PREFIX, "grid", JSON.stringify({ source: { kind: "movies" }, prefs, query: "", seed: 1 }), 0] as const
		const byTitle = grid(DEFAULT_GRID_PREFS)
		const byRuntime = grid({ ...DEFAULT_GRID_PREFS, sort: "runtime" })
		const by4k = grid({ ...DEFAULT_GRID_PREFS, quality: "2160" })
		const home = [...VIDEO_CATALOG_KEY_PREFIX, "home"]
		const seed = (): void => {
			for (const key of [byTitle, byRuntime, by4k, home]) {
				queryClient.setQueryData(key, {})
			}
		}
		const invalidated = (key: readonly unknown[]): boolean | undefined => queryClient.getQueryState(key)?.isInvalidated

		seed()
		await videoLibrary.loadProbeFacts()

		expect([invalidated(byTitle), invalidated(byRuntime), invalidated(by4k), invalidated(home)]).toEqual([false, true, true, false])

		// Facts the worker already held: nothing refetches.
		vi.useFakeTimers()
		seed()
		sdkApi.videoCatalogSetFacts.mockResolvedValueOnce({ changed: false, affectsWatch: false })
		probes.listener?.("p1", record(6000, 1080))
		await vi.advanceTimersByTimeAsync(300)

		expect([invalidated(byTitle), invalidated(byRuntime), invalidated(by4k), invalidated(home)]).toEqual([false, false, false, false])

		// They reached a title with watch-state records: what is played changed, so rows refetch too.
		sdkApi.videoCatalogSetFacts.mockResolvedValueOnce({ changed: true, affectsWatch: true })
		probes.listener?.("p2", record(60, 720))
		await vi.advanceTimersByTimeAsync(300)
		vi.useRealTimers()

		expect([invalidated(byTitle), invalidated(byRuntime), invalidated(by4k), invalidated(home)]).toEqual([true, true, true, true])
	})
})
