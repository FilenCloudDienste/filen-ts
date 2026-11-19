import {
	DOMParser,
	DOMSerializer,
	Fragment,
	Slice,
	type DOMOutputSpec,
	type Mark,
	type MarkType,
	type Node,
	type ResolvedPos
} from "prosemirror-model"
import type { Transaction } from "prosemirror-state"
import { docxSchema, type DocxEditorSession, type MarkerList } from "../../../core/docx/edit/index"
import type { PagedEditor } from "../../../core/docx/paged/index"
import { COMMENT_MOVE_META, freshSliceKeeping } from "../../../core/docx/edit/invariants/index"
import { sourceCopies } from "../../../core/docx/edit/session"
import { RevisionView, revisionHidden } from "../../../core/docx/model/kinds"
import { shownFieldText } from "../../../core/docx/layout/fields"
import { docxComments } from "../../../core/docx/review/comments"
import { symbolTable, symbolToUnicode } from "../../../core/fonts/index"

// The clipboard of the editing views (the paged editor's input sink, the reflowed view): what a copy writes
// (structure and basic formatting as HTML, and text as Word copies it), how a paste is read (HTML rebuilt from
// its text and basic formatting first, plain text a paragraph per line), and a cut's comment anchors moved
// when it is pasted back.

const nodes = docxSchema.nodes

function symbolCode(char: unknown): char is number {
	return typeof char === "number" && Number.isInteger(char) && char > 0 && char <= 0x10ffff
}

// A w:sym as the character it shows: a symbol font's code (Symbol, Wingdings...) as the Unicode character the
// font draws there, any other code as itself. What the views show, a copy writes and assistive technology reads.
export function symbolText(node: Node): string {
	const char = node.attrs["char"]
	const font = node.attrs["font"]

	if (!symbolCode(char)) return ""

	const table = typeof font === "string" ? symbolTable(font) : undefined
	const mapped = table === undefined ? 0 : symbolToUnicode(table, char)

	return String.fromCodePoint(mapped > 0 ? mapped : char)
}

export function attrText(name: string): (node: Node) => string {
	return node => {
		const value = node.attrs[name]

		return typeof value === "string" ? value : ""
	}
}

// What a field shows: its result, or a MACROBUTTON's display text where it has none.
export function fieldText(node: Node): string {
	return shownFieldText(attrText("result")(node), attrText("instruction")(node))
}

// Copying writes this HTML (and the text): structure and basic formatting, never document-controlled URLs.
export function clipboardSerializer(): DOMSerializer {
	const text =
		(value: (node: Node) => string) =>
		(node: Node): DOMOutputSpec => ["span", value(node)]
	const empty = (): DOMOutputSpec => ["span"]
	const nodeSpecs: Record<string, (node: Node) => DOMOutputSpec> = {
		paragraph: () => ["p", 0],
		table: () => ["table", ["tbody", 0]],
		table_row: () => ["tr", 0],
		table_cell: () => ["td", 0],
		sdt: () => ["div", 0],
		locked_block: node => ["p", attrText("text")(node)],
		tab: text(() => "\t"),
		break: () => ["br"],
		hyphen: text(node => (node.attrs["soft"] === true ? "" : "\u2011")),
		// The character shown, and the code and font that paste it back as the symbol.
		symbol: node => {
			const font = node.attrs["font"]

			return [
				"span",
				{ [PASTE_SYMBOL]: String(node.attrs["char"]), ...(typeof font === "string" ? { [PASTE_SYMBOL_FONT]: font } : {}) },
				symbolText(node)
			]
		},
		note_ref: empty,
		comment_ref: empty,
		drawing: empty,
		run_object: text(attrText("text")),
		field: text(fieldText),
		marker: empty,
		field_char: empty,
		math: empty,
		proof_err: empty,
		rendered_break: empty,
		opaque_inline: text(attrText("text"))
	}
	const toggled = (tag: string) => (mark: Mark) => (mark.attrs["value"] === false ? ["span", 0] : [tag, 0]) as DOMOutputSpec
	const markSpecs: Record<string, (mark: Mark, inline: boolean) => DOMOutputSpec> = Object.fromEntries(
		Object.keys(docxSchema.marks).map(name => [name, () => ["span", 0] as DOMOutputSpec])
	)

	markSpecs["bold"] = toggled("strong")
	markSpecs["italic"] = toggled("em")
	markSpecs["underline"] = () => ["u", 0]
	markSpecs["strike"] = toggled("s")

	return new DOMSerializer(nodeSpecs, markSpecs)
}

// Pasted HTML (after safeClipboardHtml) becomes paragraphs with basic formatting, breaks and tabs; the session's
// invariants make it new content.
export function clipboardParser(): DOMParser {
	return new DOMParser(docxSchema, [
		{ tag: "p", node: "paragraph" },
		// Spaces kept; safeClipboardHtml made each line a block of its own, so no newline reaches a text node.
		{ tag: "pre", node: "paragraph", preserveWhitespace: true },
		{ tag: "br", node: "break" },
		{ tag: `span[${PASTE_TAB}]`, node: "tab" },
		{
			tag: `span[${PASTE_SYMBOL}]`,
			node: "symbol",
			getAttrs: dom => ({ char: Number(dom.getAttribute(PASTE_SYMBOL)), font: dom.getAttribute(PASTE_SYMBOL_FONT) })
		},
		{ tag: "b", mark: "bold", attrs: { value: true, cs: null } },
		{ tag: "i", mark: "italic", attrs: { value: true, cs: null } },
		{ tag: "u", mark: "underline" },
		{ tag: "s", mark: "strike", attrs: { value: true } }
	])
}

// Pasted HTML is rebuilt from its text and basic formatting before ProseMirror reads it: a flat list of <p>
// (or <pre>) blocks holding text, <br>, tabs, this editor's symbols (by code and font) and b/i/u/s only, without
// other attributes; text is escaped. Content
// that is not text is dropped (scripts, styles, embedded and replaced content). A table becomes a paragraph
// per row, its cells separated by tabs and a cell's paragraphs by line breaks, as Word pastes a table as text
// (and as a copy's plain text has it): the editor cannot insert a table. Nesting is resolved here, never by
// the HTML parser or ProseMirror's clipboard reader, which would treat a leading cell as a table fragment and
// drop the rest. The source is parsed by DOMParser, which never runs scripts or loads anything, so what
// ProseMirror parses next references nothing; ProseMirror's own slice data (data-pm-slice) goes too.
const PASTE_TAB = "data-fo-tab"
// A symbol of this editor's copy: its code (decimal) and font, kept so it pastes back as the symbol.
const PASTE_SYMBOL = "data-fo-sym"
const PASTE_SYMBOL_FONT = "data-fo-sym-font"
const MAX_SYMBOL_FONT = 64
const PASTE_DROPPED = new Set([
	"script",
	"style",
	"template",
	"noscript",
	"head",
	"title",
	"meta",
	"link",
	"base",
	"iframe",
	"frame",
	"frameset",
	"object",
	"embed",
	"applet",
	"img",
	"picture",
	"source",
	"track",
	"video",
	"audio",
	"canvas",
	"svg",
	"math",
	"map",
	"area",
	"form",
	"input",
	"button",
	"select",
	"textarea",
	"option",
	"dialog",
	"portal",
	"colgroup",
	"col"
])
// Elements that end the paragraph before them and start a new one.
const PASTE_BLOCKS = new Set([
	"p",
	"div",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"li",
	"dt",
	"dd",
	"blockquote",
	"pre",
	"address",
	"article",
	"aside",
	"section",
	"header",
	"footer",
	"nav",
	"main",
	"figure",
	"figcaption",
	"center",
	"ul",
	"ol",
	"dl",
	"details",
	"summary",
	"hr",
	"caption",
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"td",
	"th"
])
// Blocks that are a paragraph of their own even when empty.
const PASTE_PARAGRAPHS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "dt", "dd", "pre"])
const ESCAPED: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }
// Word's tab characters in its HTML (`<span style='mso-tab-count:2'>`).
const MSO_TABS = /mso-tab-count\s*:\s*(\d+)/i
const MARK_TAGS = ["b", "i", "u", "s"] as const

interface ParsedHtml {
	readonly body: ParsedNode | null
}

interface ParsedNode {
	readonly nodeType: number
	readonly nodeValue: string | null
	readonly localName?: string
	readonly childNodes: ArrayLike<ParsedNode>
	readonly style?: { readonly fontWeight?: string; readonly fontStyle?: string; readonly textDecoration?: string }
	getAttribute?(name: string): string | null
}

// Bold, italic, underline, strike: on, or off when unset.
type PasteMarks = readonly [boolean, boolean, boolean, boolean]

const NO_MARKS: PasteMarks = [false, false, false, false]

function pasteMarks(node: ParsedNode, tag: string, marks: PasteMarks): PasteMarks {
	let [bold, italic, underline, strike] = marks

	if (tag === "b" || tag === "strong") bold = true
	else if (tag === "i" || tag === "em") italic = true
	else if (tag === "u" || tag === "ins") underline = true
	else if (tag === "s" || tag === "del" || tag === "strike") strike = true

	const style = node.style

	if (style !== undefined) {
		const weight = style.fontWeight ?? ""

		// Google Docs wraps what it copies in <b style="font-weight:normal">.
		if (/^(bold|bolder|[6-9]00)$/.test(weight)) bold = true
		else if (/^(normal|lighter|[1-5]00)$/.test(weight)) bold = false

		const fontStyle = style.fontStyle ?? ""

		if (fontStyle === "italic" || fontStyle === "oblique") italic = true
		else if (fontStyle === "normal") italic = false

		const decoration = style.textDecoration ?? ""

		if (decoration.includes("underline")) underline = true
		if (decoration.includes("line-through")) strike = true
	}

	return bold === marks[0] && italic === marks[1] && underline === marks[2] && strike === marks[3]
		? marks
		: [bold, italic, underline, strike]
}

function marked(html: string, marks: PasteMarks): string {
	let open = ""
	let close = ""

	for (let k = 0; k < MARK_TAGS.length; k++) {
		if (!marks[k]) continue

		open += `<${MARK_TAGS[k] ?? ""}>`
		close = `</${MARK_TAGS[k] ?? ""}>` + close
	}

	return open + html + close
}

interface PasteBlock {
	readonly inline: string
	readonly pre: boolean
}

// Collects the paragraphs of a piece of HTML: inline content accumulates until a block boundary.
class PasteBlocks {
	readonly blocks: PasteBlock[] = []
	private inline = ""
	// The inline content holds more than collapsible white space.
	private content = false
	private pre = 0

	add(parent: ParsedNode, marks: PasteMarks): void {
		const children = parent.childNodes

		for (let k = 0; k < children.length; k++) {
			const child = children[k]

			if (child === undefined) continue

			if (child.nodeType === 3) {
				this.text(child.nodeValue ?? "", marks)

				continue
			}

			if (child.nodeType !== 1) continue

			const tag = child.localName ?? ""

			if (PASTE_DROPPED.has(tag)) continue

			const inner = pasteMarks(child, tag, marks)

			if (tag === "br") {
				this.inline += marked("<br>", inner)
				this.content = true
			} else if (tag === "table") {
				this.flush(false)
				this.table(child, inner)
			} else if (PASTE_BLOCKS.has(tag)) {
				this.block(child, tag, inner)
			} else if (tag === "span" && this.symbol(child, inner)) {
				this.content = true
			} else {
				const tabs = MSO_TABS.exec(child.getAttribute?.("style") ?? "")

				if (tabs === null) {
					this.add(child, inner)
				} else {
					this.inline += marked(`<span ${PASTE_TAB}></span>`.repeat(Math.min(Number(tabs[1]), 16)), inner)
					this.content = true
				}
			}
		}
	}

	// A symbol this editor copied, rebuilt from its code and font alone (its text is the character shown); false for
	// any other span.
	private symbol(node: ParsedNode, marks: PasteMarks): boolean {
		const code = node.getAttribute?.(PASTE_SYMBOL) ?? null

		if (code === null || !/^[0-9]{1,7}$/.test(code) || !symbolCode(Number(code))) return false

		const font = node.getAttribute?.(PASTE_SYMBOL_FONT) ?? null
		const fontAttr =
			font === null || font.length === 0 || font.length > MAX_SYMBOL_FONT
				? ""
				: ` ${PASTE_SYMBOL_FONT}="${font.replace(/[&<>"]/g, c => ESCAPED[c] ?? c)}"`

		this.inline += marked(`<span ${PASTE_SYMBOL}="${code}"${fontAttr}></span>`, marks)

		return true
	}

	// What is left once the source is read.
	finish(): PasteBlock[] {
		this.flush(false)

		return this.blocks
	}

	private text(value: string, marks: PasteMarks): void {
		if (value.length === 0) return

		if (this.pre === 0 && !/[^ \t\r\n\f]/.test(value)) {
			// White space only: a separator, never a paragraph of its own.
			if (this.inline.length > 0) this.inline += " "

			return
		}

		if (this.pre > 0) {
			// Preformatted text keeps its lines (a paragraph each, as a plain-text paste makes them) and tabs.
			const lines = value.split(/\r\n?|\n/)

			lines.forEach((line, k) => {
				if (k > 0) this.flush(true)

				if (line.length === 0) return

				this.inline += marked(
					line
						.split("\t")
						.map(part => part.replace(/[&<>]/g, c => ESCAPED[c] ?? c))
						.join(`<span ${PASTE_TAB}></span>`),
					marks
				)
				this.content = true
			})

			return
		}

		this.inline += marked(
			value.replace(/[&<>]/g, c => ESCAPED[c] ?? c),
			marks
		)
		this.content = true
	}

	private block(node: ParsedNode, tag: string, marks: PasteMarks): void {
		this.flush(false)

		const before = this.blocks.length

		if (tag === "pre") this.pre++

		this.add(node, marks)

		const paragraph = PASTE_PARAGRAPHS.has(tag)

		this.flush(paragraph && this.blocks.length === before)

		if (tag === "pre") this.pre--
	}

	// A paragraph per row, cells separated by tabs.
	private table(node: ParsedNode, marks: PasteMarks): void {
		const rows: { row: ParsedNode; marks: PasteMarks }[] = []
		const findRows = (parent: ParsedNode, inherited: PasteMarks): void => {
			const children = parent.childNodes

			for (let k = 0; k < children.length; k++) {
				const child = children[k]
				const tag = child?.localName ?? ""

				if (child === undefined || child.nodeType !== 1 || PASTE_DROPPED.has(tag)) continue

				const inner = pasteMarks(child, tag, inherited)

				if (tag === "tr") rows.push({ row: child, marks: inner })
				else if (tag === "thead" || tag === "tbody" || tag === "tfoot") findRows(child, inner)
				else if (tag === "caption") this.block(child, tag, inner)
			}
		}

		findRows(node, marks)

		for (const { row, marks: rowMarks } of rows) {
			const cells: string[] = []
			const children = row.childNodes

			for (let k = 0; k < children.length; k++) {
				const cell = children[k]
				const tag = cell?.localName ?? ""

				if (cell === undefined || (tag !== "td" && tag !== "th")) continue

				const inner = new PasteBlocks()

				inner.pre = this.pre
				inner.add(cell, pasteMarks(cell, tag, rowMarks))
				cells.push(
					inner
						.finish()
						.map(block => block.inline)
						.join("<br>")
				)
			}

			this.blocks.push({ inline: cells.join(`<span ${PASTE_TAB}></span>`), pre: this.pre > 0 })
		}
	}

	// Ends the paragraph being collected: kept when it has content (a lone line break or no-break space is an
	// empty paragraph, as editors write one) or when `empty` asks for it.
	private flush(empty: boolean): void {
		if (this.content || empty) {
			// A line break that ends a block adds no line (as HTML shows it).
			const inline = this.inline.replace(/(?:<[bius]>)*<br>(?:<\/[bius]>)*\s*$/, "")

			this.blocks.push({ inline: /^\s*$/.test(inline) ? "" : inline, pre: this.pre > 0 })
		}

		this.inline = ""
		this.content = false
	}
}

export function safeClipboardHtml(html: string): string {
	const Parser: unknown = Reflect.get(globalThis, "DOMParser")

	if (typeof Parser !== "function") return ""

	const parsed = new (Parser as new () => { parseFromString(source: string, type: string): ParsedHtml })().parseFromString(
		html,
		"text/html"
	)

	if (parsed.body === null) return ""

	const blocks = new PasteBlocks()

	blocks.add(parsed.body, NO_MARKS)

	return blocks
		.finish()
		.map(block => (block.pre ? `<pre>${block.inline}</pre>` : `<p>${block.inline}</p>`))
		.join("")
}

// Leaves as plain text (what a copy writes and assistive technology reads).
const PLAIN_LEAVES: Record<string, (node: Node) => string> = {
	tab: () => "\t",
	break: () => "\n",
	hyphen: node => (node.attrs["soft"] === true ? "" : "\u2011"),
	symbol: symbolText,
	run_object: attrText("text"),
	field: fieldText,
	opaque_inline: attrText("text")
}
const plainLeaf = (node: Node): string => PLAIN_LEAVES[node.type.name]?.(node) ?? ""

// ---- what the revision view shows -----------------------------------------------------------------------------

// The marks of text revision view `view` hides: deletions in the Final view (No Markup), insertions in the
// Original view, none in Markup (which shows and copies tracked changes as they are).
export function hiddenMarks(view: RevisionView): readonly MarkType[] {
	if (view === RevisionView.Final) return [docxSchema.marks.deletion, docxSchema.marks.move_from]
	if (view === RevisionView.Original) return [docxSchema.marks.insertion, docxSchema.marks.move_to]

	return []
}

function hiddenBy(node: Node, hidden: readonly MarkType[]): boolean {
	return node.isInline && node.marks.some(mark => hidden.includes(mark.type))
}

// A tracked row or cell `view` does not show (a deleted one in Final, an inserted one in Original).
function rowOrCellHidden(node: Node, view: RevisionView): boolean {
	return (node.type === nodes.table_row || node.type === nodes.table_cell) && revisionHidden(node.attrs["revision"] as number, view)
}

// A paragraph whose mark `view` does not show: it runs on into the next paragraph there.
function markHidden(node: Node, view: RevisionView): boolean {
	return node.type === nodes.paragraph && revisionHidden(node.attrs["revision"] as number, view)
}

// `fragment` as revision view `view` shows it: without the inline content `hidden` marks and the rows and cells
// the view leaves out, a paragraph whose mark it leaves out joined to the next (which keeps its mark).
function shownFragment(fragment: Fragment, view: RevisionView, hidden: readonly MarkType[]): Fragment {
	let changed = false
	const children: Node[] = []
	// A paragraph whose mark is not shown, waiting for the next paragraph to run on into.
	let pending: { readonly node: Node; readonly content: Fragment } | undefined
	const flush = (): void => {
		if (pending !== undefined) children.push(pending.node.copy(pending.content))

		pending = undefined
	}

	fragment.forEach(child => {
		if (hiddenBy(child, hidden) || rowOrCellHidden(child, view)) {
			changed = true

			return
		}

		let content = child.isLeaf || child.isText ? child.content : shownFragment(child.content, view, hidden)

		if (content !== child.content) changed = true

		// A table row without a cell shown, or a table without a row: none.
		if (content.childCount === 0 && (child.type === nodes.table_row || child.type === nodes.table)) {
			changed = true

			return
		}

		if (pending !== undefined && child.isTextblock) {
			content = pending.content.append(content)
			pending = undefined
		} else flush()

		if (markHidden(child, view)) {
			pending = { node: child, content }
			changed = true

			return
		}

		children.push(content === child.content ? child : child.copy(content))
	})
	// The run-on text with no paragraph after it here stays a paragraph of its own.
	flush()

	return changed ? Fragment.from(children) : fragment
}

// A copied slice as revision view `view` shows it: text it hides is left out (none in Markup).
export function shownSlice(slice: Slice, view: RevisionView): Slice {
	if (view === RevisionView.Markup) return slice

	const content = shownFragment(slice.content, view, hiddenMarks(view))

	return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd)
}

// [from, to) of a textblock's content as plain text, leaving out what `hidden` marks.
function shownText(block: Node, from: number, to: number, hidden: readonly MarkType[]): string {
	if (hidden.length === 0) return block.textBetween(from, to, undefined, plainLeaf)

	let out = ""

	block.forEach((child, at) => {
		const end = at + child.nodeSize

		if (end <= from || at >= to || hiddenBy(child, hidden)) return

		out += child.isText ? (child.text ?? "").slice(Math.max(0, from - at), Math.min(child.nodeSize, to - at)) : plainLeaf(child)
	})

	return out
}

// [from, to) of `doc` as plain text, as Word copies it: paragraphs on lines of their own (empty ones
// kept), a table's cells separated by tabs and its rows by line breaks, list numbers as text. What revision view
// `view` hides is left out: text, rows and cells, and paragraph marks (the next paragraph runs on).
export function plainText(
	doc: Node,
	from: number,
	to: number,
	marker: (pos: number) => string,
	view: RevisionView = RevisionView.Markup
): string {
	const hidden = hiddenMarks(view)
	const blocks = (parent: Node, offset: number, out: string[]): string[] => {
		// The previous paragraph's mark is not shown: this one's text runs on from it.
		let runOn = false

		parent.forEach((child, at) => {
			const pos = offset + at
			const end = pos + child.nodeSize

			if (end <= from || pos >= to) return

			const joins = runOn

			runOn = false

			if (child.isTextblock) {
				const a = Math.max(from, pos + 1) - pos - 1
				const b = Math.max(a, Math.min(to, end - 1) - pos - 1)
				const prefix = from <= pos + 1 && to > pos + 1 ? marker(pos + 1) : ""
				const text = prefix + shownText(child, a, b, hidden)

				if (joins && out.length > 0) out[out.length - 1] += text
				else out.push(text)

				runOn = markHidden(child, view)
			} else if (child.type === nodes.table) {
				child.forEach((row, rowAt) => {
					const rowPos = pos + 1 + rowAt

					if (rowPos + row.nodeSize <= from || rowPos >= to || rowOrCellHidden(row, view)) return

					const cells: string[] = []

					row.forEach((cell, cellAt) => {
						const cellPos = rowPos + 1 + cellAt

						if (cellPos + cell.nodeSize > from && cellPos < to && !rowOrCellHidden(cell, view))
							cells.push(blocks(cell, cellPos + 1, []).join("\n"))
					})

					if (cells.length > 0) out.push(cells.join("\t"))
				})
			} else if (child.type === nodes.locked_block) {
				out.push(attrText("text")(child))
			} else {
				blocks(child, pos + 1, out)
			}
		})

		return out
	}

	return blocks(doc, 0, []).join("\n")
}

// Without the control characters XML cannot hold (tabs and vertical tabs become nodes).
function withoutControls(text: string): string {
	let out = ""
	let last = 0

	for (let k = 0; k < text.length; k++) {
		const c = text.charCodeAt(k)

		if (c < 0x20 && c !== 0x09 && c !== 0x0b) {
			out += text.slice(last, k)
			last = k + 1
		}
	}

	return last === 0 ? text : out + text.slice(last)
}

// Pasted plain text: one paragraph per line (empty lines kept), tabs and vertical tabs (Word's line breaks)
// as nodes, formatted as the text at the insertion point.
export function plainSlice(text: string, $context: ResolvedPos): Slice {
	const marks = $context.marks()
	const paragraphs = text.split(/\r\n?|\n/).map(line => {
		const inline: Node[] = []
		const parts = withoutControls(line).split(/([\t\v])/)

		for (const part of parts) {
			if (part === "\t") inline.push(nodes.tab.create(null, null, marks))
			else if (part === "\v") inline.push(nodes.break.create({ type: "textWrapping" }, null, marks))
			else if (part.length > 0) inline.push(docxSchema.text(part, marks))
		}

		return nodes.paragraph.create(null, inline)
	})

	return new Slice(Fragment.from(paragraphs), 1, 1)
}

const COMMENT_MARKERS: ReadonlySet<unknown> = new Set(["commentRangeStart", "commentRangeEnd"])

// Ids of the comments anchored in `fragment` (ranges, references, marker lists of blocks).
export function commentIds(fragment: Fragment): string[] {
	const out = new Set<string>()
	const list = (value: unknown): void => {
		if (!Array.isArray(value)) return

		for (const marker of value as MarkerList)
			if (COMMENT_MARKERS.has(marker.kind) || marker.kind === "commentReference") if (marker.id !== null) out.add(marker.id)
	}

	fragment.descendants(node => {
		const id: unknown = node.attrs["id"]

		if (
			node.type === docxSchema.nodes.comment_ref ||
			(node.type === docxSchema.nodes.marker && COMMENT_MARKERS.has(node.attrs["kind"]))
		) {
			if (typeof id === "string") out.add(id)
		}

		list(node.attrs["before"])
		list(node.attrs["end"])

		return true
	})

	return [...out]
}

const CUTS = new WeakMap<object, CutMemory>()

// The cut memory of an editor's views (the pages' input view and Mobile view share it: a cut in one pastes back
// in the other).
export function cutMemory(editor: PagedEditor): CutMemory {
	let memory = CUTS.get(editor)

	if (memory === undefined) {
		memory = new CutMemory()
		CUTS.set(editor, memory)
	}

	return memory
}

// What the last cut took out with comment anchors in it: pasted back as text of the same clipboard, it moves the
// comments (as in Word) rather than leaving them out.
export class CutMemory {
	private cut:
		{ readonly session: DocxEditorSession; readonly text: string; readonly slice: Slice; readonly ids: readonly string[] } | undefined

	forget(): void {
		this.cut = undefined
	}

	// Keeps `session`'s selection as it is about to be cut when it holds comment anchors; `text` is what the cut
	// writes as text (the slice's own when not given).
	remember(session: DocxEditorSession, text: (slice: Slice) => string): void {
		const slice = session.state.selection.content()
		const ids = commentIds(slice.content)

		this.cut = ids.length === 0 ? undefined : { session, text: text(slice), slice, ids }
	}

	// The last cut pasted into `target`'s selection as it was, comment anchors included, when `text` is what it
	// wrote and its comments are anchored nowhere now (the cut took them out, untracked, and no paste put them
	// back): the comments move, also into another story (as in Word). Once only; undefined for anything else
	// (it pastes as usual).
	take(editor: PagedEditor, target: DocxEditorSession, text: string | undefined): Transaction | undefined {
		const cut = this.cut

		if (cut === undefined || text === undefined) return undefined

		this.cut = undefined

		const comments = docxComments(editor)

		if (text.replace(/\r\n?/g, "\n") !== cut.text.replace(/\r\n?/g, "\n") || cut.ids.some(id => comments.comment(id) !== undefined))
			return undefined

		// Into another part, the cut's source identities are not that part's: new content, the anchors kept.
		const slice =
			target.story.part === cut.session.story.part
				? cut.slice
				: freshSliceKeeping(
						cut.slice,
						new Set(
							cut.ids.flatMap(id => ["commentRangeStart", "commentRangeEnd", "commentReference"].map(kind => `${kind}:${id}`))
						),
						sourceCopies(cut.session.context),
						cut.session.story.part.index,
						target.story.part.index,
						target.story.story.kind === "body"
					)

		return target.state.tr.replaceSelection(slice).scrollIntoView().setMeta("uiEvent", "paste").setMeta(COMMENT_MOVE_META, cut.ids)
	}
}

// Writes `content` to a copy or cut event's clipboard instead of the browser's own copy; false without one.
export function writeClipboardEvent(event: ClipboardEvent, content: { readonly html: string; readonly text: string } | undefined): boolean {
	const data = event.clipboardData

	if (data === null || content === undefined) return false

	event.preventDefault()
	data.clearData()
	data.setData("text/html", content.html)
	data.setData("text/plain", content.text)

	return true
}
