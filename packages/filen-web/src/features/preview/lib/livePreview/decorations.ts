import { syntaxTree } from "@codemirror/language"
import type { EditorState, Range } from "@codemirror/state"
import { Decoration, type DecorationSet } from "@codemirror/view"
import {
	BULLET,
	CheckboxWidget,
	EmbedWidget,
	FenceLabelWidget,
	ImageWidget,
	TableWidget,
	type EmbedRenderer,
	type InlineRun,
	type TableAlign,
	type TableModel
} from "@/features/preview/lib/livePreview/widgets"

// The live preview's decorations for one stretch of the document (the viewport and a margin, livePreview.ts), read
// from the markdown syntax tree: the text keeps its source, styled in place, its syntax marks hidden (or drawn as a
// widget: a bullet, a task box, an image, a table) except where the selection touches them. Pure: the same state,
// stretch and config give the same set.

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"]

export interface LivePreviewConfig {
	// The URL an image loads from, or null to name it instead (the host's Read view policy).
	readonly image: (url: string) => string | null
	// Opens a link's URL as written (Mod+click), through the host's link policy and trust confirmation.
	readonly openLink: (url: string) => void
	readonly labels: {
		readonly imageNotLoaded: (alt: string) => string
		readonly task: string
		readonly openLink: string
	}
	// Formulas ($…$, $$…$$, ```math fences) and ```mermaid fences, where the host's Read view draws them.
	readonly math: EmbedRenderer | null
	readonly mermaid: EmbedRenderer | null
}

export interface LivePreviewBlock {
	readonly from: number
	readonly to: number
}

export interface LivePreviewDecorations {
	readonly decorations: DecorationSet
	// The ranges drawn as one block widget (a table, a diagram, a display formula): the cursor keys step into them.
	readonly blocks: readonly LivePreviewBlock[]
}

const HIDE = Decoration.replace({})

const MARKS = {
	strong: Decoration.mark({ class: "cm-lp-strong" }),
	em: Decoration.mark({ class: "cm-lp-em" }),
	strike: Decoration.mark({ class: "cm-lp-strike" }),
	code: Decoration.mark({ class: "cm-lp-code" }),
	footnote: Decoration.mark({ class: "cm-lp-footnote" }),
	definition: Decoration.mark({ class: "cm-lp-definition" }),
	listNumber: Decoration.mark({ class: "cm-lp-list-number" })
}

const lineDecorations = new Map<string, Decoration>()

function lineDecoration(className: string): Decoration {
	let decoration = lineDecorations.get(className)

	if (decoration === undefined) {
		decoration = Decoration.line({ class: className })
		lineDecorations.set(className, decoration)
	}

	return decoration
}

// Per config: the link mark carries its "Mod+click to open" hint.
const linkMarks = new WeakMap<LivePreviewConfig, Decoration>()

function linkMark(config: LivePreviewConfig): Decoration {
	let decoration = linkMarks.get(config)

	if (decoration === undefined) {
		decoration = Decoration.mark({ class: "cm-lp-link", attributes: { title: config.labels.openLink } })
		linkMarks.set(config, decoration)
	}

	return decoration
}

// Nodes whose insides the preview leaves alone: raw HTML, and code (its own grammar highlights it).
const OPAQUE = new Set(["HTMLBlock", "HTMLTag", "Comment", "CommentBlock", "ProcessingInstructionBlock", "ProcessingInstruction"])

// Marks a table cell's text drops (the Read view shows none of them).
const CELL_MARKS = new Set(["EmphasisMark", "StrikethroughMark", "SubscriptMark", "CodeMark", "LinkMark", "URL", "LinkTitle", "LinkLabel"])

const PLAIN: InlineRun = { text: "", strong: false, em: false, strike: false, code: false, link: false }

// Inline math as GitHub reads it (remarkGuardedMath): the formula hugs its dollar signs and no digit follows.
const INLINE_MATH = /(?<![\\$])(\$\$?)(?![\s$])((?:[^$\\\n]|\\.)+?)(?<!\s)\1(?![\d$])/g

class Builder {
	readonly ranges: Range<Decoration>[] = []
	readonly blocks: LivePreviewBlock[] = []
	// Ranges a formula took over: nothing else decorates inside them.
	private readonly covered: LivePreviewBlock[] = []

	readonly state: EditorState
	readonly from: number
	readonly to: number
	readonly reveal: boolean
	readonly config: LivePreviewConfig

	constructor(state: EditorState, from: number, to: number, reveal: boolean, config: LivePreviewConfig) {
		this.state = state
		this.from = from
		this.to = to
		this.reveal = reveal
		this.config = config
	}

	// The selection touches [from, to] (its ends included); never before the editor was first focused.
	touches(from: number, to: number): boolean {
		return this.reveal && this.state.selection.ranges.some(range => range.from <= to && range.to >= from)
	}

	touchesLine(pos: number): boolean {
		const line = this.state.doc.lineAt(pos)

		return this.touches(line.from, line.to)
	}

	isCovered(pos: number): boolean {
		return this.covered.some(range => pos >= range.from && pos < range.to)
	}

	add(decoration: Decoration, from: number, to: number): void {
		if (to > from) {
			this.ranges.push(decoration.range(from, to))
		}
	}

	hide(from: number, to: number): void {
		this.add(HIDE, from, to)
	}

	line(pos: number, className: string): void {
		this.ranges.push(lineDecoration(className).range(this.state.doc.lineAt(pos).from))
	}

	// Each line of [from, to] within the stretch.
	lines(from: number, to: number, className: string): void {
		const doc = this.state.doc
		const last = doc.lineAt(Math.min(to, this.to)).number

		for (let number = doc.lineAt(Math.max(from, this.from)).number; number <= last; number++) {
			this.ranges.push(lineDecoration(className).range(doc.line(number).from))
		}
	}

	// A block widget covers whole lines only (CodeMirror's rule); a table nested in a list item stays source.
	blockable(node: SyntaxNode): boolean {
		const doc = this.state.doc

		return doc.lineAt(node.from).from === node.from && doc.lineAt(node.to).to === node.to
	}

	block(from: number, to: number, widget: TableWidget | EmbedWidget): void {
		this.ranges.push(Decoration.replace({ widget, block: true }).range(from, to))
		this.blocks.push({ from, to })
	}

	// The node's marks (by name), hidden.
	hideMarks(node: SyntaxNode, name: string): void {
		for (const mark of node.getChildren(name)) {
			this.hide(mark.from, mark.to)
		}
	}

	visit(node: SyntaxNode): boolean {
		if (this.isCovered(node.from)) {
			return false
		}

		const name = node.name

		if (OPAQUE.has(name)) {
			return false
		}

		if (name.startsWith("ATXHeading")) {
			this.heading(node, Number(name.slice("ATXHeading".length)))

			return true
		}

		switch (name) {
			case "SetextHeading1":
			case "SetextHeading2":
				this.setext(node, name === "SetextHeading1" ? 1 : 2)

				return true
			case "Emphasis":
				this.inline(node, MARKS.em, "EmphasisMark")

				return true
			case "StrongEmphasis":
				this.inline(node, MARKS.strong, "EmphasisMark")

				return true
			case "Strikethrough":
				this.inline(node, MARKS.strike, "StrikethroughMark")

				return true
			// A single tilde strikes through in the Read view (GFM's), where the grammar reads a subscript.
			case "Subscript":
				this.inline(node, MARKS.strike, "SubscriptMark")

				return true
			case "InlineCode":
				this.inlineCode(node)

				return false
			case "Link":
				this.link(node)

				return true
			case "Image":
				this.image(node)

				return false
			case "Autolink":
				this.autolink(node)

				return false
			case "URL":
				this.add(linkMark(this.config), node.from, node.to)

				return false
			case "Escape":
				if (!this.touches(node.from, node.to)) {
					this.hide(node.from, node.from + 1)
				}

				return false
			case "Blockquote":
				this.lines(node.from, node.to, "cm-lp-quote")

				return true
			case "QuoteMark":
				this.quoteMark(node)

				return false
			case "HorizontalRule":
				this.line(node.from, "cm-lp-hr")

				if (!this.touchesLine(node.from)) {
					this.hide(node.from, node.to)
				}

				return false
			case "ListMark":
				this.listMark(node)

				return false
			case "TaskMarker":
				this.taskMarker(node)

				return false
			case "FencedCode":
				this.fence(node)

				return false
			case "CodeBlock":
				this.lines(node.from, node.to, "cm-lp-codeblock")

				return false
			case "Table":
				this.table(node)

				return false
			case "LinkReference":
				this.add(MARKS.definition, node.from, node.to)

				return false
			case "Paragraph":
				return this.paragraph(node)
			default:
				return true
		}
	}

	heading(node: SyntaxNode, level: number): void {
		this.line(node.from, `cm-lp-heading cm-lp-h${String(level)}`)

		if (this.touchesLine(node.from)) {
			return
		}

		const line = this.state.doc.lineAt(node.from)
		const text = line.text

		for (const mark of node.getChildren("HeaderMark")) {
			if (mark.from === node.from) {
				let end = mark.to

				while (end < line.to && (text.charCodeAt(end - line.from) === 32 || text.charCodeAt(end - line.from) === 9)) {
					end++
				}

				this.hide(mark.from, end)
			} else {
				let start = mark.from

				while (start > line.from && text.charCodeAt(start - 1 - line.from) === 32) {
					start--
				}

				this.hide(start, mark.to)
			}
		}
	}

	setext(node: SyntaxNode, level: number): void {
		const mark = node.getChild("HeaderMark")
		const textEnd = mark === null ? node.to : mark.from - 1

		this.lines(node.from, Math.max(node.from, textEnd), `cm-lp-heading cm-lp-h${String(level)}`)

		if (mark !== null) {
			this.line(mark.from, "cm-lp-setext-mark")

			if (!this.touches(node.from, node.to)) {
				this.hide(mark.from, mark.to)
			}
		}
	}

	inline(node: SyntaxNode, mark: Decoration, markName: string): void {
		this.add(mark, node.from, node.to)

		if (!this.touches(node.from, node.to)) {
			this.hideMarks(node, markName)
		}
	}

	inlineCode(node: SyntaxNode): void {
		const marks = node.getChildren("CodeMark")
		const open = marks[0]
		const close = marks[1]

		if (open === undefined || close === undefined) {
			return
		}

		this.add(MARKS.code, open.to, close.from)

		if (!this.touches(node.from, node.to)) {
			this.hide(open.from, open.to)
			this.hide(close.from, close.to)
		}
	}

	link(node: SyntaxNode): void {
		const marks = node.getChildren("LinkMark")
		const open = marks[0]
		const close = marks[1]

		if (open === undefined || close === undefined) {
			return
		}

		const footnote = this.state.sliceDoc(open.from, open.to + 1) === "[^"

		this.add(footnote ? MARKS.footnote : linkMark(this.config), open.to, close.from)

		if (!this.touches(node.from, node.to)) {
			this.hide(open.from, footnote ? open.to + 1 : open.to)
			// "](url "title")", "][label]" or the bare "]".
			this.hide(close.from, node.to)
		}
	}

	image(node: SyntaxNode): void {
		if (this.touches(node.from, node.to)) {
			return
		}

		const close = node.getChildren("LinkMark")[1]
		const url = node.getChild("URL")
		const alt = close === undefined ? "" : this.state.sliceDoc(node.from + 2, close.from)
		const written = url === null ? "" : this.state.sliceDoc(url.from, url.to).replace(/^<(.*)>$/, "$1")
		const src = written === "" ? null : this.config.image(written)

		this.add(Decoration.replace({ widget: new ImageWidget(src, alt, this.config.labels.imageNotLoaded(alt)) }), node.from, node.to)
	}

	autolink(node: SyntaxNode): void {
		const url = node.getChild("URL")

		if (url !== null) {
			this.add(linkMark(this.config), url.from, url.to)
		}

		if (!this.touches(node.from, node.to)) {
			this.hideMarks(node, "LinkMark")
		}
	}

	quoteMark(node: SyntaxNode): void {
		if (this.touchesLine(node.from)) {
			return
		}

		const after = this.state.sliceDoc(node.to, node.to + 1)

		this.hide(node.from, after === " " ? node.to + 1 : node.to)
	}

	listMark(node: SyntaxNode): void {
		const item = node.parent
		const task = item?.getChild("Task")?.getChild("TaskMarker") ?? null

		if (task !== null) {
			// The box takes the bullet's place.
			if (!this.touches(node.from, task.to)) {
				this.hide(node.from, task.from)
			}

			return
		}

		if (item?.parent?.name === "OrderedList") {
			this.add(MARKS.listNumber, node.from, node.to)

			return
		}

		if (!this.touches(node.from, node.to + 1)) {
			this.add(Decoration.replace({ widget: BULLET }), node.from, node.to)
		}
	}

	taskMarker(node: SyntaxNode): void {
		const listMark = node.parent?.parent?.getChild("ListMark") ?? null

		if (this.touches(listMark?.from ?? node.from, node.to)) {
			return
		}

		const checked = this.state.sliceDoc(node.from + 1, node.from + 2).toLowerCase() === "x"
		const widget = new CheckboxWidget(checked, this.state.readOnly, this.config.labels.task)

		this.add(Decoration.replace({ widget }), node.from, node.to)
	}

	fence(node: SyntaxNode): void {
		const doc = this.state.doc
		const first = doc.lineAt(node.from)
		const last = doc.lineAt(node.to)
		const opening = first.text.slice(node.from - first.from)
		const marker = /^(`{3,}|~{3,})\s*([^\s`]*)/.exec(opening)
		const language = marker?.[2] ?? ""
		const closed = last.number > first.number && last.text.trim().startsWith(marker?.[1] ?? "```")
		const touched = this.touches(node.from, node.to)

		// A ```mermaid fence is a diagram, a ```math one display math (as on GitHub).
		const kind = language.toLowerCase()
		const embed = kind === "mermaid" ? this.config.mermaid : kind === "math" ? this.config.math : null

		if (!touched && embed !== null && closed && this.blockable(node)) {
			const source = doc.sliceString(first.to + 1, last.from - 1)

			this.block(node.from, node.to, new EmbedWidget(source, true, embed, kind === "mermaid" ? 200 : 48))

			return
		}

		this.lines(node.from, node.to, "cm-lp-fence")
		this.line(first.from, "cm-lp-fence-start")

		if (closed) {
			this.line(last.from, "cm-lp-fence-end")
		}

		if (touched) {
			return
		}

		this.add(language === "" ? HIDE : Decoration.replace({ widget: new FenceLabelWidget(language) }), node.from, first.to)

		if (closed) {
			this.hide(last.from + (last.text.length - last.text.trimStart().length), last.to)
		}
	}

	table(node: SyntaxNode): void {
		if (this.touches(node.from, node.to) || !this.blockable(node)) {
			this.lines(node.from, node.to, "cm-lp-table-source")

			return
		}

		this.block(node.from, node.to, new TableWidget(this.state.sliceDoc(node.from, node.to), this.tableModel(node)))
	}

	tableModel(node: SyntaxNode): TableModel {
		const header = node.getChild("TableHeader")
		const columns = header === null ? [] : this.rowCells(header)
		const width = columns.length
		const delimiter = node.getChildren("TableDelimiter").find(child => this.state.doc.lineAt(child.from).from === child.from)
		const align = delimiter === undefined ? [] : this.alignments(this.state.doc.lineAt(delimiter.from).text)
		const rows = node.getChildren("TableRow").map(row => {
			const cells = this.rowCells(row).slice(0, width)

			while (cells.length < width) {
				cells.push([])
			}

			return cells
		})

		return { align: align.slice(0, width), header: columns, rows }
	}

	alignments(text: string): TableAlign[] {
		return text
			.trim()
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map(spec => {
				const cell = spec.trim()
				const left = cell.startsWith(":")
				const right = cell.endsWith(":")

				return left && right ? "center" : right ? "right" : left ? "left" : null
			})
	}

	// A row's cells, split at its pipes (an empty cell has no node of its own).
	rowCells(row: SyntaxNode): InlineRun[][] {
		const pipes = row.getChildren("TableDelimiter")
		const cells: InlineRun[][] = []
		let start = row.from

		const push = (from: number, to: number): void => {
			const cell = row.getChildren("TableCell").find(child => child.from >= from && child.to <= to)

			cells.push(cell === undefined ? [] : this.runs(cell, cell.from, cell.to, PLAIN))
		}

		for (const pipe of pipes) {
			// A leading pipe opens the first cell.
			if (pipe.from !== row.from) {
				push(start, pipe.from)
			}

			start = pipe.to
		}

		if (this.state.sliceDoc(start, row.to).trim() !== "") {
			push(start, row.to)
		}

		return cells
	}

	runs(node: SyntaxNode, from: number, to: number, style: InlineRun): InlineRun[] {
		const out: InlineRun[] = []
		let pos = from

		const text = (start: number, end: number): void => {
			if (end > start) {
				out.push({ ...style, text: this.state.sliceDoc(start, end) })
			}
		}

		for (let child = node.firstChild; child !== null; child = child.nextSibling) {
			if (child.from >= to) {
				break
			}

			text(pos, child.from)
			pos = child.to

			if (CELL_MARKS.has(child.name)) {
				continue
			}

			switch (child.name) {
				case "Escape":
					text(child.from + 1, child.to)
					break
				case "Emphasis":
					out.push(...this.runs(child, child.from, child.to, { ...style, em: true }))
					break
				case "StrongEmphasis":
					out.push(...this.runs(child, child.from, child.to, { ...style, strong: true }))
					break
				case "Strikethrough":
				case "Subscript":
					out.push(...this.runs(child, child.from, child.to, { ...style, strike: true }))
					break
				case "InlineCode": {
					const marks = child.getChildren("CodeMark")
					const start = marks[0]?.to ?? child.from
					const end = marks[1]?.from ?? child.to

					if (end > start) {
						out.push({ ...style, code: true, text: this.state.sliceDoc(start, end) })
					}

					break
				}
				case "Link": {
					const close = child.getChildren("LinkMark")[1]

					out.push(...this.runs(child, child.from + 1, close?.from ?? child.to, { ...style, link: true }))
					break
				}
				case "Image": {
					const close = child.getChildren("LinkMark")[1]

					text(child.from + 2, close?.from ?? child.to)
					break
				}
				default:
					text(child.from, child.to)
			}
		}

		text(pos, to)

		return out
	}

	paragraph(node: SyntaxNode): boolean {
		const math = this.config.math

		if (math === null) {
			return true
		}

		const doc = this.state.doc
		const first = doc.lineAt(node.from)
		const last = doc.lineAt(node.to)

		// $$ on lines of their own around the formula: display math.
		if (last.number > first.number + 1 && first.text.trim() === "$$" && last.text.trim() === "$$") {
			if (!this.touches(node.from, node.to) && this.blockable(node)) {
				this.block(node.from, node.to, new EmbedWidget(doc.sliceString(first.to + 1, last.from - 1), true, math, 48))

				return false
			}

			return true
		}

		const text = this.state.sliceDoc(node.from, node.to)

		for (const match of text.matchAll(INLINE_MATH)) {
			const from = node.from + match.index
			const to = from + match[0].length
			const inner = syntaxTree(this.state).resolveInner(from, 1)

			// Not inside code or a link's URL.
			if (inner.name === "CodeMark" || inner.name === "InlineCode" || inner.name === "CodeText" || inner.name === "URL") {
				continue
			}

			this.covered.push({ from, to })

			if (!this.touches(from, to)) {
				this.add(Decoration.replace({ widget: new EmbedWidget(match[2] ?? "", false, math, -1) }), from, to)
			}
		}

		return true
	}
}

// The decorations of [from, to] (nodes overlapping it are decorated whole). `reveal`: the selection shows the syntax
// it touches (false until the editor is first focused, so a document opens fully rendered).
export function buildLivePreview(
	state: EditorState,
	from: number,
	to: number,
	reveal: boolean,
	config: LivePreviewConfig
): LivePreviewDecorations {
	const builder = new Builder(state, from, to, reveal, config)

	syntaxTree(state).iterate({
		from,
		to,
		enter: node => builder.visit(node.node)
	})

	return { decorations: Decoration.set(builder.ranges, true), blocks: builder.blocks }
}
