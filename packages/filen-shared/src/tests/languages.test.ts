import { describe, expect, it } from "vitest"
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, isSupportedLanguage, languageChain, resolveLanguage } from "@filen/shared/languages"

const ALL = SUPPORTED_LANGUAGES

describe("SUPPORTED_LANGUAGES", () => {
	it("is English plus the 27 translated languages, each with a native label", () => {
		expect(ALL).toHaveLength(28)
		expect(ALL[0]).toBe("en")
		expect(Object.keys(LANGUAGE_LABELS).sort()).toEqual([...ALL].sort())
	})

	it("recognises only listed codes", () => {
		expect(isSupportedLanguage("zh-TW")).toBe(true)
		expect(isSupportedLanguage("pt")).toBe(false)
		expect(isSupportedLanguage(null)).toBe(false)
	})
})

describe("resolveLanguage", () => {
	it.each([
		["de-DE", "de"],
		["de", "de"],
		["DE-at", "de"],
		["pt-PT", "pt-PT"],
		["pt-BR", "pt-BR"],
		["pt", "pt-BR"],
		["pt-AO", "pt-BR"],
		["pt_PT", "pt-PT"],
		["zh-TW", "zh-TW"],
		["zh-HK", "zh-TW"],
		["zh-MO", "zh-TW"],
		["zh-Hant", "zh-TW"],
		["zh-Hant-HK", "zh-TW"],
		["zh-Hans-HK", "zh"],
		["zh-CN", "zh"],
		["zh-SG", "zh"],
		["zh-Hans", "zh"],
		["zh", "zh"],
		["nb-NO", "no"],
		["nn", "no"],
		["no", "no"],
		["es-419", "es"],
		["en-GB", "en"]
	])("%s → %s", (tag, expected) => {
		expect(resolveLanguage([tag], ALL)).toBe(expected)
	})

	it("takes the first tag that maps, in preference order", () => {
		expect(resolveLanguage(["xx-YY", "ga", "fr-CA", "de"], ALL)).toBe("fr")
	})

	it("returns null when nothing maps", () => {
		expect(resolveLanguage(["ga-IE", "", "x"], ALL)).toBeNull()
		expect(resolveLanguage([], ALL)).toBeNull()
	})

	it("only picks from the supported subset it is given", () => {
		expect(resolveLanguage(["zh-TW"], ["en", "zh"])).toBe("zh")
		expect(resolveLanguage(["zh-TW", "de"], ["en", "de"])).toBe("de")
		expect(resolveLanguage(["pt"], ["en", "pt-PT"])).toBeNull()
	})
})

describe("languageChain", () => {
	it("is the language and its supported base, never English", () => {
		expect(languageChain("zh-TW", ALL)).toEqual(["zh-TW", "zh"])
		expect(languageChain("pt-BR", ALL)).toEqual(["pt-BR"])
		expect(languageChain("de", ALL)).toEqual(["de"])
		expect(languageChain("en", ALL)).toEqual([])
		expect(languageChain("zh-TW", ["en", "zh-TW"])).toEqual(["zh-TW"])
	})
})
