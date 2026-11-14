import type * as Mupdf from "mupdf"
import {
	foldCase,
	isSearchableTerm,
	matchPreset,
	matchTerm,
	type RedactionFinding,
	type RedactionQuery,
	type RedactQuad,
	type TextMatch
} from "../../../core/pdfedit/redactVerify"
import { markText } from "./marks"

// Find and redact: literal terms (case and whole-word options; no patterns) and presets searched in each page's
// structured text, as the review list; marking the kept findings creates text marks.

export type { RedactionQuery }

// A page's text as one string, with the quad of each UTF-16 unit (null for the separators added between lines and
// blocks). Lines of one block join with a space, so a term wrapped across lines is found; blocks with a newline.
export interface PageText {
	readonly text: string
	readonly quads: readonly (RedactQuad | null)[]
}

export function pageText(page: Mupdf.PDFPage): PageText {
	const stext = page.toStructuredText("")
	const quads: (RedactQuad | null)[] = []
	let text = ""
	let lineStart = true
	let blockStart = true

	stext.walk({
		beginTextBlock: () => {
			if (!blockStart) {
				text += "\n"
				quads.push(null)
			}

			blockStart = true
		},
		beginLine: () => {
			lineStart = true
		},
		onChar: (char, _origin, _font, _size, quad) => {
			if (lineStart && !blockStart && !/\s$/.test(text)) {
				text += " "
				quads.push(null)
			}

			lineStart = false
			blockStart = false
			text += char

			for (let unit = 0; unit < char.length; unit++) quads.push(quad)
		}
	})
	stext.destroy()

	return { text, quads }
}

const sameLine = (left: RedactQuad, right: RedactQuad): boolean =>
	Math.abs(left[1] - right[1]) < 0.5 && Math.abs(left[5] - right[5]) < 0.5 && left[0] <= right[0] + 0.5

// The quads of a match: consecutive characters of one line merge into one quad from the first's left edge to the
// last's right edge.
export function matchQuads(text: PageText, match: TextMatch): RedactQuad[] {
	const out: RedactQuad[] = []
	let current: RedactQuad | null = null

	for (let index = match.start; index < match.end; index++) {
		const quad = text.quads[index]

		if (quad === null || quad === undefined) continue
		if (current !== null && sameLine(current, quad)) {
			current = [current[0], current[1], quad[2], quad[3], current[4], current[5], quad[6], quad[7]]
		} else {
			if (current !== null) out.push(current)

			current = quad
		}
	}

	if (current !== null) out.push(current)

	return out
}

// Every finding on the given pages (all pages when omitted), page by page in reading order. Read-only.
export function findRedactions(document: Mupdf.PDFDocument, query: RedactionQuery, pages?: readonly number[]): RedactionFinding[] {
	const findings: RedactionFinding[] = []
	const terms = query.terms.map((term, index) => ({ term, index })).filter(({ term }) => isSearchableTerm(term.text))
	const indices = pages ?? Array.from({ length: document.countPages() }, (_, index) => index)

	for (const pageIndex of indices) {
		const page = document.loadPage(pageIndex)
		const text = pageText(page)
		const folded = foldCase(text.text)
		const hits: { readonly match: TextMatch; readonly source: RedactionFinding["source"] }[] = []

		page.destroy()

		for (const { term, index } of terms) {
			for (const match of matchTerm(text.text, term, folded)) hits.push({ match, source: { kind: "term", index } })
		}
		for (const preset of query.presets) {
			for (const match of matchPreset(text.text, preset)) hits.push({ match, source: { kind: "preset", preset } })
		}

		hits.sort((left, right) => left.match.start - right.match.start || right.match.end - left.match.end)
		hits.forEach(({ match, source }, index) => {
			const quads = matchQuads(text, match)

			if (quads.length > 0) {
				findings.push({
					id: `${String(pageIndex)}:${String(index)}`,
					page: pageIndex,
					text: text.text.slice(match.start, match.end),
					quads,
					source
				})
			}
		})
	}

	return findings
}

// Marks the findings (one text mark each). Returns the touched page indices.
export function markFindings(document: Mupdf.PDFDocument, findings: readonly RedactionFinding[]): number[] {
	const byPage = new Map<number, RedactionFinding[]>()

	for (const finding of findings) {
		const list = byPage.get(finding.page)

		if (list === undefined) byPage.set(finding.page, [finding])
		else list.push(finding)
	}

	for (const [pageIndex, list] of byPage) {
		const page = document.loadPage(pageIndex)

		for (const finding of list) markText(page, finding.quads)

		page.destroy()
	}

	return [...byPage.keys()].sort((left, right) => left - right)
}
