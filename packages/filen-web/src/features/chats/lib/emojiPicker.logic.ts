import { CUSTOM_EMOJIS, EMOJI_SHORTCODES, searchEmoji, type EmojiSuggestion } from "@/features/chats/lib/emoji"

// The composer's emoji picker draws on the same two sets the `:` autocomplete and the message renderer use (emoji.ts):
// the curated standard shortcode table and Filen's custom pack, so whatever the picker offers also renders in a
// message. Each standard glyph sits in its Unicode emoji group below, by its canonical name (aliases such as "+1"
// or "collision" are left out, so no glyph shows twice). The names are kept as one string per group and only turned
// into items the first time the picker asks for them, so the picker costs nothing until it opens.

export type StandardEmojiCategory = "smileys" | "people" | "nature" | "food" | "travel" | "activities" | "objects" | "symbols"

export type EmojiPickerCategory = "recent" | StandardEmojiCategory | "custom"

// Tab order: recently used, the Unicode groups in their standard order, then Filen's own pack. The table holds a
// single flag (checkered_flag), so it sits with the sports rather than alone in a Flags tab.
export const EMOJI_PICKER_CATEGORIES: readonly EmojiPickerCategory[] = [
	"recent",
	"smileys",
	"people",
	"nature",
	"food",
	"travel",
	"activities",
	"objects",
	"symbols",
	"custom"
]

const STANDARD_CATEGORY_NAMES: Readonly<Record<StandardEmojiCategory, string>> = {
	smileys:
		"smile smiley grin laughing joy rofl relaxed blush slightly_smiling_face upside_down_face wink heart_eyes kissing_heart " +
		"kissing yum stuck_out_tongue stuck_out_tongue_winking_eye stuck_out_tongue_closed_eyes money_mouth_face hugs thinking " +
		"zipper_mouth_face neutral_face expressionless no_mouth smirk unamused roll_eyes grimacing relieved pensive sleepy " +
		"drooling_face sleeping mask face_with_thermometer nauseated_face sneezing_face dizzy_face sunglasses nerd_face confused " +
		"worried slightly_frowning_face frowning_face open_mouth hushed astonished flushed frowning anguished fearful cold_sweat " +
		"disappointed_relieved cry sob scream confounded persevere disappointed sweat weary tired_face triumph rage angry " +
		"smiling_imp imp skull poop clown_face ghost alien robot partying_face exploding_head shushing_face star_struck " +
		"saluting_face melting_face heart orange_heart yellow_heart green_heart blue_heart purple_heart black_heart broken_heart " +
		"two_hearts sparkling_heart heartpulse cupid 100 boom dizzy sweat_drops",
	people:
		"wave raised_hand ok_hand v crossed_fingers point_up point_down point_left point_right thumbsup thumbsdown fist facepunch " +
		"clap raised_hands heart_hands pray handshake writing_hand nail_care muscle brain eyes",
	nature:
		"dog cat mouse rabbit fox_face bear panda_face tiger lion cow pig frog monkey_face chicken penguin bird unicorn bee bug " +
		"butterfly snail fish whale dolphin white_flower rose sunflower four_leaf_clover",
	food: "apple banana pizza hamburger fries taco cookie doughnut ice_cream cake birthday chocolate_bar candy coffee tea beer beers wine_glass cocktail",
	travel:
		"earth_africa house office hospital school train bus taxi car bike construction anchor airplane rocket hourglass watch " +
		"moon sunny star star2 dizzy_star cloud rainbow umbrella zap snowflake snowman fire droplet",
	activities:
		"jack_o_lantern christmas_tree sparkles balloon tada confetti_ball gift trophy medal soccer basketball football tennis " +
		"8ball game_die dart art checkered_flag",
	objects:
		"eyeglasses crown tophat gem bell microphone musical_note notes headphones guitar iphone battery computer clapper camera " +
		"tv mag flashlight bulb book books moneybag dollar credit_card email memo pushpin lock key hammer wrench gear shield link",
	symbols:
		"no_entry warning recycle white_check_mark heavy_check_mark x negative_squared_cross_mark heavy_plus_sign heavy_minus_sign " +
		"heavy_multiplication_x heavy_dollar_sign bangbang question exclamation arrow_up arrow_right arrow_down arrow_left up ok new"
}

const categoryItems = new Map<Exclude<EmojiPickerCategory, "recent">, readonly EmojiSuggestion[]>()

// The items of one tab, built on first use and kept: the custom tab maps the pack's ~1100 prebuilt entries once.
export function emojiPickerCategoryItems(category: Exclude<EmojiPickerCategory, "recent">): readonly EmojiSuggestion[] {
	const cached = categoryItems.get(category)

	if (cached !== undefined) {
		return cached
	}

	const items: EmojiSuggestion[] =
		category === "custom"
			? CUSTOM_EMOJIS.map(emoji => ({ kind: "custom", name: emoji.name, imageUrl: emoji.imageUrl }))
			: STANDARD_CATEGORY_NAMES[category].split(" ").flatMap(name => {
					const char = EMOJI_SHORTCODES[name]

					return char === undefined ? [] : [{ kind: "standard" as const, name, char }]
				})

	categoryItems.set(category, items)

	return items
}

// Search results cap: past this many matches the query is too loose to scan by eye.
export const EMOJI_PICKER_SEARCH_LIMIT = 240

// Drops a standard item whose glyph an earlier item already shows (an alias: "+1" after "thumbsup").
export function withoutRepeatedGlyphs(items: readonly EmojiSuggestion[]): EmojiSuggestion[] {
	const seenChars = new Set<string>()

	return items.filter(item => {
		if (item.kind === "custom") {
			return true
		}

		if (seenChars.has(item.char)) {
			return false
		}

		seenChars.add(item.char)

		return true
	})
}

// The `:` autocomplete's ranking (prefix before substring, names and custom keywords), each glyph once.
export function searchEmojiPicker(query: string): EmojiSuggestion[] {
	return withoutRepeatedGlyphs(searchEmoji(query.trim(), EMOJI_PICKER_SEARCH_LIMIT))
}

// What choosing an item inserts into the composer, and the token the recently used list remembers it by: a standard
// emoji is its glyph, a custom one its `:name:` shortcode (it has no glyph; the message renderer resolves the
// shortcode back to the image).
export function emojiInsertText(item: EmojiSuggestion): string {
	return item.kind === "standard" ? item.char : `:${item.name}:`
}

let tokenIndex: Map<string, EmojiSuggestion> | null = null

// A remembered token back to its item, or undefined once the token no longer names an emoji the picker offers
// (a pack entry since removed, or stored data that is not ours).
export function emojiForInsertText(token: string): EmojiSuggestion | undefined {
	if (tokenIndex === null) {
		tokenIndex = new Map()

		for (const category of EMOJI_PICKER_CATEGORIES) {
			if (category === "recent") {
				continue
			}

			for (const item of emojiPickerCategoryItems(category)) {
				tokenIndex.set(emojiInsertText(item), item)
			}
		}
	}

	return tokenIndex.get(token)
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

// Spoken and hover name: a custom emoji by its shortcode, a standard one by its name in words.
export function emojiLabel(item: EmojiSuggestion): string {
	return item.kind === "custom" ? `:${item.name}:` : item.name.replaceAll("_", " ")
}
