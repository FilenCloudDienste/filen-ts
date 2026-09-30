import { describe, expect, it, vi } from "vitest"
import {
	buildOutputSchema,
	chunkEntries,
	cldrCategories,
	computePluralBases,
	parseCliArgs,
	sortRecord,
	splitPluralKey,
	translateSubset
} from "@filen/shared/tooling/i18n"

describe("parseCliArgs", () => {
	const langs = ["de", "fr", "ja"] as const

	it("defaults to every language in delta mode", () => {
		expect(parseCliArgs([], langs)).toEqual({ full: false, languages: langs })
	})

	it("accepts --full and bare or comma-separated lists", () => {
		expect(parseCliArgs(["--full", "de, fr", "ja"], langs)).toEqual({ full: true, languages: ["de", "fr", "ja"] })
	})

	it("rejects an unknown language", () => {
		expect(() => parseCliArgs(["xx"], langs)).toThrow("Unknown target language \"xx\". Valid: de, fr, ja")
	})
})

describe("cldrCategories", () => {
	it("returns only integer-reachable categories", () => {
		expect([...cldrCategories("en")].sort()).toEqual(["one", "other"])
		// Russian `other` only fires for decimals; callers union in English's own categories.
		expect([...cldrCategories("ru")].sort()).toEqual(["few", "many", "one"])
		expect([...cldrCategories("cs")].sort()).toEqual(["few", "one", "other"])
		expect([...cldrCategories("ja")]).toEqual(["other"])
	})
})

describe("splitPluralKey", () => {
	it("splits a CLDR suffix off a key", () => {
		expect(splitPluralKey("files_other")).toEqual({ base: "files", category: "other" })
		expect(splitPluralKey("files_few")).toEqual({ base: "files", category: "few" })
	})

	it("ignores plain keys and a bare suffix", () => {
		expect(splitPluralKey("files")).toBeNull()
		expect(splitPluralKey("_one")).toBeNull()
	})
})

describe("computePluralBases", () => {
	it("keeps only bases with both _one and _other", () => {
		const bases = computePluralBases({ items_one: "a", items_other: "b", lone_one: "c", plain: "d" })

		expect([...bases.keys()]).toEqual(["items"])
		expect([...(bases.get("items") ?? [])]).toEqual(["one", "other"])
	})
})

describe("buildOutputSchema", () => {
	it("declares a closed schema requiring every key", () => {
		expect(buildOutputSchema(["a", "b"])).toEqual({
			type: "object",
			additionalProperties: false,
			properties: { a: { type: "string" }, b: { type: "string" } },
			required: ["a", "b"]
		})
	})
})

describe("chunkEntries", () => {
	it("splits in insertion order", () => {
		expect(chunkEntries({ a: "1", b: "2", c: "3" }, 2)).toEqual([{ a: "1", b: "2" }, { c: "3" }])
		expect(chunkEntries({}, 2)).toEqual([])
	})
})

describe("sortRecord", () => {
	it("orders keys", () => {
		expect(Object.keys(sortRecord({ b: "2", a: "1" }))).toEqual(["a", "b"])
	})
})

describe("translateSubset", () => {
	it("merges every batch", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {})

		const subset = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, `v${i}`]))
		const translateBatch = vi.fn(async (batch: Record<string, string>) =>
			Object.fromEntries(Object.entries(batch).map(([key, value]) => [key, `de:${value}`]))
		)
		const result = await translateSubset({ label: "de", subset, translateBatch })

		expect(translateBatch).toHaveBeenCalledTimes(2)
		expect(result["k29"]).toBe("de:v29")
		expect(Object.keys(result)).toHaveLength(30)
	})

	it("throws when the model omits a key", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {})

		await expect(
			translateSubset({ label: "de/common", subset: { a: "1", b: "2" }, translateBatch: async () => ({ a: "x" }) })
		).rejects.toThrow("de/common: model did not return a translation for key \"b\"")
	})
})
