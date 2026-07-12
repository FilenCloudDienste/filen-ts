import { describe, expect, it } from "vitest"
import { CUSTOM_EMOJIS, EMOJI_SHORTCODES, customEmojiImageForShortcode, emojiForShortcode, searchEmoji } from "@/features/chats/lib/emoji"

// messageContent.tsx and the `:` autocomplete both resolve a shortcode against the standard-unicode
// table before the bundled custom-pack subset, so a custom entry sharing a name with a standard one is
// unreachable dead weight — it can never render as its image, and it would show up as two identically
// labeled (but visually different) suggestions in the picker. This guards against reintroducing one.
describe("emoji shortcode table has no standard/custom name collisions", () => {
	it("no bundled custom-pack entry shares a name with the standard shortcode table", () => {
		const standardNames = new Set(Object.keys(EMOJI_SHORTCODES))
		const colliding = CUSTOM_EMOJIS.filter(emoji => standardNames.has(emoji.name))

		expect(colliding).toEqual([])
	})

	it("resolves a standard name to its unicode glyph, not a custom image, when the two would otherwise collide", () => {
		expect(emojiForShortcode("clap")).toBe("👏")
		expect(customEmojiImageForShortcode("clap")).toBeUndefined()
	})

	it("the renamed custom clap entry resolves to its bundled image", () => {
		expect(customEmojiImageForShortcode("clapping")).toBeDefined()
		expect(emojiForShortcode("clapping")).toBeUndefined()
	})

	it("the `:` autocomplete never surfaces two suggestions with the same name", () => {
		const suggestions = searchEmoji("clap", 10)
		const names = suggestions.map(s => s.name)

		expect(new Set(names).size).toBe(names.length)
	})
})
