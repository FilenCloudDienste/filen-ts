import { describe, expect, it } from "vitest"
import { languageName, languagePreferenceRank, languagesMatch, normalizeLanguage } from "@filen/shared/videos"

describe("normalizeLanguage", () => {
	it.each([
		["en", "en"],
		["EN", "en"],
		["eng", "en"],
		["en-US", "en"],
		["en_GB", "en"],
		["ger", "de"],
		["deu", "de"],
		["de-AT", "de"],
		["fre", "fr"],
		["fra", "fr"],
		["chi", "zh"],
		["zho", "zh"],
		["zh-Hant-TW", "zh"],
		["dut", "nl"],
		["nld", "nl"],
		["gre", "el"],
		["ell", "el"],
		["jpn", "ja"],
		["iw", "he"],
		["in", "id"],
		["nb", "no"],
		["nob", "no"],
		["nn-NO", "no"],
		["fil", "tl"],
		["yue", "yue"],
		["haw", "haw"],
		["English", "en"],
		["german", "de"],
		["Portuguese (Brazil)", "pt"],
		["Castilian", "es"],
		["  Spanish ", "es"]
	])("%s -> %s", (input, expected) => {
		expect(normalizeLanguage(input)).toBe(expected)
	})

	it.each(["", "und", "mis", "zxx", "mul", "xx", "qqq", "klingon-ish", "zz", "1234"])("rejects %s", input => {
		expect(normalizeLanguage(input)).toBeNull()
	})

	it.each(["constructor", "Constructor (US)", "hasOwnProperty", "valueOf", "__proto__", "toString"])(
		"never resolves the object prototype key %s",
		input => {
			expect(normalizeLanguage(input)).toBeNull()
		}
	)

	it("handles null, undefined and oversized input", () => {
		expect(normalizeLanguage(null)).toBeNull()
		expect(normalizeLanguage(undefined)).toBeNull()
		expect(normalizeLanguage("a".repeat(5000))).toBeNull()
	})

	it("resolves every ISO 639-2/B and /T pair in the table to the same primary code", () => {
		const pairs: [string, string, string][] = [
			["ces", "cze", "cs"],
			["cym", "wel", "cy"],
			["eus", "baq", "eu"],
			["fas", "per", "fa"],
			["hye", "arm", "hy"],
			["isl", "ice", "is"],
			["kat", "geo", "ka"],
			["mkd", "mac", "mk"],
			["mri", "mao", "mi"],
			["msa", "may", "ms"],
			["mya", "bur", "my"],
			["ron", "rum", "ro"],
			["slk", "slo", "sk"],
			["sqi", "alb", "sq"],
			["bod", "tib", "bo"]
		]

		for (const [t, b, one] of pairs) {
			expect(normalizeLanguage(t)).toBe(one)
			expect(normalizeLanguage(b)).toBe(one)
		}
	})
})

describe("language helpers", () => {
	it("names languages in English", () => {
		expect(languageName("ger")).toBe("German")
		expect(languageName("pt-BR")).toBe("Portuguese")
		expect(languageName("zzz")).toBeNull()
	})

	it("matches across code systems", () => {
		expect(languagesMatch("eng", "en-US")).toBe(true)
		expect(languagesMatch("nb", "nn")).toBe(true)
		expect(languagesMatch("en", "de")).toBe(false)
		expect(languagesMatch("und", "und")).toBe(false)
		expect(languagesMatch(null, "en")).toBe(false)
	})

	it("ranks against a preference list", () => {
		const preferred = ["de", "en"]

		expect(languagePreferenceRank("eng", preferred)).toBe(1)
		expect(languagePreferenceRank("ger", preferred)).toBe(0)
		expect(languagePreferenceRank("jpn", preferred)).toBe(-1)
		expect(languagePreferenceRank(null, preferred)).toBe(-1)
	})
})

describe("extra names and legacy codes", () => {
	it.each([
		["Farsi", "fa"],
		["cmn", "zh"],
		["Norwegian Bokmål", "no"],
		["Brazilian Portuguese", "pt"],
		["pt-BR", "pt"],
		["Modern Greek", "el"],
		["Chinese Simplified", "zh"],
		["Chinese (Traditional)", "zh"],
		["sh", "sr"],
		["scc", "sr"],
		["scr", "hr"],
		["per", "fa"],
		["fas", "fa"]
	])("%s -> %s", (input, expected) => {
		expect(normalizeLanguage(input)).toBe(expected)
	})
})

describe("names with diacritics", () => {
	it.each([
		["Español", "es"],
		["Français", "fr"],
		["Bokmål", "no"],
		["Bokma\u030al", "no"],
		["Norwegian Bokma\u030al", "no"],
		["Português", "pt"],
		["Português (Brasil)", "pt"]
	])("%s -> %s", (input, expected) => {
		expect(normalizeLanguage(input)).toBe(expected)
	})

	it("leaves a name in another script unknown", () => {
		expect(normalizeLanguage("Ελληνικά")).toBeNull()
	})
})
