/**
 * HARDENING suite for src/queries/client.ts — contract tripwires added ahead of the perf
 * campaign (2026-06-11). The existing queryPersister.test.ts + client.test.ts suites are
 * deep; this file pins exactly the two behaviors the planned optimizations touch:
 *
 * 1. TRAILING-DEBOUNCE WINDOW EXTENSION — a setItem inside the pending window pushes the
 *    persist out to (last write + PERSIST_DEBOUNCE); nothing lands before that. The
 *    per-mutation debounce machinery is being replaced with an O(1) scheduler (same as
 *    the cache campaign) and must reproduce extension semantics, not just "fires
 *    eventually".
 * 2. queryUpdater.set SWALLOWS persist failures — a rejecting persistQueryByKey must
 *    neither prevent the setQueryData from landing nor surface as an unhandled
 *    rejection. The run() wrapper that currently guarantees this is being slimmed.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

const { mockDb, open, mockPersistQueryByKey } = vi.hoisted(() => {
	const mockDb = {
		execute: vi.fn(async (_query: unknown, _params?: unknown) => ({ rows: [] as never[], insertId: undefined, rowsAffected: 0 })),
		executeRaw: vi.fn(async (_query: unknown, _params?: unknown) => ({ rawRows: [] as unknown[][], columnNames: [] as string[], rowsAffected: 0 })),
		executeBatch: vi.fn(async (_commands: unknown) => ({ rowsAffected: 0 })),
		prepareStatement: vi.fn(() => ({
			bind: vi.fn(),
			bindSync: vi.fn(),
			execute: vi.fn(async () => ({ rows: [], insertId: undefined, rowsAffected: 0 }))
		})),
		close: vi.fn()
	}

	return {
		mockDb,
		open: vi.fn(() => mockDb),
		mockPersistQueryByKey: vi.fn(async () => undefined)
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", () => ({
	AppState: {
		addEventListener: () => ({ remove: () => {} }),
		currentState: "active"
	},
	Platform: {
		OS: "ios",
		select: <T,>(specifics: { ios?: T; android?: T; default?: T }) => specifics["ios"] ?? specifics["default"]
	}
}))

vi.mock("@op-engineering/op-sqlite", () => ({
	open
}))

vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: (path: string) => path
}))

vi.mock("@/lib/sdkErrors", () => ({
	unwrapSdkError: () => null,
	isNetworkClassError: () => false
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("@filen/sdk-rs", () => ({
	ErrorKind: { Unauthenticated: "Unauthenticated" }
}))

vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))

vi.mock("@tanstack/react-query", () => ({
	QueryClient: class {
		public defaultOptions = {}
		public setQueryData = vi.fn((_key: unknown, updater: unknown, _opts?: unknown) => {
			return typeof updater === "function" ? (updater as (prev: unknown) => unknown)(undefined) : updater
		})
		public getQueryData = vi.fn()
		public constructor(_opts?: unknown) {}
	},
	QueryCache: class {
		public constructor(_config?: unknown) {}
	},
	onlineManager: { isOnline: vi.fn(() => true) },
	notifyManager: { batch: (fn: () => unknown) => fn() },
	useQuery: vi.fn()
}))

vi.mock("@tanstack/query-persist-client-core", () => ({
	experimental_createQueryPersister: vi.fn(() => ({
		persisterFn: vi.fn(),
		persistQueryByKey: mockPersistQueryByKey
	}))
}))

vi.mock("@/lib/auth", () => ({
	default: {
		logout: vi.fn(async () => undefined)
	}
}))

vi.mock("@/stores/useApp.store", () => ({
	default: {
		getState: () => ({ biometricUnlocked: true })
	}
}))

import { QueryPersisterKv, queryUpdater } from "@/queries/client"

async function flushMicrotasks(maxTicks = 30): Promise<void> {
	for (let i = 0; i < maxTicks; i++) {
		await Promise.resolve()
	}
}

beforeEach(() => {
	vi.useFakeTimers()
	mockDb.executeBatch.mockClear()
	mockPersistQueryByKey.mockClear()
	mockPersistQueryByKey.mockImplementation(async () => undefined)
})

afterEach(() => {
	vi.useRealTimers()
})

describe("hardening — trailing-debounce window extension (QueryPersisterKv)", () => {
	it("a setItem inside the pending window pushes the persist out; nothing lands before last-write+debounce", async () => {
		const persister = new QueryPersisterKv()

		persister.setItem("query-1", { state: 1 })

		// 600ms in: inside the 1000ms window — nothing persisted.
		await vi.advanceTimersByTimeAsync(600)
		await flushMicrotasks()

		expect(mockDb.executeBatch).not.toHaveBeenCalled()

		// Second write extends the window to t=1600.
		persister.setItem("query-2", { state: 2 })

		// t=1200: past the first write's deadline, only 600ms past the second — still nothing.
		await vi.advanceTimersByTimeAsync(600)
		await flushMicrotasks()

		expect(mockDb.executeBatch).not.toHaveBeenCalled()

		// t=1700: past last-write+1000 — exactly one batch carrying both upserts.
		await vi.advanceTimersByTimeAsync(500)
		await flushMicrotasks()

		expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

		const commands = mockDb.executeBatch.mock.calls[0]?.[0] as [string, unknown[]][]

		expect(commands.filter(([sql]) => sql.startsWith("INSERT"))).toHaveLength(2)
	})
})

describe("hardening — queryUpdater.set swallows persist failures", () => {
	it("a rejecting persistQueryByKey does not block setQueryData and never escapes as an unhandled rejection", async () => {
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason)
		}

		process.on("unhandledRejection", onUnhandled)

		try {
			mockPersistQueryByKey.mockImplementation(async () => {
				throw new Error("persist boom")
			})

			queryUpdater.set(["hardening-key"], { value: 42 })

			await flushMicrotasks()
			await vi.advanceTimersByTimeAsync(10)
			await flushMicrotasks()

			expect(mockPersistQueryByKey).toHaveBeenCalledTimes(1)
			expect(unhandled).toHaveLength(0)
		} finally {
			process.off("unhandledRejection", onUnhandled)
		}
	})
})

// ---------------------------------------------------------------------------
// Reference-identity persist gate (QueryPersisterKv.canSkipPersist)
//
// TanStack's structural sharing hands back the PREVIOUS `data` reference when a
// refetch produced deep-equal content, so an unchanged reference is an exact
// "nothing changed". Without this gate a whale account's photos listing — one
// multi-MB row — was re-serialized and rewritten on every no-op refetch and on
// every unrelated drive mutation.
// ---------------------------------------------------------------------------

function persisted(data: unknown, dataUpdatedAt: number): unknown {
	return {
		state: {
			data,
			dataUpdatedAt,
			status: "success"
		}
	}
}

async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(1500)
	await flushMicrotasks()
}

describe("hardening — persist gate skips writes for unchanged data", () => {
	it("writes the first value, then skips a re-set carrying the SAME data reference", async () => {
		const persister = new QueryPersisterKv()
		const data = [{ uuid: "a" }]

		persister.setItem("q", persisted(data, 1_000))

		await settle()

		expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

		// A no-op refetch: new envelope, newer stamp, identical data reference.
		persister.setItem("q", persisted(data, 2_000))

		await settle()

		expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)
	})

	it("still writes when the data reference actually changes", async () => {
		const persister = new QueryPersisterKv()

		persister.setItem("q", persisted([{ uuid: "a" }], 1_000))

		await settle()

		persister.setItem("q", persisted([{ uuid: "a" }, { uuid: "b" }], 2_000))

		await settle()

		expect(mockDb.executeBatch).toHaveBeenCalledTimes(2)
	})

	it("keeps the newest value readable through getItem even when the write was skipped", async () => {
		const persister = new QueryPersisterKv()
		const data = [{ uuid: "a" }]
		const newest = persisted(data, 2_000)

		persister.setItem("q", persisted(data, 1_000))

		await settle()

		persister.setItem("q", newest)

		expect(persister.getItem("q")).toBe(newest)
	})

	it("re-writes an unchanged row once its stored stamp has aged, so the restore TTL cannot evict live data", async () => {
		const persister = new QueryPersisterKv()
		const data = [{ uuid: "a" }]
		const day = 86400 * 1000

		persister.setItem("q", persisted(data, 1_000))

		await settle()

		// Six days on: still inside the refresh window, still skipped.
		persister.setItem("q", persisted(data, 1_000 + 6 * day))

		await settle()

		expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

		// Eight days past the STORED stamp — the drift bound is measured from what actually
		// reached disk, not from the previous skip, so a long series of skips can never
		// accumulate past the window.
		persister.setItem("q", persisted(data, 1_000 + 8 * day))

		await settle()

		expect(mockDb.executeBatch).toHaveBeenCalledTimes(2)
	})

	it("coalesces repeats of unchanged data into a single write per debounce window", async () => {
		const persister = new QueryPersisterKv()
		const data = [{ uuid: "a" }]

		// Two sets inside one window collapse to one write; a later identical set adds none.
		// (canSkipPersist also refuses to reason about a key with a pending write, but that guard is
		// defensive — the flush reads the buffer at flush time, so it cannot be observed here.)
		persister.setItem("q", persisted(data, 1_000))
		persister.setItem("q", persisted(data, 2_000))

		await settle()

		expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)

		persister.setItem("q", persisted(data, 3_000))

		await settle()

		expect(mockDb.executeBatch).toHaveBeenCalledTimes(1)
	})

	it("does not skip for values that are not shaped like a persisted query", async () => {
		const persister = new QueryPersisterKv()

		persister.setItem("q", { state: 1 })

		await settle()

		persister.setItem("q", { state: 1 })

		await settle()

		expect(mockDb.executeBatch).toHaveBeenCalledTimes(2)
	})

	it("writes again after a removeItem, even for the same data reference", async () => {
		const persister = new QueryPersisterKv()
		const data = [{ uuid: "a" }]

		persister.setItem("q", persisted(data, 1_000))

		await settle()

		persister.removeItem("q")

		await settle()

		persister.setItem("q", persisted(data, 2_000))

		await settle()

		expect(mockDb.executeBatch).toHaveBeenCalledTimes(3)
	})
})
