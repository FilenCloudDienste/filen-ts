import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
	batchIssues,
	buildOutputSchema,
	chunkEntries,
	cldrCategories,
	computePluralBases,
	deadlineAfter,
	isTransientError,
	MAX_TRANSIENT_ATTEMPTS,
	MAX_VALIDATION_ATTEMPTS,
	parseCliArgs,
	parseTranslatedBatch,
	retryDelayMs,
	sortRecord,
	splitPluralKey,
	translateSubset,
	writeJsonFile
} from "@filen/shared/tooling/i18n"

describe("parseCliArgs", () => {
	const langs = ["de", "fr", "ja"] as const

	it("defaults to every language in delta mode", () => {
		expect(parseCliArgs([], langs)).toEqual({ full: false, languages: langs, budgetMinutes: null })
	})

	it("accepts --full and bare or comma-separated lists", () => {
		expect(parseCliArgs(["--full", "de, fr", "ja"], langs)).toEqual({ full: true, languages: ["de", "fr", "ja"], budgetMinutes: null })
	})

	it("reads a time budget in minutes", () => {
		expect(parseCliArgs(["--budget-minutes=330", "de"], langs)).toEqual({ full: false, languages: ["de"], budgetMinutes: 330 })
		expect(parseCliArgs(["--budget-minutes=0.5"], langs).budgetMinutes).toBe(0.5)
		expect(parseCliArgs(["--budget-minutes=0"], langs).budgetMinutes).toBe(0)

		for (const bad of ["--budget-minutes=", "--budget-minutes=-1", "--budget-minutes=soon", "--budget-minutes=Infinity"]) {
			expect(() => parseCliArgs([bad], langs)).toThrow("expected a non-negative number of minutes")
		}
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
	const echo = (): ((batch: Record<string, string>) => Promise<Record<string, string>>) =>
		vi.fn(async (batch: Record<string, string>) => Object.fromEntries(Object.entries(batch).map(([key, value]) => [key, `de:${value}`])))
	const noSleep = (): (() => Promise<void>) => vi.fn(() => Promise.resolve())

	function quiet(): void {
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "warn").mockImplementation(() => {})
	}

	function collect(): { result: Record<string, string>; onBatch: (translated: Record<string, string>) => void } {
		const result: Record<string, string> = {}

		return { result, onBatch: translated => Object.assign(result, translated) }
	}

	it("hands every batch to onBatch", async () => {
		quiet()

		const subset = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, `v${i}`]))
		const { result, onBatch } = collect()
		const translateBatch = echo()

		await expect(translateSubset({ label: "de", subset, translateBatch, onBatch })).resolves.toBe(true)
		expect(translateBatch).toHaveBeenCalledTimes(2)
		expect(result["k29"]).toBe("de:v29")
		expect(Object.keys(result)).toHaveLength(30)
	})

	it("keeps only the requested keys of a reply", async () => {
		quiet()

		const { result, onBatch } = collect()

		await translateSubset({ label: "de", subset: { a: "1" }, translateBatch: async () => ({ a: "x", extra: "y" }), onBatch })
		expect(result).toEqual({ a: "x" })
	})

	it("retries a reply missing a key once, then fails", async () => {
		quiet()

		const translateBatch = vi.fn(async () => ({ a: "x" }))
		const onBatch = vi.fn()
		const sleep = noSleep()

		await expect(translateSubset({ label: "de/common", subset: { a: "1", b: "2" }, translateBatch, onBatch, sleep })).rejects.toThrow(
			"de/common: batch 1/1: model did not return a translation for key \"b\""
		)
		expect(translateBatch).toHaveBeenCalledTimes(MAX_VALIDATION_ATTEMPTS)
		expect(onBatch).not.toHaveBeenCalled()
		expect(sleep).not.toHaveBeenCalled()
	})

	it("accepts a reply fixed on the validation retry", async () => {
		quiet()

		const translateBatch = vi.fn().mockResolvedValueOnce({ a: "Datei {{name}}" }).mockResolvedValueOnce({ a: "Datei {{count}}" })
		const { result, onBatch } = collect()

		await expect(translateSubset({ label: "de", subset: { a: "{{count}} file" }, translateBatch, onBatch })).resolves.toBe(true)
		expect(result).toEqual({ a: "Datei {{count}}" })
	})

	it("retries transient failures with backoff, up to the attempt limit", async () => {
		quiet()

		const overloaded = Object.assign(new Error("529 overloaded_error"), { status: 529 })
		const flaky = vi.fn().mockRejectedValueOnce(overloaded).mockRejectedValueOnce(overloaded).mockResolvedValueOnce({ a: "x" })
		const sleep = vi.fn(() => Promise.resolve())
		const { result, onBatch } = collect()

		await expect(translateSubset({ label: "de", subset: { a: "1" }, translateBatch: flaky, onBatch, sleep })).resolves.toBe(true)
		expect(result).toEqual({ a: "x" })
		expect(sleep.mock.calls).toEqual([[retryDelayMs(1)], [retryDelayMs(2)]])

		const down = vi.fn().mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }))

		await expect(translateSubset({ label: "de", subset: { a: "1" }, translateBatch: down, onBatch, sleep: noSleep() })).rejects.toThrow(
			`de: batch 1/1: gave up after ${MAX_TRANSIENT_ATTEMPTS} attempts: rate limited`
		)
		expect(down).toHaveBeenCalledTimes(MAX_TRANSIENT_ATTEMPTS)
	})

	it("does not retry other failures", async () => {
		quiet()

		const bad = vi.fn().mockRejectedValue(Object.assign(new Error("400 invalid_request_error"), { status: 400 }))

		await expect(translateSubset({ label: "de", subset: { a: "1" }, translateBatch: bad, onBatch: vi.fn(), sleep: noSleep() })).rejects.toThrow(
			"400 invalid_request_error"
		)
		expect(bad).toHaveBeenCalledTimes(1)
	})

	it("stops at a batch boundary when the budget runs out, keeping the finished batches", async () => {
		quiet()

		const subset = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, `v${i}`]))
		const { result, onBatch } = collect()
		let checks = 0

		await expect(translateSubset({ label: "de", subset, translateBatch: echo(), onBatch, shouldStop: () => ++checks > 2 })).resolves.toBe(false)
		expect(Object.keys(result)).toHaveLength(50)
	})

	it("stops instead of backing off once the budget is spent", async () => {
		quiet()

		let spent = false
		const sleep = noSleep()
		const translateBatch = vi.fn(() => {
			spent = true

			return Promise.reject(Object.assign(new Error("overloaded"), { status: 529 }))
		})

		await expect(
			translateSubset({ label: "de", subset: { a: "1" }, translateBatch, onBatch: vi.fn(), shouldStop: () => spent, sleep })
		).resolves.toBe(false)
		expect(sleep).not.toHaveBeenCalled()
	})
})

describe("isTransientError", () => {
	it("recognizes rate limits, overload, 5xx and network failures", () => {
		expect(isTransientError(Object.assign(new Error("x"), { status: 429 }))).toBe(true)
		expect(isTransientError(Object.assign(new Error("x"), { status: 529 }))).toBe(true)
		expect(isTransientError(Object.assign(new Error("x"), { status: 500 }))).toBe(true)
		expect(isTransientError(Object.assign(new Error("Connection error."), { name: "APIConnectionError" }))).toBe(true)
		expect(isTransientError(new Error("Overloaded"))).toBe(true)
		expect(isTransientError(new TypeError("fetch failed"))).toBe(true)
	})

	it("rejects client errors and non-errors", () => {
		expect(isTransientError(Object.assign(new Error("x"), { status: 400 }))).toBe(false)
		expect(isTransientError(Object.assign(new Error("x"), { status: 401 }))).toBe(false)
		expect(isTransientError(new Error("Unknown target language"))).toBe(false)
		expect(isTransientError("overloaded")).toBe(false)
	})
})

describe("batchIssues", () => {
	it("reports missing keys and placeholder or markup drift", () => {
		expect(batchIssues({ a: "Open <link>{{name}}</link>", b: "x" }, { a: "Öffnen {{name}}" })).toEqual([
			"a: markup differs from English",
			"model did not return a translation for key \"b\""
		])
		expect(batchIssues({ a: "{{count}} files" }, { a: "{{n}} Dateien" })).toEqual(["a: placeholders n differ from English count"])
	})

	it("lets a _one form drop {{count}}", () => {
		expect(batchIssues({ files_one: "{{count}} file" }, { files_one: "Eine Datei" })).toEqual([])
	})
})

describe("deadlineAfter", () => {
	it("is never reached without a budget and reached at once for zero", () => {
		expect(deadlineAfter(null)()).toBe(false)
		expect(deadlineAfter(0)()).toBe(true)
	})

	it("is reached once the minutes have passed", () => {
		let now = 1_000
		const reached = deadlineAfter(2, () => now)

		now += 119_999
		expect(reached()).toBe(false)
		now += 1
		expect(reached()).toBe(true)
	})
})

describe("writeJsonFile", () => {
	it("creates the directory and leaves no temporary file", () => {
		const dir = mkdtempSync(join(tmpdir(), "i18n-"))
		const path = join(dir, ".sources", "de.json")

		try {
			writeJsonFile(path, { b: "2", a: "1" })
			expect(readFileSync(path, "utf8")).toBe("{\n\t\"b\": \"2\",\n\t\"a\": \"1\"\n}\n")
			expect(readdirSync(join(dir, ".sources"))).toEqual(["de.json"])
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("parseTranslatedBatch", () => {
	it("returns a map of strings", () => {
		expect(parseTranslatedBatch("{\"a\":\"x\",\"b\":\"y\"}")).toEqual({ a: "x", b: "y" })
	})

	it("throws on a non-string value, an array or malformed JSON", () => {
		expect(() => parseTranslatedBatch("{\"a\":1}")).toThrow(/a must be a string/)
		expect(() => parseTranslatedBatch("[\"x\"]")).toThrow(/array/)
		expect(() => parseTranslatedBatch("null")).toThrow()
		expect(() => parseTranslatedBatch("{")).toThrow()
	})
})
