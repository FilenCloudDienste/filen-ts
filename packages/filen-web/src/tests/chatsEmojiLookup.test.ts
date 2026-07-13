import { describe, expect, it } from "vitest"
import { CUSTOM_EMOJIS, customEmojiImageForShortcode, emojiForShortcode, searchEmoji } from "@/features/chats/lib/emoji"

// The full custom pack (CDN-sourced, shared with mobile via customEmojis.json) legitimately collides
// with a handful of ids in the curated standard-unicode table below — mobile has no textual
// standard-shortcode lookup at all, so for any id its custom pack defines, the custom pack IS mobile's
// answer. Matching that means: on a collision, the custom pack always wins (emoji.ts's emojiForShortcode
// comment carries the full rationale). These ids are verified colliding members of the shipped pack.
const COLLIDING_IDS = ["clap", "fire", "smile", "thinking", "flushed", "angry", "ghost", "cat", "ok"] as const

describe("emoji shortcode resolution — mobile-parity precedence on standard/custom collisions", () => {
	it("every colliding id resolves to its custom-pack CDN image, never the standard glyph", () => {
		for (const id of COLLIDING_IDS) {
			expect(customEmojiImageForShortcode(id)).toBe(`https://cdn.filen.io/emojis/${id}.webp`)
			expect(emojiForShortcode(id)).toBeUndefined()
		}
	})

	it("a non-colliding standard shortcode still resolves to its glyph", () => {
		expect(emojiForShortcode("joy")).toBe("😂")
		expect(customEmojiImageForShortcode("joy")).toBeUndefined()
	})

	it("the `:` autocomplete surfaces exactly one suggestion for a colliding id, and it's the custom one", () => {
		const suggestions = searchEmoji("clap", 10)
		const clapMatches = suggestions.filter(s => s.name === "clap")

		expect(clapMatches).toHaveLength(1)
		expect(clapMatches[0]?.kind).toBe("custom")
	})

	it("no two custom-pack entries share an id (the pack data itself, not the standard table)", () => {
		const names = CUSTOM_EMOJIS.map(emoji => emoji.name)

		expect(new Set(names).size).toBe(names.length)
	})
})

describe("custom emoji pack — data derivation from customEmojis.json", () => {
	it("resolves sampled pack entries to their expected CDN image url", () => {
		const samples = ["kekw", "gigachad", "catjam", "sadge", "monkaw"]

		for (const id of samples) {
			expect(customEmojiImageForShortcode(id)).toBe(`https://cdn.filen.io/emojis/${id}.webp`)
		}
	})

	it("has over a thousand entries (the full pack, not a bundled subset)", () => {
		expect(CUSTOM_EMOJIS.length).toBeGreaterThan(1000)
	})

	it("the 20 previously bundled-webp subset ids still resolve, now to their CDN entry", () => {
		const previouslyBundled = [
			"kekw",
			"pog",
			"pogu",
			"poggies",
			"letsgo",
			"clap",
			"gigachad",
			"catjam",
			"sadge",
			"copium",
			"prayge",
			"hmm",
			"monkaw",
			"popcat",
			"pepelaugh",
			"nodders",
			"aware",
			"saved",
			"yep",
			"meow"
		]

		for (const id of previouslyBundled) {
			const url = customEmojiImageForShortcode(id)

			expect(url).toBeDefined()
			expect(url).toMatch(/^https:\/\/cdn\.filen\.io\/emojis\/.+\.webp$/)
		}
	})

	it("matches suggestions by keyword, not just by id prefix/substring", () => {
		// No pack id contains "filen", so a match here can only come from the shared "filen" keyword —
		// proves searchEmoji scans keywords, not just names.
		const suggestions = searchEmoji("filen", 5)

		expect(suggestions.length).toBeGreaterThan(0)
		expect(suggestions.every(s => s.kind === "custom")).toBe(true)
	})

	it("an unknown shortcode resolves to neither table", () => {
		expect(customEmojiImageForShortcode("definitely_not_a_real_custom_emoji")).toBeUndefined()
		expect(emojiForShortcode("definitely_not_a_real_custom_emoji")).toBeUndefined()
	})
})
