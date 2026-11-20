// Skin tones for the emoji picker: 0 is the default yellow (no modifier), 1 (light) to 5 (dark) the Fitzpatrick
// modifiers U+1F3FB to U+1F3FF. Its own import-free file, as scripts/emojiDataSource.ts builds the emoji data with it.

export const SKIN_TONES = [0, 1, 2, 3, 4, 5] as const

export type SkinTone = (typeof SKIN_TONES)[number]

const ZWJ = "\u200d"
const VS16 = "\ufe0f"

export function skinToneModifier(tone: Exclude<SkinTone, 0>): string {
	return String.fromCodePoint(0x1f3fa + tone)
}

// `char` in skin tone `tone`: the modifier after the first code point of each ZWJ-joined part listed in `toneParts`
// (part indexes as digits), a VS16 right after that code point dropped, as Unicode's toned sequences never carry it
// there. The data generator checks this gives Unicode's own sequence for every emoji that takes a tone, in every tone.
export function applySkinTone(char: string, toneParts: string, tone: SkinTone): string {
	if (tone === 0 || toneParts.length === 0) {
		return char
	}

	const modifier = skinToneModifier(tone)

	return char
		.split(ZWJ)
		.map((part, index) => {
			if (!toneParts.includes(String(index))) {
				return part
			}

			const first = String.fromCodePoint(part.codePointAt(0) ?? 0)
			const rest = part.slice(first.length)

			return `${first}${modifier}${rest.startsWith(VS16) ? rest.slice(VS16.length) : rest}`
		})
		.join(ZWJ)
}
