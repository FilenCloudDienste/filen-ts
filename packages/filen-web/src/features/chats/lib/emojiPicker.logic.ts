import { CUSTOM_EMOJIS, emojiSet, searchEmoji, type EmojiSuggestion } from "@/features/chats/lib/emoji"
import { STANDARD_EMOJI_CATEGORIES, withSkinTone, type StandardEmojiCategory } from "@/features/chats/lib/emojiData"
import type { SkinTone } from "@/features/chats/lib/skinTone"

// The composer's emoji picker offers the full Unicode emoji set (emojiData.ts, split the first time the picker asks for
// it) in Unicode's groups, flags included, and Filen's custom pack, the same sets the `:` autocomplete and the message
// renderer use (emoji.ts).

export type EmojiPickerCategory = "recent" | StandardEmojiCategory | "custom"

// Tab order: recently used, the Unicode groups in their standard order, then Filen's own pack.
export const EMOJI_PICKER_CATEGORIES: readonly EmojiPickerCategory[] = ["recent", ...STANDARD_EMOJI_CATEGORIES, "custom"]

let customItems: readonly EmojiSuggestion[] | null = null

// The items of one tab: a Unicode group as the parsed set holds it; the custom tab maps the pack's ~1100 prebuilt
// entries once and keeps them.
export function emojiPickerCategoryItems(category: Exclude<EmojiPickerCategory, "recent">): readonly EmojiSuggestion[] {
	if (category !== "custom") {
		return emojiSet().categories.get(category) ?? []
	}

	customItems ??= CUSTOM_EMOJIS.map(emoji => ({ kind: "custom", name: emoji.name, imageUrl: emoji.imageUrl }))

	return customItems
}

// Search results cap: past this many matches the query is too loose to scan by eye.
export const EMOJI_PICKER_SEARCH_LIMIT = 240

// The `:` autocomplete's search (emoji.ts): shortcodes, CLDR names and keywords, and the custom pack.
export function searchEmojiPicker(query: string): EmojiSuggestion[] {
	return searchEmoji(query.trim(), EMOJI_PICKER_SEARCH_LIMIT)
}

// What choosing an item inserts into the composer: a standard emoji as its characters in the chosen skin tone (when it
// takes one), a custom one as its `:name:` shortcode (it has no glyph; the message renderer resolves the shortcode back
// to the image).
export function emojiInsertText(item: EmojiSuggestion, tone: SkinTone): string {
	return item.kind === "standard" ? withSkinTone(item, tone) : `:${item.name}:`
}

// The token the recently used list remembers an item by: a standard emoji's default-tone characters (so the list
// follows a later skin tone change), a custom one's `:name:`.
export function emojiRecentToken(item: EmojiSuggestion): string {
	return item.kind === "standard" ? item.char : `:${item.name}:`
}

let customTokens: Map<string, EmojiSuggestion> | null = null

// A remembered token back to its item, or undefined once the token no longer names an emoji the picker offers (a pack
// entry since removed, or stored data that is not ours). A standard token is matched with or without its VS16s.
export function emojiForRecentToken(token: string): EmojiSuggestion | undefined {
	if (!token.startsWith(":")) {
		return emojiSet().byChar.get(token) ?? emojiSet().byChar.get(token.replace(/\ufe0f/g, ""))
	}

	customTokens ??= new Map(emojiPickerCategoryItems("custom").map(item => [emojiRecentToken(item), item]))

	return customTokens.get(token)
}

export const MAX_RECENT_EMOJIS = 32

// The recently used list after using `token`: it moves to the front, once, and the list stays capped.
export function pushRecentEmoji(recents: readonly string[], token: string): string[] {
	return [token, ...recents.filter(existing => existing !== token)].slice(0, MAX_RECENT_EMOJIS)
}

// Merges the stored list under the uses made this session before it finished loading (newest first, no repeats).
export function mergeRecentEmojis(session: readonly string[], stored: readonly string[]): string[] {
	const merged: string[] = []

	for (const token of [...session, ...stored]) {
		if (!merged.includes(token) && merged.length < MAX_RECENT_EMOJIS) {
			merged.push(token)
		}
	}

	return merged
}

// The grid cell a navigation key moves to from `index`, clamped to the grid; null for a key the grid does not handle.
// Home/End go to the start/end of the row.
export function moveGridIndex(index: number, key: string, count: number, columns: number): number | null {
	if (count === 0) {
		return null
	}

	const rowStart = index - (index % columns)

	switch (key) {
		case "ArrowLeft":
			return Math.max(0, index - 1)
		case "ArrowRight":
			return Math.min(count - 1, index + 1)
		case "ArrowUp":
			return index - columns >= 0 ? index - columns : index
		case "ArrowDown":
			// Into a shorter last row: its last cell. Already on the last row: stay.
			return index + columns < count ? index + columns : rowStart + columns < count ? count - 1 : index
		case "Home":
			return rowStart
		case "End":
			return Math.min(count - 1, rowStart + columns - 1)
		default:
			return null
	}
}

// Text with `insert` replacing the selection [start, end), and the caret after it. A custom `:name:` token right
// after a non-space character gets a space before it, so the shortcode never runs into a colon before it (in
// "10:30" + ":kekw:", ":30:" would match first and the emoji would never render).
export function insertEmojiAt(value: string, start: number, end: number, insert: string): { value: string; caret: number } {
	const before = value.slice(0, start)
	const previous = before.at(-1)
	const text = insert.startsWith(":") && previous !== undefined && !/\s/.test(previous) ? ` ${insert}` : insert

	return { value: `${before}${text}${value.slice(end)}`, caret: start + text.length }
}

export function emojiCellId(gridId: string, index: number): string {
	return `${gridId}-cell-${String(index)}`
}

// Spoken and hover name: a custom emoji by its shortcode, a standard one by its CLDR name.
export function emojiLabel(item: EmojiSuggestion): string {
	return item.kind === "custom" ? `:${item.name}:` : item.label
}
