import { spliceAll } from "../../arrays"
import type { LineSpacingRule } from "../../fonts/index"
import {
	Exclusions,
	LINE_FLOATS,
	LINE_INTS,
	LineInt,
	MeasureCache,
	StyleTable,
	Wrap,
	type HyphenationLibrary,
	type TextMeasurer
} from "../../text/index"
import type { DocxModel, Section } from "../model/document"
import { Item, RevisionView } from "../model/kinds"
import type { StoryPart } from "../model/part"
import { NumberingCounters, type CounterSnapshot, type ListMarker } from "../numbering/counter"
import { PropsStore } from "../props/store"
import type { ResolvedSectionProps } from "../props/types"
import type { Numbering } from "../numbering/numbering"
import { headingLevel, type DocxStyles } from "../styles/styles"
import { resolveSection, type PropertyResolver } from "../styles/resolve"
import { chapterSeparator, pageNumberText, type PageValues, type StoryContext } from "./content"
import { REF_SPAN, refItem, refPart, type LayoutEdits } from "./edits"
import type { FieldCodes } from "./fields"
import {
	Area,
	AreaStart,
	BlockFlow,
	DEFAULT_TUNING,
	Engine,
	FlowStatus,
	nextToken,
	type FlowSnapshot,
	type LayoutTuning,
	type PageFrame
} from "./flow"
import { layoutCompat, lineSpacingRule, pageGeometry, type LayoutCompat, type PageGeometry } from "./geometry"
import { FootnoteArea, NoteNumbering, type FootnoteState, type NoteNumberingSnapshot, type PlacedNote } from "./notes"
import { ObjectTable, type ObjectSizer } from "./objects"
import {
	PageGraphic,
	Layer,
	OutputMark,
	PageDisplayList,
	PageOutput,
	Region,
	SOURCE_INTS,
	SourceFlag,
	SourceInt,
	sectionBreakFlags
} from "./output"
import { DecorationTable, RunStyles, borderWidth, type DecorationValue, type FontSource, type RunStyleInfo } from "./styles"
import { laidRows, sameNumbers, type TableSnapshot } from "./table"
import { EPSILON, twips } from "./units"

export interface LayoutOptions {
	// Which tracked changes show (default Final, as Word's Simple Markup lays out).
	readonly view?: RevisionView
	// Lay out hidden text (w:vanish) as Word does with "Show hidden text" on.
	readonly showHidden?: boolean
	// The store property XML is parsed into (a new one by default).
	readonly store?: PropsStore
	readonly sizer?: ObjectSizer
	readonly lineSpacingRule?: LineSpacingRule
	readonly tuning?: Partial<LayoutTuning>
	// Time slice in ms between yields (default 8; Infinity runs to the end without yielding).
	readonly sliceMs?: number
	// Gives the host a turn between slices (web: scheduler.yield or a MessageChannel; default a microtask).
	readonly yield?: () => Promise<void>
	// The clock slices and edits' budgets are read on (default performance.now, else Date.now).
	readonly now?: () => number
	readonly signal?: { readonly aborted: boolean }
	// Stops after this many pages (default 100000).
	readonly maxPages?: number
	// NUMPAGES before the layout knows it (default: Word's recorded page breaks + 1).
	readonly estimatedPages?: number
	// Record where each item's content lands in its paragraph's text (PageDisplayList.sourceMapPool).
	readonly recordMaps?: boolean
	// Without recordMaps, the paragraphs whose maps are recorded anyway (where links are placed from them).
	readonly mapParagraph?: (part: StoryPart, paragraph: number) => boolean
	// Unsaved edits to lay out in place of their source (read whenever layout restarts).
	readonly edits?: LayoutEdits
	// The time (epoch ms) DATE and TIME fields show, as Word shows them as of opening or printing (default: when
	// layout starts). Read once, so every page and relayout shows the same.
	readonly date?: number
	// The hyphenation patterns of a document that hyphenates automatically (w:autoHyphenation); without them only
	// soft hyphens break words.
	readonly hyphenation?: HyphenationLibrary
}

// A top-level body block an edit changed, as laid out now: relaying out cannot stop at a page that matches
// the previous layout before it has laid each of them out.
export interface DirtyBlock {
	readonly section: number
	readonly ref: number
	// A table whose rows and cells' paragraphs alone changed: those paragraphs and rows (refs: the table's
	// part, or overlays of rows written again). Laid out once the rows holding them are, unless one is a header
	// row (repeated on every page).
	readonly cells?: readonly number[]
	// Its rows came, went or moved: rows after them are not where the previous layout had them, so layout does
	// not meet it again inside the table.
	readonly moved?: boolean
}

export type AdvanceResult = "done" | "more" | "fonts"

export type RefreshResult = "done" | "numbers" | "moved"

// Entries [from, to) of a table added since the previous event.
export interface TableRange {
	readonly from: number
	readonly to: number
}

export interface LayoutEvent {
	readonly type: "pages"
	readonly from: number
	readonly to: number
	readonly final: boolean
	// Style (styles, styleInfo), decoration and object entries added since the previous event: everything
	// pages [from, to) use that earlier events did not deliver, so a worker can send just these.
	readonly styles: TableRange
	readonly decorations: TableRange
	readonly objects: TableRange
}

// Where a page's flow starts: for editing, which relays out from the first page that changed.
export interface PageAnchor {
	readonly section: number
	// The story the page's flow continues (the body; an endnote's story when endnotes run on).
	readonly story: number
	// The top-level block (paragraph or table item of the story) the page starts in, -1 after the last;
	// `part` is the part it is laid out from and `index` its place among the section's blocks.
	readonly block: number
	readonly part: number
	readonly index: number
	// Inside a table: the row the page starts at; -1 otherwise.
	readonly row: number
	// Inside a paragraph: the offset into its laid-out text where the page's first line starts; 0 otherwise.
	readonly offset: number
}

// A Word page break (w:lastRenderedPageBreak) located in this layout: the page its line landed on and the
// line's index among the body lines of the whole document (table cells in their layout order).
export interface RenderedBreak {
	readonly page: number
	readonly line: number
	// The paragraph holding it, and which of the paragraph's breaks it is.
	readonly item: number
	readonly ordinal: number
}

// The incremental result of layoutDocument: pages arrive as they are laid out.
export class DocumentLayout {
	readonly model: DocxModel
	readonly pages: PageDisplayList[] = []
	readonly anchors: PageAnchor[] = []
	readonly styles: StyleTable
	readonly objects: ObjectTable
	readonly renderedBreaks: RenderedBreak[] = []
	// Index of each page's first body line (as RenderedBreak.line counts).
	readonly pageFirstLines: number[] = []
	final = false
	cancelled = false
	error: unknown = undefined
	// Pages laid out again after the layout first delivered them (page count fields).
	readonly dirty = new Set<number>()
	// Pages kept from an earlier layout whose page number or count fields show old values (see refresh).
	readonly stale = new Set<number>()
	done: Promise<void> = Promise.resolve()
	private readonly runStyles: RunStyles
	private readonly listeners = new Set<(event: LayoutEvent) => void>()

	constructor(model: DocxModel, styles: StyleTable, runStyles: RunStyles, objects: ObjectTable) {
		this.model = model
		this.styles = styles
		this.runStyles = runStyles
		this.objects = objects
	}

	get styleInfo(): readonly RunStyleInfo[] {
		return this.runStyles.info
	}

	get decorations(): readonly DecorationValue[] {
		return this.runStyles.decorations.values
	}

	pageCount(): { count: number; final: boolean } {
		return { count: this.pages.length, final: this.final }
	}

	subscribe(listener: (event: LayoutEvent) => void): () => void {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	cancel(): void {
		this.cancelled = true
		this.wakeResumed()
	}

	private relayout: ((page: number) => Promise<number>) | undefined = undefined
	private running: () => boolean = () => false
	private driver: LayoutDriver | undefined = undefined
	private viewSwitch: ((view: RevisionView) => void) | undefined = undefined
	private codesSwitch: ((codes: FieldCodes | undefined, fresh: boolean) => void) | undefined = undefined
	private suspendedValue = false
	private readonly resumeWaiters: (() => void)[] = []

	attach(
		relayout: (page: number) => Promise<number>,
		running?: () => boolean,
		driver?: LayoutDriver,
		viewSwitch?: (view: RevisionView) => void,
		codesSwitch?: (codes: FieldCodes | undefined, fresh: boolean) => void,
		hiddenSwitch?: { readonly shown: boolean; readonly set: (on: boolean, fresh: boolean) => void }
	): void {
		this.relayout = relayout

		if (running !== undefined) this.running = running
		if (driver !== undefined) this.driver = driver
		if (viewSwitch !== undefined) this.viewSwitch = viewSwitch
		if (codesSwitch !== undefined) this.codesSwitch = codesSwitch
		if (hiddenSwitch !== undefined) {
			this.hiddenSwitch = hiddenSwitch.set
			this.showHiddenValue = hiddenSwitch.shown
		}
	}

	private hiddenSwitch: ((on: boolean, fresh: boolean) => void) | undefined = undefined
	private showHiddenValue = false
	// Anything hidden met while laying out (see ContentServices.hidden).
	readonly hidden = { seen: false }

	get showHidden(): boolean {
		return this.showHiddenValue
	}

	// Editing: lays hidden text (w:vanish) out or leaves it out, as Word does with its formatting marks shown or
	// not. When nothing hidden was met so far only what is laid out from now on changes (-1 is returned); else it
	// lays the document out again from the first page as setView does and returns that page.
	setShowHidden(on: boolean): number {
		if (this.hiddenSwitch === undefined || this.driver === undefined) throw new Error("No layout to edit")
		if (on === this.showHiddenValue) return -1

		this.showHiddenValue = on

		const fresh = this.hidden.seen

		this.hiddenSwitch(on, fresh)

		if (!fresh) return -1

		this.cancelled = false

		return this.driver.begin(0, undefined)
	}

	// Editing: lays the document out again in revision view `view`, from the first page (the pages laid out
	// so far stay until replaced); call advance() or continue() as after beginEdit. The edits' view must be
	// switched first (DocumentEdits.setView). Returns the first page laid out again.
	setView(view: RevisionView): number {
		if (this.driver === undefined || this.viewSwitch === undefined) throw new Error("No layout to edit")

		this.viewSwitch(view)
		this.cancelled = false

		return this.driver.begin(0, undefined)
	}

	// Editing: lays the document out again with fields shown as their codes (see FieldCodes; undefined: as their
	// results), from the first page as setView does, or (`from`: fields of those blocks switched one by one) as
	// an edit of them does (beginEdit). Returns the first page laid out again.
	setFieldCodes(codes: FieldCodes | undefined, from?: { readonly page: number; readonly dirty: readonly DirtyBlock[] }): number {
		if (this.driver === undefined || this.codesSwitch === undefined) throw new Error("No layout to edit")

		this.codesSwitch(codes, from === undefined)
		this.cancelled = false

		return this.driver.begin(from?.page ?? 0, from?.dirty)
	}

	// Background layout stops at its next slice (another surface shows the document meanwhile); edits may
	// still restart it (beginEdit), and it carries on with resume().
	suspend(): void {
		this.suspendedValue = true
	}

	resume(): Promise<void> {
		this.suspendedValue = false
		this.wakeResumed()

		return this.continue()
	}

	// Resolves when the layout is resumed (or cancelled).
	whenResumed(): Promise<void> {
		if (!this.suspendedValue || this.cancelled) return Promise.resolve()

		return new Promise(resolve => {
			this.resumeWaiters.push(resolve)
		})
	}

	private wakeResumed(): void {
		for (const resolve of this.resumeWaiters.splice(0)) resolve()
	}

	get suspended(): boolean {
		return this.suspendedValue
	}

	// Editing: starts laying the document out again for edits that change what pages from `page` on show
	// (the first page showing a changed block), keeping earlier pages. `dirty` lists the changed top-level
	// blocks: once each is laid out, layout stops at the first page that starts like a page of the previous
	// layout and keeps the rest (renumbered when the page count changed). Call advance() until "done".
	// Returns the first page laid out again.
	// Without `dirty` layout runs to the end. A run under way (the first layout, or the background part of an
	// earlier edit's) is taken over: layout carries on from the earlier restart page. `through`: pages up to it
	// are laid out again whatever they start with (they show a note the edit changed).
	beginEdit(page: number, dirty: readonly DirtyBlock[] | undefined, through = -1): number {
		if (this.driver === undefined) throw new Error("No layout to edit")

		this.cancelled = false

		return this.driver.begin(page, dirty, through)
	}

	// Carries on laying out in slices (as the first layout does) until done; resolves then.
	continue(): Promise<void> {
		return this.driver?.continue() ?? Promise.resolve()
	}

	// Lays out synchronously until `deadline` (the clock passed in LayoutOptions.now) or until pages up to
	// `through` are laid out: "done" when the layout is complete, "fonts" when fonts must load first
	// (prepareFonts()).
	advance(deadline: number, through = Infinity): AdvanceResult {
		return this.driver?.advance(deadline, through) ?? "done"
	}

	prepareFonts(): Promise<void> {
		return this.driver?.prepareFonts() ?? Promise.resolve()
	}

	// Brings a stale page up to date (its header and footer laid out again): "done", or what keeps it from it:
	// "numbers" when its body shows page values that changed (lay out again from it, beginEdit(page, [])),
	// "moved" when the header or footer changed height (beginEdit(page, undefined): to the end).
	refresh(page: number): RefreshResult {
		return this.driver?.refresh(page) ?? "numbers"
	}

	// Styles and list definitions an editor added (what a save will add): later layout resolves with them.
	redefine(styles: DocxStyles, numbering: Numbering | undefined): void {
		this.driver?.redefine(styles, numbering)
	}

	// A header, footer or other page story's text changed: the pages showing it become stale (refresh() lays
	// them out again). Returns the first such page, or -1.
	restory(story: number): number {
		return this.driver?.restory(story) ?? -1
	}

	// The page layout restarts at for an edit to what page `page` shows: an earlier one when a keep-with-next
	// chain moved off it and the block it ran out of room at there is on this page or later (the edit may let
	// the chain fit there).
	keepFrom(page: number): number {
		return this.driver?.keepFrom(page) ?? page
	}

	get editing(): boolean {
		return this.driver !== undefined
	}

	// Where the last relayout for edits met the previous layout again and kept its pages (-1: ran to the end).
	get resyncedAt(): number {
		return this.driver?.resyncedAt ?? -1
	}

	// Lays the document out again from page `page` on: pages before the nearest page layout can restart at
	// (at or before `page`) are kept, the rest arrive again as events. Resolves to the first page laid out
	// again once the layout is final. The model is the one laid out (an edit will come with a new model or a
	// patch to it); call it once `done` has settled, never while a layout runs (that rejects).
	async relayoutFrom(page: number): Promise<number> {
		if (this.relayout === undefined) return 0

		if (this.running()) throw new Error("relayoutFrom while the layout runs")

		this.cancelled = false

		const run = this.relayout(Math.max(0, page))

		this.done = run.then(() => undefined)

		return run
	}

	// Bytes of all pages' display lists.
	get byteLength(): number {
		return this.pages.reduce((sum, page) => sum + page.byteLength, 0)
	}

	private sentStyles = 0
	private sentDecorations = 0
	private sentObjects = 0

	// Tells subscribers about pages [from, to), with the table entries added since the last event.
	notify(from: number, to: number, final: boolean): void {
		const styles = this.runStyles.info.length
		const decorations = this.runStyles.decorations.values.length
		const objects = this.objects.count
		const event: LayoutEvent = {
			type: "pages",
			from,
			to,
			final,
			styles: { from: this.sentStyles, to: styles },
			decorations: { from: this.sentDecorations, to: decorations },
			objects: { from: this.sentObjects, to: objects }
		}

		this.sentStyles = styles
		this.sentDecorations = decorations
		this.sentObjects = objects

		for (const listener of this.listeners) listener(event)
	}
}

// The paginator's state where a page opens: layout can restart there.
interface PageSnapshot {
	readonly sectionIndex: number
	readonly flow: FlowSnapshot
	readonly pageNumber: number
	readonly restart: number | undefined
	readonly sectionFirstPage: boolean
	readonly nextStart: AreaStart
	readonly bodyLines: number
	readonly lineSection: number
	readonly endnotesDone: number
	readonly globalLine: number
	readonly sectionPageCounts: readonly number[]
	readonly counters: CounterSnapshot | undefined
	readonly notes: NoteNumberingSnapshot
	readonly carried: readonly PlacedNote[]
	// Endnotes referenced and not placed yet.
	readonly endnotes: readonly number[]
	readonly renderedBreaks: number
	// List markers counted before the page opened for paragraphs laid out from it on (built ahead).
	readonly markers: readonly (readonly [number, ListMarker | null])[]
	// Note numbers assigned the same way.
	readonly assigned: readonly (readonly [number, string])[]
	// The chapter numbers of the pages before (see Paginator.chapters).
	readonly chapters: readonly (string | undefined)[]
}

const Step = { PROGRESS: 0, PAGE: 1, SUSPEND: 2, FINISHED: 3 } as const

type Step = (typeof Step)[keyof typeof Step]

// What to lay out again when a page's header or footer changes (their text, or the page numbers or counts
// they show), the body kept.
interface PageRecord {
	readonly index: number
	// Its header or footer shows the page count (NUMPAGES, SECTIONPAGES), or the page number.
	readonly totals: boolean
	readonly numbers: boolean
	// Where the header ends and the footer begins (they set the body's area).
	readonly headerBottom: number
	readonly footerTop: number
	// Exclusions.key of the obstacles the header's and footer's floats made for the body.
	readonly wraps: number
	// The page's content before its header and footer were appended.
	readonly body: OutputMark
	readonly header: number
	readonly footer: number
	readonly geometry: PageGeometry
	// The geometry the header and footer were laid out with: the section the page opened in (a continuous
	// section starting further down the page changes `geometry`, not them).
	readonly headerGeometry: PageGeometry
	readonly values: PageValues
	readonly frame: PageFrame
	// Something on it was placed by whether the page is odd or even.
	readonly parity: boolean
	// Pages back to the page a keep-with-next chain moved off while the block it ran out of room at there is
	// still to come here or later (0: none).
	readonly keep: number
	readonly info: ConstructorParameters<typeof PageDisplayList>[1]
}

// Word's recorded page breaks (lastRenderedPageBreak) in items [start, end) of `part`, blocks laid out from an
// overlay counted there (as the saved document has them). A fresh layout's page count estimates.
function countRenderedBreaks(
	part: StoryPart,
	start: number,
	end: number,
	edits?: LayoutEdits,
	parts?: readonly (StoryPart | undefined)[]
): number {
	const kinds = part.kinds
	const substitutes = edits?.substitutes.size === 0 ? undefined : edits?.substitutes
	const rows = edits?.rows?.size === 0 ? undefined : edits?.rows
	let count = 0

	// Nothing laid out from elsewhere: one search of the kinds.
	if (substitutes === undefined && rows === undefined) {
		for (
			let at = kinds.indexOf(Item.LastRenderedPageBreak, start);
			at >= 0 && at < end;
			at = kinds.indexOf(Item.LastRenderedPageBreak, at + 1)
		)
			count++

		return count
	}

	for (let item = start; item < end;) {
		const kind = kinds[item]
		const block = kind === Item.Paragraph || kind === Item.Table
		const laid = substitutes !== undefined && block ? substitutes.get(part.index * REF_SPAN + item) : undefined
		const overlay = laid === undefined ? undefined : parts?.[refPart(laid)]

		if (laid !== undefined && overlay !== undefined && overlay !== part) {
			const at = refItem(laid)

			count += countRenderedBreaks(overlay, at, overlay.end(at), edits, parts)
			item = part.end(item)

			continue
		}

		// A table with rows of its own: theirs.
		const list = rows !== undefined && kind === Item.Table ? rows.get(part.index * REF_SPAN + item) : undefined

		if (list !== undefined) {
			for (const value of list) {
				const from = Number.isNaN(value) ? undefined : parts?.[refPart(value)]
				const row = refItem(value)

				if (from !== undefined) count += countRenderedBreaks(from, row, from.end(row), edits, parts)
			}

			item = part.end(item)

			continue
		}

		if (kind === Item.LastRenderedPageBreak) count++

		item++
	}

	return count
}

// The breaks countRenderedBreaks counts in section `index` of the body as edited.
function sectionBreaks(model: DocxModel, body: StoryPart, index: number, edits: LayoutEdits | undefined): number {
	const blocks = edits?.body

	if (blocks === undefined) {
		const section = model.sections[index]

		return section === undefined ? 0 : countRenderedBreaks(body, section.start, section.end, edits, model.parts)
	}

	const end = blocks.sectionEnds[index] ?? 0
	let count = 0

	for (let k = index === 0 ? 0 : (blocks.sectionEnds[index - 1] ?? 0); k < end; k++) {
		const value = blocks.refs[k] ?? 0
		const part = model.parts[refPart(value)]
		const item = refItem(value)

		if (part !== undefined) count += countRenderedBreaks(part, item, part.end(item), edits, model.parts)
	}

	return count
}

class Paginator {
	private readonly engine: Engine
	private readonly layout: DocumentLayout
	private readonly model: DocxModel

	get edits(): LayoutEdits | undefined {
		return this.engine.edits
	}
	private readonly body: StoryPart | undefined
	private bodyStory: StoryContext | undefined
	private readonly compat: LayoutCompat
	// `compat` with mirror margins as edited (made when they differ).
	private editedCompat: LayoutCompat | undefined = undefined
	private readonly maxPages: number
	private readonly page = new PageOutput()
	// A placed object's stacking key: its relativeHeight (VML: z-index).
	private readonly zOrderOf = (id: number): number => this.engine.objects.floats[id]?.zOrder ?? 0
	private readonly header = new PageOutput()
	private readonly footer = new PageOutput()
	private readonly exclusions = new Exclusions()
	// The obstacles one header or footer story's wrapping floats made, and those of both for the page body.
	private readonly storyWraps = new Exclusions()
	private readonly headerFooterWraps = new Exclusions()
	private pageWraps = 0
	private laidFooterTop = 0
	private readonly footnotes: FootnoteArea
	private readonly area = new Area()
	// By page index.
	private records: (PageRecord | undefined)[] = []
	private readonly sectionPageCounts: number[] = []
	private readonly sectionEstimates: number[] = []
	// Per page, the values page count fields in its body, notes or text boxes showed (undefined: none).
	private readonly bodyTotals: (PageValues | undefined)[] = []
	// Per page, whether its body, notes or text boxes show the page number.
	private readonly bodyNumbers: boolean[] = []
	private estimate: number
	private readonly initialNotes: NoteNumberingSnapshot
	private sectionIndex = -1
	private section: ResolvedSectionProps = resolveSection({})
	private flows: BlockFlow[] = []
	private flowIndex = 0
	private pageOpen = false
	private pageNumber = 0
	private restart: number | undefined = undefined
	private sectionFirstPage = true
	// The open page is its section's first.
	private firstOfSection = true
	private geometry: PageGeometry | undefined = undefined
	// The geometry the open page's header and footer were laid out with.
	private openGeometry: PageGeometry | undefined = undefined
	private column = 0
	// Where the section's part of the open page began (undefined until its first step there; null when it
	// cannot be laid out again: it began inside a table): to balance its columns, or to align it vertically
	// around obstacles that stay.
	private balanceStart: BalanceStart | null | undefined = undefined
	// What the last step's run of the flow ended with.
	private lastStatus: FlowStatus = FlowStatus.DONE
	// Each column of the page has notes of its own (the page began in a section with columns); the lowest
	// content of the column being filled.
	private notesPerColumn = false
	private columnBottom = 0
	private sectionTop = 0
	private bodyTop = 0
	private bodyBottom = 0
	private contentBottom = 0
	private values: PageValues = { page: 1, pageFormat: undefined, numPages: 1, sectionPages: 1 }
	// By heading level (Heading 1-9): the list number of the last numbered heading laid out on the pages closed
	// so far, for chapter numbers (w:pgNumType chapStyle). Replaced, never changed in place (snapshots share it).
	private chapters: readonly (string | undefined)[] = NO_CHAPTERS
	// The heading levels the sections number chapters by (bit level - 1), -1 until read.
	private chapterLevels = -1
	private frame: PageFrame = { width: 816, height: 1056, marginLeft: 96, marginRight: 96, marginTop: 96, marginBottom: 96, odd: true }
	private headerStory = -1
	private footerStory = -1
	private headerBottom = 0
	private footerTop = 0
	private pageSection = 0
	// The properties of the section the open page belongs to.
	private pageProps: ResolvedSectionProps = resolveSection({})
	private anchor: PageAnchor = { section: 0, story: -1, block: -1, part: -1, index: -1, row: -1, offset: 0 }
	// The section line numbers were last counted in.
	private lineSection = -1
	// The section whose endnotes were placed last.
	private endnotesDone = -1
	private bodyLines = 0
	// Why the next page opens.
	private nextStart: AreaStart = AreaStart.DOCUMENT
	finished = false

	// The body flow yields between blocks once `clock` reaches `at` (Infinity: never).
	yieldAt(at: number, clock: () => number): void {
		this.engine.yieldAt = at
		this.engine.clock = clock
	}

	constructor(engine: Engine, layout: DocumentLayout, estimate: number | undefined, maxPages: number) {
		this.engine = engine
		this.layout = layout
		this.model = engine.model
		this.compat = engine.compat
		this.maxPages = maxPages
		this.footnotes = new FootnoteArea(engine)
		this.initialNotes = engine.notes.snapshot()
		engine.notes.pageNotes = () => this.footnotes.count

		const story = this.model.body
		const body = story === undefined ? undefined : this.model.parts[story.part]

		this.body = body
		this.bodyStory =
			body === undefined || story === undefined
				? undefined
				: { part: body, story: story.index, counters: this.counters(), noteMark: "", breaksAsLines: false, recount: false }

		const counts = this.renderedBreakCounts()

		for (const count of counts) this.sectionEstimates.push(count + 1)

		this.estimate = estimate ?? Math.max(1, counts.reduce((sum, count) => sum + count, 0) + 1)
	}

	// Word's recorded page breaks in each section of the body as edited.
	private renderedBreakCounts(): number[] {
		const body = this.body
		const edits = this.engine.edits

		return this.model.sections.map((_, index) => (body === undefined ? 0 : sectionBreaks(this.model, body, index, edits)))
	}

	// Fields shown as their codes in what is built from now on (see ContentBuilder.setFieldCodes).
	setFieldCodes(codes: FieldCodes | undefined): void {
		this.engine.content.setFieldCodes(codes)
	}

	// Hidden text laid out or not in what is built from now on (see ContentBuilder.setShowHidden).
	setShowHidden(on: boolean): void {
		this.engine.content.setShowHidden(on)
	}

	// The resolver's definitions changed (styles and lists an editor added): counting goes on with them. Whether
	// a style laid out as missing is defined now.
	redefine(styles: DocxStyles, numbering: Numbering | undefined): boolean {
		const defined = this.engine.resolver.redefine(styles, numbering)

		if (numbering === undefined) return defined

		const body = this.bodyStory

		if (body?.counters !== undefined) body.counters.use(numbering)
		else if (body !== undefined) this.bodyStory = { ...body, counters: new NumberingCounters(numbering) }

		return defined
	}

	private counters(): NumberingCounters | undefined {
		const numbering = this.engine.resolver.numbering

		return numbering === undefined ? undefined : new NumberingCounters(numbering)
	}

	// A header's or footer's (`counted`: its lists numbered), counted from its start each time (see
	// StoryContext.recount).
	private storyContext(story: number, counted: boolean): StoryContext | undefined {
		const root = this.model.stories[story]
		const part = root === undefined ? undefined : this.model.parts[root.part]

		if (root === undefined || part === undefined) return undefined

		return { part, story, counters: counted ? this.counters() : undefined, noteMark: "", breaksAsLines: true, recount: true }
	}

	// Lays out every header, footer and note once off-page, so the fonts they need (tables and text boxes
	// included) are loaded before layout starts: they are laid out where layout cannot wait for fonts.
	// From story `from` on, until `clock()` reaches `until`: the story to go on from then, -1 once done.
	scanStories(from = 0, until = Infinity, clock: () => number = Date.now): number {
		const scratch = new PageOutput()

		// By index: an editing layout's model drops stories of overlay parts it no longer uses.
		for (let index = from; index < this.model.stories.length; index++) {
			if (index > from && until !== Infinity && clock() >= until) return index

			const story = this.model.stories[index]

			if (story === undefined) continue
			if (story.kind !== "header" && story.kind !== "footer" && story.kind !== "footnote" && story.kind !== "endnote") continue

			const context = this.storyContext(story.index, false)

			if (context === undefined) continue

			const region = story.kind === "header" ? Region.HEADER : story.kind === "footer" ? Region.FOOTER : Region.FOOTNOTE

			this.engine.layoutBox(context, region, scratch, this.values, this.frame, 0, 0, 600)
			scratch.reset()
		}

		return -1
	}

	private resolved(index: number): ResolvedSectionProps {
		const section = this.model.sections[index]
		const body = this.body

		if (section === undefined || body === undefined || section.sectPr < 0) return resolveSection({})

		return this.engine.resolver.section(this.engine.store.section(section.document ?? body.document, section.sectPr))
	}

	step(): Step {
		if (this.finished) return Step.FINISHED

		if (this.sectionIndex < 0) {
			if (!this.startSection(0)) {
				this.finished = true

				return Step.FINISHED
			}
		}

		if (!this.pageOpen) {
			this.takeSnapshot()

			if (this.resyncs !== undefined && this.resynchronise(this.resyncs)) return Step.FINISHED

			this.openPage()
		}

		const flow = this.flows[this.flowIndex]

		if (flow === undefined) return this.nextSection()

		if (
			this.balanceStart === undefined &&
			this.column === 0 &&
			this.flowIndex === 0 &&
			flow.region === Region.BODY &&
			((this.geometry?.columnX.length ?? 1) > 1 || (this.pageSection === this.sectionIndex && aligned(this.section)))
		) {
			const state = flow.snapshot()

			this.balanceStart =
				state === undefined
					? null
					: {
							body: flow,
							flow: state,
							mark: this.page.mark(),
							notes: this.footnotes.save(),
							exclusions: this.exclusions.count,
							endnotes: this.engine.endnotes.length,
							empty: this.area.empty,
							start: this.area.start
						}
		}

		const status = flow.run(this.area)

		if (this.engine.standIns) {
			this.engine.standIns = false
			this.pageMissedFonts = true
		}

		this.contentBottom = Math.max(this.contentBottom, flow.y)
		this.columnBottom = Math.max(this.columnBottom, flow.y)
		this.lastStatus = status

		switch (status) {
			case FlowStatus.DONE:
				this.flowIndex++

				if (this.flowIndex >= this.flows.length) return this.nextSection()

				// The next flow (an endnote) goes on below this one, not from the column's top.
				this.continueBelow()

				return Step.PROGRESS
			case FlowStatus.SUSPEND:
				return Step.SUSPEND
			case FlowStatus.PAGE_BREAK:
				this.closePage()
				this.nextStart = AreaStart.BREAK

				return Step.PAGE
			case FlowStatus.COLUMN_BREAK:
				return this.nextColumn(AreaStart.BREAK)
			default:
				return this.nextColumn(AreaStart.OVERFLOW)
		}
	}

	// Snapshots by page index; a page opened inside a table or among endnotes has none.
	private readonly snapshots: (PageSnapshot | undefined)[] = []

	private takeSnapshot(): void {
		const index = this.progress
		const flow = this.flows[this.flowIndex]
		const state = this.flowIndex === 0 && flow?.region === Region.BODY ? flow.snapshot(true) : undefined

		if (state === undefined || flow === undefined) {
			this.put(this.snapshots, this.inPlace?.snapshots, index, undefined)

			return
		}

		// What did not change since the page before is shared with its snapshot (most pages of a long table).
		const previous = index > 0 ? this.snapshots[index - 1] : undefined
		const counts = this.sectionPageCounts
		const counters = this.bodyStory?.counters?.snapshot()
		const endnotes = this.engine.endnotes
		const markers = this.markersAhead(flow)
		const assigned = this.engine.notes.assignedWhere((part, item) => this.ahead(flow, part, item, true))
		const notes = this.engine.notes.snapshot()

		this.put(this.snapshots, this.inPlace?.snapshots, index, {
			sectionIndex: this.sectionIndex,
			flow: state,
			pageNumber: this.pageNumber,
			restart: this.restart,
			sectionFirstPage: this.sectionFirstPage,
			nextStart: this.nextStart,
			bodyLines: this.bodyLines,
			lineSection: this.lineSection,
			endnotesDone: this.endnotesDone,
			globalLine: this.globalLine,
			sectionPageCounts:
				previous !== undefined && sameList(previous.sectionPageCounts, counts) ? previous.sectionPageCounts : counts.slice(),
			counters: previous !== undefined && sameCounters(previous.counters, counters) ? previous.counters : counters,
			notes: previous !== undefined && sameNotes(previous.notes, notes) ? previous.notes : notes,
			carried: this.footnotes.carried ? this.footnotes.carriedNotes : NO_NOTES,
			endnotes: previous !== undefined && sameList(previous.endnotes, endnotes) ? previous.endnotes : endnotes.slice(),
			renderedBreaks: this.breakCount,
			markers: markers.length === 0 ? NO_ENTRIES : markers,
			assigned: assigned.length === 0 ? NO_ENTRIES : assigned,
			chapters: this.chapters
		})
	}

	// The nearest page at or before `page` layout can restart at; inside a table only with `tables`, for an edit
	// that says what changed (the body's blocks, or none: page values to show anew). Other restarts (a note or
	// header edited, page counts, fonts) still restart before the table.
	restartPage(page: number, tables = false): number {
		for (let index = Math.min(page, this.snapshots.length - 1); index > 0; index--) {
			const snapshot = this.snapshots[index]

			const table = snapshot?.flow.table

			if (snapshot !== undefined && (table === undefined || (tables && table.cells === undefined))) return index
		}

		return 0
	}

	// Drops pages from `page` (one with a snapshot, or 0) and continues from there. With `dirty`, the dropped
	// pages are kept aside: layout stops where it meets them again once every dirty block is laid out.
	// `own`: the pages this run laid out from `page` on may be met again too (not when they are laid out again
	// for being wrong).
	// `least`: the page asked for (layout restarts at the nearest page with a snapshot before it): the run lays it
	// out again before it may meet the earlier layout (a page refreshed for its page values is not kept as it was).
	// `through`: the earlier layout's pages up to it are not met again (see Resync.through).
	restartAt(page: number, dirty?: readonly DirtyBlock[], own = true, least = page, through = -1): void {
		const layout = this.layout

		this.detach()

		const snapshot = page > 0 ? this.snapshots[page] : undefined

		this.resyncs =
			dirty === undefined ? undefined : this.previousLayout(page, own, dirty, snapshot?.renderedBreaks ?? 0, least, through)
		this.missedFonts = this.missedFonts >= page ? -1 : this.missedFonts
		this.pageMissedFonts = false
		// An edit may have changed the sections' page numbering.
		this.chapterLevels = -1
		this.resyncedAt = -1
		this.pageOpen = false
		this.finished = false

		// Laying out again in place, the previous layout's entries stay where they are until written over.
		if (this.inPlace === undefined) {
			this.records.length = Math.min(this.records.length, page)
			this.bodyNumbers.length = Math.min(this.bodyNumbers.length, page)
			this.snapshots.length = page
			this.bodyTotals.length = Math.min(this.bodyTotals.length, page)
			layout.pages.length = page
			layout.anchors.length = page
			layout.pageFirstLines.length = page
		}

		layout.final = false
		this.footnotes.restart()

		for (const index of [...layout.dirty]) if (index >= page) layout.dirty.delete(index)
		for (const index of [...layout.stale]) if (index >= page) layout.stale.delete(index)

		if (snapshot === undefined) {
			this.restartFromStart()

			return
		}

		if (this.inPlace === undefined) layout.renderedBreaks.length = snapshot.renderedBreaks

		this.sectionIndex = snapshot.sectionIndex
		// As the section reads now: an edit may have given the sections other properties.
		this.section = this.resolved(snapshot.sectionIndex)

		const section = this.model.sections[snapshot.sectionIndex]
		const body = this.body
		const story = this.bodyStory

		const flow = this.bodyFlow(snapshot.sectionIndex)

		if (section === undefined || body === undefined || story === undefined || flow === undefined) return

		this.flows = [flow]
		this.flowIndex = 0
		this.pageNumber = snapshot.pageNumber
		this.restart = snapshot.restart
		this.sectionFirstPage = snapshot.sectionFirstPage
		this.nextStart = snapshot.nextStart
		this.bodyLines = snapshot.bodyLines
		this.lineSection = snapshot.lineSection
		this.endnotesDone = snapshot.endnotesDone
		this.globalLine = snapshot.globalLine
		this.chapters = snapshot.chapters
		spliceAll(this.sectionPageCounts, 0, this.sectionPageCounts.length, snapshot.sectionPageCounts)

		// Taken before the document had lists (planned ones came since): nothing counted yet.
		if (snapshot.counters !== undefined) story.counters?.restore(snapshot.counters)
		else story.counters?.reset()

		this.engine.notes.restore(snapshot.notes)
		this.engine.notes.forgetAssigned(this.isBodyPart, snapshot.assigned)
		this.footnotes.carriedNotes = snapshot.carried

		for (const note of snapshot.carried) if (note.mark !== undefined) this.engine.notes.marks.set(note.story, note.mark)

		this.engine.setEndnotes(snapshot.endnotes)
		this.forgetMarkers()

		for (const [key, marker] of snapshot.markers) this.engine.markers.set(key, marker)

		// The page opens again with the restored state; the flow resumes in its first area.
		this.put(this.snapshots, this.inPlace?.snapshots, page, snapshot)
		this.openPage()
		flow.restore(snapshot.flow, this.area)
		this.pageKeep = flow.keepBack
		this.anchor = this.anchorHere()
	}

	private restartFromStart(): void {
		if (this.inPlace === undefined) this.layout.renderedBreaks.length = 0

		this.sectionIndex = -1
		this.section = resolveSection({})
		this.flows = []
		this.flowIndex = 0
		this.pageNumber = 0
		this.restart = undefined
		this.sectionFirstPage = true
		this.nextStart = AreaStart.DOCUMENT
		this.bodyLines = 0
		this.lineSection = -1
		this.endnotesDone = -1
		this.globalLine = 0
		this.chapters = NO_CHAPTERS
		this.sectionPageCounts.length = 0
		this.bodyStory?.counters?.reset()
		this.engine.notes.restore(this.initialNotes)
		this.engine.notes.forgetAssigned(this.isBodyPart, [])
		this.footnotes.carriedNotes = []
		this.engine.truncateEndnotes(0)
		this.forgetMarkers()
	}

	// The parts whose paragraphs the body flow lays out.
	private readonly isBodyPart = (part: number): boolean => {
		const edits = this.engine.edits

		return edits === undefined ? part === (this.body?.index ?? -1) : edits.bodyPart(part)
	}

	// Whether item `item` of `part` lies in a block of `flow` from the one being laid out to the last one built
	// ahead of it (keep chains, frames, joined paragraphs).
	// `rows`: inside the table under way, only what it lays out again (rows to come, repeated header rows).
	private ahead(flow: BlockFlow, part: number, item: number, rows = false): boolean {
		const last = Math.max(flow.index, flow.furthest)
		const edits = this.engine.edits
		// An edited paragraph inside a block (a table cell's) is laid out from an overlay of its own: it is where
		// its source is. A row an edit wrote again stands for its table (its paragraphs' overlays for the row).
		const source = edits?.sourceBlock?.(part, item) ?? -1
		const sourcePart = source < 0 ? -1 : refPart(source)
		const sourceItem = source < 0 ? -1 : refItem(source)
		const outer = source < 0 ? -1 : (edits?.sourceBlock?.(sourcePart, sourceItem) ?? -1)
		const outerPart = outer < 0 ? -1 : refPart(outer)
		const outerItem = outer < 0 ? -1 : refItem(outer)

		for (let k = flow.index; k <= last && k < flow.count; k++) {
			const block = flow.blocks[k] ?? -1
			const end = flow.partAt(k)?.end(block) ?? block + 1

			if (flow.parts[k] === part && item >= block && item < end) return !rows || k !== flow.index || flow.tableAhead(part, item)
			// The row (or cell paragraph) the table holds is the level below the table itself.
			if (flow.parts[k] === sourcePart && sourceItem >= block && sourceItem < end)
				return (
					!rows ||
					k !== flow.index ||
					(sourceItem === block ? flow.tableAhead(part, item) : flow.tableAhead(sourcePart, sourceItem))
				)
			if (flow.parts[k] === outerPart && outerItem >= block && outerItem < end)
				return (
					!rows ||
					k !== flow.index ||
					(outerItem === block ? flow.tableAhead(sourcePart, sourceItem) : flow.tableAhead(outerPart, outerItem))
				)

			// An edited paragraph counts under its source's key, and so do the paragraphs of its text boxes.
			const key = this.engine.memoKey(flow.parts[k] ?? -1, block)
			const keyPart = Math.floor(key / REF_SPAN)
			const keyItem = key - keyPart * REF_SPAN

			if (keyPart === part && keyItem === item) return true
			if (keyPart === part && keyPart !== flow.parts[k] && item > keyItem && item < (this.model.parts[keyPart]?.end(keyItem) ?? 0))
				return !rows || k !== flow.index || flow.tableAhead(part, item)
		}

		return false
	}

	// List markers counted for blocks the page that opens lays out again (built ahead before it opened).
	private markersAhead(flow: BlockFlow): [number, ListMarker | null][] {
		const out: [number, ListMarker | null][] = []

		for (const [key, marker] of this.engine.markers) {
			const part = Math.floor(key / REF_SPAN)

			if (this.isBodyPart(part) && this.ahead(flow, part, key - part * REF_SPAN, true)) out.push([key, marker])
		}

		return out
	}

	// List markers the body flow counted are counted again (layout restarts at a page).
	private forgetMarkers(): void {
		const markers = this.engine.markers

		for (const key of markers.keys()) if (this.isBodyPart(Math.floor(key / REF_SPAN))) markers.delete(key)
	}

	// The body flow of section `index`: the model's blocks, or the edited body's.
	private bodyFlow(index: number): BlockFlow | undefined {
		const section = this.model.sections[index]
		const body = this.body
		const story = this.bodyStory

		if (section === undefined || body === undefined || story === undefined) return undefined

		const flow = new BlockFlow(this.engine, story, Region.BODY, true)
		const blocks = this.engine.edits?.body

		if (blocks === undefined) flow.setRange(body, section.start, section.end)
		else flow.setRefs(body, blocks.refs, index === 0 ? 0 : (blocks.sectionEnds[index - 1] ?? 0), blocks.sectionEnds[index] ?? 0)

		// The section's last paragraph holds its break: formatting marks show how the next section starts.
		if (index + 1 < this.model.sections.length) flow.lastFlags = sectionBreakFlags(this.resolved(index + 1).type)

		return flow
	}

	private startSection(index: number): boolean {
		const flow = this.bodyFlow(index)

		if (flow === undefined) return false

		this.sectionIndex = index
		this.section = this.resolved(index)
		this.flows = [flow]
		this.flowIndex = 0
		this.engine.notes.startSection(this.section.footnotes, this.section.endnotes, index === 0, this.engine.edits)

		const start = this.section.pageNumbering.start

		if (start !== undefined) this.restart = start

		return true
	}

	private nextSection(): Step {
		const index = this.sectionIndex + 1
		const section = this.model.sections[index]

		if (this.endnotesDone !== this.sectionIndex) {
			this.endnotesDone = this.sectionIndex

			if (this.queueEndnotes(section === undefined)) return Step.PROGRESS
		}

		if (section === undefined) {
			this.closePage()
			this.finished = true

			return Step.FINISHED
		}

		const previous = this.section
		const next = this.resolved(index)
		const sameSize = Math.abs(next.pageWidth - previous.pageWidth) < 1 && Math.abs(next.pageHeight - previous.pageHeight) < 1

		if (this.pageOpen && next.type === "continuous" && sameSize) {
			// The section's columns end level before the next section starts below them, unless w:noColumnBalance.
			if (!this.compat.noColumnBalance) this.balanceColumns()

			if (this.geometry !== undefined) this.columnSeparators(this.geometry)

			if (this.notesPerColumn) this.closeColumnNotes()

			this.startSection(index)
			this.balanceStart = undefined
			this.geometry = pageGeometry(next, this.pageCompat(), this.frame.odd)
			this.pageParity ||= mirrored(next, this.pageCompat())
			this.engine.gridPitch = this.geometry.gridPitch
			this.sectionTop = this.contentBottom
			this.column = 0
			this.setArea(0, this.sectionTop, this.sectionTop <= this.bodyTop + EPSILON)
			this.area.start = AreaStart.BREAK

			if (this.notesPerColumn) this.footnotes.startColumn(this.area.left, this.area.width)

			return Step.PROGRESS
		}

		if (
			this.pageOpen &&
			next.type === "nextColumn" &&
			sameSize &&
			this.geometry !== undefined &&
			this.column + 1 < this.geometry.columnX.length
		) {
			this.startSection(index)

			return this.nextColumn(AreaStart.BREAK)
		}

		// The page closes with the section it belongs to before the next one starts.
		if (this.pageOpen) this.closePage()

		this.startSection(index)

		this.sectionFirstPage = true
		this.nextStart = AreaStart.BREAK

		const upcoming = this.restart ?? this.pageNumber + 1
		const wrongParity = (next.type === "evenPage" && upcoming % 2 === 1) || (next.type === "oddPage" && upcoming % 2 === 0)

		if (wrongParity && this.progress > 0) {
			// Word leaves a blank page to start the section on the right side.
			this.openPage()
			this.closePage()
			this.sectionFirstPage = true
		}

		return Step.PAGE
	}

	// Endnotes referenced so far, after the section (w:pos sectEnd) or the document's last one.
	private queueEndnotes(atEnd: boolean): boolean {
		const engine = this.engine

		if (engine.endnotes.length === 0 || (engine.notes.endnotes.position !== "sectEnd" && !atEnd)) return false

		const stories = engine.takeEndnotes()

		const flows: BlockFlow[] = []
		const model = this.model
		let separator = -1

		for (const id of model.settings.endnoteSeparators) {
			const story = model.endnotes.get(id)

			if (story?.noteType === "separator") separator = story.index
		}

		for (const index of separator >= 0 ? [separator, ...stories] : stories) {
			const story = model.stories[index]
			const part = story === undefined ? undefined : model.parts[story.part]

			if (story === undefined || part === undefined) continue

			const context: StoryContext = {
				part,
				story: index,
				counters: undefined,
				noteMark: engine.notes.marks.get(index) ?? "",
				breaksAsLines: true,
				recount: false
			}

			const flow = new BlockFlow(engine, context, Region.ENDNOTE, true)
			// An edited note's blocks as edited (a note the editor added has no source container).
			const edited = engine.edits?.stories?.get(index)

			flows.push(edited === undefined ? flow.setContainer(part, story.item) : flow.setRefs(part, edited, 0, edited.length))
		}

		if (flows.length === 0) return false

		this.flows = flows
		this.flowIndex = 0

		// After the section's text on its last page (each flow starts at its area's top).
		if (this.pageOpen) this.continueBelow()

		return true
	}

	// The area resumes below what the column holds, for a flow that follows another in it.
	private continueBelow(): void {
		const area = this.area

		if (this.columnBottom <= area.top + EPSILON) return

		area.top = this.columnBottom
		area.empty = false
	}

	// Lays the section's part of the page out again with the lowest column bottom that still holds it, so the
	// columns end level (the first ones longer when they cannot be equal).
	private balanceColumns(): void {
		const geometry = this.geometry
		const start = this.balanceStart
		const flow = this.flows[0]

		// Not when the section's endnotes ran on after its text (they are no part to lay out again).
		if (geometry === undefined || start === undefined || start === null || flow !== start.body || geometry.columnX.length < 2) return

		let low = this.sectionTop
		let high = this.bodyBottom
		const yieldAt = this.engine.yieldAt

		// Each try runs to its end: a slice running out in one would read as text that did not fit.
		this.engine.yieldAt = Infinity

		try {
			for (let k = 0; k < BALANCE_STEPS && high - low > 0.5; k++) {
				const middle = (low + high) / 2

				if (this.fillColumns(start, flow, middle, geometry.columnX.length) === FlowStatus.DONE) high = middle
				else low = middle
			}

			if (this.fillColumns(start, flow, high, geometry.columnX.length) !== FlowStatus.DONE)
				this.fillColumns(start, flow, this.bodyBottom, geometry.columnX.length)
		} finally {
			this.engine.yieldAt = yieldAt
		}
	}

	// Lays the section's part of the page out from `start` into its columns from sectionTop to `bottom`; what
	// the last column ended with (DONE: it all fitted).
	private fillColumns(start: BalanceStart, flow: BlockFlow, bottom: number, columns: number): FlowStatus {
		this.page.rollback(start.mark)
		this.footnotes.load(start.notes)
		this.exclusions.count = start.exclusions
		this.engine.truncateEndnotes(start.endnotes)
		this.contentBottom = this.sectionTop
		this.column = 0
		this.setArea(0, this.sectionTop, start.empty)
		this.area.start = start.start
		this.area.bottom = bottom
		flow.restore(start.flow, this.area)

		for (;;) {
			const status = flow.run(this.area)

			this.contentBottom = Math.max(this.contentBottom, flow.y)
			this.columnBottom = Math.max(this.columnBottom, flow.y)

			if (status === FlowStatus.DONE) return status

			if ((status !== FlowStatus.OVERFLOW && status !== FlowStatus.COLUMN_BREAK) || this.column + 1 >= columns) return status

			if (this.notesPerColumn) this.closeColumnNotes()

			this.column++
			this.setArea(this.column, this.sectionTop, this.sectionTop <= this.bodyTop + EPSILON)
			this.area.start = status === FlowStatus.COLUMN_BREAK ? AreaStart.BREAK : AreaStart.OVERFLOW
			this.area.bottom = bottom

			if (this.notesPerColumn) this.footnotes.startColumn(this.area.left, this.area.width)
		}
	}

	// Draws the notes of the column being left at its bottom; text that comes later on the page keeps clear
	// of them.
	private closeColumnNotes(): void {
		const top = this.footnotes.close(this.page, this.bodyBottom, this.columnBottom)

		if (top < this.bodyBottom - EPSILON)
			this.exclusions.add(this.area.left, top, this.area.left + this.area.width, this.bodyBottom, Wrap.BOTH)
	}

	private columnSeparators(geometry: PageGeometry): void {
		if (!geometry.separator) return

		for (let c = 1; c < geometry.columnX.length; c++) {
			const previousEnd = (geometry.columnX[c - 1] ?? 0) + (geometry.columnWidths[c - 1] ?? 0)
			const x = geometry.left + (previousEnd + (geometry.columnX[c] ?? 0)) / 2

			this.page.addGraphic(
				PageGraphic.COLUMN_SEPARATOR,
				0,
				Layer.TEXT,
				x - 0.5,
				this.sectionTop,
				1,
				Math.max(1, this.contentBottom - this.sectionTop)
			)
		}
	}

	private nextColumn(start: AreaStart): Step {
		const geometry = this.geometry

		if (geometry !== undefined && this.column + 1 < geometry.columnX.length) {
			if (this.notesPerColumn) this.closeColumnNotes()

			this.column++
			this.setArea(this.column, this.sectionTop, this.sectionTop <= this.bodyTop + EPSILON)
			this.area.start = start

			if (this.notesPerColumn) this.footnotes.startColumn(this.area.left, this.area.width)

			return Step.PROGRESS
		}

		this.closePage()
		this.nextStart = start

		return Step.PAGE
	}

	private setArea(column: number, top: number, empty: boolean): void {
		const geometry = this.geometry
		const area = this.area

		if (geometry === undefined) return

		this.columnBottom = top
		area.page = this.page
		area.region = Region.BODY
		area.left = geometry.left + (geometry.columnX[column] ?? 0)
		area.width = geometry.columnWidths[column] ?? geometry.width - geometry.left - geometry.right
		area.top = top
		area.bottom = this.bodyBottom
		area.empty = empty
		area.breaks = true
		area.inTable = false
		area.exclusions = this.exclusions
		area.footnotes = this.footnotes
		area.values = this.values
		area.frame = this.frame
		area.token = nextToken()
	}

	// Lays out a header or footer story at `top`; its height. Its wrapping floats' obstacles are left in
	// storyWraps.
	private layoutStory(story: number, output: PageOutput, region: Region, top: number): number {
		const context = this.storyContext(story, true)
		const geometry = this.geometry

		this.storyWraps.clear()

		if (context === undefined || geometry === undefined) return 0

		const root = this.model.stories[story]

		if (root === undefined) return 0

		return this.engine.layoutBox(
			context,
			region,
			output,
			this.values,
			this.frame,
			geometry.left,
			top,
			geometry.width - geometry.left - geometry.right,
			true,
			this.storyWraps
		)
	}

	// Lays out the page's header and footer; the body's obstacles from their wrapping floats are left in
	// headerFooterWraps. Returns the header's bottom; the footer's top is left in laidFooterTop.
	private layoutHeaderFooter(header: number, footer: number, geometry: PageGeometry): number {
		const wraps = this.headerFooterWraps
		let headerBottom = 0
		let footerTop = geometry.height

		wraps.clear()

		if (header >= 0) {
			headerBottom = geometry.header + this.layoutStory(header, this.header, Region.HEADER, geometry.header)
			wraps.addShifted(this.storyWraps, 0)
		}

		if (footer >= 0) {
			const height = this.layoutStory(footer, this.footer, Region.FOOTER, 0)

			footerTop = geometry.height - geometry.footer - height

			// Laid out at 0 for its height, then moved; again in place when it placed something on the page or its
			// margins, which moving would take along.
			if (this.footer.pinned) {
				this.footer.reset()
				this.layoutStory(footer, this.footer, Region.FOOTER, footerTop)
				wraps.addShifted(this.storyWraps, 0)
			} else {
				this.footer.move(new OutputMark(), null, 0, footerTop)
				wraps.addShifted(this.storyWraps, footerTop)
			}
		}

		this.laidFooterTop = footerTop

		return headerBottom
	}

	private anchorHere(): PageAnchor {
		const flow = this.flows[this.flowIndex]
		const position = flow?.position()

		return {
			section: this.sectionIndex,
			story: flow?.story.story ?? -1,
			block: position?.block ?? -1,
			part: position?.part ?? -1,
			index: position?.index ?? -1,
			row: position?.row ?? -1,
			offset: position?.offset ?? 0
		}
	}

	private headerFooter(set: Section["effectiveHeaders"], odd: boolean): number {
		if (this.sectionFirstPage && this.section.titlePage) return set.first
		if ((this.engine.edits?.evenAndOddHeaders ?? this.compat.evenAndOddHeaders) && !odd) return set.even

		return set.default
	}

	private openPage(): void {
		const section = this.section
		const sectionInfo = this.model.sections[this.sectionIndex]
		const number = this.restart ?? this.pageNumber + 1

		this.restart = undefined
		this.pageNumber = number
		this.parityAtOpen = this.engine.parityReads
		this.pageKeep = this.flows[this.flowIndex]?.keepBack ?? 0

		const odd = number % 2 !== 0
		const geometry = pageGeometry(section, this.pageCompat(), odd)

		this.geometry = geometry
		this.openGeometry = geometry
		this.engine.gridPitch = geometry.gridPitch
		this.page.reset()
		this.header.reset()
		this.footer.reset()
		this.exclusions.clear()
		this.engine.notes.startPage()
		this.values = {
			page: number,
			pageFormat: section.pageNumbering.format,
			chapter: this.chapterOf(section),
			numPages: this.estimate,
			sectionPages: this.sectionEstimates[this.sectionIndex] ?? 1
		}
		this.frame = {
			width: geometry.width,
			height: geometry.height,
			marginLeft: geometry.left,
			marginRight: geometry.right,
			marginTop: geometry.top,
			marginBottom: geometry.height - geometry.bottom,
			odd
		}
		this.pageSection = this.sectionIndex
		this.pageProps = section

		// Their font is asked for before the page's text: it is loaded before the page is done.
		if (shownLineNumbers(section.lineNumbering) !== undefined) this.lineNumberStyle()

		this.anchor = this.anchorHere()

		const textWidth = geometry.width - geometry.left - geometry.right

		this.headerStory = sectionInfo === undefined ? -1 : this.headerFooter(sectionInfo.effectiveHeaders, odd)
		this.footerStory = sectionInfo === undefined ? -1 : this.headerFooter(sectionInfo.effectiveFooters, odd)
		// Its section starts on a page of one parity, its margins swap with it, or it shows the other header or
		// footer on a page of the other parity.
		this.pageParity =
			section.type === "oddPage" ||
			section.type === "evenPage" ||
			mirrored(section, this.pageCompat()) ||
			(sectionInfo !== undefined &&
				(this.headerFooter(sectionInfo.effectiveHeaders, !odd) !== this.headerStory ||
					this.headerFooter(sectionInfo.effectiveFooters, !odd) !== this.footerStory))

		const headerBottom = this.layoutHeaderFooter(this.headerStory, this.footerStory, geometry)
		const footerTop = this.laidFooterTop

		// Body text wraps around the header's and footer's wrapping floats (ECMA-376 §20.4.2.3).
		this.exclusions.addShifted(this.headerFooterWraps, 0)
		this.pageWraps = this.headerFooterWraps.key()

		// The header and footer cannot wait for fonts: when they needed one still loading, the page is laid out
		// again once it has loaded, even if it arrived before the page closes (between slices).
		if (this.engine.styles.hasMissing) this.pageMissedFonts = true

		this.headerBottom = headerBottom
		this.footerTop = footerTop

		this.bodyTop = geometry.topFixed ? geometry.top : Math.max(geometry.top, headerBottom)
		this.bodyBottom = geometry.bottomFixed ? geometry.bottom : Math.min(geometry.bottom, footerTop)

		if (this.bodyBottom - this.bodyTop < 24) this.bodyBottom = this.bodyTop + 24

		this.notesPerColumn = geometry.columnX.length > 1
		this.footnotes.startPage(
			geometry.left + (this.notesPerColumn ? (geometry.columnX[0] ?? 0) : 0),
			this.notesPerColumn ? (geometry.columnWidths[0] ?? textWidth) : textWidth,
			this.values,
			this.frame,
			this.bodyTop,
			this.bodyBottom
		)
		this.column = 0
		this.balanceStart = undefined
		this.sectionTop = this.bodyTop
		this.contentBottom = this.bodyTop
		this.setArea(0, this.bodyTop, true)
		this.area.start = this.nextStart
		this.nextStart = AreaStart.OVERFLOW
		this.pageOpen = true
		this.firstOfSection = this.sectionFirstPage
		this.sectionFirstPage = false
	}

	private closePage(): void {
		if (!this.pageOpen) return

		const page = this.page
		const geometry = this.geometry
		const layout = this.layout

		this.pageOpen = false
		this.flows[this.flowIndex]?.leavePage()

		if (geometry === undefined) return

		this.verticalAlign(page)
		this.footnotes.close(page, this.bodyBottom, this.notesPerColumn ? this.columnBottom : this.contentBottom)

		this.columnSeparators(geometry)

		this.lineNumbers(page)
		this.pageBorders(page, geometry)
		this.countChapters(page)

		const index = this.progress
		const inPlace = this.inPlace
		const bodyFirst = this.firstBodyItem(page)
		const info = {
			index,
			number: this.pageNumber,
			numberText: pageNumberText(this.pageNumber, this.values.pageFormat, this.values.chapter),
			section: this.pageSection,
			width: geometry.width,
			height: geometry.height,
			bodyFirst,
			bodyLast: this.lastBodyItem(page),
			footnotes: this.footnotes.referenced
		}

		this.renderedBreaks(page, index)

		// Drawn with stand-in metrics where a header, footer, note or number needed a font still loading (now, or
		// when the page opened: the font may have arrived between slices since).
		if (this.missedFonts < 0 && (this.engine.styles.hasMissing || this.pageMissedFonts)) this.missedFonts = index

		this.pageMissedFonts = false

		this.put(this.bodyTotals, inPlace?.bodyTotals, index, this.usesTotals(page) ? this.values : undefined)
		this.put(this.bodyNumbers, inPlace?.bodyNumbers, index, usesFlag(page, SourceFlag.PAGE_FIELDS))

		const totals = this.usesTotals(this.header) || this.usesTotals(this.footer)
		const numbers = usesFlag(this.header, SourceFlag.PAGE_FIELDS) || usesFlag(this.footer, SourceFlag.PAGE_FIELDS)

		this.put(this.records, inPlace?.records, index, {
			index,
			totals,
			numbers,
			headerBottom: this.headerBottom,
			footerTop: this.footerTop,
			wraps: this.pageWraps,
			body: page.mark(),
			header: this.headerStory,
			footer: this.footerStory,
			geometry,
			headerGeometry: this.openGeometry ?? geometry,
			values: this.values,
			frame: this.frame,
			parity: this.engine.parityReads !== this.parityAtOpen || this.pageParity,
			keep: this.pageKeep,
			info
		})

		page.append(this.header, 0, 0)
		page.append(this.footer, 0, 0)
		page.stackObjects(this.zOrderOf)
		this.put(layout.pages, inPlace?.pages, index, new PageDisplayList(page, info))
		this.put(layout.anchors, inPlace?.anchors, index, this.anchor)
		this.sectionPageCounts[this.pageSection] = (this.sectionPageCounts[this.pageSection] ?? 0) + 1
		layout.notify(index, index + 1, false)
		this.trimMemos()

		if (this.progress >= this.maxPages) this.finished = true
	}

	// w:pgBorders: lines at their space from the page edge or around the text area.
	private pageBorders(page: PageOutput, geometry: PageGeometry): void {
		const borders = this.pageProps.pageBorders

		if (borders === undefined) return
		if (borders.display === "firstPage" && !this.firstOfSection) return
		if (borders.display === "notFirstPage" && this.firstOfSection) return

		const resolver = this.engine.resolver
		const decorations = this.engine.decorations
		const fromPage = borders.offsetFrom === "page"
		const layer = borders.zOrder === "back" ? Layer.BEHIND : Layer.TEXT
		const space = (border: { readonly space?: number } | undefined): number => ((border?.space ?? 0) * 4) / 3
		const top = resolver.border(borders.top)
		const bottom = resolver.border(borders.bottom)
		const left = resolver.border(borders.left)
		const right = resolver.border(borders.right)
		const x0 = fromPage ? space(borders.left) : geometry.left - space(borders.left)
		const x1 = fromPage ? geometry.width - space(borders.right) : geometry.width - geometry.right + space(borders.right)
		const y0 = fromPage ? space(borders.top) : this.bodyTop - space(borders.top)
		const y1 = fromPage ? geometry.height - space(borders.bottom) : this.bodyBottom + space(borders.bottom)
		const line = (border: typeof top, x: number, y: number, width: number, height: number): void => {
			if (border !== undefined) page.addGraphic(PageGraphic.BORDER, decorations.border(border), layer, x, y, width, height)
		}

		line(top, x0, y0, x1 - x0, top === undefined ? 0 : borderWidth(top))
		line(bottom, x0, y1 - (bottom === undefined ? 0 : borderWidth(bottom)), x1 - x0, bottom === undefined ? 0 : borderWidth(bottom))
		line(left, x0, y0, left === undefined ? 0 : borderWidth(left), y1 - y0)
		line(right, x1 - (right === undefined ? 0 : borderWidth(right)), y0, right === undefined ? 0 : borderWidth(right), y1 - y0)
	}

	private usesTotals(output: PageOutput): boolean {
		return usesFlag(output, SourceFlag.TOTAL_FIELDS)
	}

	// The body flow's list markers of blocks already behind it are no longer needed.
	private trimMemos(): void {
		const markers = this.engine.markers
		const flow = this.flows[this.flowIndex]

		if (markers.size < 8192 || flow === undefined || flow.region !== Region.BODY) return

		for (const key of markers.keys()) {
			const part = Math.floor(key / REF_SPAN)
			const item = key - part * REF_SPAN

			if (!this.isBodyPart(part) || this.ahead(flow, part, item)) continue

			// The block before the one being laid out stays: a keep chain may still roll back into it.
			const previous = flow.index - 1
			const block = flow.blocks[previous] ?? -1

			if (previous >= 0 && flow.parts[previous] === part && item >= block && item < (flow.partAt(previous)?.end(block) ?? block))
				continue

			markers.delete(key)
		}
	}

	// Chapter numbers (w:pgNumType chapStyle, §17.6.12): a page shows the list number of the last numbered heading
	// of the chapter level laid out on it or before. The page's headings are counted as it closes; when one
	// changed the chapter the page opened with, a header or footer showing page numbers is laid out again (the
	// body keeps its area).
	private countChapters(page: PageOutput): void {
		if (this.chapterLevels < 0) this.chapterLevels = this.readChapterLevels()

		const levels = this.chapterLevels

		if (levels === 0) return

		const engine = this.engine
		let chapters: (string | undefined)[] | undefined
		let lastPart = -1
		let lastItem = -1

		for (let s = 0; s < page.sourceCount; s++) {
			const at = s * SOURCE_INTS
			const part = page.sourceParts[s] ?? -1
			const item = page.sourceInts[at + SourceInt.ITEM] ?? -1

			if (page.sourceInts[at] !== Region.BODY || (page.sourceOwners[s] ?? -1) >= 0 || (part === lastPart && item === lastItem))
				continue

			lastPart = part
			lastItem = item

			const level = this.isBodyPart(part) ? this.headingOf(part, item) : undefined

			if (level === undefined || (levels & (1 << (level - 1))) === 0) continue

			// Counted when the heading was built (unnumbered: none).
			const text = engine.markers.get(engine.memoKey(part, item))?.text

			if (text === undefined || text === "" || text === (chapters ?? this.chapters)[level - 1]) continue

			chapters ??= this.chapters.slice()
			chapters[level - 1] = text
		}

		if (chapters === undefined) return

		this.chapters = chapters

		const chapter = this.chapterOf(this.pageProps)
		const geometry = this.geometry
		const opened = this.openGeometry ?? geometry

		if (chapter === this.values.chapter) return

		this.values = { ...this.values, chapter }

		if (opened === undefined || !(usesFlag(this.header, SourceFlag.PAGE_FIELDS) || usesFlag(this.footer, SourceFlag.PAGE_FIELDS)))
			return

		this.geometry = opened
		this.header.reset()
		this.footer.reset()
		this.layoutHeaderFooter(this.headerStory, this.footerStory, opened)
		this.geometry = geometry
	}

	// The chapter prefix pages of `section` show: the chapter number and its separator, undefined without one.
	private chapterOf(section: ResolvedSectionProps): string | undefined {
		const level = section.pageNumbering.chapterStyle
		const text = level === undefined ? undefined : this.chapters[level - 1]

		return text === undefined ? undefined : text + chapterSeparator(section.pageNumbering.chapterSeparator)
	}

	// The heading levels the sections number chapters by (bit level - 1).
	private readChapterLevels(): number {
		let levels = 0

		for (let index = 0; index < this.model.sections.length; index++) {
			const level = this.resolved(index).pageNumbering.chapterStyle

			if (level !== undefined && level >= 1 && level <= 9) levels |= 1 << (level - 1)
		}

		return levels
	}

	// The built-in heading style (Heading 1-9) a paragraph is in: chapStyle names the style, not an outline level.
	private headingOf(partIndex: number, item: number): number | undefined {
		const part = this.model.parts[partIndex]
		const row = part === undefined || item < 0 ? -1 : part.paragraphRow(item)

		if (part === undefined || row < 0) return undefined

		const engine = this.engine
		const style = engine.resolver.paragraphStyle(engine.store.paragraphLook(part.document, part.paragraphs.pPr[row] ?? -1).styleId)

		return style === undefined ? undefined : headingLevel(style)
	}

	private firstBodyItem(page: PageOutput): number {
		for (let s = 0; s < page.sourceCount; s++)
			if (page.sourceInts[s * SOURCE_INTS] === Region.BODY) return page.sourceInts[s * SOURCE_INTS + SourceInt.ITEM] ?? -1

		return -1
	}

	private lastBodyItem(page: PageOutput): number {
		for (let s = page.sourceCount - 1; s >= 0; s--)
			if (page.sourceInts[s * SOURCE_INTS] === Region.BODY) return page.sourceInts[s * SOURCE_INTS + SourceInt.ITEM] ?? -1

		return -1
	}

	// Section vertical alignment (w:vAlign) on pages of one section.
	private verticalAlign(page: PageOutput): void {
		if (!aligned(this.pageProps) || this.pageSection !== this.sectionIndex) return

		const dy = this.alignShift(this.contentBottom)

		if (dy <= EPSILON) return

		// Objects placed on the page or its margins stay (pinned when placed). When the text wraps around one of
		// them or the header's or footer's, Word lays it out again in its new place.
		if ((!page.fixedWraps && this.headerFooterWraps.count === 0) || !this.alignAgain(dy)) page.moveText(dy)
	}

	// How far section vertical alignment moves text ending at `bottom` (laid out from sectionTop).
	private alignShift(bottom: number): number {
		const free = this.bodyBottom - this.footnotes.reserved - bottom

		return this.pageProps.vAlign === "center" ? free / 2 : free
	}

	// Lays the page's text out again `dy` lower, then with the height that took, or less low while it no longer
	// ends the page where it did (bisected); false when it cannot be laid out again.
	private alignAgain(dy: number): boolean {
		const start = this.balanceStart
		const flow = this.flows[0]
		const geometry = this.geometry
		const end = flow?.snapshot()

		if (
			start === undefined ||
			start === null ||
			flow !== start.body ||
			this.flows.length !== 1 ||
			geometry === undefined ||
			end === undefined
		)
			return false

		const status = this.lastStatus
		const top = this.sectionTop
		const columns = geometry.columnX.length
		const yieldAt = this.engine.yieldAt
		// The lowest shift known to end the page where it did, and the highest one known not to.
		let good = 0
		let bad = Infinity
		let laid = 0

		// Each try runs to its end (see balanceColumns).
		this.engine.yieldAt = Infinity

		try {
			for (let round = 0; round < ALIGN_ROUNDS && Math.abs(dy - good) > ALIGN_TOLERANCE && dy > EPSILON; round++) {
				laid = dy
				this.sectionTop = top + dy

				if (this.fillColumns(start, flow, this.bodyBottom, columns) === status && sameEnd(flow.snapshot(), end)) {
					good = dy
					dy = Math.min(this.alignShift(this.contentBottom - dy), (good + bad) / 2)
				} else {
					// Going around the obstacles it no longer fits: as low as it still does.
					bad = dy
					dy = (good + bad) / 2
				}
			}

			if (laid !== good) {
				this.sectionTop = top + good
				this.fillColumns(start, flow, this.bodyBottom, columns)
			}
		} finally {
			this.engine.yieldAt = yieldAt
		}

		// Not tried: too small a shift to lay out again for.
		return laid > 0
	}

	// Line numbers in the margin (w:lnNumType), counting body lines outside tables.
	// Line numbers' style (w:lnNumType draws them in the LineNumber character style).
	// The compatibility settings pages are laid out with: mirror margins as edited.
	private pageCompat(): LayoutCompat {
		const mirror = this.engine.edits?.mirrorMargins

		if (mirror === undefined || mirror === this.compat.mirrorMargins) return this.compat

		if (this.editedCompat?.mirrorMargins !== mirror) this.editedCompat = { ...this.compat, mirrorMargins: mirror }

		return this.editedCompat
	}

	private lineNumberStyle(): number {
		const engine = this.engine

		return engine.styles.style(engine.resolver.run(engine.resolver.paragraph({}), LINE_NUMBER_RUN), "ascii")
	}

	private lineNumbers(page: PageOutput): void {
		const numbering = shownLineNumbers(this.pageProps.lineNumbering)
		const geometry = this.geometry

		if (numbering === undefined || geometry === undefined || this.body === undefined) return

		const countBy = Math.max(1, numbering.countBy ?? 1)
		const distance = numbering.distance === undefined ? 18 : twips(numbering.distance)
		const text = page.text
		const engine = this.engine
		const style = this.lineNumberStyle()
		const rtl = this.pageProps.bidi
		// Word numbers from w:start + 1 (MS-OI29500 2.1.215: the value is how many numbers to skip).
		const start = (numbering.start ?? 0) + 1
		let n =
			numbering.restart === "continuous" || (numbering.restart === "newSection" && this.lineSection === this.pageSection)
				? this.bodyLines
				: 0

		this.lineSection = this.pageSection
		const lines = text.lineCount

		for (let line = 0; line < lines; line++) {
			const source = text.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? 0

			if (
				page.sourceInts[source * SOURCE_INTS] !== Region.BODY ||
				(page.sourceFlags(source) & (SourceFlag.IN_TABLE | SourceFlag.NO_LINE_NUMBERS)) !== 0
			)
				continue

			n++

			if ((start - 1 + n) % countBy !== 0) continue

			const label = String(start - 1 + n)
			const width = engine.styles.table.cache.width(engine.styles.table.fontKey[style] ?? 0, label, 0, label.length)
			const top = text.lineTop(line)
			const height = text.lineHeight(line)
			const baseline = text.lineBaseline(line)
			// A fixed distance from the text margin of the line's column, whatever its indent or alignment
			// (ECMA-376 §17.6.8); right of it in a right-to-left section.
			const lineX = text.lineFloats[line * LINE_FLOATS + 3] ?? 0
			const column = columnAt(geometry, lineX + (text.lineFloats[line * LINE_FLOATS + 4] ?? 0) / 2)
			const columnLeft = geometry.left + (geometry.columnX[column] ?? 0)
			const x = rtl ? columnLeft + (geometry.columnWidths[column] ?? 0) + distance : columnLeft - distance - width
			const labelSource = page.addSource(Region.LINE_NUMBER, -1, -1, 0, label)

			text.addLine(top, height, baseline, x, width, 0, label.length, 0, labelSource)
			text.addFragment(x, width, 0, 0, 0, label.length, style, 0, 0)
		}

		this.bodyLines = n
	}

	private renderedBreaks(page: PageOutput, index: number): void {
		const layout = this.layout
		const text = page.text
		let first = -1

		for (let line = 0; line < text.lineCount; line++) {
			const source = text.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? 0

			if (page.sourceInts[source * SOURCE_INTS] !== Region.BODY) continue

			const global = this.globalLine++

			if (first < 0) first = global

			const breaks = page.sourceBreaks[source]

			if (breaks === undefined) continue

			const start = text.lineInts[line * LINE_INTS + LineInt.TEXT_START] ?? 0
			const end = text.lineInts[line * LINE_INTS + LineInt.TEXT_END] ?? 0

			breaks.forEach((offset, ordinal) => {
				if (offset >= start && (offset < end || (offset === end && (text.lineFlags(line) & 1) !== 0))) {
					this.put(layout.renderedBreaks, this.inPlace?.breaks, this.breakCount, {
						page: index,
						line: global,
						item: page.sourceInts[source * SOURCE_INTS + SourceInt.ITEM] ?? -1,
						ordinal
					})
				}
			})
		}

		this.put(layout.pageFirstLines, this.inPlace?.firstLines, index, first < 0 ? this.globalLine : first)
	}

	private globalLine = 0

	// The first page whose body showed page counts other than the layout's, or -1.
	totalsMismatch(): number {
		const total = this.layout.pages.length

		for (let index = 0; index < this.bodyTotals.length; index++) {
			const values = this.bodyTotals[index]

			if (values === undefined) continue

			const section = this.layout.pages[index]?.section ?? 0

			if (values.numPages !== total || values.sectionPages !== (this.sectionPageCounts[section] ?? 1)) return index
		}

		return -1
	}

	// The first page whose body shows page counts (NUMPAGES, SECTIONPAGES in the text), or -1.
	firstBodyCounts(): number {
		return this.bodyTotals.findIndex(values => values !== undefined)
	}

	// The estimates a fresh layout of the saved document starts from (Word's recorded page breaks plus one, as
	// the constructor counts them); whether they differ from those in use (then they are in use from now on). Page counts in the body can settle on more than one count (a longer number taking
	// a page more): an edit settles on the one a fresh layout settles on.
	freshEstimates(): boolean {
		const breaks = this.renderedBreakCounts()
		const counts = breaks.map(count => count + 1)
		const estimate = Math.max(1, breaks.reduce((sum, count) => sum + count, 0) + 1)
		let same = estimate === this.estimate

		for (let section = 0; section < counts.length && same; section++) same = counts[section] === this.sectionEstimates[section]

		this.estimate = estimate

		for (let section = 0; section < counts.length; section++) this.sectionEstimates[section] = counts[section] ?? 1

		return !same
	}

	// Takes the page counts of the layout so far as the estimates fields show from now on.
	adoptTotals(): void {
		this.estimate = Math.max(1, this.layout.pages.length)

		// Sections an edit added have counts too.
		for (let section = 0; section < this.sectionPageCounts.length; section++) {
			const count = this.sectionPageCounts[section]

			if (count !== undefined) this.sectionEstimates[section] = count
		}
	}

	// Whether the page counts fields show (the estimates in use) are the layout's: nothing to count again.
	countsHold(): boolean {
		if (this.estimate !== this.layout.pages.length) return false

		for (let section = 0; section < this.sectionPageCounts.length; section++)
			if ((this.sectionPageCounts[section] ?? 1) !== (this.sectionEstimates[section] ?? 1)) return false

		return true
	}

	// Page count fields: pages whose headers or footers used the estimate are laid out again, or with `lazy`
	// marked stale for refresh(). The first page that needs more than its header and footer (they changed
	// height, or its body shows the counts), or -1: layout runs again from there.
	finish(lazy = false): number {
		const layout = this.layout
		const total = layout.pages.length
		let first = -1

		this.resyncs = undefined

		for (const entry of this.records) {
			if (entry === undefined || !entry.totals) continue

			const sectionPages = this.sectionPageCounts[entry.info.section] ?? 1

			if (entry.values.numPages === total && entry.values.sectionPages === sectionPages) continue

			if (lazy) layout.stale.add(entry.index)
			else if (this.redoHeaderFooter(entry) !== "done" && first < 0) first = entry.index
		}

		return first
	}

	// Lays page `entry.index` out again with its current page values (number and counts): its header and
	// footer, the body kept. "numbers" when the body shows page values that changed too, "moved" when the
	// header or footer changed height (the body's area moved): the page needs layout.
	redoHeaderFooter(entry: PageRecord): RefreshResult {
		const layout = this.layout
		const list = layout.pages[entry.index]

		if (list === undefined) return "numbers"

		const values: PageValues = {
			...entry.values,
			page: list.number,
			numPages: layout.pages.length,
			sectionPages: this.sectionPageCounts[entry.info.section] ?? 1
		}
		const body = this.bodyTotals[entry.index]

		if (
			(body !== undefined && (body.numPages !== values.numPages || body.sectionPages !== values.sectionPages)) ||
			(this.bodyNumbers[entry.index] === true && entry.values.page !== values.page)
		)
			return "numbers"

		const page = this.page
		const geometry = entry.headerGeometry
		const info = { ...entry.info, index: entry.index, number: list.number, numberText: list.numberText }

		this.values = values
		this.frame = entry.frame
		this.geometry = geometry
		page.reset()
		this.header.reset()
		this.footer.reset()

		const headerBottom = this.layoutHeaderFooter(entry.header, entry.footer, geometry)
		const footerTop = this.laidFooterTop

		// A header or footer of another height, or whose floats the body wraps around moved, moves the body: it
		// is laid out again instead.
		if (
			(!geometry.topFixed && Math.abs(Math.max(geometry.top, headerBottom) - Math.max(geometry.top, entry.headerBottom)) > EPSILON) ||
			(!geometry.bottomFixed &&
				Math.abs(Math.min(geometry.bottom, footerTop) - Math.min(geometry.bottom, entry.footerTop)) > EPSILON) ||
			this.headerFooterWraps.key() !== entry.wraps
		)
			return "moved"

		page.append(list, 0, 0, -Infinity, Infinity, null, entry.body)
		page.append(this.header, 0, 0)
		page.append(this.footer, 0, 0)
		page.stackObjects(this.zOrderOf)
		layout.pages[entry.index] = new PageDisplayList(page, info)
		layout.dirty.add(entry.index)
		this.records[entry.index] = { ...entry, values, info, headerBottom, footerTop }

		return "done"
	}

	// A stale page brought up to date (see DocumentLayout.refresh).
	refresh(index: number): RefreshResult {
		const layout = this.layout

		if (!layout.stale.has(index)) return "done"

		const entry = this.records[index]
		const result = entry === undefined ? "numbers" : this.redoHeaderFooter(entry)

		// A font the header or footer needs is still loading: a run lays the page out again, waiting for it.
		if (result === "done" && this.engine.styles.hasMissing) return "numbers"

		if (result === "done") layout.stale.delete(index)

		return result
	}

	// Pages showing story `story` as their header or footer are marked stale (its text changed); the first, or
	// -1.
	restory(story: number): number {
		let first = -1

		for (const entry of this.records) {
			if (entry === undefined || (entry.header !== story && entry.footer !== story)) continue

			this.layout.stale.add(entry.index)

			if (first < 0) first = entry.index
		}

		// Pages of the earlier layout a relayout under way may keep: kept stale.
		const resync = this.resyncs

		if (resync !== undefined) {
			for (let k = resync.records.from; k < resync.records.end; k++) {
				const entry = resync.records.at(k)

				if (entry !== undefined && (entry.header === story || entry.footer === story)) resync.stale.add(k)
			}
		}

		return first
	}

	// Whether the page being laid out shows story `story` as its header or footer.
	shows(story: number): boolean {
		return this.pageOpen && (this.headerStory === story || this.footerStory === story)
	}

	private resyncs: Resync | undefined = undefined
	// Set while a relayout lays out again in place (it ends before the run yields: see detach).
	private inPlace: InPlace | undefined = undefined
	// The engine's parity reads when the page being laid out opened.
	private parityAtOpen = 0
	// The page being laid out depends on its parity beyond what parity reads count.
	private pageParity = false
	// The keep of the page being laid out (see PageRecord).
	private pageKeep = 0

	// The page to lay out again from for an edit to what page `index` shows (see DocumentLayout.keepFrom).
	keepFrom(index: number): number {
		return index - (this.records[index]?.keep ?? 0)
	}

	// For edits to paragraphs in table cells alone (every dirty block has cells), a later page to restart at
	// than `page` (the first page showing a changed table, or the one before): the last page opening in the
	// table before the first row holding a changed paragraph, or the one before the first page that row opens
	// (it may now fit there). Rows before it lay out as they did. Undefined otherwise.
	cellsRestart(page: number, dirty: readonly DirtyBlock[]): number | undefined {
		const anchors = this.layout.anchors
		let best = Infinity

		if (dirty.length === 0) return undefined

		for (const block of dirty) {
			const cells = block.cells
			const part = this.engine.model.parts[refPart(block.ref)]
			const item = refItem(block.ref)

			if (cells === undefined || cells.length === 0 || part === undefined) return undefined

			const rows = laidRows(this.engine, part, item)
			let first = Infinity

			for (const cell of cells) {
				const row = rows.indexOf(refPart(cell), refItem(cell))

				if (row >= 0) first = Math.min(first, row)
			}

			// Nothing of it shows.
			if (first === Infinity) continue

			// The last page opening at a row before it, or the page before the first opening in it (a row split
			// over pages opens each of them after the first).
			let at = -1
			let inTable = false
			let headers = -1

			for (let index = Math.max(0, page); index < anchors.length; index++) {
				const anchor = anchors[index]
				const inside = anchor !== undefined && anchor.part === part.index && anchor.block === item && anchor.row >= 0

				if (!inside) {
					if (inTable) break

					continue
				}

				inTable = true
				headers = this.snapshots[index]?.flow.table?.headerRows ?? headers

				if (anchor.row >= first) {
					if (anchor.row === first) at = index - 1

					break
				}

				at = index
			}

			if (at < 0 || headers < 0 || first < headers) return undefined

			best = Math.min(best, at, this.keepFrom(at))
		}

		return best === Infinity ? undefined : Math.max(page, best)
	}

	// The first page closed while fonts it may have used were loading (-1: none).
	missedFonts = -1
	// The open page's header or footer needed a font still loading.
	private pageMissedFonts = false

	// The layout as it stands, from `page` on, for a relayout to meet again: the pages laid out so far and,
	// while an earlier relayout is still under way, the earlier layout's pages from the one starting where
	// that run stands (none to meet again when no such page is found: the run then lays out to the end).
	// Not `own`: none of the pages laid out so far (the earlier layout's met now included) are met again.
	private previousLayout(
		page: number,
		own: boolean,
		dirty: readonly DirtyBlock[],
		breaks: number,
		least: number,
		through: number
	): Resync | undefined {
		const layout = this.layout
		let previous = this.resyncs
		let deliver = false

		// A run standing between pages first meets the earlier layout there if its next step would; one that
		// laid out to the end has nothing of it left. Either way the layout is whole again. Pages it keeps now
		// are not taken in before the next run starts: they go out when that run keeps them.
		if (previous !== undefined && !this.finished && !this.pageOpen && this.sectionIndex >= 0) {
			this.takeSnapshot()
			deliver = this.resynchronise(previous)
		}

		if (this.finished) previous = undefined

		const progress = layout.pages.length
		// Meeting the earlier layout above may have added its pages: read after it.
		const floor = own ? page : progress

		if (previous === undefined) {
			if (floor >= progress) return undefined

			// Laid out again in place: nothing is copied; what the run writes over is kept aside (Tail).
			const inPlace: InPlace = {
				pages: new Tail(layout.pages, page, progress, page),
				anchors: new Tail(layout.anchors, page, progress, page),
				firstLines: new Tail(layout.pageFirstLines, page, progress, page),
				snapshots: new Tail(this.snapshots, page, progress, page),
				bodyTotals: new Tail(this.bodyTotals, page, progress, Math.min(this.bodyTotals.length, page)),
				records: new Tail(this.records, page, progress, Math.min(this.records.length, page)),
				bodyNumbers: new Tail(this.bodyNumbers, page, progress, Math.min(this.bodyNumbers.length, page)),
				breaks: new Tail(layout.renderedBreaks, breaks, layout.renderedBreaks.length, breaks)
			}

			this.inPlace = inPlace

			return {
				from: page,
				floor: Math.max(page, least),
				through,
				deliver,
				pages: inPlace.pages,
				anchors: inPlace.anchors,
				firstLines: inPlace.firstLines,
				snapshots: inPlace.snapshots,
				bodyTotals: inPlace.bodyTotals,
				records: inPlace.records,
				bodyNumbers: inPlace.bodyNumbers,
				renderedBreaks: inPlace.breaks,
				stale: within(layout.stale, page, progress),
				redone: within(layout.dirty, page, progress),
				sectionPageCounts: this.sectionPageCounts.slice(),
				globalLine: this.globalLine,
				dirty,
				dirtyIndices: new Map(),
				byAnchor: undefined,
				bodyCounts: this.firstBodyCounts() >= 0
			}
		}

		// The earlier layout's pages continue the run's only from the page beginning where the run stands, and
		// the run did not meet them there: they are met again as they are, as pages from `progress` on. The run's
		// own pages are not (what follows them is not the earlier layout).
		const anchor = this.pageOpen ? this.anchor : this.anchorHere()
		const anchors = previous.anchors.values()
		const cut = anchor.block < 0 ? -1 : anchors.findIndex(old => sameAnchor(old, anchor))

		if (cut < 0) return undefined

		const first = previous.from + cut
		const kept: RenderedBreak[] = []
		const marks = (earlier: ReadonlySet<number>): Set<number> => {
			const set = new Set<number>()

			for (const index of earlier) if (index >= first) set.add(index - first + progress)

			return set
		}

		for (const entry of previous.renderedBreaks.values())
			if (entry.page >= first) kept.push({ ...entry, page: entry.page - first + progress })

		return {
			from: progress,
			floor: Math.max(floor, least),
			// Both in the earlier layout's indices, moved as its pages are.
			through: Math.max(previous.through, through) < first ? -1 : Math.max(previous.through, through) - first + progress,
			// Shown at other indices, or behind the run's pages.
			deliver: true,
			pages: Tail.copied(previous.pages.values().slice(cut), progress),
			anchors: Tail.copied(anchors.slice(cut), progress),
			firstLines: Tail.copied(previous.firstLines.values().slice(cut), progress),
			snapshots: Tail.copied(previous.snapshots.values().slice(cut), progress),
			bodyTotals: Tail.copied(previous.bodyTotals.values().slice(cut), progress),
			records: Tail.copied(previous.records.values().slice(cut), progress),
			bodyNumbers: Tail.copied(previous.bodyNumbers.values().slice(cut), progress),
			renderedBreaks: Tail.copied(kept, 0),
			stale: marks(previous.stale),
			redone: marks(previous.redone),
			sectionPageCounts: previous.sectionPageCounts.slice(),
			globalLine: previous.globalLine,
			dirty: previous.dirty.concat(dirty),
			dirtyIndices: new Map(),
			byAnchor: undefined,
			bodyCounts: previous.bodyCounts || this.firstBodyCounts() >= 0
		}
	}

	// Pages laid out so far in the current run (a relayout under way reaches no further).
	get progress(): number {
		return this.inPlace?.pages.top ?? this.layout.pages.length
	}

	// Rendered breaks found so far in the current run.
	private get breakCount(): number {
		return this.inPlace?.breaks.top ?? this.layout.renderedBreaks.length
	}

	// Writes entry `index` of one of the arrays a run fills page by page (pushing at the end); laying out
	// again in place, the previous layout's entry there is kept aside first.
	private put<T>(array: T[], tail: Tail<T> | undefined, index: number, value: T): void {
		if (tail !== undefined) {
			tail.keep(index)
			tail.top = Math.max(tail.top, index + 1)
		}

		array[index] = value
	}

	// Ends laying out again in place (before the run yields, restarts or reaches the end without meeting the
	// previous layout): the previous layout's entries still needed are copied aside and the arrays cut where
	// the run stands, as a run that copied them from the start has them.
	detach(): void {
		const inPlace = this.inPlace
		const resync = this.resyncs

		if (inPlace === undefined) return

		this.inPlace = undefined

		if (resync !== undefined) {
			this.resyncs = {
				...resync,
				pages: Tail.copied(inPlace.pages.values(), resync.from),
				anchors: Tail.copied(inPlace.anchors.values(), resync.from),
				firstLines: Tail.copied(inPlace.firstLines.values(), resync.from),
				snapshots: Tail.copied(inPlace.snapshots.values(), resync.from),
				bodyTotals: Tail.copied(inPlace.bodyTotals.values(), resync.from),
				records: Tail.copied(inPlace.records.values(), resync.from),
				bodyNumbers: Tail.copied(inPlace.bodyNumbers.values(), resync.from),
				renderedBreaks: Tail.copied(inPlace.breaks.values(), inPlace.breaks.from)
			}
		}

		for (const tail of [
			inPlace.pages,
			inPlace.anchors,
			inPlace.firstLines,
			inPlace.snapshots,
			inPlace.bodyTotals,
			inPlace.records,
			inPlace.bodyNumbers,
			inPlace.breaks
		] as Tail<unknown>[])
			tail.live.length = tail.top
	}

	// Whether a relayout for edits is still under way and may meet the previous layout again.
	get resyncing(): boolean {
		return this.resyncs !== undefined
	}

	// At a page about to open while laying out again for edits: when the flow has laid out every dirty block
	// and stands where a page of the previous layout started, in the same state, the rest of the previous
	// layout is kept from there (moved and renumbered when pages were added or removed before it).
	private resynchronise(resync: Resync): boolean {
		const index = this.progress
		const snapshot = this.snapshots[index]
		const flow = this.flows[this.flowIndex]

		if (index <= resync.floor || snapshot === undefined || flow === undefined || !this.dirtyDone(resync, flow)) return false

		const anchor = this.anchorHere()
		const old = this.matchingPage(resync, anchor, index)

		if (old <= resync.through) return false

		const oldSnapshot = resync.snapshots.at(old)

		if (oldSnapshot === undefined || !sameState(snapshot, oldSnapshot)) return false

		// The page count changes and the body shows it: laid out to the end, where the counts settle.
		if (index !== old && resync.bodyCounts) return false

		// Pages placing things by whether they are odd or even cannot move to the other parity.
		const shift = snapshot.restart === undefined ? snapshot.pageNumber - oldSnapshot.pageNumber : 0

		if (shift % 2 !== 0) {
			for (let k = old; k < resync.records.end; k++) if (resync.records.at(k)?.parity === true) return false
		}

		this.keepTail(resync, old, index, snapshot, oldSnapshot, anchor)

		return true
	}

	// Whether every dirty block lies behind the body flow.
	private dirtyDone(resync: Resync, flow: BlockFlow): boolean {
		const section = this.sectionIndex

		for (const block of resync.dirty) {
			if (block.section > section) return false
			if (block.section < section) continue

			let at = resync.dirtyIndices.get(block.ref)

			if (at === undefined) {
				at = -1

				for (let k = 0; k < flow.count; k++) {
					if (flow.refAt(k) === block.ref) {
						at = k

						break
					}
				}

				resync.dirtyIndices.set(block.ref, at)
			}

			if (at > flow.index || (at === flow.index && !rowsBehind(block, flow))) return false
		}

		return true
	}

	// The page of the previous layout that starts where `anchor` stands, or -1.
	private matchingPage(resync: Resync, anchor: PageAnchor, index: number): number {
		// Most edits leave the page count as it was: the same page index first.
		const candidate = resync.anchors.at(index)

		if (candidate !== undefined && sameAnchor(candidate, anchor)) return index

		if (resync.byAnchor === undefined) {
			const byAnchor = new Map<string, number>()

			for (let k = resync.anchors.from; k < resync.anchors.end; k++) {
				const old = resync.anchors.at(k)
				const key = old === undefined ? undefined : anchorKey(old)

				if (key !== undefined && !byAnchor.has(key)) byAnchor.set(key, k)
			}

			resync.byAnchor = byAnchor
		}

		return resync.byAnchor.get(anchorKey(anchor)) ?? -1
	}

	// Keeps the previous layout's pages from `old` on as pages from `index` on.
	private keepTail(
		resync: Resync,
		old: number,
		index: number,
		snapshot: PageSnapshot,
		oldSnapshot: PageSnapshot,
		anchor: PageAnchor
	): void {
		const layout = this.layout
		const inPlace = this.inPlace
		const shift = index - old
		// A section numbering its pages anew from this page on: its numbers are as they were.
		const numberShift = snapshot.restart === undefined ? snapshot.pageNumber - oldSnapshot.pageNumber : 0
		const lineShift = this.globalLine - oldSnapshot.globalLine
		const blockShift = (anchor.index ?? 0) - (resync.anchors.at(old)?.index ?? 0)
		const breakShift = this.breakCount - oldSnapshot.renderedBreaks
		const section = this.sectionIndex
		const stale = shift !== 0 || numberShift !== 0
		const count = resync.pages.end - old
		// Page numbers move in this section and the later ones up to the first that numbers its pages anew.
		const renumbered =
			numberShift === 0 ? section + 1 : this.numberedFrom(section, resync.pages.at(resync.pages.end - 1)?.section ?? section)

		// Laid out again in place: the kept entries are moved to where they now go (nothing moves when the pages
		// before them kept their count).
		if (inPlace !== undefined) {
			inPlace.pages.place(old, index)
			inPlace.anchors.place(old, index)
			inPlace.firstLines.place(old, index)
			inPlace.snapshots.place(old, index)
			inPlace.bodyTotals.place(old, index)
			inPlace.records.place(old, index)
			inPlace.bodyNumbers.place(old, index)
		}

		// The previous layout's entry of kept page `k` (0: page `old`), wherever it is now.
		const kept = <T>(tail: Tail<T>, k: number): T | undefined => (inPlace === undefined ? tail.at(old + k) : tail.live[index + k])
		let countsMoved = false

		for (let s = 0; s <= section && !countsMoved; s++) countsMoved = snapshot.sectionPageCounts[s] !== oldSnapshot.sectionPageCounts[s]

		if (inPlace !== undefined && !stale && lineShift === 0 && blockShift === 0 && breakShift === 0 && !countsMoved) {
			// Every kept entry is as it was, where it was: only the pages still to refresh or deliver are marked.
			for (const page of resync.redone) if (page >= old) layout.dirty.add(page)
			for (const page of resync.stale) if (page >= old) layout.stale.add(page)
		} else {
			for (let k = 0; k < count; k++) {
				const page = kept(resync.pages, k)
				const at = index + k

				if (page === undefined) continue

				const record = kept(resync.records, k)
				const number = page.section < renumbered ? page.number + numberShift : page.number
				const moved =
					page.index === at && number === page.number
						? page
						: page.moved(
								at,
								number,
								pageNumberText(number, record?.values.pageFormat ?? this.formatOf(page.section), record?.values.chapter)
							)
				const oldAnchor = kept(resync.anchors, k)
				const keptSnapshot = kept(resync.snapshots, k)

				layout.pages[at] = moved
				layout.anchors[at] =
					oldAnchor === undefined || oldAnchor.section !== section || blockShift === 0
						? (oldAnchor ?? anchor)
						: { ...oldAnchor, index: oldAnchor.index + blockShift }
				layout.pageFirstLines[at] = (kept(resync.firstLines, k) ?? 0) + lineShift
				this.snapshots[at] =
					keptSnapshot === undefined
						? undefined
						: rebased(keptSnapshot, section, renumbered, numberShift, lineShift, blockShift, breakShift, snapshot, oldSnapshot)
				this.bodyTotals[at] = kept(resync.bodyTotals, k)
				this.records[at] =
					record === undefined ||
					(record.index === at &&
						record.info.index === at &&
						record.info.number === number &&
						record.info.numberText === moved.numberText)
						? record
						: { ...record, index: at, info: { ...record.info, index: at, number, numberText: moved.numberText } }
				this.bodyNumbers[at] = kept(resync.bodyNumbers, k) ?? false

				if (resync.redone.has(old + k)) layout.dirty.add(at)

				if (
					resync.stale.has(old + k) ||
					(stale && (record?.numbers === true || record?.totals === true || this.bodyNumbers[at] === true))
				)
					layout.stale.add(at)
			}
		}

		const breaks = inPlace?.breaks

		// In place, the kept pages' breaks follow the run's where they were, unchanged, when nothing moved.
		if (breaks === undefined || shift !== 0 || lineShift !== 0 || breakShift !== 0) {
			const moved: RenderedBreak[] = []

			for (let k = resync.renderedBreaks.from; k < resync.renderedBreaks.end; k++) {
				const entry = resync.renderedBreaks.at(k)

				if (entry !== undefined && entry.page >= old)
					moved.push({ ...entry, page: entry.page + shift, line: entry.line + lineShift })
			}

			layout.renderedBreaks.length = this.breakCount

			for (const entry of moved) layout.renderedBreaks.push(entry)
		}

		this.inPlace = undefined

		// Section page counts: this section's grew by the pages laid out, the later ones are as they were.
		for (let s = section; s < resync.sectionPageCounts.length; s++) {
			const before = oldSnapshot.sectionPageCounts[s] ?? 0
			const now = snapshot.sectionPageCounts[s] ?? 0

			this.sectionPageCounts[s] = (resync.sectionPageCounts[s] ?? 0) + (s === section ? now - before : 0)
		}

		this.globalLine = resync.globalLine + lineShift
		this.resyncs = undefined
		this.finished = true
		this.resyncedAt = index

		if (stale || resync.deliver) layout.notify(index, layout.pages.length, false)
	}

	// The first section after `section`, up to `last`, whose page numbering starts anew (last + 1 when none).
	private numberedFrom(section: number, last: number): number {
		for (let index = section + 1; index <= last; index++) if (this.resolved(index).pageNumbering.start !== undefined) return index

		return last + 1
	}

	// Where the last relayout met the previous layout again (-1 when it ran to the end).
	resyncedAt = -1

	private formatOf(section: number): string | undefined {
		const info = this.model.sections[section]
		const sectPr = info?.sectPr ?? -1
		const body = this.body

		return body === undefined || sectPr < 0
			? undefined
			: this.engine.resolver.section(this.engine.store.section(info?.document ?? body.document, sectPr)).pageNumbering.format
	}
}

// Previous-layout state a relayout for edits compares new pages with (see resynchronise).
interface Resync {
	// The index of its first page as numbered here, and the page the run restarted at (it meets none at or
	// before it).
	readonly from: number
	readonly floor: number
	// Its pages up to this index are not kept: they show a note an edit changed (the page starting alike).
	readonly through: number
	// Its pages go out again when kept: they may not be the pages shown at their indices.
	readonly deliver: boolean
	readonly pages: Tail<PageDisplayList>
	readonly anchors: Tail<PageAnchor>
	readonly firstLines: Tail<number>
	readonly snapshots: Tail<PageSnapshot | undefined>
	readonly bodyTotals: Tail<PageValues | undefined>
	readonly records: Tail<PageRecord | undefined>
	readonly bodyNumbers: Tail<boolean>
	readonly renderedBreaks: Tail<RenderedBreak>
	// Pages (by index, as numbered here) still to refresh (DocumentLayout.stale) or to deliver again
	// (DocumentLayout.dirty).
	readonly stale: Set<number>
	readonly redone: ReadonlySet<number>
	readonly sectionPageCounts: readonly number[]
	readonly globalLine: number
	readonly dirty: readonly DirtyBlock[]
	// Index of each dirty block in its section's flow (-1 when absent), found once.
	readonly dirtyIndices: Map<number, number>
	byAnchor: Map<string, number> | undefined
	// A page's body shows page counts (see resynchronise).
	readonly bodyCounts: boolean
}

// The previous layout's entries of one array from index `from` to `end`, for a relayout to meet again. Laying
// out again in place (see InPlace), they stay in the array (`live`) until the run writes over them: each is kept
// aside first (`saved`, in order; writes come in index order), so a keystroke that lays out a page or two copies
// a page or two, not the document. A copied tail holds every entry aside.
class Tail<T> {
	readonly live: T[]
	readonly from: number
	readonly end: number
	readonly saved: T[]
	// The array's length as the run has it so far (laid out again in place, `live` keeps the rest meanwhile).
	top: number

	constructor(live: T[], from: number, end: number, top: number, saved: T[] = []) {
		this.live = live
		this.from = from
		this.end = end
		this.top = top
		this.saved = saved
	}

	static copied<T>(values: T[], from: number): Tail<T> {
		return new Tail<T>([], from, from + values.length, from + values.length, values)
	}

	// The previous layout's entry at `index` (from <= index < end).
	at(index: number): T | undefined {
		if (index < this.from || index >= this.end) return undefined

		return index < this.from + this.saved.length ? this.saved[index - this.from] : this.live[index]
	}

	// Before the run writes `index` of `live`: the previous entries up to it are kept aside.
	keep(index: number): void {
		const live = this.live

		while (this.from + this.saved.length <= index && this.from + this.saved.length < this.end)
			this.saved.push(live[this.from + this.saved.length] as T)
	}

	// Every entry from `from` on, as an array.
	values(): T[] {
		const out = this.saved.slice()

		for (let index = this.from + this.saved.length; index < this.end; index++) out.push(this.live[index] as T)

		return out
	}

	// Moves entries [old, end) of `live` to start at `index` (the run met the previous layout there): those
	// still in place by memmove, those written over from `saved`; `live` then ends after them.
	place(old: number, index: number): void {
		const live = this.live
		const end = this.end
		const shift = index - old
		const start = Math.max(old, Math.min(end, this.from + this.saved.length))

		if (shift !== 0 && start < end) {
			if (live.length < end + shift) live.length = end + shift

			live.copyWithin(start + shift, start, end)
		}

		for (let k = old; k < start; k++) live[k + shift] = this.saved[k - this.from] as T

		live.length = index + end - old
	}
}

// A relayout laying out again in place: the tails of the arrays it fills (see Tail).
interface InPlace {
	readonly pages: Tail<PageDisplayList>
	readonly anchors: Tail<PageAnchor>
	readonly firstLines: Tail<number>
	readonly snapshots: Tail<PageSnapshot | undefined>
	readonly bodyTotals: Tail<PageValues | undefined>
	readonly records: Tail<PageRecord | undefined>
	readonly bodyNumbers: Tail<boolean>
	readonly breaks: Tail<RenderedBreak>
}

// A dirty table the body flow stands in, between two rows: whether every row its changed paragraphs are in
// is behind it.
function rowsBehind(block: DirtyBlock, flow: BlockFlow): boolean {
	const cells = block.cells

	if (cells === undefined || cells.length === 0 || block.moved === true) return false

	for (const cell of cells) {
		const at = flow.tableRow(refPart(cell), refItem(cell))

		if (at === undefined) return false
		// In a row not laid out (hidden in the view): nothing of it shows.
		if (at.row < 0) continue
		if (at.row < at.headers || at.row >= at.current) return false
	}

	return true
}

// The members of `set` in [start, end).
function within(set: ReadonlySet<number>, start: number, end: number): Set<number> {
	const result = new Set<number>()

	for (const index of set) if (index >= start && index < end) result.add(index)

	return result
}

function usesFlag(output: PageOutput, flag: number): boolean {
	for (let s = 0; s < output.sourceCount; s++) if ((output.sourceFlags(s) & flag) !== 0) return true

	return false
}

// The column nearest page x (a line's middle).
function columnAt(geometry: PageGeometry, x: number): number {
	const columns = geometry.columnX.length
	let best = 0
	let nearest = Infinity

	if (columns < 2) return 0

	for (let c = 0; c < columns; c++) {
		const left = geometry.left + (geometry.columnX[c] ?? 0)
		const distance = Math.max(left - x, x - left - (geometry.columnWidths[c] ?? 0), 0)

		if (distance < nearest) {
			nearest = distance
			best = c
		}
	}

	return best
}

function anchorKey(anchor: PageAnchor): string {
	return `${anchor.section}:${anchor.story}:${anchor.part}:${anchor.block}:${anchor.row}:${anchor.offset}`
}

// A section's line numbers as shown: none for w:countBy 0, as Word (LibreOffice bug 131594); the attribute left
// out counts every line.
function shownLineNumbers(numbering: ResolvedSectionProps["lineNumbering"]): ResolvedSectionProps["lineNumbering"] {
	return numbering?.countBy !== undefined && numbering.countBy <= 0 ? undefined : numbering
}

// Whether mirrored margins give the section's pages of one parity other margins than the other's.
function mirrored(section: ResolvedSectionProps, compat: LayoutCompat): boolean {
	const margins = section.margins

	return compat.mirrorMargins && (margins.left !== margins.right || (margins.gutter > 0 && !compat.gutterAtTop && !section.rtlGutter))
}

function sameAnchor(a: PageAnchor, b: PageAnchor): boolean {
	return (
		a.section === b.section &&
		a.story === b.story &&
		a.part === b.part &&
		a.block === b.block &&
		a.row === b.row &&
		a.offset === b.offset
	)
}

function sameValues(a: PageValues | undefined, b: PageValues | undefined, pageShift: number): boolean {
	if (a === undefined || b === undefined) return a === b

	return (
		a.page === b.page + pageShift &&
		a.pageFormat === b.pageFormat &&
		a.chapter === b.chapter &&
		a.numPages === b.numPages &&
		a.sectionPages === b.sectionPages
	)
}

const NO_ENTRIES: readonly (readonly [number, never])[] = []
const NO_CHAPTERS: readonly (string | undefined)[] = []

function sameChapters(a: readonly (string | undefined)[], b: readonly (string | undefined)[]): boolean {
	if (a === b) return true

	for (let k = 0; k < 9; k++) if (a[k] !== b[k]) return false

	return true
}
const NO_NOTES: readonly PlacedNote[] = []

function sameList(a: readonly number[], b: readonly number[]): boolean {
	if (a.length !== b.length) return false

	for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false

	return true
}

function sameMarker(a: ListMarker | null | undefined, b: ListMarker | null | undefined): boolean {
	if (a === undefined || a === null || b === undefined || b === null) return a === b

	return a.numId === b.numId && a.ilvl === b.ilvl && a.value === b.value && a.text === b.text && a.level === b.level
}

function sameCounters(a: CounterSnapshot | undefined, b: CounterSnapshot | undefined): boolean {
	if (a === undefined || b === undefined) return a === b
	if (a.sets.size !== b.sets.size || a.overridesApplied.size !== b.overridesApplied.size) return false

	for (const [id, set] of a.sets) {
		const other = b.sets.get(id)

		if (other === undefined || set.values.length !== other.values.length) return false

		for (let k = 0; k < set.values.length; k++) if (set.values[k] !== other.values[k] || set.active[k] !== other.active[k]) return false
	}

	for (const [id, applied] of a.overridesApplied) if (b.overridesApplied.get(id) !== applied) return false

	return true
}

function sameNotes(a: NoteNumberingSnapshot, b: NoteNumberingSnapshot): boolean {
	const same = (x: NoteNumberingSnapshot["footnotes"], y: NoteNumberingSnapshot["footnotes"]): boolean =>
		x.format === y.format && x.start === y.start && x.restart === y.restart && x.position === y.position

	return (
		a.footnoteNext === b.footnoteNext &&
		a.endnoteNext === b.endnoteNext &&
		same(a.footnotes, b.footnotes) &&
		same(a.endnotes, b.endnotes)
	)
}

function sameEntries<T>(
	a: readonly (readonly [number, T])[],
	b: readonly (readonly [number, T])[],
	same: (x: T, y: T) => boolean
): boolean {
	if (a.length !== b.length) return false

	const map = new Map(b)

	for (const [key, value] of a) {
		if (!map.has(key)) return false

		const other = map.get(key) as T

		if (!same(value, other)) return false
	}

	return true
}

// Two flows' states alike, but for the block index (the page's anchor compares where the body flow stands).
function sameFlow(fa: FlowSnapshot, fb: FlowSnapshot, pageShift: number): boolean {
	return (
		fa.inParagraph === fb.inParagraph &&
		fa.item === fb.item &&
		fa.offset === fb.offset &&
		fa.rows === fb.rows &&
		fa.pendingMark === fb.pendingMark &&
		fa.hyphens === fb.hyphens &&
		fa.after === fb.after &&
		fa.contextual === fb.contextual &&
		fa.styleId === fb.styleId &&
		fa.hasPrevious === fb.hasPrevious &&
		fa.breakBeforeDone === fb.breakBeforeDone &&
		fa.noRoom === fb.noRoom &&
		fa.chained === fb.chained &&
		fa.moves.length === fb.moves.length &&
		fa.moves.every((value, k) => value === fb.moves[k]) &&
		sameValues(fa.values, fb.values, pageShift) &&
		sameMarker(fa.marker, fb.marker) &&
		sameTable(fa.table, fb.table, pageShift)
	)
}

// The cells' flows of a split row compare as flows in full (their block index too).
function sameCell(a: FlowSnapshot | null | undefined, b: FlowSnapshot | null | undefined, pageShift: number): boolean {
	if (a === null || a === undefined || b === null || b === undefined) return a === b

	return a.index === b.index && sameFlow(a, b, pageShift)
}

function sameTable(a: TableSnapshot | undefined, b: TableSnapshot | undefined, pageShift: number): boolean {
	if (a === undefined || b === undefined) return a === b

	const cells = a.cells
	const others = b.cells

	return (
		(cells === undefined || others === undefined
			? cells === others
			: cells.length === others.length && cells.every((cell, k) => sameCell(cell, others[k], pageShift))) &&
		a.row === b.row &&
		a.headerRows === b.headerRows &&
		(a.placed ? 0 : a.stalled + 1) === (b.placed ? 0 : b.stalled + 1) &&
		a.repeated === b.repeated &&
		a.left === b.left &&
		a.width === b.width &&
		sameNumbers(a.grid, b.grid) &&
		sameNumbers(a.gridX, b.gridX)
	)
}

// Whether a page opening now continues exactly as a page of the previous layout did (its anchor matched):
// everything later pages depend on is the same, the page number apart.
function sameState(a: PageSnapshot, b: PageSnapshot): boolean {
	const pageShift = a.pageNumber - b.pageNumber

	return (
		a.sectionIndex === b.sectionIndex &&
		a.restart === b.restart &&
		a.sectionFirstPage === b.sectionFirstPage &&
		a.nextStart === b.nextStart &&
		a.bodyLines === b.bodyLines &&
		a.lineSection === b.lineSection &&
		a.endnotesDone === b.endnotesDone &&
		sameFlow(a.flow, b.flow, pageShift) &&
		sameCounters(a.counters, b.counters) &&
		sameNotes(a.notes, b.notes) &&
		a.carried.length === b.carried.length &&
		a.carried.every(
			(note, k) =>
				note.story === b.carried[k]?.story &&
				note.from === b.carried[k]?.from &&
				note.height === b.carried[k]?.height &&
				note.mark === b.carried[k]?.mark &&
				sameValues(note.values, b.carried[k]?.values, pageShift)
		) &&
		a.endnotes.length === b.endnotes.length &&
		a.endnotes.every((story, k) => story === b.endnotes[k]) &&
		sameEntries(a.markers, b.markers, sameMarker) &&
		sameEntries(a.assigned, b.assigned, (x, y) => x === y) &&
		sameChapters(a.chapters, b.chapters)
	)
}

// A snapshot of a kept page, moved to where the page now is (the same snapshot when nothing moved).
function rebased(
	kept: PageSnapshot,
	section: number,
	renumbered: number,
	numberShift: number,
	lineShift: number,
	blockShift: number,
	breakShift: number,
	now: PageSnapshot,
	then: PageSnapshot
): PageSnapshot {
	const keptCounts = kept.sectionPageCounts
	let counts: number[] | undefined

	for (let s = 0; s < keptCounts.length && s <= section; s++) {
		const count =
			s < section
				? (now.sectionPageCounts[s] ?? 0)
				: (keptCounts[s] ?? 0) + (now.sectionPageCounts[s] ?? 0) - (then.sectionPageCounts[s] ?? 0)

		if (count === keptCounts[s]) continue

		counts ??= keptCounts.slice()
		counts[s] = count
	}

	const same = kept.sectionIndex === section
	const shifted = numberShift !== 0 && kept.sectionIndex < renumbered
	const values = kept.flow.values
	const flow =
		(same && blockShift !== 0) || (shifted && values !== undefined)
			? {
					...kept.flow,
					index: same ? kept.flow.index + blockShift : kept.flow.index,
					values: shifted && values !== undefined ? { ...values, page: values.page + numberShift } : values
				}
			: kept.flow

	// Notes continued onto the page show the page numbers they were laid out with, moved likewise.
	const carried =
		shifted && kept.carried.some(note => note.values !== undefined)
			? kept.carried.map(note =>
					note.values === undefined ? note : { ...note, values: { ...note.values, page: note.values.page + numberShift } }
				)
			: kept.carried

	if (counts === undefined && !shifted && lineShift === 0 && breakShift === 0 && flow === kept.flow) return kept

	return {
		...kept,
		pageNumber: shifted ? kept.pageNumber + numberShift : kept.pageNumber,
		globalLine: kept.globalLine + lineShift,
		renderedBreaks: kept.renderedBreaks + breakShift,
		sectionPageCounts: counts ?? keptCounts,
		carried,
		flow
	}
}

const LINE_NUMBER_RUN = { styleId: "LineNumber" }

// Halvings of the column bottom when balancing columns (to under a pixel on any page).
const BALANCE_STEPS = 12

// Layouts again for section vertical alignment around obstacles that stay (to under a pixel of a full page
// when bisecting), and how close it gets.
const ALIGN_ROUNDS = 12
const ALIGN_TOLERANCE = 0.5

// The section aligns its pages' text vertically (w:vAlign; "both" is laid out as top).
function aligned(section: ResolvedSectionProps): boolean {
	return section.vAlign === "center" || section.vAlign === "bottom"
}

// Two flow states stand at the same place (outside tables).
function sameEnd(a: FlowSnapshot | undefined, b: FlowSnapshot): boolean {
	return (
		a !== undefined &&
		a.index === b.index &&
		a.inParagraph === b.inParagraph &&
		a.item === b.item &&
		a.offset === b.offset &&
		a.rows === b.rows
	)
}

// Where a section's part of a page began, to lay it out again.
interface BalanceStart {
	readonly body: BlockFlow
	readonly flow: FlowSnapshot
	readonly mark: OutputMark
	readonly notes: FootnoteState
	readonly exclusions: number
	readonly endnotes: number
	readonly empty: boolean
	readonly start: AreaStart
}

// Layouts again for page count fields in the text, at most.
const MAX_TOTALS_ROUNDS = 3
// What laying out the pages in view may take past an edit's budget (a frame, with the budget).
const THROUGH_MS = 12
// How often a merge held off by a save looks again.
const MERGE_POLL_MS = 250

// Steps a document's paginator: synchronously within a time budget (editing lays out the pages in view in
// the keystroke's task), or in slices from layoutDocument's loop.
export class LayoutDriver {
	private paginator: Paginator
	private readonly layout: DocumentLayout
	private readonly styles: RunStyles
	private readonly now: () => number
	private rounds = 0
	// A run begin() started (an edit's, a view's): page counts in the body are derived as a fresh layout
	// derives them.
	private edited = false
	// The run derived page counts in the body afresh (see advance), from page `from` on.
	private fresh = false
	private from = 0
	// The run lays out again for edits: page count fields of earlier pages are refreshed when shown.
	private lazy = false
	// The run lays out again what a merge of overlays moved (see LayoutEdits.compact); one is due once the
	// slices' loop runs. Merges wait for input (an edit's run) and saves (LayoutEdits.compactHeld) to have been
	// idle for LayoutEdits.compactWait.
	private compacting = false
	private wantCompact = false
	private mergeTimer: unknown = undefined
	private editedSinceMerge = false
	private catchUp = false
	// A paginator switched to (another view or field codes) scans its stories first, in slices, from this story
	// (-1: done; see Paginator.scanStories).
	private scanFrom = -1
	// Starts the slice loop when it is not running (set by layoutDocument).
	continue: () => Promise<void> = () => Promise.resolve()

	constructor(paginator: Paginator, layout: DocumentLayout, styles: RunStyles, now: () => number) {
		this.paginator = paginator
		this.layout = layout
		this.styles = styles
		this.now = now
	}

	// Restarts at the nearest page layout can restart at, at or before `page` (no later than where a run
	// under way stands); with `dirty`, the run may stop where it meets the previous layout again.
	begin(page: number, dirty: readonly DirtyBlock[] | undefined, through = -1): number {
		const paginator = this.paginator

		// Input: a merge due waits for it to be idle again.
		this.dropMerge()
		this.wantCompact = false
		this.editedSinceMerge = true
		const layout = this.layout
		// A layout still under way without an earlier edit run cannot stop early: it has pages left to lay out.
		const resync = dirty !== undefined && (layout.final || paginator.resyncing)
		// Rows before the changed ones lay out as they did, under way or not (the pages a run under way laid out
		// are the edited document's up to its edit's rows, those behind it the document's before).
		const cells = dirty !== undefined ? paginator.cellsRestart(page, dirty) : undefined
		const asked = cells ?? page
		const target = layout.final ? asked : Math.min(asked, paginator.progress)
		const from = paginator.restartPage(target, dirty !== undefined)

		this.rounds = 0
		this.lazy = dirty !== undefined
		this.edited = true
		this.fresh = false
		this.from = from
		paginator.restartAt(from, resync ? dirty : undefined, true, target, through)
		layout.notify(from, from, false)

		return from
	}

	advance(deadline: number, through: number): AdvanceResult {
		try {
			return this.steps(deadline, through)
		} finally {
			this.paginator.yieldAt(Infinity, this.now)
		}
	}

	private steps(deadline: number, through: number): AdvanceResult {
		const paginator = this.paginator
		const layout = this.layout

		if (this.scanFrom >= 0) {
			this.scanFrom = paginator.scanStories(this.scanFrom, deadline, this.now)

			if (this.scanFrom >= 0) return "more"
			if (this.styles.hasMissing) return "fonts"
		}

		if (layout.final) {
			// Laid out to the end with a merge of overlays due: the slices' loop starts it (after a save holding it
			// off).
			if (through >= 0 || !this.wantCompact) return "done"

			this.wantCompact = false

			if (this.paginator.edits?.compactHeld?.() === true) {
				this.armMerge(MERGE_POLL_MS)

				return "done"
			}

			this.editedSinceMerge = false

			if (!this.compact(deadline)) return "done"
		}

		// An edit's blocks left for the slices: the next of them, a slice after the pages laid out before.
		if (this.catchUp && (through < 0 || through === Infinity)) {
			this.catchUp = false

			// Not all of them yet: the pages show what they did meanwhile.
			if (!this.compact(through === Infinity ? Infinity : deadline) && paginator.edits?.pending?.() === true) {
				this.catchUp = true

				return "more"
			}
		}

		this.redoMissed()

		// Pages up to `through` (those in view) are laid out before returning, for THROUGH_MS past the deadline at
		// most: a run far behind them lays the rest out in slices (the view shows them as they were meanwhile).
		const cap = deadline + THROUGH_MS

		for (;;) {
			const limit = paginator.progress > through ? deadline : cap

			paginator.yieldAt(limit, this.now)

			const step = paginator.step()

			if (step === Step.FINISHED) {
				// Reached the end without meeting the previous layout again: the arrays as the run has them.
				paginator.detach()

				if (this.styles.hasMissing) return "fonts"
				if (this.redoMissed()) continue

				// An edit with page counts in the body: they are derived as a fresh layout derives them, from its
				// estimates, laying out again from the first page showing them (unless this run already did).
				if (this.edited && !this.fresh && !paginator.countsHold()) {
					this.fresh = true

					const first = paginator.firstBodyCounts()

					if (first >= 0 && (paginator.freshEstimates() || first < this.from)) {
						const start = paginator.restartPage(first)

						paginator.restartAt(start)
						layout.notify(start, start, false)

						continue
					}
				}

				// Page count fields in the text showed estimates: laid out again from there with the counts found,
				// a bounded number of times (the counts can change again).
				const from = this.rounds < MAX_TOTALS_ROUNDS ? paginator.totalsMismatch() : -1

				if (from >= 0) {
					this.rounds++
					paginator.adoptTotals()

					const start = paginator.restartPage(from)

					paginator.restartAt(start)
					layout.notify(start, start, false)

					continue
				}

				// A page whose header or footer changed height with the counts found is laid out again with them.
				const moved = paginator.finish(this.lazy)

				if (moved >= 0 && this.rounds < MAX_TOTALS_ROUNDS) {
					this.rounds++
					paginator.adoptTotals()

					const start = paginator.restartPage(moved)

					paginator.restartAt(start)
					layout.notify(start, start, false)

					continue
				}

				// Records a merge or an edit left readable go once no page shows them.
				const merged = this.compacting

				this.compacting = false
				this.releaseRetired()

				// An edit's blocks still to write: not settled. Synchronously to the end, or the slices' loop takes
				// the next of them up a slice later (after this run's pages are delivered).
				if (paginator.edits?.pending?.() === true) {
					if (through === Infinity) {
						// A long table comes a few rows at a time: until they are all laid out again.
						let started = false

						while (!started && paginator.edits.pending()) started = this.compact(Infinity)

						if (started) continue
					} else {
						this.catchUp = true

						return "more"
					}
				}

				// Overlays to merge: a region at a time, its pages laid out again from the merged part (the same
				// text), in the slices' loop once this run's pages are delivered (a slice later), once input has
				// been idle (the next region right away while it still is).
				if (paginator.edits?.compactDue?.() === true) {
					const wait = merged && !this.editedSinceMerge ? 0 : (paginator.edits.compactWait?.() ?? 0)

					if (wait > 0) this.armMerge(wait)
					else this.wantCompact = true
				}

				layout.final = true
				layout.notify(0, layout.pages.length, true)

				if (this.wantCompact && through >= 0) void this.continue()

				return "done"
			}

			// Fonts are loaded as soon as a step needed them, whatever the slicing: a layout that missed fonts
			// outside a suspendable flow then continues the same way however it was sliced. A run yielding leaves
			// the arrays as others read them (laid out again in place, they are cut where it stands).
			if (this.styles.hasMissing) {
				paginator.detach()

				return "fonts"
			}

			if (this.now() >= (paginator.progress > through ? deadline : cap)) {
				paginator.detach()

				return "more"
			}
		}
	}

	prepareFonts(): Promise<void> {
		return this.styles.prepareMissing()
	}

	// A merge of overlays waits for the slices' loop.
	get merging(): boolean {
		return this.wantCompact
	}

	private releaseRetired(): void {
		const edits = this.paginator.edits
		const parts = edits?.retiredParts?.()

		if (parts === undefined || parts.size === 0) return

		const shown = new Set<number>()

		for (const page of this.layout.pages) {
			for (let s = 0; s < page.sourceCount; s++) {
				const part = page.sourceParts[s] ?? -1

				if (parts.has(part)) shown.add(part)
			}
		}

		edits?.compacted?.(shown)
	}

	// A merge due starts in `ms` unless an edit comes first (begin()), later while a save holds it off.
	private armMerge(ms: number): void {
		const set: unknown = Reflect.get(globalThis, "setTimeout")

		this.dropMerge()

		// No timers here: it starts now.
		if (typeof set !== "function") {
			this.wantCompact = true

			return
		}

		this.mergeTimer = (set as (callback: () => void, ms: number) => unknown)(() => {
			this.mergeTimer = undefined

			const edits = this.paginator.edits

			if (!this.layout.final || this.layout.suspended || this.layout.cancelled || edits?.compactDue?.() !== true) return

			if (edits.compactHeld?.() === true) {
				this.armMerge(Math.max(ms, MERGE_POLL_MS))

				return
			}

			this.wantCompact = true
			void this.continue()
		}, ms)
	}

	private dropMerge(): void {
		const clear: unknown = Reflect.get(globalThis, "clearTimeout")

		if (this.mergeTimer === undefined) return
		if (typeof clear === "function") (clear as (handle: unknown) => void)(this.mergeTimer)

		this.mergeTimer = undefined
	}

	// Starts laying out again the pages a merge of overlays moved, from the first page showing them; false when
	// none is due.
	private compact(deadline: number): boolean {
		const paginator = this.paginator
		const layout = this.layout
		const edits = paginator.edits

		if (edits?.compactDue?.() !== true || edits.compact === undefined) return false

		const pages = new Map<number, [number, number]>()

		// Blocks an edit left behind tell their pages otherwise (Compaction.from).
		if (edits.pending?.() !== true)
			layout.pages.forEach((page, index) => {
				for (let s = 0; s < page.sourceCount; s++) {
					const part = page.sourceParts[s] ?? -1
					const range = pages.get(part)

					if (range === undefined) pages.set(part, [index, index])
					else range[1] = index
				}
			})

		const batch = edits.compact(pages, () => this.now() >= deadline)

		if (batch === undefined) return false

		let first = Infinity

		for (const part of batch.parts) first = Math.min(first, pages.get(part)?.[0] ?? Infinity)

		// The last page starting before the first block laid out anew.
		if (batch.from !== undefined) {
			const { section, index } = batch.from

			first = 0

			for (let page = 0; page < layout.anchors.length; page++) {
				const anchor = layout.anchors[page]

				if (anchor === undefined || anchor.section > section || (anchor.section === section && anchor.index >= index)) break

				first = page
			}

			// In a long table, from the first row changed.
			first = paginator.cellsRestart(first, batch.from.rows) ?? first
		}

		if (first === Infinity) {
			this.releaseRetired()

			return false
		}

		const from = paginator.restartPage(first, true)

		this.compacting = true
		this.rounds = 0
		this.lazy = true
		this.edited = true
		this.fresh = false
		this.from = from
		paginator.restartAt(from, batch.dirty, true, first)
		layout.notify(from, from, false)

		return true
	}

	// Pages closed while fonts were loading are laid out again once they are loaded (a run then comes out the
	// same whenever fonts arrive). Whether it restarted.
	private redoMissed(): boolean {
		const paginator = this.paginator
		const missed = paginator.missedFonts

		if (missed < 0 || this.styles.hasMissing) return false

		const start = paginator.restartPage(Math.min(missed, paginator.progress))

		paginator.restartAt(start, paginator.resyncing ? [] : undefined, false)
		paginator.missedFonts = -1
		this.layout.notify(start, start, false)

		return true
	}

	refresh(page: number): RefreshResult {
		return this.paginator.refresh(page)
	}

	keepFrom(page: number): number {
		return this.paginator.keepFrom(page)
	}

	restory(story: number): number {
		const paginator = this.paginator
		const first = paginator.restory(story)

		// The page being laid out started with the story as it was: laid out again.
		if (!this.layout.final && paginator.shows(story)) this.begin(paginator.progress, [])

		return first
	}

	// Content that referred to a style missing until now looks different: laid out again from the start.
	redefine(styles: DocxStyles, numbering: Numbering | undefined): void {
		if (this.paginator.redefine(styles, numbering)) this.begin(0, undefined)
	}

	// Where the last run met the previous layout again, or -1.
	get resyncedAt(): number {
		return this.paginator.resyncedAt
	}

	// Lays out with `paginator` from now on (a revision view switch: a new engine, laid out from the start).
	use(paginator: Paginator): void {
		this.paginator = paginator
		this.scanFrom = 0
		this.rounds = 0
		this.wantCompact = false
		this.dropMerge()
	}
}

// performance.now where there is one (the clock an editor reads its budgets on, see PagedEditor), else Date.now.
function monotonicNow(): () => number {
	const performance: unknown = Reflect.get(globalThis, "performance")
	const now: unknown = typeof performance === "object" && performance !== null ? Reflect.get(performance, "now") : undefined

	return typeof now === "function" ? () => (now as () => number).call(performance) : Date.now
}

function defaultYield(): Promise<void> {
	return Promise.resolve()
}

// Lays out a document into pages, incrementally: the returned layout fills as pages are laid out (subscribe
// to hear about them; `done` settles at the end). Work is cut into slices of `sliceMs` with the host given a
// turn in between, so the same code runs in a worker or on a UI thread. `fonts` must have the document's
// font table declared; faces load as text needs them.
export function layoutDocument(
	model: DocxModel,
	resolver: PropertyResolver,
	fonts: FontSource,
	measurer: TextMeasurer,
	options: LayoutOptions = {}
): DocumentLayout {
	const cache = new MeasureCache(measurer)
	const table = new StyleTable(cache, options.lineSpacingRule ?? lineSpacingRule(model.settings))
	const decorations = new DecorationTable()
	const runStyles = new RunStyles(table, fonts, decorations, model.settings.autoHyphenation ? (options.hyphenation ?? null) : null)
	const objects = new ObjectTable()
	const layout = new DocumentLayout(model, table, runStyles, objects)
	const store = options.store ?? new PropsStore()
	const tuning = { ...DEFAULT_TUNING, ...options.tuning }
	let view = options.view ?? RevisionView.Final
	let codes: FieldCodes | undefined
	let showHidden = options.showHidden ?? false
	const date = new Date(options.date ?? Date.now())
	const engineOf = (): Engine => {
		const engine = new Engine({
			model,
			resolver,
			store,
			styles: runStyles,
			decorations,
			objects,
			sizer: options.sizer,
			notes: new NoteNumbering(model),
			view,
			showHidden,
			hidden: layout.hidden,
			compat: layoutCompat(model.settings),
			tuning,
			recordMaps: options.recordMaps ?? false,
			...(options.mapParagraph === undefined ? {} : { mapParagraph: options.mapParagraph }),
			now: date,
			...(options.edits === undefined ? {} : { edits: options.edits })
		})

		if (codes !== undefined) engine.content.setFieldCodes(codes)

		return engine
	}
	let paginator = new Paginator(engineOf(), layout, options.estimatedPages, options.maxPages ?? 100000)
	const slice = options.sliceMs ?? 8
	const now = options.now ?? monotonicNow()
	const pause = options.yield ?? defaultYield
	const driver = new LayoutDriver(paginator, layout, runStyles, now)

	// Runs the paginator to the end (or cancellation), from wherever it stands; edits may move it back
	// between slices (it then carries on with their run).
	let running = false
	const drive = async (scan: boolean, later = false): Promise<void> => {
		running = true

		try {
			if (scan) {
				for (let next = 0; next >= 0;) {
					next = paginator.scanStories(next, now() + slice, now)

					if (next >= 0) await pause()
				}

				await runStyles.prepareMissing()
			}

			// Continuing an edit's layout: the edit's own task has done its share already.
			if (later) await pause()

			for (;;) {
				if (layout.cancelled || options.signal?.aborted === true) {
					layout.cancelled = true

					return
				}

				// Suspended: the run waits (done stays pending) until resumed or cancelled.
				if (layout.suspended) {
					await layout.whenResumed()

					continue
				}

				const result = driver.advance(now() + slice, -1)

				// Done with a merge of overlays due: it starts a slice later (the pages just delivered shown).
				if (result === "done" && !driver.merging) break
				if (result === "fonts") await runStyles.prepareMissing()

				await pause()
			}
		} catch (error) {
			layout.error = error

			throw error
		} finally {
			running = false
		}
	}

	driver.continue = (): Promise<void> => {
		if (!running) layout.done = drive(false, true)

		return layout.done
	}

	layout.attach(
		async (page: number) => {
			const from = driver.begin(page, undefined)

			await drive(false)

			return from
		},
		() => running,
		driver,
		next => {
			view = next
			paginator = new Paginator(engineOf(), layout, options.estimatedPages, options.maxPages ?? 100000)
			driver.use(paginator)
		},
		(next, fresh) => {
			codes = next

			// Fields switched one by one: what the pages built from now on show; earlier ones stay.
			if (!fresh) {
				paginator.setFieldCodes(next)

				return
			}

			paginator = new Paginator(engineOf(), layout, options.estimatedPages, options.maxPages ?? 100000)
			driver.use(paginator)
		},
		{
			shown: showHidden,
			set: (next, fresh) => {
				showHidden = next

				// Nothing hidden laid out so far: what is built from now on follows.
				if (!fresh) {
					paginator.setShowHidden(next)

					return
				}

				paginator = new Paginator(engineOf(), layout, options.estimatedPages, options.maxPages ?? 100000)
				driver.use(paginator)
			}
		}
	)
	layout.done = drive(true)

	return layout
}
