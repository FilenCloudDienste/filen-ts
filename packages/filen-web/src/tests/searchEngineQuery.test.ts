import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Client, CacheSearchConfig, CacheSearchSnapshot, CacheStatusMessage, Dir, ResyncProgressMessage } from "@filen/sdk-rs"
import { createSearchEngine, type SearchPush, type SearchQueryProgress } from "@/workers/searchEngine"
import { testUuid } from "@/tests/support/uuid"

function snapshot(overrides: Partial<CacheSearchSnapshot> = {}): CacheSearchSnapshot {
	return { results: [], total: 0n, live: true, ...overrides }
}

type SnapshotListener = (s: CacheSearchSnapshot) => void

// A fake engine handle. `results` is what the engine holds for a filter: a window opens on it and total()
// answers it, except that a `lagging` filter's window opens on the previous filter's hits. Deliveries are
// driven by hand, to the newest window or (a late one) to an older window.
function fakeHandle(results: (name: string) => CacheSearchSnapshot = () => snapshot(), lagging: ReadonlySet<string> = new Set()) {
	let current = snapshot()
	let opening = current
	const listeners: SnapshotListener[] = []
	const windows: { free: ReturnType<typeof vi.fn>; initialSnapshot: ReturnType<typeof vi.fn> }[] = []
	let filter: string | undefined
	const configure = (config: CacheSearchConfig) => {
		const name = config.name ?? ""

		// A refilter to the same name re-reads what the engine already holds.
		if (name === filter) {
			opening = current

			return
		}

		filter = name
		opening = lagging.has(name) ? current : results(name)
		current = results(name)
	}
	const search = {
		close: vi.fn(() => Promise.resolve(undefined)),
		free: vi.fn(),
		total: vi.fn(() => Promise.resolve(current.total)),
		setConfig: vi.fn((config: CacheSearchConfig) => {
			configure(config)

			return Promise.resolve(undefined)
		}),
		getRange: vi.fn((_start: bigint, _end: bigint, next: SnapshotListener) => {
			const initial = opening
			const searchWindow = { free: vi.fn(), initialSnapshot: vi.fn(() => initial) }

			listeners.push(next)
			windows.push(searchWindow)

			return Promise.resolve(searchWindow)
		})
	}

	return {
		search,
		windows,
		configure,
		deliver: (s: CacheSearchSnapshot) => {
			current = s
			opening = s
			listeners.at(-1)?.(s)
		},
		deliverTo: (index: number, s: CacheSearchSnapshot) => {
			listeners[index]?.(s)
		}
	}
}

type FakeHandle = ReturnType<typeof fakeHandle>

function fakeClient(handles: FakeHandle[]) {
	let status: ((messages: CacheStatusMessage[]) => void) | undefined
	const createSearch = vi.fn((_root: string, config: CacheSearchConfig) => {
		const next = handles.shift()

		if (next === undefined) {
			return Promise.reject(new Error("no search"))
		}

		next.configure(config)

		return Promise.resolve(next.search)
	})
	const configureCache = vi.fn((_path: string, listener: (messages: CacheStatusMessage[]) => void) => {
		status = listener

		return Promise.resolve(undefined)
	})
	const client = {
		configureCache,
		createSearch,
		root: vi.fn(() => ({ uuid: "root" }))
	} as unknown as Client

	return {
		client,
		configureCache,
		createSearch,
		resync: (progress: ResyncProgressMessage) => status?.([{ type: "resyncProgress", progress }])
	}
}

const hit = { parentPath: "Docs", result: { type: "dir" as const, dir: { uuid: "d1" } as unknown as Dir } }
const OPTIONS = { settleMs: 100, stallMs: 2_000, capMs: 10_000, keepMs: 60_000 }
const MINUTE = 60_000
const RESYNC_START_MS = 5_000
const ROOT = testUuid("root")

function listing(downloaded: bigint, total: bigint): ResyncProgressMessage {
	return { type: "listing", root: ROOT, root_index: 0n, root_count: 1n, bytes_downloaded: downloaded, total_bytes: total }
}

const one = () => snapshot({ results: [hit], total: 1n })

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("createSearchEngine — query", () => {
	it("runs on a handle of its own beside the user's open search, leaving the user's untouched", async () => {
		const user = fakeHandle()
		const own = fakeHandle(one)
		const { client, createSearch } = fakeClient([user, own])
		const engine = createSearchEngine()

		await engine.open(client, { rootUuid: null, name: "doc" }, () => undefined)

		// The user's search covers the drive: no resync is due, so stillness settles it.
		const result = engine.query(client, { rootUuid: null, names: ["x"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(100)

		await expect(result).resolves.toMatchObject({ settled: true, name: "x", snapshot: { total: 1n } })
		expect(createSearch).toHaveBeenCalledTimes(2)
		expect(own.windows[0]?.free).toHaveBeenCalledTimes(1)
		expect(user.search.close).not.toHaveBeenCalled()
		await expect(engine.setName("docs")).resolves.toBe(true)
		expect(user.search.setConfig).toHaveBeenCalledTimes(1)
		expect(own.search.setConfig).not.toHaveBeenCalled()
	})

	it("keeps its handle registered between queries: the next refilters it, and it goes once idle for keepMs", async () => {
		const own = fakeHandle(name => (name === "a" ? one() : snapshot({ total: 0n })))
		const { client, createSearch, resync } = fakeClient([own])
		const engine = createSearchEngine()
		const first = engine.query(client, { rootUuid: null, names: ["a"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(0)
		resync({ type: "started", roots: [ROOT] })
		resync({ type: "finished", converged: true })
		await vi.advanceTimersByTimeAsync(100)
		await expect(first).resolves.toMatchObject({ settled: true, snapshot: { total: 1n } })

		await vi.advanceTimersByTimeAsync(OPTIONS.keepMs - 1_000)

		const second = engine.query(client, { rootUuid: null, names: ["b"], itemType: "file" }, OPTIONS)

		await vi.advanceTimersByTimeAsync(100)

		await expect(second).resolves.toMatchObject({ settled: true, name: "b", snapshot: { total: 0n } })
		expect(createSearch).toHaveBeenCalledTimes(1)
		expect(own.search.setConfig).toHaveBeenCalledWith(expect.objectContaining({ name: "b", itemType: "file" }))
		expect(own.windows).toHaveLength(2)
		expect(own.search.close).not.toHaveBeenCalled()

		// The keep window restarted with the second query.
		await vi.advanceTimersByTimeAsync(OPTIONS.keepMs - 1)
		expect(own.search.close).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(own.search.close).toHaveBeenCalledTimes(1)
	})

	it("answers once the results have been still for settleMs after its registration's resync finished", async () => {
		const own = fakeHandle()
		const { client, resync } = fakeClient([own])
		const engine = createSearchEngine()
		const result = engine.query(client, { rootUuid: null, names: ["doc"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(0)
		resync({ type: "started", roots: [ROOT] })
		await vi.advanceTimersByTimeAsync(50)
		own.deliver(one())
		resync({ type: "finished", converged: true })
		await vi.advanceTimersByTimeAsync(99)
		expect(own.windows[0]?.free).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)

		await expect(result).resolves.toEqual({
			snapshot: { hits: [{ parentPath: "Docs", item: hit.result.dir }], total: 1n, live: true },
			settled: true,
			name: "doc"
		})
		expect(own.windows[0]?.free).toHaveBeenCalledTimes(1)
		expect(own.search.close).not.toHaveBeenCalled()
	})

	it("re-reads the hits once its resync finished instead of taking a batch the engine has not re-read yet for no match", async () => {
		const own = fakeHandle()
		const { client, resync } = fakeClient([own])
		const engine = createSearchEngine()
		const result = engine.query(client, { rootUuid: null, names: ["probe"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(0)
		resync({ type: "started", roots: [ROOT] })
		await vi.advanceTimersByTimeAsync(1_000)
		// The resync's last batch is committed before its finish message; the engine's own re-read is still
		// debounced, so only a refilter delivers it.
		own.search.setConfig.mockImplementationOnce(() => {
			own.deliver(one())

			return Promise.resolve(undefined)
		})
		resync({ type: "finished", converged: true })
		await vi.advanceTimersByTimeAsync(100)

		await expect(result).resolves.toMatchObject({ settled: true, name: "probe", snapshot: { total: 1n } })
		expect(own.search.setConfig).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "probe" }))
	})

	it("waits for the re-read's delivery when it trails the refilter", async () => {
		const own = fakeHandle()
		const { client, resync } = fakeClient([own])
		const engine = createSearchEngine()
		const result = engine.query(client, { rootUuid: null, names: ["probe"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(0)
		resync({ type: "started", roots: [ROOT] })
		await vi.advanceTimersByTimeAsync(1_000)
		// The re-read's total is stored before its delivery reaches the window.
		own.search.setConfig.mockImplementationOnce(() => {
			own.search.total.mockImplementationOnce(() => Promise.resolve(1n))
			setTimeout(() => {
				own.deliver(one())
			}, 50)

			return Promise.resolve(undefined)
		})
		let done = false

		void result.then(() => {
			done = true
		})
		resync({ type: "finished", converged: true })
		await vi.advanceTimersByTimeAsync(100)
		expect(own.search.setConfig).toHaveBeenCalledOnce()
		// The delivery lands 50 ms after the refilter; the hits must then be still for settleMs.
		await vi.advanceTimersByTimeAsync(149)
		expect(done).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await expect(result).resolves.toMatchObject({ settled: true, snapshot: { total: 1n } })
	})

	it("leaves the hits unconfirmed when the re-read after its resync fails", async () => {
		const own = fakeHandle()
		const { client, resync } = fakeClient([own])
		const engine = createSearchEngine()
		const result = engine.query(client, { rootUuid: null, names: ["probe"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(0)
		resync({ type: "started", roots: [ROOT] })
		own.search.setConfig.mockImplementationOnce(() => Promise.reject(new Error("engine gone")))
		resync({ type: "finished", converged: true })
		await vi.advanceTimersByTimeAsync(100)

		await expect(result).resolves.toMatchObject({ settled: false, snapshot: { total: 0n } })
	})

	it("waits out a long first index build, reporting how far it got, and settles once it finishes", async () => {
		const own = fakeHandle()
		const { client, resync } = fakeClient([own])
		const engine = createSearchEngine()
		const progress: SearchQueryProgress[] = []
		const result = engine.query(
			client,
			{ rootUuid: null, names: ["doc"] },
			{ ...OPTIONS, stallMs: 3 * MINUTE, capMs: 30 * MINUTE },
			p => progress.push(p)
		)
		let settled = false

		void result.then(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(0)
		resync({ type: "started", roots: [ROOT] })

		// Minutes of listing: each message keeps the query waiting, well past any fixed budget of seconds.
		for (let minute = 1; minute <= 10; minute++) {
			await vi.advanceTimersByTimeAsync(MINUTE / 2)
			resync(listing(BigInt(minute), 10n))
			await vi.advanceTimersByTimeAsync(MINUTE / 2)
			resync(listing(BigInt(minute), 10n))
			own.deliver(snapshot({ results: [hit], total: BigInt(minute) }))
		}

		expect(settled).toBe(false)
		// A long apply reports nothing; a minute of silence is not the end of it.
		resync({ type: "applying" })
		await vi.advanceTimersByTimeAsync(MINUTE)
		expect(settled).toBe(false)
		resync({ type: "finished", converged: true })
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(100)

		await expect(result).resolves.toMatchObject({ settled: true, snapshot: { total: 10n } })
		expect(progress.some(p => p.indexed !== null && p.indexed > 0 && p.indexed < 1)).toBe(true)
		expect(progress).toContainEqual({ indexed: 1, candidates: 10n })
		// The index is complete: no share left to show.
		expect(progress.at(-1)).toEqual({ indexed: null, candidates: 10n })
		// Throttled: far fewer reports than events.
		expect(progress.length).toBeLessThan(40)
		expect(own.search.close).not.toHaveBeenCalled()
	})

	it("gives up at capMs with settled false and keeps its handle so the build goes on", async () => {
		const own = fakeHandle()
		const { client, resync } = fakeClient([own])
		const engine = createSearchEngine()
		const result = engine.query(client, { rootUuid: null, names: ["doc"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(0)
		resync({ type: "started", roots: [ROOT] })

		for (let elapsed = 0; elapsed < OPTIONS.capMs; elapsed += 1_000) {
			await vi.advanceTimersByTimeAsync(1_000)
			resync(listing(1n, 10n))
		}

		await expect(result).resolves.toMatchObject({ settled: false })
		expect(own.windows[0]?.free).toHaveBeenCalledTimes(1)

		// Still building at the end of the keep window: kept until the build is over.
		for (let elapsed = 0; elapsed < OPTIONS.keepMs; elapsed += 1_000) {
			await vi.advanceTimersByTimeAsync(1_000)
			resync(listing(2n, 10n))
		}

		expect(own.search.close).not.toHaveBeenCalled()
		resync({ type: "finished", converged: true })
		expect(own.search.close).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(OPTIONS.keepMs)
		expect(own.search.close).toHaveBeenCalledTimes(1)
	})

	it("ends the wait on a resync silent for stallMs without calling the index settled, and keeps the handle", async () => {
		const own = fakeHandle()
		const { client, resync } = fakeClient([own])
		const engine = createSearchEngine()
		const result = engine.query(client, { rootUuid: null, names: ["doc"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(0)
		resync({ type: "started", roots: [ROOT] })
		await vi.advanceTimersByTimeAsync(OPTIONS.stallMs)

		await expect(result).resolves.toMatchObject({ settled: false })
		await vi.advanceTimersByTimeAsync(OPTIONS.keepMs - 1)
		expect(own.search.close).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(own.search.close).toHaveBeenCalledTimes(1)
	})

	it("does not settle a fresh registration before its resync starts, even when the start comes late", async () => {
		const own = fakeHandle(one)
		const { client, resync } = fakeClient([own])
		const engine = createSearchEngine()
		let settled: boolean | null = null
		const result = engine.query(client, { rootUuid: null, names: ["doc"] }, OPTIONS)

		void result.then(r => {
			settled = r.settled
		})
		await vi.advanceTimersByTimeAsync(1_000)
		expect(settled).toBeNull()
		resync({ type: "started", roots: [ROOT] })
		await vi.advanceTimersByTimeAsync(1_000)
		expect(settled).toBeNull()
		resync({ type: "finished", converged: true })
		await vi.advanceTimersByTimeAsync(100)

		await expect(result).resolves.toMatchObject({ settled: true })
	})

	it("counts a resync whose start message dropped from its first listing message", async () => {
		const own = fakeHandle(one)
		const { client, resync } = fakeClient([own])
		const engine = createSearchEngine()
		const result = engine.query(client, { rootUuid: null, names: ["doc"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(1_000)
		resync(listing(1n, 2n))
		await vi.advanceTimersByTimeAsync(1_000)
		resync({ type: "finished", converged: true })
		await vi.advanceTimersByTimeAsync(100)

		await expect(result).resolves.toMatchObject({ settled: true })
	})

	it("leaves a fresh registration unconfirmed when no resync message ever arrives", async () => {
		const own = fakeHandle(one)
		const { client } = fakeClient([own])
		const engine = createSearchEngine()
		let settled: boolean | null = null
		const result = engine.query(client, { rootUuid: null, names: ["doc"] }, OPTIONS)

		void result.then(r => {
			settled = r.settled
		})
		await vi.advanceTimersByTimeAsync(RESYNC_START_MS - 1)
		expect(settled).toBeNull()
		await vi.advanceTimersByTimeAsync(1)

		await expect(result).resolves.toMatchObject({ settled: false, snapshot: { total: 1n } })
	})

	it("does not call an index settled whose resync finished without converging", async () => {
		const own = fakeHandle(one)
		const { client, resync } = fakeClient([own])
		const engine = createSearchEngine()
		const result = engine.query(client, { rootUuid: null, names: ["doc"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(0)
		resync({ type: "started", roots: [ROOT] })
		resync({ type: "finished", converged: false })
		await vi.advanceTimersByTimeAsync(100)

		await expect(result).resolves.toMatchObject({ settled: false, snapshot: { total: 1n } })
	})

	it("does not wait on a resync whose finish was dropped long before it started", async () => {
		const own = fakeHandle()
		const { client, resync } = fakeClient([own])
		const engine = createSearchEngine()

		void engine.query(client, { rootUuid: null, names: ["a"] }, OPTIONS)
		await vi.advanceTimersByTimeAsync(0)
		resync({ type: "started", roots: [ROOT] })
		await vi.advanceTimersByTimeAsync(OPTIONS.stallMs + 1)

		const result = engine.query(client, { rootUuid: null, names: ["b"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(100)

		await expect(result).resolves.toMatchObject({ settled: true, name: "b" })
	})

	it("answers at once when stopped, and the Stop ends an index build no user search stands on", async () => {
		const own = fakeHandle(one)
		const { client, resync } = fakeClient([own])
		const engine = createSearchEngine()
		const result = engine.query(client, { rootUuid: null, names: ["doc"] }, { ...OPTIONS, id: 7 })

		await vi.advanceTimersByTimeAsync(0)
		resync({ type: "started", roots: [ROOT] })
		await vi.advanceTimersByTimeAsync(500)
		engine.cancelQuery(7)

		await expect(result).resolves.toMatchObject({ settled: false, snapshot: { total: 1n } })
		expect(own.search.close).toHaveBeenCalledTimes(1)
	})

	it("keeps a stopped query's handle while the user's open search may stand on its resync, until it finishes", async () => {
		const own = fakeHandle(one)
		const user = fakeHandle()
		const { client, resync } = fakeClient([own, user])
		const engine = createSearchEngine()
		const result = engine.query(client, { rootUuid: null, names: ["doc"] }, { ...OPTIONS, id: 7 })

		await vi.advanceTimersByTimeAsync(0)
		resync({ type: "started", roots: [ROOT] })
		await engine.open(client, { rootUuid: null, name: "mine" }, () => undefined)
		engine.cancelQuery(7)
		await expect(result).resolves.toMatchObject({ settled: false })
		expect(own.search.close).not.toHaveBeenCalled()

		resync({ type: "finished", converged: true })
		expect(own.search.close).toHaveBeenCalledTimes(1)
		expect(user.search.close).not.toHaveBeenCalled()
	})

	it("tells a user's search opened during the query's resync that one is running", async () => {
		const own = fakeHandle(one)
		const user = fakeHandle()
		const { client, resync } = fakeClient([own, user])
		const engine = createSearchEngine()
		const pushes: SearchPush[] = []

		void engine.query(client, { rootUuid: null, names: ["doc"] }, OPTIONS)
		await vi.advanceTimersByTimeAsync(0)
		resync({ type: "started", roots: [ROOT] })
		await engine.open(client, { rootUuid: null, name: "mine" }, p => pushes.push(p))

		expect(pushes).toEqual([{ type: "resync", resyncing: true }])
		resync({ type: "finished", converged: true })
		// Cleared once the post-finish re-read agrees with what the window delivered.
		await vi.advanceTimersByTimeAsync(0)
		expect(pushes.at(-1)).toEqual({ type: "resync", resyncing: false })
	})

	it("tries the next word in a window of its own when the first matches more than the window, keeping the fewest", async () => {
		const totals: Record<string, bigint> = { report: 5_000n, "2024": 1_200n, q3: 3n }
		const own = fakeHandle(name => snapshot({ results: [hit], total: totals[name] ?? 0n }))
		const user = fakeHandle()
		const { client } = fakeClient([user, own])
		const engine = createSearchEngine()

		await engine.open(client, { rootUuid: null, name: "" }, () => undefined)

		const result = engine.query(client, { rootUuid: null, names: ["report", "2024", "q3"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(100)
		expect(own.search.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ name: "2024" }))
		await vi.advanceTimersByTimeAsync(100)
		expect(own.search.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ name: "q3" }))
		// A late delivery to the previous word's window is not taken for this word's.
		own.deliverTo(1, snapshot({ results: [hit], total: 2n }))
		await vi.advanceTimersByTimeAsync(100)

		await expect(result).resolves.toMatchObject({ settled: true, name: "q3", snapshot: { total: 3n } })
		expect(own.search.setConfig).toHaveBeenCalledTimes(2)
		expect(own.windows.map(w => w.free.mock.calls.length)).toEqual([1, 1, 1])
	})

	it("stops trying words once one fits the window", async () => {
		const totals: Record<string, bigint> = { report: 5_000n, "2024": 1n }
		const own = fakeHandle(name => snapshot({ results: [hit], total: totals[name] ?? 0n }))
		const user = fakeHandle()
		const { client } = fakeClient([user, own])
		const engine = createSearchEngine()

		await engine.open(client, { rootUuid: null, name: "" }, () => undefined)

		const result = engine.query(client, { rootUuid: null, names: ["report", "2024", "q3"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(300)

		await expect(result).resolves.toMatchObject({ name: "2024", snapshot: { total: 1n } })
		expect(own.search.setConfig).toHaveBeenCalledTimes(1)
	})

	it("waits for a word's slow delivery when the handle's total disagrees with its window, and drops a word that never agrees", async () => {
		// "2024" and "2025" windows open on the previous filter's hits before their own arrive.
		const totals: Record<string, bigint> = { report: 5_000n, "2024": 2n, "2025": 7n }
		const own = fakeHandle(name => snapshot({ results: [hit], total: totals[name] ?? 0n }), new Set(["2024", "2025"]))
		const user = fakeHandle()
		const { client } = fakeClient([user, own])
		const engine = createSearchEngine()

		await engine.open(client, { rootUuid: null, name: "" }, () => undefined)

		const result = engine.query(client, { rootUuid: null, names: ["report", "2024"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(250)
		own.deliver(snapshot({ results: [hit], total: 2n }))
		await vi.advanceTimersByTimeAsync(100)

		await expect(result).resolves.toMatchObject({ settled: true, name: "2024", snapshot: { total: 2n } })

		const stale = engine.query(client, { rootUuid: null, names: ["report", "2025"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(400)

		await expect(stale).resolves.toMatchObject({ settled: true, name: "report", snapshot: { total: 5_000n } })
	})

	it("is not stopped by the user's open, and the user's open does not take the query's handle", async () => {
		const own = fakeHandle(one)
		const user = fakeHandle()
		const { client, resync } = fakeClient([own, user])
		const engine = createSearchEngine()
		const result = engine.query(client, { rootUuid: null, names: ["doc"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(0)
		resync({ type: "started", roots: [ROOT] })
		await engine.open(client, { rootUuid: null, name: "mine" }, () => undefined)
		await engine.close()
		expect(own.search.close).not.toHaveBeenCalled()
		resync({ type: "finished", converged: true })
		await vi.advanceTimersByTimeAsync(100)

		await expect(result).resolves.toMatchObject({ settled: true, snapshot: { total: 1n } })
		expect(user.search.close).toHaveBeenCalledTimes(1)
		expect(own.search.close).not.toHaveBeenCalled()
	})

	it("runs queries one at a time on the one handle", async () => {
		const own = fakeHandle(name => (name === "a" ? one() : snapshot()))
		const user = fakeHandle()
		const { client, createSearch } = fakeClient([user, own])
		const engine = createSearchEngine()

		await engine.open(client, { rootUuid: null, name: "" }, () => undefined)

		const first = engine.query(client, { rootUuid: null, names: ["a"] }, OPTIONS)
		const second = engine.query(client, { rootUuid: null, names: ["b"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(50)
		expect(own.search.setConfig).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(50)
		await expect(first).resolves.toMatchObject({ name: "a", snapshot: { total: 1n } })
		await vi.advanceTimersByTimeAsync(100)
		await expect(second).resolves.toMatchObject({ name: "b", snapshot: { total: 0n } })
		expect(createSearch).toHaveBeenCalledTimes(2)
	})

	it("stops every query and closes every handle on shutdown", async () => {
		const own = fakeHandle()
		const user = fakeHandle()
		const { client, resync } = fakeClient([own, user])
		const engine = createSearchEngine()

		void engine.query(client, { rootUuid: null, names: ["a"] }, OPTIONS)
		await vi.advanceTimersByTimeAsync(0)
		resync({ type: "started", roots: [ROOT] })
		await engine.open(client, { rootUuid: null, name: "mine" }, () => undefined)

		const running = engine.query(client, { rootUuid: null, names: ["b"] }, OPTIONS)

		await vi.advanceTimersByTimeAsync(0)
		await engine.shutdown()

		await expect(running).resolves.toMatchObject({ settled: false })
		expect(user.search.close).toHaveBeenCalledTimes(1)
		expect(own.search.close).toHaveBeenCalledTimes(1)
		await expect(engine.query(client, { rootUuid: null, names: ["c"] }, OPTIONS)).resolves.toMatchObject({ settled: false })
	})

	it("serves the next sign-in's client after a logout that kept the worker, configuring its cache anew", async () => {
		const old = fakeClient([fakeHandle()])
		const engine = createSearchEngine()

		void engine.query(old.client, { rootUuid: null, names: ["a"] }, OPTIONS)
		await vi.advanceTimersByTimeAsync(0)
		await engine.shutdown()

		const next = fakeClient([fakeHandle(one)])
		const result = engine.query(next.client, { rootUuid: null, names: ["x"] }, OPTIONS)

		// A fresh client's handle registers the root: its resync has to run before the index counts.
		await vi.advanceTimersByTimeAsync(0)
		next.resync({ type: "started", roots: [ROOT] })
		next.resync({ type: "finished", converged: true })
		await vi.advanceTimersByTimeAsync(200)

		await expect(result).resolves.toMatchObject({ name: "x", snapshot: { total: 1n } })
		expect(next.configureCache).toHaveBeenCalledTimes(1)
		// The old session's client stays shut out.
		await expect(engine.query(old.client, { rootUuid: null, names: ["c"] }, OPTIONS)).resolves.toMatchObject({ settled: false })
	})
})
