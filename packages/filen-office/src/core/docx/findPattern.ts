// The pattern both DOCX finds (the viewer's over laid-out pages, the editor's over the editing document) search
// with, so the two cannot drift apart. The query is literal and compared in NFC. A whole word (Word's "Find whole
// words only") has no letter, mark, digit or underscore next to it, checked only at an edge of the query that is
// itself one of those (as Word does: "the " still matches in "the other").

export interface DocxFindPatternOptions {
	readonly caseSensitive?: boolean
	readonly wholeWord?: boolean
}

const SPECIAL = /[.*+?^${}()|[\]\\]/g
const WORD_CLASS = "[\\p{L}\\p{M}\\p{N}_]"
const WORD_START = new RegExp(`^${WORD_CLASS}`, "u")
const WORD_END = new RegExp(`${WORD_CLASS}$`, "u")

// The query as a global, Unicode-aware pattern, case-insensitive unless asked; null for an empty query.
export function findPattern(query: string, options: DocxFindPatternOptions = {}): RegExp | null {
	const normalised = query.normalize("NFC")

	if (normalised.length === 0) return null

	let source = normalised.replace(SPECIAL, "\\$&")

	if (options.wholeWord === true) {
		if (WORD_START.test(normalised)) source = `(?<!${WORD_CLASS})${source}`
		if (WORD_END.test(normalised)) source = `${source}(?!${WORD_CLASS})`
	}

	return new RegExp(source, options.caseSensitive === true ? "gu" : "giu")
}
