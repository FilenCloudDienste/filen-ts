import type { Mark, Node } from "prosemirror-model"
import { SOURCE_INTS, SourceInt, type PageDisplayList, type RevisionAuthors } from "../layout/index"
import { modelAuthors } from "../layout/styles"
import { equationChangeOf, storyHasTrackedEquations } from "../math/edit"
import { RevisionFlag } from "../model/index"
import { reviewIndexWanted, storyReviewIndex } from "../review/accept"
import { docxComments, type DocxComment as StoreComment, type DocxComments } from "../review/comments"
import { paragraphChangeFormat, textFormatChanges, type EditFormatItem } from "../review/formatChanges"
import { ReviewKind, type ReviewEntry, type ReviewIndex } from "../review/index"
import { docxSchema } from "../edit/schema"
import type { DocxEditorSession } from "../edit/session"
import type { PagedEditor } from "./editor"
import { MarkBoxes, type Affinity, type PagedGeometry } from "./geometry"

// The comments and tracked changes of a document being edited, live: what a viewer's annotations hold
// (dom/docx/annotations.ts DocxAnnotations, the same shape), read from each story's review index and comments,
// with boxes on the pages laid out so far. Made by the view that shows them (never by the editor itself), and
// read again only for the pages whose version changed.

export type { EditFormatColor, EditFormatItem, EditFormatToggle } from "../review/formatChanges"

export interface EditAnnotationRun {
	readonly text: string
	readonly bold: boolean
	readonly italic: boolean
	readonly underline: boolean
	readonly strike: boolean
}

export interface EditAnnotationComment {
	// w:id, as written.
	readonly id: string
	// Index into the authors, or -1 when the comment names none.
	readonly author: number
	readonly initials: string
	// ISO 8601 as the document records it (UTC where known), or "".
	readonly date: string
	// The comment's paragraphs, each its runs.
	readonly paragraphs: readonly (readonly EditAnnotationRun[])[]
	// The comment this one replies to (index into comments), or -1.
	readonly parent: number
	// Resolved (commentsExtended w15:done).
	readonly done: boolean
	// The commented text's boxes: rects [firstRect, firstRect + rectCount). None where it is not laid out (or,
	// live, not on the pages read).
	readonly firstRect: number
	readonly rectCount: number
}

export type EditAnnotationRevisionKind = "insertion" | "deletion" | "moveFrom" | "moveTo" | "formatting"

// What a change applies to: text runs, a paragraph (its mark, properties or numbering), a table (rows,
// cells, properties) or a section's properties.
export type EditAnnotationRevisionTarget = "text" | "paragraph" | "table" | "section"

export interface EditAnnotationRevision {
	readonly kind: EditAnnotationRevisionKind
	readonly target: EditAnnotationRevisionTarget
	readonly author: number
	readonly date: string
	// The inserted, deleted or moved text (shortened), "" for formatting.
	readonly text: string
	// Formatting: the WordprocessingML properties that changed (local names: "b", "sz", "jc"...), where known.
	readonly properties: readonly string[]
	// Live annotations only: what a formatting change changed, as Word lists it (empty for other kinds).
	readonly format: readonly EditFormatItem[]
	readonly firstRect: number
	readonly rectCount: number
	// Live annotations only: the change's id (what review.accept and review.reject take) and its story.
	readonly id: string
	readonly story: number
}

// Boxes of annotated text: four floats per box (x, y, width, height on its page), the page in rectPages.
export interface EditAnnotationData {
	readonly authors: readonly string[]
	// Every comment anchored in the document as edited: threads in document order, each its first comment and
	// then its replies.
	readonly comments: readonly EditAnnotationComment[]
	// The tracked changes with text on the pages read, one per change however many pieces it has.
	readonly revisions: readonly EditAnnotationRevision[]
	readonly rectPages: Int32Array
	readonly rectFloats: Float32Array
}

const MAX_PREVIEW = 160
// Text read for a preview (a long insertion is not read whole).
const PREVIEW_READ = 4 * MAX_PREVIEW
const MAX_COMMENT_CHARS = 20_000
// Boxes kept per comment or change.
const MAX_RECTS = 512
// Numbers per box while gathering: page, x, y, width, height.
const BOX = 5
// Past this many comments in a story, those outside the page are passed over before boxing.
const FILTERED = 8
const FULL = { from: 0, to: Number.MAX_SAFE_INTEGER }

const marks = docxSchema.marks
const TEXT_KINDS: Readonly<Partial<Record<number, { readonly kind: EditAnnotationRevisionKind; readonly mark: unknown }>>> = {
	[ReviewKind.INSERTION]: { kind: "insertion", mark: marks.insertion },
	[ReviewKind.DELETION]: { kind: "deletion", mark: marks.deletion },
	[ReviewKind.MOVE_FROM]: { kind: "moveFrom", mark: marks.move_from },
	[ReviewKind.MOVE_TO]: { kind: "moveTo", mark: marks.move_to },
	[ReviewKind.FORMAT]: { kind: "formatting", mark: marks.format_change }
}
const STAMPED_MARKS = [marks.paragraph_change, marks.row_props, marks.cell_props]

interface Range {
	readonly from: number
	readonly to: number
	// Index of the list the boxes go to.
	readonly owner: number
}

interface Stamp {
	readonly author: string | undefined
	readonly date: string | undefined
}

// The stories whose boxes can be found, with their geometry.
interface Located {
	readonly session: DocxEditorSession
	readonly geometry: PagedGeometry
	readonly story: number
	// The pages read that show the story.
	readonly pages: readonly number[]
}

interface Change {
	readonly story: Located
	readonly id: string
	readonly kind: EditAnnotationRevisionKind
	readonly target: EditAnnotationRevisionTarget
	readonly stamp: Stamp
	readonly text: string
	readonly format: readonly EditFormatItem[]
	readonly ranges: Range[]
	readonly points: number[]
	// Boxes found already (a story read page by page from its cache), else found from ranges and points.
	boxes?: number[]
}

const NO_FORMAT: readonly EditFormatItem[] = []

// A story's comments (by id, numbered) and changes with all their ranges, owners the comments then the changes.
interface StoryReview {
	readonly ids: ReadonlyMap<string, number>
	readonly changes: readonly (readonly [string, Change])[]
	readonly ranges: readonly Range[]
}

interface KeptBoxes {
	readonly list: PageDisplayList
	readonly key: string
	readonly boxes: readonly number[]
}

interface StoryPage {
	readonly list: PageDisplayList | undefined
	readonly doc: Node
	readonly comments: ReadonlyMap<string, readonly number[]>
	readonly changes: readonly { readonly key: string; readonly change: Change; readonly boxes: readonly number[] }[]
}
const NO_STAMP: Stamp = { author: undefined, date: undefined }

function preview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim()

	return flat.length > MAX_PREVIEW ? `${flat.slice(0, MAX_PREVIEW - 1)}…` : flat
}

function dateOf(value: string | undefined): string {
	return value !== undefined && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : ""
}

// A comment's plain text (paragraphs on line feeds, line breaks U+2028) as paragraphs of one run each.
function plainParagraphs(text: string): EditAnnotationRun[][] {
	const out: EditAnnotationRun[][] = []

	for (const paragraph of text.slice(0, MAX_COMMENT_CHARS).split("\n")) {
		const flat = paragraph.replaceAll(" ", "\n")

		out.push(flat.length === 0 ? [] : [{ text: flat, bold: false, italic: false, underline: false, strike: false }])
	}

	while (out.length > 0 && (out[out.length - 1]?.length ?? 0) === 0) out.pop()

	return out
}

function stampOf(value: unknown): Stamp | undefined {
	if (typeof value !== "object" || value === null) return undefined

	const author: unknown = (value as { readonly author?: unknown }).author
	const date: unknown = (value as { readonly date?: unknown }).date

	return typeof author === "string" ? { author, date: typeof date === "string" ? date : undefined } : undefined
}

function markStamp(mark: Mark | undefined): Stamp {
	return (mark === undefined ? undefined : stampOf(mark.attrs)) ?? NO_STAMP
}

// The block a block entry stands for: entries sit before the block's closing token.
function blockAt(doc: Node, pos: number): { node: Node; start: number; end: number } | undefined {
	if (pos < 0 || pos > doc.content.size) return undefined

	const $pos = doc.resolve(pos)

	return $pos.depth === 0 ? undefined : { node: $pos.parent, start: $pos.start(), end: $pos.end() }
}

// Who recorded a block's change and when: a stamp the editor recorded on it, else the source's revision.
function blockStamp(node: Node, kind: ReviewKind, source: (src: number) => Stamp): Stamp {
	const keys = kind === ReviewKind.PROPERTIES ? ["props", "change", "gridChange"] : ["inserted", "deleted", "ins", "del"]
	const values: unknown[] = STAMPED_MARKS.map(type => type.isInSet(node.marks)?.attrs["value"])

	if (node.type === docxSchema.nodes.table) values.push(node.attrs["props"])

	for (const value of values) {
		if (typeof value !== "object" || value === null) continue

		for (const key of keys) {
			const stamp = stampOf((value as Readonly<Record<string, unknown>>)[key])

			if (stamp !== undefined) return stamp
		}
	}

	const src: unknown = node.attrs["src"]

	return typeof src === "number" && src >= 0 ? source(src) : NO_STAMP
}

function blockKind(node: Node, kind: ReviewKind): { kind: EditAnnotationRevisionKind; target: EditAnnotationRevisionTarget } {
	const target = node.isTextblock ? "paragraph" : "table"

	if (kind === ReviewKind.PROPERTIES) return { kind: "formatting", target }

	const revision: unknown = node.attrs["revision"]
	const flags = typeof revision === "number" ? revision : 0

	if ((flags & RevisionFlag.Deleted) !== 0) return { kind: "deletion", target }
	if ((flags & RevisionFlag.MovedFrom) !== 0) return { kind: "moveFrom", target }
	if ((flags & RevisionFlag.MovedTo) !== 0) return { kind: "moveTo", target }

	return { kind: "insertion", target }
}

export class EditAnnotations {
	readonly editor: PagedEditor
	private readonly store: DocxComments
	private readonly listeners = new Set<() => void>()
	private readonly stops: (() => void)[] = []
	private readonly pageVersions: number[] = []
	private readonly boxes = new MarkBoxes()
	// Reviewers numbered as the layout numbers them (one colour per author in the text and the margin).
	private readonly authors: RevisionAuthors
	// The source revisions' authors and dates by item, per story (read once).
	private readonly sourceStamps = new Map<number, Map<number, Stamp>>()
	private readonly pageStories = new WeakMap<PageDisplayList, readonly number[]>()
	private readonly sourceStories = new Map<number, boolean>()
	private readonly commentBases = new WeakMap<StoreComment, Pick<EditAnnotationComment, "initials" | "date" | "paragraphs">>()
	// What other stories show per page (see storyPage).
	private readonly storyPages = new WeakMap<PagedGeometry, Map<number, StoryPage>>()
	// What a story holds, kept while the story is unchanged (a relayout of its page boxes it again only).
	private readonly storyReviews = new WeakMap<Node, StoryReview>()
	// Boxes of a change's few ranges per page, kept while the page and their places are the same.
	private readonly storyBoxes = new WeakMap<PagedGeometry, Map<number, KeptBoxes>>()
	// Boxes of the comments of the body (or the story being edited) per page (see commentBoxesOf).
	private readonly commentPages = new WeakMap<PagedGeometry, Map<number, KeptBoxes>>()
	// The store's comments in order, kept while it is unchanged.
	private flat: { readonly version: number; readonly list: readonly StoreComment[]; readonly order: ReadonlyMap<string, number> } = {
		version: -1,
		list: [],
		order: new Map()
	}
	private readonly formats = new WeakMap<Node, { readonly style: string | undefined; readonly format: readonly EditFormatItem[] }>()
	private global = 0
	private queued = false
	private disposed = false

	constructor(editor: PagedEditor) {
		this.editor = editor
		this.store = docxComments(editor)
		this.authors = modelAuthors(editor.edits.model)
		this.stops.push(
			editor.subscribe(event => {
				if (event.type === "pages") {
					for (const page of event.changed) this.pageVersions[page] = (this.pageVersions[page] ?? 0) + 1

					this.notify()
				} else if (event.type === "story") {
					this.global++
					this.notify()
				}
			}),
			this.store.subscribe(() => {
				this.global++
				this.notify()
			})
		)
	}

	// Changes whenever what page `page` shows of the annotations changes (an edit, a relayout of the page).
	pageVersion(page: number): number {
		return this.global + (this.pageVersions[page] ?? 0)
	}

	// The annotations now, with boxes on pages `pages` (the ones mounted) only.
	read(pages: readonly number[]): EditAnnotationData {
		const located = this.located(pages)
		const version = this.store.version

		if (this.flat.version !== version) {
			const list: StoreComment[] = []

			for (const thread of this.store.threads()) list.push(thread.comment, ...thread.replies)

			this.flat = { version, list, order: new Map(list.map((comment, k) => [comment.id, k])) }
		}

		const { list: flat, order } = this.flat

		const commentBoxes: number[][] = flat.map(() => [])
		const changes = new Map<string, Change>()
		const seen = new Set<string>()

		for (const story of located) {
			const index = this.index(story.session)

			if (index === undefined) continue

			if (story.session === this.editor.body.session || story.session === this.editor.session) {
				this.commentBoxesOf(story.geometry, index, order, story.pages, commentBoxes)

				if (index.revisionCount > 0) for (const page of story.pages) this.pageChanges(story, index, page, changes, seen)

				continue
			}

			// Another story (a note, a header): what it shows on each page, kept while the page and the story are.
			for (const page of story.pages) {
				const found = this.storyPage(story, index, page)

				for (const [id, boxes] of found.comments) commentBoxes[order.get(id) ?? -1]?.push(...boxes)

				for (const { key, change, boxes } of found.changes) {
					const known = changes.get(key)

					if (known === undefined) changes.set(key, { ...change, boxes: [...boxes] })
					else known.boxes?.push(...boxes)
				}
			}
		}

		const rectPages: number[] = []
		const rectFloats: number[] = []
		const authors = this.authors
		const comments = flat.map((comment, k): EditAnnotationComment => {
			const first = rectPages.length

			pack(commentBoxes[k] ?? [], rectPages, rectFloats)

			let base = this.commentBases.get(comment)

			// Read once per comment as the store has it (the same object while it is unchanged).
			if (base === undefined) {
				base = {
					initials: comment.initials?.trim() ?? "",
					date: dateOf(comment.dateUtc ?? comment.date),
					paragraphs: plainParagraphs(comment.text)
				}
				this.commentBases.set(comment, base)
			}

			return {
				id: comment.id,
				author: authors.index(comment.author),
				...base,
				parent: comment.parentId === undefined ? -1 : (order.get(comment.parentId) ?? -1),
				done: comment.done,
				firstRect: first,
				rectCount: rectPages.length - first
			}
		})
		const revisions: EditAnnotationRevision[] = []
		const owned: number[][] = [[]]

		for (const change of changes.values()) {
			const boxes = change.boxes ?? owned[0] ?? []

			if (change.boxes === undefined) {
				boxes.length = 0
				this.boxesOf(change.story.geometry, change.ranges, pages, owned)

				for (const point of change.points) {
					const caret = change.story.geometry.locate(point, -1)

					if (caret !== undefined && pages.includes(caret.page) && boxes.length < MAX_RECTS * BOX)
						boxes.push(caret.page, caret.x, caret.top, caret.width ?? 0, caret.height)
				}
			}

			if (boxes.length === 0) continue

			const first = rectPages.length

			pack(boxes, rectPages, rectFloats)
			revisions.push({
				kind: change.kind,
				target: change.target,
				author: authors.index(change.stamp.author),
				date: dateOf(change.stamp.date),
				text: change.text,
				properties: [],
				format: change.format,
				firstRect: first,
				rectCount: rectPages.length - first,
				id: change.id,
				story: change.story.story
			})
		}

		return {
			authors: authors.names,
			comments,
			revisions,
			rectPages: Int32Array.from(rectPages),
			rectFloats: Float32Array.from(rectFloats)
		}
	}

	// The tracked change at `pos` of story `story` (index), for a hover card or the caret's change.
	changeAt(story: number, pos: number): ReviewEntry | undefined {
		const session = this.editor.sessions.find(candidate => candidate.story.story.index === story)
		const index = session === undefined ? undefined : this.index(session)

		return index === undefined || index.revisionCount === 0 ? undefined : index.changeAt(pos)
	}

	// Hears once per burst of changes that alter what read() returns.
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	// Stops listening to the editor.
	dispose(): void {
		this.disposed = true

		for (const stop of this.stops.splice(0)) stop()

		this.listeners.clear()
	}

	// ---- internals ----------------------------------------------------------------------------------------

	private notify(): void {
		if (this.queued || this.disposed) return

		this.queued = true
		void Promise.resolve().then(() => {
			this.queued = false

			if (this.disposed) return

			for (const listener of [...this.listeners]) listener()
		})
	}

	// The stories whose boxes are read: the body, the story being edited, and the other stories laid out on the
	// pages read (headers, footers, notes, text boxes) that may hold comments or changes. Those get their session
	// (and geometry) on first read; one without anything to show never does.
	private located(pages: readonly number[]): Located[] {
		const editor = this.editor
		const bodyStory = editor.body.session.story.story.index
		const out: Located[] = [{ session: editor.body.session, geometry: editor.body.geometry, story: bodyStory, pages }]
		const others = new Map<
			number,
			{ readonly session: DocxEditorSession; readonly geometry: PagedGeometry; readonly pages: number[] }
		>()
		const skipped = new Set<number>([bodyStory])

		if (editor.session !== editor.body.session) {
			out.push({ session: editor.session, geometry: editor.geometry, story: editor.activeStory, pages })
			skipped.add(editor.activeStory)
		}

		let sessions: Set<number> | undefined

		for (const page of pages) {
			for (const story of this.storiesOn(page)) {
				if (skipped.has(story)) continue

				let found = others.get(story)

				if (found === undefined) {
					sessions ??= new Set(editor.sessions.map(session => session.story.story.index))

					const on = sessions.has(story) || this.sourceReview(story) ? editor.storyOnPages(story) : undefined

					if (on === undefined) {
						skipped.add(story)

						continue
					}

					found = { session: on.session, geometry: on.geometry, pages: [] }
					others.set(story, found)
				}

				found.pages.push(page)
			}
		}

		for (const [story, found] of others) out.push({ ...found, story })

		return out
	}

	// The stories other than the body a page shows, from its sources (once per laid-out page).
	private storiesOn(page: number): readonly number[] {
		const list = this.editor.page(page)

		if (list === undefined) return []

		let stories = this.pageStories.get(list)

		if (stories === undefined) {
			const body = this.editor.body.session.story.story.index
			const found = new Set<number>()

			for (let source = 0; source < list.sourceCount; source++) {
				const story = list.sourceInts[source * SOURCE_INTS + SourceInt.STORY] ?? -1

				if (story >= 0 && story !== body) found.add(story)
			}

			stories = [...found]
			this.pageStories.set(list, stories)
		}

		return stories
	}

	// Whether the file has comments or tracked changes in story `story` (read once per story).
	private sourceReview(story: number): boolean {
		let has = this.sourceStories.get(story)

		if (has === undefined) {
			const model = this.editor.edits.model
			const target = model.stories[story]
			const part = target === undefined ? undefined : model.parts[target.part]

			has = false

			if (target !== undefined && part !== undefined) {
				const end = part.end(target.item)
				const inside = (partIndex: number, item: number): boolean => partIndex === target.part && item >= target.item && item < end
				const revisions = part.revisions
				const anchors = model.commentAnchors

				for (let row = 0; row < revisions.count && !has; row++) has = inside(target.part, revisions.item[row] ?? -1)

				has ||= storyHasTrackedEquations(part, target.item)

				for (let row = 0; row < anchors.count && !has; row++) {
					has =
						inside(anchors.startPart[row] ?? -1, anchors.startItem[row] ?? -1) ||
						inside(anchors.referencePart[row] ?? -1, anchors.referenceItem[row] ?? -1)
				}
			}

			this.sourceStories.set(story, has)
		}

		return has
	}

	// A story's review index, where it may hold comments or changes (none is made for a story without).
	private index(session: DocxEditorSession): ReviewIndex | undefined {
		return reviewIndexWanted(session) ? storyReviewIndex(session) : undefined
	}

	// What story `story` (not the body or the story being edited) shows on page `page`: each comment's boxes by
	// id and each change with its boxes; read again only when the page was laid out again or the story changed.
	private storyPage(story: Located, index: ReviewIndex, page: number): StoryPage {
		const list = this.editor.page(page)
		const doc = story.session.state.doc
		let kept = this.storyPages.get(story.geometry)

		if (kept === undefined) {
			kept = new Map()
			this.storyPages.set(story.geometry, kept)
		}

		const cached = kept.get(page)

		if (cached !== undefined && cached.list === list && cached.doc === doc) return cached

		const { ids, changes: changeList, ranges } = this.storyReview(story, index, doc)
		const owned = Array.from({ length: ids.size + changeList.length }, (): number[] => [])
		const found = this.pageBoxes(story.geometry, ranges, page, true)

		for (let k = 0; k + BOX < found.length; k += BOX + 1) owned[found[k] ?? -1]?.push(...found.slice(k + 1, k + 1 + BOX))

		const comments = new Map<string, number[]>()

		for (const [id, at] of ids) if ((owned[at]?.length ?? 0) > 0) comments.set(id, owned[at] ?? [])

		const result: StoryPage = {
			list,
			doc,
			comments,
			changes: changeList.map(([key, change], k) => {
				const boxes = owned[ids.size + k] ?? []

				for (const point of change.points) {
					const caret = story.geometry.locate(point, -1)

					if (caret?.page === page) boxes.push(page, caret.x, caret.top, caret.width ?? 0, caret.height)
				}

				return { key, change, boxes }
			})
		}

		kept.set(page, result)

		return result
	}

	private storyReview(story: Located, index: ReviewIndex, doc: Node): StoryReview {
		const kept = this.storyReviews.get(doc)

		if (kept !== undefined) return kept

		const ids = new Map<string, number>()
		const entries = index.commentEntries()

		for (let k = 0; k < entries.length; k++) {
			const id = index.idOf(entries[k] ?? 0)

			if (!ids.has(id)) ids.set(id, ids.size)
		}

		// The story's changes (it is small: every entry, no search for the page's part of it).
		const changes = new Map<string, Change>()

		if (index.revisionCount > 0) {
			for (const entry of index.entries()) {
				if (entry.kind <= ReviewKind.COMMENT_REFERENCE) continue

				const key = `${String(story.story)}:${String(entry.kind)}:${entry.id}`
				const change = changes.get(key) ?? this.change(story, doc, entry)

				if (change === undefined) continue

				changes.set(key, change)
				place(change, doc, entry)
			}
		}

		// Owners are the comments, then the changes, so that one pass over a page's lines boxes both.
		const changeList = [...changes]
		const ranges = commentRanges(index, ids)

		changeList.forEach(([, change], k) => {
			for (const range of change.ranges) ranges.push({ from: range.from, to: range.to, owner: ids.size + k })
		})
		ranges.sort((a, b) => a.from - b.from)

		const review: StoryReview = { ids, changes: changeList, ranges }

		this.storyReviews.set(doc, review)

		return review
	}

	// Boxes of `ranges` (sorted by from) on `pages`, each (page, x, y, width, height) to its owner's list.
	private boxesOf(geometry: PagedGeometry, ranges: readonly Range[], pages: readonly number[], out: number[][]): void {
		if (ranges.length === 0) return

		// A change of few ranges is boxed without finding first what of the story the page shows (that reads
		// every line of the page as boxing does), and its boxes on a page are kept while neither the page nor
		// its places change.
		const small = ranges.length <= FILTERED
		const key = small ? ranges.map(range => `${String(range.from)}:${String(range.to)}:${String(range.owner)}`).join(",") : ""
		let kept = small ? this.storyBoxes.get(geometry) : undefined

		if (small && kept === undefined) {
			kept = new Map()
			this.storyBoxes.set(geometry, kept)
		}

		for (const page of pages) {
			const list = this.editor.page(page)
			const cached = kept?.get(page)
			let found: readonly number[]

			if (list !== undefined && cached?.list === list && cached.key === key) {
				found = cached.boxes
			} else {
				found = this.pageBoxes(geometry, ranges, page, small)

				if (list !== undefined) kept?.set(page, { list, key, boxes: found })
			}

			addBoxes(found, out)
		}
	}

	// The boxes of the comments of the story being read in full (the body, or the story edited) on `pages`. A
	// page's are kept while it is laid out as before and neither the story's comment entries nor the store
	// changed: a keystroke boxes them again on the pages it laid out again only (the comments' places elsewhere
	// moved in the document, not on the page), and typed tracked changes do not count.
	private commentBoxesOf(
		geometry: PagedGeometry,
		index: ReviewIndex,
		order: ReadonlyMap<string, number>,
		pages: readonly number[],
		out: number[][]
	): void {
		if (index.commentCount === 0) return

		const key = `${String(index.commentVersion)}:${String(this.flat.version)}`
		let kept = this.commentPages.get(geometry)
		let ranges: Range[] | undefined

		if (kept === undefined) {
			kept = new Map()
			this.commentPages.set(geometry, kept)
		}

		for (const page of pages) {
			const list = this.editor.page(page)
			const cached = kept.get(page)
			let found: readonly number[]

			if (list !== undefined && cached?.list === list && cached.key === key) {
				found = cached.boxes
			} else {
				ranges ??= commentRanges(index, order)
				found = ranges.length === 0 ? [] : this.pageBoxes(geometry, ranges, page, ranges.length <= FILTERED)

				if (list !== undefined) kept.set(page, { list, key, boxes: found })
			}

			addBoxes(found, out)
		}
	}

	// The boxes of `ranges` (sorted by from) on page `page`, each its owner and then page, x, y, width, height.
	private pageBoxes(geometry: PagedGeometry, ranges: readonly Range[], page: number, small: boolean): number[] {
		const out: number[] = []
		const shown = small ? FULL : geometry.pageRange(page)

		if (shown === undefined) return out

		let longest = 0
		const spans: Range[] = []

		for (const range of ranges) {
			if (range.from > shown.to) break
			if (range.to < shown.from) continue

			if (range.from < range.to) {
				spans.push(range)
				longest = Math.max(longest, range.to - range.from)

				continue
			}

			this.caretBox(geometry, range.from, page, range.owner, out)
		}

		if (spans.length === 0) return out

		const boxes = this.boxes
		const boxed = new Set<number>()

		boxes.clear()
		geometry.rangesBoxes(spans, longest, page, boxes)

		for (let b = 0; b < boxes.count; b++) {
			const owner = spans[boxes.owners[b] ?? -1]?.owner ?? -1
			const at = b * 4

			boxed.add(owner)
			out.push(owner, page, boxes.values[at + 2] ?? 0, boxes.values[at] ?? 0, boxes.values[at + 3] ?? 0, boxes.values[at + 1] ?? 0)
		}

		// Text the view hides (a deletion in Final) or none at all (an atom): where it starts, as one zero-width
		// box, as the line before ends.
		for (const range of spans) {
			if (boxed.has(range.owner)) continue

			boxed.add(range.owner)
			this.caretBox(geometry, range.from, page, range.owner, out, -1)
		}

		return out
	}

	// A zero-width box where `pos` is drawn (zero-height in sideways text), when that is on page `page`: its owner,
	// then the box.
	private caretBox(geometry: PagedGeometry, pos: number, page: number, owner: number, out: number[], affinity: Affinity = 1): void {
		const caret = geometry.locate(pos, affinity)

		if (caret?.page === page) out.push(owner, page, caret.x, caret.top, caret.width ?? 0, caret.height)
	}

	// The changes with an entry on page `page` of a story, added to `changes` (one per change). `seen`: the
	// entries placed already (pages overlap where a paragraph spans two).
	private pageChanges(story: Located, index: ReviewIndex, page: number, changes: Map<string, Change>, seen: Set<string>): void {
		const shown = story.geometry.pageRange(page)

		if (shown === undefined) return

		const doc = story.session.state.doc
		// A block's change sits at its end: the paragraph the page ends in counts whole.
		const $to = doc.resolve(Math.min(doc.content.size, shown.to))
		const to = $to.depth > 0 && $to.parent.isTextblock ? $to.end() + 1 : shown.to

		for (const entry of index.between(shown.from, to)) {
			if (entry.kind <= ReviewKind.COMMENT_REFERENCE) continue

			const key = `${String(story.story)}:${String(entry.kind)}:${entry.id}`
			const at = `${key}@${String(entry.from)}`

			if (seen.has(at)) continue

			seen.add(at)

			const change = changes.get(key) ?? this.change(story, doc, entry)

			if (change === undefined) continue

			changes.set(key, change)
			place(change, doc, entry)
		}
	}

	private change(story: Located, doc: Node, entry: ReviewEntry): Change | undefined {
		const text = TEXT_KINDS[entry.kind]

		if (text !== undefined || entry.kind === ReviewKind.FIELD_UPDATE) {
			const node = doc.nodeAt(entry.from)
			const mark = text === undefined ? undefined : node?.marks.find(candidate => candidate.type === text.mark)
			// A change inside an equation: its revisions' author and date (the equation carries no mark for it).
			const inEquation = node?.type === docxSchema.nodes.math ? equationChangeOf(node, story.session.story.part, entry.id) : undefined

			return {
				story,
				id: entry.id,
				kind: inEquation === undefined ? (text?.kind ?? "insertion") : inEquation.kind === "del" ? "deletion" : "insertion",
				target: "text",
				stamp:
					inEquation === undefined
						? markStamp(mark)
						: { author: inEquation.author, date: inEquation.date === "" ? undefined : inEquation.date },
				text:
					text === undefined || text.kind === "formatting" || inEquation !== undefined
						? ""
						: preview(doc.textBetween(entry.from, Math.min(entry.to, entry.from + PREVIEW_READ), " ", "")),
				format:
					text?.kind === "formatting" && node !== null
						? this.formatOf(node, paragraphStyleAt(doc, entry.from), style =>
								textFormatChanges(story.session.context, node, style)
							)
						: NO_FORMAT,
				ranges: [],
				points: []
			}
		}

		const block = blockAt(doc, entry.from)

		if (block === undefined) return undefined

		const described = blockKind(block.node, entry.kind)

		return {
			story,
			id: entry.id,
			kind: described.kind,
			target: described.target,
			stamp: blockStamp(block.node, entry.kind, src => this.sourceStamp(story.session, src)),
			text: "",
			format:
				described.kind === "formatting" && block.node.isTextblock
					? this.formatOf(block.node, undefined, () =>
							paragraphChangeFormat(story.session.context, story.session.story.part, block.node)
						)
					: NO_FORMAT,
			ranges: [],
			points: []
		}
	}

	// What a formatting change of `node` (text in a paragraph of style `style`) changed: read once per node and
	// style (an unchanged node is the same object).
	private formatOf(
		node: Node,
		style: string | undefined,
		read: (style: string | undefined) => readonly EditFormatItem[]
	): readonly EditFormatItem[] {
		let cached = this.formats.get(node)

		if (cached?.style !== style || cached === undefined) {
			cached = { style, format: read(style) }
			this.formats.set(node, cached)
		}

		return cached.format
	}

	// The author and date of a source revision of item `src` in a story's part.
	private sourceStamp(session: DocxEditorSession, src: number): Stamp {
		const key = session.story.story.index
		let stamps = this.sourceStamps.get(key)

		if (stamps === undefined) {
			stamps = new Map()

			const table = session.story.part.revisions
			const model = this.editor.edits.model

			for (let row = 0; row < table.count; row++) {
				const item = table.item[row] ?? -1

				if (item >= 0 && !stamps.has(item))
					stamps.set(item, { author: model.string(table.author[row] ?? -1), date: model.string(table.date[row] ?? -1) })
			}

			this.sourceStamps.set(key, stamps)
		}

		return stamps.get(src) ?? NO_STAMP
	}
}

// The style of the paragraph holding `pos`.
function paragraphStyleAt(doc: Node, pos: number): string | undefined {
	const style: unknown = doc.resolve(pos).parent.attrs["styleId"]

	return typeof style === "string" ? style : undefined
}

// Adds an entry's place to its change: its text, or a paragraph mark's place at its paragraph's end, or a
// block's text (a paragraph's or row's properties).
function place(change: Change, doc: Node, entry: ReviewEntry): void {
	if (TEXT_KINDS[entry.kind] !== undefined || entry.kind === ReviewKind.FIELD_UPDATE) {
		change.ranges.push({ from: entry.from, to: Math.max(entry.from + 1, entry.to), owner: 0 })

		return
	}

	if (entry.kind === ReviewKind.PARAGRAPH) {
		change.points.push(entry.from)

		return
	}

	const block = blockAt(doc, entry.from)

	if (block === undefined) return

	if (block.end > block.start) change.ranges.push({ from: block.start, to: block.end, owner: 0 })
	else change.points.push(block.start)
}

// Each comment's range in a story (its start to its end marker; its reference where it has no range), sorted
// by `from`, owned by the comment's place in `order`.
// Boxes found (each its owner, then page, x, y, width, height) added to their owners' lists.
function addBoxes(found: readonly number[], out: number[][]): void {
	for (let k = 0; k + BOX < found.length; k += BOX + 1) {
		const into = out[found[k] ?? -1]

		if (into !== undefined && into.length < MAX_RECTS * BOX) into.push(...found.slice(k + 1, k + 1 + BOX))
	}
}

function commentRanges(index: ReviewIndex, order: ReadonlyMap<string, number>): Range[] {
	if (index.commentCount === 0) return []

	const entries = index.commentEntries()
	const starts = new Map<string, number>()
	const ends = new Map<string, number>()
	const references = new Map<string, number>()

	for (let k = 0; k < entries.length; k++) {
		const entry = entries[k] ?? 0
		const id = index.idOf(entry)
		const from = index.fromOf(entry)
		const kind = index.kindOf(entry)
		const map = kind === ReviewKind.COMMENT_START ? starts : kind === ReviewKind.COMMENT_END ? ends : references

		if (!map.has(id)) map.set(id, from)
	}

	const out: Range[] = []

	// The story's own comments only (what its index holds), never every comment of the document.
	for (const id of new Set([...starts.keys(), ...references.keys()])) {
		const owner = order.get(id)
		const reference = references.get(id)
		const from = starts.get(id) ?? reference

		if (owner === undefined || from === undefined) continue

		out.push({ from, to: Math.max(from, ends.get(id) ?? reference ?? from), owner })
	}

	return out.sort((a, b) => a.from - b.from)
}

// Appends gathered boxes (page, x, y, width, height each) to the packed arrays.
function pack(boxes: readonly number[], rectPages: number[], rectFloats: number[]): void {
	for (let k = 0; k + BOX <= boxes.length; k += BOX) {
		rectPages.push(boxes[k] ?? -1)
		rectFloats.push(boxes[k + 1] ?? 0, boxes[k + 2] ?? 0, boxes[k + 3] ?? 0, boxes[k + 4] ?? 0)
	}
}
