import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { persistQueryClientRestore, persistQueryClientSave } from "@tanstack/react-query-persist-client"
import { stringifyEnvelope } from "@/lib/serialize"
import { log } from "@/lib/log"
import { persister, PERSIST_KEY } from "@/queries/persist"

// Mirrors src/lib/storage/adapter.test.ts's Map-backed fake StorageApi, mocked one level up at
// `@/lib/storage/adapter`'s `storage()` — persist.ts's kv bridge calls that directly (ambiguity
// resolution #2: kvGet/kvSet/kvDelete, never kvGetJson/kvSetJson — the persister already owns
// serialization, so going through the JSON-aware helpers would double-envelope every write).
const { fakeStore } = vi.hoisted(() => ({ fakeStore: new Map<string, string>() }))

vi.mock("@/lib/storage/adapter", () => ({
	storage: () =>
		Promise.resolve({
			role: "leader" as const,
			api: {
				kvGet: (key: string) => Promise.resolve(fakeStore.get(key) ?? null),
				kvSet: (key: string, value: string) => {
					fakeStore.set(key, value)
					return Promise.resolve()
				},
				kvDelete: (key: string) => {
					fakeStore.delete(key)
					return Promise.resolve()
				}
			}
		})
}))

beforeEach(() => {
	fakeStore.clear()
	vi.restoreAllMocks()
})

// Uses the real dehydrate/hydrate/persistQueryClient* functions throughout (never a hand-rolled
// stand-in for TanStack internals) — only the kv transport underneath the persister is faked.
describe("query persister (Map-backed fake kv)", () => {
	it("round-trips a dehydrated bigint through persist -> restore", async () => {
		const source = new QueryClient()
		source.setQueryData(["drive", "quota"], { usedBytes: 123456789012345678n })

		await persistQueryClientSave({ queryClient: source, persister, buster: PERSIST_KEY })

		const target = new QueryClient()
		await persistQueryClientRestore({ queryClient: target, persister, buster: PERSIST_KEY })

		expect(target.getQueryData(["drive", "quota"])).toEqual({ usedBytes: 123456789012345678n })
	})

	it("restores a corrupted stored string as an empty cache, never throws", async () => {
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined)
		fakeStore.set(PERSIST_KEY, "{not valid json")

		const target = new QueryClient()

		await expect(persistQueryClientRestore({ queryClient: target, persister, buster: PERSIST_KEY })).resolves.toBeUndefined()

		expect(target.getQueryCache().getAll()).toHaveLength(0)
		expect(warnSpy).toHaveBeenCalledWith("query.persist", expect.stringContaining("unparseable"), expect.anything())
	})

	it("rejects a wrong-shape envelope via the wrapper schema: warns, restores empty, never throws", async () => {
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined)
		fakeStore.set(PERSIST_KEY, stringifyEnvelope({ oops: true }))

		const target = new QueryClient()

		await expect(persistQueryClientRestore({ queryClient: target, persister, buster: PERSIST_KEY })).resolves.toBeUndefined()

		expect(target.getQueryCache().getAll()).toHaveLength(0)
		expect(warnSpy).toHaveBeenCalledWith("query.persist", expect.stringContaining("invalid"), expect.anything())
	})
})
