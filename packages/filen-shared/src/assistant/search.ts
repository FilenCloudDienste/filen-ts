import { sanitizeUntrustedText } from "./untrusted"

// Matching the words of a query against names, as every app's tools and the eval's fake app do.

// Accents, marks and invisible characters go: a name the model copies back matches with or without a
// Persian name's zero-width non-joiner.
export function normalizeText(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, "")
		.toLowerCase()
}

const UNSPACED =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u

const KANA_PARTICLE = /^[\p{Script=Hiragana}]$/u

// Created on first use, never at load: a segmenter loads the locale's word data, and a runtime without
// Intl.Segmenter only fails a query in a script written without spaces.
let segmenter: Intl.Segmenter | null = null

// The words of a query, in the case and form the user wrote them: scripts written without spaces
// ("2024年の請求書", "報告書をArchiveに") are split into words, a change of script splits too, and a lone
// kana particle is dropped.
function queryWords(value: string): string[] {
	const text = value.normalize("NFC").toLowerCase()

	if (!UNSPACED.test(text)) {
		return text.split(/[^\p{L}\p{M}\p{N}]+/u).filter(word => word.length > 0)
	}

	segmenter ??= new Intl.Segmenter(undefined, { granularity: "word" })

	return [...segmenter.segment(text)]
		.filter(segment => segment.isWordLike === true)
		.flatMap(segment =>
			segment.segment.split(
				/(?<=\p{Script=Latin}|\p{N})(?=[^\p{Script=Latin}\p{N}])|(?<=[^\p{Script=Latin}\p{N}])(?=\p{Script=Latin}|\p{N})/u
			)
		)
		.filter(word => word.length > 0 && !KANA_PARTICLE.test(word))
}

// For the app's own matching, where both sides are folded the same way (accents and marks removed).
export function searchTokens(value: string): string[] {
	return queryWords(value)
		.map(normalizeText)
		.filter(token => token.length > 0)
}

// For a matcher that compares names as written (the SDK's search engine: NFC, case-folded, nothing else
// folded): accents, Devanagari vowel signs and voiced kana stay.
export function rawSearchTokens(value: string): string[] {
	return queryWords(value)
}

// A word's singular, for a substring engine: "invoices" asks for "invoice", "boxes" for "box".
function singularStem(token: string): string {
	if (token.length > 4 && /(?:s|x|z|ch|sh)es$/u.test(token)) {
		return token.slice(0, -2)
	}

	return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token
}

// The words a substring engine may be asked for, the likeliest to narrow the hits first: words before
// numbers, longer before shorter, each as its singular so it also finds the other form, none twice.
export function engineTokens(tokens: readonly string[], max: number): string[] {
	const ranked = tokens
		.filter(token => token.length > 0)
		.toSorted((a, b) => Number(/^\p{N}+$/u.test(a)) - Number(/^\p{N}+$/u.test(b)) || b.length - a.length)
		.map(singularStem)

	return [...new Set(ranked)].slice(0, max)
}

// "invoices" finds "Invoice_2024.pdf": names are matched word by word with crude plural folding.
export function tokenMatches(haystack: string, token: string): boolean {
	if (haystack.includes(token)) {
		return true
	}

	if (token.length > 4 && token.endsWith("es") && haystack.includes(token.slice(0, -2))) {
		return true
	}

	return token.length > 3 && token.endsWith("s") && haystack.includes(token.slice(0, -1))
}

export function matchScore(name: string, tokens: readonly string[]): number {
	const haystack = normalizeText(name)

	return tokens.filter(token => tokenMatches(haystack, token)).length
}

export function sameName(a: string, b: string): boolean {
	return normalizeText(a.trim()) === normalizeText(b.trim())
}

export const CONTEXT_NAME_MAX_CHARS = 80

// A name in the context line: other people choose shared items', notes', chats' and tracks' names, and the
// line sits in the system prompt. Sanitized, on one line, shortened and quoted, so it can neither carry
// template tokens nor pose as another field of the line. The loop sanitizes the whole line again with the
// model's own tokens.
export function contextName(name: string): string {
	const flat = Array.from(sanitizeUntrustedText(name, [], { keepJoiners: true }).replace(/\s+/g, " ").trim())

	return JSON.stringify(flat.length > CONTEXT_NAME_MAX_CHARS ? `${flat.slice(0, CONTEXT_NAME_MAX_CHARS - 1).join("")}…` : flat.join(""))
}
