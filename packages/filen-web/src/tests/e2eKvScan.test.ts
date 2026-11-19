import { describe, expect, it } from "vitest"
import { kvKeysHolding, kvRowHolds } from "@/e2e-hooks/kvScan"
import { stringifyEnvelope } from "@filen/shared/session"

// The password canary's kv scan (e2e/helpers/passwordCanary.ts): a row holds the needle in its key, in its raw
// stored value, or in the value as JSON writes it.
describe("kvRowHolds", () => {
	it("matches the key", () => {
		expect(kvRowHolds("office:pw:hunter2", stringifyEnvelope(1), "hunter2")).toBe(true)
	})

	it("matches the raw value", () => {
		expect(kvRowHolds("settings", stringifyEnvelope({ remembered: "hunter2" }), "hunter2")).toBe(true)
	})

	it("matches the value JSON-escaped", () => {
		const needle = 'pa"ss\\word'

		expect(kvRowHolds("settings", stringifyEnvelope({ remembered: needle }), needle)).toBe(true)
	})

	it("misses a row without it", () => {
		expect(kvRowHolds("settings", stringifyEnvelope({ remembered: "other" }), "hunter2")).toBe(false)
	})
})

describe("kvKeysHolding", () => {
	it("pages through every row from the start", async () => {
		const rows: [string, string][] = Array.from({ length: 2500 }, (_, index) => [
			`key-${String(index).padStart(5, "0")}`,
			stringifyEnvelope(index === 2400 ? "hunter2" : index)
		])
		const calls: (string | null)[] = []
		const found = await kvKeysHolding((prefix, after, limit) => {
			expect(prefix).toBe("")
			calls.push(after)

			return Promise.resolve(rows.filter(([key]) => after === null || key > after).slice(0, limit))
		}, "hunter2")

		expect(found).toEqual(["key-02400"])
		expect(calls).toEqual([null, "key-01999"])
	})
})
