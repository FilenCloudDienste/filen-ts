import { hasSwitch, parseFieldCode } from "../../core/docx/fields/code"
import { Item, RevisionView, SOURCE_MAP_INTS, type DocxModel, type StoryPart } from "../../core/docx/index"
import type { DocxLinkTarget } from "./protocol"

// Hyperlinks of a laid-out paragraph as ranges of its text: w:hyperlink content, a HYPERLINK field's result
// and a REF, PAGEREF or NOTEREF \h field's result. A layout that places links records, for the paragraphs
// holding one, where each item's content landed in the text (linkMapParagraph), and each link covers exactly
// what its items laid out, generated text (list markers, computed fields) included. Without that map a link
// is found by its own text, and left out where that text is missing or occurs more than once, never placed
// on the wrong words.

export interface LinkRange {
	readonly start: number
	readonly end: number
	readonly target: DocxLinkTarget
}

const QUOTED = /"([^"]*)"|(\S+)/g

// HYPERLINK "url" \l "anchor" \o "tooltip" (ECMA-376 §17.16.5.25).
export function parseHyperlinkField(instruction: string): DocxLinkTarget | undefined {
	const body = /^\s*HYPERLINK\b(.*)$/is.exec(instruction)?.[1]

	if (body === undefined) return undefined

	let href: string | undefined
	let anchor: string | undefined
	let tooltip: string | undefined
	let pending: "l" | "o" | "skip" | undefined

	for (const match of body.matchAll(QUOTED)) {
		const value = match[1] ?? match[2] ?? ""

		if (match[1] === undefined && value.startsWith("\\")) {
			const name = value.slice(1, 2).toLowerCase()

			pending = name === "l" ? "l" : name === "o" ? "o" : name === "m" || name === "n" ? undefined : "skip"

			continue
		}

		if (pending === "l") anchor = value
		else if (pending === "o") tooltip = value
		else if (pending === undefined && href === undefined) href = value

		pending = undefined
	}

	if (anchor !== undefined && anchor.length > 0) return { kind: "internal", anchor, tooltip }
	if (href !== undefined && href.length > 0) return { kind: "external", href, tooltip }

	return undefined
}

function hyperlinkTarget(part: StoryPart, item: number): DocxLinkTarget | undefined {
	const link = part.hyperlink(item)

	if (link.anchor !== undefined && link.anchor.length > 0) return { kind: "internal", anchor: link.anchor, tooltip: link.tooltip }

	// Only external relationships are links; an internal part target is never navigated to.
	if (link.external && link.target !== undefined && link.target.length > 0) {
		const href = link.docLocation === undefined || link.docLocation.length === 0 ? link.target : `${link.target}#${link.docLocation}`

		return { kind: "external", href, tooltip: link.tooltip }
	}

	return undefined
}

// The text of a field's result (between its separate and end characters) as layout shows it.
function fieldResult(part: StoryPart, separate: number, end: number, view: RevisionView): string {
	let out = ""

	for (let item = separate + 1; item < end; item++) {
		const kind = part.kinds[item] ?? 0

		if (part.hidden(item, view)) {
			item = part.end(item) - 1

			continue
		}

		if (kind === Item.Text) out += part.text(item)
		else if (kind === Item.Tab) out += "\t"
	}

	return out
}

const CROSS_REFERENCES: ReadonlySet<string> = new Set(["REF", "PAGEREF", "NOTEREF"])

// REF, PAGEREF or NOTEREF with \h: a link to its bookmark (ECMA-376 §17.16.5.51, §17.16.5.45, §17.16.5.40).
export function crossReferenceTarget(instruction: string): DocxLinkTarget | undefined {
	const code = parseFieldCode(instruction)

	if (!CROSS_REFERENCES.has(code.type) || !hasSwitch(code, "h")) return undefined

	const anchor = code.args[0]

	return anchor === undefined || anchor.length === 0 ? undefined : { kind: "internal", anchor, tooltip: undefined }
}

function fieldTarget(instruction: string): DocxLinkTarget | undefined {
	return parseHyperlinkField(instruction) ?? crossReferenceTarget(instruction)
}

// A source's item map (PageDisplayList.sourceMapPool): SOURCE_MAP_INTS per laid-out item in [start, end).
export interface LinkMap {
	readonly pool: Int32Array
	readonly start: number
	readonly end: number
}

export function sourceLinkMap(
	page: { readonly sourceMapPool: Int32Array; readonly sourceMapRanges: Int32Array },
	source: number
): LinkMap | undefined {
	const start = page.sourceMapRanges[source * 2] ?? 0
	const end = page.sourceMapRanges[source * 2 + 1] ?? 0

	return end > start ? { pool: page.sourceMapPool, start, end } : undefined
}

interface Candidate {
	readonly at: number
	// The items the link spans, [from, to).
	readonly from: number
	readonly to: number
	readonly text: string
	readonly target: DocxLinkTarget
}

// Paragraphs (and the paragraphs around them) holding a link, per part and view, built once.
const linkIndex = new WeakMap<StoryPart, Map<RevisionView, Set<number>>>()

function addParagraphs(part: StoryPart, item: number, out: Set<number>): void {
	for (let at = item; at >= 0; at = part.parent(at)) if (part.kinds[at] === Item.Paragraph) out.add(at)
}

function linkParagraphs(part: StoryPart, view: RevisionView): Set<number> {
	let byView = linkIndex.get(part)
	let found = byView?.get(view)

	if (found !== undefined) return found

	found = new Set()

	const kinds = part.kinds

	for (let item = 0; item < part.count; item++) if (kinds[item] === Item.Hyperlink) addParagraphs(part, item, found)

	const fields = part.fields

	for (let field = 0; field < fields.count; field++) {
		const begin = fields.begin[field] ?? -1

		if (begin >= 0 && fieldTarget(part.fieldInstruction(field, view)) !== undefined) addParagraphs(part, begin, found)
	}

	if (byView === undefined) {
		byView = new Map()
		linkIndex.set(part, byView)
	}

	byView.set(view, found)

	return found
}

// LayoutOptions.mapParagraph for a layout whose links are placed (paragraphLinks with the source's map).
export function linkMapParagraph(view: RevisionView): (part: StoryPart, paragraph: number) => boolean {
	return (part, paragraph) => linkParagraphs(part, view).has(paragraph)
}

// Fields of a part indexed by the paragraph their begin character sits in, built once per part.
const fieldIndex = new WeakMap<StoryPart, Map<number, number[]>>()

function paragraphOf(part: StoryPart, item: number): number {
	for (let at = item; at >= 0; at = part.parent(at)) {
		if (part.kinds[at] === Item.Paragraph) return at
	}

	return -1
}

function fieldsByParagraph(part: StoryPart): Map<number, number[]> {
	let index = fieldIndex.get(part)

	if (index === undefined) {
		index = new Map()

		const fields = part.fields

		for (let field = 0; field < fields.count; field++) {
			const begin = fields.begin[field] ?? -1

			if (begin < 0) continue

			const paragraph = paragraphOf(part, begin)
			const list = index.get(paragraph)

			if (list === undefined) index.set(paragraph, [field])
			else list.push(field)
		}

		fieldIndex.set(part, index)
	}

	return index
}

// The text range the candidate's items laid out in, from the source's map; undefined when they laid out nothing.
function mappedRange(map: LinkMap, part: number, candidate: Candidate): { start: number; end: number } | undefined {
	const pool = map.pool
	let start = -1
	let end = -1

	for (let at = map.start; at + SOURCE_MAP_INTS <= map.end; at += SOURCE_MAP_INTS) {
		const item = pool[at + 1] ?? -1

		if (pool[at] !== part || item < candidate.from || item >= candidate.to) continue

		const from = pool[at + 2] ?? 0
		const to = pool[at + 3] ?? 0

		if (start < 0 || from < start) start = from
		if (to > end) end = to
	}

	return start >= 0 && end > start ? { start, end } : undefined
}

// Without a map: the link's own text where it occurs exactly once in the paragraph's text.
function searchedRange(text: string, needle: string): { start: number; end: number } | undefined {
	if (needle.trim().length === 0) return undefined

	const at = text.indexOf(needle)

	if (at < 0 || text.indexOf(needle, at + 1) >= 0) return undefined

	return { start: at, end: at + needle.length }
}

// `map`: the source's item map (sourceLinkMap), which places each link on exactly the text its items laid out.
// Without one a link is placed by its text, and only where that text is unambiguous.
export function paragraphLinks(part: StoryPart, paragraph: number, text: string, view: RevisionView, map?: LinkMap): LinkRange[] {
	if (!linkParagraphs(part, view).has(paragraph)) return []

	const candidates: Candidate[] = []
	const end = part.end(paragraph)

	for (let item = paragraph + 1; item < end; item++) {
		if (part.kinds[item] !== Item.Hyperlink) continue

		const target = hyperlinkTarget(part, item)

		if (target !== undefined)
			candidates.push({
				at: item,
				from: item,
				to: part.end(item),
				text: map === undefined ? part.paragraphText(item, view) : "",
				target
			})
	}

	const fields = part.fields

	for (const field of fieldsByParagraph(part).get(paragraph) ?? []) {
		const instruction = part.fieldInstruction(field, view)
		const hyperlink = parseHyperlinkField(instruction)
		const target = hyperlink ?? crossReferenceTarget(instruction)

		if (target === undefined) continue

		const begin = fields.begin[field] ?? -1
		const separate = fields.separate[field] ?? -1
		const fieldEnd = fields.end[field] ?? -1
		const simple = fields.simple[field] === 1
		const to = simple ? part.end(begin) : fieldEnd + 1

		// A cross-reference inside a link (a TOC entry's page number) is that link's, not a second one.
		if (hyperlink === undefined && candidates.some(other => begin > other.from && begin < other.to)) continue

		const result =
			map !== undefined
				? ""
				: simple
					? part.paragraphText(begin, view)
					: separate >= 0 && fieldEnd > separate
						? fieldResult(part, separate, fieldEnd, view)
						: ""

		candidates.push({ at: begin, from: begin, to: to > begin ? to : begin + 1, text: result, target })
	}

	if (candidates.length === 0) return []

	candidates.sort((a, b) => a.at - b.at)

	const out: LinkRange[] = []

	for (const candidate of candidates) {
		const range = map === undefined ? searchedRange(text, candidate.text) : mappedRange(map, part.index, candidate)

		if (range !== undefined) out.push({ start: range.start, end: range.end, target: candidate.target })
	}

	return out
}

// Bookmark name -> where it starts, built once per model.
export function bookmarkIndex(model: DocxModel): Map<string, { part: number; item: number }> {
	const out = new Map<string, { part: number; item: number }>()

	model.parts.forEach((part: StoryPart | undefined, partIndex) => {
		// An editing layout's model drops the parts edits replaced.
		if (part === undefined) return

		for (let row = 0; row < part.bookmarks.count; row++) {
			const item = part.bookmarks.start[row] ?? -1
			const name = part.bookmarkName(row)

			if (item >= 0 && name !== undefined && !out.has(name)) out.set(name, { part: partIndex, item })
		}
	})

	return out
}

export { paragraphOf }
