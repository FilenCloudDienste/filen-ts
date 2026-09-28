import { beforeEach, describe, expect, it, vi } from "vitest"
import { type } from "arktype"
import { kvClear, kvGetJson, kvHas, kvSetJson } from "@/lib/storage/adapter"
import { log } from "@/lib/log"

// node vitest cannot provide navigator.locks/BroadcastChannel/real workers (leader.ts's actual
// election machinery), so the whole leader module is replaced with a Map-backed fake StorageApi —
// this tests the adapter facade only (envelope + arktype validation), never leader election itself
// (that needs a manual two-tab dev smoke test, plus a scripted e2e spec later).
const { fakeStore, fakeApi } = vi.hoisted(() => {
	const fakeStore = new Map<string, string>()
	const fakeApi = {
		open: () => Promise.resolve(undefined),
		kvGet: (key: string) => Promise.resolve(fakeStore.get(key) ?? null),
		kvSet: (key: string, value: string) => {
			fakeStore.set(key, value)
			return Promise.resolve()
		},
		kvDelete: (key: string) => {
			fakeStore.delete(key)
			return Promise.resolve()
		},
		kvKeys: (prefix: string) => Promise.resolve([...fakeStore.keys()].filter(k => k.startsWith(prefix))),
		kvDeletePrefix: (prefix: string) => {
			for (const key of [...fakeStore.keys()]) {
				if (key.startsWith(prefix)) {
					fakeStore.delete(key)
				}
			}

			return Promise.resolve()
		}
	}

	return { fakeStore, fakeApi }
})

vi.mock("@/lib/storage/leader", () => ({
	acquireStorage: () => Promise.resolve({ role: "leader" as const, api: fakeApi })
}))

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

	it("kvClear is two prefix deletes over every key, never a per-row enumeration", async () => {
		await kvSetJson("rq.v1.a", { n: 1n })
		await kvSetJson("session", { n: 2n })
		const deletePrefix = vi.spyOn(fakeApi, "kvDeletePrefix")
		const keys = vi.spyOn(fakeApi, "kvKeys")
		const del = vi.spyOn(fakeApi, "kvDelete")

		await kvClear()

		expect(deletePrefix.mock.calls).toEqual([[""], [""]])
		expect(keys).not.toHaveBeenCalled()
		expect(del).not.toHaveBeenCalled()
	})

	it("kvClear leaves no row behind when a straggler write lands mid-wipe (logout resurrection guard)", async () => {
		await kvSetJson("session", { n: 1n })

		// Model a write that races the wipe: an in-flight persist (e.g. an outbox flush already past its own
		// abort gate) re-adds a decrypted row right after the first delete ran. A single sweep leaves that
		// row on disk to replay next boot; the second sweep must catch it.
		const origDeletePrefix = fakeApi.kvDeletePrefix
		let injected = false

		vi.spyOn(fakeApi, "kvDeletePrefix").mockImplementation(async (prefix: string) => {
			await origDeletePrefix(prefix)

			if (!injected) {
				injected = true
				fakeStore.set("inflightChatMessages", "straggler")
			}
		})

		await kvClear()

		expect(fakeStore.has("inflightChatMessages")).toBe(false)
		expect(fakeStore.size).toBe(0)
	})

	it("kvClear still runs the second pass when the first rejects, then rejects itself", async () => {
		await kvSetJson("session", { n: 1n })
		const timeout = new Error("db rpc timeout: kvDeletePrefix")
		const origDeletePrefix = fakeApi.kvDeletePrefix
		const deletePrefix = vi
			.spyOn(fakeApi, "kvDeletePrefix")
			.mockRejectedValueOnce(timeout)
			.mockImplementation(prefix => origDeletePrefix(prefix))

		await expect(kvClear()).rejects.toBe(timeout)
		expect(deletePrefix).toHaveBeenCalledTimes(2)
		expect(fakeStore.size).toBe(0)
	})

	it("kvClear wipes through a leader on an older build that has no kvDeletePrefix", async () => {
		await kvSetJson("rq.v1.a", { n: 1n })
		await kvSetJson("session", { n: 2n })

		// What a follower receives from such a leader: Comlink's TypeError for the unknown method, rebuilt
		// by leader forwarding as a plain Error that keeps the name.
		const unknownMethod = new Error("Cannot read properties of undefined (reading 'apply')")

		unknownMethod.name = "TypeError"

		const deletePrefix = vi.spyOn(fakeApi, "kvDeletePrefix").mockRejectedValue(unknownMethod)
		const keys = vi.spyOn(fakeApi, "kvKeys")

		await kvClear()

		expect(fakeStore.size).toBe(0)
		expect(deletePrefix).toHaveBeenCalledTimes(1)
		expect(keys).toHaveBeenCalledTimes(2)
	})

	it("kvClear does not fall back to a per-key wipe when the prefix delete times out", async () => {
		await kvSetJson("session", { n: 1n })
		const timeout = new Error("db rpc timeout: kvDeletePrefix")

		vi.spyOn(fakeApi, "kvDeletePrefix").mockRejectedValue(timeout)
		const keys = vi.spyOn(fakeApi, "kvKeys")

		await expect(kvClear()).rejects.toBe(timeout)
		expect(keys).not.toHaveBeenCalled()
	})

	it("kvHas reports existence independent of schema — even a mismatched value counts as present", async () => {
		await expect(kvHas("k4")).resolves.toBe(false)

		await kvSetJson("k4", { n: "not-a-bigint" }) // kvGetJson would drop this as invalid for a bigint schema

		await expect(kvHas("k4")).resolves.toBe(true)

		await kvClear()

		await expect(kvHas("k4")).resolves.toBe(false)
	})
})
