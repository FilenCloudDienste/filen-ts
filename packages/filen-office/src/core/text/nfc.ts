// Text in Unicode NFC with a map back to the original, for searches that must not care how a document composed
// its characters.

const MARK = /\p{M}/u

// A Hangul leading consonant jamo or an LV syllable: conjoining vowels and finals after it compose with it.
function takesJamo(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0xa960 && code <= 0xa97f) ||
		(code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 === 0)
	)
}

// A conjoining Hangul vowel or final jamo (General_Category Lo, so not a mark). Non-composing ones in the
// blocks just join the piece.
function isTrailingJamo(code: number): boolean {
	return (code >= 0x1160 && code <= 0x11ff) || (code >= 0xd7b0 && code <= 0xd7ff)
}

// `text` in NFC, with each normalised code unit's cluster in the original (start, end): a match maps back to
// whole characters however the document composed them. Null maps when the text is already NFC.
export interface NfcText {
	readonly text: string
	readonly starts: Int32Array | null
	readonly ends: Int32Array | null
}

export function nfcWithMap(text: string): NfcText {
	const nfc = text.normalize("NFC")

	if (nfc === text) return { text, starts: null, ends: null }

	const starts: number[] = []
	const ends: number[] = []
	let out = ""
	let at = 0

	while (at < text.length) {
		// A cluster: one code point, the conjoining jamo a Hangul syllable takes (never a second leading
		// consonant), and the combining marks after it.
		const first = text.codePointAt(at) ?? 0
		let end = at + (first > 0xffff ? 2 : 1)

		if (takesJamo(first)) {
			while (end < text.length && isTrailingJamo(text.charCodeAt(end))) end++
		}

		while (end < text.length) {
			const next = text.codePointAt(end) ?? 0

			if (!MARK.test(String.fromCodePoint(next))) break

			end += next > 0xffff ? 2 : 1
		}

		const piece = text.slice(at, end).normalize("NFC")

		for (let k = 0; k < piece.length; k++) {
			starts.push(at)
			ends.push(end)
		}

		out += piece
		at = end
	}

	return { text: out, starts: Int32Array.from(starts), ends: Int32Array.from(ends) }
}
