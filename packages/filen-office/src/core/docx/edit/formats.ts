import type { Mark, MarkType, Node, ResolvedPos } from "prosemirror-model"
import type { EditorState, Transaction } from "prosemirror-state"
import { Item, type StoryPart } from "../model/index"
import {
	EMPTY_PARAGRAPH,
	type ParagraphProps,
	type ResolvedRunProps,
	type ParagraphBordersProps,
	type RunProps,
	type SpacingProps
} from "../props/index"
import type { Numbering, NumberingLevel } from "../numbering/index"
import type { ParagraphFormat } from "../styles/index"
import { HIGHLIGHT_COLORS } from "../theme/color"
import type { DocxHighlightColor } from "./commands/formatting"
import type { DocxEditContext } from "./context"
import { formattingMarks, runPropsOf } from "./formatting"
import { MarkChanges, MarkSetChanges, sameSet } from "./marks"
import { holdsFormatting } from "../fields/format"
import { FORMATTING_MARKS, NO_SOURCE, docxSchema, inlineLevel, type ColorAttrs, type IndentAttrs } from "./schema"

const NO_MARKS: readonly Mark[] = []

// The marks text typed at the caret takes: the stored marks, else, in a paragraph holding no content, its
// paragraph mark's (FormatResolver.emptyParagraphMarks), else the caret's.
export function caretMarks(state: EditorState, formats: FormatResolver): readonly Mark[] {
	const $from = state.selection.$from

	return state.storedMarks ?? formats.emptyParagraphMarks($from) ?? $from.marks()
}

export type ListKind = "bullet" | "numbered"

// A list a command started: its kind, and the existing w:num whose definition (w:abstractNum) the new
// w:num takes over, restarting the count; null for a new definition.
export interface NewList {
	readonly kind: ListKind
	readonly basedOn: number | null
	// A numbered list AutoFormat started from a typed number ("3. ", "b) "): its first level's format, the text
	// after the number and the first number, in a definition of its own.
	readonly first?: ListStart
}

export interface ListStart {
	readonly format: "decimal" | "lowerLetter" | "upperLetter" | "lowerRoman" | "upperRoman"
	readonly suffix: "." | ")"
	readonly start: number
}

export type RunToggle = "bold" | "italic" | "underline" | "strike"

export const RUN_TOGGLES: readonly RunToggle[] = ["bold", "italic", "underline", "strike"]
export const TOGGLE_ON = 1
export const TOGGLE_STYLE = 16

const marks = docxSchema.marks
const nodes = docxSchema.nodes
const NUMBERING_OFF = { numId: null, ilvl: null } as const
const NUMBERING_OFF_STYLED = { numId: 0, ilvl: null } as const
const PROPERTY_TYPES: ReadonlySet<MarkType> = new Set(FORMATTING_MARKS.filter(name => name !== "plain").map(name => marks[name]))
const HIGHLIGHT_NAMES = new Map(Object.entries(HIGHLIGHT_COLORS).map(([name, hex]) => [hex, name as DocxHighlightColor]))

// The formatting values of run content (what the toolbar shows and what value commands compare with).
// Interned: equal values are one object.
export interface RunValues {
	// The font of the content's script (w:ascii, or w:cs for complex script).
	readonly font: string
	// Half-points.
	readonly size: number
	// "auto", "RRGGBB" or "theme:<name>" with "/tint:<n>" or "/shade:<n>" (0–255) as the direct colour says;
	// what the styles give is "auto" or "RRGGBB".
	readonly color: string
	// The colour shown: "auto" or "RRGGBB".
	readonly colorRgb: string
	readonly highlight: DocxHighlightColor
	readonly vertAlign: "baseline" | "superscript" | "subscript"
	readonly strike: boolean
	readonly doubleStrike: boolean
	readonly caps: boolean
	readonly smallCaps: boolean
	// Character spacing, twips.
	readonly spacing: number
	// Complex script content (w:rtl or w:cs): size and font are the w:szCs and w:cs ones.
	readonly complex: boolean
}

interface Formatting {
	readonly props: RunProps
	// The character style alone.
	readonly style: RunProps
	// The source w:rPr marks complex script content (w:rtl, w:cs).
	readonly complexBase: boolean
	readonly color: string | undefined
	readonly values: Map<ParagraphFormat, RunValues>
	readonly styleValues: Map<ParagraphFormat, RunValues>
	// FormatResolver.toggles per paragraph format.
	readonly toggles: Map<ParagraphFormat, number>
}

interface TrieNode {
	// Weak: a path through marks no node carries any more (a tracked change's own marks, an edit's new ones) goes
	// with them; the formatting it led to stays, found by content.
	next: WeakMap<Mark, TrieNode> | undefined
	// Without and with a complex script base.
	readonly leaf: [Formatting | undefined, Formatting | undefined]
}

// The colour key of a direct w:color (see RunValues.color).
export function colorKey(attrs: ColorAttrs): string {
	if (attrs.themeColor !== null && attrs.themeColor !== "none") {
		const tone = attrs.themeTint !== null ? `/tint:${attrs.themeTint}` : attrs.themeShade !== null ? `/shade:${attrs.themeShade}` : ""

		return `theme:${attrs.themeColor}${tone}`
	}

	return attrs.value === null || attrs.value === "auto" ? "auto" : attrs.value.toUpperCase()
}

// Built-in styles commands add whose type is not paragraph, or whose id Word does not make from the name.
const BUILT_IN_STYLES: Readonly<Record<string, { readonly type: "paragraph" | "character"; readonly id: string }>> = {
	"annotation text": { type: "paragraph", id: "CommentText" },
	"annotation reference": { type: "character", id: "CommentReference" },
	"footnote reference": { type: "character", id: "FootnoteReference" },
	"endnote reference": { type: "character", id: "EndnoteReference" },
	"Placeholder Text": { type: "character", id: "PlaceholderText" },
	Hyperlink: { type: "character", id: "Hyperlink" },
	...Object.fromEntries(
		[1, 2, 3, 4, 5, 6, 7, 8, 9].map(level => [`toc ${String(level)}`, { type: "paragraph", id: `TOC${String(level)}` } as const])
	)
}

export function builtInStyleType(name: string): "paragraph" | "character" {
	return BUILT_IN_STYLES[name]?.type ?? "paragraph"
}

// The id of built-in style `name` when the document defines it or a command added it, without adding it.
export function knownBuiltInStyleId(context: DocxEditContext, name: string): string | undefined {
	const existing = context.styles.byName(name, builtInStyleType(name))

	if (existing !== undefined) return existing.id

	for (const [id, missing] of context.newStyles) if (missing === name) return id

	return undefined
}

// The id of built-in style `name` (a name the writer has a definition for): the document's own, else one
// added to the styles the writer defines when content uses it (Word's id, made unique against the document's).
export function builtInStyleId(context: DocxEditContext, name: string): string {
	const known = knownBuiltInStyleId(context, name)

	if (known !== undefined) return known

	const styles = context.styles
	const base = BUILT_IN_STYLES[name]?.id ?? name.replace(/(^|\s)(\S)/g, (_match, _space: string, letter: string) => letter.toUpperCase())
	let id = base

	for (let n = 1; styles.byId(id) !== undefined || context.newStyles.has(id); n++) id = `${base}${n}`

	context.newStyles.set(id, name)

	return id
}

// Run-level content of a selection as [from, to) pieces with their paragraph (what formatting changes: not
// markers or locked blocks); `cell` when the paragraph is in a table (a table style may format it,
// which the resolver does not see).
export interface RunPiece {
	readonly from: number
	readonly to: number
	readonly node: Node
	readonly paragraph: Node
	readonly cell: boolean
}

export function runPieces(state: EditorState, ranges?: readonly { readonly from: number; readonly to: number }[]): RunPiece[] {
	return runPiecesIn(state.doc, ranges ?? state.selection.ranges.map(range => ({ from: range.$from.pos, to: range.$to.pos })))
}

export function runPiecesIn(doc: Node, ranges: readonly { readonly from: number; readonly to: number }[]): RunPiece[] {
	const out: RunPiece[] = []

	for (const { from, to } of ranges) {
		// Ends of the tables around the content visited (nodesBetween visits a range's ancestors too).
		const tables: number[] = []

		doc.nodesBetween(from, to, (node, pos, parent) => {
			if (!node.isInline) {
				if (node.type === nodes.table) tables.push(pos + node.nodeSize)

				return node.type !== nodes.locked_block
			}

			// A field takes formatting as its runs do (§17.16.4.3; the writer gives them what changed).
			if (
				parent !== null &&
				parent.type === nodes.paragraph &&
				(inlineLevel(node) === "run" || (node.type === nodes.field && holdsFormatting(node)))
			) {
				const start = Math.max(from, pos)
				const end = Math.min(to, pos + node.nodeSize)

				while (tables.length > 0 && (tables[tables.length - 1] ?? 0) <= pos) tables.pop()

				if (end > start) out.push({ from: start, to: end, node, paragraph: parent, cell: tables.length > 0 })
			}

			return false
		})
	}

	return out
}

// Letters, digits, marks, apostrophes, "_", "-" and the zero-width (non-)joiners; an object reads as U+FFFC.
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}'’_-]|\p{Join_Control}/u
const OBJECT_TEXT = String.fromCharCode(0xfffc)

// The word an empty selection is inside of (not at either end of): what Word's character formatting and painter
// take with no selection ("When selecting, automatically select entire word").
export function wordAround(state: EditorState): { from: number; to: number } | undefined {
	const $from = state.selection.$from
	const parent = $from.parent

	if (!state.selection.empty || parent.type !== nodes.paragraph) return undefined

	const at = $from.parentOffset
	let start = at
	let end = at

	// Only the characters around the caret are read (no copy of the paragraph's text per command).
	while (start > 0 && WORD_CHARACTER.test(parent.textBetween(start - 1, start, undefined, OBJECT_TEXT))) start--
	while (end < parent.content.size && WORD_CHARACTER.test(parent.textBetween(end, end + 1, undefined, OBJECT_TEXT))) end++

	return start === at || end === at ? undefined : { from: $from.start() + start, to: $from.start() + end }
}

export interface ParagraphAt {
	readonly node: Node
	readonly pos: number
	// In a table (see RunPiece.cell).
	readonly cell: boolean
}

// The paragraphs the selection touches, in document order.
export function selectedParagraphs(state: EditorState): ParagraphAt[] {
	const out: ParagraphAt[] = []
	const seen = new Set<number>()

	for (const range of state.selection.ranges) {
		const tables: number[] = []

		state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
			if (node.type === nodes.paragraph) {
				while (tables.length > 0 && (tables[tables.length - 1] ?? 0) <= pos) tables.pop()

				if (!seen.has(pos)) {
					seen.add(pos)
					out.push({ node, pos, cell: tables.length > 0 })
				}

				return false
			}

			if (node.type === nodes.table) tables.push(pos + node.nodeSize)

			return !node.isInline && node.type !== nodes.locked_block
		})
	}

	return out
}

// Sets, piece by piece, the mark of `type` that `next` gives (undefined: none), as one step (see SetMarksStep:
// undo restores what each piece had).
export function changeMarks(
	tr: Transaction,
	pieces: readonly RunPiece[],
	type: MarkType,
	next: (piece: RunPiece, index: number) => Mark | undefined
): void {
	const changes = new MarkChanges()
	let sample: Mark | undefined

	pieces.forEach((piece, index) => {
		const existing = type.isInSet(piece.node.marks)
		const wanted = next(piece, index)

		if (existing === undefined ? wanted === undefined : wanted !== undefined && existing.eq(wanted)) return

		sample ??= wanted ?? existing
		changes.add(piece.from, piece.to, wanted ?? null)
	})

	if (sample !== undefined) changes.step(tr, sample)
}

// Sets, piece by piece, the marks of `types` that `next` gives (a set as addToSet makes it), as one step (see
// SetMarkSetsStep); `mark` is what readers of an AddMarkStep see.
export function changeMarkSets(
	tr: Transaction,
	pieces: readonly RunPiece[],
	types: readonly MarkType[],
	next: (piece: RunPiece) => readonly Mark[],
	mark: Mark
): void {
	const changes = new MarkSetChanges(types)

	for (const piece of pieces) {
		const wanted = next(piece)

		if (
			!sameSet(
				piece.node.marks.filter(own => types.includes(own.type)),
				wanted
			)
		)
			changes.add(piece.from, piece.to, wanted)
	}

	changes.step(tr, mark)
}

// The marks `marksOf` with the mark of `type` replaced by `mark` (removed when undefined).
export function withMark(marksOf: readonly Mark[], type: MarkType, mark: Mark | undefined): readonly Mark[] {
	const without = type.removeFromSet(marksOf)

	return mark === undefined ? without : mark.addToSet(without)
}

// Whether a paragraph node's attributes still say what its source w:pPr says (compared by identity: unchanged
// copies keep the attribute values the builder read).
function saysSource(node: Node, source: ParagraphProps): boolean {
	const attrs = node.attrs

	return (
		attrs["styleId"] === (source.styleId ?? null) &&
		attrs["numId"] === (source.numbering?.numId ?? null) &&
		attrs["ilvl"] === (source.numbering?.ilvl ?? null) &&
		attrs["align"] === (source.alignment ?? null) &&
		attrs["indent"] === (source.indent ?? null) &&
		attrs["spacing"] === (source.spacing ?? null) &&
		attrs["borders"] === (source.borders ?? null)
	)
}

// Effective formatting of editing nodes: a paragraph's direct properties are its source w:pPr with the
// attributes commands edit laid over; a run's toggles are its direct marks, else what the paragraph and
// character styles give. Everything is cached by identity (attribute objects are shared by unchanged node
// copies, resolver results are interned).
export class FormatResolver {
	private readonly context: DocxEditContext
	private readonly part: StoryPart
	// Per source paragraph (by its row in the part's paragraph table): its w:pPr's properties as an index into
	// `sourceProps` (-1 before the first read), and the format of each while a paragraph's attributes still
	// say what it says (paragraph()). Four bytes a paragraph, where a map per node would hold an entry each.
	private sourceRows: Int32Array | undefined = undefined
	private readonly sourceList: ParagraphProps[] = []
	private readonly sourceIds = new Map<ParagraphProps, number>()
	private readonly sourceFormats: (ParagraphFormat | undefined)[] = []
	private readonly edited = new WeakMap<object, ParagraphFormat>()
	private readonly styleParagraphs = new Map<string | null, ParagraphFormat>()
	private readonly characterStyles = new Map<string | null, RunProps>()
	private readonly overrides = new WeakMap<ParagraphProps, Map<string, ParagraphProps>>()
	// Distinct direct formattings (by the property marks' attributes and the base's script), and their values
	// per paragraph format: keyed by content, not by mark array (every source run has its own array), so a
	// large selection adds nothing per run.
	private readonly markKeys = new WeakMap<Mark, string>()
	private readonly formattings = new Map<string, Formatting>()
	private readonly trie: TrieNode = { next: undefined, leaf: [undefined, undefined] }
	private readonly interned = new WeakMap<ResolvedRunProps, Map<string, RunValues>>()
	// Paragraph-mark marks by w:pPr/w:rPr node, and by its interned properties (shared by equal marks).
	private markMarks: Map<number, readonly Mark[]> | undefined = undefined
	private readonly markMarksByProps = new WeakMap<RunProps, readonly Mark[]>()
	// Lists created in this session (negative numIds) and their kind.
	readonly newLists: Map<number, NewList>

	constructor(context: DocxEditContext, part: StoryPart) {
		this.context = context
		this.part = part
		this.newLists = context.newLists
	}

	// The paragraph properties of a paragraph node's source w:pPr (none for a new paragraph), by source item:
	// the store interns them by their bytes, which a command over a long document would otherwise hash again
	// for every paragraph.
	sourceProps(node: Node): ParagraphProps {
		const id = this.sourceId(node)

		return id < 0 ? EMPTY_PARAGRAPH : (this.sourceList[id] ?? EMPTY_PARAGRAPH)
	}

	// The index of a paragraph node's source properties in `sourceList`, -1 for a new paragraph.
	private sourceId(node: Node): number {
		const src = node.attrs["src"] as number
		const part = this.part

		if (src === NO_SOURCE || part.kinds[src] !== Item.Paragraph) return -1

		const row = part.aux[src] ?? -1
		const pPrs = part.paragraphs.pPr

		if (row < 0 || row >= pPrs.length) return -1

		const rows = (this.sourceRows ??= new Int32Array(pPrs.length).fill(-1))
		let id = rows[row] ?? -1

		if (id < 0) {
			const props = this.context.store.paragraph(part.document, pPrs[row] ?? -1)

			id = this.sourceIds.get(props) ?? this.sourceList.length

			if (id === this.sourceList.length) {
				this.sourceList.push(props)
				this.sourceIds.set(props, id)
			}

			rows[row] = id
		}

		return id
	}

	// The formatting marks of a paragraph node's source paragraph mark (w:pPr/w:rPr), none for a new
	// paragraph: what Word types into the paragraph while it holds no content. Its revision records (w:ins,
	// w:del, w:moveFrom, w:moveTo, w:rPrChange) and w:specVanish describe the mark only and give none.
	paragraphMarkMarks(node: Node): readonly Mark[] {
		const src = node.attrs["src"] as number
		const part = this.part

		if (src === NO_SOURCE || part.kinds[src] !== Item.Paragraph) return NO_MARKS

		const markRPr = part.paragraphs.markRPr[part.aux[src] ?? -1] ?? -1

		if (markRPr < 0) return NO_MARKS

		const byNode = (this.markMarks ??= new Map())
		let out = byNode.get(markRPr)

		if (out === undefined) {
			const props = this.context.store.run(part.document, markRPr)

			out = this.markMarksByProps.get(props)

			if (out === undefined) {
				out = formattingMarks(props).filter(mark => mark.type !== marks.format_change)
				this.markMarksByProps.set(props, out)
			}

			byNode.set(markRPr, out)
		}

		return out
	}

	// The paragraph mark's marks (paragraphMarkMarks) where text typed at `$pos` takes them: in a paragraph
	// holding no content (range markers at most). Undefined elsewhere or when the mark has none.
	emptyParagraphMarks($pos: ResolvedPos): readonly Mark[] | undefined {
		const paragraph = $pos.parent

		if (paragraph.type !== nodes.paragraph) return undefined

		for (let k = 0; k < paragraph.childCount; k++) {
			const type = paragraph.child(k).type

			if (type !== nodes.marker && type !== nodes.proof_err) return undefined
		}

		const own = this.paragraphMarkMarks(paragraph)

		if (own.length === 0) return undefined

		let out = $pos.marks()

		if (out.length === 0) return own

		for (const mark of own) out = mark.addToSet(out)

		return out
	}

	// The direct paragraph properties of a paragraph node: its source w:pPr's own (interned) object while
	// the attributes still say what it says, so the resolver's cache serves every unedited paragraph;
	// otherwise one interned object per source and override set.
	direct(node: Node): ParagraphProps {
		const source = this.sourceProps(node)

		if (saysSource(node, source)) return source

		const styleId = node.attrs["styleId"] as string | null
		const numId = node.attrs["numId"] as number | null
		const ilvl = node.attrs["ilvl"] as number | null
		const align = node.attrs["align"] as string | null
		const indent = node.attrs["indent"] as IndentAttrs | null
		const spacing = node.attrs["spacing"] as SpacingProps | null
		const borders = node.attrs["borders"] as ParagraphBordersProps | null

		const key = JSON.stringify([styleId, numId, ilvl, align, indent, spacing, borders])
		let bySource = this.overrides.get(source)

		if (bySource === undefined) {
			bySource = new Map()
			this.overrides.set(source, bySource)
		}

		let direct = bySource.get(key)

		if (direct === undefined) {
			const {
				styleId: _styleId,
				numbering: _numbering,
				alignment: _alignment,
				indent: _indent,
				spacing: _spacing,
				borders: _borders,
				...rest
			} = source

			direct = {
				...rest,
				...(styleId !== null ? { styleId } : {}),
				...(numId !== null
					? { numbering: ilvl === null ? { numId } : { numId, ilvl } }
					: ilvl !== null
						? { numbering: { ilvl } }
						: {}),
				...(align !== null ? { alignment: align } : {}),
				...(indent !== null ? { indent } : {}),
				...(spacing !== null ? { spacing } : {}),
				...(borders !== null ? { borders } : {})
			}
			bySource.set(key, direct)
		}

		return direct
	}

	paragraph(node: Node): ParagraphFormat {
		const id = this.sourceId(node)
		const source = id < 0 ? undefined : this.sourceList[id]

		if (source !== undefined && saysSource(node, source)) {
			let format = this.sourceFormats[id]

			if (format === undefined) {
				format = this.context.resolver.paragraph(source)
				this.sourceFormats[id] = format
			}

			return format
		}

		const key = node.attrs
		let format = this.edited.get(key)

		if (format === undefined) {
			format = this.context.resolver.paragraph(this.direct(node))
			this.edited.set(key, format)
		}

		return format
	}

	// What the paragraph style alone gives (no direct properties).
	styleParagraph(styleId: string | null): ParagraphFormat {
		let format = this.styleParagraphs.get(styleId)

		if (format === undefined) {
			format = this.context.resolver.paragraph(styleId === null ? EMPTY_PARAGRAPH : { styleId })
			this.styleParagraphs.set(styleId, format)
		}

		return format
	}

	// A run's properties from its paragraph and character style, without direct formatting.
	styleRun(paragraph: ParagraphFormat, marksOf: readonly Mark[]): ResolvedRunProps {
		return this.context.resolver.run(
			paragraph,
			this.characterStyle((marks.char_style.isInSet(marksOf)?.attrs["styleId"] as string | undefined) ?? null)
		)
	}

	private characterStyle(styleId: string | null): RunProps {
		let direct = this.characterStyles.get(styleId)

		if (direct === undefined) {
			direct = styleId === null ? {} : { styleId }
			this.characterStyles.set(styleId, direct)
		}

		return direct
	}

	// The four toggles of content with `marksOf` in `paragraph` as bits: TOGGLE_ON << k when toggle k is
	// on, TOGGLE_STYLE << k when the styles alone give it. Cached per distinct formatting and paragraph format
	// (bold, italic, underline and strike are formatting marks; content is complex script when its styles or its
	// base say so), so a large selection adds nothing per run.
	toggles(paragraph: ParagraphFormat, marksOf: readonly Mark[]): number {
		const formatting = this.formatting(marksOf)
		const cached = formatting.toggles.get(paragraph)

		if (cached !== undefined) return cached

		const style = this.context.resolver.run(paragraph, formatting.style)
		const complex = style.rtl || style.cs || formatting.complexBase
		let bits = 0

		RUN_TOGGLES.forEach((toggle, k) => {
			let on: boolean
			let fromStyle: boolean

			switch (toggle) {
				case "bold":
				case "italic": {
					fromStyle = toggle === "bold" ? (complex ? style.boldCs : style.bold) : complex ? style.italicCs : style.italic

					const mark = marks[toggle].isInSet(marksOf)
					const value = mark?.attrs[complex ? "cs" : "value"] as boolean | null | undefined

					on = value ?? fromStyle

					break
				}
				case "underline": {
					fromStyle = style.underline !== undefined

					const mark = marks.underline.isInSet(marksOf)

					on = mark === undefined ? fromStyle : mark.attrs["style"] !== "none"

					break
				}
				case "strike": {
					fromStyle = style.strike

					const value = marks.strike.isInSet(marksOf)?.attrs["value"] as boolean | null | undefined

					on = value ?? fromStyle

					break
				}
			}

			if (on) bits |= TOGGLE_ON << k
			if (fromStyle) bits |= TOGGLE_STYLE << k
		})

		formatting.toggles.set(paragraph, bits)

		return bits
	}

	// Whether `toggle` is on for content with `marksOf` in `paragraph`, and what the styles alone give.
	toggle(toggle: RunToggle, paragraph: ParagraphFormat, marksOf: readonly Mark[]): { readonly on: boolean; readonly style: boolean } {
		const bits = this.toggles(paragraph, marksOf)
		const k = RUN_TOGGLES.indexOf(toggle)

		return { on: (bits & (TOGGLE_ON << k)) !== 0, style: (bits & (TOGGLE_STYLE << k)) !== 0 }
	}

	private markKey(mark: Mark): string {
		let key = this.markKeys.get(mark)

		if (key === undefined) {
			key = `${mark.type.name}${JSON.stringify(mark.attrs)}`
			this.markKeys.set(mark, key)
		}

		return key
	}

	// The formatting of content with `marksOf`: found through a trie over the property marks' identities
	// (source runs share their base's mark objects), so a lookup allocates nothing; a new path is matched to
	// an existing formatting by content.
	private formatting(marksOf: readonly Mark[]): Formatting {
		let complexBase = false
		let node = this.trie

		for (const mark of marksOf) {
			if (PROPERTY_TYPES.has(mark.type)) {
				let next = node.next?.get(mark)

				if (next === undefined) {
					next = { next: undefined, leaf: [undefined, undefined] }
					node.next ??= new WeakMap()
					node.next.set(mark, next)
				}

				node = next
			} else if (mark.type === marks.run) {
				const props = this.context.bases.get(mark.attrs["base"] as number)?.props

				complexBase = props?.rtl === true || props?.cs === true
			}
		}

		const slot = complexBase ? 1 : 0
		let formatting = node.leaf[slot]

		if (formatting === undefined) {
			const own = marksOf.filter(mark => PROPERTY_TYPES.has(mark.type))
			const key = own.map(mark => this.markKey(mark)).join("") + (complexBase ? "|cs" : "")

			formatting = this.formattings.get(key)

			if (formatting === undefined) {
				const color = marks.color.isInSet(own)
				const props = runPropsOf(own)

				formatting = {
					props,
					style: this.characterStyle(props.styleId ?? null),
					complexBase,
					color: color === undefined ? undefined : colorKey(color.attrs as ColorAttrs),
					values: new Map(),
					styleValues: new Map(),
					toggles: new Map()
				}
				this.formattings.set(key, formatting)
			}

			node.leaf[slot] = formatting
		}

		return formatting
	}

	// The direct properties the formatting marks of `marksOf` stand for, one object per distinct set.
	runProps(marksOf: readonly Mark[]): RunProps {
		return this.formatting(marksOf).props
	}

	// The effective formatting of content with `marksOf` in `paragraph`.
	resolvedRun(paragraph: ParagraphFormat, marksOf: readonly Mark[]): ResolvedRunProps {
		return this.context.resolver.run(paragraph, this.runProps(marksOf))
	}

	// The formatting values of content with `marksOf` in `paragraph`.
	values(paragraph: ParagraphFormat, marksOf: readonly Mark[]): RunValues {
		const formatting = this.formatting(marksOf)
		let values = formatting.values.get(paragraph)

		if (values === undefined) {
			const resolved = this.context.resolver.run(paragraph, formatting.props)

			values = this.intern(resolved, formatting.color, formatting.complexBase || resolved.rtl || resolved.cs)
			formatting.values.set(paragraph, values)
		}

		return values
	}

	// What the paragraph and character styles alone give content with `marksOf` (no direct formatting).
	styleValues(paragraph: ParagraphFormat, marksOf: readonly Mark[]): RunValues {
		const formatting = this.formatting(marksOf)
		let values = formatting.styleValues.get(paragraph)

		if (values === undefined) {
			const resolved = this.context.resolver.run(paragraph, formatting.style)

			values = this.intern(resolved, undefined, formatting.complexBase || resolved.rtl || resolved.cs)
			formatting.styleValues.set(paragraph, values)
		}

		return values
	}

	private intern(resolved: ResolvedRunProps, directColor: string | undefined, complex: boolean): RunValues {
		let byKey = this.interned.get(resolved)

		if (byKey === undefined) {
			byKey = new Map()
			this.interned.set(resolved, byKey)
		}

		const key = `${directColor ?? ""}|${complex ? 1 : 0}`
		let values = byKey.get(key)

		if (values === undefined) {
			const rgb = resolved.color ?? "auto"

			values = {
				font: complex ? resolved.fonts.cs : resolved.fonts.ascii,
				size: complex ? resolved.sizeCs : resolved.size,
				color: directColor ?? rgb,
				colorRgb: rgb,
				highlight: resolved.highlight === undefined ? "none" : (HIGHLIGHT_NAMES.get(resolved.highlight) ?? "none"),
				vertAlign: resolved.vertAlign,
				strike: resolved.strike,
				doubleStrike: resolved.doubleStrike,
				caps: resolved.caps,
				smallCaps: resolved.smallCaps,
				spacing: resolved.spacing,
				complex
			}
			byKey.set(key, values)
		}

		return values
	}

	// The paragraph `node` would resolve to with `attrs` laid over its attributes.
	paragraphWith(node: Node, attrs: Readonly<Record<string, unknown>>): ParagraphFormat {
		return this.context.resolver.paragraph(this.direct(node.type.create({ ...node.attrs, ...attrs })))
	}

	// The numbering attributes that take paragraph `node` out of its list: numbering its style gives is switched
	// off explicitly (numId 0); direct numbering is removed.
	numberingOff(node: Node): { readonly numId: number | null; readonly ilvl: null } {
		const styled = this.styleParagraph(node.attrs["styleId"] as string | null).props.numbering

		return styled !== undefined && styled.numId > 0 ? NUMBERING_OFF_STYLED : NUMBERING_OFF
	}

	// The paragraph style a new paragraph made by Enter at the end of `node` takes (its style's w:next, §17.7.4.10):
	// a style id, null for the default paragraph style; undefined when it keeps `node`'s.
	nextStyle(node: Node): string | null | undefined {
		const styles = this.context.styles
		const id = node.attrs["styleId"] as string | null
		const style = id === null ? styles.defaultOf("paragraph") : styles.byId(id)

		if (style?.next === undefined || style.type !== "paragraph") return undefined

		const next = styles.byId(style.next)

		if (next === undefined || next === style || next.type !== "paragraph") return undefined

		return next === styles.defaultOf("paragraph") ? null : next.id
	}

	// The list a paragraph is in, by its effective numbering.
	listOf(node: Node): { readonly kind: ListKind; readonly numId: number; readonly ilvl: number } | undefined {
		const numbering = this.paragraph(node).props.numbering
		const direct = node.attrs["numId"] as number | null
		const ilvl = (node.attrs["ilvl"] as number | null) ?? numbering?.ilvl ?? 0

		if (direct !== null && direct < 0) {
			const list = this.newLists.get(direct)

			return list === undefined ? undefined : { kind: list.kind, numId: direct, ilvl }
		}

		if (numbering === undefined || numbering.numId <= 0) return undefined

		const level = this.context.numbering?.level(numbering.numId, numbering.ilvl)

		const kind = level === undefined ? undefined : listKind(level.level.format)

		return kind === undefined ? undefined : { kind, numId: numbering.numId, ilvl: numbering.ilvl }
	}

	// The first w:num of the document whose first level is a list of `kind`.
	firstList(kind: ListKind): number | undefined {
		const numbering = this.context.numbering

		if (numbering === undefined) return undefined

		for (const numId of [...numbering.instances.keys()].sort((a, b) => a - b)) {
			const level = numbering.level(numId, 0)

			if (level !== undefined && listKind(level.level.format) === kind && plainList(numbering, numId, kind, level.level)) return numId
		}

		return undefined
	}
}

// Word's list buttons apply a library format, never a style-linked (heading/outline) or legal definition:
// only a plain list qualifies for reuse.
function plainList(numbering: Numbering, numId: number, kind: ListKind, first: NumberingLevel): boolean {
	if (first.legal || first.styleId !== undefined) return false

	if (kind === "numbered" && first.text !== undefined && /%[2-9]/.test(first.text)) return false

	const instance = numbering.instances.get(numId)

	if (instance === undefined) return false

	const declared = numbering.abstracts.get(instance.abstractId)
	const abstract = numbering.abstractFor(instance)

	if (declared?.numStyleLink !== undefined || declared?.styleLink !== undefined || abstract?.styleLink !== undefined) return false

	if (abstract?.levels.some(level => level?.styleId !== undefined) === true) return false

	for (const override of instance.overrides.values()) if (override.level?.styleId !== undefined) return false

	return true
}

function listKind(format: string): ListKind | undefined {
	return format === "none" ? undefined : format === "bullet" ? "bullet" : "numbered"
}

// ST_Jc to the four alignments commands set (logical: Word reads left/right of a right-to-left paragraph
// as its start/end).
export function alignmentOf(jc: string): "start" | "center" | "end" | "justify" | "other" {
	switch (jc) {
		case "left":
		case "start":
			return "start"
		case "right":
		case "end":
			return "end"
		case "center":
			return "center"
		case "both":
		case "distribute":
		case "lowKashida":
		case "mediumKashida":
		case "highKashida":
		case "thaiDistribute":
			return "justify"
		default:
			return "other"
	}
}
