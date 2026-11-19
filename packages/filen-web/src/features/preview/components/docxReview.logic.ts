import {
	EditAnnotations,
	docxComments,
	type DocxComments,
	type DocxCommentThread,
	type EditAnnotationData,
	type EditAnnotationRevision,
	type EditFormatColor,
	type EditFormatItem,
	type EditFormatToggle,
	type PagedEditor
} from "@filen/office/core/docx/paged"
import { LINE_FLOATS } from "@filen/office/core/text"
import { RECT_FLOATS } from "@filen/office/dom/docx"
import { indexAnnotations, placeBalloons, type BalloonLayout, type DocxAnnotationIndex, type DocxPageFrame } from "@filen/office/react/docx"
import type { PreviewKey } from "@/lib/i18n"
import { formatShortDate } from "@/lib/formatDate"
import { STANDARD_SWATCHES, fromTwips, lengthUnit, type DocxLengthUnit } from "@/features/preview/components/docxEditor.logic"

// The review layer's state for one editor: the live annotations of the pages mounted, read once per animation
// frame after the editor or the pages changed (never inside a keystroke), kept page by page: a page whose
// version did not change, or that reads the same again, keeps its object, so only what changed draws again.
// The balloons, the page overlays and the comment popover each read the part they show.

// What a page shows of the review, in page px.
export interface ReviewPage {
	readonly frame: DocxPageFrame
	// Threads whose text starts on the page (their first comment's id), top to bottom.
	readonly threads: readonly ReviewAnchor[]
	// Formatting changes starting on the page.
	readonly changes: readonly ReviewChangeAnchor[]
	// The changes with text on the page (for their cards).
	readonly revisions: readonly EditAnnotationRevision[]
	// Commented text: x, y, width, height per box, with its thread and that thread's author (colour).
	readonly boxes: Float32Array
	readonly boxThreads: readonly string[]
	readonly boxAuthors: Int32Array
	// Changed lines (top and height pairs, merged) and where their bar stands.
	readonly bars: Float32Array
	readonly barX: number
}

export interface ReviewAnchor {
	readonly id: string
	readonly x: number
	readonly y: number
	readonly height: number
	readonly author: number
}

export interface ReviewChangeAnchor extends Omit<ReviewAnchor, "id"> {
	readonly revision: EditAnnotationRevision
}

// The pages in view: their places in the scrolled content (px), the element scrolling them and its size without
// scroll bars, and whether any shows a tracked change.
export interface ReviewLayout {
	readonly frames: readonly DocxPageFrame[]
	readonly scroller: HTMLElement | null
	readonly width: number
	readonly height: number
	readonly revisions: boolean
}

const EMPTY_LAYOUT: ReviewLayout = { frames: [], scroller: null, width: 0, height: 0, revisions: false }
const NO_THREADS: ReadonlyMap<string, DocxCommentThread> = new Map()
const NO_AUTHORS: readonly string[] = []

function px(value: string): number {
	const parsed = Number.parseFloat(value)

	return Number.isFinite(parsed) ? parsed : 0
}

function frameKey(frame: DocxPageFrame): string {
	return `${String(frame.top)}:${String(frame.left)}:${String(frame.width)}:${String(frame.height)}`
}

function sameNumbers(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
	if (a.length !== b.length) return false

	for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false

	return true
}

function sameAnchor(a: Omit<ReviewAnchor, "id">, b: Omit<ReviewAnchor, "id">): boolean {
	return a.x === b.x && a.y === b.y && a.height === b.height && a.author === b.author
}

function sameRevision(a: EditAnnotationRevision, b: EditAnnotationRevision): boolean {
	return (
		a.id === b.id &&
		a.kind === b.kind &&
		a.target === b.target &&
		a.author === b.author &&
		a.date === b.date &&
		a.text === b.text &&
		(a.format === b.format || JSON.stringify(a.format) === JSON.stringify(b.format))
	)
}

function sameThreads(a: readonly ReviewAnchor[], b: readonly ReviewAnchor[]): boolean {
	return (
		a.length === b.length &&
		a.every((anchor, k) => {
			const other = b[k]

			return anchor.id === other?.id && sameAnchor(anchor, other)
		})
	)
}

function sameChanges(a: readonly ReviewChangeAnchor[], b: readonly ReviewChangeAnchor[]): boolean {
	return (
		a.length === b.length &&
		a.every((anchor, k) => {
			const other = b[k]

			return other !== undefined && sameAnchor(anchor, other) && sameRevision(anchor.revision, other.revision)
		})
	)
}

// A page read again with what it shows as before kept as it was, part by part: what reads only its frame,
// threads or formatting changes (the balloons, the markers) is not drawn again for a change typed into its
// text (that changes its revisions, boxes and bars only).
function sharedPage(before: ReviewPage, after: ReviewPage): ReviewPage {
	return {
		...after,
		frame: frameKey(before.frame) === frameKey(after.frame) ? before.frame : after.frame,
		threads: sameThreads(before.threads, after.threads) ? before.threads : after.threads,
		changes: sameChanges(before.changes, after.changes) ? before.changes : after.changes
	}
}

// Whether a page read again shows the same.
function samePage(a: ReviewPage, b: ReviewPage): boolean {
	return (
		frameKey(a.frame) === frameKey(b.frame) &&
		a.barX === b.barX &&
		sameThreads(a.threads, b.threads) &&
		sameChanges(a.changes, b.changes) &&
		a.revisions.length === b.revisions.length &&
		a.revisions.every((revision, k) => {
			const other = b.revisions[k]

			return other !== undefined && sameRevision(revision, other)
		}) &&
		sameNumbers(a.boxes, b.boxes) &&
		sameNumbers(a.boxAuthors, b.boxAuthors) &&
		a.boxThreads.every((id, k) => id === b.boxThreads[k]) &&
		sameNumbers(a.bars, b.bars)
	)
}

// What change bars stand left of: the page's leftmost line, a little further left.
function barX(editor: PagedEditor, index: number): number {
	const lines = editor.page(index)?.text
	let left = Infinity

	for (let line = 0; line < (lines?.lineCount ?? 0); line++) left = Math.min(left, lines?.lineFloats[line * LINE_FLOATS + 3] ?? Infinity)

	return Number.isFinite(left) ? Math.max(2, left - 12) : 2
}

function buildPage(editor: PagedEditor, data: EditAnnotationData, index: DocxAnnotationIndex, frame: DocxPageFrame): ReviewPage {
	const entry = index.pages.get(frame.index)
	const threads: ReviewAnchor[] = []
	const changes: ReviewChangeAnchor[] = []
	const revisions: EditAnnotationRevision[] = []

	for (const anchor of entry?.threads ?? []) {
		const comment = data.comments[anchor.index]

		if (comment !== undefined) threads.push({ id: comment.id, x: anchor.x, y: anchor.y, height: anchor.height, author: comment.author })
	}

	for (const anchor of entry?.formatting ?? []) {
		const revision = data.revisions[anchor.index]

		if (revision !== undefined) changes.push({ revision, x: anchor.x, y: anchor.y, height: anchor.height, author: revision.author })
	}

	for (const revision of data.revisions) {
		for (let rect = revision.firstRect; rect < revision.firstRect + revision.rectCount; rect++) {
			if (data.rectPages[rect] === frame.index) {
				revisions.push(revision)

				break
			}
		}
	}

	const ranges = entry?.ranges ?? new Int32Array(0)
	const boxes = new Float32Array(ranges.length * 2)
	const boxAuthors = new Int32Array(ranges.length / 2)
	const boxThreads: string[] = []

	for (let k = 0; k + 1 < ranges.length; k += 2) {
		const comment = data.comments[ranges[k] ?? -1]
		const f = (ranges[k + 1] ?? 0) * RECT_FLOATS

		boxes.set(data.rectFloats.subarray(f, f + RECT_FLOATS), k * 2)
		boxAuthors[k / 2] = comment?.author ?? -1
		boxThreads.push(comment?.id ?? "")
	}

	return {
		frame,
		threads,
		changes,
		revisions,
		boxes,
		boxThreads,
		boxAuthors,
		bars: entry?.bars ?? new Float32Array(0),
		barX: entry === undefined || entry.bars.length === 0 ? 0 : barX(editor, frame.index)
	}
}

export class ReviewView {
	readonly editor: PagedEditor
	readonly annotations: EditAnnotations
	readonly comments: DocxComments
	private readonly elements = new Map<number, HTMLElement>()
	private readonly listeners = new Set<() => void>()
	private readonly pages = new Map<number, { readonly key: string; readonly page: ReviewPage }>()
	private layoutValue: ReviewLayout = EMPTY_LAYOUT
	private threadsValue: ReadonlyMap<string, DocxCommentThread> = NO_THREADS
	private threadsVersion = -1
	private authorsValue: readonly string[] = NO_AUTHORS
	private asideValue = false
	private activeValue: string | null = null
	private frameId = 0
	private moves: MutationObserver | null | undefined = undefined
	private resizes: ResizeObserver | null = null
	private observed: HTMLElement | null = null

	constructor(editor: PagedEditor) {
		this.editor = editor
		this.annotations = new EditAnnotations(editor)
		this.comments = docxComments(editor)
		this.annotations.subscribe(() => {
			this.schedule()
		})
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		this.schedule()

		return () => {
			this.listeners.delete(listener)

			// An observed scroller keeps its observer (and through it this view and the editor) alive: let both go
			// with the last listener; the next subscribe observes it again.
			if (this.listeners.size === 0) {
				cancelAnimationFrame(this.frameId)
				this.frameId = 0
				this.resizes?.disconnect()
				this.resizes = null
				this.observed = null
			}
		}
	}

	readonly layout = (): ReviewLayout => this.layoutValue

	// What page `index` shows (the same object while that does not change).
	readonly page = (index: number): ReviewPage | undefined => this.pages.get(index)?.page

	// Every thread by its first comment's id (the same map while no comment changed).
	readonly threads = (): ReadonlyMap<string, DocxCommentThread> => this.threadsValue

	// Reviewers by colour index (the same list while no one new joined).
	readonly authors = (): readonly string[] => this.authorsValue

	// Balloons have room beside the pages (else threads open in a popover).
	readonly aside = (): boolean => this.asideValue

	// The thread (its first comment's id) shown active: its text highlighted strongest.
	readonly active = (): string | null => this.activeValue

	// A tracked change shown on the pages in view, by id.
	revision(id: string): EditAnnotationRevision | undefined {
		for (const { page } of this.pages.values()) {
			const found = page.revisions.find(revision => revision.id === id)

			if (found !== undefined) return found
		}

		return undefined
	}

	// A page in view (its element, positioned in the scrolled content), told on every render of its overlay.
	mount(index: number, element: HTMLElement): void {
		if (this.elements.get(index) !== element) {
			this.elements.set(index, element)
			// A page moves without its overlay drawing again (the view resized at a fixed zoom): its style tells.
			this.moves ??=
				typeof MutationObserver === "function"
					? new MutationObserver(() => {
							this.schedule()
						})
					: null
			this.moves?.observe(element, { attributes: true, attributeFilter: ["style"] })
		}

		this.schedule()
	}

	unmount(index: number, element: HTMLElement): void {
		if (this.elements.get(index) === element) {
			this.elements.delete(index)
			this.schedule()
		}
	}

	setAside(aside: boolean): void {
		if (this.asideValue !== aside) {
			this.asideValue = aside
			this.notify()
		}
	}

	setActive(active: string | null): void {
		if (this.activeValue !== active) {
			this.activeValue = active
			this.notify()
		}
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener()
	}

	private schedule(): void {
		if (this.frameId !== 0 || this.listeners.size === 0) return

		this.frameId = requestAnimationFrame(() => {
			this.frameId = 0
			this.update()
		})
	}

	// Reads the pages' frames, and the annotations again only when a mounted page's version changed; a page
	// that shows the same keeps its object.
	private update(): void {
		if (this.listeners.size === 0) return

		const frames: DocxPageFrame[] = []

		for (const [index, element] of this.elements) {
			const style = element.style

			frames.push({ index, top: px(style.top), left: px(style.left), width: px(style.width), height: px(style.height) })
		}

		frames.sort((a, b) => a.index - b.index)

		let changed = false
		const version = this.comments.version

		if (version !== this.threadsVersion) {
			this.threadsVersion = version
			this.threadsValue = new Map(this.comments.threads().map(thread => [thread.id, thread]))
			changed = true
		}

		const keys = frames.map(frame => `${frameKey(frame)}|${String(this.annotations.pageVersion(frame.index))}`)

		if (frames.some((frame, k) => this.pages.get(frame.index)?.key !== keys[k])) {
			const data = this.annotations.read(frames.map(frame => frame.index))
			const index = indexAnnotations(data)

			if (data.authors.length !== this.authorsValue.length) {
				this.authorsValue = [...data.authors]
				changed = true
			}

			frames.forEach((frame, k) => {
				const key = keys[k] ?? ""
				const cached = this.pages.get(frame.index)

				if (cached?.key === key) return

				const built = buildPage(this.editor, data, index, frame)
				const keep = cached !== undefined && samePage(cached.page, built)

				this.pages.set(frame.index, {
					key,
					page: keep ? cached.page : cached === undefined ? built : sharedPage(cached.page, built)
				})
				changed ||= !keep
			})
		}

		for (const index of this.pages.keys()) {
			if (!this.elements.has(index)) {
				this.pages.delete(index)
				changed = true
			}
		}

		const first = this.elements.values().next().value
		const scroller = first?.closest<HTMLElement>(".fo-docx-pages") ?? null

		// The room beside the pages changes with the scroller's size.
		if (scroller !== this.observed) {
			this.observed = scroller
			this.resizes?.disconnect()
			this.resizes = null

			if (scroller !== null && typeof ResizeObserver === "function") {
				this.resizes = new ResizeObserver(() => {
					this.schedule()
				})
				this.resizes.observe(scroller)
			}
		}

		const width = scroller?.clientWidth ?? 0
		const height = scroller?.clientHeight ?? 0
		const revisions = [...this.pages.values()].some(({ page }) => page.revisions.length > 0)
		const layout = this.layoutValue

		if (
			layout.scroller !== scroller ||
			layout.width !== width ||
			layout.height !== height ||
			layout.revisions !== revisions ||
			layout.frames.length !== frames.length ||
			layout.frames.some((frame, k) => frame.index !== frames[k]?.index || frameKey(frame) !== frameKey(frames[k] ?? frame))
		) {
			this.layoutValue = { frames, scroller, width, height, revisions }
			changed = true
		}

		if (changed) this.notify()
	}
}

const VIEWS = new WeakMap<PagedEditor, ReviewView>()
const SUBSCRIBERS = new WeakMap<PagedEditor, (listener: () => void) => () => void>()

// Hears every change of the snapshot of the story being edited: one function per editor (a store subscription
// that stays the same across renders).
export function sessionSubscriber(editor: PagedEditor): (listener: () => void) => () => void {
	let subscribe = SUBSCRIBERS.get(editor)

	if (subscribe === undefined) {
		subscribe = listener => editor.subscribeSession(listener)
		SUBSCRIBERS.set(editor, subscribe)
	}

	return subscribe
}

// The review state of an editor (one per editor, kept as long as it is).
export function reviewView(editor: PagedEditor): ReviewView {
	let view = VIEWS.get(editor)

	if (view === undefined) {
		view = new ReviewView(editor)
		VIEWS.set(editor, view)
	}

	return view
}

// A comment's or change's date as balloons show it ("" for none).
export function reviewDate(date: string | undefined): string {
	return date === undefined || date.length === 0 ? "" : formatShortDate(date)
}

// The thread whose text holds position `pos` of story `story`, innermost first: its first comment's id.
export function threadAt(comments: DocxComments, story: number, pos: number): string | undefined {
	let found: string | undefined
	let width = Infinity

	for (const thread of comments.threads()) {
		if (thread.comment.story !== story) continue

		const anchor = comments.anchor(thread.id)

		if (anchor === undefined || pos < anchor.from || pos > Math.max(anchor.to, anchor.reference + 1)) continue

		if (anchor.to - anchor.from < width) {
			found = thread.id
			width = anchor.to - anchor.from
		}
	}

	return found
}

// What a change card or balloon calls a change.
export function changeLabel(revision: Pick<EditAnnotationRevision, "kind" | "target">): PreviewKey {
	if (revision.kind === "formatting") {
		return "previewDocxFormatted"
	}

	if (revision.target === "paragraph") {
		return revision.kind === "deletion" || revision.kind === "moveFrom"
			? "previewDocxChangeParagraphDeleted"
			: "previewDocxChangeParagraphInserted"
	}

	if (revision.target === "table") {
		return revision.kind === "deletion" ? "previewDocxChangeTableDeleted" : "previewDocxChangeTableInserted"
	}

	switch (revision.kind) {
		case "deletion":
			return "previewDocxChangeDeleted"
		case "moveFrom":
			return "previewDocxChangeMovedFrom"
		case "moveTo":
			return "previewDocxChangeMovedTo"
		default:
			return "previewDocxChangeInserted"
	}
}

// A balloon in a page's column: a comment thread, a formatting change, or the comment being composed.
export interface ReviewBalloon {
	readonly key: string
	readonly kind: "thread" | "change" | "compose"
	// The thread's first comment's id, the change's id; "" for the one being composed.
	readonly id: string
	// Where its text starts on the page (page px); x -1 for none.
	readonly x: number
	readonly y: number
	readonly height: number
	readonly author: number
	readonly revision?: EditAnnotationRevision
}

// A page's balloons in anchor order: threads (when the markup shows comments), formatting changes (when it
// shows them) and the comment being composed on this page.
export function pageBalloons(
	page: Pick<ReviewPage, "threads" | "changes">,
	show: { readonly comments: boolean; readonly formatting: boolean },
	compose: { readonly x: number; readonly y: number; readonly height: number } | null
): ReviewBalloon[] {
	const out: ReviewBalloon[] = []

	if (show.comments) for (const anchor of page.threads) out.push({ ...anchor, key: `c:${anchor.id}`, kind: "thread" })

	if (show.formatting) {
		for (const anchor of page.changes) {
			out.push({ ...anchor, key: `f:${anchor.revision.id}`, kind: "change", id: anchor.revision.id })
		}
	}

	if (compose !== null) out.push({ key: "new", kind: "compose", id: "", x: compose.x, y: compose.y, height: compose.height, author: -1 })

	return out.sort((a, b) => a.y - b.y || a.x - b.x)
}

// Tops (content px) of a page's balloons beside its frame, measured heights where known: what does not fit
// waits behind a "+N more" control (see placeBalloons).
export function placeColumn(
	balloons: readonly ReviewBalloon[],
	frame: DocxPageFrame,
	zoom: number,
	heights: ReadonlyMap<string, number>,
	active: string | null,
	sizes: { readonly estimate: number; readonly connector: number; readonly gap: number; readonly more: number }
): BalloonLayout {
	const wanted = balloons.map(balloon => frame.top + (balloon.y + balloon.height * 0.5) * zoom - sizes.connector)
	const measured = balloons.map(balloon => heights.get(balloon.key) ?? sizes.estimate)
	const at = balloons.findIndex(balloon => balloon.key === active)

	return placeBalloons(wanted, measured, {
		gap: sizes.gap,
		top: frame.top,
		bottom: frame.top + frame.height,
		more: sizes.more,
		...(at >= 0 ? { active: at } : {})
	})
}

// Room for balloons right of the pages (px) in a view `viewportWidth` wide: the narrowest gap beside a mounted
// page, less the column's margins.
export function asideRoom(frames: readonly DocxPageFrame[], viewportWidth: number, margin: number): number {
	let room = Infinity

	for (const frame of frames) room = Math.min(room, viewportWidth - (frame.left + frame.width) - 2 * margin)

	return Number.isFinite(room) ? Math.max(0, room) : 0
}

// What a change card or balloon says of a change: its kind, and for a formatting change what changed, as Word's
// balloons say it ("Formatted: Font: Bold"; a table's "Formatted Table"). Lengths in the units of the browser's
// region.
export function changeTitle(revision: Pick<EditAnnotationRevision, "kind" | "target" | "format">, t: ReviewTranslate): string {
	if (revision.kind !== "formatting") {
		return t(changeLabel(revision))
	}

	if (revision.target === "table") {
		return t("previewDocxFormattedTable")
	}

	if (revision.format.length === 0) {
		return t("previewDocxFormatted")
	}

	const locale = typeof navigator === "undefined" ? "en-US" : navigator.language

	return t("previewDocxFormattedProperties", { properties: formatDescription(revision.format, t, lengthUnit(locale), locale) })
}

// ---- what a formatting change changed, in Word's words --------------------------------------------------------

export type ReviewTranslate = (key: PreviewKey, values?: Readonly<Record<string, string | number>>) => string

const THEME_COLOR_KEYS: Readonly<Record<string, PreviewKey>> = {
	dark1: "previewOfficeColorText1",
	text1: "previewOfficeColorText1",
	light1: "previewOfficeColorBackground1",
	background1: "previewOfficeColorBackground1",
	dark2: "previewOfficeColorText2",
	text2: "previewOfficeColorText2",
	light2: "previewOfficeColorBackground2",
	background2: "previewOfficeColorBackground2",
	accent1: "previewOfficeColorAccent1",
	accent2: "previewOfficeColorAccent2",
	accent3: "previewOfficeColorAccent3",
	accent4: "previewOfficeColorAccent4",
	accent5: "previewOfficeColorAccent5",
	accent6: "previewOfficeColorAccent6",
	hyperlink: "previewDocxFormatHyperlink",
	followedHyperlink: "previewDocxFormatFollowedHyperlink"
}

const STANDARD_COLOR_KEYS: Readonly<Record<string, PreviewKey>> = Object.fromEntries(
	STANDARD_SWATCHES.map(swatch => [swatch.rgb, swatch.label.name])
)

const TOGGLE_KEYS: Readonly<Record<EditFormatToggle, readonly [PreviewKey, PreviewKey]>> = {
	bold: ["previewDocxFormatBold", "previewDocxFormatNotBold"],
	italic: ["previewDocxFormatItalic", "previewDocxFormatNotItalic"],
	strike: ["previewDocxFormatStrike", "previewDocxFormatNotStrike"],
	doubleStrike: ["previewDocxFormatDoubleStrike", "previewDocxFormatNotDoubleStrike"],
	smallCaps: ["previewDocxFormatSmallCaps", "previewDocxFormatNotSmallCaps"],
	caps: ["previewDocxFormatCaps", "previewDocxFormatNotCaps"],
	hidden: ["previewDocxFormatHidden", "previewDocxFormatNotHidden"]
}

// A theme font's name by slot, as Word writes it ("+Body", "+Body Asian", "+Body CS").
const THEME_FONT_KEYS: Readonly<Record<string, PreviewKey>> = {
	"body:default": "previewDocxFormatThemeBody",
	"headings:default": "previewDocxFormatThemeHeadings",
	"body:asian": "previewDocxFormatThemeBodyAsian",
	"headings:asian": "previewDocxFormatThemeHeadingsAsian",
	"body:complex": "previewDocxFormatThemeBodyComplex",
	"headings:complex": "previewDocxFormatThemeHeadingsComplex"
}

const SCRIPT_KEYS: Readonly<Record<string, PreviewKey>> = {
	default: "previewDocxFormatDefault",
	asian: "previewDocxFormatAsian",
	complex: "previewDocxFormatComplex"
}

const UNDERLINE_KEYS: Readonly<Record<string, PreviewKey>> = {
	double: "previewDocxFormatDoubleUnderline",
	thick: "previewDocxFormatThickUnderline",
	dotted: "previewDocxFormatDottedUnderline",
	wave: "previewDocxFormatWaveUnderline"
}

const ALIGN_KEYS: Readonly<Record<string, PreviewKey>> = {
	left: "previewDocxFormatLeft",
	center: "previewDocxFormatCentered",
	right: "previewDocxFormatRight",
	justify: "previewDocxFormatJustified",
	distribute: "previewDocxFormatDistributed"
}

const INDENT_KEYS: Readonly<Record<string, PreviewKey>> = {
	left: "previewDocxFormatIndentLeft",
	right: "previewDocxFormatIndentRight",
	firstLine: "previewDocxFormatIndentFirstLine",
	hanging: "previewDocxFormatIndentHanging"
}

const FONT_KINDS: ReadonlySet<EditFormatItem["kind"]> = new Set(["font", "size", "toggle", "underline", "position", "characterSpacing"])

// A colour as Word names it: a theme colour (lighter or darker), a standard colour, Auto, else its RGB.
export function reviewColorName(color: EditFormatColor, t: ReviewTranslate): string {
	if (color.kind === "auto") {
		return t("previewDocxFormatAuto")
	}

	if (color.kind === "theme") {
		const name = t(THEME_COLOR_KEYS[color.theme] ?? "previewDocxFormatAuto")

		if (color.tint !== undefined && color.tint < 255) {
			return t("previewOfficeColorLighter", { color: name, percent: Math.round((1 - color.tint / 255) * 100) })
		}

		if (color.shade !== undefined && color.shade < 255) {
			return t("previewOfficeColorDarker", { color: name, percent: Math.round((1 - color.shade / 255) * 100) })
		}

		return name
	}

	const named = STANDARD_COLOR_KEYS[color.rgb]

	if (named !== undefined) {
		return t(named)
	}

	const value = Number.parseInt(color.rgb, 16)

	return t("previewDocxFormatCustomColor", { red: (value >> 16) & 255, green: (value >> 8) & 255, blue: value & 255 })
}

// One item's words (font and indent items without their group's "Font:" and "Indent:").
function itemWords(item: EditFormatItem, t: ReviewTranslate, number: (value: number) => string, unit: DocxLengthUnit): string {
	const points = (value: number): string => t("previewDocxFormatPoints", { points: number(value) })

	switch (item.kind) {
		case "style":
			return item.name ?? t(item.paragraph ? "previewDocxFormatNormalStyle" : "previewDocxFormatDefaultCharacterStyle")
		case "font": {
			const theme = item.theme === null ? null : t(THEME_FONT_KEYS[`${item.theme}:${item.script}`] ?? "previewDocxFormatThemeBody")
			const name =
				theme === null ? item.name : item.name === null ? theme : t("previewDocxFormatThemeFont", { theme, name: item.name })
			const script = t(SCRIPT_KEYS[item.script] ?? "previewDocxFormatDefault")

			return name === null ? script : t("previewDocxFormatScriptValue", { script, value: name })
		}
		case "size":
			return item.script === "complex"
				? t("previewDocxFormatScriptValue", { script: t("previewDocxFormatComplex"), value: points(item.points) })
				: points(item.points)
		case "toggle":
			return t(TOGGLE_KEYS[item.property][item.on ? 0 : 1])
		case "underline":
			return t(item.style === null ? "previewDocxFormatNoUnderline" : (UNDERLINE_KEYS[item.style] ?? "previewDocxFormatUnderline"))
		case "position":
			return t(
				item.value === "superscript"
					? "previewDocxFormatSuperscript"
					: item.value === "subscript"
						? "previewDocxFormatSubscript"
						: "previewDocxFormatBaseline"
			)
		case "characterSpacing":
			return item.points === 0
				? t("previewDocxFormatNormalSpacing")
				: t(item.points > 0 ? "previewDocxFormatExpanded" : "previewDocxFormatCondensed", { points: number(Math.abs(item.points)) })
		case "color":
			return t("previewDocxFormatFontColor", { color: reviewColorName(item.color, t) })
		case "underlineColor":
			return t("previewDocxFormatUnderlineColor", { color: reviewColorName(item.color, t) })
		case "highlight":
			return t(item.on ? "previewDocxFormatHighlight" : "previewDocxFormatNotHighlight")
		case "shading":
			return item.color === null
				? t("previewDocxFormatNoPattern")
				: t("previewDocxFormatPattern", { color: reviewColorName(item.color, t) })
		case "align":
			return t(ALIGN_KEYS[item.value] ?? "previewDocxFormatLeft")
		case "indent":
			return t(INDENT_KEYS[item.side] ?? "previewDocxFormatIndentLeft", {
				length: t(unit === "in" ? "previewDocxFormatInches" : "previewDocxFormatCentimetres", {
					value: number(fromTwips(item.twips, unit))
				})
			})
		case "space":
			return item.points === "auto" ? t("previewDocxFormatAuto") : points(item.points)
		case "lineSpacing": {
			let value: string

			if (item.rule === "exact") {
				value = t("previewDocxFormatExactly", { points: number(item.value / 20) })
			} else if (item.rule === "atLeast") {
				value = t("previewDocxFormatAtLeast", { points: number(item.value / 20) })
			} else if (item.value === 240) {
				value = t("previewDocxFormatSingle")
			} else if (item.value === 360) {
				value = t("previewDocxFormatOneAndHalf")
			} else if (item.value === 480) {
				value = t("previewDocxFormatDouble")
			} else {
				value = t("previewDocxFormatMultiple", { lines: number(item.value / 240) })
			}

			return t("previewDocxFormatLineSpacing", { value })
		}
		case "list":
			return item.list === "none"
				? t("previewDocxFormatNoList")
				: t(item.list === "bullet" ? "previewDocxFormatBulleted" : "previewDocxFormatNumbered", { level: item.level })
		case "borders":
			return t("previewDocxFormatBorder")
		case "keepNext":
			return t(item.on ? "previewDocxFormatKeepNext" : "previewDocxFormatNotKeepNext")
		case "keepLines":
			return t(item.on ? "previewDocxFormatKeepLines" : "previewDocxFormatNotKeepLines")
		case "pageBreakBefore":
			return t(item.on ? "previewDocxFormatPageBreakBefore" : "previewDocxFormatNoPageBreakBefore")
		case "outlineLevel":
			return item.level === null ? t("previewDocxFormatBodyText") : t("previewDocxFormatLevel", { level: item.level })
	}
}

// What a formatting change changed, as Word's balloon lists it after "Formatted: " (Revision.FormatDescription,
// in the grammar of Style.Description): the font's changes after one "Font:", the indents after one "Indent:",
// "Space Before" then "After", each other property on its own, comma-separated. Lengths in `unit`, numbers
// as `locale` writes them.
export function formatDescription(items: readonly EditFormatItem[], t: ReviewTranslate, unit: DocxLengthUnit, locale: string): string {
	const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
	const number = (value: number): string => numbers.format(value)
	const out: string[] = []

	for (let k = 0; k < items.length;) {
		const item = items[k]

		if (item === undefined) {
			break
		}

		if (FONT_KINDS.has(item.kind) || item.kind === "indent") {
			const font = FONT_KINDS.has(item.kind)
			const group: string[] = []

			while (k < items.length) {
				const next = items[k]

				if (next === undefined || (font ? !FONT_KINDS.has(next.kind) : next.kind !== "indent")) {
					break
				}

				group.push(itemWords(next, t, number, unit))
				k++
			}

			out.push(t(font ? "previewDocxFormatFont" : "previewDocxFormatIndent", { items: group.join(", ") }))

			continue
		}

		if (item.kind === "space") {
			const after = item.side === "before" && items[k + 1]?.kind === "space" ? items[k + 1] : undefined

			out.push(
				t(item.side === "before" ? "previewDocxFormatSpaceBefore" : "previewDocxFormatSpaceAfter", {
					value: itemWords(item, t, number, unit)
				})
			)

			if (after !== undefined) {
				out.push(t("previewDocxFormatAfter", { value: itemWords(after, t, number, unit) }))
				k++
			}

			k++

			continue
		}

		out.push(itemWords(item, t, number, unit))
		k++
	}

	return out.join(", ")
}
