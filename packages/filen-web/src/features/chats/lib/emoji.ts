// Standard-unicode emoji shortcode table + lookup, PLUS Filen's full custom (non-unicode) emoji pack —
// see the "Custom emoji pack" section below for how the two are sourced and reconciled.
//
// The web completes / renders standard shortcodes against a curated STANDARD-unicode shortcode table (a
// subset of the gemoji/emoji-mart short-name convention): `:name:` completes to and renders as the native
// unicode glyph, self-contained and asset-free. An unknown shortcode (neither this table nor the custom
// pack below) stays literal `:shortcode:` text.

import customEmojiPackData from "@/assets/customEmojis.json"

// shortcode (without the surrounding colons) → unicode glyph. Curated common set; extend as needed.
export const EMOJI_SHORTCODES: Readonly<Record<string, string>> = {
	smile: "😄",
	smiley: "😃",
	grin: "😁",
	laughing: "😆",
	joy: "😂",
	rofl: "🤣",
	relaxed: "☺️",
	blush: "😊",
	slightly_smiling_face: "🙂",
	upside_down_face: "🙃",
	wink: "😉",
	heart_eyes: "😍",
	kissing_heart: "😘",
	kissing: "😗",
	yum: "😋",
	stuck_out_tongue: "😛",
	stuck_out_tongue_winking_eye: "😜",
	stuck_out_tongue_closed_eyes: "😝",
	money_mouth_face: "🤑",
	hugs: "🤗",
	thinking: "🤔",
	zipper_mouth_face: "🤐",
	neutral_face: "😐",
	expressionless: "😑",
	no_mouth: "😶",
	smirk: "😏",
	unamused: "😒",
	roll_eyes: "🙄",
	grimacing: "😬",
	relieved: "😌",
	pensive: "😔",
	sleepy: "😪",
	drooling_face: "🤤",
	sleeping: "😴",
	mask: "😷",
	face_with_thermometer: "🤒",
	nauseated_face: "🤢",
	sneezing_face: "🤧",
	dizzy_face: "😵",
	sunglasses: "😎",
	nerd_face: "🤓",
	confused: "😕",
	worried: "😟",
	slightly_frowning_face: "🙁",
	frowning_face: "☹️",
	open_mouth: "😮",
	hushed: "😯",
	astonished: "😲",
	flushed: "😳",
	frowning: "😦",
	anguished: "😧",
	fearful: "😨",
	cold_sweat: "😰",
	disappointed_relieved: "😥",
	cry: "😢",
	sob: "😭",
	scream: "😱",
	confounded: "😖",
	persevere: "😣",
	disappointed: "😞",
	sweat: "😓",
	weary: "😩",
	tired_face: "😫",
	triumph: "😤",
	rage: "😡",
	angry: "😠",
	smiling_imp: "😈",
	imp: "👿",
	skull: "💀",
	poop: "💩",
	clown_face: "🤡",
	ghost: "👻",
	alien: "👽",
	robot: "🤖",
	wave: "👋",
	raised_hand: "✋",
	ok_hand: "👌",
	v: "✌️",
	crossed_fingers: "🤞",
	point_up: "☝️",
	point_down: "👇",
	point_left: "👈",
	point_right: "👉",
	thumbsup: "👍",
	"+1": "👍",
	thumbsdown: "👎",
	"-1": "👎",
	fist: "✊",
	facepunch: "👊",
	clap: "👏",
	raised_hands: "🙌",
	pray: "🙏",
	handshake: "🤝",
	muscle: "💪",
	writing_hand: "✍️",
	nail_care: "💅",
	eyes: "👀",
	brain: "🧠",
	heart: "❤️",
	orange_heart: "🧡",
	yellow_heart: "💛",
	green_heart: "💚",
	blue_heart: "💙",
	purple_heart: "💜",
	black_heart: "🖤",
	broken_heart: "💔",
	two_hearts: "💕",
	sparkling_heart: "💖",
	heartpulse: "💗",
	cupid: "💘",
	fire: "🔥",
	star: "⭐",
	star2: "🌟",
	sparkles: "✨",
	zap: "⚡",
	boom: "💥",
	collision: "💥",
	dizzy: "💫",
	sweat_drops: "💦",
	droplet: "💧",
	tada: "🎉",
	confetti_ball: "🎊",
	balloon: "🎈",
	gift: "🎁",
	trophy: "🏆",
	medal: "🏅",
	rocket: "🚀",
	airplane: "✈️",
	sunny: "☀️",
	cloud: "☁️",
	rainbow: "🌈",
	snowflake: "❄️",
	snowman: "⛄",
	moon: "🌙",
	earth_africa: "🌍",
	dog: "🐶",
	cat: "🐱",
	mouse: "🐭",
	rabbit: "🐰",
	fox_face: "🦊",
	bear: "🐻",
	panda_face: "🐼",
	tiger: "🐯",
	lion: "🦁",
	cow: "🐮",
	pig: "🐷",
	frog: "🐸",
	monkey_face: "🐵",
	chicken: "🐔",
	penguin: "🐧",
	bird: "🐦",
	unicorn: "🦄",
	bee: "🐝",
	bug: "🐛",
	butterfly: "🦋",
	snail: "🐌",
	fish: "🐟",
	whale: "🐳",
	dolphin: "🐬",
	apple: "🍎",
	banana: "🍌",
	pizza: "🍕",
	hamburger: "🍔",
	fries: "🍟",
	taco: "🌮",
	coffee: "☕",
	tea: "🍵",
	beer: "🍺",
	beers: "🍻",
	wine_glass: "🍷",
	cocktail: "🍸",
	cake: "🍰",
	birthday: "🎂",
	cookie: "🍪",
	chocolate_bar: "🍫",
	candy: "🍬",
	doughnut: "🍩",
	ice_cream: "🍨",
	checkered_flag: "🏁",
	soccer: "⚽",
	basketball: "🏀",
	football: "🏈",
	tennis: "🎾",
	"8ball": "🎱",
	game_die: "🎲",
	dart: "🎯",
	musical_note: "🎵",
	notes: "🎶",
	microphone: "🎤",
	headphones: "🎧",
	guitar: "🎸",
	bulb: "💡",
	computer: "💻",
	iphone: "📱",
	email: "📧",
	lock: "🔒",
	key: "🔑",
	hourglass: "⌛",
	watch: "⌚",
	bell: "🔔",
	mag: "🔍",
	link: "🔗",
	pushpin: "📌",
	memo: "📝",
	pencil: "📝",
	book: "📖",
	books: "📚",
	moneybag: "💰",
	dollar: "💵",
	credit_card: "💳",
	gem: "💎",
	white_check_mark: "✅",
	heavy_check_mark: "✔️",
	x: "❌",
	negative_squared_cross_mark: "❎",
	warning: "⚠️",
	no_entry: "⛔",
	question: "❓",
	exclamation: "❗",
	bangbang: "‼️",
	100: "💯",
	ok: "🆗",
	new: "🆕",
	up: "🔼",
	arrow_up: "⬆️",
	arrow_down: "⬇️",
	arrow_left: "⬅️",
	arrow_right: "➡️",
	recycle: "♻️",
	heavy_plus_sign: "➕",
	heavy_minus_sign: "➖",
	heavy_multiplication_x: "✖️",
	heavy_dollar_sign: "💲",
	white_flower: "💮",
	rose: "🌹",
	sunflower: "🌻",
	four_leaf_clover: "🍀",
	christmas_tree: "🎄",
	jack_o_lantern: "🎃",
	crown: "👑",
	eyeglasses: "👓",
	tophat: "🎩",
	umbrella: "☂️",
	house: "🏠",
	office: "🏢",
	hospital: "🏥",
	school: "🏫",
	car: "🚗",
	taxi: "🚕",
	bus: "🚌",
	train: "🚆",
	bike: "🚲",
	anchor: "⚓",
	construction: "🚧",
	hammer: "🔨",
	wrench: "🔧",
	gear: "⚙️",
	shield: "🛡️",
	battery: "🔋",
	flashlight: "🔦",
	camera: "📷",
	tv: "📺",
	clapper: "🎬",
	art: "🎨",
	dizzy_star: "🌠",
	partying_face: "🥳",
	exploding_head: "🤯",
	shushing_face: "🤫",
	star_struck: "🤩",
	heart_hands: "🫶",
	saluting_face: "🫡",
	melting_face: "🫠"
}

// ── Custom emoji pack (non-unicode, image-backed) ───────────────────────────────────────────────────
// Filen's shared custom emoji pack is a large (thousand-plus-entry) set of image-backed shortcodes —
// Twitch/BTTV-style reaction emotes, not unicode glyphs — that mobile and old-web both source from a
// CDN-hosted manifest (each entry's image is a remote https://cdn.filen.io/... url). The pack's DATA
// (id/name/keywords/image url per entry) is canonical and shared across apps — mobile's copy lives at
// filen-mobile/src/assets/customEmojis.json; this is that same file, copied verbatim rather than
// regenerated, so both apps stay in lockstep on ids and CDN paths. The image urls are only renderable
// here because the app's Content-Security-Policy allowlists cdn.filen.io under img-src.
interface CustomEmojiPackEntry {
	id: string
	name: string
	keywords: string[]
	skins: { src: string }[]
}

// Vite/TS resolve the JSON import structurally against this interface (resolveJsonModule) — no runtime
// parsing or cast needed.
const CUSTOM_EMOJI_PACK: readonly CustomEmojiPackEntry[] = customEmojiPackData

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
	// asserted non-null, since this is externally sourced data copied from another package.
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

// A handful of the pack's ~1100 ids collide with the curated standard-unicode table above (e.g. "clap",
// "fire", "ok" — the pack owns the id independently of this web-only table). Mobile has no textual
// standard-shortcode lookup at all: its regexed.tsx only ever resolves `:id:` against the custom pack
// (standard unicode emoji reach a message as literal glyph characters typed via the OS keyboard, never
// as `:name:` text), so for any id the custom pack defines, the custom pack is mobile's ONLY answer —
// there is nothing else for it to lose to. Matching that on web means the custom pack wins every
// collision: a colliding shortcode resolves to its CDN image, never the unicode glyph.
export function emojiForShortcode(shortcode: string): string | undefined {
	const normalized = shortcode.toLowerCase()

	if (CUSTOM_EMOJI_MAP.has(normalized)) {
		return undefined
	}

	return EMOJI_SHORTCODES[normalized]
}

// A suggestion is either a standard unicode glyph or a custom-pack image — the composer's `:`
// autocomplete sources both into one merged, ranked list (see searchEmoji below); the render/insertion
// layers switch on `kind` to pick a unicode-glyph vs. an image-shortcode replacement.
export type EmojiSuggestion = { name: string } & ({ kind: "standard"; char: string } | { kind: "custom"; imageUrl: string })

// Suggestion list for the composer's `:` autocomplete. Prefix matches rank above substring matches
// (both alphabetically inside their tier), so `:sm` surfaces `smile`/`smiley` before `kissing_heart`
// never would — it just keeps the obvious completions on top. Capped to `limit` (mobile caps at 10).
// Sources BOTH the standard shortcode table and the custom pack into one ranked list, matching custom
// entries by id OR keyword. A standard name the custom pack also owns is skipped here — same
// custom-wins precedence as emojiForShortcode, so the picker never shows two entries for one id.
export function searchEmoji(query: string, limit: number): EmojiSuggestion[] {
	const q = query.toLowerCase()

	if (q.length === 0) {
		return []
	}

	const prefix: EmojiSuggestion[] = []
	const contains: EmojiSuggestion[] = []

	for (const name of Object.keys(EMOJI_SHORTCODES)) {
		if (CUSTOM_EMOJI_MAP.has(name)) {
			continue
		}

		const char = EMOJI_SHORTCODES[name]

		if (char === undefined) {
			continue
		}

		const item: EmojiSuggestion = { kind: "standard", name, char }

		if (name.startsWith(q)) {
			prefix.push(item)
		} else if (name.includes(q)) {
			contains.push(item)
		}
	}

	for (const emoji of CUSTOM_EMOJIS) {
		const item: EmojiSuggestion = { kind: "custom", name: emoji.name, imageUrl: emoji.imageUrl }
		const matches = emoji.name.startsWith(q) || emoji.keywords.some(keyword => keyword.toLowerCase().startsWith(q))

		if (matches) {
			prefix.push(item)
		} else if (emoji.name.includes(q) || emoji.keywords.some(keyword => keyword.toLowerCase().includes(q))) {
			contains.push(item)
		}
	}

	prefix.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	contains.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

	return [...prefix, ...contains].slice(0, limit)
}
