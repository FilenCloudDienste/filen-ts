import { LOWERCASE_FLAG, UPPERCASE_FLAG, WORD_BREAK_CLASS_MASK, WordBreakClass } from "../classes"
import type { Hyphenator } from "../layout"
import { BREAK_HYPHEN, BREAK_NONE } from "../lineBreak"
import type { ParagraphText } from "../paragraph"
import type { StyleTable } from "../styles"
import { wordBreakTable } from "../unicode"
import { HYPHENATION_LANGUAGES } from "./languages.generated"
import type { HyphenationLibrary } from "./library"

// Automatic hyphenation of a paragraph's words, each in its language (StyleTable.language at its first character),
// by the bundled TeX patterns. Word and LibreOffice hyphenate with their own lexicons, so breaks are correct for the
// language but not always the ones they choose. A word is a run of letters (with their marks, and apostrophes
// between letters); words with digits or a soft hyphen (whose breaks are the author's) are left whole.

export interface HyphenationRules {
	// The fewest characters kept before and after a break, at least the patterns' own and 2. Default 2.
	readonly left?: number
	readonly right?: number
	// The shortest word hyphenated, in characters. Default 5.
	readonly minWord?: number
	// Words in capitals only are hyphenated too (Word unless w:doNotHyphenateCaps). Default true.
	readonly caps?: boolean
}

const LETTER = 1
const MARK = 2
const APOSTROPHE = 3
const DIGIT = 4
const SOFT_HYPHEN = 5

export class TextHyphenator implements Hyphenator {
	private readonly library: HyphenationLibrary
	private readonly left: number
	private readonly right: number
	private readonly minWord: number
	private readonly caps: boolean

	constructor(library: HyphenationLibrary, rules: HyphenationRules = {}) {
		this.library = library
		this.left = Math.max(2, rules.left ?? 2)
		this.right = Math.max(2, rules.right ?? 2)
		this.minWord = rules.minWord ?? 5
		this.caps = rules.caps ?? true
	}

	hyphenate(paragraph: ParagraphText, styles: StyleTable, breaks: Uint8Array): void {
		const text = paragraph.text
		const n = paragraph.length
		const table = wordBreakTable()
		const languages = styles.language
		let run = 0
		let runEnd = paragraph.runCount > 1 ? (paragraph.runStart[1] ?? n) : n

		for (let i = 0; i < n;) {
			if (kind(table, text, i) !== LETTER) {
				i++

				continue
			}

			const start = i
			let skip = false
			let upper = false
			let lower = false

			for (;;) {
				const k = kind(table, text, i)

				if (k === LETTER) {
					const flags = table.get(codePoint(text, i))

					if ((flags & UPPERCASE_FLAG) !== 0) upper = true
					if ((flags & LOWERCASE_FLAG) !== 0) lower = true
				} else if (k === DIGIT || k === SOFT_HYPHEN) {
					skip = true
				} else if (k === APOSTROPHE) {
					if (kind(table, text, i + 1) !== LETTER) break
				} else if (k !== MARK) {
					break
				}

				i += isHigh(text.charCodeAt(i)) && i + 1 < n ? 2 : 1

				if (i >= n) break
			}

			while (start >= runEnd && run + 1 < paragraph.runCount) {
				run++
				runEnd = run + 1 < paragraph.runCount ? (paragraph.runStart[run + 1] ?? n) : n
			}

			if (skip || i - start < this.minWord || (!this.caps && upper && !lower)) continue

			const language = languages[paragraph.runStyle[run] ?? paragraph.markStyle] ?? 0

			if (language === 0 || !this.library.request(language)) continue

			const patterns = this.library.patterns(language)
			const word = text.slice(start, i).toLowerCase()

			// Case mapping that changes the length (a dotted capital I) leaves offsets unmatched.
			if (patterns === null || word.length !== i - start) continue

			const entry = HYPHENATION_LANGUAGES[language - 1]
			const left = Math.max(this.left, entry?.left ?? 0)
			const last = word.length - Math.max(this.right, entry?.right ?? 0)

			for (const at of patterns.breaks(word)) {
				if (at < left || at > last) continue

				const offset = start + at

				if (breaks[offset] === BREAK_NONE && kind(table, text, offset) === LETTER) breaks[offset] = BREAK_HYPHEN
			}
		}
	}
}

function isHigh(unit: number): boolean {
	return unit >= 0xd800 && unit <= 0xdbff
}

function codePoint(text: string, i: number): number {
	const unit = text.charCodeAt(i)

	if (isHigh(unit) && i + 1 < text.length) {
		const low = text.charCodeAt(i + 1)

		if (low >= 0xdc00 && low <= 0xdfff) return (unit - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
	}

	return unit
}

function kind(table: ReturnType<typeof wordBreakTable>, text: string, i: number): number {
	if (i >= text.length) return 0

	const unit = text.charCodeAt(i)

	if (unit === 0x27 || unit === 0x2019) return APOSTROPHE
	if (unit === 0xad) return SOFT_HYPHEN
	if (unit < 0x80) {
		if ((unit >= 0x61 && unit <= 0x7a) || (unit >= 0x41 && unit <= 0x5a)) return LETTER

		return unit >= 0x30 && unit <= 0x39 ? DIGIT : 0
	}

	switch (table.get(codePoint(text, i)) & WORD_BREAK_CLASS_MASK) {
		case WordBreakClass.ALetter:
		case WordBreakClass.Hebrew_Letter:
			return LETTER
		case WordBreakClass.Extend:
		case WordBreakClass.Format:
		case WordBreakClass.ZWJ:
			return MARK
		case WordBreakClass.Numeric:
			return DIGIT
		default:
			return 0
	}
}
