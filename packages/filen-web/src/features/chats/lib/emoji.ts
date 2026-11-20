// Emoji lookup for chats: the full Unicode emoji set (emojiData.ts, parsed on first use) and Filen's custom
// (non-unicode, image-backed) pack. A standard emoji is inserted into messages as its unicode characters; a custom one
// as its `:name:` shortcode, which the message renderer resolves back to the image. Standard `:shortcode:` text (the
// old web app wrote it for every emoji it offered, as emoji-mart's iamcal ids, optionally with `:skin-tone-N:`) renders
// as the glyph; an unknown shortcode stays literal text.

import { CUSTOM_EMOJI_PACK } from "@filen/shared/emojis"
import { parseEmojiSet, withSkinTone, type EmojiSet, type StandardEmoji } from "@/features/chats/lib/emojiData"
import { SKIN_TONES, type SkinTone } from "@/features/chats/lib/skinTone"

// ── Custom emoji pack (non-unicode, image-backed) ───────────────────────────────────────────────────
// Filen's custom emoji pack is a large (thousand-plus-entry) set of image-backed shortcodes —
// Twitch/BTTV-style reaction emotes, not unicode glyphs — each entry's image a remote
// https://cdn.filen.io/... url. The pack's DATA (id/name/keywords/image url per entry) is shared with
// mobile via "@filen/shared/emojis", so both apps stay in lockstep on ids and CDN paths. The image urls
// are only renderable here because the app's Content-Security-Policy allowlists cdn.filen.io under img-src.

export interface CustomEmoji {
	// The shortcode without surrounding colons, e.g. "kekw" for `:kekw:` — the pack entry's own `id`.
	name: string
	imageUrl: string
	// Extra search terms (beyond `name`) the `:` autocomplete also matches against.
	keywords: readonly string[]
}

// Built once at module load from the pack data — searchEmoji below filters this array per keystroke,
// it never rebuilds it, so autocomplete stays a cheap linear scan over ~1100 prebuilt entries.
export const CUSTOM_EMOJIS: readonly CustomEmoji[] = CUSTOM_EMOJI_PACK.flatMap(entry => {
	const skin = entry.skins[0]

	// Every entry in the shipped pack has a skin (verified against all 1107); still guarded rather than
	// asserted non-null, since this is externally sourced data.
	if (skin === undefined) {
		return []
	}

	return [{ name: entry.id.toLowerCase(), imageUrl: skin.src, keywords: entry.keywords }]
})

const CUSTOM_EMOJI_MAP: ReadonlyMap<string, string> = new Map(CUSTOM_EMOJIS.map(emoji => [emoji.name, emoji.imageUrl]))

// Returns the CDN image url for a custom-pack shortcode, or undefined (outside the pack — falls back to
// literal `:shortcode:` text at the render layer, same as an unknown standard one).
export function customEmojiImageForShortcode(shortcode: string): string | undefined {
	return CUSTOM_EMOJI_MAP.get(shortcode.toLowerCase())
}

// Filen's custom pack owns its ids against the standard set (e.g. "clap", "fire", "ok"). Mobile has no textual
// standard-shortcode lookup at all: its regexed.tsx only ever resolves `:id:` against the custom pack, so for any id
// the pack defines, the pack is mobile's only answer. Matching that on web, the custom pack wins every collision: a
// colliding shortcode resolves to its CDN image, and the standard emoji is reached by its other shortcodes.
function isCustomShortcode(shortcode: string): boolean {
	return CUSTOM_EMOJI_MAP.has(shortcode)
}

let parsedSet: EmojiSet | null = null

// The standard set, split on first use and kept.
export function emojiSet(): EmojiSet {
	parsedSet ??= parseEmojiSet(isCustomShortcode)

	return parsedSet
}

// Whether the standard set has been split yet (tests check the picker costs nothing before it opens).
export function isEmojiSetParsed(): boolean {
	return parsedSet !== null
}

// The glyph a standard `:shortcode:` stands for, in skin tone `tone`; undefined for an id the custom pack owns (it
// renders as the image) or one neither set knows.
export function emojiForShortcode(shortcode: string, tone: SkinTone = 0): string | undefined {
	const normalized = shortcode.toLowerCase()

	if (isCustomShortcode(normalized)) {
		return undefined
	}

	const emoji = emojiSet().byShortcode.get(normalized)

	return emoji !== undefined ? withSkinTone(emoji, tone) : undefined
}

// A message's `:name:` or `:name::skin-tone-N:` token (the old web app's emoji-mart form, N 2 to 6 for the five tones,
// 1 for the default) as its shortcode and skin tone.
export function parseShortcodeToken(raw: string): { shortcode: string; tone: SkinTone } {
	const match = /^:([^:]+):(?::skin-tone-(\d+):)?$/.exec(raw)
	const shortcode = match?.[1] ?? raw.replaceAll(":", "")
	const tone = SKIN_TONES.find(entry => entry === Number(match?.[2] ?? "1") - 1) ?? 0

	return { shortcode, tone }
}

// A suggestion is either a standard unicode emoji or a custom-pack image: the `:` autocomplete and the picker list both;
// the render and insertion layers switch on `kind`.
export type EmojiSuggestion = StandardEmoji | { kind: "custom"; name: string; imageUrl: string }

// Match tiers, best first: the query is a whole shortcode (or custom id); a shortcode or custom id starts with it; a
// word of the name or keywords starts with it; it appears anywhere.
function standardTier(emoji: StandardEmoji, q: string): number {
	if (emoji.shortcodes.includes(q)) {
		return 0
	}

	if (emoji.shortcodes.some(code => code.startsWith(q))) {
		return 1
	}

	if (emoji.search.startsWith(q) || emoji.search.includes(` ${q}`)) {
		return 2
	}

	return emoji.search.includes(q) ? 3 : -1
}

function customTier(emoji: CustomEmoji, q: string): number {
	if (emoji.name === q) {
		return 0
	}

	if (emoji.name.startsWith(q)) {
		return 1
	}

	if (emoji.keywords.some(keyword => keyword.toLowerCase().startsWith(q))) {
		return 2
	}

	return emoji.name.includes(q) || emoji.keywords.some(keyword => keyword.toLowerCase().includes(q)) ? 3 : -1
}

// Search over the full standard set (shortcodes, CLDR names and keywords) and the custom pack (ids and keywords), for
// the `:` autocomplete and the picker. Better tiers first; inside a tier, standard emoji in Unicode order, then custom
// ones alphabetically. Capped to `limit`.
export function searchEmoji(query: string, limit: number): EmojiSuggestion[] {
	const q = query.toLowerCase()

	if (q.length === 0) {
		return []
	}

	const tiers: EmojiSuggestion[][] = [[], [], [], []]

	for (const emoji of emojiSet().all) {
		tiers[standardTier(emoji, q)]?.push(emoji)
	}

	const custom: (readonly [number, EmojiSuggestion])[] = []

	for (const emoji of CUSTOM_EMOJIS) {
		const tier = customTier(emoji, q)

		if (tier !== -1) {
			custom.push([tier, { kind: "custom", name: emoji.name, imageUrl: emoji.imageUrl }])
		}
	}

	custom.sort(([, a], [, b]) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

	for (const [tier, item] of custom) {
		tiers[tier]?.push(item)
	}

	return tiers.flat().slice(0, limit)
}
