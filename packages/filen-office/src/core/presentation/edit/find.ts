import type { Paragraph, Run, TextBody } from "../model"

// Find and replace over DrawingML text bodies. A paragraph's find text is its runs' text in order (a:br as "\n", a
// field as the text the file shows, content kept as source as its text); offsets of a match are in that text.
// Matches lie inside runs of plain text (a:r): a match never takes in a break, a field or kept content, so replacing
// one never deletes them (PowerPoint's Replace leaves fields alone the same way). Case-insensitive matching folds
// each UTF-16 unit on its own (lengths never change, so offsets hold), and a whole word is one with no letter,
// digit or underscore on either side.

export interface FindQuery {
	readonly query: string
	readonly caseSensitive?: boolean
	readonly wholeWord?: boolean
}

export interface Matcher {
	readonly needle: string
	readonly caseSensitive: boolean
	readonly wholeWord: boolean
}

// Matches of one query stop at this many per body (hostile bodies; the deck-wide limit is the caller's).
export const MAX_BODY_MATCHES = 100_000

const WORD = /[\p{L}\p{N}_]/u

export function matcherOf(query: FindQuery): Matcher | undefined {
	if (query.query.length === 0) return undefined

	const caseSensitive = query.caseSensitive === true

	return { needle: caseSensitive ? query.query : fold(query.query), caseSensitive, wholeWord: query.wholeWord === true }
}

// Lower case unit by unit, offsets kept: the whole string at once when that keeps its length (no unit expands, the
// common case), else each unit that folds to one unit. Final sigma folds as sigma, so a query matches either form.
export function fold(text: string): string {
	const lower = text.toLowerCase()

	if (lower.length === text.length) return lower.includes("ς") ? lower.replaceAll("ς", "σ") : lower

	let out = ""

	for (let i = 0; i < text.length; i++) {
		const unit = text[i] ?? ""
		const folded = unit.toLowerCase()

		out += folded.length === 1 ? (folded === "ς" ? "σ" : folded) : unit
	}

	return out
}

function wordAt(text: string, index: number): boolean {
	if (index < 0 || index >= text.length) return false

	const code = text.charCodeAt(index)

	// A surrogate pair is tested whole.
	if (code >= 0xdc00 && code <= 0xdfff && index > 0) return WORD.test(text.slice(index - 1, index + 1))
	if (code >= 0xd800 && code <= 0xdbff) return WORD.test(text.slice(index, index + 2))

	return WORD.test(text[index] ?? "")
}

// Matches of `matcher` in `text` (non-overlapping, left to right), as [start, end) offsets in `text`.
export function matchesIn(text: string, matcher: Matcher, visit: (start: number, end: number) => boolean): void {
	matchesInRange(text, matcher.caseSensitive ? text : fold(text), matcher, 0, text.length, visit)
}

// Matches inside [from, to) of `text` (`haystack` is it folded when the matcher is case-insensitive); the range's
// edges count as word boundaries. Returns false when `visit` stopped.
function matchesInRange(
	text: string,
	haystack: string,
	matcher: Matcher,
	from: number,
	to: number,
	visit: (start: number, end: number) => boolean
): boolean {
	const length = matcher.needle.length

	for (let at = from; at <= to - length;) {
		const found = haystack.indexOf(matcher.needle, at)

		if (found < 0 || found + length > to) return true

		const end = found + length

		if (matcher.wholeWord && ((found > from && wordAt(text, found - 1)) || (end < to && wordAt(text, end)))) {
			at = found + 1
			continue
		}

		if (!visit(found, end)) return false

		at = end
	}

	return true
}

// A paragraph's find text.
export function findText(paragraph: Paragraph): string {
	let text = ""

	for (const run of paragraph.runs) text += run.kind === "br" ? "\n" : run.text

	return text
}

// The stretches of a paragraph's find text that are plain text runs: [start, end) pairs, flattened.
function textStretches(paragraph: Paragraph): number[] {
	const out: number[] = []
	let offset = 0
	let open = -1

	for (const run of paragraph.runs) {
		const length = run.kind === "br" ? 1 : run.text.length

		if (run.kind === "r") {
			if (open < 0) open = offset
		} else if (open >= 0) {
			out.push(open, offset)
			open = -1
		}

		offset += length
	}

	if (open >= 0) out.push(open, offset)

	return out
}

// Matches in one paragraph, in its find text's offsets. The text is built and folded once; a paragraph whose text is
// shorter than the query is skipped before either.
export function paragraphMatches(paragraph: Paragraph, matcher: Matcher, visit: (start: number, end: number) => boolean): void {
	const runs = paragraph.runs
	let length = 0
	let plain = true

	for (const run of runs) {
		length += run.kind === "br" ? 1 : run.text.length

		if (run.kind !== "r") plain = false
	}

	if (length < matcher.needle.length) return

	const text = runs.length === 1 && runs[0]?.kind === "r" ? runs[0].text : findText(paragraph)
	const haystack = matcher.caseSensitive ? text : fold(text)

	if (plain) {
		matchesInRange(text, haystack, matcher, 0, text.length, visit)

		return
	}

	const stretches = textStretches(paragraph)

	for (let i = 0; i < stretches.length; i += 2) {
		if (!matchesInRange(text, haystack, matcher, stretches[i] ?? 0, stretches[i + 1] ?? 0, visit)) return
	}
}

// Every match in a body: paragraph index, start, end. `visit` returning false stops.
export function bodyMatches(body: TextBody, matcher: Matcher, visit: (paragraph: number, start: number, end: number) => boolean): void {
	let going = true
	let count = 0

	for (let p = 0; p < body.paragraphs.length && going; p++) {
		paragraphMatches(body.paragraphs[p] as Paragraph, matcher, (start, end) => {
			going = visit(p, start, end) && ++count < MAX_BODY_MATCHES

			return going
		})
	}
}

// `paragraph` with find-text range [start, end) (inside plain text runs) replaced by `replacement`, which takes the
// run properties of the range's first character.
export function replaceRange(paragraph: Paragraph, start: number, end: number, replacement: string): Paragraph {
	const runs: Run[] = []
	let offset = 0
	let placed = false

	for (const run of paragraph.runs) {
		const length = run.kind === "br" ? 1 : run.text.length
		const runStart = offset
		const runEnd = offset + length

		offset = runEnd

		if (run.kind !== "r" || runEnd <= start || runStart >= end) {
			// An empty run at the range's start takes nothing.
			runs.push(run)
			continue
		}

		const keepBefore = run.text.slice(0, Math.max(0, start - runStart))
		const keepAfter = run.text.slice(Math.min(length, end - runStart))
		const text = placed ? keepBefore + keepAfter : keepBefore + replacement + keepAfter

		placed = true

		if (text.length > 0) runs.push({ kind: "r", text, rPr: run.rPr })
	}

	return { ...paragraph, runs }
}

// The body with every match replaced (or only `only`, a match as find reported it: paragraph, start, end), and the
// count replaced; undefined when `only` is no longer a match there.
export function replaceInBody(
	body: TextBody,
	matcher: Matcher,
	replacement: string,
	only?: readonly [number, number, number]
): { readonly body: TextBody; readonly count: number } | undefined {
	const paragraphs = [...body.paragraphs]
	let count = 0

	if (only !== undefined) {
		const [index, start, end] = only
		const paragraph = paragraphs[index]
		let found = false

		if (paragraph !== undefined) {
			paragraphMatches(paragraph, matcher, (s, e) => {
				found = s === start && e === end

				return !found && s <= start
			})
		}

		if (paragraph === undefined || !found) return undefined

		paragraphs[index] = replaceRange(paragraph, start, end, replacement)

		return { body: { ...body, paragraphs }, count: 1 }
	}

	for (let p = 0; p < paragraphs.length; p++) {
		const paragraph = paragraphs[p] as Paragraph
		const ranges: number[] = []

		paragraphMatches(paragraph, matcher, (start, end) => {
			ranges.push(start, end)

			return count + ranges.length / 2 < MAX_BODY_MATCHES
		})

		if (ranges.length === 0) continue

		let next = paragraph

		// Last first, so earlier offsets hold.
		for (let i = ranges.length - 2; i >= 0; i -= 2) next = replaceRange(next, ranges[i] ?? 0, ranges[i + 1] ?? 0, replacement)

		paragraphs[p] = next
		count += ranges.length / 2
	}

	return { body: { ...body, paragraphs }, count }
}

// A table's paragraphs are counted across its cells in row-major order (how find reports a match in a table): the
// cell and the paragraph within it of flat paragraph `index`; undefined past the last.
export function tableParagraph(
	table: { readonly rows: readonly { readonly cells: readonly { readonly text: TextBody }[] }[] },
	index: number
): { readonly row: number; readonly col: number; readonly paragraph: number } | undefined {
	let left = index

	for (let row = 0; row < table.rows.length; row++) {
		const cells = table.rows[row]?.cells ?? []

		for (let col = 0; col < cells.length; col++) {
			const count = cells[col]?.text.paragraphs.length ?? 0

			if (left < count) return { row, col, paragraph: left }

			left -= count
		}
	}

	return undefined
}
