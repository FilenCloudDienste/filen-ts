import type { Mark, MarkType, Node } from "prosemirror-model"
import { EditorState, TextSelection, type Transaction } from "prosemirror-state"
import { closeHistory, history, isHistoryTransaction, redo, redoDepth, undo, undoDepth } from "prosemirror-history"
import { ReplaceStep } from "prosemirror-transform"
import { Item, type Story } from "../model/index"
import { commentParaIds } from "../review/comments"
import { ReviewIndex } from "../review/index"
import { refusedForAuthor, refusedUnsupported } from "../review/track"
import { DocxDocBuilder, type StoryDoc } from "./build"
import {
	PARAGRAPH_STYLE_NAMES,
	commandInfo,
	isWriteCommand,
	type DocxAlignment,
	type DocxEditorCommand,
	type DocxEditorCommandInfo,
	type DocxEditorCommandType,
	type DocxParagraphStyle,
	DOCX_EDITOR_COMMANDS
} from "./commands"
import { BASE_COMMANDS, writesUnholdableText } from "./commands/base"
import type { DocxEditContext } from "./context"
import {
	FormatResolver,
	RUN_TOGGLES,
	TOGGLE_ON,
	alignmentOf,
	builtInStyleId,
	builtInStyleType,
	caretMarks,
	wordAround,
	type ListKind,
	type ListStart,
	type NewList,
	type RunToggle
} from "./formats"
import { docxInvariantPlugins, isInternal, markInternal, type ListNormalizer } from "./invariants/index"
import type { CopiedElement, SourceCopies } from "./invariants/core"
import { elementData } from "./copies"
import { indexOriginals } from "../write/story"
import { openDocumentTranslation } from "../layout/geometry"
import { noteFieldCopy } from "./invariants/forms"
import { legacyCopyState } from "../forms/controls"
import { equationRunStyles } from "../math/edit"
import { sessionGone, sessionMade } from "../forms/sessions"
import { sourceCellProps, sourceRowProps } from "./tables/map"
import { conservativeProof, lockBlocks, proveBlocks, type BlockProof, type BlockStart } from "./proof"
import { MarkChanges, MarkSetChanges } from "./marks"
import { AttrChanges } from "./attrs"
import { baseFits } from "./formatting"
import { knowOrigins } from "./origin"
import { commandAllowed, internalViolation } from "./protection"
import { readOnlyReasons, type DocxReadOnlyReason } from "./readOnly"
import { registeredTransformer, storyHandler, type DocxTransactionTransformer, type StoryCommandContext } from "./registry"
import { FORMATTING_MARKS, NO_SOURCE, docxSchema, inlineLevel, type IndentAttrs, type LockReason } from "./schema"
import {
	providedSnapshot,
	type DocxContextSnapshot,
	type DocxProvidedSnapshot,
	type DocxReviewSnapshot,
	type DocxValuesSnapshot
} from "./snapshot/index"

export type FormatState = "on" | "off" | "mixed"

// Why a user's edit came to nothing: tracking records an author and none is set, or what tracking would record
// cannot be saved (the deletion of an equation nested too deep).
export type DocxRefusalReason = "authorNeeded" | "unsupported"

export type { DocxReadOnlyReason } from "./readOnly"

// Everything a toolbar needs, as plain data (it crosses a worker or WebView bridge as is).
export interface DocxEditorSnapshot {
	// Increases with every change of state.
	readonly version: number
	readonly readOnly: boolean
	readonly readOnlyReasons: readonly DocxReadOnlyReason[]
	// The document differs from the last saved (or opened) one.
	readonly dirty: boolean
	readonly canUndo: boolean
	readonly canRedo: boolean
	readonly selection: {
		readonly empty: boolean
		readonly from: number
		readonly to: number
		// The selection is (or is inside) a locked block, and why it is locked.
		readonly locked: LockReason | null
		readonly paragraphs: number
	}
	readonly formats: Readonly<Record<RunToggle, FormatState>>
	readonly paragraph: {
		// "custom" for any other style, "mixed" across paragraphs, null without paragraphs.
		readonly style: DocxParagraphStyle | "custom" | "mixed" | null
		// The style's display name when it is custom.
		readonly styleName: string | null
		readonly align: DocxAlignment | "other" | "mixed" | null
		readonly list: ListKind | "none" | "mixed" | null
		// List level (0-based) when every paragraph is at the same one.
		readonly level: number | null
	}
	// Formatting values of the selection (font, size, colours, spacing).
	readonly values: DocxValuesSnapshot
	// Where the selection is: the story, and the table, object, control, field, link or comment it is in.
	readonly context: DocxContextSnapshot
	readonly review: DocxReviewSnapshot
	readonly enabled: Readonly<Record<DocxEditorCommandType, boolean>>
}

export interface DocxEditorOptions {
	// The story to edit (default: the body).
	readonly story?: Story
	// The host's read-only mode (public links, versions, trash...). Gate 0 reasons make a session read-only too.
	readonly readOnly?: boolean
	// Gate 1 for the blocks of the story; null leaves it to the caller (see prove()).
	readonly proof?: BlockProof | null
	readonly normalizeList?: ListNormalizer
	// Undo steps kept (default 100, as ProseMirror's history).
	readonly historyDepth?: number
	// The story's editing document built ahead (DocxEditorSession.open builds it in slices).
	readonly built?: StoryDoc
	// Turns each user transaction into what is applied (default: the features' registered transformers;
	// null: none).
	readonly transformer?: DocxTransactionTransformer | null
	// AutoFormat As You Type (default: on, as in Word): a host's per-user setting turns each off.
	readonly autoFormat?: DocxAutoFormat
}

export interface DocxAutoFormat {
	// "1. ", "a) ", "* ", "- " or "> " typed at the start of a paragraph starts a list.
	readonly lists: boolean
	// Straight quotes typed become curly ones.
	readonly quotes: boolean
}

const AUTO_FORMAT_ON: DocxAutoFormat = { lists: true, quotes: true }

const nodes = docxSchema.nodes
const marks = docxSchema.marks
const BASE_TYPES: ReadonlySet<string> = new Set(BASE_COMMANDS.map(info => info.type))
const FORMATTING_TYPES: readonly MarkType[] = FORMATTING_MARKS.map(name => marks[name])
// What clearing direct formatting removes (Word's Ctrl+Space), and the plain mark it sets: everything but the
// language and highlighting.
const CLEARED_TYPES: readonly MarkType[] = FORMATTING_TYPES.filter(type => type !== marks.lang && type !== marks.highlight)
// The command style of each built-in style name.
const STYLE_OF_NAME: ReadonlyMap<string, DocxParagraphStyle> = new Map(
	Object.entries(PARAGRAPH_STYLE_NAMES).map(([style, name]) => [name, style as DocxParagraphStyle])
)
const NO_DOUBLE_STRIKE = marks.double_strike.create({ value: false })
// Word's default indent step and tab stop: half an inch.
const INDENT_STEP = 720
const MAX_LIST_LEVEL = 8
// Word's built-in list item style (its w:name), and its canonical name.
const LIST_PARAGRAPH = "List Paragraph"
const LIST_PARAGRAPH_KEY = "list paragraph"
// How an inline object reads in text.
const OBJECT = String.fromCharCode(0xfffc)
// The longest typed text a list AutoFormat reads ("999. ").
const MAX_LIST_PREFIX = 5
const NUMBERED_PREFIX = /^(?:(\d{1,3})|([a-hj-z])|([A-HJ-Z])|(i|[ivxlcdm]{2,})|(I|[IVXLCDM]{2,}))([.)])$/
const BULLET_PREFIXES: ReadonlySet<string> = new Set(["*", "-", ">"])
const ROMAN: Readonly<Record<string, number>> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 }
// What a typed quote opens after (else it closes, as an apostrophe in a word does): white space, an opening
// bracket or quote, a dash.
const OPENS_AFTER = /[\s([{<‘“–—]/u
// English curly quotes: Word follows the run's language; quotes of other languages are not told apart here.
const CURLY: Readonly<Record<string, readonly [string, string]>> = { '"': ["“", "”"], "'": ["‘", "’"] }

// The character a user transaction typed at a caret that AutoFormat As You Type acts on (a space, a tab, a
// straight quote); undefined for anything else (a paste, a composition, a replacement, an undo).
function typedTrigger(tr: Transaction): string | undefined {
	if (tr.steps.length !== 1 || isHistoryTransaction(tr) || tr.getMeta("composition") !== undefined || tr.getMeta("uiEvent") !== undefined)
		return undefined

	const step = tr.steps[0]

	if (!(step instanceof ReplaceStep) || step.from !== step.to || step.slice.openStart !== 0 || step.slice.content.childCount !== 1)
		return undefined

	const node = step.slice.content.child(0)

	if (node.type === nodes.tab) return "\t"

	return node.text === " " || node.text === '"' || node.text === "'" ? node.text : undefined
}

// The roman numeral `text` (lower case) stands for, 0 when it is none in its usual form.
function romanValue(text: string): number {
	let value = 0

	for (let k = 0; k < text.length; k++) {
		const digit = ROMAN[text.charAt(k)] ?? 0
		const next = ROMAN[text.charAt(k + 1)] ?? 0

		value += digit < next ? -digit : digit
	}

	return value > 0 && value < 4000 && romanText(value) === text ? value : 0
}

function romanText(value: number): string {
	const table: readonly (readonly [number, string])[] = [
		[1000, "m"],
		[900, "cm"],
		[500, "d"],
		[400, "cd"],
		[100, "c"],
		[90, "xc"],
		[50, "l"],
		[40, "xl"],
		[10, "x"],
		[9, "ix"],
		[5, "v"],
		[4, "iv"],
		[1, "i"]
	]
	let out = ""
	let rest = value

	for (const [amount, digits] of table) {
		while (rest >= amount) {
			out += digits
			rest -= amount
		}
	}

	return out
}

// The list a paragraph starting with `prefix` and a space becomes (Word's automatic bulleted and numbered lists):
// a bullet for "*", "-" and ">", a numbered list from the number or letter before "." or ")" ("i" and "I" are
// roman), undefined for any other text.
function listPrefix(prefix: string): "bullet" | ListStart | undefined {
	if (BULLET_PREFIXES.has(prefix)) return "bullet"

	const match = NUMBERED_PREFIX.exec(prefix)

	if (match === null) return undefined

	const [, digits, lower, upper, lowerRoman, upperRoman, end] = match
	const suffix = end === ")" ? ")" : "."

	if (digits !== undefined) return { format: "decimal", suffix, start: Number(digits) }
	if (lower !== undefined) return { format: "lowerLetter", suffix, start: lower.charCodeAt(0) - 96 }
	if (upper !== undefined) return { format: "upperLetter", suffix, start: upper.charCodeAt(0) - 64 }

	const roman = lowerRoman ?? upperRoman?.toLowerCase() ?? ""
	const start = romanValue(roman)

	return start === 0 ? undefined : { format: lowerRoman === undefined ? "upperRoman" : "lowerRoman", suffix, start }
}

// What an inline leaf reads as before a quote: white space for a tab or break, nothing for a range marker or a
// proofing mark, an object otherwise.
function leafText(leaf: Node): string {
	if (leaf.type === nodes.tab) return "\t"
	if (leaf.type === nodes.break) return "\n"

	return leaf.type === nodes.marker || leaf.type === nodes.proof_err ? "" : OBJECT
}

// The straight quote typed right before the caret as Word's smart quote: opening at the start of a paragraph or
// after OPENS_AFTER, else closing.
function smartQuote(state: EditorState, typed: string): Transaction | null {
	const $caret = state.selection.$from
	const quote = $caret.nodeBefore
	const pair = CURLY[typed]

	if (quote === null || pair === undefined) return null

	const paragraph = $caret.parent
	let previous = ""

	// The visible character before it (range markers and proofing marks have no text).
	for (let at = $caret.parentOffset - 1; at > 0 && previous === ""; at--) {
		previous = paragraph.textBetween(at - 1, at, undefined, leafText)
	}

	const curly = previous === "" || OPENS_AFTER.test(previous) ? pair[0] : pair[1]
	const pos = $caret.pos

	return state.tr.replaceWith(pos - 1, pos, docxSchema.text(curly, quote.marks))
}

interface RunPiece {
	readonly from: number
	readonly to: number
	readonly node: Node
	readonly paragraph: Node
}

// What a selection holds, additive over ranges so an extended selection updates by its difference.
// Characters (and run-level atoms) count by their size in the selection; paragraphs by their facts.
interface Tally {
	chars: number
	readonly on: number[]
	paragraphs: number
	outdentable: number
	readonly styles: Map<string, number>
	readonly aligns: Map<string, number>
	readonly lists: Map<string, number>
	readonly levels: Map<number, number>
}

interface ParagraphFacts {
	// A DocxParagraphStyle, or "custom:" and the style's name.
	readonly style: string
	readonly align: string
	readonly list: string
	readonly level: number
	readonly outdentable: boolean
}

// Whether `story` may hold the anchors of comment `id`: a comment of the file in the story its anchors are in
// (notes share a part), a new one in the body (where comments are added).
function commentStory(context: DocxEditContext, story: Story, id: string): boolean {
	const anchors = context.model.commentAnchors
	const row = anchors.ids.get(id)

	if (row === undefined) return story.kind === "body"

	const reference = anchors.referencePart[row] ?? -1
	const part = reference >= 0 ? reference : (anchors.startPart[row] ?? -1)
	const item = reference >= 0 ? (anchors.referenceItem[row] ?? -1) : (anchors.startItem[row] ?? -1)

	if (part < 0) return true
	if (part !== story.part) return false

	const source = context.model.parts[part]

	return source === undefined || story.item < 0 || item < 0 || (item >= story.item && item < source.end(story.item))
}

// prosemirror-history keeps the plugins of the last state it recorded a change of (its mustPreserveItems
// cache), and a session's plugins hold the session, its document and context: a closed session hands it a
// state of its own instead.
let historyHolder: EditorState | undefined

function releaseHistory(): void {
	historyHolder ??= EditorState.create({ schema: docxSchema, plugins: [history()] })
	historyHolder.apply(historyHolder.tr.insertText(" ", 1))
}

const copiesOf = new WeakMap<DocxEditContext, SourceCopies>()

const COPIED_KINDS: Readonly<Record<CopiedElement, number>> = { table: Item.Table, row: Item.Row, cell: Item.Cell, control: Item.Sdt }
// What a copy's properties leave out: tracked changes (the original's), what the copy writes of its own (grid
// offsets, span and merge, width) and a control's id.
const LEFT_OUT: Readonly<Record<CopiedElement, ReadonlySet<string>>> = {
	table: new Set(["tblPrChange"]),
	row: new Set(["ins", "del", "trPrChange", "gridBefore", "gridAfter", "wBefore", "wAfter"]),
	cell: new Set(["cellIns", "cellDel", "cellMerge", "tcPrChange", "tcW", "gridSpan", "hMerge", "vMerge"]),
	control: new Set(["id"])
}

// What copies pasted into a document's stories keep that only their source's part holds (freshSlice, the
// invariants): a legacy form field's w:ffData; of another part's table, row, cell or content control its
// property element as data, and of a row or cell the properties its overrides carry (fill, vertical alignment,
// header repeat, grid offsets, width).
export function sourceCopies(context: DocxEditContext): SourceCopies {
	const known = copiesOf.get(context)

	if (known !== undefined) return known

	const partOf = (index: number | undefined) => (index === undefined ? undefined : context.model.parts[index])
	const copies: SourceCopies = {
		field(node, index) {
			const part = partOf(index)
			const state = part === undefined ? undefined : legacyCopyState(part, node)

			if (state !== undefined) noteFieldCopy(context)

			return state
		},
		props(node, index) {
			const part = partOf(index)
			const own = node.attrs["src"] as number

			if (part === undefined || own < 0 || own >= part.count) return undefined

			if (node.type === nodes.table_cell) {
				if (part.kinds[own] !== Item.Cell) return undefined

				const props = sourceCellProps(part, context.store, own, false)
				const fill = props.shading?.fill?.val
				const vAlign = props.vAlign === "both" ? undefined : props.vAlign

				return {
					...(fill !== undefined && /^[0-9A-Fa-f]{6}$/.test(fill) && props.shading?.pattern !== "nil"
						? { shading: fill.toUpperCase() }
						: {}),
					...(vAlign === undefined ? {} : { vAlign })
				}
			}

			if (part.kinds[own] !== Item.Row) return undefined

			const props = sourceRowProps(part, context.store, own, false)

			return {
				...(props.header === true ? { header: true } : {}),
				...(props.gridBefore === undefined || props.gridBefore === 0 ? {} : { gridBefore: props.gridBefore }),
				...(props.gridAfter === undefined || props.gridAfter === 0 ? {} : { gridAfter: props.gridAfter })
			}
		},
		width(node, index) {
			const part = partOf(index)
			const own = node.attrs["src"] as number

			if (part === undefined || own < 0 || own >= part.count || part.kinds[own] !== Item.Cell) return undefined

			const width = sourceCellProps(part, context.store, own, false).width

			return width?.type === "dxa" && width.value > 0 ? width.value : undefined
		},
		properties(kind, item, index) {
			const part = partOf(index)

			if (part === undefined || item < 0 || item >= part.count || part.kinds[item] !== COPIED_KINDS[kind]) return undefined

			const row = part.aux[item] ?? -1
			const element =
				kind === "table"
					? part.tables.tblPr[row]
					: kind === "row"
						? part.rows.trPr[row]
						: kind === "cell"
							? part.cells.tcPr[row]
							: part.sdts.sdtPr[row]

			if (element === undefined || element < 0) return undefined

			// A control's copy keeps its binding: Word keeps a mapped control mapped wherever it is pasted.
			return elementData(part, element, LEFT_OUT[kind])
		}
	}

	copiesOf.set(context, copies)

	return copies
}

function emptyTally(): Tally {
	return {
		chars: 0,
		on: [0, 0, 0, 0],
		paragraphs: 0,
		outdentable: 0,
		styles: new Map(),
		aligns: new Map(),
		lists: new Map(),
		levels: new Map()
	}
}

// A transaction setting `changes` (one step for every paragraph).
function attrsTransaction(state: EditorState, changes: AttrChanges): Transaction {
	const tr = state.tr

	changes.step(tr)

	return tr
}

function bump<K>(map: Map<K, number>, key: K, by: number): void {
	const count = (map.get(key) ?? 0) + by

	if (count === 0) map.delete(key)
	else map.set(key, count)
}

function only<K>(map: ReadonlyMap<K, number>): K | undefined {
	return map.size === 1 ? map.keys().next().value : undefined
}

interface ParagraphAt {
	readonly node: Node
	readonly pos: number
}

// The headless editing session of one story: a ProseMirror state with the document invariants, undo
// history and the read-only gate, driven by serialisable commands. A view (when there is one) dispatches
// its transactions through dispatch(); a toolbar renders snapshot() and sends execute().
export class DocxEditorSession {
	readonly context: DocxEditContext
	readonly story: StoryDoc
	private readonly builder: DocxDocBuilder
	// Effective formatting of this story's nodes (feature code shares it: one cache per paragraph).
	readonly formats: FormatResolver
	private readonly hostReadOnly: boolean
	private readonly reasons: readonly DocxReadOnlyReason[]
	private readonly transformer: DocxTransactionTransformer | undefined
	private readonly autoFormat: DocxAutoFormat
	private readonly listeners = new Set<(snapshot: DocxEditorSnapshot) => void>()
	private readonly appliedListeners = new Set<(transactions: readonly Transaction[], state: EditorState) => void>()
	private readonly refusedListeners = new Set<(reason: DocxRefusalReason) => void>()
	private current: EditorState
	private saved: Node
	// The track switch as last saved (or opened): a save writes it into settings.xml, so turning it is an edit.
	private savedTracking: boolean
	private version = 0
	private cached: DocxEditorSnapshot | null = null
	private disposed = false
	private notifying = false
	private facts = new WeakMap<object, ParagraphFacts>()
	private blockTallies = new WeakMap<Node, Tally>()
	private selectionTally: { doc: Node; from: number; to: number; tally: Tally } | null = null
	private dirtyOf: { doc: Node; saved: Node; dirty: boolean } | null = null
	private savedFormsOf: { saved: Node; forms: Map<number, Node> } | null = null
	private provided: DocxProvidedSnapshot | undefined = undefined
	private enabledOf: Readonly<Record<DocxEditorCommandType, boolean>> | undefined = undefined
	private reviewIndexOf: ReviewIndex | undefined = undefined

	constructor(context: DocxEditContext, options: DocxEditorOptions = {}) {
		const story = options.story ?? context.model.body

		if (story === undefined) throw new RangeError("The document has no body")

		this.context = context
		this.hostReadOnly = options.readOnly ?? false
		this.reasons = readOnlyReasons(context, story, this.hostReadOnly)
		this.transformer = options.transformer === null ? undefined : (options.transformer ?? registeredTransformer())
		this.autoFormat = options.autoFormat ?? AUTO_FORMAT_ON

		this.builder = new DocxDocBuilder(context)
		this.story = options.built !== undefined && options.built.story === story ? options.built : this.builder.build(story)
		this.formats = new FormatResolver(context, this.story.part)
		this.current = EditorState.create({
			doc: this.story.doc,
			plugins: [
				history({ depth: options.historyDepth ?? 100 }),
				...docxInvariantPlugins({
					readOnly: () => this.readOnly,
					commentAnchor: id => commentStory(context, story, id),
					part: this.story.part.index,
					knowOrigins: () => knowOrigins(context),
					baseFits: id => {
						const base = context.bases.get(id)

						return base !== undefined && baseFits(base, this.story.part.document)
					},
					copies: sourceCopies(context),
					notes: this.story.story.kind === "body",
					...(options.normalizeList !== undefined ? { normalizeList: options.normalizeList } : {})
				}),
				...(story.kind === "comment" ? [commentParaIds(context, this.story.part)] : [])
			]
		})

		const proof = options.proof === undefined ? conservativeProof : options.proof

		if (proof !== null) this.prove(proof)

		this.saved = this.current.doc
		this.savedTracking = context.review.tracking

		sessionMade(context, this)
	}

	// Opens a session building the story's document in slices (`pause` gives the host a turn whenever
	// `sliceMs` passed): no long task on a UI thread however long the document.
	static async open(
		context: DocxEditContext,
		options: DocxEditorOptions,
		slicing: { readonly pause: () => Promise<void>; readonly sliceMs: number; readonly now: () => number }
	): Promise<DocxEditorSession> {
		const story = options.story ?? context.model.body

		if (story === undefined) throw new RangeError("The document has no body")

		const built = await new DocxDocBuilder(context).buildSliced(story, slicing.pause, slicing.sliceMs, slicing.now)

		return new DocxEditorSession(context, { ...options, built })
	}

	get state(): EditorState {
		return this.current
	}

	get readOnly(): boolean {
		return this.reasons.length > 0
	}

	// The document author name (undefined until the app gave one).
	get author(): string | undefined {
		return this.context.identity.author
	}

	// The document as last saved (or opened): what feature units compare against.
	get savedDoc(): Node {
		return this.saved
	}

	// Comments and tracked changes of this story, kept up to date edit by edit (made on first use).
	get reviewIndex(): ReviewIndex {
		this.reviewIndexOf ??= new ReviewIndex(this.current.doc)

		return this.reviewIndexOf
	}

	// Ids of styles the document lacks that content uses (paragraphs a paragraph style, runs a character
	// style), with their built-in names: the writer adds their definitions. Styles a command added that
	// nothing uses any more are left out.
	get missingStyles(): ReadonlyMap<string, string> {
		if (this.context.newStyles.size === 0) return new Map()

		const used = this.usedParagraphValues("styleId")

		if ([...this.context.newStyles.values()].some(name => builtInStyleType(name) === "character")) this.usedCharacterStyles(used)

		return new Map([...this.context.newStyles].filter(([id]) => used.has(id)))
	}

	// Lists commands started (negative numIds) that paragraphs use: the writer adds a w:num for each.
	get newLists(): ReadonlyMap<number, NewList> {
		if (this.formats.newLists.size === 0) return new Map()

		const used = this.usedParagraphValues("numId")

		return new Map([...this.formats.newLists].filter(([id]) => used.has(id)))
	}

	// Adds the character styles content uses to `out` (a walk of all content: only when one was added).
	private usedCharacterStyles(out: Set<unknown>): void {
		this.current.doc.descendants(node => {
			const style = marks.char_style.isInSet(node.marks)
			// A tracked formatting change names the formatting before it (its w:rPrChange) too.
			const before = marks.format_change.isInSet(node.marks)?.attrs["base"] as number | null | undefined
			const styleBefore = before === null || before === undefined ? undefined : this.context.bases.get(before)?.marks

			if (style !== undefined) out.add(style.attrs["styleId"])
			if (styleBefore !== undefined) out.add(marks.char_style.isInSet(styleBefore)?.attrs["styleId"])
			// A new or edited equation keeps its runs' properties in its XML.
			if (node.type === nodes.math && typeof node.attrs["omml"] === "string") equationRunStyles(node.attrs["omml"], out)

			return node.type !== nodes.locked_block
		})
	}

	private usedParagraphValues(attr: string): Set<unknown> {
		const out = new Set<unknown>()

		this.current.doc.descendants(node => {
			if (node.type === nodes.paragraph) {
				out.add(node.attrs[attr])

				// A tracked property change names the properties before it (its w:pPrChange) too.
				const before = (
					marks.paragraph_change.isInSet(node.marks)?.attrs["value"] as
						{ props?: { before?: Record<string, unknown> } } | null | undefined
				)?.props?.before

				if (before !== undefined) out.add(before[attr])
			}

			return !node.isTextblock && node.type !== nodes.locked_block
		})

		return out
	}

	// Runs Gate 1 over [from, to) of the document and locks what fails; returns the number locked. Without
	// a proof at construction a host can call this in slices (mobile has no worker), `start` giving where each runs.
	prove(proof: BlockProof, from?: number, to?: number, start?: BlockStart): number {
		const requests = proveBlocks(this.story, this.current.doc, proof, from, to, start)
		const tr = lockBlocks(this.current, this.story, this.builder, requests)

		if (tr !== null) this.apply(tr)

		return requests.length
	}

	// The source blocks of the last-saved document (paragraphs, tables, content controls) by source id, where
	// the id is that block's alone in it: what an edited block can go back to.
	private savedForms(): Map<number, Node> {
		const cached = this.savedFormsOf

		if (cached?.saved === this.saved) return cached.forms

		const forms = new Map<number, Node>()
		const repeated = new Set<number>()

		this.saved.descendants(node => {
			if (node.isInline) return false

			const src = node.attrs["src"]

			if (typeof src === "number" && src !== NO_SOURCE && !node.isInline) {
				if (forms.has(src)) repeated.add(src)
				else forms.set(src, node)
			}

			return !node.isTextblock && node.type !== nodes.locked_block
		})

		for (const src of repeated) forms.delete(src)

		this.savedFormsOf = { saved: this.saved, forms }

		return forms
	}

	// Blocks changed since the last save (or since the document opened) that can go back to how they were
	// saved: source paragraphs, and source tables or content controls changed other than in their source
	// paragraphs (rows, new paragraphs), each with its own form in the last-saved document. Positions in
	// state.doc, in document order. What a save that the writer refused falls back on.
	editedBlocks(): number[] {
		const forms = this.savedForms()
		const seen = new Map<number, number>()

		this.current.doc.descendants(node => {
			if (node.isInline) return false

			const src = node.attrs["src"]

			if (typeof src === "number" && src !== NO_SOURCE) seen.set(src, (seen.get(src) ?? 0) + 1)

			return !node.isTextblock && node.type !== nodes.locked_block
		})

		const revertible = (node: Node): boolean => {
			const src = node.attrs["src"]

			return typeof src === "number" && src !== NO_SOURCE && seen.get(src) === 1 && forms.has(src)
		}
		const out: number[] = []
		const visit = (parent: Node, offset: number): boolean => {
			let found = false

			parent.forEach((node, at) => {
				const pos = offset + at

				if (node.isInline || node.type === nodes.locked_block || forms.get(node.attrs["src"] as number) === node) return

				if (node.isTextblock) {
					if (revertible(node)) {
						out.push(pos)
						found = true
					}

					return
				}

				if (visit(node, pos + 1)) {
					found = true

					return
				}

				// Changed, but not in a source paragraph of its own: the container is what goes back.
				if ((node.type === nodes.table || node.type === nodes.sdt) && revertible(node)) {
					out.push(pos)
					found = true
				}
			})

			return found
		}

		visit(this.current.doc, 0)

		return out
	}

	// The step taking the blocks at `positions` of `state` back to their last-saved form: a block saved as the
	// file has it is locked (kept as its bytes, decision 5); one saved with edits goes back to that edited
	// form, which the writer accepted then.
	private revertStep(state: EditorState, positions: readonly number[]): Transaction | null {
		const forms = this.savedForms()
		const tr = state.tr

		for (const pos of [...positions].sort((a, b) => b - a)) {
			const node = tr.doc.nodeAt(pos)
			const form = node === null ? undefined : forms.get(node.attrs["src"] as number)

			if (node === null || form === undefined) continue

			const replacement =
				this.story.pristine.has(form) && (form.type === nodes.paragraph || form.type === nodes.table)
					? this.builder.lockedBlock(this.story, form, "proof")
					: form

			tr.replaceWith(pos, pos + node.nodeSize, replacement)
		}

		return tr.docChanged ? markInternal(tr) : null
	}

	// A read-only stand-in for this session whose document has the blocks at `positions` (from editedBlocks)
	// back at their last-saved form: what a save would write (pass it to the writer). The session is unchanged.
	withReverted(positions: readonly number[]): DocxEditorSession {
		const tr = this.revertStep(this.current, positions)

		return tr === null ? this.standIn(this.current) : this.standIn(this.current.apply(tr))
	}

	// A read-only stand-in for this session with `tr` (made from state) applied: what a feature's unit writes
	// in place of the session. The session is unchanged.
	withTransaction(tr: Transaction): DocxEditorSession {
		return this.standIn(this.current.apply(tr))
	}

	private standIn(state: EditorState): DocxEditorSession {
		const trial: DocxEditorSession = Object.create(this) as DocxEditorSession

		Object.defineProperty(trial, "current", { value: state })
		// Its review index is made from its own document (the prototype's maps the session's).
		Object.defineProperty(trial, "reviewIndexOf", { value: undefined, writable: true })

		return trial
	}

	// Takes these blocks (nodes of the document, found where they are now) back to their last-saved form, as
	// withReverted() wrote them: one undoable step, so the edits come back with an undo (and a later save takes
	// them back again). Blocks changed since are left. Returns the number taken back.
	revert(blocks: readonly Node[]): number {
		const wanted = new Set(blocks)
		const positions: number[] = []

		this.current.doc.descendants((node, pos) => {
			if (wanted.has(node)) positions.push(pos)

			return !node.isTextblock && wanted.size > positions.length
		})

		const tr = this.revertStep(this.current, positions)

		// An undo step of its own (never merged with the typing before it).
		if (tr === null || !this.apply(closeHistory(tr))) return 0

		return positions.length
	}

	// The marks a view gives text typed or composed at the caret of `state` (this session's), where they are not
	// the caret's own (ProseMirror's choice): a paragraph mark's formatting in a paragraph holding no content.
	// Undefined elsewhere, so the view leaves typing to the browser.
	typingMarks(state: EditorState): readonly Mark[] | undefined {
		const selection = state.selection

		return selection.empty && state.storedMarks === null ? this.formats.emptyParagraphMarks(selection.$from) : undefined
	}

	// Applies a transaction from a view or a command. False when the invariants or the read-only gate
	// refused it.
	dispatch(tr: Transaction): boolean {
		// The session's own transactions skip the transformers: protection still limits what they change.
		if (isInternal(tr) && internalViolation(tr, this) !== undefined) return false

		const typed = isInternal(tr) ? undefined : typedTrigger(tr)

		if (!this.apply(tr)) return false
		if (typed !== undefined) this.autoFormatTyped(typed)

		return true
	}

	// Word's AutoFormat As You Type after `typed` (typedTrigger) was typed at the caret: its own undo step, so an
	// undo right after it gives back what was typed.
	private autoFormatTyped(typed: string): void {
		const state = this.current
		const { $from, empty } = state.selection
		const before = $from.nodeBefore

		// The typed character is right before the caret, in a paragraph.
		if (!empty || $from.parent.type !== nodes.paragraph || before === null) return
		if (typed === "\t" ? before.type !== nodes.tab : before.text?.endsWith(typed) !== true) return

		const tr =
			typed === " " || typed === "\t"
				? this.autoFormat.lists
					? this.autoList(state)
					: null
				: this.autoFormat.quotes
					? smartQuote(state, typed)
					: null

		// Typing after it starts an undo step of its own too.
		if (tr !== null && this.apply(closeHistory(tr))) this.apply(closeHistory(this.current.tr))
	}

	// "1. " (a number or letter and "." or ")") or "* ", "- ", "> " typed at the start of a paragraph in no list
	// makes it a list item: the prefix goes. Not in content controls (their content is the control's).
	private autoList(state: EditorState): Transaction | null {
		const $caret = state.selection.$from
		const paragraph = $caret.parent

		for (let depth = $caret.depth - 1; depth > 0; depth--) if ($caret.node(depth).type === nodes.sdt) return null

		if (this.formats.listOf(paragraph) !== undefined) return null

		const caret = $caret.parentOffset
		let typed = ""
		let first = -1

		// The paragraph's text up to the caret (range markers and proofing marks are not text): a short prefix only.
		for (let k = 0, offset = 0; k < paragraph.childCount && offset < caret && typed.length <= MAX_LIST_PREFIX; k++) {
			const child = paragraph.child(k)

			if (child.isText) {
				if (first < 0) first = offset
				typed += (child.text ?? "").slice(0, caret - offset)
			} else if (child.type !== nodes.marker && child.type !== nodes.proof_err) {
				typed += child.type === nodes.tab ? "\t" : OBJECT
			}

			offset += child.nodeSize
		}

		const start = first < 0 ? undefined : listPrefix(typed.slice(0, -1))

		if (start === undefined) return null

		const pos = $caret.before()
		const numId =
			start === "bullet"
				? (this.adjacentList(state, [{ node: paragraph, pos }], "bullet") ??
					this.formats.firstList("bullet") ??
					this.newList("bullet", null))
				: this.newList("numbered", null, start)
		const tr = state.tr.delete($caret.start() + first, $caret.pos)
		const node = tr.doc.nodeAt(pos)

		if (node === null) return null

		const changes = new AttrChanges()

		changes.set(node, pos, { numId, ilvl: 0, ...this.listParagraph(node) })
		changes.step(tr)

		return tr
	}

	// Runs a base command or a feature's story command; document commands (scope "document") run on the
	// paged editor, except undo and redo, which here undo this story's own edits.
	execute(command: DocxEditorCommand): boolean {
		if (this.disposed || (isWriteCommand(command.type) && (this.readOnly || !commandAllowed(this, command.type)))) return false
		if (writesUnholdableText(command)) return false

		const tr = this.transactionFor(command)

		if (tr === null) return false
		if (tr === true) return true

		return this.apply(tr)
	}

	canExecute(type: DocxEditorCommandType): boolean {
		return this.snapshot().enabled[type]
	}

	// Call after the document was written: it is no longer dirty. `doc` and `tracking` are the document and the
	// track switch as the save read them, so edits made while the file was written or stored stay unsaved.
	markSaved(doc: Node = this.current.doc, tracking: boolean = this.context.review.tracking): void {
		if (doc === this.saved && tracking === this.savedTracking) return

		this.saved = doc
		this.savedTracking = tracking
		this.changed()
	}

	// The document context changed outside a transaction (the author's name, the track switch): the snapshot
	// is made again and listeners hear it.
	invalidate(): void {
		if (!this.disposed) this.changed()
	}

	subscribe(listener: (snapshot: DocxEditorSnapshot) => void): () => void {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	// Hears each user edit (typing, composition, paste, drop, a shortcut) the session refused, with why; never
	// an undo or the editor's own changes.
	onRefused(listener: (reason: DocxRefusalReason) => void): () => void {
		this.refusedListeners.add(listener)

		return () => {
			this.refusedListeners.delete(listener)
		}
	}

	// Hears every change of state synchronously, with the transactions that made it (the one applied first,
	// then those the invariants appended): a paged view lays the document out again from them.
	onApplied(listener: (transactions: readonly Transaction[], state: EditorState) => void): () => void {
		this.appliedListeners.add(listener)

		return () => {
			this.appliedListeners.delete(listener)
		}
	}

	dispose(): void {
		this.disposed = true
		this.listeners.clear()
		this.appliedListeners.clear()
		this.refusedListeners.clear()
		sessionGone(this.context, this)
		releaseHistory()
	}

	snapshot(): DocxEditorSnapshot {
		this.cached ??= this.computeSnapshot()

		return this.cached
	}

	// ---- internals --------------------------------------------------------------------------------------

	// Runs a keystroke through the transformers and plugins and drops it: the code a first edit runs is compiled
	// before the user types (work for an idle host; nothing is kept). Not while read-only or after an edit.
	warmUp(): void {
		if (this.disposed || this.readOnly || this.current.doc !== this.story.doc) return

		const state = this.current
		const at = TextSelection.findFrom(state.selection.$head, 1, true) ?? TextSelection.findFrom(state.doc.resolve(0), 1, true)

		if (at === null) return

		const tr = state.tr.setSelection(at).insertText("a")
		// A tracked keystroke takes a change id: the next real one takes it again.
		const ids = this.context.ids.saved()

		try {
			state.applyTransaction(this.transformer === undefined ? tr : this.transformer(tr, this))
		} finally {
			this.context.ids.restore(ids)
		}

		indexOriginals(this.story)
	}

	private apply(tr: Transaction): boolean {
		if (this.disposed) return false

		const transformed =
			this.transformer !== undefined && tr.docChanged && !isInternal(tr) && !isHistoryTransaction(tr)
				? this.transformer(tr, this)
				: tr
		const result = this.current.applyTransaction(transformed)

		if (result.transactions.length === 0) {
			// Only the transformer marks a transaction refused for its author (never an undo or the session's own).
			if (this.refusedListeners.size > 0 && refusedForAuthor(transformed)) {
				const reason: DocxRefusalReason | undefined = refusedUnsupported(transformed)
					? "unsupported"
					: (this.author ?? "") === ""
						? "authorNeeded"
						: undefined

				if (reason !== undefined) for (const listener of this.refusedListeners) listener(reason)
			}

			return false
		}

		this.current = result.state
		this.reviewIndexOf?.applyAll(result.transactions)

		for (const listener of this.appliedListeners) listener(result.transactions, result.state)

		this.changed()

		return true
	}

	// Listeners hear once per burst of changes (a microtask later), with the snapshot then current.
	private changed(): void {
		this.version++
		this.cached = null

		if (this.listeners.size === 0 || this.notifying) return

		this.notifying = true
		void Promise.resolve().then(() => {
			this.notifying = false

			if (this.disposed || this.listeners.size === 0) return

			const snapshot = this.snapshot()

			for (const listener of this.listeners) listener(snapshot)
		})
	}

	// The transaction a command makes; true when it ran without one (undo/redo), null when it cannot run.
	private transactionFor(command: DocxEditorCommand): Transaction | true | null {
		const state = this.current

		switch (command.type) {
			case "format.bold":
				return this.toggle("bold")
			case "format.italic":
				return this.toggle("italic")
			case "format.underline":
				return this.toggle("underline")
			case "format.strike":
				return this.toggle("strike")
			case "format.clear":
				return this.clearFormatting()
			case "style.set":
				return this.setStyle(command.style)
			case "align.start":
				return this.align("start")
			case "align.center":
				return this.align("center")
			case "align.end":
				return this.align("end")
			case "align.justify":
				return this.align("justify")
			case "list.bullet":
				return this.toggleList("bullet")
			case "list.numbered":
				return this.toggleList("numbered")
			case "list.indent":
				return this.indent(1)
			case "list.outdent":
				return this.indent(-1)
			case "history.undo":
				return undo(state, tr => this.apply(tr)) ? true : null
			case "history.redo":
				return redo(state, tr => this.apply(tr)) ? true : null
			default: {
				const handler = commandInfo(command.type)?.scope === "story" ? storyHandler(command.type) : undefined

				return handler === undefined ? null : handler.run(this.commandContext(), command as never)
			}
		}
	}

	private commandContext(): StoryCommandContext {
		return { session: this, state: this.current, context: this.context }
	}

	private paragraphs(state: EditorState = this.current): ParagraphAt[] {
		const out: ParagraphAt[] = []
		const seen = new Set<number>()

		for (const range of state.selection.ranges) {
			state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
				if (node.type === nodes.paragraph) {
					if (!seen.has(pos)) {
						seen.add(pos)
						out.push({ node, pos })
					}

					return false
				}

				return !node.isInline && node.type !== nodes.locked_block
			})
		}

		return out
	}

	// Run-level content in the selection as [from, to) pieces with their paragraph (what formatting changes:
	// not markers or locked blocks).
	private runPieces(state: EditorState, ranges?: readonly { readonly from: number; readonly to: number }[]): RunPiece[] {
		const out: RunPiece[] = []

		for (const { from, to } of ranges ?? state.selection.ranges.map(range => ({ from: range.$from.pos, to: range.$to.pos }))) {
			state.doc.nodesBetween(from, to, (node, pos, parent) => {
				if (!node.isInline) return node.type !== nodes.locked_block

				// A field takes formatting as its runs do (§17.16.4.3).
				if (parent !== null && parent.type === nodes.paragraph && (inlineLevel(node) === "run" || node.type === nodes.field)) {
					const start = Math.max(from, pos)
					const end = Math.min(to, pos + node.nodeSize)

					if (end > start) out.push({ from: start, to: end, node, paragraph: parent })
				}

				return false
			})
		}

		return out
	}

	private toggleMark(toggle: RunToggle, on: boolean): Mark {
		switch (toggle) {
			case "bold":
			case "italic":
				return marks[toggle].create({ value: on, cs: on })
			case "underline":
				return on ? marks.underline.create({ style: "single" }) : marks.underline.create({ style: "none" })
			case "strike":
				return marks.strike.create({ value: on })
		}
	}

	private toggle(toggle: RunToggle): Transaction | null {
		const state = this.current
		const selection = state.selection
		const type = marks[toggle]
		// A caret inside a word formats the word (Word's "automatically select entire word"), staying where it is.
		const word = wordAround(state)

		if (selection.empty && word === undefined) {
			const paragraph = selection.$from.parent

			if (paragraph.type !== nodes.paragraph) return null

			const format = this.formats.paragraph(paragraph)
			const current = caretMarks(state, this.formats)
			const value = this.formats.toggle(toggle, format, current)
			const desired = !value.on
			const tr = state.tr.setStoredMarks(current).removeStoredMark(type)

			if (toggle === "strike" && desired) {
				// Word allows one of strikethrough and double strikethrough.
				tr.removeStoredMark(marks.double_strike)

				if (this.formats.styleValues(format, current).doubleStrike) tr.addStoredMark(NO_DOUBLE_STRIKE)
			}

			return desired === value.style ? tr : tr.addStoredMark(this.toggleMark(toggle, desired))
		}

		const pieces = this.runPieces(state, word === undefined ? undefined : [word])

		if (pieces.length === 0) return null

		const resolved = pieces.map(piece => this.formats.toggle(toggle, this.formats.paragraph(piece.paragraph), piece.node.marks))
		const desired = !resolved.every(value => value.on)
		const mark = this.toggleMark(toggle, desired)
		const changes = new MarkChanges()

		// Direct formatting only where the styles do not already give the result: a piece gets the mark, or loses
		// its own where the style gives the result, or stays.
		pieces.forEach((piece, index) => {
			const direct = desired !== (resolved[index]?.style ?? false)
			const existing = type.isInSet(piece.node.marks)

			if (direct && existing?.eq(mark) !== true) changes.add(piece.from, piece.to, mark)
			else if (!direct && existing !== undefined) changes.add(piece.from, piece.to, null)
		})

		const tr = state.tr

		changes.step(tr, mark)

		if (toggle === "strike" && desired) {
			// Word allows one of strikethrough and double strikethrough: the double goes, switched off where a style
			// gives it.
			const doubles = new MarkChanges()

			for (const piece of pieces) {
				const own = marks.double_strike.isInSet(piece.node.marks)
				const styled = this.formats.styleValues(this.formats.paragraph(piece.paragraph), piece.node.marks).doubleStrike
				const wanted = styled ? NO_DOUBLE_STRIKE : null

				if (own === undefined ? wanted !== null : wanted === null || !own.eq(wanted)) doubles.add(piece.from, piece.to, wanted)
			}

			doubles.step(tr, NO_DOUBLE_STRIKE)
		}

		return tr.docChanged ? tr : null
	}

	// Word's Ctrl+Space: direct character formatting goes, the language stays, and the `plain` mark tells a
	// writer to ignore the run's source formatting except w:rtl and w:cs.
	private clearFormatting(): Transaction | null {
		const state = this.current
		const selection = state.selection
		const plain = marks.plain.create()
		const word = wordAround(state)

		if (selection.empty && word === undefined) {
			if (selection.$from.parent.type !== nodes.paragraph) return null

			const current = caretMarks(state, this.formats)

			return state.tr.setStoredMarks(plain.addToSet(current.filter(mark => !CLEARED_TYPES.includes(mark.type))))
		}

		const pieces = this.runPieces(state, word === undefined ? undefined : [word])

		if (pieces.length === 0) return null

		// One step for every mark type: each piece ends with the plain mark and none of the cleared.
		const changes = new MarkSetChanges(CLEARED_TYPES)
		const onlyPlain = [plain]

		for (const piece of pieces) {
			if (
				piece.node.marks.some(mark => mark.type !== marks.plain && CLEARED_TYPES.includes(mark.type)) ||
				!plain.isInSet(piece.node.marks)
			)
				changes.add(piece.from, piece.to, onlyPlain)
		}

		const tr = state.tr

		changes.step(tr, plain)

		return tr.docChanged ? tr : null
	}

	// The id of a built-in paragraph style, adding it to the styles the writer must define when missing.
	private styleIdFor(style: DocxParagraphStyle): string | null {
		const styles = this.context.styles

		if (style === "normal") {
			const normal = styles.defaultOf("paragraph")

			return normal === undefined || normal.canonicalName === "normal" ? null : (styles.byName("normal", "paragraph")?.id ?? null)
		}

		return this.builtInId(PARAGRAPH_STYLE_NAMES[style])
	}

	// The id of built-in style `name`, added to the styles the writer defines when the document lacks it.
	private builtInId(name: string): string {
		const added = this.context.newStyles.size
		const id = builtInStyleId(this.context, name)

		// A paragraph naming the id before it was defined is named by it now.
		if (this.context.newStyles.size !== added) {
			this.facts = new WeakMap()
			this.blockTallies = new WeakMap()
		}

		return id
	}

	private get openDocument(): boolean {
		return openDocumentTranslation(this.context.model.settings)
	}

	// The style a paragraph made a list item takes: List Paragraph for one in the default paragraph style (as
	// Word, unless "Use Normal style for bulleted or numbered lists" is on); others keep theirs. A document
	// translated from OpenDocument keeps every paragraph's style, as LibreOffice does.
	private listParagraph(node: Node): { readonly styleId?: string } {
		if (this.openDocument) return {}

		const id = node.attrs["styleId"] as string | null
		const styles = this.context.styles

		return id === null || (styles.byId(id) !== undefined && styles.byId(id) === styles.defaultOf("paragraph"))
			? { styleId: this.builtInId(LIST_PARAGRAPH) }
			: {}
	}

	// The style a list item taken out of its list takes: Normal for one in List Paragraph, else its own (always
	// its own in a document translated from OpenDocument, see listParagraph).
	private unlistedParagraph(node: Node): { readonly styleId?: string | null } {
		if (this.openDocument) return {}

		const id = node.attrs["styleId"] as string | null
		const name = id === null ? undefined : (this.context.newStyles.get(id) ?? this.context.styles.byId(id)?.canonicalName)

		return name !== undefined && name.toLowerCase() === LIST_PARAGRAPH_KEY ? { styleId: this.styleIdFor("normal") } : {}
	}

	private setStyle(style: DocxParagraphStyle): Transaction | null {
		const paragraphs = this.paragraphs()

		if (paragraphs.length === 0) return null

		const styleId = this.styleIdFor(style)
		const changes = new AttrChanges()

		for (const at of paragraphs) changes.set(at.node, at.pos, { styleId })

		return attrsTransaction(this.current, changes)
	}

	private align(alignment: DocxAlignment): Transaction | null {
		const paragraphs = this.paragraphs()

		if (paragraphs.length === 0) return null

		const value = alignment === "start" ? "left" : alignment === "end" ? "right" : alignment === "justify" ? "both" : "center"
		const changes = new AttrChanges()

		for (const at of paragraphs) {
			const fromStyle = alignmentOf(this.formats.styleParagraph(at.node.attrs["styleId"] as string | null).props.alignment)

			// No direct property where the style already aligns the paragraph so.
			changes.set(at.node, at.pos, { align: fromStyle === alignment ? null : value })
		}

		return attrsTransaction(this.current, changes)
	}

	private toggleList(kind: ListKind): Transaction | null {
		const state = this.current
		const paragraphs = this.paragraphs(state)

		if (paragraphs.length === 0) return null

		const lists = paragraphs.map(at => this.formats.listOf(at.node))
		const changes = new AttrChanges()

		if (lists.every(list => list?.kind === kind)) {
			for (const at of paragraphs)
				changes.set(at.node, at.pos, { ...this.formats.numberingOff(at.node), ...this.unlistedParagraph(at.node) })

			return attrsTransaction(state, changes)
		}

		// Continue the list next to the selection; else bullets take the document's first bullet list, and a
		// numbered list starts afresh on the definition of the document's first numbered list.
		const existing = this.formats.firstList(kind)
		const numId =
			this.adjacentList(state, paragraphs, kind) ?? (kind === "bullet" ? existing : undefined) ?? this.newList(kind, existing ?? null)

		paragraphs.forEach((at, index) => {
			const list = lists[index]

			// A paragraph already in a list (of the other kind) keeps its style.
			changes.set(at.node, at.pos, { numId, ilvl: list?.ilvl ?? 0, ...(list === undefined ? this.listParagraph(at.node) : {}) })
		})

		return attrsTransaction(state, changes)
	}

	// The list of the paragraph right before the selection (or right after it) when it is of `kind`: a
	// new item continues it.
	private adjacentList(state: EditorState, paragraphs: readonly ParagraphAt[], kind: ListKind): number | undefined {
		const first = paragraphs[0]
		const last = paragraphs[paragraphs.length - 1]

		if (first === undefined || last === undefined) return undefined

		const before = state.doc.resolve(first.pos).nodeBefore
		const after = state.doc.resolve(last.pos + last.node.nodeSize).nodeAfter

		for (const node of [before, after]) {
			if (node?.type !== nodes.paragraph) continue

			const list = this.formats.listOf(node)

			if (list?.kind === kind) return list.numId
		}

		return undefined
	}

	private newList(kind: ListKind, basedOn: number | null, first?: ListStart): number {
		// One numbering for every session of the document: lists of different stories never share an id.
		const id = -(this.formats.newLists.size + 1)

		this.formats.newLists.set(id, first === undefined ? { kind, basedOn } : { kind, basedOn, first })
		this.facts = new WeakMap()
		this.blockTallies = new WeakMap()

		return id
	}

	private indent(direction: 1 | -1): Transaction | null {
		const paragraphs = this.paragraphs()

		if (paragraphs.length === 0) return null

		const changes = new AttrChanges()

		for (const at of paragraphs) {
			const list = this.formats.listOf(at.node)

			if (list !== undefined) {
				const ilvl = Math.max(0, Math.min(MAX_LIST_LEVEL, list.ilvl + direction))

				changes.set(at.node, at.pos, { numId: list.numId, ilvl })

				continue
			}

			const indent = (at.node.attrs["indent"] as IndentAttrs | null) ?? {}
			const current = this.formats.paragraph(at.node).props.indent.start
			// Steps land on multiples of the step, as Word's indent buttons do.
			const next =
				direction > 0
					? (Math.floor(current / INDENT_STEP) + 1) * INDENT_STEP
					: Math.max(0, (Math.ceil(current / INDENT_STEP) - 1) * INDENT_STEP)

			if (next === current) continue

			const { startChars: _startChars, ...rest } = indent

			changes.set(at.node, at.pos, { indent: { ...rest, start: next } })
		}

		return changes.empty ? null : attrsTransaction(this.current, changes)
	}

	private paragraphFacts(node: Node): ParagraphFacts {
		let facts = this.facts.get(node.attrs)

		if (facts === undefined) {
			const format = this.formats.paragraph(node)
			const own = this.paragraphStyle(node, format.style?.canonicalName, format.style?.id)
			const list = this.formats.listOf(node)

			facts = {
				style: own.style === "custom" ? `custom:${own.name ?? ""}` : own.style,
				align: alignmentOf(format.props.alignment),
				list: list?.kind ?? "none",
				level: list?.ilvl ?? -1,
				outdentable: list !== undefined ? list.ilvl > 0 : format.props.indent.start > 0
			}
			this.facts.set(node.attrs, facts)
		}

		return facts
	}

	private addParagraph(tally: Tally, node: Node, sign: number): void {
		const facts = this.paragraphFacts(node)

		tally.paragraphs += sign
		tally.outdentable += facts.outdentable ? sign : 0
		bump(tally.styles, facts.style, sign)
		bump(tally.aligns, facts.align, sign)
		bump(tally.lists, facts.list, sign)

		if (facts.level >= 0) bump(tally.levels, facts.level, sign)
	}

	// The paragraph a position is inside of (after its start token), which a range starting there touches.
	private addContaining(tally: Tally, doc: Node, pos: number, sign: number): void {
		const $pos = doc.resolve(pos)

		for (let depth = $pos.depth; depth > 0; depth--) {
			if ($pos.node(depth).type === nodes.paragraph) {
				this.addParagraph(tally, $pos.node(depth), sign)

				return
			}
		}
	}

	private addTally(tally: Tally, add: Tally, sign: number): void {
		tally.chars += sign * add.chars
		tally.paragraphs += sign * add.paragraphs
		tally.outdentable += sign * add.outdentable

		for (let k = 0; k < tally.on.length; k++) tally.on[k] = (tally.on[k] ?? 0) + sign * (add.on[k] ?? 0)
		for (const [key, count] of add.styles) bump(tally.styles, key, sign * count)
		for (const [key, count] of add.aligns) bump(tally.aligns, key, sign * count)
		for (const [key, count] of add.lists) bump(tally.lists, key, sign * count)
		for (const [key, count] of add.levels) bump(tally.levels, key, sign * count)
	}

	private addInline(tally: Tally, paragraph: Node, node: Node, size: number, sign: number): void {
		const bits = this.formats.toggles(this.formats.paragraph(paragraph), node.marks)

		tally.chars += sign * size

		for (let k = 0; k < RUN_TOGGLES.length; k++) if ((bits & (TOGGLE_ON << k)) !== 0) tally.on[k] = (tally.on[k] ?? 0) + sign * size
	}

	// A block wholly in the selection. Tables and content controls keep their tally (by node identity: an
	// edit elsewhere leaves them as they were), so selecting everything again after an edit recounts only
	// what changed.
	private addBlock(tally: Tally, node: Node, sign: number): void {
		if (node.type === nodes.paragraph) {
			this.addParagraph(tally, node, sign)
			node.forEach(child => {
				if (inlineLevel(child) === "run") this.addInline(tally, node, child, child.nodeSize, sign)
			})

			return
		}

		if (node.type === nodes.locked_block || node.isInline) return

		if (node.type === nodes.table || node.type === nodes.sdt) {
			let own = this.blockTallies.get(node)

			if (own === undefined) {
				own = emptyTally()

				const target = own

				node.forEach(child => this.addBlock(target, child, 1))
				this.blockTallies.set(node, own)
			}

			this.addTally(tally, own, sign)

			return
		}

		node.forEach(child => this.addBlock(tally, child, sign))
	}

	// Run content clipped to [from, to) and the paragraphs starting there.
	private addRange(tally: Tally, doc: Node, from: number, to: number, sign: number): void {
		if (to <= from) return

		doc.nodesBetween(from, to, (node, pos, parent) => {
			if (!node.isInline) {
				if (pos >= from && pos + node.nodeSize <= to) {
					this.addBlock(tally, node, sign)

					return false
				}

				if (node.type === nodes.paragraph && pos >= from) this.addParagraph(tally, node, sign)

				return node.type !== nodes.locked_block
			}

			if (parent !== null && parent.type === nodes.paragraph && (inlineLevel(node) === "run" || node.type === nodes.field)) {
				const size = Math.min(to, pos + node.nodeSize) - Math.max(from, pos)

				if (size > 0) this.addInline(tally, parent, node, size, sign)
			}

			return false
		})
	}

	// The tally of the selection: updated by the difference when only its ends moved on the same document
	// (extending a selection), else counted afresh.
	private tally(state: EditorState): Tally {
		const selection = state.selection
		const doc = state.doc

		if (selection.ranges.length !== 1) {
			const tally = emptyTally()

			for (const range of selection.ranges) {
				this.addContaining(tally, doc, range.$from.pos, 1)
				this.addRange(tally, doc, range.$from.pos, range.$to.pos, 1)
			}

			this.selectionTally = null

			return tally
		}

		const from = selection.from
		const to = selection.to
		const cached = this.selectionTally

		if (cached !== null && cached.doc === doc && Math.abs(from - cached.from) + Math.abs(to - cached.to) <= to - from) {
			const tally = cached.tally

			if (from !== cached.from) {
				this.addContaining(tally, doc, cached.from, -1)
				this.addContaining(tally, doc, from, 1)

				if (from < cached.from) this.addRange(tally, doc, from, cached.from, 1)
				else this.addRange(tally, doc, cached.from, from, -1)
			}

			if (to > cached.to) this.addRange(tally, doc, cached.to, to, 1)
			else if (to < cached.to) this.addRange(tally, doc, to, cached.to, -1)

			this.selectionTally = { doc, from, to, tally }

			return tally
		}

		const tally = emptyTally()

		this.addContaining(tally, doc, from, 1)
		this.addRange(tally, doc, from, to, 1)
		this.selectionTally = { doc, from, to, tally }

		return tally
	}

	private dirty(doc: Node): boolean {
		const cached = this.dirtyOf

		if (this.context.review.persist && this.context.review.tracking !== this.savedTracking) return true
		if (cached !== null && cached.doc === doc && cached.saved === this.saved) return cached.dirty

		const dirty = !this.saved.eq(doc)

		this.dirtyOf = { doc, saved: this.saved, dirty }

		return dirty
	}

	private computeSnapshot(): DocxEditorSnapshot {
		const state = this.current
		const selection = state.selection
		const readOnly = this.readOnly
		const tally = this.tally(state)
		const formats = { bold: "off", italic: "off", underline: "off", strike: "off" } as Record<RunToggle, FormatState>

		if (selection.empty) {
			const paragraph = selection.$from.parent

			if (paragraph.type === nodes.paragraph) {
				const bits = this.formats.toggles(this.formats.paragraph(paragraph), caretMarks(state, this.formats))

				RUN_TOGGLES.forEach((toggle, k) => {
					formats[toggle] = (bits & (TOGGLE_ON << k)) !== 0 ? "on" : "off"
				})
			}
		} else {
			RUN_TOGGLES.forEach((toggle, k) => {
				const on = tally.on[k] ?? 0

				formats[toggle] = tally.chars === 0 || on === 0 ? "off" : on === tally.chars ? "on" : "mixed"
			})
		}

		const styleKey = only(tally.styles)
		const style: DocxParagraphStyle | "custom" | "mixed" | null =
			tally.paragraphs === 0
				? null
				: styleKey === undefined
					? "mixed"
					: styleKey.startsWith("custom:")
						? "custom"
						: (styleKey as DocxParagraphStyle)
		const alignKey = only(tally.aligns)
		const listKey = only(tally.lists)
		const list = tally.paragraphs === 0 ? null : ((listKey ?? "mixed") as ListKind | "none" | "mixed")
		const lockedNode =
			selection.$from.nodeAfter?.type === nodes.locked_block && selection.to - selection.from <= 1 ? selection.$from.nodeAfter : null
		const writable = !readOnly && tally.paragraphs > 0
		const undoable = !readOnly && undoDepth(state) > 0
		const redoable = !readOnly && redoDepth(state) > 0
		const provided = providedSnapshot({ session: this, state, context: this.context, readOnly }, this.provided)
		const commandContext = this.commandContext()
		const enabledOf = (info: DocxEditorCommandInfo): boolean => {
			switch (info.type) {
				case "history.undo":
					return undoable
				case "history.redo":
					return redoable
				case "list.outdent":
					return writable && tally.outdentable > 0
			}

			// Document protection that allows edits within limits (forms, comments, tracked changes).
			if (info.write && !commandAllowed(this, info.type)) return false
			if (BASE_TYPES.has(info.type)) return writable
			if (info.scope !== "story" || (readOnly && info.write)) return false

			return storyHandler(info.type)?.enabled(commandContext) === true
		}
		const previous = this.enabledOf
		let same = previous !== undefined
		const values: boolean[] = []

		// One pass; the same record while every command's state is (a toolbar compares it by identity).
		for (const info of DOCX_EDITOR_COMMANDS) {
			const value = enabledOf(info)

			values.push(value)

			if (same && previous?.[info.type] !== value) same = false
		}

		let enabled = previous

		if (!same || enabled === undefined) {
			const record: Record<string, boolean> = {}

			DOCX_EDITOR_COMMANDS.forEach((info, k) => {
				record[info.type] = values[k] ?? false
			})
			enabled = record as Record<DocxEditorCommandType, boolean>
			this.enabledOf = enabled
		}

		this.provided = provided

		return {
			version: this.version,
			readOnly,
			readOnlyReasons: this.reasons,
			dirty: this.dirty(state.doc),
			canUndo: undoable,
			canRedo: redoable,
			selection: {
				empty: selection.empty,
				from: selection.from,
				to: selection.to,
				locked: lockedNode === null ? null : (lockedNode.attrs["reason"] as LockReason),
				paragraphs: tally.paragraphs
			},
			formats,
			paragraph: {
				style,
				styleName: style === "custom" && styleKey !== undefined ? styleKey.slice("custom:".length) || null : null,
				align: tally.paragraphs === 0 ? null : ((alignKey ?? "mixed") as DocxAlignment | "other" | "mixed"),
				list,
				level: list !== null && list !== "none" && list !== "mixed" ? (only(tally.levels) ?? null) : null
			},
			values: provided.values,
			context: provided.context,
			review: provided.review,
			enabled
		}
	}

	private paragraphStyle(
		node: Node,
		canonical: string | undefined,
		id: string | undefined
	): { style: DocxParagraphStyle | "custom"; name: string | null } {
		const styleId = node.attrs["styleId"] as string | null
		const missing = styleId === null ? undefined : this.context.newStyles.get(styleId)
		const name = missing ?? (id === this.context.styles.defaultOf("paragraph")?.id ? "normal" : canonical)

		const style = name === undefined ? undefined : STYLE_OF_NAME.get(name)

		if (style !== undefined) return { style, name: null }

		// A style a command added (List Paragraph) is named by its built-in name until the save defines it.
		return { style: "custom", name: missing ?? (id === undefined ? undefined : this.context.styles.byId(id)?.name) ?? null }
	}
}
