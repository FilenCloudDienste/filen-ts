// Standard-unicode emoji shortcode table + lookup, PLUS a bundled subset of Filen's custom (non-unicode)
// emoji pack — see the "Custom emoji pack" section below for why it's a subset rather than the full set.
//
// The web completes / renders standard shortcodes against a curated STANDARD-unicode shortcode table (a
// subset of the gemoji/emoji-mart short-name convention): `:name:` completes to and renders as the native
// unicode glyph, self-contained and asset-free. An unknown shortcode (neither this table nor the bundled
// custom pack below) stays literal `:shortcode:` text.

import kekwUrl from "@/assets/customEmojis/kekw.webp"
import pogUrl from "@/assets/customEmojis/pog.webp"
import poguUrl from "@/assets/customEmojis/pogu.webp"
import poggiesUrl from "@/assets/customEmojis/poggies.webp"
import letsgoUrl from "@/assets/customEmojis/letsgo.webp"
import clapUrl from "@/assets/customEmojis/clap.webp"
import gigachadUrl from "@/assets/customEmojis/gigachad.webp"
import catjamUrl from "@/assets/customEmojis/catjam.webp"
import sadgeUrl from "@/assets/customEmojis/sadge.webp"
import copiumUrl from "@/assets/customEmojis/copium.webp"
import praygeUrl from "@/assets/customEmojis/prayge.webp"
import hmmUrl from "@/assets/customEmojis/hmm.webp"
import monkawUrl from "@/assets/customEmojis/monkaw.webp"
import popcatUrl from "@/assets/customEmojis/popcat.webp"
import pepelaughUrl from "@/assets/customEmojis/pepelaugh.webp"
import noddersUrl from "@/assets/customEmojis/nodders.webp"
import awareUrl from "@/assets/customEmojis/aware.webp"
import savedUrl from "@/assets/customEmojis/saved.webp"
import yepUrl from "@/assets/customEmojis/yep.webp"
import meowUrl from "@/assets/customEmojis/meow.webp"

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

// Longest-name-first isn't needed — shortcodes are looked up whole. Returns the glyph or undefined.
export function emojiForShortcode(shortcode: string): string | undefined {
	return EMOJI_SHORTCODES[shortcode.toLowerCase()]
}

// ── Custom emoji pack (non-unicode, image-backed) ───────────────────────────────────────────────────
// Filen's shared custom emoji pack is a large (thousand-plus-entry) set of image-backed shortcodes —
// Twitch/BTTV-style reaction emotes, not unicode glyphs — that mobile and old-web both source from a
// CDN-hosted manifest (each entry's image is a remote https://cdn.filen.io/... url). This app's
// Content-Security-Policy restricts img-src to 'self' plus blob:/data: — no external image host is
// allowlisted — so those CDN urls cannot be rendered here as-is, and the CSP is not something a single
// chat feature should widen for its own convenience.
//
// This ships a SMALL, hand-picked SUBSET of the pack instead, as genuine same-origin assets: each image
// is a real file bundled under this app (resolved to a hashed, same-origin URL by the bundler, the exact
// pattern the drive file-type icon set already uses under assets/file-icons) — self-contained, no runtime
// fetch, CSP-compliant by construction. It proves out the full lookup + autocomplete + jumbo-render path
// end to end. Hosting the REMAINING ~1000+ entries is a deliberate follow-up that needs one of: (a)
// checking that many binary images into this repo (this 20-emoji subset alone is ~650KB — the full pack
// would run tens of megabytes of git history forever), or (b) standing up a sanctioned first-party asset
// host (e.g. a static bucket under a filen.io subdomain) and widening img-src to it. Both are
// product/infra decisions outside a single feature change's scope — flagged here rather than silently
// left incomplete.
export interface CustomEmoji {
	// The shortcode without surrounding colons, e.g. "kekw" for `:kekw:`. Lowercase, no spaces.
	name: string
	imageUrl: string
}

export const CUSTOM_EMOJIS: readonly CustomEmoji[] = [
	{ name: "kekw", imageUrl: kekwUrl },
	{ name: "pog", imageUrl: pogUrl },
	{ name: "pogu", imageUrl: poguUrl },
	{ name: "poggies", imageUrl: poggiesUrl },
	{ name: "letsgo", imageUrl: letsgoUrl },
	{ name: "clap", imageUrl: clapUrl },
	{ name: "gigachad", imageUrl: gigachadUrl },
	{ name: "catjam", imageUrl: catjamUrl },
	{ name: "sadge", imageUrl: sadgeUrl },
	{ name: "copium", imageUrl: copiumUrl },
	{ name: "prayge", imageUrl: praygeUrl },
	{ name: "hmm", imageUrl: hmmUrl },
	{ name: "monkaw", imageUrl: monkawUrl },
	{ name: "popcat", imageUrl: popcatUrl },
	{ name: "pepelaugh", imageUrl: pepelaughUrl },
	{ name: "nodders", imageUrl: noddersUrl },
	{ name: "aware", imageUrl: awareUrl },
	{ name: "saved", imageUrl: savedUrl },
	{ name: "yep", imageUrl: yepUrl },
	{ name: "meow", imageUrl: meowUrl }
]

const CUSTOM_EMOJI_MAP: ReadonlyMap<string, string> = new Map(CUSTOM_EMOJIS.map(emoji => [emoji.name, emoji.imageUrl]))

// Returns the bundled image url for a custom-pack shortcode, or undefined (unknown / outside the bundled
// subset — falls back to literal `:shortcode:` text at the render layer, same as an unknown standard one).
export function customEmojiImageForShortcode(shortcode: string): string | undefined {
	return CUSTOM_EMOJI_MAP.get(shortcode.toLowerCase())
}

// A suggestion is either a standard unicode glyph or a bundled custom-pack image — the composer's `:`
// autocomplete sources both into one merged, ranked list (see searchEmoji below); the render/insertion
// layers switch on `kind` to pick a unicode-glyph vs. an image-shortcode replacement.
export type EmojiSuggestion = { name: string } & ({ kind: "standard"; char: string } | { kind: "custom"; imageUrl: string })

// Suggestion list for the composer's `:` autocomplete. Prefix matches rank above substring matches
// (both alphabetically inside their tier), so `:sm` surfaces `smile`/`smiley` before `kissing_heart`
// never would — it just keeps the obvious completions on top. Capped to `limit` (mobile caps at 10).
// Sources BOTH the standard shortcode table and the bundled custom-pack subset into one ranked list.
export function searchEmoji(query: string, limit: number): EmojiSuggestion[] {
	const q = query.toLowerCase()

	if (q.length === 0) {
		return []
	}

	const prefix: EmojiSuggestion[] = []
	const contains: EmojiSuggestion[] = []

	for (const name of Object.keys(EMOJI_SHORTCODES)) {
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

		if (emoji.name.startsWith(q)) {
			prefix.push(item)
		} else if (emoji.name.includes(q)) {
			contains.push(item)
		}
	}

	prefix.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	contains.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

	return [...prefix, ...contains].slice(0, limit)
}
