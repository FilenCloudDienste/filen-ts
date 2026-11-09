import { BreakKind, ParagraphBuilder, TabAlignment, TabLeader, type StyleTable } from "../../text/index"
import type { DocxModel } from "../model/document"
import { BreakClear, BreakType, FieldCharType, Item, RevisionView } from "../model/kinds"
import { Ns } from "../model/namespaces"
import type { StoryPart } from "../model/part"
import type { ListMarker, NumberingCounters } from "../numbering/counter"
import { EMPTY_RUN } from "../props/parse"
import type { PropsStore } from "../props/store"
import type { ResolvedRunProps, RunProps } from "../props/types"
import type { CellFormat, ParagraphFormat, PropertyResolver } from "../styles/resolve"
import { FieldKind, dateTimeText, fieldInfo, formFieldLook, macroButtonText, numberText, type FieldCodes, type FieldInfo } from "./fields"
import { objectAt, ObjectKind, type ObjectSizer, type ObjectTable } from "./objects"
import { TrackedLook, revisionLook, shadingDark, type RunStyles } from "./styles"
import { halfPoints, twips } from "./units"

// Builds the text a paragraph lays out from the model: runs resolved to styles, fields shown as their
// results (page fields and legacy form fields computed) or, in the field codes view, as their codes between
// braces, hidden text and tracked changes per view, list markers, note references, symbols, positional tabs
// and objects.

// Field values for the page being laid out.
export interface PageValues {
	page: number
	// The section's w:pgNumType format.
	pageFormat: string | undefined
	numPages: number
	sectionPages: number
	// The chapter number and its separator page numbers begin with (w:pgNumType chapStyle, chapSep), absent
	// without one.
	chapter?: string | undefined
}

// A page number as fields and page lists show it: the chapter prefix, then the number in `format`.
export function pageNumberText(page: number, format: string | undefined, chapter: string | undefined): string {
	const text = numberText(page, format)

	return chapter === undefined ? text : chapter + text
}

// The character w:chapSep names (§17.18.6), a hyphen by default.
export function chapterSeparator(value: string | undefined): string {
	switch (value) {
		case "period":
			return "."
		case "colon":
			return ":"
		case "emDash":
			return "—"
		case "enDash":
			return "–"
		default:
			return "-"
	}
}

// Numbers of note references, assigned in layout order.
export interface NoteNumbers {
	// The mark text of a reference (empty for w:customMarkFollows).
	reference(endnote: boolean, part: number, item: number, story: number): string
	// A paragraph's references are about to be numbered.
	beginParagraph(): void
}

// The story a paragraph belongs to, and its own counters.
export interface StoryContext {
	readonly part: StoryPart
	readonly story: number
	readonly counters: NumberingCounters | undefined
	// The mark text of the note being laid out (w:footnoteRef / w:endnoteRef).
	readonly noteMark: string
	// Page and column breaks do not apply (headers, footers, notes, cells, text boxes).
	readonly breaksAsLines: boolean
	// Counted from its start each time it is laid out, its list markers not kept between layouts: a header or
	// footer shows the same numbers on every page, whichever of its blocks an edit changed.
	readonly recount: boolean
}

export const FieldFlag = { PAGE: 1, TOTALS: 2 } as const

export class BuiltParagraph {
	first = -1
	// The part of the first paragraph.
	firstPart = -1
	last = -1
	format: ParagraphFormat | undefined = undefined
	markStyle = 0
	text = ""
	// The list marker's width and lvlJc ("left", "center", "right"), 0 / "" without a marker.
	markerWidth = 0
	markerAlignment = ""
	// Anchored objects (ids) in text order, and the text offset each is anchored at.
	readonly floats: number[] = []
	readonly floatOffsets: number[] = []
	// Note references: text offset, story index and 1 for endnotes.
	readonly noteOffsets: number[] = []
	readonly noteStories: number[] = []
	readonly noteEndnote: number[] = []
	// Inline objects with text boxes inside.
	readonly boxedObjects: number[] = []
	// w:lastRenderedPageBreak positions (text offsets).
	readonly renderedBreaks: number[] = []
	fieldFlags = 0
	// PAGE field results: start and end text offsets.
	readonly pageFields: number[] = []
	// The paragraph has only a mark (no text, tabs or objects).
	empty = true
	dropCap: "drop" | "margin" | undefined = undefined
	// Where each item's content landed in `text` (SOURCE_MAP_INTS per item), when the layout records it.
	map: Int32Array | undefined = undefined

	reset(): void {
		this.first = -1
		this.firstPart = -1
		this.last = -1
		this.format = undefined
		this.markStyle = 0
		this.text = ""
		this.markerWidth = 0
		this.markerAlignment = ""
		this.floats.length = 0
		this.floatOffsets.length = 0
		this.noteOffsets.length = 0
		this.noteStories.length = 0
		this.noteEndnote.length = 0
		this.boxedObjects.length = 0
		this.renderedBreaks.length = 0
		this.fieldFlags = 0
		this.pageFields.length = 0
		this.empty = true
		this.dropCap = undefined
		this.map = undefined
	}
}

const FIELD_CODE = 0
const FIELD_RESULT = 1
// A computed field: its stored result is replaced.
const FIELD_REPLACED = 2
// Shown as its code (the field codes view): the code laid out, the result after it hidden.
const FIELD_SHOWN = 3
const FIELD_SHOWN_RESULT = 4

const LEADERS: Readonly<Record<string, TabLeader>> = {
	dot: TabLeader.DOT,
	hyphen: TabLeader.HYPHEN,
	underscore: TabLeader.UNDERSCORE,
	heavy: TabLeader.HEAVY,
	middleDot: TabLeader.MIDDLE_DOT
}

export interface ContentServices {
	readonly model: DocxModel
	readonly resolver: PropertyResolver
	readonly store: PropsStore
	readonly styles: RunStyles
	readonly objects: ObjectTable
	readonly sizer: ObjectSizer | undefined
	readonly notes: NoteNumbers
	// Line spacing multiples stretch inline objects too.
	readonly stretchObjects: boolean
	readonly view: RevisionView
	readonly showHidden: boolean
	// List markers already counted, by paragraph: a paragraph laid out again must not count twice.
	readonly markers: Map<number, ListMarker | null>
	// Record where each item's content lands in the paragraph text (editing maps positions through it).
	readonly recordMaps: boolean
	// Without recordMaps, the paragraphs whose maps are recorded anyway (those holding links).
	readonly mapParagraph: ((part: StoryPart, paragraph: number) => boolean) | undefined
	// The key list markers are counted under for paragraph `item` of part `part`.
	readonly memoKey: (part: number, item: number) => number
	// The index of a tracked change's author (-1 for none), numbered as reviewers are.
	readonly authors: (name: string | undefined) => number
	// The time DATE and TIME fields show (LayoutOptions.date), read once per layout.
	readonly now: Date
}

// A legacy check box's run properties at its own size (w:size), one object per run properties and size so
// resolved runs (and their styles) are shared.
const SIZED_RUNS = new WeakMap<RunProps, Map<number, RunProps>>()

// Whether a paragraph's mark is not shown (w:vanish, w:specVanish on the mark): the paragraph then joins the
// next one (one paragraph built, one list marker counted), as Word lays it out.
export function markVanishes(mark: ResolvedRunProps, showHidden: boolean): boolean {
	return !showHidden && (mark.vanish || mark.specVanish)
}

// The text a list marker shows: a picture bullet without text of its own shows as a bullet character.
export function listMarkerText(marker: ListMarker): string {
	return marker.pictureBullet !== undefined && marker.text === "" ? "\u2022" : marker.text
}

function sizedRun(direct: RunProps, size: number): RunProps {
	let sizes = SIZED_RUNS.get(direct)
	let sized = sizes?.get(size)

	if (sized !== undefined) return sized

	sized = Object.freeze({ ...direct, size, sizeCs: size })

	if (sizes === undefined) {
		sizes = new Map()
		SIZED_RUNS.set(direct, sizes)
	}

	sizes.set(size, sized)

	return sized
}

// A computed field's value: a page field's \* format, a DATE or TIME field's text, or a legacy form field's look
// and the run it is drawn in.
interface FieldValue {
	readonly format: string | undefined
	readonly text: string | undefined
	readonly run: ResolvedRunProps | undefined
	// A legacy check box: whether it is checked.
	readonly checked?: boolean
}

const NO_VALUE: FieldValue = { format: undefined, text: undefined, run: undefined }

// Decoded text of text items by part, while editing: a relayout lays the paragraphs around an edit out again
// keystroke after keystroke, and their text is decoded once. Bounded by characters (cleared when full); a part
// that goes (an edited block's earlier overlay) takes its entries with it.
const TEXT_CACHE_CHARS = 1 << 18
let textCache = new WeakMap<StoryPart, Map<number, string>>()
let textCacheChars = 0

function cachedText(part: StoryPart, item: number): string {
	let texts = textCache.get(part)
	let text = texts?.get(item)

	if (text !== undefined) return text

	text = part.text(item)

	if (textCacheChars + text.length > TEXT_CACHE_CHARS) {
		textCache = new WeakMap()
		textCacheChars = 0
		texts = undefined
	}

	if (texts === undefined) {
		texts = new Map()
		textCache.set(part, texts)
	}

	texts.set(item, text)
	textCacheChars += text.length

	return text
}

export class ContentBuilder {
	readonly builder = new ParagraphBuilder()
	private readonly services: ContentServices
	private readonly table: StyleTable
	private readonly fieldKinds: number[] = []
	private readonly fieldModes: number[] = []
	private readonly fieldValues: FieldValue[] = []
	// Per open field: what it shows when its result shows nothing (a MACROBUTTON's display text, else undefined),
	// and where its result starts in the text (-1 before its separator).
	private readonly fieldDisplays: (string | undefined)[] = []
	private readonly resultStarts: number[] = []
	private hidden = 0
	// The field codes view (undefined: results shown), and per part the paragraphs whose marks lie inside a
	// field shown as its code (hidden there, as Word hides them).
	private codes: FieldCodes | undefined = undefined
	private codeMarks = new WeakMap<StoryPart, ReadonlySet<number>>()
	private out: BuiltParagraph = new BuiltParagraph()
	private page: PageValues = { page: 1, pageFormat: undefined, numPages: 1, sectionPages: 1 }
	private story: StoryContext | undefined = undefined
	private format: ParagraphFormat | undefined = undefined
	private columnWidth = 0
	private readonly separators = new Map<number, number>()
	// Check box objects by size and state.
	private readonly boxes = new Map<number, number>()
	private readonly map: number[] = []

	constructor(services: ContentServices) {
		this.services = services
		this.table = services.styles.table
	}

	// Shows fields as their codes (see FieldCodes), or as their results when undefined. Takes effect for the
	// paragraphs built from now on: the layout lays out again.
	setFieldCodes(codes: FieldCodes | undefined): void {
		this.codes = codes
		this.codeMarks = new WeakMap()
	}

	// Whether the field whose begin (or w:fldSimple) is `item` shows its code.
	private codeShown(part: StoryPart, item: number): boolean {
		const codes = this.codes

		return codes !== undefined && codes.all !== (codes.toggled?.(part, item) ?? false)
	}

	// The paragraphs of `part` whose marks lie inside a field shown as its code: from the paragraph of its
	// begin to the one before its end's.
	private codeMarksOf(part: StoryPart): ReadonlySet<number> {
		let found = this.codeMarks.get(part)

		if (found !== undefined) return found

		const out = new Set<number>()
		const fields = part.fields

		for (let field = 0; field < fields.count; field++) {
			const begin = fields.begin[field] ?? -1
			const end = fields.end[field] ?? -1

			if (fields.simple[field] === 1 || begin < 0 || end < 0 || !this.codeShown(part, begin)) continue

			const last = paragraphOf(part, end)

			for (let item = paragraphOf(part, begin); item >= 0 && item < last; item++)
				if (part.kinds[item] === Item.Paragraph) out.add(item)
		}

		found = out
		this.codeMarks.set(part, found)

		return found
	}

	// A text item's decoded text (remembered while editing, see cachedText).
	private textOf(part: StoryPart, item: number): string {
		return this.services.recordMaps ? cachedText(part, item) : part.text(item)
	}

	// The paragraph format of an item (the paragraph's direct properties in its cell context).
	formatOf(part: StoryPart, item: number, cell: CellFormat | undefined): ParagraphFormat {
		const row = part.paragraphRow(item)
		const pPr = row < 0 ? -1 : (part.paragraphs.pPr[row] ?? -1)

		return this.services.resolver.paragraph(this.services.store.paragraphLook(part.document, pPr), cell)
	}

	// Whether the paragraph's mark is absent in the view, joining it to the next paragraph.
	markHidden(part: StoryPart, item: number, format: ParagraphFormat): boolean {
		if (part.paragraphMarkHidden(item, this.services.view)) return true
		if (this.codes !== undefined && part.fields.count > 0 && this.codeMarksOf(part).has(item)) return true
		if (this.codes?.within?.(part, item) === true) return true

		return markVanishes(this.services.resolver.paragraphMark(format), this.services.showHidden)
	}

	// Builds paragraphs first..last (joined: every mark but the last hidden) into the paragraph builder;
	// `parts` and `formats` are their parts and formats in order. `dark`: the fill behind them (a cell's or a
	// table's) is dark, which turns automatic text white where no paragraph shading lies between.
	build(
		story: StoryContext,
		parts: readonly StoryPart[],
		items: readonly number[],
		formats: readonly ParagraphFormat[],
		columnWidth: number,
		page: PageValues,
		out: BuiltParagraph,
		dark: boolean = false
	): void {
		const services = this.services
		const styles = services.styles
		const lastFormat = formats[formats.length - 1]
		const first = items[0] ?? -1
		const firstPart = parts[0] ?? story.part
		const darkBehind = (format: ParagraphFormat): boolean =>
			(format.props.shading === undefined ? undefined : shadingDark(format.props.shading)) ?? dark

		out.reset()

		if (lastFormat === undefined) return

		styles.darkBackground = darkBehind(lastFormat)
		this.out = out
		this.page = page
		this.story = story
		this.columnWidth = columnWidth
		this.map.length = 0
		out.first = first
		out.firstPart = firstPart.index
		out.last = items[items.length - 1] ?? first
		out.format = lastFormat
		out.markStyle = services.styles.style(services.resolver.paragraphMark(lastFormat), "ascii")

		const dropCap = lastFormat.props.frame?.dropCap

		out.dropCap = dropCap === "drop" || dropCap === "margin" ? dropCap : undefined

		const builder = this.builder.reset(out.markStyle)

		services.notes.beginParagraph()

		styles.darkBackground = darkBehind(formats[0] ?? lastFormat)
		this.marker(story, firstPart, first, formats[0] ?? lastFormat)
		this.resetFields()

		for (let k = 0; k < items.length; k++) {
			const format = formats[k] ?? lastFormat

			styles.darkBackground = darkBehind(format)
			this.format = format
			this.paragraph(parts[k] ?? firstPart, items[k] ?? -1, format)
		}

		styles.darkBackground = false
		out.text = builder.finish().text

		if (services.recordMaps || this.map.length > 0) out.map = Int32Array.from(this.map)

		this.story = undefined
		this.format = undefined
	}

	private marker(story: StoryContext, part: StoryPart, item: number, format: ParagraphFormat): void {
		const services = this.services
		const numbering = format.props.numbering

		if (numbering === undefined || format.level === undefined || story.counters === undefined) return

		const key = services.memoKey(part.index, item)
		let marker = story.recount ? undefined : services.markers.get(key)

		if (marker === undefined) {
			marker = story.counters.next(numbering.numId, numbering.ilvl) ?? null

			if (!story.recount) services.markers.set(key, marker)
		}

		if (marker === null) return

		const run = services.resolver.listMarker(format)

		if (run === undefined || (run.vanish && !services.showHidden)) return

		const builder = this.builder
		const text = listMarkerText(marker)
		const start = builder.length

		if (text !== "") {
			services.styles.forEachStyle(text, run, TrackedLook.NONE, (from, to, style) => {
				const drawn = services.styles.drawn(style, text.slice(from, to))

				builder.append(drawn, style)
				this.out.markerWidth += this.width(style, drawn, 0, drawn.length)
			})
		}

		const style = services.styles.style(run, "ascii")

		if (marker.suffix === "tab") builder.tab(style)
		else if (marker.suffix === "space") {
			builder.append(" ", style)
		}

		this.out.markerAlignment = marker.alignment
		this.out.empty = builder.length === start && marker.suffix === "nothing"
	}

	private width(style: number, text: string, from: number, to: number): number {
		const table = this.table

		return (
			(table.cache.width(table.fontKey[style] ?? 0, text, from, to) + (table.letterSpacing[style] ?? 0) * (to - from)) *
			(table.scaleX[style] ?? 1)
		)
	}

	private paragraph(part: StoryPart, paragraph: number, format: ParagraphFormat): void {
		const services = this.services
		const view = services.view
		const store = services.store
		const resolver = services.resolver
		const builder = this.builder
		const kinds = part.kinds
		const end = part.end(paragraph)
		const base = resolver.run(format, EMPTY_RUN)
		let run: ResolvedRunProps = base
		let runEnd = -1
		let revision: TrackedLook = TrackedLook.NONE
		let runHidden = false
		const map = services.recordMaps || services.mapParagraph?.(part, paragraph) === true ? this.map : undefined
		// A w:fldSimple MACROBUTTON open: it and its end, its display text, where its result started and its run.
		let simpleItem = -1
		let simpleEnd = -1
		let simpleDisplay = ""
		let simpleStart = 0
		let simpleRun = base
		let simpleRevision: TrackedLook = TrackedLook.NONE
		const closeSimple = (): void => {
			// Its result shows nothing: its display text instead.
			if (builder.length === simpleStart && this.hidden === 0) {
				this.text(simpleDisplay, simpleRun, simpleRevision)

				if (map !== undefined && builder.length > simpleStart) map.push(part.index, simpleItem, simpleStart, builder.length)
			}

			simpleEnd = -1
		}

		// Fields stop at each paragraph's end; shown as codes, a field spanning paragraphs joins them (their marks
		// are hidden) and goes on.
		if (this.codes === undefined) this.resetFields()

		for (let item = paragraph + 1; item < end;) {
			const kind = kinds[item] ?? 0
			let next = part.end(item)

			if (simpleEnd >= 0 && item >= simpleEnd) closeSimple()

			if (item >= runEnd && runEnd >= 0) {
				run = base
				runEnd = -1
				revision = TrackedLook.NONE
				runHidden = false
			}

			const before = builder.length

			switch (kind) {
				case Item.Run: {
					const row = part.runs.rPr[part.aux[item] ?? -1] ?? -1

					run = resolver.run(format, store.runLook(part.document, row))
					runEnd = next
					revision = view === RevisionView.Markup ? this.revisionOf(part, item, paragraph) : TrackedLook.NONE
					runHidden = (run.vanish || run.specVanish) && !services.showHidden
					next = item + 1

					break
				}
				case Item.Sdt:
				case Item.CustomXml:
				case Item.SmartTag:
				case Item.Hyperlink:
				case Item.Bidi:
				case Item.AlternateContent:
					next = item + 1

					break
				case Item.Insertion:
				case Item.MoveTo:
					next = view === RevisionView.Original ? next : item + 1

					break
				case Item.Deletion:
				case Item.MoveFrom:
					next = view === RevisionView.Final ? next : item + 1

					break
				case Item.FieldSimple: {
					const instruction = part.fieldInstruction(part.aux[item] ?? -1, view)
					const info = fieldInfo(instruction, part, item)

					if (this.codes !== undefined && this.codeShown(part, item)) {
						if (this.hidden === 0) this.text(`{${instruction}}`, run, revision)

						next = part.end(item)
					} else if (info.kind === FieldKind.OTHER || info.kind === FieldKind.CHECKBOX || info.kind === FieldKind.DROPDOWN) {
						const display = this.fieldModes.length === 0 && simpleEnd < 0 ? macroButtonText(instruction) : undefined

						if (display !== undefined && !runHidden) {
							simpleItem = item
							simpleEnd = part.end(item)
							simpleDisplay = display
							simpleStart = builder.length
							simpleRun = run
							simpleRevision = revision
						}

						next = item + 1
					} else if (this.hidden === 0) {
						const firstRun = this.firstRun(part, item)
						const fieldRun =
							firstRun < 0
								? run
								: resolver.run(format, store.runLook(part.document, part.runs.rPr[part.aux[firstRun] ?? -1] ?? -1))

						this.computedField(info.kind, this.computedValue(info, instruction, fieldRun), fieldRun, revision)
					}

					break
				}
				case Item.InstrText:
				case Item.DeletedInstrText:
					if (this.hidden === 0 && !runHidden && this.fieldModes[this.fieldModes.length - 1] === FIELD_SHOWN)
						this.text(this.textOf(part, item), run, revision)

					break
				case Item.Text:
				case Item.DeletedText:
					if (this.hidden === 0 && !runHidden) this.text(this.textOf(part, item), run, revision)

					break
				case Item.Tab:
					if (this.hidden === 0 && !runHidden) this.tab(run, revision)

					break
				case Item.PositionalTab:
					if (this.hidden === 0 && !runHidden) this.positionalTab(part, item, run, revision)

					break
				case Item.Break:
					if (this.hidden === 0 && !runHidden) this.lineBreak(part, item, run, revision)

					break
				case Item.CarriageReturn:
					if (this.hidden === 0 && !runHidden) {
						builder.lineBreak(this.services.styles.style(run, "ascii", revision))
						this.out.empty = false
					}

					break
				case Item.LastRenderedPageBreak:
					this.out.renderedBreaks.push(builder.length)

					break
				case Item.Symbol:
					if (this.hidden === 0 && !runHidden) {
						const symbol = part.symbol(item)

						if (symbol.char > 0 && symbol.char <= 0x10ffff) {
							const style = services.styles.style(run, "ascii", revision, symbol.font)

							builder.append(services.styles.drawn(style, String.fromCodePoint(symbol.char)), style)
							this.out.empty = false
						}
					}

					break
				case Item.SoftHyphen:
					if (this.hidden === 0 && !runHidden) builder.append("­", services.styles.style(run, "ascii", revision))

					break
				case Item.NoBreakHyphen:
					if (this.hidden === 0 && !runHidden) this.text("‑", run, revision)

					break
				case Item.FieldChar:
					this.fieldChar(part, item, view, run, revision, runHidden)

					break
				case Item.FootnoteReference:
				case Item.EndnoteReference:
					if (this.hidden === 0 && !runHidden) this.noteReference(part, item, kind === Item.EndnoteReference, run, revision)

					break
				case Item.FootnoteMark:
				case Item.EndnoteMark:
					if (this.hidden === 0 && !runHidden && this.story !== undefined) this.text(this.story.noteMark, run, revision)

					break
				case Item.Separator:
				case Item.ContinuationSeparator:
					if (this.hidden === 0) this.separator(kind === Item.ContinuationSeparator, run, revision)

					break
				case Item.PageNumber:
					if (this.hidden === 0 && !runHidden) this.computedField(FieldKind.PAGE, NO_VALUE, run, revision)

					break
				case Item.Drawing:
				case Item.VmlPicture:
				case Item.EmbeddedObject:
				case Item.Math:
				case Item.MathParagraph:
					if (this.hidden === 0 && !runHidden) this.object(part, item, kind, run, revision)

					break
				case Item.Ruby:
					if (this.hidden === 0 && !runHidden) this.ruby(part, item, run, revision)

					break
				case Item.Paragraph:
					// A paragraph inside a paragraph only comes from an AlternateContent branch; its text joins in.
					next = item + 1

					break
			}

			if (map !== undefined && builder.length > before) map.push(part.index, item, before, builder.length)

			item = next
		}

		if (simpleEnd >= 0) closeSimple()
	}

	private firstRun(part: StoryPart, container: number): number {
		for (let item = container + 1; item < part.end(container); item++) if (part.kinds[item] === Item.Run) return item

		return -1
	}

	// The tracked change a run sits in, with its author (see revisionLook).
	private revisionOf(part: StoryPart, item: number, paragraph: number): TrackedLook {
		for (let at = part.parent(item); at > paragraph; at = part.parent(at)) {
			const look =
				part.kinds[at] === Item.Insertion
					? TrackedLook.INSERTED
					: part.kinds[at] === Item.Deletion
						? TrackedLook.DELETED
						: part.kinds[at] === Item.MoveFrom
							? TrackedLook.MOVED_FROM
							: part.kinds[at] === Item.MoveTo
								? TrackedLook.MOVED_TO
								: TrackedLook.NONE

			if (look === TrackedLook.NONE) continue

			const node = part.revisions.node[part.aux[at] ?? -1] ?? -1
			const author = node < 0 ? undefined : part.reader.attr(node, Ns.W, "author")

			return revisionLook(look, this.services.authors(author))
		}

		return TrackedLook.NONE
	}

	private text(text: string, run: ResolvedRunProps, revision: TrackedLook): void {
		if (text.length === 0) return

		const builder = this.builder

		const styles = this.services.styles

		styles.forEachStyle(text, run, revision, (from, to, style) => {
			builder.append(styles.drawn(style, from === 0 && to === text.length ? text : text.slice(from, to)), style)
		})
		this.out.empty = false
	}

	private tab(run: ResolvedRunProps, revision: TrackedLook): void {
		this.builder.tab(this.services.styles.style(run, "ascii", revision))
		this.out.empty = false
	}

	// w:ptab: a tab to a position relative to the margins or indents, ignoring the paragraph's stops.
	private positionalTab(part: StoryPart, item: number, run: ResolvedRunProps, revision: TrackedLook): void {
		const reader = part.reader
		const node = part.node(item)
		const alignment = reader.attr(node, Ns.W, "alignment") ?? "left"
		const relative = reader.attr(node, Ns.W, "relativeTo") ?? "margin"
		const leader = LEADERS[reader.attr(node, Ns.W, "leader") ?? "none"] ?? TabLeader.NONE
		const indent = this.format?.props.indent
		const start = relative === "indent" && indent !== undefined ? twips(indent.start) : 0
		const end = this.columnWidth - (relative === "indent" && indent !== undefined ? twips(indent.end) : 0)
		const position = alignment === "center" ? (start + end) / 2 : alignment === "right" ? end : start

		this.builder.tab(this.services.styles.style(run, "ascii", revision), {
			position,
			alignment: alignment === "center" ? TabAlignment.CENTER : alignment === "right" ? TabAlignment.END : TabAlignment.START,
			leader
		})
		this.out.empty = false
	}

	private lineBreak(part: StoryPart, item: number, run: ResolvedRunProps, revision: TrackedLook): void {
		const type = part.breakType(item)
		const style = this.services.styles.style(run, "ascii", revision)
		let kind: BreakKind = BreakKind.LINE

		if (type === BreakType.Page && this.story?.breaksAsLines !== true) kind = BreakKind.PAGE
		else if (type === BreakType.Column && this.story?.breaksAsLines !== true) kind = BreakKind.COLUMN
		else if (type === BreakType.TextWrapping) {
			const clear = part.breakClear(item)

			kind =
				clear === BreakClear.Left
					? BreakKind.LINE_CLEAR_LEFT
					: clear === BreakClear.Right
						? BreakKind.LINE_CLEAR_RIGHT
						: clear === BreakClear.All
							? BreakKind.LINE_CLEAR_ALL
							: BreakKind.LINE
		}

		this.builder.lineBreak(style, kind)
		this.out.empty = false
	}

	private resetFields(): void {
		this.fieldKinds.length = 0
		this.fieldModes.length = 0
		this.fieldValues.length = 0
		this.fieldDisplays.length = 0
		this.resultStarts.length = 0
		this.hidden = 0
	}

	private fieldChar(
		part: StoryPart,
		item: number,
		view: RevisionView,
		run: ResolvedRunProps,
		revision: TrackedLook,
		runHidden: boolean
	): void {
		const type = part.fieldCharType(item)
		const kinds = this.fieldKinds
		const modes = this.fieldModes

		if (type === FieldCharType.Begin) {
			if (this.codes !== undefined && this.codeShown(part, item)) {
				kinds.push(FieldKind.OTHER)
				this.fieldValues.push(NO_VALUE)
				this.fieldDisplays.push(undefined)
				this.resultStarts.push(-1)
				modes.push(FIELD_SHOWN)

				if (this.hidden === 0 && !runHidden) this.text("{", run, revision)

				return
			}

			const field = part.fieldOf(item)
			const instruction = field < 0 ? "" : part.fieldInstruction(field, view)
			const info = field < 0 ? undefined : fieldInfo(instruction, part, item)
			const kind = info?.kind ?? FieldKind.OTHER

			kinds.push(kind)
			// Inside another field a MACROBUTTON shows nothing (MS-OI29500 §17.16.5.34).
			this.fieldDisplays.push(modes.length === 0 && field >= 0 ? part.macroButtonDisplay(field, view) : undefined)
			this.resultStarts.push(-1)
			this.fieldValues.push(
				kind === FieldKind.CHECKBOX || kind === FieldKind.DROPDOWN
					? this.formValue(part, item, kind)
					: info === undefined
						? NO_VALUE
						: this.computedValue(info, instruction, run)
			)
			modes.push(FIELD_CODE)
			this.hidden++

			return
		}

		const depth = modes.length

		if (depth === 0) return

		const mode = modes[depth - 1] ?? FIELD_RESULT
		const kind = (kinds[depth - 1] ?? FieldKind.OTHER) as FieldKind

		if (type === FieldCharType.Separate) {
			if (mode === FIELD_SHOWN) {
				modes[depth - 1] = FIELD_SHOWN_RESULT
				this.hidden++

				return
			}

			if (mode !== FIELD_CODE) return

			if (kind === FieldKind.OTHER) {
				modes[depth - 1] = FIELD_RESULT
				this.hidden--
				this.resultStarts[depth - 1] = this.builder.length
			} else {
				modes[depth - 1] = FIELD_REPLACED

				if (this.hidden === 1) this.computedField(kind, this.fieldValues[depth - 1] ?? NO_VALUE, run, revision)
			}

			return
		}

		if (type === FieldCharType.End) {
			kinds.pop()
			modes.pop()

			const value = this.fieldValues.pop() ?? NO_VALUE
			const display = this.fieldDisplays.pop()
			const resultStart = this.resultStarts.pop() ?? -1

			if (mode === FIELD_SHOWN || mode === FIELD_SHOWN_RESULT) {
				if (mode === FIELD_SHOWN_RESULT) this.hidden--
				if (this.hidden === 0 && !runHidden) this.text("}", run, revision)

				return
			}

			// A MACROBUTTON whose result shows nothing (none stored, or empty) shows its display text.
			if (mode === FIELD_RESULT) {
				if (display !== undefined && this.builder.length === resultStart && this.hidden === 0 && !runHidden)
					this.text(display, run, revision)

				return
			}

			this.hidden--

			if (display !== undefined && mode === FIELD_CODE && this.hidden === 0 && !runHidden) this.text(display, run, revision)

			// A computed field without a stored result still shows its value.
			if (mode === FIELD_CODE && kind !== FieldKind.OTHER && this.hidden === 0) this.computedField(kind, value, run, revision)
		}
	}

	// What a legacy check box or drop-down list shows, in its begin run's formatting (a check box at its own
	// size when it has one).
	private formValue(part: StoryPart, item: number, kind: FieldKind): FieldValue {
		const look = formFieldLook(part, item, kind)

		if (look === undefined) return { format: undefined, text: "", run: undefined }

		const checkbox = kind === FieldKind.CHECKBOX

		// A drop-down list shows its entry where its result is, in that formatting.
		if (this.format === undefined || (!checkbox && look.size === undefined))
			return { format: undefined, text: look.text, run: undefined, checked: look.checked }

		// A check box is drawn in its begin run's formatting (w:sizeAuto: that run's size).
		const runItem = part.parent(item)
		const row = part.kinds[runItem] === Item.Run ? (part.runs.rPr[part.aux[runItem] ?? -1] ?? -1) : -1
		const services = this.services
		const props = services.store.runLook(part.document, row)

		return {
			format: undefined,
			text: look.text,
			run: services.resolver.run(this.format, look.size === undefined ? props : sizedRun(props, look.size)),
			checked: look.checked
		}
	}

	// A computed field's value: a page field's \* format, or a DATE or TIME field's text as of the layout's clock
	// in the language of `run` (its first run's), computed once per field as it is laid out.
	private computedValue(info: FieldInfo, instruction: string, run: ResolvedRunProps): FieldValue {
		if (info.kind === FieldKind.DATE || info.kind === FieldKind.TIME)
			return { format: undefined, text: dateTimeText(instruction, this.services.now, run.lang), run: undefined }

		return info.format === undefined ? NO_VALUE : { format: info.format, text: undefined, run: undefined }
	}

	private computedField(kind: FieldKind, value: FieldValue, run: ResolvedRunProps, revision: TrackedLook): void {
		const page = this.page
		const format = value.format

		if (kind === FieldKind.CHECKBOX) {
			if (value.checked !== undefined) this.checkbox(value.checked, value.run ?? run, revision)

			return
		}

		if (kind === FieldKind.DROPDOWN || kind === FieldKind.DATE || kind === FieldKind.TIME) {
			this.text(value.text ?? "", value.run ?? run, revision)

			return
		}

		if (kind === FieldKind.PAGE) {
			const start = this.builder.length

			this.out.fieldFlags |= 1
			this.text(pageNumberText(page.page, format ?? page.pageFormat, page.chapter), run, revision)
			this.out.pageFields.push(start, this.builder.length)

			return
		}

		this.out.fieldFlags |= 2
		this.text(numberText(kind === FieldKind.NUMPAGES ? page.numPages : page.sectionPages, format), run, revision)
	}

	private noteReference(part: StoryPart, item: number, endnote: boolean, run: ResolvedRunProps, revision: TrackedLook): void {
		const services = this.services
		const id = String(part.aux[item] ?? -1)
		const story = (endnote ? services.model.endnotes : services.model.footnotes).get(id)
		const offset = this.builder.length

		if (story === undefined) return

		const custom = part.reader.attr(part.node(item), Ns.W, "customMarkFollows")
		const mark =
			custom === "1" || custom === "true" || custom === "on" ? "" : services.notes.reference(endnote, part.index, item, story.index)

		this.text(mark, run, revision)
		this.out.noteOffsets.push(offset)
		this.out.noteStories.push(story.index)
		this.out.noteEndnote.push(endnote ? 1 : 0)
		this.out.empty = false
	}

	// A legacy check box: a square as tall as its run's font size (w:size or, with w:sizeAuto, the run's;
	// ECMA-376 Part 1 §17.16.20, §17.16.24), standing on the baseline.
	private checkbox(checked: boolean, run: ResolvedRunProps, revision: TrackedLook): void {
		const services = this.services
		const side = halfPoints(run.size)
		const key = Math.round(side * 8) * 2 + (checked ? 1 : 0)
		let id = this.boxes.get(key)

		if (id === undefined) {
			id = services.objects.add(ObjectKind.CHECKBOX, -1, -1, checked ? 1 : 0, side, side, side, undefined, undefined, undefined)
			this.boxes.set(key, id)
		}

		this.builder.object(services.styles.style(run, "ascii", revision), side, side, 0, id)
		this.out.empty = false
	}

	private separator(continuation: boolean, run: ResolvedRunProps, revision: TrackedLook): void {
		const services = this.services
		const kind = continuation ? ObjectKind.CONTINUATION_SEPARATOR : ObjectKind.SEPARATOR
		// Word's separator is 144 pt wide (2 in); the continuation separator spans the column.
		const width = continuation ? this.columnWidth : Math.min(this.columnWidth, 192)
		const key = Math.round(width * 8) * 2 + (continuation ? 1 : 0)
		let id = this.separators.get(key)

		if (id === undefined) {
			id = services.objects.add(kind, -1, -1, -1, width, 1, 1, undefined, undefined, undefined)
			this.separators.set(key, id)
		}

		this.builder.object(services.styles.style(run, "ascii", revision), width, halfPoints(run.size) * 0.35, 0, id)
		this.out.empty = false
	}

	private object(part: StoryPart, item: number, kind: number, run: ResolvedRunProps, revision: TrackedLook): void {
		const services = this.services
		const style = services.styles.style(run, "ascii", revision)
		const size = halfPoints(run.size)
		const placed = objectAt(
			services.model,
			services.objects,
			services.sizer,
			part,
			item,
			size,
			text => this.width(style, text, 0, text.length),
			services.styles.hasMissing,
			services.view
		)

		if (placed === undefined) return

		if (placed.anchored) {
			this.out.floats.push(placed.id)
			this.out.floatOffsets.push(this.builder.length)

			return
		}

		const display = kind === Item.MathParagraph
		const builder = this.builder

		// Display equations take a line of their own.
		if (display && builder.length > 0) builder.lineBreak(style)

		// Word's line spacing multiple stretches the text of a line, not the objects on it: the box is shrunk
		// by the multiple the layout applies to the whole line.
		const spacing = this.format?.props.spacing
		const multiple =
			!services.stretchObjects && spacing !== undefined && spacing.lineRule === "auto" && spacing.line > 0 ? spacing.line / 240 : 1

		builder.object(style, placed.width, placed.ascent / multiple, (placed.height - placed.ascent) / multiple, placed.id)

		if ((services.objects.textboxes[placed.id]?.length ?? 0) > 0) this.out.boxedObjects.push(placed.id)

		this.out.empty = false
	}

	// Ruby: the base text (the annotation above it is not laid out yet).
	private ruby(part: StoryPart, item: number, run: ResolvedRunProps, revision: TrackedLook): void {
		for (let child = item + 1; child < part.end(item); child = part.end(child)) {
			if (part.kinds[child] !== Item.RubyBase) continue

			for (let inner = child + 1; inner < part.end(child); inner++) {
				if (part.kinds[inner] === Item.Text) this.text(this.textOf(part, inner), run, revision)
			}
		}
	}
}

function paragraphOf(part: StoryPart, item: number): number {
	for (let at = item; at >= 0; at = part.parent(at)) if (part.kinds[at] === Item.Paragraph) return at

	return -1
}
