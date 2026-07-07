import { beforeEach, describe, expect, it, vi } from "vitest"
import { type } from "arktype"
import { kvClear, kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { log } from "@/lib/log"

// node vitest cannot provide navigator.locks/BroadcastChannel/real workers (leader.ts's actual
// election machinery), so the whole leader module is replaced with a Map-backed fake StorageApi —
// this tests the adapter facade only (envelope + arktype validation), never leader election itself
// (that needs a manual two-tab dev smoke test, plus a scripted e2e spec later).
const { fakeStore } = vi.hoisted(() => ({ fakeStore: new Map<string, string>() }))

vi.mock("@/lib/storage/leader", () => ({
	acquireStorage: () =>
		Promise.resolve({
			role: "leader" as const,
			api: {
				open: () => Promise.resolve("persistent" as const),
				mode: () => Promise.resolve("persistent" as const),
				kvGet: (key: string) => Promise.resolve(fakeStore.get(key) ?? null),
				kvSet: (key: string, value: string) => {
					fakeStore.set(key, value)
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

vi.stubGlobal("location", { search: "" })

beforeEach(() => {
	fakeStore.clear()
	vi.restoreAllMocks()
})

describe("storage adapter (Map-backed fake StorageApi)", () => {
	it("roundtrips a bigint through kvSetJson/kvGetJson", async () => {
		const schema = type({ n: "bigint" })

		await kvSetJson("k1", { n: 123456789012345678n })

		await expect(kvGetJson("k1", schema)).resolves.toEqual({ n: 123456789012345678n })
	})

	it("drops a schema-mismatched value: null, warns, never throws", async () => {
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined)
		const schema = type({ n: "bigint" })

		await kvSetJson("k2", { n: "not-a-bigint" })

		await expect(kvGetJson("k2", schema)).resolves.toBeNull()
		expect(warnSpy).toHaveBeenCalledWith("kv", expect.stringContaining("k2"), expect.anything())
	})

	it("drops an unparseable envelope: null, warns, never throws", async () => {
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined)

		fakeStore.set("k3", "{not valid json")

		await expect(kvGetJson("k3", type({ n: "bigint" }))).resolves.toBeNull()
		expect(warnSpy).toHaveBeenCalledWith("kv", expect.stringContaining("k3"))
	})

	it("returns null for a missing key without touching the schema", async () => {
		await expect(kvGetJson("missing", type({ n: "bigint" }))).resolves.toBeNull()
	})

	it("kvClear wipes every row regardless of prefix", async () => {
		await kvSetJson("rq.v1.a", { n: 1n })
		await kvSetJson("keymap.v1.overrides", { n: 2n })
		await kvSetJson("session", { n: 3n })

		await kvClear()

		expect(fakeStore.size).toBe(0)
	})
})
