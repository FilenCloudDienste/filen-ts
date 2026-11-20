import { EMOJI_DATA, EMOJI_GROUPS } from "@/features/chats/lib/emojiData.gen"
import { applySkinTone, type SkinTone } from "@/features/chats/lib/skinTone"

// The full Unicode emoji set (emojiData.gen.ts, generated from emojibase-data) is one string until something first
// needs it: the picker opening, a `:` autocomplete query, or a message shortcode the custom pack does not own
// (emoji.ts's emojiSet holds the result). Only then is it split into one object per emoji, once.

export type StandardEmojiCategory = (typeof EMOJI_GROUPS)[number]

export const STANDARD_EMOJI_CATEGORIES: readonly StandardEmojiCategory[] = EMOJI_GROUPS

export interface StandardEmoji {
	kind: "standard"
	// What the `:` autocomplete shows as `:name:`: the first shortcode the custom pack does not own, or the CLDR name in
	// snake case when there is none.
	name: string
	char: string
	// The CLDR name, e.g. "waving hand".
	label: string
	// The shortcodes the custom pack does not own (those resolve to the custom image, so they never mean this emoji).
	shortcodes: readonly string[]
	// Lowercased name, keywords and every shortcode, space-separated, for search.
	search: string
	// The ZWJ parts a skin tone modifier goes on, as digits (skinTone.ts); empty when the emoji takes no skin tone.
	toneParts: string
}

export interface EmojiSet {
	categories: ReadonlyMap<StandardEmojiCategory, readonly StandardEmoji[]>
	all: readonly StandardEmoji[]
	byShortcode: ReadonlyMap<string, StandardEmoji>
	// The emoji, and the emoji without its VS16s (how the same emoji may arrive typed elsewhere), to its entry.
	byChar: ReadonlyMap<string, StandardEmoji>
}

const VS16_ALL = /️/g

function parseEmoji(line: string, isReserved: (shortcode: string) => boolean): StandardEmoji {
	const [char = "", label = "", keywords = "", codes = "", toneParts = ""] = line.split("\t")
	const shortcodes = codes.length > 0 ? codes.split(" ").filter(code => !isReserved(code)) : []

	return {
		kind: "standard",
		name: shortcodes[0] ?? label.toLowerCase().replace(/[^\da-z]+/g, "_"),
		char,
		label,
		shortcodes,
		search: `${label} ${keywords.replaceAll("|", " ")} ${codes}`.toLowerCase(),
		toneParts
	}
}

// Splits the data; `isReserved` names the shortcodes another source (the custom pack) owns.
export function parseEmojiSet(isReserved: (shortcode: string) => boolean): EmojiSet {
	const categories = new Map<StandardEmojiCategory, StandardEmoji[]>()
	const all: StandardEmoji[] = []
	const byShortcode = new Map<string, StandardEmoji>()
	const byChar = new Map<string, StandardEmoji>()

	EMOJI_DATA.split("\n\n").forEach((block, index) => {
		const category = EMOJI_GROUPS[index]

		if (category === undefined) {
			return
		}

		const items = block.split("\n").map(line => parseEmoji(line, isReserved))

		categories.set(category, items)

		for (const item of items) {
			all.push(item)
			byChar.set(item.char, item)

			const bare = item.char.replace(VS16_ALL, "")

			if (!byChar.has(bare)) {
				byChar.set(bare, item)
			}

			for (const code of item.shortcodes) {
				byShortcode.set(code, item)
			}
		}
	})

	return { categories, all, byShortcode, byChar }
}

// The emoji in skin tone `tone` (skinTone.ts), or as it is when it takes none.
export function withSkinTone(emoji: StandardEmoji, tone: SkinTone): string {
	return applySkinTone(emoji.char, emoji.toneParts, tone)
}
