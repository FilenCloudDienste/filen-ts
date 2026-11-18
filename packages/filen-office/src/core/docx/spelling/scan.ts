import type { Mark, Node } from "prosemirror-model"
import { WORD_KANA, WORD_LETTER, WORD_LOWER, WORD_NUMBER, WORD_UPPER, wordSegments } from "../../text/index"
import type { DocxEditContext } from "../edit/context"
import { FormatResolver } from "../edit/formats"
import { docxSchema } from "../edit/schema"
import type { StoryPart } from "../model/index"
import type { ParagraphFormat } from "../styles/index"
import type { SpellingChecker, SpellingKind } from "./checker"

// The words of one paragraph node to check, by Word's proofing rules: language from each run's w:lang slot
// for the word's script (styles and docDefaults included), nothing in noProof, hidden or deleted text,
// fields never (they are atoms: neither instructions nor results are text here), and Word's options:
// ignore words in UPPERCASE, words with numbers, Internet and file addresses; flag repeated words.

const marks = docxSchema.marks
const nodes = docxSchema.nodes

// One character per inline atom, so text offsets are the paragraph's content offsets. Zero-width atoms
// (range markers, Word's proofing marks, comment references, rendered page breaks) are Word_Break Format:
// a word around them stays one word.
const ZERO_WIDTH = "⁠"
const SOFT_HYPHEN = "­"
const OBJECT = "￼"
const INVISIBLE = /[⁠­]/g

// Longer "words" (identifiers, encoded data) are not checked.
export const MAX_WORD_LENGTH = 100

const RIGHT_QUOTE = "\u2019"
// Combining diacritical marks: text with them may be decomposed (NFD), while dictionaries and the user's
// dictionary hold precomposed (NFC) words.
const COMBINING_MARK = /[\u0300-\u036f]/

// The form a word is looked up in: NFC, with typographic apostrophes as ASCII ones, which every dictionary
// lists (some also map U+2019 themselves, others do not). Only words with a combining mark are normalised.
export function spellingQuery(word: string): string {
	const composed = COMBINING_MARK.test(word) ? word.normalize("NFC") : word

	return composed.includes(RIGHT_QUOTE) ? composed.replaceAll(RIGHT_QUOTE, "'") : composed
}

// Suggestions in the apostrophe style of the word they replace.
export function inWordStyle(word: string, suggestions: readonly string[]): readonly string[] {
	return word.includes(RIGHT_QUOTE) ? suggestions.map(suggestion => suggestion.replaceAll("'", RIGHT_QUOTE)) : suggestions
}

export interface ScanOptions {
	// For text whose runs and styles name no language.
	readonly defaultLanguage: string | undefined
	readonly ignoreUppercase: boolean
	readonly ignoreWordsWithNumbers: boolean
	readonly ignoreAddresses: boolean
	readonly flagRepeated: boolean
}

// Offsets relative to the paragraph's content start.
export interface RelativeIssue {
	readonly from: number
	readonly to: number
	readonly kind: SpellingKind
	readonly word: string
	readonly language: string
	readonly dictionary: string
}

export interface ParagraphScan {
	readonly issues: readonly RelativeIssue[]
	// Every word had a verdict: the result stays right until the paragraph or the verdicts change.
	readonly complete: boolean
}

interface RunFacts {
	readonly skip: boolean
	// w:rtl or w:cs: the complex-script language slot applies.
	readonly complex: boolean
	readonly latin: string | undefined
	readonly eastAsia: string | undefined
	readonly bidi: string | undefined
}

const SKIPPED: RunFacts = { skip: true, complex: false, latin: undefined, eastAsia: undefined, bidi: undefined }

const SLOT_LATIN = 0
const SLOT_EAST_ASIA = 1
const SLOT_COMPLEX = 2

// Which w:lang slot a script uses (Word: w:eastAsia for East Asian text, w:bidi for complex scripts).
function scriptSlot(cp: number): number {
	if (cp < 0x0590) return SLOT_LATIN
	if (cp <= 0x08ff || (cp >= 0x0900 && cp <= 0x0fff) || (cp >= 0x1780 && cp <= 0x17ff)) return SLOT_COMPLEX
	if ((cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xa960 && cp <= 0xa97f)) return SLOT_EAST_ASIA
	if ((cp >= 0xac00 && cp <= 0xd7ff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef)) return SLOT_EAST_ASIA
	if ((cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) return SLOT_COMPLEX
	if (cp >= 0x20000 && cp <= 0x3ffff) return SLOT_EAST_ASIA

	return SLOT_LATIN
}

// Internet and file addresses, Word's way: whitespace-separated tokens that are URLs (a scheme with "://",
// or www., mailto:, file:), e-mail addresses, or Windows, UNC and Unix paths. Each test is anchored or an
// indexOf on one token, so the cost stays linear however long a token is (encoded data, say).
const TOKEN = /[^\s\ufffc]+/g
const MAYBE_ADDRESS = /[:@\\/]|www/i
const SCHEME_CHAR = /[a-z0-9+.-]/i
const LETTER = /[a-z]/i
const PREFIX = /^(?:www\d{0,3}\.|mailto:|file:)/i
const DRIVE = /^[a-z]:\\/i
const LEADING_PUNCTUATION = /^[("'<[{\u201c\u2018]*/

function isAddress(token: string): boolean {
	const scheme = token.indexOf("://")

	if (scheme > 0) {
		// The scheme: the scheme characters right before "://", from their first letter.
		let start = scheme

		while (start > 0 && SCHEME_CHAR.test(token.charAt(start - 1))) start--
		while (start < scheme && !LETTER.test(token.charAt(start))) start++

		if (start < scheme) return true
	}

	const at = token.indexOf("@")

	if (at > 0 && token.indexOf(".", at + 2) > at + 1) return true

	const body = token.slice(LEADING_PUNCTUATION.exec(token)?.[0].length ?? 0)

	if (PREFIX.test(body) || DRIVE.test(body) || body.startsWith("\\\\")) return true

	// A Unix path: "/" or "~/" first and a second "/" after a name ("/usr/bin", not "and/or").
	const path = body.startsWith("~/") ? 1 : body.startsWith("/") ? 0 : -1

	return path >= 0 && body.length > path + 1 && body[path + 1] !== "/" && body.indexOf("/", path + 2) > path + 1
}

export function addressSpans(text: string): number[] {
	const spans: number[] = []

	if (!MAYBE_ADDRESS.test(text)) return spans

	TOKEN.lastIndex = 0

	for (let match = TOKEN.exec(text); match !== null; match = TOKEN.exec(text)) {
		const token = match[0]

		if (MAYBE_ADDRESS.test(token) && isAddress(token)) spans.push(match.index, match.index + token.length)
	}

	return spans
}

function spacesOnly(text: string, from: number, to: number): boolean {
	for (let i = from; i < to; i++) {
		const code = text.charCodeAt(i)

		if (code !== 0x20 && code !== 0xa0 && code !== 0x2060) return false
	}

	return from < to
}

const FACTS_LIMIT = 512

export class ParagraphScanner {
	private readonly context: DocxEditContext
	private readonly formats: FormatResolver
	private readonly checker: SpellingChecker
	private readonly options: ScanOptions
	// Run facts by marks (a text node's mark set), the last few hundred: a plain map (no weak references to
	// trace), emptied when full.
	private readonly facts = new Map<readonly Mark[], { readonly paragraph: ParagraphFormat; readonly facts: RunFacts }>()
	private readonly dictionaries = new Map<string, string | undefined>()

	constructor(context: DocxEditContext, part: StoryPart, checker: SpellingChecker, options: ScanOptions) {
		this.context = context
		this.formats = new FormatResolver(context, part)
		this.checker = checker
		this.options = options
	}

	private dictionaryFor(language: string): string | undefined {
		if (this.dictionaries.has(language)) return this.dictionaries.get(language)

		const dictionary = this.checker.dictionaryFor(language)

		this.dictionaries.set(language, dictionary)

		return dictionary
	}

	private runFacts(paragraph: ParagraphFormat, marksOf: readonly Mark[]): RunFacts {
		const cached = this.facts.get(marksOf)

		if (cached !== undefined && cached.paragraph === paragraph) return cached.facts

		let facts: RunFacts

		if (marks.deletion.isInSet(marksOf) !== undefined || marks.move_from.isInSet(marksOf) !== undefined) {
			facts = SKIPPED
		} else {
			const style = this.formats.styleRun(paragraph, marksOf)
			const base = marks.run.isInSet(marksOf)?.attrs["base"] as number | undefined
			const props = base === undefined ? undefined : this.context.bases.get(base)?.props
			// Cleared direct formatting keeps only the base's script flags (as formatting does).
			const direct = marks.plain.isInSet(marksOf) === undefined ? props : undefined
			const lang = marks.lang.isInSet(marksOf)?.attrs as
				{ latin: string | null; eastAsia: string | null; bidi: string | null } | undefined

			facts = {
				skip: (direct?.noProof ?? style.noProof) || (direct?.vanish ?? style.vanish) || (direct?.specVanish ?? style.specVanish),
				complex: style.rtl || style.cs || props?.rtl === true || props?.cs === true,
				latin: lang?.latin ?? style.lang.latin,
				eastAsia: lang?.eastAsia ?? style.lang.eastAsia,
				bidi: lang?.bidi ?? style.lang.bidi
			}
		}

		if (this.facts.size >= FACTS_LIMIT) this.facts.clear()

		this.facts.set(marksOf, { paragraph, facts })

		return facts
	}

	// The issues of a paragraph by the verdicts known now; words without one are added to `unknown`
	// (dictionary -> words) for the caller to check.
	scan(
		paragraph: Node,
		ignored: ReadonlySet<string>,
		ignoredRepeats: ReadonlySet<string>,
		unknown: Map<string, Set<string>>
	): ParagraphScan {
		const format = this.formats.paragraph(paragraph)
		const runStarts: number[] = []
		const runFacts: RunFacts[] = []
		let text = ""

		paragraph.forEach(child => {
			if (child.isText) {
				runStarts.push(text.length)
				runFacts.push(this.runFacts(format, child.marks))
				text += child.text ?? ""
			} else if (child.type === nodes.hyphen) {
				text += child.attrs["soft"] === true ? SOFT_HYPHEN : "‑"
			} else if (child.type === nodes.tab) {
				text += "\t"
			} else if (child.type === nodes.break) {
				text += "\n"
			} else if (
				child.type === nodes.marker ||
				child.type === nodes.proof_err ||
				child.type === nodes.comment_ref ||
				child.type === nodes.rendered_break
			) {
				text += ZERO_WIDTH
			} else {
				text += OBJECT
			}
		})

		const issues: RelativeIssue[] = []

		if (runStarts.length === 0) return { issues, complete: true }

		const options = this.options
		const addresses = options.ignoreAddresses ? addressSpans(text) : []
		const collect = (dictionary: string, word: string): void => {
			let words = unknown.get(dictionary)

			if (words === undefined) {
				words = new Set()
				unknown.set(dictionary, words)
			}

			words.add(word)
		}
		let run = 0
		let address = 0
		let complete = true
		// The previous word (lower case) and where it ended, for repeated words.
		let previous: string | undefined
		let previousEnd = 0

		wordSegments(text, (start, end, flags) => {
			if ((flags & WORD_LETTER) === 0) {
				if (!spacesOnly(text, start, end)) previous = undefined

				return
			}

			while (run + 1 < runStarts.length && (runStarts[run + 1] ?? 0) <= start) run++

			const facts = runStarts[run] !== undefined && (runStarts[run] ?? 0) <= start ? (runFacts[run] ?? SKIPPED) : SKIPPED

			if (facts.skip) {
				previous = undefined

				return
			}

			let word = text.slice(start, end)

			if (word.includes(ZERO_WIDTH) || word.includes(SOFT_HYPHEN)) word = word.replace(INVISIBLE, "")

			const cp = word.codePointAt(0) ?? 0
			const slot = facts.complex ? SLOT_COMPLEX : scriptSlot(cp)
			const language =
				(slot === SLOT_COMPLEX ? facts.bidi : slot === SLOT_EAST_ASIA ? facts.eastAsia : facts.latin) ?? options.defaultLanguage

			if (options.flagRepeated) {
				const lower = word.toLowerCase()
				const repeated = previous === lower && spacesOnly(text, previousEnd, start) && !ignoredRepeats.has(lower)

				previous = lower
				previousEnd = end

				if (repeated) {
					const dictionary = language === undefined ? undefined : this.dictionaryFor(language)

					issues.push({ from: start, to: end, kind: "repeated", word, language: language ?? "", dictionary: dictionary ?? "" })

					return
				}
			}

			if ((flags & WORD_KANA) !== 0) return
			if (options.ignoreWordsWithNumbers && (flags & WORD_NUMBER) !== 0) return
			if (options.ignoreUppercase && (flags & WORD_UPPER) !== 0 && (flags & WORD_LOWER) === 0) return
			// Internal dots and underscores: abbreviations (e.g), domain names, identifiers.
			if (word.length > MAX_WORD_LENGTH || word.includes(".") || word.includes("_")) return

			while (address < addresses.length && (addresses[address + 1] ?? 0) <= start) address += 2

			if (address < addresses.length && (addresses[address] ?? 0) < end) return
			const query = spellingQuery(word)

			if (language === undefined || ignored.has(query)) return

			const dictionary = this.dictionaryFor(language)

			if (dictionary === undefined) return

			// Dictionaries list abbreviations with their period ("etc."): a word before a period may be one.
			const dotted = text.charCodeAt(end) === 0x2e
			let correct = this.checker.known(dictionary, query)

			if (correct === false && dotted) correct = this.checker.known(dictionary, `${query}.`)

			if (correct === undefined) {
				collect(dictionary, query)

				if (dotted) collect(dictionary, `${query}.`)

				complete = false
			} else if (!correct) {
				issues.push({ from: start, to: end, kind: "spelling", word, language, dictionary })
			}
		})

		return { issues, complete }
	}
}
