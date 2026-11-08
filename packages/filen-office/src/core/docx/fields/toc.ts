import type { Mark, Node } from "prosemirror-model"
import type { Transaction } from "prosemirror-state"
import type { DocxEditContext } from "../edit/context"
import { NO_MARKERS, NO_SOURCE, docxSchema, markerNodeAttrs, survivorsOf, type MarkerList, type SpacingAttrs } from "../edit/schema"
import type { DocxEditorSession } from "../edit/session"
import { FieldCharType, Item, type StoryPart } from "../model/index"
import { Ns } from "../model/namespaces"
import type { ParagraphProps } from "../props/index"
import { hasStyleDefinition } from "../write/styles"
import { bookmarkIndex, bookmarkNameTaken, hiddenBookmarkName, insertBookmark, type DocxBookmark } from "./bookmarks"
import { hasSwitch, outlineLevels, parseFieldCode, rangeText, switchOf, type FieldCode, type FieldHost } from "./evaluate"

// Tables of contents (ECMA-376 Part 1 §17.16.5.68, TOC): the switches read (\o heading levels, \u outline
// levels, \t styles, \c captions of a SEQ identifier, \b a bookmark's range, \h links, \n levels without page
// numbers, \p the separator before the number, \w and \x tabs and line breaks kept), the headings collected,
// and the entry paragraphs built as Word builds them: styled "toc N", the heading's list number and text in a
// link to a hidden _Toc bookmark at the heading, then a tab and a PAGEREF field. A table spans paragraphs: a
// field_char begin in its first entry and an end in its last (the file's keep their items: edited in place,
// their page numbers updated alone), or, for a table of the file whose structure does not fit, locked blocks.

const nodes = docxSchema.nodes
const marks = docxSchema.marks
// Word's text for a table without entries (en-US).
export const NO_ENTRIES = "No table of contents entries found."
// Word's paragraph style of a table of figures' entries.
const FIGURES_STYLE = "table of figures"
// Word's default table: heading levels 1 to 3, links, no tab leaders in Web view, outline levels.
export function tocInstruction(levels: number, hyperlinks: boolean): string {
	return ` TOC \\o "1-${String(levels)}"${hyperlinks ? " \\h" : ""} \\z \\u `
}

export interface TocOptions {
	// Heading style levels (\o), 1-based inclusive; undefined without \o.
	readonly headings: readonly [number, number] | undefined
	// Paragraph outline levels count (\u).
	readonly outline: boolean
	// Style names (canonical) and the level each gives (\t).
	readonly styles: ReadonlyMap<string, number>
	// Paragraphs holding a SEQ field of this identifier (\c), level 1.
	readonly caption: string | undefined
	readonly hyperlinks: boolean
	// Levels whose entries have no page number (\n); [1, 9] for all.
	readonly omit: readonly [number, number] | undefined
	readonly separator: string | undefined
	readonly bookmark: string | undefined
	readonly keepTabs: boolean
	readonly keepBreaks: boolean
	// Entries this editor cannot collect (TC fields alone, \a): the table is kept as it is.
	readonly supported: boolean
	// A table of figures (\c or \a): its entries take Word's "table of figures" style.
	readonly figures: boolean
	// \z: tab leaders and page numbers hidden in Web layout.
	readonly webHidden: boolean
}

function levelRange(value: string | undefined, fallback: readonly [number, number]): readonly [number, number] {
	const match = value === undefined ? null : /^\s*(\d)\s*-\s*(\d)\s*$/.exec(value)

	if (match === null) {
		const single = Number(value)

		return Number.isInteger(single) && single >= 1 && single <= 9 ? [single, single] : fallback
	}

	const from = Math.max(1, Math.min(9, Number(match[1])))
	const to = Math.max(from, Math.min(9, Number(match[2])))

	return [from, to]
}

export function tocOptions(code: FieldCode): TocOptions {
	const o = switchOf(code, "o")
	const t = switchOf(code, "t")
	const c = switchOf(code, "c")
	const n = switchOf(code, "n")
	const styles = new Map<string, number>()

	if (t?.arg !== undefined) {
		// "Style,level,Style,level" (Word writes the list separator: "," or ";").
		const parts = t.arg.split(/[,;]/).map(part => part.trim())

		// A style without a level is level 1.
		for (let k = 0; k < parts.length; k++) {
			const name = parts[k] ?? ""
			const next = parts[k + 1] ?? ""
			const level = /^[1-9]$/.test(next) ? Number(next) : 1

			if (level === Number(next)) k++
			if (name !== "" && !/^\d+$/.test(name)) styles.set(name.replace(/\s+/g, " ").toLowerCase(), level)
		}
	}

	const outline = hasSwitch(code, "u")
	const headings = o === undefined ? undefined : levelRange(o.arg, [1, 9])
	const caption = c?.arg
	const collects = headings !== undefined || outline || styles.size > 0 || caption !== undefined

	return {
		headings,
		outline,
		styles,
		caption,
		hyperlinks: hasSwitch(code, "h"),
		omit: n === undefined ? undefined : levelRange(n.arg, [1, 9]),
		separator: switchOf(code, "p")?.arg,
		bookmark: switchOf(code, "b")?.arg,
		keepTabs: hasSwitch(code, "w"),
		keepBreaks: hasSwitch(code, "x"),
		supported: code.type === "TOC" && (collects || (!hasSwitch(code, "f") && !hasSwitch(code, "l") && !hasSwitch(code, "a"))),
		figures: caption !== undefined || hasSwitch(code, "a"),
		webHidden: hasSwitch(code, "z")
	}
}

// ---- the tables of a story --------------------------------------------------------------------------------

export interface TocRegion {
	// The blocks [from, to) of the story's document the table's paragraphs are (siblings).
	readonly from: number
	readonly to: number
	readonly instruction: string
	// Kept as the file's locked blocks (else field_char paragraphs).
	readonly source: boolean
	// Whether an update can rebuild it: its blocks hold nothing but the table.
	readonly updatable: boolean
	// The section break one of its blocks carries (the last block's after a rebuild), or NO_SOURCE.
	readonly sectPr: number
	// Range markers and comment references inside its source blocks, which outlive a rebuild.
	readonly markers: MarkerList
	// Per entry level, a source paragraph of the table whose properties a rebuilt entry of that level takes
	// (its style, direct tabs and paragraph mark formatting, as Word keeps them).
	readonly templates: ReadonlyMap<number, number>
	// What a rebuild replaces, [replaceFrom, replaceTo) (else from and to): from after the separate when the first
	// paragraph shows something before the begin (a title, kept with the code in its paragraph, the entries after
	// it), to the end character's paragraph when nothing shows before the end in it (kept whole, as Word keeps
	// the paragraph after the last entry), or to the end character when something shows after it there.
	readonly replaceFrom: number
	readonly replaceTo: number
	// Whether the rebuilt table keeps the begin (and its code) or the end character of the table where they are.
	readonly head: boolean
	readonly tail: "whole" | "open" | undefined
	// Where the separate ends and where the end character is (a table rebuilt while tracking keeps both, its old
	// result recorded deleted between them); -1 for the file's locked blocks.
	readonly codeEnd: number
	readonly endAt: number
	// A table of one paragraph holding nothing but its field, read as one field atom (an empty table, as Word
	// leaves one): that field's position (an update replaces the paragraph whole), else -1.
	readonly atom: number
}

interface SourceToc {
	readonly field: number
	readonly begin: number
	readonly end: number
	readonly first: number
	readonly last: number
	readonly instruction: string
}

const SOURCE_TOCS = new WeakMap<StoryPart, ReadonlyMap<number, SourceToc>>()

function paragraphOf(part: StoryPart, item: number): number {
	for (let at = item; at >= 0; at = part.parent(at)) if (part.kinds[at] === Item.Paragraph) return at

	return -1
}

// The tables of contents of a part that span paragraphs, by the paragraph their begin is in.
function sourceTocs(part: StoryPart): ReadonlyMap<number, SourceToc> {
	let found = SOURCE_TOCS.get(part)

	if (found !== undefined) return found

	const out = new Map<number, SourceToc>()
	const fields = part.fields

	for (let field = 0; field < fields.count; field++) {
		const begin = fields.begin[field] ?? -1
		const end = fields.end[field] ?? -1

		if (fields.simple[field] === 1 || begin < 0 || end < 0 || (fields.parent[field] ?? -1) >= 0) continue

		const first = paragraphOf(part, begin)
		const last = paragraphOf(part, end)

		if (first < 0 || first === last || part.fieldType(field) !== "TOC") continue

		out.set(first, { field, begin, end, first, last, instruction: part.fieldInstruction(field) })
	}

	found = out
	SOURCE_TOCS.set(part, found)

	return found
}

// Kinds that show nothing: what may stand before a table's begin in its first paragraph or after its end in
// its last (a rebuild writes neither).
const BLANK_KINDS: ReadonlySet<number> = new Set<number>([
	Item.Run,
	Item.LastRenderedPageBreak,
	Item.BookmarkStart,
	Item.BookmarkEnd,
	Item.CommentRangeStart,
	Item.CommentRangeEnd,
	Item.PermissionStart,
	Item.PermissionEnd
])

function blank(part: StoryPart, from: number, to: number): boolean {
	for (let item = from; item < to; item++) if (!BLANK_KINDS.has(part.kinds[item] ?? 0)) return false

	return true
}

function blockMarkers(node: Node, out: MarkerList[]): void {
	for (const name of ["before", "markers"]) {
		const list: unknown = node.attrs[name]

		if (Array.isArray(list) && list.length > 0) out.push(list as MarkerList)
	}
}

// The table of contents the file has whose first locked paragraph is `parent`'s child `index`.
function sourceRegion(context: DocxEditContext, part: StoryPart, parent: Node, index: number, pos: number): TocRegion | undefined {
	const first = parent.child(index)
	const toc = sourceTocs(part).get(first.attrs["src"] as number)

	if (toc === undefined) return undefined

	const lists: MarkerList[] = []
	const templates = new Map<number, number>()
	const figures = tocOptions(parseFieldCode(toc.instruction)).figures
	let at = pos
	let sectPr = NO_SOURCE
	let breaks = 0
	let updatable = true

	for (let k = index; k < parent.childCount; k++) {
		const block = parent.child(k)
		const item = block.attrs["src"] as number

		if (block.type !== nodes.locked_block || block.attrs["kind"] !== "paragraph") return undefined

		blockMarkers(block, lists)

		if ((block.attrs["sectPr"] as number) !== NO_SOURCE) {
			sectPr = block.attrs["sectPr"] as number
			breaks++
		}

		const level = tocLevel(context, partStyle(part, item), figures)

		if (level !== undefined && !templates.has(level)) templates.set(level, item)

		at += block.nodeSize

		if (item === toc.last) {
			updatable = breaks <= 1 && rebuildable(part, toc) && tocOptions(parseFieldCode(toc.instruction)).supported

			return {
				from: pos,
				to: at,
				instruction: toc.instruction,
				source: true,
				updatable,
				sectPr,
				markers: lists.length === 0 ? NO_MARKERS : lists.flat(),
				templates,
				replaceFrom: pos,
				replaceTo: at,
				head: false,
				tail: undefined,
				codeEnd: -1,
				endAt: -1,
				atom: -1
			}
		}
	}

	return undefined
}

// The level of a "toc N" paragraph style (by its name, else Word's id "TOCN"); in a table of figures, 1 for its
// "table of figures" style.
function tocLevel(context: DocxEditContext, styleId: string | undefined, figures: boolean): number | undefined {
	if (styleId === undefined) return undefined

	const name = context.styles.byId(styleId)?.canonicalName ?? ""

	if (figures) return name === FIGURES_STYLE || /^tableoffigures$/i.test(styleId) ? 1 : undefined

	const match = /^toc ([1-9])$/.exec(name) ?? /^toc([1-9])$/i.exec(styleId)

	return match === null ? undefined : Number(match[1])
}

// The w:pStyle value of a source paragraph.
function partStyle(part: StoryPart, item: number): string | undefined {
	const row = part.aux[item] ?? -1
	const pPr = row < 0 ? -1 : (part.paragraphs.pPr[row] ?? -1)

	if (pPr < 0) return undefined

	const style = part.reader.child(pPr, Ns.W, "pStyle")

	return style < 0 ? undefined : part.reader.attr(style, Ns.W, "val")
}

// The begin field_char of a table of contents in `paragraph`.
function newBegin(paragraph: Node): Node | undefined {
	let found: Node | undefined

	paragraph.forEach(child => {
		if (found === undefined && child.type === nodes.field_char && child.attrs["kind"] === "begin") found = child
	})

	// One a tracked change deleted (the old table of one rebuilt while tracking) is no table any more.
	return found !== undefined &&
		marks.deletion.isInSet(found.marks) === undefined &&
		marks.move_from.isInSet(found.marks) === undefined &&
		parseFieldCode(found.attrs["instruction"] as string).type === "TOC"
		? found
		: undefined
}

// Inline nodes that show nothing (range markers, comment references, Word's bookkeeping).
const UNSEEN = new Set([nodes.marker, nodes.comment_ref, nodes.proof_err, nodes.rendered_break])

function shows(node: Node): boolean {
	return !UNSEEN.has(node.type)
}

// Where the first paragraph of a table built as paragraphs has its begin, and the separate after it in that
// paragraph (-1 without), as child indexes; whether something shows before the begin.
export function tocHead(paragraph: Node): { readonly begin: number; readonly separate: number; readonly titled: boolean } {
	let begin = -1
	let separate = -1
	let titled = false

	paragraph.forEach((child, _, index) => {
		if (begin < 0) {
			if (child.type === nodes.field_char && child.attrs["kind"] === "begin") begin = index
			else if (shows(child)) titled = true
		} else if (separate < 0 && child.type === nodes.field_char && child.attrs["kind"] === "separate") {
			separate = index
		}
	})

	return { begin, separate, titled }
}

// A table of field_char paragraphs starting in `parent`'s child `index`: up to the paragraph holding its end.
// Its range markers and comment references outlive a rebuild (those of what it replaces); its paragraphs of the
// file give their properties to the rebuilt entries of their levels.
function newRegion(context: DocxEditContext, part: StoryPart, parent: Node, index: number, pos: number): TocRegion | undefined {
	const first = parent.child(index)
	const begin = newBegin(first)

	if (begin === undefined) return undefined

	const head = tocHead(first)
	let depth = 0
	let at = pos
	const blocks: { node: Node; pos: number; end: number }[] = []

	for (let k = index; k < parent.childCount; k++) {
		const block = parent.child(k)

		if (block.type !== nodes.paragraph) return undefined

		let end = -1

		block.forEach((child, _, offset) => {
			if (end >= 0 || child.type !== nodes.field_char) return

			if (child.attrs["kind"] === "begin") depth++
			else if (child.attrs["kind"] === "end" && --depth === 0) end = offset
		})

		blocks.push({ node: block, pos: at, end })
		at += block.nodeSize

		if (end >= 0) break
	}

	const last = blocks[blocks.length - 1]

	if (last === undefined || last.end < 0) return undefined

	const instruction = begin.attrs["instruction"] as string
	const options = tocOptions(parseFieldCode(instruction))
	const spans = blocks.length > 1
	// A title before the begin stays in its paragraph with the code (the code would run over a paragraph mark
	// otherwise: the separate must be there).
	const titled = spans && head.titled
	let tail: "whole" | "open" | undefined

	if (spans) {
		let before = false
		let after = false

		last.node.forEach((child, _, offset) => {
			if (offset < last.end) before ||= shows(child)
			else if (offset > last.end) after ||= shows(child)
		})

		tail = !before ? "whole" : after ? "open" : undefined
	}

	let sectPr = NO_SOURCE
	const lists: MarkerList[] = []
	const templates = new Map<number, number>()
	const offsetOf = (node: Node, child: number): number => {
		let offset = 0

		for (let k = 0; k < child; k++) offset += node.child(k).nodeSize

		return offset
	}

	for (const [k, { node: block, end }] of blocks.entries()) {
		const kept = (k === 0 && titled) || (k === blocks.length - 1 && tail === "whole")
		const item = block.attrs["src"] as number

		if (item !== NO_SOURCE && part.kinds[item] === Item.Paragraph) {
			const level = tocLevel(context, partStyle(part, item), options.figures)

			if (level !== undefined && !templates.has(level)) templates.set(level, item)
		}

		if (k === blocks.length - 1 && tail === "whole") continue
		if (!kept && (block.attrs["sectPr"] as number) !== NO_SOURCE) sectPr = block.attrs["sectPr"] as number
		if (!kept) blockMarkers(block, lists)

		// Of the first paragraph kept, what follows its separate; of the last joined, what precedes its end.
		const from = k === 0 && titled ? head.separate + 1 : 0
		const to = k === blocks.length - 1 && tail === "open" ? end : block.childCount

		for (let child = from; child < to; child++) {
			const markers = survivorsOf(block.child(child))

			if (markers.length > 0) lists.push(markers)
		}
	}

	const firstBlock = blocks[0] as { node: Node; pos: number }
	const codeEnd = head.separate < 0 ? -1 : firstBlock.pos + 1 + offsetOf(firstBlock.node, head.separate + 1)
	const endAt = last.pos + 1 + offsetOf(last.node, last.end)

	return {
		from: pos,
		to: at,
		instruction,
		source: false,
		updatable: options.supported && (!titled || head.separate >= 0),
		sectPr,
		markers: lists.length === 0 ? NO_MARKERS : lists.flat(),
		templates,
		replaceFrom: titled ? codeEnd : pos,
		replaceTo: tail === "whole" ? last.pos : tail === "open" ? endAt : at,
		head: titled,
		tail,
		codeEnd,
		endAt,
		atom: -1
	}
}

// The TOC field atom a paragraph holds and nothing else that shows (range markers may stand around it), with its
// child index; undefined for any other paragraph, or a field a tracked change deleted or moved.
export function tocAtomOf(paragraph: Node): { readonly node: Node; readonly index: number } | undefined {
	let found: { node: Node; index: number } | undefined
	let other = false

	paragraph.forEach((child, _, index) => {
		if (!shows(child)) return
		if (found === undefined && child.type === nodes.field && parseFieldCode(child.attrs["instruction"] as string).type === "TOC")
			found = { node: child, index }
		else other = true
	})

	if (found === undefined || other) return undefined

	const field = found.node

	return marks.deletion.isInSet(field.marks) === undefined && marks.move_from.isInSet(field.marks) === undefined ? found : undefined
}

// A table of contents read as one field atom in `parent`'s child `index` (see TocRegion.atom).
function atomRegion(context: DocxEditContext, part: StoryPart, parent: Node, index: number, pos: number): TocRegion | undefined {
	const paragraph = parent.child(index)
	const atom = tocAtomOf(paragraph)

	if (atom === undefined) return undefined

	const field = atom.node
	const instruction = field.attrs["instruction"] as string
	const options = tocOptions(parseFieldCode(instruction))
	const lists: MarkerList[] = []
	const templates = new Map<number, number>()
	const item = paragraph.attrs["src"] as number

	if (item !== NO_SOURCE && part.kinds[item] === Item.Paragraph) {
		const level = tocLevel(context, partStyle(part, item), options.figures)

		if (level !== undefined) templates.set(level, item)
	}

	blockMarkers(paragraph, lists)
	paragraph.forEach(child => {
		const markers = survivorsOf(child)

		if (markers.length > 0) lists.push(markers)
	})

	let offset = 0

	for (let k = 0; k < atom.index; k++) offset += paragraph.child(k).nodeSize

	return {
		from: pos,
		to: pos + paragraph.nodeSize,
		instruction,
		source: false,
		// A field with a value a command set or an update recorded while tracking is rebuilt by no update.
		updatable: options.supported && field.attrs["state"] === null && field.attrs["update"] === null,
		sectPr: paragraph.attrs["sectPr"] as number,
		markers: lists.length === 0 ? NO_MARKERS : lists.flat(),
		templates,
		replaceFrom: pos,
		replaceTo: pos + paragraph.nodeSize,
		head: false,
		tail: undefined,
		codeEnd: -1,
		endAt: -1,
		atom: pos + 1 + offset
	}
}

// Every table of contents of the story, in document order (one walk; for commands, never per keystroke).
export function tocRegions(session: DocxEditorSession): TocRegion[] {
	const part = session.story.part
	const context = session.context
	const out: TocRegion[] = []
	const visit = (parent: Node, start: number): void => {
		let pos = start

		for (let index = 0; index < parent.childCount; index++) {
			const child = parent.child(index)
			const region =
				child.type === nodes.locked_block
					? sourceRegion(context, part, parent, index, pos)
					: child.type === nodes.paragraph
						? (newRegion(context, part, parent, index, pos) ?? atomRegion(context, part, parent, index, pos))
						: undefined

			if (region !== undefined) {
				out.push(region)

				while (index + 1 < parent.childCount && pos + parent.child(index).nodeSize < region.to)
					pos += parent.child(index++).nodeSize

				pos += parent.child(index).nodeSize

				continue
			}

			if (!child.isTextblock && !child.isAtom) visit(child, pos + 1)

			pos += child.nodeSize
		}
	}

	visit(session.state.doc, 0)

	return out
}

// The table the selection is in, else the story's first.
export function tocAt(session: DocxEditorSession): TocRegion | undefined {
	const regions = tocRegions(session)
	const { from, to } = session.state.selection

	return regions.find(region => from < region.to && to > region.from) ?? regions.find(region => from === region.to) ?? regions[0]
}

// ---- entries ---------------------------------------------------------------------------------------------

export interface TocEntry {
	readonly level: number
	// The heading's list number as drawn ("1.2\t"), and its text.
	readonly number: string
	readonly text: string
	// The heading paragraph and the bookmark an entry links to (one an update adds when it has none).
	readonly pos: number
	readonly node: Node
	readonly bookmark: DocxBookmark | undefined
}

// The headings a table with `options` lists, outside [skipFrom, skipTo) (the table itself).
export function tocEntries(host: FieldHost, session: DocxEditorSession, options: TocOptions, skipFrom: number, skipTo: number): TocEntry[] {
	const doc = session.state.doc
	const context = session.context
	const levelOf = outlineLevels(session)
	const formats = session.formats
	const bookmarks = bookmarkIndex(doc, session.story.part)
	const limit = options.bookmark === undefined ? undefined : bookmarks.byName.get(options.bookmark.toLowerCase())
	// Per paragraph style: the level \t gives it, and its own outline level (0-based).
	const styleInfo = new Map<string | null, { readonly listed: number | undefined; readonly outline: number | undefined }>()
	const infoOf = (node: Node): { readonly listed: number | undefined; readonly outline: number | undefined } => {
		const styleId = node.attrs["styleId"] as string | null
		let info = styleInfo.get(styleId)

		if (info === undefined) {
			const level = formats.styleParagraph(styleId).props.outlineLevel
			const name = (styleId === null ? context.styles.defaultOf("paragraph") : context.styles.byId(styleId))?.canonicalName

			info = {
				listed: name === undefined ? undefined : options.styles.get(name),
				outline: level !== undefined && level < 9 ? level : undefined
			}
			styleInfo.set(styleId, info)
		}

		return info
	}
	// Bookmarks by the paragraph their start is in: the first _Toc of a heading is its anchor.
	const tocBookmarks = new Map<number, DocxBookmark>()

	for (const bookmark of bookmarks.list) {
		if (!bookmark.name.startsWith("_Toc") || bookmark.start !== "inline") continue

		const $start = doc.resolve(bookmark.startPos)
		const paragraph = $start.parent.type === nodes.paragraph ? $start.before() : -1

		if (paragraph >= 0 && !tocBookmarks.has(paragraph)) tocBookmarks.set(paragraph, bookmark)
	}

	const entries: TocEntry[] = []
	const caption = options.caption?.toLowerCase()

	doc.descendants((node, pos) => {
		if (pos >= skipFrom && pos < skipTo) return false
		if (node.type !== nodes.paragraph) return node.type !== nodes.locked_block && !node.isInline
		if (limit !== undefined && (pos + node.nodeSize <= limit.from || pos >= limit.to)) return false

		// A style \t names; else a heading style's level (\o) or the paragraph's own outline level (\u), within
		// the \o range when there is one.
		const info = infoOf(node)
		let level = info.listed

		if (level === undefined && (options.headings !== undefined || options.outline)) {
			const outline = options.outline ? levelOf(node) : info.outline
			const [from, to] = options.headings ?? [1, 9]

			if (outline !== undefined && outline + 1 >= from && outline + 1 <= to) level = outline + 1
		}

		if (level === undefined && caption !== undefined) {
			let has = false

			node.forEach(child => {
				if (child.type === nodes.field) {
					const code = parseFieldCode(child.attrs["instruction"] as string)

					if (code.type === "SEQ" && code.args[0]?.toLowerCase() === caption) has = true
				}
			})

			if (has) level = 1
		}

		if (level === undefined) return false

		let text = rangeText(doc, pos + 1, pos + node.nodeSize - 1)

		if (!options.keepTabs) text = text.replace(/\t/g, " ")
		if (!options.keepBreaks) text = text.replace(/\n/g, " ")

		text = text.trim()

		if (text === "") return false

		const number = caption === undefined ? (host.pages?.markerAt(session, pos + 1) ?? "") : ""

		entries.push({ level, number, text, pos, node, bookmark: tocBookmarks.get(pos) })

		return false
	})

	return entries
}

// ---- building ----------------------------------------------------------------------------------------------

export interface TocBuild {
	// The table's paragraphs, the begin in the first and the end in the last.
	readonly paragraphs: readonly Node[]
	// Bookmarks the entries link to that the headings lack: addTocBookmarks puts them there.
	readonly bookmarks: readonly { readonly entry: TocEntry; readonly name: string; readonly id: string }[]
}

// The id of paragraph style "toc N" ("table of figures" for a table of figures: Word's style for \c and \a
// tables) as the document has it, or a built-in one the save adds, or null when it can be neither (its look is
// then given directly).
function tocStyle(context: DocxEditContext, level: number, figures: boolean): string | null {
	const name = figures ? FIGURES_STYLE : `toc ${String(level)}`
	const existing = context.styles.byName(name, "paragraph")

	if (existing !== undefined) return existing.id
	if (!hasStyleDefinition(name)) return null

	for (const [id, missing] of context.newStyles) if (missing === name) return id

	const base = figures ? "TableofFigures" : `TOC${String(level)}`
	let id = base

	for (let n = 1; context.styles.byId(id) !== undefined || context.newStyles.has(id); n++) id = `${base}${String(n)}`

	context.newStyles.set(id, name)

	return id
}

// Word's "toc N" without a definition (spacing after 5 points, 11 points of indent per level).
const TOC_SPACING: SpacingAttrs = Object.freeze({ after: 100 })
// Word's "table of figures" without a definition: no spacing after.
const FIGURES_SPACING: SpacingAttrs = Object.freeze({ after: 0 })

function tocIndent(level: number): { start: number } | null {
	return level <= 1 ? null : Object.freeze({ start: 220 * (level - 1) })
}

// The width of the text column of the section the table is in, in twips (where Word sets its right tab).
function textWidth(session: DocxEditorSession, host: FieldHost, pos: number): number {
	const context = session.context
	const pages = host.pages
	const page = pages?.page(pages.pageAt(session, pos) ?? 0)
	const sections = context.model.sections
	const section = sections[page?.section ?? sections.length - 1] ?? sections[sections.length - 1]
	const body = context.model.body === undefined ? undefined : context.model.parts[context.model.body.part]
	const props =
		section === undefined || section.sectPr < 0 || body === undefined
			? context.resolver.section({})
			: context.resolver.section(context.store.section(body.document, section.sectPr))
	const columns = Math.max(1, props.columns.count)
	const width = props.pageWidth - props.margins.left - props.margins.right - props.margins.gutter

	return Math.max(720, Math.round((width - props.columns.space * (columns - 1)) / columns))
}

// Paragraph tab stops are written once the schema has them (see the proposed `tabs` attribute).
const SUPPORTS_TABS = "tabs" in (nodes.paragraph.spec.attrs ?? {})

export interface TocBuildInput {
	readonly session: DocxEditorSession
	readonly host: FieldHost
	readonly instruction: string
	readonly entries: readonly TocEntry[]
	// Where the table goes (its section's text width sets the tab).
	readonly pos: number
	readonly templates: ReadonlyMap<number, number>
	// Range markers and comment references the old table held (inline at the new one's start), and the
	// section break its last paragraph carries.
	readonly markers: MarkerList
	readonly sectPr: number
	// Whether a bookmark name is taken in another story.
	readonly taken: (name: string) => boolean
	// The page number an entry shows now ("" when not laid out).
	readonly page: (entry: TocEntry) => string
	// The table keeps its begin and code where they are (see TocRegion): in a title's paragraph before the entries,
	// or in the paragraph the first entry joins. It keeps its end character in a paragraph of its own after the
	// entries, or in the paragraph the last entry joins. The entries hold neither then.
	readonly head?: "title" | "join" | undefined
	readonly tail?: "whole" | "open" | undefined
}

export function buildToc(input: TocBuildInput): TocBuild {
	const { session, instruction, entries } = input
	const context = session.context
	const options = tocOptions(parseFieldCode(instruction))
	const hyperlinkStyle = options.hyperlinks ? context.styles.byName("Hyperlink", "character")?.id : undefined
	const names = new Set(bookmarkIndex(session.state.doc, session.story.part).list.map(bookmark => bookmark.name.toLowerCase()))
	const bookmarks: { entry: TocEntry; name: string; id: string }[] = []
	const width = textWidth(session, input.host, input.pos)
	const noProof = marks.no_proof.create({ value: true })
	const webHidden = options.webHidden ? marks.web_hidden.create({ value: true }) : undefined
	const specs: { level: number; content: Node[]; tab: boolean }[] = []

	for (const entry of entries) {
		let name = entry.bookmark?.name

		if (name === undefined) {
			name = hiddenBookmarkName("_Toc", candidate => names.has(candidate.toLowerCase()) || input.taken(candidate))
			names.add(name.toLowerCase())
			bookmarks.push({ entry, name, id: String(context.ids.next("bookmark")) })
		}

		// Word's runs: no proofing throughout, the tab and page number hidden in Web layout under \z.
		const link: readonly Mark[] = noProof.addToSet(
			options.hyperlinks ? [marks.link.create({ src: NO_SOURCE, anchor: name, target: null, tooltip: null, history: "1" })] : []
		)
		const page: readonly Mark[] = webHidden === undefined ? link : webHidden.addToSet(link)
		const textMarks: readonly Mark[] =
			hyperlinkStyle === undefined ? link : marks.char_style.create({ styleId: hyperlinkStyle }).addToSet(link)
		const content: Node[] = []
		const text = (value: string, with_: readonly Mark[]): void => {
			for (const piece of value.split(/(\t|\n)/)) {
				if (piece === "\t") content.push(nodes.tab.create(null, null, link))
				else if (piece === "\n") content.push(nodes.break.create(null, null, link))
				else if (piece !== "") content.push(docxSchema.text(piece, with_))
			}
		}

		text(entry.number, textMarks)
		text(entry.text, textMarks)

		const numbered = options.omit === undefined || entry.level < options.omit[0] || entry.level > options.omit[1]

		if (numbered) {
			if (options.separator !== undefined) text(options.separator, page)
			else content.push(nodes.tab.create(null, null, page))

			content.push(
				nodes.field.create(
					{
						src: NO_SOURCE,
						end: NO_SOURCE,
						simple: false,
						type: "PAGEREF",
						instruction: ` PAGEREF ${name} \\h `,
						result: input.page(entry)
					},
					null,
					page
				)
			)
		}

		specs.push({ level: entry.level, content, tab: numbered && options.separator === undefined })
	}

	if (specs.length === 0) specs.push({ level: 1, content: [docxSchema.text(NO_ENTRIES)], tab: false })

	const code =
		input.head !== undefined
			? []
			: [
					nodes.field_char.create({ kind: "begin", instruction, dirty: false }),
					nodes.field_char.create({ kind: "instruction", instruction }),
					nodes.field_char.create({ kind: "separate" })
				]

	;(specs[0] as { content: Node[] }).content.unshift(
		...input.markers.map(marker =>
			marker.kind === "commentReference"
				? nodes.comment_ref.create({ src: marker.src, id: marker.id })
				: nodes.marker.create(markerNodeAttrs(marker))
		),
		...code
	)
	// The end in the last entry; a table of one paragraph ends in one of its own after it (a field within one
	// paragraph is no table: it would read back as a field of that paragraph).
	if (specs.length === 1 && input.head !== "title" && input.tail !== "whole") specs.push({ level: 1, content: [], tab: false })
	if (input.tail === undefined) (specs[specs.length - 1] as { content: Node[] }).content.push(nodes.field_char.create({ kind: "end" }))

	const paragraphs = specs.map((spec, index) =>
		entryParagraph(
			session,
			input,
			options.figures,
			spec.level,
			width,
			spec.content,
			spec.tab,
			index === specs.length - 1 ? input.sectPr : NO_SOURCE
		)
	)

	return { paragraphs, bookmarks }
}

// An entry paragraph of level `level`: the table's own paragraph of that style when it has one (its direct
// properties stay, as Word keeps them), else a new one styled "toc N" with Word's right tab at the margin when
// the style has none.
function entryParagraph(
	session: DocxEditorSession,
	input: TocBuildInput,
	figures: boolean,
	level: number,
	width: number,
	content: readonly Node[],
	tab: boolean,
	sectPr: number
): Node {
	const context = session.context
	const part = session.story.part
	const template = input.templates.get(level)
	const styleId = template === undefined ? tocStyle(context, level, figures) : null
	const attrs: Record<string, unknown> = { styleId, sectPr }

	if (template !== undefined) {
		const row = part.aux[template] ?? -1
		const props: ParagraphProps = context.store.paragraph(part.document, part.paragraphs.pPr[row] ?? -1)

		Object.assign(attrs, {
			src: template,
			styleId: props.styleId ?? null,
			numId: props.numbering?.numId ?? null,
			ilvl: props.numbering?.ilvl ?? null,
			align: props.alignment ?? null,
			indent: props.indent ?? null,
			spacing: props.spacing ?? null,
			borders: props.borders ?? null
		})
	} else if (styleId === null) {
		Object.assign(attrs, figures ? { spacing: FIGURES_SPACING } : { spacing: TOC_SPACING, indent: tocIndent(level) })
	}

	if (tab && template === undefined && SUPPORTS_TABS) {
		const tabs = session.formats.styleParagraph(styleId).props.tabs

		if (!tabs.some(stop => stop.alignment === "end"))
			attrs["tabs"] = Object.freeze([Object.freeze({ alignment: "right", position: width - 10, leader: "dot" })])
	}

	return nodes.paragraph.create(attrs, content)
}

// Puts the bookmarks of `build` around their headings' text (`tr` maps positions of the document the
// entries were collected from).
export function addTocBookmarks(tr: Transaction, build: TocBuild): void {
	for (const { entry, name, id } of [...build.bookmarks].sort((a, b) => b.entry.pos - a.entry.pos)) {
		const from = tr.mapping.map(entry.pos + 1, -1)
		const to = tr.mapping.map(entry.pos + entry.node.nodeSize - 1, 1)

		insertBookmark(tr, from, to, id, name)
	}
}

// Whether a name is taken by a bookmark of a story other than `session`'s.
export function takenElsewhere(sessions: readonly DocxEditorSession[], session: DocxEditorSession): (name: string) => boolean {
	const others = sessions.filter(other => other !== session)

	return name => bookmarkNameTaken(session.context, others, name)
}

// Parts with a table of contents within one paragraph (read as a field atom).
const ONE_PARAGRAPH_TOCS = new WeakMap<StoryPart, boolean>()

function hasOneParagraphToc(part: StoryPart): boolean {
	let found = ONE_PARAGRAPH_TOCS.get(part)

	if (found === undefined) {
		found = false

		for (let field = 0; field < part.fields.count && !found; field++)
			found = (part.fields.parent[field] ?? -1) < 0 && part.fieldType(field) === "TOC"

		ONE_PARAGRAPH_TOCS.set(part, found)
	}

	return found
}

// Whether the story's part has a table of contents of its own (read once per part).
export function partHasToc(part: StoryPart): boolean {
	return sourceTocs(part).size > 0 || hasOneParagraphToc(part)
}

// Stories a table of contents was inserted into this session.
const INSERTED = new WeakSet<DocxEditorSession>()

export function tocInserted(session: DocxEditorSession): void {
	INSERTED.add(session)
}

// Whether a story may hold a table of contents (without looking at its document): its part has one, or one
// was inserted.
export function mayHoldToc(session: DocxEditorSession): boolean {
	return INSERTED.has(session) || partHasToc(session.story.part)
}

// Whether nothing shows before a table's begin in its first paragraph or after its end in its last (a rebuild
// writes neither, so it keeps all there is).
function rebuildable(part: StoryPart, toc: SourceToc): boolean {
	const beginRun = part.parent(toc.begin)
	const endRun = part.parent(toc.end)

	if (part.parent(toc.first) !== part.parent(toc.last)) return false

	// Paragraphs only (a rebuild writes paragraphs), range markers between them.
	for (let block = toc.first; block <= toc.last; block = part.end(block)) {
		const kind = part.kinds[block] ?? 0

		if (kind !== Item.Paragraph && !BLANK_KINDS.has(kind)) return false
	}

	return (
		part.kinds[beginRun] === Item.Run &&
		part.kinds[endRun] === Item.Run &&
		part.fieldCharType(toc.begin) === FieldCharType.Begin &&
		blank(part, toc.first + 1, beginRun) &&
		blank(part, toc.end + 1, part.end(toc.last))
	)
}

// Why an update cannot rebuild a table of contents: its switches ask for what the editor does not build, or its
// paragraphs hold more than the table.
export type TocRefusal = "unsupportedTable" | "tableWithOtherContent"

export interface SourceTocInfo {
	readonly instruction: string
	readonly refusal: TocRefusal | null
}

const TOC_PARAGRAPHS = new WeakMap<StoryPart, ReadonlyMap<number, SourceTocInfo>>()

// The table of contents of the file a source paragraph is part of, if any: its instruction and why an update
// cannot rebuild it (null: it can), read once per part.
export function sourceTocOf(part: StoryPart, paragraph: number): SourceTocInfo | undefined {
	let map = TOC_PARAGRAPHS.get(part)

	if (map === undefined) {
		const out = new Map<number, SourceTocInfo>()

		for (const toc of sourceTocs(part).values()) {
			const value = Object.freeze({
				instruction: toc.instruction,
				refusal: !tocOptions(parseFieldCode(toc.instruction)).supported
					? "unsupportedTable"
					: rebuildable(part, toc)
						? null
						: "tableWithOtherContent"
			})

			for (let item = toc.first; item <= toc.last; item++) if (part.kinds[item] === Item.Paragraph) out.set(item, value)
		}

		map = out
		TOC_PARAGRAPHS.set(part, map)
	}

	return map.get(paragraph)
}
