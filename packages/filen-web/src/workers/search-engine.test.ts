import { describe, expect, it, vi } from "vitest"
import type { Client, CacheSearchSnapshot, CacheStatusMessage, Dir, File, UuidStr } from "@filen/sdk-rs"
import { createSearchEngine, SearchSupersededError, CEILING, type SearchPush } from "@/workers/search-engine"

// UuidStr is a branded template literal requiring at least 3 dashes (see @filen/sdk-rs) — mirrors
// queries/drive.test.ts's own testUuid() so a readable label still satisfies the brand.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

// A controllable promise for interleaving two engine calls at a precise await point — vitest has no
// built-in for this, and the codebase's own DeferFn (@filen/utils) is a cleanup callback, not a
// resolver, so this is a small test-only primitive. No `!`: the executor runs synchronously, but the
// assignment is still read through an optional call rather than asserted non-null.
function deferredPromise<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
	let resolveFn: ((value: T) => void) | undefined
	let rejectFn: ((reason: unknown) => void) | undefined

	const promise = new Promise<T>((resolve, reject) => {
		resolveFn = resolve
		rejectFn = reject
	})

	return {
		promise,
		resolve: value => {
			resolveFn?.(value)
		},
		reject: reason => {
			rejectFn?.(reason)
		}
	}
}

function snapshot(overrides: Partial<CacheSearchSnapshot> = {}): CacheSearchSnapshot {
	return { results: [], total: 0n, live: true, ...overrides }
}

type SnapshotListener = (s: CacheSearchSnapshot) => void

// initialSnapshot() is consume-once on the real handle (see sdk-rs.d.ts) — the fake mirrors that so
// the undefined-fallback path is exercised the same way it would be live.
function makeFakeWindow(initial: CacheSearchSnapshot | undefined) {
	let consumed = false

	return {
		free: vi.fn(),
		initialSnapshot: vi.fn(() => {
			if (consumed) {
				return undefined
			}

			consumed = true

			return initial
		})
	}
}

function makeFakeSearch(
	getRangeImpl: (start: bigint, end: bigint, listener: SnapshotListener) => Promise<ReturnType<typeof makeFakeWindow>>
) {
	return {
		close: vi.fn(() => Promise.resolve(undefined)),
		free: vi.fn(),
		setConfig: vi.fn(() => Promise.resolve(undefined)),
		getRange: vi.fn(getRangeImpl)
	}
}

// Resolves getRange immediately with `fakeWindow`, capturing the listener into `onListener` so a
// test can drive further pushes by hand.
function fakeSearchResolving(fakeWindow: ReturnType<typeof makeFakeWindow>, onListener?: (listener: SnapshotListener) => void) {
	return makeFakeSearch((_start, _end, listener) => {
		onListener?.(listener)

		return Promise.resolve(fakeWindow)
	})
}

function makeFakeClient(
	createSearch: ReturnType<typeof vi.fn>,
	rootUuid = "root-uuid",
	configureCacheResult: () => Promise<undefined> = () => Promise.resolve(undefined)
) {
	let capturedStatusListener: ((messages: CacheStatusMessage[]) => void) | undefined

	const configureCache = vi.fn((_path: string, listener: (messages: CacheStatusMessage[]) => void) => {
		capturedStatusListener = listener

		return configureCacheResult()
	})

	const fakeClient = {
		configureCache,
		createSearch,
		root: vi.fn(() => ({ uuid: rootUuid }))
	}

	return {
		client: fakeClient as unknown as Client,
		configureCache,
		statusListener: () => capturedStatusListener
	}
}

function collectPushes(): { push: (p: SearchPush) => void; pushes: SearchPush[] } {
	const pushes: SearchPush[] = []

	return { push: p => pushes.push(p), pushes }
}

describe("createSearchEngine — open", () => {
	it("resolves the drive root when rootUuid is null and passes the trimmed name + fixed config", async () => {
		const fakeWindow = makeFakeWindow(snapshot())
		const search = fakeSearchResolving(fakeWindow)
		const createSearch = vi.fn(() => Promise.resolve(search))
		const { client } = makeFakeClient(createSearch, "the-root")
		const engine = createSearchEngine()
		const { push } = collectPushes()

		await engine.open(client, { rootUuid: null, name: "  doc  " }, push)

		expect(createSearch).toHaveBeenCalledWith("the-root", { name: "doc", itemType: "all", recursive: true, caseSensitive: false })
	})

	it("passes an explicit rootUuid straight through and an all-whitespace name as undefined", async () => {
		const fakeWindow = makeFakeWindow(snapshot())
		const search = fakeSearchResolving(fakeWindow)
		const createSearch = vi.fn(() => Promise.resolve(search))
		const { client } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push } = collectPushes()

		await engine.open(client, { rootUuid: "explicit-root", name: "   " }, push)

		expect(createSearch).toHaveBeenCalledWith("explicit-root", {
			name: undefined,
			itemType: "all",
			recursive: true,
			caseSensitive: false
		})
	})

	it("requests the whole-set window in one getRange call at the fixed ceiling", async () => {
		const fakeWindow = makeFakeWindow(snapshot())
		const search = fakeSearchResolving(fakeWindow)
		const createSearch = vi.fn(() => Promise.resolve(search))
		const { client } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push } = collectPushes()

		await engine.open(client, { rootUuid: null, name: "" }, push)

		expect(search.getRange).toHaveBeenCalledWith(0n, CEILING, expect.any(Function))
	})

	it("resolves with the consumed initialSnapshot when the window already has one", async () => {
		const hit = { parentPath: "sub", result: { type: "dir" as const, dir: { uuid: "d1" } as unknown as Dir } }
		const fakeWindow = makeFakeWindow(snapshot({ results: [hit], total: 1n }))
		const search = fakeSearchResolving(fakeWindow)
		const createSearch = vi.fn(() => Promise.resolve(search))
		const { client } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push } = collectPushes()

		const result = await engine.open(client, { rootUuid: null, name: "" }, push)

		expect(result).toEqual({ hits: [{ parentPath: "sub", item: hit.result.dir }], total: 1n, live: true })
	})

	it("maps a file hit's result arm the same way a directory hit's is mapped", async () => {
		const hit = { parentPath: "", result: { type: "file" as const, file: { uuid: "f1" } as unknown as File } }
		const fakeWindow = makeFakeWindow(snapshot({ results: [hit], total: 1n }))
		const search = fakeSearchResolving(fakeWindow)
		const createSearch = vi.fn(() => Promise.resolve(search))
		const { client } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push } = collectPushes()

		const result = await engine.open(client, { rootUuid: null, name: "" }, push)

		expect(result.hits).toEqual([{ parentPath: "", item: hit.result.file }])
	})

	it("falls back to the first listener delivery when initialSnapshot is undefined", async () => {
		const fakeWindow = makeFakeWindow(undefined)
		let capturedListener: SnapshotListener | undefined
		const search = fakeSearchResolving(fakeWindow, listener => {
			capturedListener = listener
		})
		const createSearch = vi.fn(() => Promise.resolve(search))
		const { client } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push } = collectPushes()

		const openPromise = engine.open(client, { rootUuid: null, name: "" }, push)

		await vi.waitFor(() => {
			expect(capturedListener).toBeDefined()
		})

		capturedListener?.(snapshot({ total: 2n }))

		await expect(openPromise).resolves.toEqual({ hits: [], total: 2n, live: true })
	})

	it("does not re-push the delivery that resolved the fallback — only later deliveries reach push", async () => {
		const fakeWindow = makeFakeWindow(undefined)
		let capturedListener: SnapshotListener | undefined
		const search = fakeSearchResolving(fakeWindow, listener => {
			capturedListener = listener
		})
		const createSearch = vi.fn(() => Promise.resolve(search))
		const { client } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push, pushes } = collectPushes()

		const openPromise = engine.open(client, { rootUuid: null, name: "" }, push)

		await vi.waitFor(() => {
			expect(capturedListener).toBeDefined()
		})

		capturedListener?.(snapshot({ total: 1n }))
		await openPromise

		expect(pushes).toHaveLength(0)

		capturedListener?.(snapshot({ total: 2n }))

		expect(pushes).toEqual([{ type: "snapshot", hits: [], total: 2n, live: true }])
	})

	it("configures the cache exactly once across two sequential opens", async () => {
		const createSearch = vi
			.fn()
			.mockResolvedValueOnce(fakeSearchResolving(makeFakeWindow(snapshot())))
			.mockResolvedValueOnce(fakeSearchResolving(makeFakeWindow(snapshot())))
		const { client, configureCache } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push } = collectPushes()

		await engine.open(client, { rootUuid: null, name: "a" }, push)
		await engine.open(client, { rootUuid: null, name: "b" }, push)

		expect(configureCache).toHaveBeenCalledTimes(1)
	})

	it("closes and frees the previous active search+window when a later open installs", async () => {
		const windowA = makeFakeWindow(snapshot())
		const searchA = fakeSearchResolving(windowA)
		const windowB = makeFakeWindow(snapshot())
		const searchB = fakeSearchResolving(windowB)
		const createSearch = vi.fn().mockResolvedValueOnce(searchA).mockResolvedValueOnce(searchB)
		const { client } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push } = collectPushes()

		await engine.open(client, { rootUuid: null, name: "a" }, push)
		await engine.open(client, { rootUuid: null, name: "b" }, push)

		// void safeClose is fire-and-forget on install — let its microtasks settle.
		await vi.waitFor(() => {
			expect(searchA.close).toHaveBeenCalledTimes(1)
		})

		expect(windowA.free).toHaveBeenCalledTimes(1)
		expect(searchA.free).toHaveBeenCalledTimes(1)
		expect(searchB.close).not.toHaveBeenCalled()
		expect(searchB.free).not.toHaveBeenCalled()
	})

	it("tears a superseded orphan down in the verified window-then-search order, without installing it", async () => {
		const order: string[] = []
		const deferredRange = deferredPromise<ReturnType<typeof makeFakeWindow>>()
		const windowA = makeFakeWindow(snapshot())

		windowA.free.mockImplementation(() => {
			order.push("windowA.free")
		})

		const searchA = makeFakeSearch(() => deferredRange.promise)

		searchA.close.mockImplementation(() => {
			order.push("searchA.close")

			return Promise.resolve(undefined)
		})
		searchA.free.mockImplementation(() => {
			order.push("searchA.free")
		})

		const windowB = makeFakeWindow(snapshot())
		const searchB = fakeSearchResolving(windowB)
		const createSearch = vi.fn().mockResolvedValueOnce(searchA).mockResolvedValueOnce(searchB)
		const { client } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push: pushA } = collectPushes()
		const { push: pushB } = collectPushes()

		const openA = engine.open(client, { rootUuid: null, name: "a" }, pushA)

		await vi.waitFor(() => {
			expect(searchA.getRange).toHaveBeenCalledTimes(1)
		})

		const openB = engine.open(client, { rootUuid: null, name: "b" }, pushB)

		await expect(openB).resolves.toEqual({ hits: [], total: 0n, live: true })

		deferredRange.resolve(windowA)

		await expect(openA).rejects.toThrow(SearchSupersededError)
		expect(order).toEqual(["windowA.free", "searchA.close", "searchA.free"])
		expect(searchB.close).not.toHaveBeenCalled()
	})

	it("closes+frees an orphan created before getRange was ever reached (superseded during createSearch)", async () => {
		const deferredCreate = deferredPromise<ReturnType<typeof fakeSearchResolving>>()
		const createSearch = vi.fn().mockReturnValueOnce(deferredCreate.promise)
		const { client } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push: pushA } = collectPushes()

		const openA = engine.open(client, { rootUuid: null, name: "a" }, pushA)

		await vi.waitFor(() => {
			expect(createSearch).toHaveBeenCalledTimes(1)
		})

		const windowB = makeFakeWindow(snapshot())
		const searchB = fakeSearchResolving(windowB)

		createSearch.mockResolvedValueOnce(searchB)

		const { push: pushB } = collectPushes()
		const openB = engine.open(client, { rootUuid: null, name: "b" }, pushB)

		await expect(openB).resolves.toEqual({ hits: [], total: 0n, live: true })

		const searchA = fakeSearchResolving(makeFakeWindow(snapshot()))

		deferredCreate.resolve(searchA)

		await expect(openA).rejects.toThrow(SearchSupersededError)
		expect(searchA.close).toHaveBeenCalledTimes(1)
		expect(searchA.free).toHaveBeenCalledTimes(1)
		expect(searchA.getRange).not.toHaveBeenCalled()
	})

	it("frees a search whose getRange genuinely rejects (not a supersede) and rethrows the same error", async () => {
		const boom = new Error("getRange boom")
		const search = makeFakeSearch(() => Promise.reject(boom))
		const createSearch = vi.fn(() => Promise.resolve(search))
		const { client } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push } = collectPushes()

		await expect(engine.open(client, { rootUuid: null, name: "" }, push)).rejects.toBe(boom)
		expect(search.close).toHaveBeenCalledTimes(1)
		expect(search.free).toHaveBeenCalledTimes(1)
	})

	// Regression coverage for a real bug: a genuine configureCache rejection used to leave
	// activeRootUuid/activePush/currentToken all set (no catch existed around that await at all), so
	// the module-level statusListener kept routing later, unrelated status events to this dead open's
	// push. Reusing the SAME root for both the failed open and the injected status event is the
	// strongest version of this test — even a same-root event must not reach the dead push once the
	// routing state is properly cleared.
	it("clears routing state on a genuine configureCache rejection so a later status event never reaches the dead push", async () => {
		const boom = new Error("configureCache boom")
		const deadRoot = testUuid("dead-root-configure")
		const createSearch = vi.fn()
		const { client, statusListener } = makeFakeClient(createSearch, deadRoot, () => Promise.reject(boom))
		const engine = createSearchEngine()
		const { push, pushes } = collectPushes()

		await expect(engine.open(client, { rootUuid: deadRoot, name: "" }, push)).rejects.toBe(boom)
		expect(createSearch).not.toHaveBeenCalled()

		const listener = statusListener()

		if (listener === undefined) {
			throw new Error("test setup: configureCache never captured a status listener")
		}

		listener([{ type: "resyncProgress", progress: { type: "started", roots: [deadRoot] } }])

		expect(pushes).toEqual([])

		// "finished" carries no roots and isn't gated on activeRootUuid at all (see statusListener's own
		// branch) — activePush being cleared is the ONLY thing that stops it reaching this dead open's
		// push, so this is the branch that actually pins the activePush half of the clear.
		listener([{ type: "resyncProgress", progress: { type: "finished", converged: true } }])

		expect(pushes).toEqual([])
	})

	// Companion coverage for the EXISTING createSearch catch (unchanged by this task) — pins that it
	// already clears activeRootUuid on a genuine rejection, so a same-root status event correctly never
	// reaches the dead open's push either.
	it("clears routing state on a genuine createSearch rejection so a later status event never reaches the dead push", async () => {
		const boom = new Error("createSearch boom")
		const deadRoot = testUuid("dead-root-create")
		const createSearch = vi.fn(() => Promise.reject(boom))
		const { client, statusListener } = makeFakeClient(createSearch, deadRoot)
		const engine = createSearchEngine()
		const { push, pushes } = collectPushes()

		await expect(engine.open(client, { rootUuid: deadRoot, name: "" }, push)).rejects.toBe(boom)

		const listener = statusListener()

		if (listener === undefined) {
			throw new Error("test setup: configureCache never captured a status listener")
		}

		listener([{ type: "resyncProgress", progress: { type: "started", roots: [deadRoot] } }])

		expect(pushes).toEqual([])
	})

	it("pushes every snapshot delivered after the first, tagged as type snapshot", async () => {
		const fakeWindow = makeFakeWindow(snapshot({ total: 1n }))
		let capturedListener: SnapshotListener | undefined
		const search = fakeSearchResolving(fakeWindow, listener => {
			capturedListener = listener
		})
		const createSearch = vi.fn(() => Promise.resolve(search))
		const { client } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push, pushes } = collectPushes()

		await engine.open(client, { rootUuid: null, name: "" }, push)

		capturedListener?.(snapshot({ total: 4n }))

		expect(pushes).toEqual([{ type: "snapshot", hits: [], total: 4n, live: true }])
	})
})

describe("createSearchEngine — status listener routing", () => {
	const rootA = testUuid("root-a")
	const rootB = testUuid("root-b")

	async function openAndCaptureStatus(rootUuid: UuidStr) {
		const fakeWindow = makeFakeWindow(snapshot())
		const search = fakeSearchResolving(fakeWindow)
		const createSearch = vi.fn(() => Promise.resolve(search))
		const { client, statusListener } = makeFakeClient(createSearch, rootUuid)
		const engine = createSearchEngine()
		const { push, pushes } = collectPushes()

		await engine.open(client, { rootUuid, name: "" }, push)

		const listener = statusListener()

		if (listener === undefined) {
			throw new Error("test setup: configureCache never captured a status listener")
		}

		return { engine, listener, pushes }
	}

	it("pushes resync:true on a started resync covering the active root", async () => {
		const { listener, pushes } = await openAndCaptureStatus(rootA)

		listener([{ type: "resyncProgress", progress: { type: "started", roots: [rootA] } }])

		expect(pushes).toEqual([{ type: "resync", resyncing: true }])
	})

	it("ignores a started resync for an unrelated root", async () => {
		const { listener, pushes } = await openAndCaptureStatus(rootA)

		listener([{ type: "resyncProgress", progress: { type: "started", roots: [rootB] } }])

		expect(pushes).toEqual([])
	})

	it("pushes resync:false on finished regardless of which root it names (finished carries none)", async () => {
		const { listener, pushes } = await openAndCaptureStatus(rootA)

		listener([{ type: "resyncProgress", progress: { type: "finished", converged: true } }])

		expect(pushes).toEqual([{ type: "resync", resyncing: false }])
	})

	it("pushes a heartbeat on a listing tick regardless of which root it names", async () => {
		const { listener, pushes } = await openAndCaptureStatus(rootA)

		listener([
			{
				type: "resyncProgress",
				progress: { type: "listing", root: rootB, root_index: 0n, root_count: 1n, bytes_downloaded: 0n, total_bytes: undefined }
			}
		])

		expect(pushes).toEqual([{ type: "heartbeat" }])
	})

	it("pushes a heartbeat on an applying tick", async () => {
		const { listener, pushes } = await openAndCaptureStatus(rootA)

		listener([{ type: "resyncProgress", progress: { type: "applying" } }])

		expect(pushes).toEqual([{ type: "heartbeat" }])
	})

	it("pushes rootDeleted when syncRootsDeleted names the active root", async () => {
		const { listener, pushes } = await openAndCaptureStatus(rootA)

		listener([{ type: "syncRootsDeleted", roots: [rootA] }])

		expect(pushes).toEqual([{ type: "rootDeleted" }])
	})

	it("ignores syncRootsDeleted for an unrelated root", async () => {
		const { listener, pushes } = await openAndCaptureStatus(rootA)

		listener([{ type: "syncRootsDeleted", roots: [rootB] }])

		expect(pushes).toEqual([])
	})

	it("never pushes for a bare errors message", async () => {
		const { listener, pushes } = await openAndCaptureStatus(rootA)

		listener([{ type: "errors", errors: ["boom"] }])

		expect(pushes).toEqual([])
	})

	it("stops routing to a closed session's push", async () => {
		const { engine, listener, pushes } = await openAndCaptureStatus(rootA)

		await engine.close()

		listener([{ type: "resyncProgress", progress: { type: "started", roots: [rootA] } }])

		expect(pushes).toEqual([])
	})
})

describe("createSearchEngine — setName", () => {
	it("returns false with no live search to refilter", async () => {
		const engine = createSearchEngine()

		await expect(engine.setName("doc")).resolves.toBe(false)
	})

	it("calls setConfig on the live handle with the same fixed shape open uses, and returns true", async () => {
		const search = fakeSearchResolving(makeFakeWindow(snapshot()))
		const createSearch = vi.fn(() => Promise.resolve(search))
		const { client } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push } = collectPushes()

		await engine.open(client, { rootUuid: null, name: "" }, push)

		await expect(engine.setName("  report  ")).resolves.toBe(true)
		expect(search.setConfig).toHaveBeenCalledWith({ name: "report", itemType: "all", recursive: true, caseSensitive: false })
	})

	it("returns false and swallows a setConfig rejection", async () => {
		const search = fakeSearchResolving(makeFakeWindow(snapshot()))

		search.setConfig.mockRejectedValueOnce(new Error("setConfig boom"))

		const createSearch = vi.fn(() => Promise.resolve(search))
		const { client } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push } = collectPushes()

		await engine.open(client, { rootUuid: null, name: "" }, push)

		await expect(engine.setName("x")).resolves.toBe(false)
	})
})

describe("createSearchEngine — close", () => {
	it("resolves cleanly with nothing ever opened", async () => {
		const engine = createSearchEngine()

		await expect(engine.close()).resolves.toBeUndefined()
	})

	it("frees the window, then closes, then frees the search, in that order", async () => {
		const order: string[] = []
		const fakeWindow = makeFakeWindow(snapshot())

		fakeWindow.free.mockImplementation(() => {
			order.push("window.free")
		})

		const search = fakeSearchResolving(fakeWindow)

		search.close.mockImplementation(() => {
			order.push("search.close")

			return Promise.resolve(undefined)
		})
		search.free.mockImplementation(() => {
			order.push("search.free")
		})

		const createSearch = vi.fn(() => Promise.resolve(search))
		const { client } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push } = collectPushes()

		await engine.open(client, { rootUuid: null, name: "" }, push)
		await engine.close()

		expect(order).toEqual(["window.free", "search.close", "search.free"])
	})

	it("is a no-op the second time (nothing left to close)", async () => {
		const search = fakeSearchResolving(makeFakeWindow(snapshot()))
		const createSearch = vi.fn(() => Promise.resolve(search))
		const { client } = makeFakeClient(createSearch)
		const engine = createSearchEngine()
		const { push } = collectPushes()

		await engine.open(client, { rootUuid: null, name: "" }, push)
		await engine.close()

		search.close.mockClear()
		search.free.mockClear()

		await engine.close()

		expect(search.close).not.toHaveBeenCalled()
		expect(search.free).not.toHaveBeenCalled()
	})
})
