import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import {
	BREAK_HYPHEN,
	BREAK_NONE,
	HYPHENATION_LANGUAGES,
	HyphenationLibrary,
	HyphenationPatterns,
	LineFlag,
	ParagraphBuilder,
	TextHyphenator,
	hyphenationLanguage,
	type HyphenationAssets
} from "../core/text/index"
import { harness, layOut, texts, type Harness } from "./textFixtures"

const ASSETS = new URL("../../assets/hyphenation/", import.meta.url)

const files: HyphenationAssets = { read: async file => new Uint8Array(await readFile(new URL(file, ASSETS))) }

async function loaded(...tags: string[]): Promise<HyphenationLibrary> {
	const library = new HyphenationLibrary(files)

	for (const tag of tags) library.request(hyphenationLanguage(tag))

	await library.whenLoaded()

	return library
}

// `word` with hyphens at its breaks, those leaving fewer than left and right characters out.
function hyphenated(patterns: HyphenationPatterns, word: string, left = 1, right = 1): string {
	let out = ""
	let from = 0

	for (const at of patterns.breaks(word)) {
		if (at < left || at > word.length - right) continue

		out += `${word.slice(from, at)}-`
		from = at
	}

	return out + word.slice(from)
}

// Breaks a hyphenator marks in `text` (one run of `style`), as the word with hyphens.
function marked(h: Harness, hyphenator: TextHyphenator, text: string, style = h.base): string {
	const builder = new ParagraphBuilder()

	builder.reset(style)
	builder.append(text, style)

	const paragraph = builder.finish()
	const breaks = new Uint8Array(text.length + 1)

	hyphenator.hyphenate(paragraph, h.styles, breaks)

	let out = ""

	for (let i = 0; i < text.length; i++) {
		if (breaks[i] === BREAK_HYPHEN) out += "-"
		else expect(breaks[i]).toBe(BREAK_NONE)

		out += text[i]
	}

	return out
}

describe("Liang's patterns", () => {
	it("takes the highest digit at each gap and breaks at odd ones", () => {
		// From Liang's thesis: hy3ph he2n hena4 hen5at 1na n2at 1tio 2io o2n.
		const patterns = new HyphenationPatterns("hy3ph he2n hena4 hen5at 1na n2at 1tio 2io o2n")

		expect(hyphenated(patterns, "hyphenation")).toBe("hy-phen-ation")
	})

	it("matches patterns anchored at the word's start and end", () => {
		const patterns = new HyphenationPatterns(".ab1c c1d. x1y")

		expect(hyphenated(patterns, "abcd")).toBe("ab-c-d")
		expect(hyphenated(patterns, "zabcdz")).toBe("zabcdz")
	})

	it("prefers exceptions to patterns", () => {
		const patterns = new HyphenationPatterns("a1b", "ab-ab-ab")

		expect(hyphenated(patterns, "ababab")).toBe("ab-ab-ab")
		expect(hyphenated(patterns, "abab")).toBe("a-ba-b")
	})
})

describe("bundled patterns", () => {
	it("hyphenate English, German and French as their pattern sets do", async () => {
		const library = await loaded("en-US", "de-DE", "fr-FR")
		const en = library.patterns(hyphenationLanguage("en-US"))
		const de = library.patterns(hyphenationLanguage("de-DE"))
		const fr = library.patterns(hyphenationLanguage("fr-FR"))

		expect(en).not.toBeNull()
		expect(de).not.toBeNull()
		expect(fr).not.toBeNull()

		if (en === null || de === null || fr === null) return

		expect(hyphenated(en, "hyphenation")).toBe("hy-phen-ation")
		expect(hyphenated(en, "computer")).toBe("com-put-er")
		// An exception of hyph-en-us.hyp.txt.
		expect(hyphenated(en, "associate")).toBe("as-so-ciate")
		expect(hyphenated(de, "silbentrennung", 2, 2)).toBe("sil-ben-tren-nung")
		expect(hyphenated(fr, "dictionnaire")).toBe("dic-tion-naire")
	})

	it("are chosen by BCP 47 tag, region and language", () => {
		const index = (tag: string): string | undefined => HYPHENATION_LANGUAGES[hyphenationLanguage(tag) - 1]?.file

		expect(index("en-US")).toBe("hyph-en-us.txt.gz")
		expect(index("en-CA")).toBe("hyph-en-us.txt.gz")
		expect(index("en-GB")).toBe("hyph-en-gb.txt.gz")
		expect(index("en_AU")).toBe("hyph-en-gb.txt.gz")
		expect(index("de-AT")).toBe("hyph-de-1996.txt.gz")
		expect(index("de-CH")).toBe("hyph-de-1996.txt.gz")
		expect(index("no")).toBe("hyph-nb.txt.gz")
		expect(index("nn-NO")).toBe("hyph-nn.txt.gz")
		expect(index("mn-Cyrl-MN")).toBe("hyph-mn-cyrl.txt.gz")
		// LPPL- or GPL-only patterns are not bundled; no language, no patterns.
		expect(hyphenationLanguage("ca-ES")).toBe(0)
		expect(hyphenationLanguage("ru-RU")).toBe(0)
		expect(hyphenationLanguage("x-none")).toBe(0)
		expect(hyphenationLanguage(undefined)).toBe(0)
	})

	it("match the manifest: sizes, hashes and a permissive licence for every file", () => {
		const manifest = JSON.parse(readFileSync(new URL("manifest.json", ASSETS), "utf8")) as {
			commit: string
			languages: { file: string; bytes: number; sha256: string; size: number; left: number; right: number; licence: string }[]
		}
		const notices = readFileSync(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8")
		const permissive = new Set(["MIT", "BSD-3-Clause", "FSFAP", "Unlicense", "LicenseRef-Public-Domain", "LicenseRef-hyph-bg"])

		expect(manifest.languages.map(({ file, size, left, right }) => ({ file, size, left, right }))).toEqual(HYPHENATION_LANGUAGES)

		for (const language of manifest.languages) {
			const bytes = readFileSync(new URL(language.file, ASSETS))

			expect(bytes.length).toBe(language.bytes)
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(language.sha256)
			expect(permissive.has(language.licence)).toBe(true)
			expect(notices).toContain(`\`${language.file}\``)
		}
	})
})

describe("the library", () => {
	it("loads a language once, on first request, and keeps it", async () => {
		const reads: string[] = []
		const library = new HyphenationLibrary({
			read: file => {
				reads.push(file)

				return files.read(file)
			}
		})
		const en = hyphenationLanguage("en-US")

		expect(library.loading).toBe(false)
		expect(library.request(en)).toBe(false)
		expect(library.loading).toBe(true)
		expect(library.patterns(en)).toBeNull()
		expect(library.request(en)).toBe(false)

		await library.whenLoaded()

		expect(library.loading).toBe(false)
		expect(library.request(en)).toBe(true)
		expect(library.patterns(en)).not.toBeNull()
		expect(reads).toEqual(["hyph-en-us.txt.gz"])
	})

	it("gives up on a language whose file fails to load", async () => {
		let reads = 0
		const library = new HyphenationLibrary({
			read: () => {
				reads++

				return Promise.reject(new Error("offline"))
			}
		})
		const de = hyphenationLanguage("de")

		library.request(de)
		await library.whenLoaded()

		expect(library.loading).toBe(false)
		expect(library.request(de)).toBe(false)
		expect(library.loading).toBe(false)
		expect(library.patterns(de)).toBeNull()
		expect(reads).toBe(1)
	})

	it("takes files a server already inflated", async () => {
		const { gunzipSync } = await import("node:zlib")
		const library = new HyphenationLibrary({ read: async file => new Uint8Array(gunzipSync(await files.read(file))) })
		const en = hyphenationLanguage("en")

		library.request(en)
		await library.whenLoaded()

		const patterns = library.patterns(en)

		expect(patterns === null ? "" : hyphenated(patterns, "hyphenation")).toBe("hy-phen-ation")
	})
})

describe("the text hyphenator", () => {
	it("marks breaks inside words in each run's language, within the minimums", async () => {
		const library = await loaded("en-US", "de")
		const h = harness()
		const english = h.style({ language: hyphenationLanguage("en-US") })
		const german = h.style({ language: hyphenationLanguage("de") })
		const hyphenator = new TextHyphenator(library)

		// English keeps three characters after a break: not "comput-er".
		expect(marked(h, hyphenator, "hyphenation computer", english)).toBe("hy-phen-ation com-puter")
		expect(marked(h, hyphenator, "Silbentrennung", german)).toBe("Sil-ben-tren-nung")
		// No language: nothing.
		expect(marked(h, hyphenator, "hyphenation")).toBe("hyphenation")
	})

	it("leaves short words, words with digits or soft hyphens, and (if asked) capitals whole", async () => {
		const library = await loaded("en-US")
		const h = harness()
		const english = h.style({ language: hyphenationLanguage("en-US") })
		const hyphenator = new TextHyphenator(library)
		const noCaps = new TextHyphenator(library, { caps: false })

		expect(marked(h, hyphenator, "hyphen3ation", english)).toBe("hyphen3ation")
		expect(marked(h, hyphenator, "hyphena­tion", english)).toBe("hyphena­tion")
		expect(marked(h, new TextHyphenator(library, { minWord: 12 }), "hyphenation", english)).toBe("hyphenation")
		expect(marked(h, hyphenator, "HYPHENATION", english)).toBe("HY-PHEN-ATION")
		expect(marked(h, noCaps, "HYPHENATION", english)).toBe("HYPHENATION")
		expect(marked(h, noCaps, "Hyphenation", english)).toBe("Hy-phen-ation")
		// More characters kept before and after the break.
		expect(marked(h, new TextHyphenator(library, { left: 3, right: 5 }), "hyphenation", english)).toBe("hyphen-ation")
	})

	it("keeps apostrophes inside a word and never breaks next to them", async () => {
		const library = await loaded("en-US")
		const h = harness()
		const english = h.style({ language: hyphenationLanguage("en-US") })

		expect(marked(h, new TextHyphenator(library), "hyphenation's", english)).toBe("hy-phen-ation's")
	})
})

describe("line breaking at hyphenation points", () => {
	// The fake font: "a" 10 px; hyphen 5 px; lines 100 px.
	function points(at: readonly number[]): { hyphenate(_p: unknown, _s: unknown, breaks: Uint8Array): void } {
		return {
			hyphenate(_paragraph, _styles, breaks) {
				for (const offset of at) breaks[offset] = BREAK_HYPHEN
			}
		}
	}

	it("breaks a word at a point and draws a hyphen at the line's end", () => {
		const h = harness()
		const view = layOut(h, b => b.append("aaa aaaaaaaaaaaa", h.base), {}, { hyphenator: points([10]) })

		expect(texts(view)).toEqual(["aaa aaaaaa", "aaaaaa"])
		expect((view[0]?.flags ?? 0) & LineFlag.HYPHENATED).toBe(LineFlag.HYPHENATED)
		// 95 for the text, 5 for the hyphen.
		expect(view[0]?.width).toBe(100)
	})

	it("moves the word whole when that leaves less room than the hyphenation zone", () => {
		const h = harness()
		const build = (b: ParagraphBuilder): void => {
			b.append("aaaaaaa aaaaaaaa", h.base)
		}

		// Moved whole, the second word leaves 30 px after "aaaaaaa".
		expect(texts(layOut(h, build, {}, { hyphenator: points([10]), hyphenationZone: 35 }))).toEqual(["aaaaaaa ", "aaaaaaaa"])
		expect(texts(layOut(h, build, {}, { hyphenator: points([10]), hyphenationZone: 25 }))).toEqual(["aaaaaaa aa", "aaaaaa"])
		expect(texts(layOut(h, build, {}, { hyphenator: points([10]) }))).toEqual(["aaaaaaa aa", "aaaaaa"])
	})

	it("keeps soft hyphens whatever the zone", () => {
		const h = harness()
		const view = layOut(h, b => b.append("aaaaaaa aa­aaaaaa", h.base), {}, { hyphenator: points([]), hyphenationZone: 1000 })

		expect(texts(view)).toEqual(["aaaaaaa aa­", "aaaaaa"])
	})

	it("ends at most the limit's number of consecutive lines in a hyphen", () => {
		const h = harness()
		// A word of 40 "a"s with a point every 9: unlimited, each of its lines ends at one.
		const text = "a".repeat(40)
		const at = [9, 18, 27, 36]
		const unlimited = layOut(h, b => b.append(text, h.base), {}, { hyphenator: points(at) })
		const limited = layOut(h, b => b.append(text, h.base), {}, { hyphenator: points(at), hyphenLimit: 1 })
		const ends = (view: typeof unlimited): boolean[] => view.map(line => (line.flags & LineFlag.HYPHENATED) !== 0)

		expect(ends(unlimited)).toEqual([true, true, true, true, false])
		// The second line breaks where its text overflows instead, without a hyphen; the third may end in one again.
		expect(texts(limited).slice(0, 2)).toEqual(["aaaaaaaaa", "aaaaaaaaaa"])
		expect(ends(limited).slice(0, 3)).toEqual([true, false, true])
	})
})
