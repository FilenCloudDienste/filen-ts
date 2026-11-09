import type { MarkType, Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { LINE_INTS, LineFlag, LineInt } from "../../text/index"
import { NO_SOURCE, docxSchema, type DocxEditorSession } from "../edit/index"
import { Item, RevisionView, type Story, type StoryPart } from "../model/index"
import { shownFieldText } from "../layout/fields"
import { Region, SOURCE_INTS, SourceInt, type PageDisplayList } from "../layout/index"
import { Ns } from "../model/namespaces"
import type { PagedEditor } from "./editor"

// Questions an app asks about the whole document now and then (a word count, the headings to navigate by):
// computed on demand, never per keystroke. A count is kept per document state (and per block, so counting
// again after an edit reads only the blocks it changed); the outline per document state.

const nodes = docxSchema.nodes
const marks = docxSchema.marks

export interface DocxTextCount {
	readonly words: number
	// Characters (code points) with and without spaces.
	readonly characters: number
	readonly charactersNoSpaces: number
	// Paragraphs holding something other than spaces.
	readonly paragraphs: number
}

export interface DocxWordCount extends DocxTextCount {
	// Pages laid out so far (all of them once the editor settled).
	readonly pages: number
	// Lines laid out on those pages (docxLineCount).
	readonly lines: number
}

export interface DocxWordCountOptions {
	// Word's "Include textboxes, footnotes and endnotes".
	readonly notesAndTextBoxes?: boolean
}

// Gives the host a turn between slices of a long count (no long task on a UI thread).
export interface DocxQuerySlicing {
	readonly pause: () => Promise<void>
	readonly sliceMs: number
	readonly now: () => number
}

// Word separates words by spaces; East Asian characters count one word each.
function isSpace(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x2000 && code <= 0x200a) || code === 0x3000
}

function isEastAsian(code: number): boolean {
	return (
		(code >= 0x3040 && code <= 0x30ff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xff66 && code <= 0xff9f) ||
		(code >= 0x20000 && code <= 0x3ffff)
	)
}

class Counter {
	words = 0
	characters = 0
	charactersNoSpaces = 0
	paragraphs = 0
	private inWord = false
	private filled = false

	text(text: string): void {
		for (let k = 0; k < text.length; k++) {
			let code = text.charCodeAt(k)

			if (code >= 0xd800 && code <= 0xdbff && k + 1 < text.length) {
				const low = text.charCodeAt(k + 1)

				if (low >= 0xdc00 && low <= 0xdfff) {
					code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
					k++
				}
			}

			// An optional hyphen is invisible unless it breaks a line.
			if (code === 0xad) continue

			this.characters++

			if (isSpace(code)) {
				this.inWord = false

				continue
			}

			this.charactersNoSpaces++
			this.filled = true

			if (isEastAsian(code)) {
				this.words++
				this.inWord = false
			} else if (!this.inWord) {
				this.words++
				this.inWord = true
			}
		}
	}

	// A break between words that is no character (a line break, the end of a paragraph).
	gap(): void {
		this.inWord = false
	}

	endParagraph(): void {
		if (this.filled) this.paragraphs++

		this.filled = false
		this.inWord = false
	}

	add(count: DocxTextCount): void {
		this.words += count.words
		this.characters += count.characters
		this.charactersNoSpaces += count.charactersNoSpaces
		this.paragraphs += count.paragraphs
	}

	result(): DocxTextCount {
		return Object.freeze({
			words: this.words,
			characters: this.characters,
			charactersNoSpaces: this.charactersNoSpaces,
			paragraphs: this.paragraphs
		})
	}
}

function hiddenTypes(view: RevisionView): readonly MarkType[] {
	return view === RevisionView.Original ? [marks.insertion, marks.move_to] : [marks.deletion, marks.move_from]
}

function countInline(counter: Counter, node: Node): void {
	switch (node.type) {
		case nodes.text:
			counter.text(node.text ?? "")

			break
		case nodes.tab:
			counter.text("\t")

			break
		case nodes.break:
			counter.gap()

			break
		case nodes.hyphen:
			if (node.attrs["soft"] !== true) counter.text("‑")

			break
		case nodes.symbol: {
			const char = node.attrs["char"] as number

			// A w:sym without a valid w:char shows nothing (as layout draws it).
			if (char > 0 && char <= 0x10ffff) counter.text(String.fromCodePoint(char))

			break
		}
		// What it shows: a MACROBUTTON without a result its display text.
		case nodes.field:
			counter.text(shownFieldText(node.attrs["result"] as string, node.attrs["instruction"] as string))

			break
		case nodes.run_object:
		case nodes.opaque_inline:
			counter.text(node.attrs["text"] as string)

			break
	}
}

// The paragraphs inside source item `item` (a block, or a story's container) as the file has them.
function countItem(counter: Counter, part: StoryPart, item: number, view: RevisionView): void {
	const end = part.end(item)
	const paragraph = (at: number): void => {
		for (const line of part.paragraphText(at, view).split("\n")) {
			counter.text(line)
			counter.gap()
		}

		counter.endParagraph()
	}

	if (part.kinds[item] === Item.Paragraph) {
		paragraph(item)

		return
	}

	for (let at = item + 1; at < end; at++) {
		if (part.kinds[at] !== Item.Paragraph) continue

		paragraph(at)
		at = part.end(at) - 1
	}
}

function countBlock(counter: Counter, part: StoryPart, node: Node, view: RevisionView, hidden: readonly MarkType[]): void {
	if (node.type === nodes.paragraph) {
		node.forEach(child => {
			if (!hidden.some(type => type.isInSet(child.marks) !== undefined)) countInline(counter, child)
		})
		counter.endParagraph()

		return
	}

	// Kept as its source bytes: counted from the file.
	if (node.type === nodes.locked_block) {
		const src = node.attrs["src"] as number

		if (src >= 0) countItem(counter, part, src, view)

		return
	}

	node.forEach(child => countBlock(counter, part, child, view, hidden))
}

// Counts per top-level block and view, kept while the block is (blocks an edit did not touch keep theirs).
const BLOCK_COUNTS: readonly WeakMap<Node, DocxTextCount>[] = [new WeakMap(), new WeakMap(), new WeakMap()]
const DOC_COUNTS: readonly WeakMap<Node, DocxTextCount>[] = [new WeakMap(), new WeakMap(), new WeakMap()]

function blockCount(part: StoryPart, node: Node, view: RevisionView): DocxTextCount {
	const cache = BLOCK_COUNTS[view] as WeakMap<Node, DocxTextCount>
	let count = cache.get(node)

	if (count === undefined) {
		const counter = new Counter()

		countBlock(counter, part, node, view, hiddenTypes(view))
		count = counter.result()
		cache.set(node, count)
	}

	return count
}

// The words, characters and paragraphs of a session's document as `view` shows it.
export async function countSession(
	session: DocxEditorSession,
	view: RevisionView = RevisionView.Final,
	slicing?: DocxQuerySlicing
): Promise<DocxTextCount> {
	const doc = session.state.doc
	const part = session.story.part
	const done = (DOC_COUNTS[view] as WeakMap<Node, DocxTextCount>).get(doc)

	if (done !== undefined) return done

	const counter = new Counter()
	let sliceStart = slicing?.now() ?? 0

	for (let k = 0; k < doc.childCount; k++) {
		counter.add(blockCount(part, doc.child(k), view))

		if (slicing !== undefined && slicing.now() - sliceStart >= slicing.sliceMs) {
			await slicing.pause()
			sliceStart = slicing.now()
		}
	}

	const count = counter.result()

	;(DOC_COUNTS[view] as WeakMap<Node, DocxTextCount>).set(doc, count)

	return count
}

// Counts of stories never opened, per view: their text is the file's, which does not change.
const STORY_COUNTS: readonly WeakMap<Story, DocxTextCount>[] = [new WeakMap(), new WeakMap(), new WeakMap()]

function countModelStory(story: Story, editor: PagedEditor, view: RevisionView): DocxTextCount {
	const cache = STORY_COUNTS[view] as WeakMap<Story, DocxTextCount>
	let count = cache.get(story)

	if (count === undefined) {
		const counter = new Counter()

		if (story.item >= 0) countItem(counter, editor.edits.model.partOf(story), story.item, view)

		count = counter.result()
		cache.set(story, count)
	}

	return count
}

const NOTE_KINDS = new Set(["footnote", "endnote", "textbox"])

// Word's word count of the body (and, with the option, of text boxes, footnotes and endnotes), in the
// revision view the editor shows. Stories open in the editor count as edited; the others as the file has them.
export async function docxWordCount(
	editor: PagedEditor,
	options: DocxWordCountOptions = {},
	slicing?: DocxQuerySlicing
): Promise<DocxWordCount> {
	const view = editor.edits.view
	const counter = new Counter()

	counter.add(await countSession(editor.body.session, view, slicing))

	if (options.notesAndTextBoxes === true) {
		const open = new Map<Story, DocxEditorSession>()

		for (const session of editor.sessions) open.set(session.story.story, session)

		for (const story of editor.edits.model.stories) {
			if (story === undefined || !NOTE_KINDS.has(story.kind) || (story.noteType !== undefined && story.noteType !== "normal"))
				continue

			const session = open.get(story)

			counter.add(session === undefined ? countModelStory(story, editor, view) : await countSession(session, view, slicing))
		}
	}

	return { ...counter.result(), pages: editor.pageCount, lines: docxLineCount(editor, options) }
}

function countRangeOf(
	counter: Counter,
	part: StoryPart,
	node: Node,
	pos: number,
	from: number,
	to: number,
	view: RevisionView,
	hidden: readonly MarkType[]
): void {
	const end = pos + node.nodeSize

	if (end <= from || pos >= to) return

	if (pos >= from && end <= to) {
		countBlock(counter, part, node, view, hidden)

		return
	}

	if (node.type === nodes.paragraph) {
		node.forEach((child, offset) => {
			const start = pos + 1 + offset
			const stop = start + child.nodeSize

			if (stop <= from || start >= to || hidden.some(type => type.isInSet(child.marks) !== undefined)) return

			if (child.isText) counter.text((child.text ?? "").slice(Math.max(from, start) - start, Math.min(to, stop) - start))
			else countInline(counter, child)
		})
		counter.endParagraph()

		return
	}

	// An atom reached in part is counted whole.
	if (node.type === nodes.locked_block) {
		countBlock(counter, part, node, view, hidden)

		return
	}

	node.forEach((child, offset) => countRangeOf(counter, part, child, pos + 1 + offset, from, to, view, hidden))
}

// The words, characters and paragraphs between positions `from` and `to` of a session's document as `view`
// shows it (Word's count of a selection): blocks wholly inside are read from the counts kept per block.
export function countRange(session: DocxEditorSession, from: number, to: number, view: RevisionView = RevisionView.Final): DocxTextCount {
	const counter = new Counter()
	const doc = session.state.doc
	const part = session.story.part
	const hidden = hiddenTypes(view)

	if (from >= to) return counter.result()

	doc.forEach((child, offset) => {
		const end = offset + child.nodeSize

		if (end <= from || offset >= to) return

		if (offset >= from && end <= to) counter.add(blockCount(part, child, view))
		else countRangeOf(counter, part, child, offset, from, to, view, hidden)
	})

	return counter.result()
}

// ---- lines ----------------------------------------------------------------------------------------------

// Lines a page shows of the body, and of notes and text boxes: kept per page laid out.
const PAGE_LINES = new WeakMap<PageDisplayList, { readonly body: number; readonly notes: number }>()

// The region line `line` of `page` is in, or -1 (no source, or a segment continuing the same row past a float).
function lineRegion(page: PageDisplayList, line: number): number {
	const i = line * LINE_INTS

	if (((page.text.lineInts[i + LineInt.FLAGS] ?? 0) & LineFlag.CONTINUES) !== 0) return -1

	const source = page.text.lineInts[i + LineInt.SOURCE] ?? -1

	return source < 0 ? -1 : (page.sourceInts[source * SOURCE_INTS + SourceInt.REGION] ?? -1)
}

function isNoteRegion(region: number): boolean {
	return region === Region.FOOTNOTE || region === Region.ENDNOTE || region === Region.TEXTBOX
}

function pageLines(page: PageDisplayList): { readonly body: number; readonly notes: number } {
	let lines = PAGE_LINES.get(page)

	if (lines === undefined) {
		let body = 0
		let notes = 0

		for (let line = 0; line < page.text.lineCount; line++) {
			const region = lineRegion(page, line)

			if (region === Region.BODY) body++
			else if (isNoteRegion(region)) notes++
		}

		lines = { body, notes }
		PAGE_LINES.set(page, lines)
	}

	return lines
}

// Word's line count: the lines laid out of the body (headers, footers and line numbers left out), and with the
// option, of text boxes, footnotes and endnotes. A page laid out again is read again; the others keep theirs.
export function docxLineCount(editor: PagedEditor, options: DocxWordCountOptions = {}): number {
	let count = 0

	for (let index = 0; index < editor.pageCount; index++) {
		const page = editor.page(index)

		if (page === undefined) continue

		const lines = pageLines(page)

		count += lines.body + (options.notesAndTextBoxes === true ? lines.notes : 0)
	}

	return count
}

// The pages and body lines positions `from` to `to` of the body are laid out on (Word's count of a selection), or
// undefined while either end is not laid out.
export function docxRangeLayout(
	editor: PagedEditor,
	from: number,
	to: number
): { readonly pages: number; readonly lines: number } | undefined {
	const geometry = editor.body.geometry
	const start = geometry.locate(from, 1)
	const end = geometry.locate(Math.max(from, to), -1)

	if (start === undefined || end === undefined || end.page < start.page) return undefined

	let lines = 0

	for (let index = start.page; index <= end.page; index++) {
		const page = editor.page(index)

		if (page === undefined) continue

		const first = index === start.page ? start.line : 0
		const last = index === end.page ? end.line : page.text.lineCount - 1

		for (let line = first; line <= last; line++) if (lineRegion(page, line) === Region.BODY) lines++
	}

	return { pages: end.page - start.page + 1, lines }
}

// ---- outline --------------------------------------------------------------------------------------------

export interface DocxOutlineEntry {
	// Outline level, 0 (Heading 1) to 8.
	readonly level: number
	readonly text: string
	// The heading paragraph's position in the body's document (`doc`).
	readonly pos: number
}

export interface DocxOutline {
	// The body's document the positions are in.
	readonly doc: Node
	readonly entries: readonly DocxOutlineEntry[]
}

// Characters of a heading an outline shows.
const MAX_HEADING = 255
const HEADING_STYLE = /^heading ([1-9])$/
// Styles followed up a basedOn chain (a cycle stops there).
const MAX_STYLE_DEPTH = 16
const OUTLINES: readonly WeakMap<Node, DocxOutline>[] = [new WeakMap(), new WeakMap(), new WeakMap()]

// The body's headings (paragraphs with an outline level, from their style or direct formatting), in document
// order: Word's navigation pane.
export function docxOutline(editor: PagedEditor): DocxOutline {
	const session = editor.body.session
	const doc = session.state.doc
	const view = editor.edits.view
	const cache = OUTLINES[view] as WeakMap<Node, DocxOutline>
	let outline = cache.get(doc)

	if (outline !== undefined) return outline

	const formats = session.formats
	const part = session.story.part
	const hidden = hiddenTypes(view)
	const entries: DocxOutlineEntry[] = []
	const styleLevels = new Map<string | null, number | undefined>()
	// The outline level Word gives a built-in heading style (heading N, or a style based on one) whose definition
	// sets none, or one an edit added that the file does not define yet: N − 1, fixed for those styles in Word.
	const headingStyleLevel = (styleId: string | null): number | undefined => {
		const { styles, newStyles } = session.context
		let id = styleId

		for (let depth = 0; id !== null && depth < MAX_STYLE_DEPTH; depth++) {
			const style = styles.byId(id)
			const name = style?.canonicalName ?? newStyles.get(id)?.toLowerCase()
			const heading = name === undefined ? null : HEADING_STYLE.exec(name)

			if (heading !== null) return Number(heading[1]) - 1

			id = style?.basedOn ?? null
		}

		return undefined
	}
	// A paragraph's outline level: its style's, unless its own properties or a list may set one (then it is
	// resolved in full). Most paragraphs are resolved by their style alone.
	const levelOf = (node: Node): number | undefined => {
		const src = node.attrs["src"] as number
		const row = src === NO_SOURCE ? -1 : (part.aux[src] ?? -1)
		const pPr = row < 0 ? -1 : (part.paragraphs.pPr[row] ?? -1)
		const styleId = node.attrs["styleId"] as string | null

		// Its own w:outlineLvl decides (9: body text).
		if (pPr >= 0 && part.reader.child(pPr, Ns.W, "outlineLvl") >= 0) return formats.paragraph(node).props.outlineLevel

		if (node.attrs["numId"] !== null) return formats.paragraph(node).props.outlineLevel ?? headingStyleLevel(styleId)

		if (!styleLevels.has(styleId)) {
			const style = formats.styleParagraph(styleId)

			styleLevels.set(styleId, style.props.numbering === undefined ? (style.props.outlineLevel ?? headingStyleLevel(styleId)) : -1)
		}

		const level = styleLevels.get(styleId)

		return level === -1 ? (formats.paragraph(node).props.outlineLevel ?? headingStyleLevel(styleId)) : level
	}

	doc.descendants((node, pos) => {
		if (node.type !== nodes.paragraph) return node.type !== nodes.locked_block

		const level = levelOf(node)

		if (level !== undefined && level < 9) {
			let text = ""

			node.forEach(child => {
				if (child.isText && !hidden.some(type => type.isInSet(child.marks) !== undefined)) text += child.text ?? ""
			})

			text = text.trim()

			if (text !== "") entries.push(Object.freeze({ level, text: text.slice(0, MAX_HEADING), pos }))
		}

		return false
	})

	outline = Object.freeze({ doc, entries: Object.freeze(entries) })
	cache.set(doc, outline)

	return outline
}

// Puts the caret at the start of an outline entry's heading (in the body, which it enters). After edits the
// heading is found again by its level and text, the nearest to where it was; false when it is gone.
export function goToOutlineEntry(editor: PagedEditor, outline: DocxOutline, entry: DocxOutlineEntry): boolean {
	const session = editor.body.session
	const current = docxOutline(editor)
	let target: DocxOutlineEntry | undefined = current === outline ? entry : undefined

	if (target === undefined) {
		const index = outline.entries.indexOf(entry)
		let best = Number.POSITIVE_INFINITY

		current.entries.forEach((candidate, at) => {
			const distance = Math.abs(at - index)

			if (candidate.level === entry.level && candidate.text === entry.text && distance < best) {
				best = distance
				target = candidate
			}
		})
	}

	if (target === undefined) return false

	editor.exitStory()

	return editor.dispatch(session.state.tr.setSelection(TextSelection.create(current.doc, target.pos + 1)).scrollIntoView())
}

// The index of the entry whose heading governs position `pos` (the last one at or before it), or -1.
export function outlineEntryAt(outline: DocxOutline, pos: number): number {
	const entries = outline.entries
	let low = 0
	let high = entries.length - 1
	let found = -1

	while (low <= high) {
		const middle = (low + high) >> 1

		if ((entries[middle]?.pos ?? 0) <= pos) {
			found = middle
			low = middle + 1
		} else high = middle - 1
	}

	return found
}

// The index of the first entry after entry `index`'s subheadings (the next of its level or a higher one), or the
// entry count: entries `index` to it are what collapsing or moving that heading takes.
export function outlineSectionEnd(outline: DocxOutline, index: number): number {
	const entries = outline.entries
	const level = entries[index]?.level ?? -1

	for (let next = index + 1; next < entries.length; next++) if ((entries[next]?.level ?? 0) <= level) return next

	return entries.length
}

// Where the top-level block holding `pos` starts.
function topStart(doc: Node, pos: number): number {
	const resolved = doc.resolve(pos)

	return resolved.depth === 0 ? pos : resolved.before(1)
}

// Whether entry `index` can be moved with its content (Word's drag in the navigation pane): its heading is a
// paragraph of the body itself, not of a table.
export function canMoveOutlineEntry(outline: DocxOutline, index: number): boolean {
	const entry = outline.entries[index]

	return entry !== undefined && outline.doc.resolve(entry.pos).depth === 0
}

// Moves heading `index` with everything under it (to the next heading of its level or a higher one) to before
// heading `before`, or to the end of the document for the entry count, as Word's navigation pane drags headings.
// The caret goes to the heading moved. False when the outline is not the body's current one, the heading cannot
// move (canMoveOutlineEntry), the place is within what moves, or the editor refuses the edit (protection).
export function moveOutlineEntry(editor: PagedEditor, outline: DocxOutline, index: number, before: number): boolean {
	const entries = outline.entries
	const session = editor.body.session
	const doc = session.state.doc

	if (outline.doc !== doc || docxOutline(editor) !== outline || !canMoveOutlineEntry(outline, index)) return false

	const last = outlineSectionEnd(outline, index)

	if (before >= index && before <= last) return false

	const start = (entries[index] as DocxOutlineEntry).pos
	const endEntry = entries[last]
	const end = endEntry === undefined ? doc.content.size : topStart(doc, endEntry.pos)
	const beforeEntry = entries[before]
	const target = beforeEntry === undefined ? doc.content.size : topStart(doc, beforeEntry.pos)

	if (target >= start && target <= end) return false

	const content = doc.slice(start, end).content
	const tr = session.state.tr
	let at = target

	if (target > end) {
		tr.insert(target, content)
		tr.delete(start, end)
		at = target - (end - start)
	} else {
		tr.delete(start, end)
		tr.insert(target, content)
	}

	editor.exitStory()

	return editor.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView())
}
