import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { applySkinTone, skinToneModifier } from "../src/features/chats/lib/skinTone"

// Builds src/features/chats/lib/emojiData.gen.ts (scripts/emojiData.ts writes it; with --check, which
// src/tests/chatsEmojiData.test.ts runs, it checks the committed file still matches) from emojibase-data, a
// devDependency read under node_modules: its English compact set (names and keywords, which emojibase takes from Unicode
// CLDR's annotations, grouped and ordered as Unicode's emoji-test data) and the iamcal and GitHub shortcode sets.
// iamcal's names are the ids the old web app's picker and `:` autocomplete wrote into messages, so they win where GitHub
// names another emoji the same.

export const EMOJI_DATA_OUTPUT = "src/features/chats/lib/emojiData.gen.ts"

// Unicode's emoji groups in order, by emojibase's group number. Group 2 (skin tone and hair components) is never
// offered on its own, and neither are the bare regional indicators (no group).
const GROUPS: readonly (readonly [number, string])[] = [
	[0, "smileys"],
	[1, "people"],
	[3, "nature"],
	[4, "food"],
	[5, "travel"],
	[6, "activities"],
	[7, "objects"],
	[8, "symbols"],
	[9, "flags"]
]

const ZWJ = "\u200d"
// The five Fitzpatrick modifiers: tone 1 (light) to 5 (dark).
const TONES = [1, 2, 3, 4, 5] as const
const MODIFIERS = TONES.map(skinToneModifier)

interface CompactEmoji {
	group?: number
	hexcode: string
	label: string
	order?: number
	tags?: string[]
	unicode: string
	skins?: { hexcode: string; unicode: string }[]
}

type ShortcodeSet = Record<string, string | string[]>

const require = createRequire(import.meta.url)

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(require.resolve(path), "utf8"))
}

// The ZWJ parts a uniform skin tone goes on: those of the tone 1 variant that carry a modifier. Throws when that rule
// does not give Unicode's uniform variant for every tone, so the data never claims a sequence that does not exist.
function toneParts(emoji: CompactEmoji): string {
	if (emoji.skins === undefined || emoji.skins.length === 0) {
		return ""
	}

	const uniform = (tone: number): string | undefined =>
		emoji.skins?.find(skin => {
			const found = MODIFIERS.filter(modifier => skin.unicode.includes(modifier))

			return found.length === 1 && found[0] === MODIFIERS[tone - 1]
		})?.unicode
	const first = uniform(1)

	if (first === undefined) {
		throw new Error(`${emoji.hexcode}: no uniform light skin tone variant`)
	}

	const parts = first
		.split(ZWJ)
		.flatMap((part, index) => (MODIFIERS.some(modifier => part.includes(modifier)) ? [String(index)] : []))
		.join("")

	if (parts.length === 0 || first.split(ZWJ).length > 10) {
		throw new Error(`${emoji.hexcode}: unexpected toned sequence`)
	}

	for (const tone of TONES) {
		if (applySkinTone(emoji.unicode, parts, tone) !== uniform(tone)) {
			throw new Error(`${emoji.hexcode}: tone ${String(tone)} does not follow the modifier rule`)
		}
	}

	return parts
}

function shortcodeIndex(sets: readonly ShortcodeSet[]): Map<string, string[]> {
	const byHexcode = new Map<string, string[]>()
	const taken = new Set<string>()

	for (const set of sets) {
		for (const [hexcode, codes] of Object.entries(set)) {
			for (const code of [codes].flat()) {
				if (taken.has(code)) {
					continue
				}

				taken.add(code)
				byHexcode.set(hexcode, [...(byHexcode.get(hexcode) ?? []), code])
			}
		}
	}

	return byHexcode
}

export function emojiDataVersion(): string {
	return (readJson("emojibase-data/package.json") as { version: string }).version
}

// One line per emoji, tab-separated: the emoji, its CLDR name, its keywords (`|`-separated, those the name already
// holds as a word left out), its shortcodes (space-separated) and the ZWJ parts a skin tone goes on (digits; empty
// when it takes none). Trailing empty fields are dropped. Groups follow in EMOJI_GROUPS order, one blank line apart.
export function buildEmojiData(): string {
	const compact = readJson("emojibase-data/en/compact.json") as CompactEmoji[]
	const shortcodes = shortcodeIndex([
		readJson("emojibase-data/en/shortcodes/iamcal.json") as ShortcodeSet,
		readJson("emojibase-data/en/shortcodes/github.json") as ShortcodeSet
	])
	const groups = GROUPS.map(([group]) =>
		compact
			.filter(emoji => emoji.group === group)
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
			.map(emoji => {
				if (/[\t\n|]/.test(emoji.label) || (emoji.tags ?? []).some(tag => /[\t\n|]/.test(tag))) {
					throw new Error(`${emoji.hexcode}: separator in its name or keywords`)
				}

				const words = new Set(emoji.label.toLowerCase().split(/[\s:,]+/))
				const keywords = (emoji.tags ?? []).filter(tag => !words.has(tag.toLowerCase())).join("|")
				const fields = [emoji.unicode, emoji.label, keywords, (shortcodes.get(emoji.hexcode) ?? []).join(" "), toneParts(emoji)]

				return fields.join("\t").replace(/\t+$/, "")
			})
			.join("\n")
	)

	if (groups.some(group => group.length === 0) || compact.length < 1900) {
		throw new Error("not emojibase-data's compact set")
	}

	return groups.join("\n\n")
}

export function emojiDataModule(): string {
	const version = emojiDataVersion()

	return `// Generated by scripts/emojiData.ts from emojibase-data ${version} (MIT; names and keywords from Unicode CLDR's
// annotations, Unicode License v3: see the third-party notices). Do not edit.

// The emoji groups, in the order EMOJI_DATA holds them.
export const EMOJI_GROUPS = ${JSON.stringify(GROUPS.map(([, name]) => name))} as const

// The full Unicode emoji set as one string, split only when first needed (emojiData.ts). One emoji a line: the emoji,
// its name, its keywords (|-separated), its shortcodes (space-separated) and the ZWJ parts a skin tone goes on, tab-
// separated, trailing empty fields dropped; a blank line between groups.
export const EMOJI_DATA =
	${JSON.stringify(buildEmojiData())}
`
}
