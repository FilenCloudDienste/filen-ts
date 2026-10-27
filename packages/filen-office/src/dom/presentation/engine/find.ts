import { parseDataModel, SmartArtError } from "../../../core/smartart/data"
import { partKey, sliceClock, type SliceClock } from "../../../core/opc/index"
import { matcherOf, matchesIn, paragraphMatches, type Matcher } from "../../../core/presentation/edit/find"
import { PresentationError, type Deck, type ShapeNode, type SlideNode, type TextBody } from "../../../core/presentation/model"
import {
	FIND_IN_NOTES,
	FIND_IN_SMARTART,
	FIND_IN_TABLE,
	FIND_LOCKED,
	PRESENTATION_FIND_INTS,
	PRESENTATION_FIND_LIMIT,
	type FindOptions
} from "../protocol"
import type { CallContext, FindCapability } from "../engine"
import { viewParts, type ViewParts } from "./view"

// Find across the deck, slide by slide in deck order. Per match, PRESENTATION_FIND_INTS ints: the slide's index in the
// deck, the shape's id, the paragraph, the match's start and end in that paragraph's find text (core edit/find.ts),
// and FIND_IN_* flags (FIND_LOCKED: the shape is locked, so the match is never replaced). Within a slide: its shapes back to front, groups entered in place; then its notes body (flag
// FIND_IN_NOTES, the shape id is the notes body's, the slide index is the slide's: a text.replace target names the
// slide's ref with `notes: true`). In a table (FIND_IN_TABLE) the paragraph counts the table's paragraphs across its
// cells in row-major order (edit/find.ts tableParagraph turns it into a cell). In SmartArt (FIND_IN_SMARTART) the
// shape is the diagram's frame and the paragraph is the index of the text-bearing point (node and assistant points in
// data order); its find text is the point's paragraphs joined by "\n". Slides are parsed as they are reached, and the
// search yields to the scheduler between slides once its slice is used.

const ALL_SCOPES: ReadonlySet<NonNullable<FindOptions["scope"]>[number]> = new Set(["slides", "notes", "tables", "smartart"])

class Results {
	private ints = new Int32Array(PRESENTATION_FIND_INTS * 64)
	count = 0
	private readonly limit: number

	constructor(limit: number) {
		this.limit = limit
	}

	get full(): boolean {
		return this.count > this.limit
	}

	push(slide: number, shape: number, paragraph: number, start: number, end: number, flags: number): boolean {
		const at = this.count * PRESENTATION_FIND_INTS

		if (at + PRESENTATION_FIND_INTS > this.ints.length) {
			const grown = new Int32Array(this.ints.length * 2)

			grown.set(this.ints)
			this.ints = grown
		}

		this.ints[at] = slide
		this.ints[at + 1] = shape
		this.ints[at + 2] = paragraph
		this.ints[at + 3] = start
		this.ints[at + 4] = end
		this.ints[at + 5] = flags
		this.count++

		return !this.full
	}

	finish(): Int32Array {
		return this.ints.slice(0, this.count * PRESENTATION_FIND_INTS)
	}
}

interface Search {
	readonly matcher: Matcher
	readonly results: Results
	readonly scopes: ReadonlySet<string>
	readonly parts: ViewParts | undefined
	readonly clock: SliceClock
	// SmartArt data part → its text-bearing points' texts (one search reads each data part once).
	readonly diagrams: Map<string, readonly string[]>
}

function searchBody(search: Search, body: TextBody, slide: number, shape: number, flags: number, base = 0): boolean {
	const paragraphs = body.paragraphs

	for (let p = 0; p < paragraphs.length; p++) {
		const paragraph = paragraphs[p]

		if (paragraph === undefined) continue

		paragraphMatches(paragraph, search.matcher, (start, end) => search.results.push(slide, shape, base + p, start, end, flags))

		if (search.results.full) return false
	}

	return true
}

const TEXT_POINTS: ReadonlySet<string> = new Set(["node", "asst"])

// The texts of a diagram's node and assistant points in data order; empty when the data part cannot be read.
async function diagramTexts(search: Search, part: string): Promise<readonly string[]> {
	const held = search.diagrams.get(part)

	if (held !== undefined) return held

	let texts: string[] = []
	const parts = search.parts

	if (parts !== undefined) {
		try {
			const key = partKey(part)
			const document = parts.document(part) ?? (parts.opc.has(key) ? await parts.opc.xml(key, search.clock) : undefined)
			const model = document === undefined ? undefined : parseDataModel(document)

			if (model !== undefined) {
				texts = []

				for (const point of model.points.values()) {
					if (TEXT_POINTS.has(point.type)) texts.push(point.paragraphs.join("\n"))
				}
			}
		} catch (error) {
			// A data part that does not read has no text to find (the render shows its cache or a refusal).
			if (!(error instanceof SmartArtError) && !(error instanceof PresentationError)) throw error

			texts = []
		}
	}

	search.diagrams.set(part, texts)

	return texts
}

async function searchShapes(search: Search, shapes: readonly ShapeNode[], slide: number): Promise<boolean> {
	for (const shape of shapes) {
		if (shape.children !== undefined && !(await searchShapes(search, shape.children, slide))) return false

		const frame = shape.frame
		// A locked shape's matches are found and flagged: no edit may replace them.
		const locked = shape.lock === undefined ? 0 : FIND_LOCKED

		if (shape.text !== undefined && search.scopes.has("slides") && !searchBody(search, shape.text, slide, shape.id, locked))
			return false

		if (frame?.kind === "table" && search.scopes.has("tables")) {
			let base = 0

			for (const row of frame.table.rows) {
				for (const cell of row.cells) {
					if (!searchBody(search, cell.text, slide, shape.id, FIND_IN_TABLE | locked, base)) return false

					base += cell.text.paragraphs.length
				}
			}
		} else if (frame?.kind === "smartart" && search.scopes.has("smartart")) {
			const texts = await diagramTexts(search, frame.data)

			for (let index = 0; index < texts.length; index++) {
				matchesIn(texts[index] ?? "", search.matcher, (start, end) =>
					search.results.push(slide, shape.id, index, start, end, FIND_IN_SMARTART | locked)
				)

				if (search.results.full) return false
			}
		}
	}

	return true
}

async function slideNode(deck: Deck, parts: ViewParts | undefined, index: number, clock: SliceClock): Promise<SlideNode | undefined> {
	const ref = deck.slides[index]

	if (ref === undefined) return undefined

	return deck.nodes.get(ref) ?? (parts === undefined ? undefined : await parts.slide(ref, clock))
}

export async function findInDeck(context: CallContext, query: string, options: FindOptions = {}): Promise<Int32Array> {
	const matcher = matcherOf({ query, ...options })
	const limit = Math.max(0, Math.trunc(options.limit ?? PRESENTATION_FIND_LIMIT))
	const results = new Results(limit)

	if (matcher === undefined) return results.finish()

	const deck = context.session.deck
	const search: Search = {
		matcher,
		results,
		scopes: options.scope === undefined ? ALL_SCOPES : new Set(options.scope),
		parts: viewParts(deck),
		clock: sliceClock(context.slicing),
		diagrams: new Map()
	}

	// The slide list is read again after each pause: an edit in between may have added or removed slides.
	for (let index = 0; index < deck.slides.length; index++) {
		if (context.signal.aborted) throw new PresentationError("aborted", "find")
		if (search.clock.due) await search.clock.pause()

		const node = await slideNode(deck, search.parts, index, search.clock)

		if (node === undefined) continue
		if (!(await searchShapes(search, node.shapes, index))) break

		if (search.scopes.has("notes") && node.notes !== undefined) {
			const notes = deck.nodes.get(node.notes)
			let stopped = false

			for (const shape of notes?.shapes ?? []) {
				if (shape.ph?.type !== "body" || shape.text === undefined) continue

				if (!searchBody(search, shape.text, index, shape.id, FIND_IN_NOTES | (shape.lock === undefined ? 0 : FIND_LOCKED))) {
					stopped = true
					break
				}
			}

			if (stopped) break
		}
	}

	return results.finish()
}

export const findCapability: FindCapability = {
	find: (context, query, options) => findInDeck(context, query, options)
}
