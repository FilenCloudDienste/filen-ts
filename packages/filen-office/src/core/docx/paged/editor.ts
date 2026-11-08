import type { Mark, MarkType, Node } from "prosemirror-model"
import { redoDepth, undoDepth } from "prosemirror-history"
import { NodeSelection, TextSelection, type EditorState, type Selection, type Transaction } from "prosemirror-state"
import { LINE_FLOATS, LINE_INTS, LineFloat, LineInt, type HitTester } from "../../text/index"
import {
	DOCX_EDITOR_COMMANDS,
	DocxDocBuilder,
	DocxEditorSession,
	commandInfo,
	docxSchema,
	documentHandler,
	readOnlyReasons,
	textboxHolderLocked,
	type DocumentCommandContext,
	type DocxEditorCommand,
	type DocxEditorCommandType,
	type DocxEditorOptions,
	type DocxEditorSnapshot,
	type DocxMediaInfo,
	type DocxRefusalReason,
	type NewStoryKind
} from "../edit/index"
import { writesUnholdableText } from "../edit/commands/base"
import { commandAllowed } from "../edit/protection"
import { hostStories } from "../forms/sessions"
import type { FieldCodes } from "../layout/fields"
import {
	Region,
	SOURCE_INTS,
	SourceInt,
	type DirtyBlock,
	type DocumentLayout,
	type LayoutEvent,
	type PageDisplayList
} from "../layout/index"
import { Item, RevisionView, type Story, type StoryPart } from "../model/index"
import { flushComposition } from "../review/track"
import { bindAddedDrawings } from "../objects/edit"
import type { StoryTemplate } from "../stories/clone"
import { DocumentEdits, foldTransactions, StoryEdits, type PendingChange, type StoryChange, type TopEntry } from "./edits"
import { PagedGeometry, type Affinity, type CaretBox, type HitResult, type PageRect } from "./geometry"
import { DocumentHistory } from "./history"
import { hitObject, type ObjectHit } from "./objects"
import { PageIndex } from "./pages"

// Paged editing of a document, headless: an editing session whose document the layout follows edit by
// edit (only the pages that change are laid out again: the ones in view within the edit's task, the rest in
// slices after it), and the caret, selection and pointer geometry over the pages as shown. A view draws
// pages, caret and selection from here and feeds input to the session; nothing here touches the DOM.

export interface PagedEditorOptions {
	readonly now?: () => number
	// Synchronous layout per edit beyond the pages in view (ms).
	readonly budgetMs?: number
}

export type PagedEditorEvent =
	// Pages laid out again (indices), the page count, and whether layout has caught up with the document.
	| { readonly type: "pages"; readonly changed: readonly number[]; readonly count: number; readonly final: boolean }
	// The selection, composition or caret geometry changed.
	| { readonly type: "selection" }
	// Editing moved to another story (the body, a header, a footer, a note): `state` is that story's.
	| { readonly type: "story"; readonly story: number }
	// The undo order, the format painter or another document-level state changed.
	| { readonly type: "document" }

// One story being edited: its session, the layout's view of it and its geometry over the pages. `region`
// is undefined for a story not laid out on the pages (a comment).
export interface EditedStory {
	readonly session: DocxEditorSession
	readonly edits: StoryEdits
	readonly index: PageIndex
	readonly geometry: PagedGeometry
	readonly region: Region | undefined
}

const STORY_REGIONS: Readonly<Record<string, Region | undefined>> = {
	body: Region.BODY,
	header: Region.HEADER,
	footer: Region.FOOTER,
	footnote: Region.FOOTNOTE,
	endnote: Region.ENDNOTE,
	textbox: Region.TEXTBOX
}

// The formatting the format painter carries (format.copy), applied by format.paste.
export interface DocxFormatPainter {
	readonly marks: readonly Mark[]
	// Paragraph attributes to apply too (null: character formatting only).
	readonly paragraph: Readonly<Record<string, unknown>> | null
	// Stays on after a paste (double-click on the painter), until cancelled.
	readonly sticky: boolean
}

// Where a story's lines lie on a page: the box around those in one column.
interface StoryBox {
	readonly region: Region
	readonly story: number
	left: number
	top: number
	right: number
	bottom: number
}

interface PageRegions {
	readonly band: { top: number; bottom: number } | undefined
	readonly boxes: readonly StoryBox[]
}

// Which stories a press reaches first where they overlap.
const REGION_ORDER: readonly Region[] = [Region.TEXTBOX, Region.FOOTNOTE, Region.ENDNOTE, Region.HEADER, Region.FOOTER]

export interface PagedSelection {
	readonly from: number
	readonly to: number
	readonly anchor: number
	readonly head: number
	readonly empty: boolean
	// The selection is one atom (a locked block, an image).
	readonly node: boolean
}

const DEFAULT_BUDGET_MS = 4
// While suspended, the stories' views take what they applied at the latest once this many stories' runs of
// applies wait (each keeps two documents).
const MAX_BEHIND = 200
// Marks of text a revision view hides.
const HIDDEN_MARKS: Readonly<Partial<Record<RevisionView, readonly MarkType[]>>> = {
	[RevisionView.Final]: [docxSchema.marks.deletion, docxSchema.marks.move_from],
	[RevisionView.Original]: [docxSchema.marks.insertion, docxSchema.marks.move_to]
}
const DOCUMENT_COMMANDS = DOCX_EDITOR_COMMANDS.filter(info => info.scope === "document")
const REGIONS = new WeakMap<PageDisplayList, PageRegions>()

export class PagedEditor {
	readonly edits: DocumentEdits
	readonly layout: DocumentLayout
	readonly body: EditedStory
	private active: EditedStory
	private readonly stories = new Map<number, EditedStory>()
	private readonly tester: HitTester
	private readonly sessionOptions: Omit<DocxEditorOptions, "story">
	private readonly now: () => number
	private readonly budget: number
	private readonly listeners = new Set<(event: PagedEditorEvent) => void>()
	private readonly refusedListeners = new Set<(reason: DocxRefusalReason) => void>()
	// Pages as shown: the layout's, and while it lays out again in the background, earlier ones it has not
	// reached yet.
	private readonly shown: PageDisplayList[] = []
	private readonly changed = new Set<number>()
	private flushQueued = false
	private finalSeen = false
	private disposed = false
	private readonly unsubscribe: (() => void)[] = []
	// Which side of a line wrap the caret is drawn on, and the x vertical motion keeps.
	private affinityValue: Affinity = 1
	private goal: number | undefined = undefined
	// The range of text being composed (an IME preedit), shown underlined.
	private compositionRange: { from: number; to: number } | undefined = undefined
	private compositionFlushQueued = false
	// The pages in view (the view tells), laid out within an edit's task.
	private visible: { first: number; last: number } = { first: 0, last: 0 }
	// Set while a transaction from geometry (a vertical move, a click) is applied: its affinity and goal stay.
	private keepMotion = false
	// Where each story's caret was after its last change (which way it moved).
	private readonly heads = new WeakMap<EditedStory, number>()
	// The page each story's caret was on when editing left it.
	private readonly lastPages = new WeakMap<EditedStory, number>()
	private visibilityQueued = false
	// One undo order across the stories edited.
	private readonly history = new DocumentHistory<EditedStory>()
	private painterValue: DocxFormatPainter | undefined = undefined
	// Paged layout is suspended (another surface shows the document): edits are kept up with but laid out
	// only on resume, from the first page they changed.
	private suspendedValue = false
	private pendingPage: number | undefined = undefined
	// Fields shown as their codes (Word's Alt+F9), and the fields switched the other way one by one (Shift+F9,
	// by their nodes): a view, never saved.
	private fieldCodesAll = false
	private readonly codeToggles = new Set<Node>()
	private readonly pendingStories = new Set<number>()
	private readonly settledWaiters: (() => void)[] = []
	private snapshotOf: { session: DocxEditorSnapshot; history: number; state: number; snapshot: DocxEditorSnapshot } | undefined =
		undefined
	// Changes with the editor's own state document commands may depend on (painter, view, suspension, stories).
	private stateVersion = 0
	// What repeat() runs, and whether a story command is running (its transactions do not end it).
	private repeatable: DocxEditorCommand | undefined = undefined
	private commandRunning = false
	private headersHidden = false
	// While suspended: what the stories applied that their layout views have not taken yet, in order (keepUp),
	// a story's consecutive applies folded into one change.
	private readonly behind: { readonly story: EditedStory; pending: PendingChange }[] = []
	private enabledOf:
		{ readonly base: DocxEditorSnapshot["enabled"]; readonly enabled: Readonly<Record<DocxEditorCommandType, boolean>> } | undefined =
		undefined

	constructor(init: {
		readonly session: DocxEditorSession
		readonly edits: DocumentEdits
		readonly layout: DocumentLayout
		readonly tester: HitTester
		readonly options?: PagedEditorOptions
		// Options of the sessions editing other stories (headers, footers, notes), made when entered.
		readonly sessionOptions?: Omit<DocxEditorOptions, "story">
	}) {
		this.edits = init.edits
		this.layout = init.layout
		this.tester = init.tester
		this.sessionOptions = init.sessionOptions ?? {}
		this.now = init.options?.now ?? defaultNow()
		this.budget = init.options?.budgetMs ?? DEFAULT_BUDGET_MS

		for (const page of init.layout.pages) this.shown[page.index] = page

		this.body = this.edited(init.session)
		this.active = this.body
		// Features changing other stories with an edit (controls bound to one node) get their sessions here.
		this.unsubscribe.push(hostStories(init.session.context, story => this.storySession(story)))
		this.finalSeen = init.layout.final
		this.unsubscribe.push(init.layout.subscribe(event => this.onLayout(event)))
	}

	private edited(session: DocxEditorSession): EditedStory {
		const edits = new StoryEdits(this.edits, session.story, session.state.doc, session.context)
		const region = STORY_REGIONS[session.story.story.kind]
		const index = new PageIndex(edits, region ?? Region.TEXTBOX)
		const story: EditedStory = {
			session,
			edits,
			index,
			geometry: new PagedGeometry(edits, index, { page: at => this.shown[at] }, this.tester, region ?? Region.TEXTBOX),
			region
		}

		if (region !== undefined) for (const page of this.shown) if (page !== undefined) index.index(page)

		this.stories.set(session.story.story.index, story)
		this.history.track(story, session.state)
		this.unsubscribe.push(session.onApplied((transactions, state) => this.onApplied(story, transactions, state)))
		this.unsubscribe.push(
			session.onRefused(reason => {
				for (const listener of this.refusedListeners) listener(reason)
			})
		)

		return story
	}

	// The story being edited.
	get session(): DocxEditorSession {
		return this.active.session
	}

	get story(): StoryEdits {
		return this.active.edits
	}

	get index(): PageIndex {
		return this.active.index
	}

	get geometry(): PagedGeometry {
		return this.active.geometry
	}

	get activeStory(): number {
		return this.active.session.story.story.index
	}

	get activeRegion(): Region {
		return this.active.region ?? Region.BODY
	}

	// Every session (for saving): the body's and those of stories entered.
	get sessions(): readonly DocxEditorSession[] {
		return [...this.stories.values()].map(story => story.session)
	}

	// The editing session of story `story` (one of the document's or one the editor added), made on first
	// use; undefined for any other index. Its edits join the undo order; it is not entered.
	storySession(story: number): DocxEditorSession | undefined {
		return this.storyOf(story)?.session
	}

	// Story `story` laid out on the pages (a header, footer, note or text box): its session and its geometry over
	// the pages, made on first use as storySession makes them; undefined for a story not on the pages (a comment).
	storyOnPages(story: number): { readonly session: DocxEditorSession; readonly geometry: PagedGeometry } | undefined {
		const edited = this.storyOf(story)

		return edited?.region === undefined ? undefined : edited
	}

	// Story `story` of the document's model; one edited blocks bring (a text box) is there once layout's view of
	// them caught up.
	private modelStory(story: number): Story | undefined {
		const known = (): boolean => story < this.edits.storyCount || this.edits.addedStory(story)

		if (!known() && this.behind.length > 0) this.keepUp()

		return known() ? this.edits.model.stories[story] : undefined
	}

	private storyOf(story: number): EditedStory | undefined {
		const known = this.stories.get(story)

		if (known !== undefined) return known

		const target = this.modelStory(story)

		if (target === undefined) return undefined

		// A text box is saved with the story holding it (write/nested.ts): that story gets its session first,
		// and a text box in a block of it that is locked stays view-only.
		if (target.kind === "textbox" && target.parent >= 0) {
			const holder = this.storyOf(target.parent)

			if (holder === undefined) return undefined

			textboxHolderLocked(holder.session.state.doc, holder.session.story.part, target)
		}

		return this.edited(new DocxEditorSession(this.body.session.context, { ...this.sessionOptions, story: target }))
	}

	// Adds a story of `kind` (a new note, comment, header or footer) with one empty paragraph and returns its
	// session (undefined when it could not be made). Notes and comments get the next id of their kind unless
	// `id` is given. A header or footer made from `template` (a copy of another one's part, stories/clone.ts)
	// holds what the template does. Nothing refers to it yet: a feature inserts the reference (and undoing that
	// leaves the story out of the save).
	addStory(kind: NewStoryKind, id?: string, template?: StoryTemplate): DocxEditorSession | undefined {
		// Stories number in the order the document's model gets them (edited blocks bring theirs, text boxes).
		this.keepUp()

		const context = this.body.session.context
		const space = kind === "footnote" || kind === "endnote" || kind === "comment" ? kind : undefined

		// An id given is a whole number no note or comment of the kind has.
		if (id !== undefined && (space === undefined || !/^-?\d{1,10}$/.test(id) || this.idTaken(space, id))) return undefined
		const storyId = id ?? (space === undefined ? undefined : String(context.ids.next(space)))

		// An id given is never handed out again.
		if (space !== undefined && id !== undefined && Number.isInteger(Number(id))) context.ids.reserve(space, Number(id))
		const target = this.newPartName(kind)
		const story = this.edits.addStory(kind, storyId, target, template)
		const part = story === undefined ? undefined : this.edits.model.parts[story.part]

		if (story === undefined || part === undefined) return undefined

		const { proof, ...options } = this.sessionOptions
		const builder = new DocxDocBuilder(context)

		// A copy's drawings are the derived model's (commands and the save read them through the context).
		if (template !== undefined)
			bindAddedDrawings(
				context,
				() => this.edits.model.drawings,
				() => this.edits.model.parts
			)

		// A copy is source content: proved as the document's own stories are.
		const session = new DocxEditorSession(context, {
			...options,
			story,
			...(template === undefined ? { proof: null } : proof === undefined ? {} : { proof }),
			built: template === undefined ? builder.buildNew(story, part) : builder.build(story, part, this.edits.model.drawings)
		})

		context.newStories.set(story, { kind, id: storyId, target })
		this.edited(session)
		this.changedState()

		return session
	}

	// The notes part new notes of `kind` go into (made where the document has none).
	notePart(kind: "footnote" | "endnote"): StoryPart | undefined {
		this.keepUp()

		return this.edits.notesPart(kind, this.newPartName(kind))
	}

	private idTaken(space: "footnote" | "endnote" | "comment", id: string): boolean {
		const model = this.edits.model

		if (space === "footnote") return model.footnotes.has(id)
		if (space === "endnote") return model.endnotes.has(id)

		return (
			model.comments.some(comment => comment.id === id) ||
			[...this.body.session.context.newStories.values()].some(story => story.kind === "comment" && story.id === id)
		)
	}

	// The part a new story goes into: the document's notes or comments part (made when it has none), or a
	// header or footer part of its own.
	private newPartName(kind: NewStoryKind): string {
		const pkg = this.edits.model.package
		const taken = new Set([...this.body.session.context.newStories.values()].map(story => story.target))

		if (kind === "footnote" || kind === "endnote" || kind === "comment") {
			const base = kind === "comment" ? "comments" : `${kind}s`
			const existing = pkg.part(base)

			if (existing !== undefined) return existing

			// One new part for every story of the kind; a name no part of the package has (an unrelated part
			// may hold the usual one).
			const made = [...this.body.session.context.newStories.values()].find(story => story.kind === kind)?.target

			if (made !== undefined) return made

			for (let n = 0; ; n++) {
				const name = `word/${base}${n === 0 ? "" : String(n)}.xml`

				if (!pkg.has(name) && !taken.has(name)) return name
			}
		}

		for (let n = 1; ; n++) {
			const name = `word/${kind}${String(n)}.xml`

			if (!pkg.has(name) && !taken.has(name)) return name
		}
	}

	// Edits story `story` (a header, footer, note or text box shown on the pages) from now on, its caret drawn
	// on page `page` (the story shows on many; -1: the first); `page` -1 and story the body's: back to the body.
	// Note separators are not entered (Word's print layout does not either).
	enterStory(story: number, page: number): boolean {
		const target = this.modelStory(story)

		if (target === undefined || STORY_REGIONS[target.kind] === undefined || !ordinaryNote(target)) return false

		const edited = this.storyOf(story)

		if (edited === undefined) return false

		// Without a page: where its caret last was.
		edited.geometry.preferPage(page < 0 ? (this.lastPages.get(edited) ?? -1) : page)

		if (edited === this.active) return true

		const leaving = this.active.geometry.locate(this.active.session.state.selection.head, this.affinityValue)

		if (leaving !== undefined) this.lastPages.set(this.active, leaving.page)

		this.active = edited
		this.affinityValue = 1
		this.goal = undefined
		this.compositionRange = undefined
		this.emit({ type: "story", story })
		this.emit({ type: "selection" })

		return true
	}

	exitStory(): void {
		this.enterStory(this.body.session.story.story.index, -1)
	}

	// The band of page `page` the body's lines take (top, bottom), or undefined without body lines.
	bodyBand(page: number): { top: number; bottom: number } | undefined {
		const list = this.shown[page]

		return list === undefined ? undefined : regionsOf(list).band
	}

	// The story other than the body whose area on page `page` holds point (x, y), or -1: a text box, a note,
	// a header or a footer, found by the lines each laid out there (from the pages' sources); a header or
	// footer also takes the margin above or below the body's lines, as in Word. Stories that would open
	// read-only for a reason of their own (a text box until its fallback is written) are passed over.
	storyAt(page: number, x: number, y: number): number {
		const list = this.shown[page]

		if (list === undefined) return -1

		const regions = regionsOf(list)
		const band = regions.band
		const context = this.body.session.context
		const own = readOnlyReasons(context, this.body.session.story.story, false).length
		const enterable = (story: number): boolean => {
			const target = this.edits.model.stories[story]

			return target !== undefined && ordinaryNote(target) && readOnlyReasons(context, target, false).length === own
		}

		for (const region of REGION_ORDER) {
			for (const box of regions.boxes) {
				if (box.region !== region || !enterable(box.story)) continue

				// Headers and footers span the page; text boxes and notes are where their column of lines is.
				const inside =
					region === Region.HEADER
						? y <= box.bottom || (band !== undefined && y < band.top)
						: region === Region.FOOTER
							? y >= box.top || (band !== undefined && y > band.bottom)
							: x >= box.left && x <= box.right && y >= box.top && y <= box.bottom

				if (inside) return box.story
			}
		}

		return -1
	}

	// The object (a picture, a content control...) at page point (x, y), as the features find them. `zoom`:
	// screen px per page px (providers whose grab distance is a screen distance use it).
	hitObject(page: number, x: number, y: number, zoom = 1): ObjectHit | undefined {
		return hitObject(this, page, x, y, zoom)
	}

	// Hears a user edit any story's session refused (DocxEditorSession.onRefused).
	onRefused(listener: (reason: DocxRefusalReason) => void): () => void {
		this.refusedListeners.add(listener)

		return () => {
			this.refusedListeners.delete(listener)
		}
	}

	subscribe(listener: (event: PagedEditorEvent) => void): () => void {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	dispose(): void {
		this.disposed = true

		for (const stop of this.unsubscribe) stop()

		this.unsubscribe.length = 0
		this.listeners.clear()
		this.refusedListeners.clear()
		this.behind.length = 0

		for (const resolve of this.settledWaiters.splice(0)) resolve()

		this.body.session.context.media.clear()

		// Their history and plugins hold their documents (see DocxEditorSession.dispose).
		for (const story of this.stories.values()) story.session.dispose()
	}

	get state(): EditorState {
		return this.session.state
	}

	get pageCount(): number {
		return this.shown.length
	}

	// Whether layout has caught up with every edit.
	get settled(): boolean {
		return (
			this.layout.final &&
			this.changed.size === 0 &&
			this.pendingPage === undefined &&
			this.pendingStories.size === 0 &&
			this.behind.length === 0
		)
	}

	page(index: number): PageDisplayList | undefined {
		return this.shown[index]
	}

	get affinity(): Affinity {
		return this.affinityValue
	}

	get composition(): { from: number; to: number } | undefined {
		return this.compositionRange
	}

	selection(): PagedSelection {
		const selection = this.session.state.selection

		return {
			from: selection.from,
			to: selection.to,
			anchor: selection.anchor,
			head: selection.head,
			empty: selection.empty,
			node: selection instanceof NodeSelection
		}
	}

	// ---- input --------------------------------------------------------------------------------------------

	// Applies a transaction (from the input view or a command); false when the session refused it.
	dispatch(tr: Transaction): boolean {
		return this.session.dispatch(tr)
	}

	// Runs a command: story commands on the story being edited, document commands here (undo and redo in the
	// order of edits across stories). A promise for async commands.
	execute(command: DocxEditorCommand): boolean | Promise<boolean> {
		const info = commandInfo(command.type)

		if (this.disposed || info === undefined || writesUnholdableText(command)) return false
		if (command.type === "history.undo" || command.type === "history.redo") return this.step(command.type === "history.undo")
		if (info.scope === "story") {
			this.commandRunning = true

			let done: boolean

			try {
				done = this.session.execute(command)
			} finally {
				this.commandRunning = false
			}

			if (done && info.write) this.repeatable = command

			return done
		}
		if (info.write && (this.body.session.readOnly || !commandAllowed(this.session, command.type))) return false

		const handler = documentHandler(command.type)
		const context = this.commandContext()

		if (handler === undefined || !handler.enabled(context)) return false

		return handler.run(context, command as never)
	}

	// Word's Repeat (F4): the last story command that changed formatting or content, run again where the
	// selection is now; false when there is none (an edit not made by a command ends it).
	repeat(): boolean {
		const command = this.repeatable

		return command !== undefined && this.execute(command) === true
	}

	canExecute(type: DocxEditorCommandType): boolean {
		return this.snapshot().enabled[type]
	}

	// The story being edited's snapshot with what the editor decides: undo and redo across stories and the
	// document commands' enablement.
	snapshot(): DocxEditorSnapshot {
		const base = this.session.snapshot()
		const cached = this.snapshotOf

		if (
			cached !== undefined &&
			cached.session === base &&
			cached.history === this.history.version &&
			cached.state === this.stateVersion
		)
			return cached.snapshot

		const readOnly = this.body.session.readOnly
		const canUndo = !readOnly && this.history.nextUndo(story => this.undoable(story)) !== undefined
		const canRedo = !readOnly && this.history.nextRedo(story => this.redoable(story)) !== undefined
		const context = this.commandContext()
		const previous = this.enabledOf
		// The session's record decides story commands; the editor only document commands (one pass over them).
		let same = previous !== undefined && previous.base === base.enabled
		const values: boolean[] = []

		for (const info of DOCUMENT_COMMANDS) {
			const value =
				info.type === "history.undo"
					? canUndo
					: info.type === "history.redo"
						? canRedo
						: !(info.write && (readOnly || !commandAllowed(this.session, info.type))) &&
							documentHandler(info.type)?.enabled(context) === true

			values.push(value)

			if (same && previous?.enabled[info.type] !== value) same = false
		}

		let enabled = previous?.enabled ?? base.enabled

		if (!same) {
			const record: Record<string, boolean> = { ...base.enabled }

			DOCUMENT_COMMANDS.forEach((info, k) => {
				record[info.type] = values[k] ?? false
			})
			enabled = record as Record<DocxEditorCommandType, boolean>
			this.enabledOf = { base: base.enabled, enabled }
		}

		const snapshot: DocxEditorSnapshot =
			enabled === base.enabled && canUndo === base.canUndo && canRedo === base.canRedo ? base : { ...base, canUndo, canRedo, enabled }

		this.snapshotOf = { session: base, history: this.history.version, state: this.stateVersion, snapshot }

		return snapshot
	}

	private commandContext(): DocumentCommandContext {
		return { editor: this, session: this.session, context: this.body.session.context }
	}

	private undoable(story: EditedStory): boolean {
		return !story.session.readOnly && undoDepth(story.session.state) > 0
	}

	private redoable(story: EditedStory): boolean {
		return !story.session.readOnly && redoDepth(story.session.state) > 0
	}

	// Undoes (or redoes) the most recent edit in whichever story it was, entering that story when it is on the
	// pages.
	private step(undo: boolean): boolean {
		if (this.body.session.readOnly) return false

		const story = undo ? this.history.nextUndo(entry => this.undoable(entry)) : this.history.nextRedo(entry => this.redoable(entry))

		if (story === undefined) return false

		// A story no page shows (a comment, a note nothing refers to yet) is undone where it is.
		if (
			story !== this.active &&
			story.region !== undefined &&
			(story === this.body || story.index.firstPage(story.edits.entries) >= 0)
		) {
			if (story === this.body) this.exitStory()
			else this.enterStory(story.session.story.story.index, -1)
		}

		return story.session.execute({ type: undo ? "history.undo" : "history.redo" })
	}

	// The format painter's formatting (set by format.copy, used by format.paste), or undefined when off.
	get painter(): DocxFormatPainter | undefined {
		return this.painterValue
	}

	setPainter(painter: DocxFormatPainter | undefined): void {
		if (painter === this.painterValue) return

		this.painterValue = painter
		this.changedState()
	}

	// Whether the surface showing the document shows headers and footers: Mobile view does not (as Word's), and
	// their commands are off meanwhile.
	get headersShown(): boolean {
		return !this.headersHidden
	}

	setHeadersShown(shown: boolean): void {
		if (shown !== this.headersHidden) return

		this.headersHidden = !shown
		this.changedState()
	}

	// Registers bytes a command will use (a picture to insert) and returns their handle, or undefined when
	// they are over the size limit. Chunks are kept as they came (a bridge streams them).
	addMedia(chunks: Uint8Array | readonly Uint8Array[], info?: DocxMediaInfo): number | undefined {
		return this.body.session.context.media.add(chunks, info)
	}

	// Shows the document in another revision view, laid out again from the first page (pages in view now,
	// the rest in slices; pages not reached yet stay as they were meanwhile). False when it already is.
	setView(view: RevisionView): boolean {
		this.keepUp()

		if (!this.edits.setView(view)) return false

		for (const story of this.stories.values()) if (story.region !== undefined) story.index.truncate(0)

		this.changed.clear()

		const restart = this.layout.setView(view)

		if (this.suspendedValue) this.pendingPage = 0
		else this.advanceFrom(restart)

		this.heads.delete(this.active)
		this.keepVisible(this.active, this.session.state)
		this.changedState()

		return true
	}

	get view(): RevisionView {
		return this.edits.view
	}

	// Shows every field as its code (Word's Alt+F9) or as its result, laid out again from the first page as
	// setView does; fields switched one by one follow. False when it already is so.
	setFieldCodes(on: boolean): boolean {
		if (on === this.fieldCodesAll && this.codeToggles.size === 0) return false

		this.keepUp()
		this.fieldCodesAll = on
		this.codeToggles.clear()
		this.layOutCodes()

		return true
	}

	get fieldCodes(): boolean {
		return this.fieldCodesAll
	}

	// Switches fields (nodes of the story being edited: field atoms, or the begin character of a field spanning
	// paragraphs) between code and result (Word's Shift+F9). Laid out again from the first page showing `range`
	// of the story's document (where the fields are, whole) when the story is the body and layout knows it as
	// it is, as an edit of those blocks is; else from the first page.
	toggleFieldCodes(fields: readonly Node[], range?: { readonly from: number; readonly to: number }): boolean {
		if (fields.length === 0) return false

		for (const field of fields) if (!this.codeToggles.delete(field)) this.codeToggles.add(field)

		this.keepUp()

		const body = this.body
		const blocks =
			range === undefined || this.active !== body || body.edits.document !== body.session.state.doc
				? undefined
				: body.edits.blocksOf(range.from, range.to)

		this.layOutCodes(blocks)

		return true
	}

	// Whether a field (see toggleFieldCodes) shows its code.
	fieldCodeShown(field: Node): boolean {
		return this.fieldCodesAll !== this.codeToggles.has(field)
	}

	private layOutCodes(blocks?: { readonly entries: readonly TopEntry[]; readonly dirty: readonly DirtyBlock[] }): void {
		const codes: FieldCodes | undefined =
			!this.fieldCodesAll && this.codeToggles.size === 0
				? undefined
				: {
						all: this.fieldCodesAll,
						toggled: this.codeToggles.size === 0 ? undefined : (part, item) => this.toggledAt(part, item),
						within: (part, item) => this.withinCode(part, item)
					}

		const layout = this.layout
		const found = blocks === undefined ? -1 : this.body.index.restartPage(blocks.entries, page => layout.keepFrom(page))

		// Only those blocks change: laid out again from the first page showing them, as an edit of them is.
		if (blocks !== undefined && found >= 0) {
			const laid = layout.pages.length
			const first = !layout.final && found >= laid ? Math.max(0, laid - 1) : found
			const restart = layout.setFieldCodes(codes, { page: first, dirty: blocks.dirty })

			if (this.suspendedValue) this.pendingPage = Math.min(this.pendingPage ?? restart, restart)
			else this.advanceFrom(restart)

			this.changedState()

			return
		}

		for (const story of this.stories.values()) if (story.region !== undefined) story.index.truncate(0)

		this.changed.clear()

		const restart = layout.setFieldCodes(codes)

		if (this.suspendedValue) this.pendingPage = 0
		else this.advanceFrom(restart)

		this.heads.delete(this.active)
		this.keepVisible(this.active, this.session.state)
		this.changedState()
	}

	// Whether the field whose begin (or w:fldSimple) is item `item` of `part`, as laid out, is a field switched
	// one by one: the field of the editing document at the same place among its paragraph's fields.
	private toggledAt(part: StoryPart, item: number): boolean {
		let paragraph = item

		while (paragraph >= 0 && part.kinds[paragraph] !== Item.Paragraph) paragraph = part.parent(paragraph)

		if (paragraph < 0) return false

		const run = part.parent(item)

		for (const story of this.stories.values()) {
			const found = story.edits.paragraphOf(part.index, paragraph)

			if (found === undefined) continue

			const laid = fieldsOf(found.shadow)
			const index = laid.findIndex(node => {
				const own = node.attrs["src"] as number

				return own === item || (own === run && node.type === docxSchema.nodes.field)
			})
			const edited = index < 0 ? undefined : fieldsOf(found.node)

			return edited !== undefined && edited.length === laid.length && this.codeToggles.has(edited[index] as Node)
		}

		return false
	}

	// Whether paragraph `item` of `part`, laid out from an edit (never a source part: the layout reads those),
	// lies inside a field spanning paragraphs shown as its code that does not end in it.
	private withinCode(part: StoryPart, item: number): boolean {
		if (this.body.session.context.model.parts[part.index] === part) return false

		for (const story of this.stories.values()) {
			const found = story.edits.paragraphOf(part.index, item)

			if (found === undefined) continue

			const pos = paragraphPos(story.edits, found.node, found.pos)

			return pos !== undefined && insideCode(story.edits.document, pos, node => this.fieldCodeShown(node))
		}

		return false
	}

	// Stops laying out and painting pages (another surface shows the document): edits are kept up with and
	// laid out from the first page they changed on resume(). What waits for the layout to finish (an engine's
	// annotations() and locate(), whenSettled()) waits until then.
	suspend(): void {
		if (this.suspendedValue) return

		this.suspendedValue = true
		this.layout.suspend()
		this.changedState()
	}

	resume(): void {
		if (!this.suspendedValue) return

		this.keepUp()
		this.suspendedValue = false

		const layout = this.layout
		const page = this.pendingPage

		this.pendingPage = undefined
		void layout.resume()

		for (const story of this.pendingStories) layout.restory(story)

		this.pendingStories.clear()

		if (page !== undefined) this.advanceFrom(layout.beginEdit(page, undefined))
		else this.refreshStale(this.visible.first, this.visible.last)

		this.changedState()
		this.wakeSettled()
	}

	get suspended(): boolean {
		return this.suspendedValue
	}

	// Resolves once layout has caught up with every edit (what async commands wait for before reading pages).
	whenSettled(): Promise<void> {
		if (this.settled || this.disposed) return Promise.resolve()

		return new Promise(resolve => {
			this.settledWaiters.push(resolve)
		})
	}

	// Lays out from `restart` through the pages in view within the edit's budget, the rest in slices.
	private advanceFrom(restart: number): void {
		const layout = this.layout
		const result = layout.advance(this.now() + this.budget, Math.max(restart, this.visible.last))

		if (result === "fonts") {
			void layout.prepareFonts().then(() => {
				if (!this.disposed) void layout.continue()
			})
		} else if (result === "more") {
			void layout.continue()
		}

		this.flush()
	}

	// The view reports the pages in view; edits lay them out before returning.
	setVisible(first: number, last: number): void {
		this.visible = { first: Math.max(0, first), last: Math.max(first, last) }

		if (!this.suspendedValue) this.refreshStale(first, last)
	}

	// IME composition: the range being composed (or none), drawn underlined.
	setComposition(range: { from: number; to: number } | undefined): void {
		const current = this.compositionRange

		if (current?.from === range?.from && current?.to === range?.to) return

		this.compositionRange = range

		// What a composition typed is marked as a tracked insertion once it ends (never during it).
		if (range === undefined && current !== undefined) flushComposition(this.active.session)

		this.emit({ type: "selection" })
	}

	private onApplied(story: EditedStory, transactions: readonly Transaction[], state: EditorState): void {
		if (this.disposed) return

		this.history.record(story, transactions, state)

		if (!this.commandRunning && this.repeatable !== undefined && transactions.some(tr => tr.docChanged)) this.repeatable = undefined

		let selectionSet = false

		for (const tr of transactions) if (tr.selectionSet || tr.docChanged) selectionSet = true

		if (selectionSet && !this.keepMotion && story === this.active) {
			this.affinityValue = 1
			this.goal = undefined
		}

		// Pages laid out since the last flush are indexed first, with the entries they were laid out from: the
		// change's replaced entries are found on them.
		if (this.changed.size > 0) this.flush()

		this.syncDefinitions()

		if (this.suspendedValue) {
			// No layout reads the story's view meanwhile: it takes the edits at once when needed (keepUp), the
			// writing of edited blocks for layout off the keystroke.
			const last = this.behind[this.behind.length - 1]

			if (last?.story === story) last.pending = foldTransactions(last.pending, transactions) ?? last.pending
			else {
				const pending = foldTransactions(undefined, transactions)

				if (pending !== undefined) this.behind.push({ story, pending })
			}

			if (this.behind.length >= MAX_BEHIND) this.keepUp()
		} else {
			const change = story.edits.applyAll(transactions)

			if (change !== undefined && story.region !== undefined) {
				if (story === this.body) this.relayout(change)
				else this.relayoutStory(story, change)
			}
		}

		this.emit({ type: "selection" })

		// ProseMirror applies what a composition typed last after compositionend (a microtask or its timer
		// later), still as composition: once the composition has ended, that is marked next.
		if (!this.compositionFlushQueued && transactions.some(tr => tr.getMeta("composition") !== undefined)) {
			this.compositionFlushQueued = true
			void Promise.resolve().then(() => {
				this.compositionFlushQueued = false

				if (!this.disposed && this.compositionRange === undefined) flushComposition(story.session)
			})
		}

		// After every listener heard this change (never from inside their loop), and never while composing.
		if (story !== this.active) return

		if (this.edits.view === RevisionView.Markup) {
			this.heads.set(story, state.selection.head)
		} else if (!this.visibilityQueued) {
			this.visibilityQueued = true
			void Promise.resolve().then(() => {
				this.visibilityQueued = false

				if (!this.disposed && this.compositionRange === undefined) this.keepVisible(this.active, this.active.session.state)
			})
		}
	}

	// The caret never rests in text the revision view hides (deletions in Final, insertions in Original):
	// it moves on past it the way it was going, so nothing is typed where it would not show.
	private keepVisible(story: EditedStory, state: EditorState): void {
		const selection = state.selection
		const head = selection.head
		const previous = this.heads.get(story) ?? head

		this.heads.set(story, head)

		const hidden = HIDDEN_MARKS[this.edits.view]

		if (hidden === undefined || !(selection instanceof TextSelection)) return

		const target = visibleFrom(state.doc, head, head >= previous ? 1 : -1, hidden)

		if (target === head) return

		const tr = state.tr.setSelection(TextSelection.create(state.doc, selection.empty ? target : selection.anchor, target))

		story.session.dispatch(tr.setMeta("addToHistory", false))
	}

	// Brings every story's layout view (StoryEdits: its blocks as layout knows them) up to its session's
	// document. While suspended the stories take what they applied only here (on resume, and before what reads
	// them as layout would); other times they are always up to date.
	keepUp(): void {
		if (this.behind.length === 0) return

		if (this.changed.size > 0) this.flush()

		// Taken in the order applied (what edited blocks bring, text boxes, numbers as it did then).
		for (const { story, pending } of this.behind.splice(0)) {
			const change = story.edits.applyPending(pending)

			if (change !== undefined && story.region !== undefined) this.defer(story, change)
		}
	}

	// While suspended: where layout restarts on resume.
	private defer(story: EditedStory, change: StoryChange): void {
		if (story.region === Region.HEADER || story.region === Region.FOOTER) {
			this.pendingStories.add(story.session.story.story.index)

			return
		}

		const page = change.whole
			? 0
			: notePage(
					story,
					story.index.restartPage(
						[...change.replaced, ...change.around],
						story === this.body ? at => this.layout.keepFrom(at) : undefined
					)
				)
		const first = page < 0 ? (story === this.body || !this.edits.addedStory(story.session.story.story.index) ? 0 : undefined) : page

		if (first !== undefined) this.pendingPage = Math.min(this.pendingPage ?? first, first)
	}

	// Lists and styles commands added are laid out as the save will define them.
	private syncDefinitions(): void {
		const context = this.body.session.context
		const planned = this.edits.plan(context.newLists, context.newStyles)

		if (planned !== undefined) this.layout.redefine(planned.styles, planned.numbering)
	}

	// A header or footer changed: every page showing it gets it laid out again (those in view now, the others
	// when shown); a note changed: the body from the page it is on (its area takes room from the body).
	private relayoutStory(story: EditedStory, change: StoryChange): void {
		const layout = this.layout
		const index = story.session.story.story.index

		if (story.region === Region.HEADER || story.region === Region.FOOTER) {
			const first = layout.restory(index)

			if (first >= 0) this.refreshStale(this.visible.first, this.visible.last)
			if (!layout.final) void layout.continue()

			return
		}

		const page = notePage(story, story.index.restartPage([...change.replaced, ...change.around]))

		// A story the editor added that no page shows (nothing refers to it): nothing to lay out. While layout is
		// still under way it may have laid out pages showing it that are not indexed yet: from the last page laid.
		if (page < 0 && this.edits.addedStory(story.session.story.story.index)) {
			if (layout.final) return

			const restart = layout.beginEdit(Math.max(0, layout.pages.length - 1), undefined)

			if (layout.advance(this.now() + this.budget, Math.max(restart, this.visible.last)) !== "done") void layout.continue()

			this.flush()

			return
		}

		// A footnote changes the pages showing it or its reference (and those it moves onto): layout stops once
		// past them where it meets the earlier layout again.
		const restart =
			story.region === Region.FOOTNOTE && page >= 0
				? layout.beginEdit(page, [], story.index.lastPage)
				: layout.beginEdit(page < 0 ? 0 : page, undefined)
		const result = layout.advance(this.now() + this.budget, Math.max(restart, this.visible.last))

		if (result !== "done") void layout.continue()

		this.flush()
	}

	// ---- layout -------------------------------------------------------------------------------------------

	private relayout(change: StoryChange): void {
		const layout = this.layout
		const found = change.whole ? 0 : this.body.index.restartPage([...change.replaced, ...change.around], page => layout.keepFrom(page))
		const laid = layout.pages.length
		// Pages a run under way has not reached show the document as it was: a block found there, or not shown
		// yet, may now end the last page it laid out.
		const first = !layout.final && (found < 0 || found >= laid) ? Math.max(0, laid - 1) : Math.max(0, found)
		const restart = layout.beginEdit(first, change.whole ? undefined : change.dirty)
		// The pages in view after the restart page are laid out now, with what the budget allows beyond.
		const through = Math.max(restart, this.visible.last)
		const result = layout.advance(this.now() + this.budget, through)

		if (result === "fonts") {
			void layout.prepareFonts().then(() => {
				if (!this.disposed) void layout.continue()
			})
		} else if (result === "more") {
			void layout.continue()
		}

		this.flush()
	}

	private onLayout(event: LayoutEvent): void {
		if (this.disposed) return

		if (event.final) {
			this.finalSeen = true

			for (const index of this.layout.dirty) this.changed.add(index)
		} else {
			this.finalSeen = false

			for (let index = event.from; index < event.to; index++) this.changed.add(index)
		}

		if (!this.flushQueued) {
			this.flushQueued = true
			void Promise.resolve().then(() => this.flush())
		}
	}

	// Takes pages the layout laid out into the pages shown and tells the view.
	private flush(): void {
		this.flushQueued = false

		if (this.disposed) return

		const layout = this.layout
		const changed: number[] = []

		for (const index of this.changed) {
			const page = layout.pages[index]

			// A page cut by a restart in the same task as its event stays wanted until the layout is final: a run
			// keeping it from the layout before announces it no more.
			if (page !== undefined || layout.final) this.changed.delete(index)

			if (page === undefined || this.shown[index] === page) continue

			this.shown[index] = page
			this.indexPage(page)
			changed.push(index)
		}

		if (this.finalSeen && layout.final && this.shown.length > layout.pages.length) {
			this.shown.length = layout.pages.length

			for (const story of this.stories.values()) if (story.region !== undefined) story.index.truncate(layout.pages.length)
		}

		if (layout.final) this.refreshStale(this.visible.first, this.visible.last, changed)

		if (changed.length > 0 || layout.final) {
			changed.sort((a, b) => a - b)
			this.emit({ type: "pages", changed, count: this.shown.length, final: layout.final })
		}

		this.wakeSettled()
	}

	private wakeSettled(): void {
		if (this.settledWaiters.length > 0 && this.settled) for (const resolve of this.settledWaiters.splice(0)) resolve()
	}

	// Pages in [first, last] showing outdated page numbers or counts are brought up to date.
	private refreshStale(first: number, last: number, changed?: number[]): void {
		const layout = this.layout

		if (!layout.final || layout.stale.size === 0) return

		const updated: number[] = changed ?? []

		for (let index = Math.max(0, first); index <= last; index++) {
			if (!layout.stale.has(index)) continue

			const result = layout.refresh(index)

			if (result === "done") {
				const page = layout.pages[index]

				if (page !== undefined) {
					this.shown[index] = page
					this.indexPage(page)
					updated.push(index)
				}
			} else {
				// The body shows page numbers too: laid out again from there; or a header or footer changed height:
				// to the end (what its height does to the body is no state layout compares).
				layout.beginEdit(index, result === "numbers" ? [] : undefined)
				void layout.continue()

				return
			}
		}

		if (changed === undefined && updated.length > 0)
			this.emit({ type: "pages", changed: updated, count: this.shown.length, final: true })
	}

	private indexPage(page: PageDisplayList): void {
		// Stories not laid out on pages (comments) have nothing there.
		for (const story of this.stories.values()) if (story.region !== undefined) story.index.index(page)
	}

	// Document commands may be enabled differently now: the snapshot is computed again and listeners hear.
	private changedState(): void {
		this.stateVersion++
		this.emit({ type: "document" })
	}

	private emit(event: PagedEditorEvent): void {
		for (const listener of this.listeners) listener(event)
	}

	// Hears every change of the snapshot of the story being edited (session.subscribe), following story
	// switches; editor events (subscribe) tell the rest.
	subscribeSession(listener: () => void): () => void {
		let stop = this.session.subscribe(listener)
		const stopStory = this.subscribe(event => {
			if (event.type !== "story") return

			stop()
			stop = this.session.subscribe(listener)
		})

		return () => {
			stopStory()
			stop()
		}
	}

	// ---- geometry -----------------------------------------------------------------------------------------

	// Where the caret (the selection's head) is drawn.
	caret(): CaretBox | undefined {
		return this.geometry.locate(this.session.state.selection.head, this.affinityValue)
	}

	// The selection's boxes on page `page` (nothing for an empty selection).
	selectionRects(page: number): PageRect[] {
		const selection = this.session.state.selection

		if (selection.empty) return []

		return this.geometry.rects(selection.from, selection.to, page)
	}

	// Boxes of any range on a page (composition underline, find results, spelling marks).
	rangeRects(from: number, to: number, page: number): PageRect[] {
		return this.geometry.rects(from, to, page)
	}

	// The selection's two ends as drawn (for touch selection handles and a menu next to the selection).
	ends(): { readonly start: CaretBox | undefined; readonly end: CaretBox | undefined } {
		const selection = this.session.state.selection

		return {
			start: this.geometry.locate(selection.from, 1),
			end: this.geometry.locate(selection.to, selection.empty ? this.affinityValue : -1)
		}
	}

	hitTest(page: number, x: number, y: number): HitResult | undefined {
		return this.geometry.hitTest(page, x, y)
	}

	// ---- selection commands -------------------------------------------------------------------------------

	// Puts the caret at a hit (extending the selection from its anchor with `extend`).
	select(hit: HitResult, extend = false): boolean {
		const state = this.session.state
		const doc = state.doc

		if (hit.atom && !extend) {
			const node = doc.nodeAt(hit.pos)

			if (node !== null) return this.apply(state.tr.setSelection(NodeSelection.create(doc, hit.pos)), hit.affinity, undefined)
		}

		const anchor = extend ? state.selection.anchor : hit.pos

		return this.apply(state.tr.setSelection(textSelection(doc, anchor, hit.pos)), hit.affinity, undefined)
	}

	// Selects from `anchor` to the hit (a drag).
	selectRange(anchor: number, hit: HitResult): boolean {
		const state = this.session.state

		return this.apply(state.tr.setSelection(textSelection(state.doc, anchor, hit.pos)), hit.affinity, undefined)
	}

	selectWord(pos: number): boolean {
		const range = this.geometry.wordRange(pos)
		const state = this.session.state

		return this.apply(state.tr.setSelection(textSelection(state.doc, range.from, range.to)), -1, undefined)
	}

	selectParagraph(pos: number): boolean {
		const range = this.geometry.paragraphRange(pos)
		const state = this.session.state

		return this.apply(state.tr.setSelection(textSelection(state.doc, range.from, range.to)), -1, undefined)
	}

	// The caret one line down or up, keeping the x it started from; false at the document's ends.
	moveVertical(dir: 1 | -1, extend: boolean): boolean {
		const state = this.session.state
		const head = state.selection.head
		const caret = this.geometry.locate(head, this.affinityValue)
		const goal = this.goal ?? caret?.x ?? 0
		const hit = this.geometry.verticalMove(head, this.affinityValue, goal, dir)

		if (hit === undefined) {
			// Past the first or last line: the document's start or end.
			const pos = dir > 0 ? endOf(state.doc) : startOf(state.doc)
			const anchor = extend ? state.selection.anchor : pos

			return this.apply(state.tr.setSelection(textSelection(state.doc, anchor, pos)), 1, undefined)
		}

		const anchor = extend ? state.selection.anchor : hit.pos

		return this.apply(state.tr.setSelection(textSelection(state.doc, anchor, hit.pos)), hit.affinity, goal)
	}

	// The caret to the start or end of its line.
	moveLineBoundary(dir: 1 | -1, extend: boolean): boolean {
		const state = this.session.state
		const hit = this.geometry.lineBoundary(state.selection.head, this.affinityValue, dir)

		if (hit === undefined) return false

		const anchor = extend ? state.selection.anchor : hit.pos

		return this.apply(state.tr.setSelection(textSelection(state.doc, anchor, hit.pos)), hit.affinity, undefined)
	}

	// The caret to the document's start or end.
	moveDocumentBoundary(dir: 1 | -1, extend: boolean): boolean {
		const state = this.session.state
		const pos = dir > 0 ? endOf(state.doc) : startOf(state.doc)
		const anchor = extend ? state.selection.anchor : pos

		return this.apply(state.tr.setSelection(textSelection(state.doc, anchor, pos)), 1, undefined)
	}

	// The caret moved by a hit the view found (a page up or down: the point a view height away).
	moveTo(hit: HitResult, extend: boolean, keepGoal: boolean): boolean {
		const state = this.session.state
		const anchor = extend ? state.selection.anchor : hit.pos

		return this.apply(state.tr.setSelection(textSelection(state.doc, anchor, hit.pos)), hit.affinity, keepGoal ? this.goal : undefined)
	}

	// The x vertical motion keeps (the caret's own when none was kept).
	goalX(): number | undefined {
		return this.goal ?? this.caret()?.x
	}

	private apply(tr: Transaction, affinity: Affinity, goal: number | undefined): boolean {
		this.keepMotion = true

		try {
			const applied = this.session.dispatch(tr.scrollIntoView())

			if (applied) {
				this.affinityValue = affinity
				this.goal = goal
				this.emit({ type: "selection" })
			}

			return applied
		} finally {
			this.keepMotion = false
		}
	}
}

// Where layout restarts for a note edit: from the page showing it, or from the page before its reference's
// when that comes first. A note that did not fit takes the line referring to it to the next page, or is left
// for the next page itself: edited, it may fit there now.
function notePage(story: EditedStory, page: number): number {
	const reference = story.index.referencePage

	if (reference < 0) return page

	const before = Math.max(0, reference - 1)

	return page < 0 ? before : Math.min(page, before)
}

function defaultNow(): () => number {
	const performance: unknown = Reflect.get(globalThis, "performance")
	const now: unknown = typeof performance === "object" && performance !== null ? Reflect.get(performance, "now") : undefined

	return typeof now === "function" ? () => (now as () => number).call(performance) : Date.now
}

function textSelection(doc: Node, anchor: number, head: number): Selection {
	const size = doc.content.size
	const $anchor = doc.resolve(Math.max(0, Math.min(anchor, size)))
	const $head = doc.resolve(Math.max(0, Math.min(head, size)))

	return TextSelection.between($anchor, $head)
}

function startOf(doc: Node): number {
	return TextSelection.atStart(doc).from
}

function endOf(doc: Node): number {
	return TextSelection.atEnd(doc).to
}

// Where the body's lines and each other story's lines lie on a page (once per display list).
function regionsOf(list: PageDisplayList): PageRegions {
	const cached = REGIONS.get(list)

	if (cached !== undefined) return cached

	const text = list.text
	const boxes: StoryBox[] = []
	let top = Infinity
	let bottom = -Infinity

	for (let line = 0; line < text.lineCount; line++) {
		const source = text.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? -1
		const region = (list.sourceInts[source * SOURCE_INTS + SourceInt.REGION] ?? -1) as Region
		const story = list.sourceInts[source * SOURCE_INTS + SourceInt.STORY] ?? -1
		const at = line * LINE_FLOATS
		const lineTop = text.lineFloats[at + LineFloat.TOP] ?? 0
		const lineBottom = lineTop + (text.lineFloats[at + LineFloat.HEIGHT] ?? 0)
		const left = text.lineFloats[at + LineFloat.X] ?? 0
		const right = left + (text.lineFloats[at + LineFloat.WIDTH] ?? 0)

		if (source < 0) continue

		if (region === Region.BODY) {
			top = Math.min(top, lineTop)
			bottom = Math.max(bottom, lineBottom)

			continue
		}

		if (story < 0 || !REGION_ORDER.includes(region)) continue

		// One box per column of a story's lines (lines side by side are in other columns).
		const box = boxes.find(entry => entry.region === region && entry.story === story && left < entry.right && right > entry.left)

		if (box === undefined) {
			boxes.push({ region, story, left, top: lineTop, right, bottom: lineBottom })
		} else {
			box.left = Math.min(box.left, left)
			box.top = Math.min(box.top, lineTop)
			box.right = Math.max(box.right, right)
			box.bottom = Math.max(box.bottom, lineBottom)
		}
	}

	const out: PageRegions = { band: top === Infinity ? undefined : { top, bottom }, boxes }

	REGIONS.set(list, out)

	return out
}

// Any story but a note separator (separator, continuation separator or notice).
function ordinaryNote(story: Story): boolean {
	return story.noteType === undefined || story.noteType === "normal"
}

// The position nearest `pos` in direction `dir` that is not inside text marked with `hidden` (inside: hidden on
// both sides; the edges of hidden text are where it stands).
function visibleFrom(doc: Node, pos: number, dir: 1 | -1, hidden: readonly MarkType[]): number {
	const isHidden = (node: Node | null): boolean => node !== null && node.isInline && node.marks.some(mark => hidden.includes(mark.type))
	const $pos = doc.resolve(pos)

	if (!$pos.parent.inlineContent || !isHidden($pos.nodeBefore) || !isHidden($pos.nodeAfter)) return pos

	let at = pos

	for (;;) {
		const $at = doc.resolve(at)
		const next = dir > 0 ? $at.nodeAfter : $at.nodeBefore

		if (!isHidden(next) || next === null) return at

		at += dir * next.nodeSize
	}
}

// Where `paragraph` stands in the story's document as laid out, `at` as an overlay's record has it: checked, and
// looked for in the top-level block there when the record's place is no longer the paragraph's (an edit of the
// block before it moved it), undefined when the block does not hold it.
export function paragraphPos(edits: Pick<StoryEdits, "document" | "starts" | "entryAt">, paragraph: Node, at: number): number | undefined {
	const doc = edits.document

	if (at >= 0 && at < doc.content.size && doc.nodeAt(at) === paragraph) return at

	const index = edits.entryAt(Math.max(0, Math.min(at, doc.content.size - 1)))
	const block = index < doc.childCount ? doc.child(index) : undefined
	const start = edits.starts[index] ?? 0
	let found: number | undefined

	block?.descendants((node, pos) => {
		if (found === undefined && node === paragraph) found = start + 1 + pos

		return found === undefined && !node.isTextblock
	})

	return found
}

// A paragraph's fields in order: field atoms and the begin characters of fields spanning paragraphs.
// Whether the paragraph at `pos` of `doc` lies inside a field spanning paragraphs that shows its code (`shown`,
// asked of its begin character) and does not end in it: the field characters from where its container starts
// to its end leave one open. Such fields are paragraphs of one container (tables of contents), so the walk
// stops at the first sibling that is no paragraph.
function insideCode(doc: Node, pos: number, shown: (begin: Node) => boolean): boolean {
	const $pos = doc.resolve(pos)
	const parent = $pos.parent
	let pending = 0

	for (let index = $pos.index(); index >= 0; index--) {
		const block = parent.child(index)

		if (block.type !== docxSchema.nodes.paragraph) return false

		for (let k = block.childCount - 1; k >= 0; k--) {
			const child = block.child(k)

			if (child.type !== docxSchema.nodes.field_char) continue

			if (child.attrs["kind"] === "end") pending++
			else if (child.attrs["kind"] === "begin" && pending > 0) pending--
			else if (child.attrs["kind"] === "begin" && shown(child)) return true
		}
	}

	return false
}

function fieldsOf(paragraph: Node): Node[] {
	const out: Node[] = []

	paragraph.forEach(child => {
		if (child.type === docxSchema.nodes.field || (child.type === docxSchema.nodes.field_char && child.attrs["kind"] === "begin"))
			out.push(child)
	})

	return out
}
