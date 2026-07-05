import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { stringifyEnvelope } from "@/lib/serialize"
import { log } from "@/lib/log"
import { persister, restorePersistedQueries, PERSIST_PREFIX } from "@/queries/persist"

// Map-backed fake of the kv worker api (mirrors src/lib/storage/adapter.test.ts), mocked at
// `@/lib/storage/adapter`'s `storage()` — the persister's kv bridge calls that directly with RAW
// strings (kvGet/kvSet/kvDelete/kvKeys, never kvGetJson/kvSetJson: the persister owns its own
// envelope, so the JSON-aware helpers would double-envelope every row). `writes` records every
// kvSet key so tests can assert per-query write isolation (the point of this architecture).
const { fakeStore, writes } = vi.hoisted(() => ({ fakeStore: new Map<string, string>(), writes: [] as string[] }))

vi.mock("@/lib/storage/adapter", () => ({
	storage: () =>
		Promise.resolve({
			role: "leader" as const,
			api: {
				kvGet: (key: string) => Promise.resolve(fakeStore.get(key) ?? null),
				kvSet: (key: string, value: string) => {
					fakeStore.set(key, value)
					writes.push(key)
					return Promise.resolve()
				},
				kvDelete: (key: string) => {
					fakeStore.delete(key)
					return Promise.resolve()
				},
				kvKeys: (prefix: string) => Promise.resolve([...fakeStore.keys()].filter(k => k.startsWith(prefix)))
			}
		})
}))

// A client wired the way T9 will wire the real singleton: the per-query persister as a DEFAULT, so
// every fetch persists/restores its own row automatically through real TanStack machinery — no
// hand-rolled stand-ins for library internals anywhere in this suite; only the kv layer is faked.
function makeClient(): QueryClient {
	return new QueryClient({ defaultOptions: { queries: { retry: false, persister: persister.persisterFn } } })
}

async function seedTwoQueries(): Promise<{ quotaKey: string; notesKey: string; client: QueryClient }> {
	const client = makeClient()

	await client.fetchQuery({ queryKey: ["drive", "quota"], queryFn: () => ({ usedBytes: 123456789012345678n }) })
	await client.fetchQuery({ queryKey: ["notes", "list"], queryFn: () => [{ uuid: "n1", size: 42n }] })

	// persistQuery is scheduled via notifyManager (setTimeout 0) and the kv write is async — poll.
	await vi.waitFor(() => {
		expect(fakeStore.size).toBe(2)
	})

	const quotaKey = [...fakeStore.keys()].find(k => k.includes("quota"))
	const notesKey = [...fakeStore.keys()].find(k => k.includes("notes"))

	if (quotaKey === undefined || notesKey === undefined) {
		throw new Error("seed rows missing")
	}

	return { quotaKey, notesKey, client }
}

beforeEach(() => {
	fakeStore.clear()
	writes.length = 0
	vi.restoreAllMocks()
})

describe("per-query persister (Map-backed fake kv)", () => {
	it("writes only the changed query's row (no whole-cache write amplification)", async () => {
		const { quotaKey, notesKey, client } = await seedTwoQueries()

		expect(quotaKey.startsWith(`${PERSIST_PREFIX}-`)).toBe(true) // the persister's own `${prefix}-${queryHash}` key scheme

		const notesRowBefore = fakeStore.get(notesKey)

		writes.length = 0

		// Default staleTime 0 → this fetchQuery refetches the existing query with new data.
		await client.fetchQuery({ queryKey: ["drive", "quota"], queryFn: () => ({ usedBytes: 2n }) })

		await vi.waitFor(() => {
			expect(writes).toContain(quotaKey)
		})

		expect(writes).not.toContain(notesKey)
		expect(fakeStore.get(notesKey)).toBe(notesRowBefore)
	})

	it("skips persisting an unserializable update (warn, no write, previous row kept) without an unhandled rejection", async () => {
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined)
		const client = makeClient()

		await client.fetchQuery({ queryKey: ["boot", "config"], queryFn: () => ({ ok: true }) })

		await vi.waitFor(() => {
			expect(fakeStore.size).toBe(1)
		})

		const key = [...fakeStore.keys()][0]

		if (key === undefined) {
			throw new Error("seed row missing")
		}

		const rowBefore = fakeStore.get(key)

		writes.length = 0

		// A circular ref is the reliable JSON.stringify throw (functions/symbols are silently
		// DROPPED by JSON semantics, they don't throw). The refetch itself succeeds in memory —
		// only the persistence write must degrade.
		interface Circular {
			self?: Circular
		}
		const circular: Circular = {}
		circular.self = circular

		await client.fetchQuery({ queryKey: ["boot", "config"], queryFn: () => circular })

		// The wrapped serialize turns the throw into warn + skip. Without the wrap this waitFor
		// times out (no warn ever fires) and the floating persistQuery rejection additionally
		// fails the run as an unhandled error — either way, RED.
		await vi.waitFor(() => {
			expect(warnSpy).toHaveBeenCalledWith("query.persist", expect.stringContaining("unserializable"), expect.anything())
		})

		expect(writes).toEqual([])
		expect(fakeStore.get(key)).toBe(rowBefore)
	})

	it("restore-all on boot restores multiple queries including bigint data", async () => {
		await seedTwoQueries()

		const target = new QueryClient()

		await restorePersistedQueries(target)

		expect(target.getQueryData(["drive", "quota"])).toEqual({ usedBytes: 123456789012345678n })
		expect(target.getQueryData(["notes", "list"])).toEqual([{ uuid: "n1", size: 42n }])
	})

	it("drops ONE corrupted row (warn + self-heal) while the others restore fine", async () => {
		const { notesKey } = await seedTwoQueries()
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined)

		fakeStore.set(notesKey, "{not valid json")

		const target = new QueryClient()

		await restorePersistedQueries(target)

		expect(target.getQueryData(["drive", "quota"])).toEqual({ usedBytes: 123456789012345678n })
		expect(target.getQueryData(["notes", "list"])).toBeUndefined()
		expect(fakeStore.has(notesKey)).toBe(false) // the library removes the bad row (self-heal)
		expect(warnSpy).toHaveBeenCalledWith("query.persist", expect.stringContaining("unparseable"), expect.anything())
	})

	it("drops a wrong-shape envelope via the wrapper schema (warn + self-heal), other rows unaffected", async () => {
		const { quotaKey } = await seedTwoQueries()
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined)
		const badKey = `${PERSIST_PREFIX}-["bad"]`

		fakeStore.set(badKey, stringifyEnvelope({ oops: true }))

		const target = new QueryClient()

		await restorePersistedQueries(target)

		expect(target.getQueryData(["drive", "quota"])).toEqual({ usedBytes: 123456789012345678n })
		expect(fakeStore.has(badKey)).toBe(false)
		expect(fakeStore.has(quotaKey)).toBe(true)
		expect(warnSpy).toHaveBeenCalledWith("query.persist", expect.stringContaining("invalid"), expect.anything())
	})

	it("drops a buster-mismatched row (old cache version) on restore", async () => {
		const legacyKey = `${PERSIST_PREFIX}-["legacy"]`

		fakeStore.set(
			legacyKey,
			stringifyEnvelope({
				buster: "rq.v0",
				queryHash: '["legacy"]',
				queryKey: ["legacy"],
				state: { data: { n: 1 }, dataUpdatedAt: Date.now(), status: "success" }
			})
		)

		const target = new QueryClient()

		await restorePersistedQueries(target)

		expect(target.getQueryData(["legacy"])).toBeUndefined()
		expect(fakeStore.has(legacyKey)).toBe(false)
	})
})
