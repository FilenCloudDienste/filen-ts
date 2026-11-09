import type { Mark, Node } from "prosemirror-model"
import { EditorState, Plugin, TextSelection, type Selection as EditorSelection, type Transaction } from "prosemirror-state"
import { Mapping, StepMap } from "prosemirror-transform"
import { DecorationSet, EditorView } from "prosemirror-view"
import { DocxDocBuilder, FormatResolver, isWriteCommand, type DocxEditorSession } from "../../../core/docx/edit/index"
import type { Story } from "../../../core/docx/model/story"
import { inlineControlAround, legacyFieldOf, type ControlInfo } from "../../../core/docx/forms/controls"
import { RevisionView } from "../../../core/docx/model/kinds"
import { equationView } from "../../../core/docx/layout/objects"
import { modelAuthors } from "../../../core/docx/layout/styles"
import type { OmmlRevisionView } from "../../../core/math/index"
import {
	commandForKey,
	findForKey,
	isRepeatKey,
	joinBackward,
	joinForward,
	lineBreak,
	selectAll,
	splitParagraph,
	type HitResult,
	type PagedEditor
} from "../../../core/docx/paged/index"
import type { ObjectHit, ObjectHitKind } from "../../../core/docx/paged/objects"
import { docxComments } from "../../../core/docx/review/comments"
import { docxNotes } from "../../../core/docx/stories/notes"
import { deletesBreakAtCaret, endsSection, sectionEndOf } from "../../../core/docx/stories/sections"
import type { ClientPoint, DocxEditorInteractions, DocxObjectPress } from "../DocxEditor"
import {
	clipboardParser,
	clipboardSerializer,
	cutMemory,
	type CutMemory,
	plainSlice,
	plainText,
	safeClipboardHtml,
	shownSlice,
	writeClipboardEvent
} from "../edit/clipboard"
import {
	autoLinked,
	composedFormatting,
	deleteBeforeComposition,
	deleteSelectionKey,
	inputTransaction,
	selectionFormatting,
	spaceEndsAddress,
	spaceTransaction
} from "../edit/input"
import type { DocxEditorMark } from "../edit/surface"
import {
	blockIndex,
	changedRange,
	compositionFrom,
	deletesBreakBefore,
	readComposition,
	escapesToHost,
	gapRowCount,
	handFocus,
	LiveStarts,
	mergeWindows,
	ROW_WINDOW_MIN,
	releaseGapText,
	rowsAround,
	sameWindows,
	sessionTransaction,
	tabKey,
	takeFocus,
	unreadSelection,
	windowAround,
	windowedState
} from "../edit/window"
import type { DocxDocument } from "../store"
import { DOCX_MARK_LABELS, sameLabels, type DocxMarkLabels } from "../paint/marks"
import { StoryCounters, markerCopy } from "../../../core/docx/reflow/counters"
import { laidTable, sameTableLook, sourceTable } from "../../../core/docx/reflow/tables"
import { CodeScan, blockPositions, storyDecorations, type ReflowSource, type TableSource } from "./decorate"
import { LayoutFaces } from "./faces"
import { BlockHeights, estimateHeight } from "./heights"
import { reflowMarkViews, reflowNodeViews, type NestedStory, type ReflowNodeHost } from "./nodes"

// The reflowed view: the body's editing session in a visible ProseMirror view that wraps to the width of its
// scroll box, holding only the blocks on screen (and around the selection) while the others are gaps of their
// estimated or measured height, so what the DOM holds, what a keystroke costs and what opening costs do not
// grow with the document. Notes and text boxes are nested views of their own stories. Input is the browser's
// own (touch selection, IME, spellcheck off: the app's is drawn as marks); transactions go to the sessions as
// the paged editor's input sink sends them.

export interface ReflowViewOptions {
	readonly label: string
	// The id of an element describing the editing area (how to leave it from the keyboard).
	readonly describedBy?: string | undefined
	readonly readOnly: boolean
	readonly apple: boolean
	// In the desktop app: the shortcuts the browser owns are the editor's (DocxKeyBinding).
	readonly desktop?: boolean
	readonly onFind: ((replace: boolean) => void) | undefined
	// Sorted by `from`, in the body.
	readonly marks: readonly DocxEditorMark[]
	readonly interactions: DocxEditorInteractions | undefined
	readonly document: DocxDocument
	// The accessible name of a note's or text box's text shown at its reference.
	// A note's text (`mark` its mark as shown, "" for a custom one) or a text box's (`mark` "").
	readonly storyLabel?: ((kind: "footnote" | "endnote" | "textbox", mark: string) => string) | undefined
	// The words formatting marks label breaks with (English by default).
	readonly markLabels?: DocxMarkLabels | undefined
}

// Blocks held on each side of the selection's ends.
const SELECTION_WINDOW = 8
const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph", "Fn", "OS"])
// Rows of a long table held on each side of the selection's ends.
const ROW_MARGIN = 12
// The screens held above and below the one in view.
const OVERSCAN_SCREENS = 1
// The height taken as the view's before it is laid out.
const DEFAULT_HEIGHT = 800
const DEFAULT_WIDTH = 400
const TAP_SLOP = 10
const TAP_MS = 500

const REVISION_VIEWS: Readonly<Record<number, string>> = {
	[RevisionView.Markup]: "markup",
	[RevisionView.Final]: "final",
	[RevisionView.Original]: "original"
}

interface Target {
	readonly kind: ObjectHitKind
	readonly session: ReflowSource
	readonly getPos: () => number | undefined
}

interface Press {
	readonly pointer: number
	readonly x: number
	readonly y: number
	readonly time: number
}

function controlPart(info: ControlInfo): string | undefined {
	if (info.checkbox !== null) return "checkbox"
	if (info.type === "dropDownList" || info.type === "comboBox") return "list"
	if (info.date !== null) return "date"

	return undefined
}

// The positions an edit replaced, as one step map from `before` to `after` (for decorations kept through a
// composition).
function diffMap(before: Node, after: Node): Mapping {
	const start = before.content.findDiffStart(after.content)

	if (start === null) return new Mapping()

	const end = before.content.findDiffEnd(after.content) ?? { a: before.content.size, b: after.content.size }
	const a = Math.max(start, end.a)
	const b = Math.max(start, end.b)

	return new Mapping([new StepMap([start, a - start, b - start])])
}

// One story in a view: the body (windowed) or a note's or text box's (whole).
class StoryView {
	readonly host: ReflowView
	readonly session: DocxEditorSession
	readonly story: number
	readonly view: EditorView
	readonly windowed: boolean
	windows: readonly number[] = []
	// Long tables held with some of their rows only, by top-level index, as last drawn.
	shownTables: ReadonlyMap<number, Node> = new Map()
	private selectionWindows: readonly number[] = []
	private gaps: readonly Node[] = []
	private real: EditorState
	private decorations: DecorationSet = DecorationSet.empty
	private readonly counters: StoryCounters
	private readonly codeScan = new CodeScan()
	private readonly tables: TableSource
	private dispatching = false
	private compositionStart = -1
	// The caret End or typed text left (right after a character on its line), while it is the session's.
	private lineEnd: EditorSelection | undefined
	// Text typed (beforeinput insertText) the view has not read yet.
	private typing = false
	private compositionText = ""
	// What text composed over a selection takes (selectionFormatting), until the composition ends.
	private composeFormatting: readonly Mark[] | undefined = undefined
	private readOnlyShown: boolean
	private rewindowed = false
	// The view exists (its state is first made while it is being made), and was taken down.
	private made = false
	private gone = false

	constructor(host: ReflowView, session: DocxEditorSession, mount: HTMLElement, windowed: boolean, label?: () => string) {
		const editor = host.editor

		this.host = host
		this.session = session
		this.story = session.story.story.index
		this.windowed = windowed
		this.real = session.state
		this.counters = new StoryCounters(editor, session)
		this.tables = windowed
			? (table, index) => {
					const entries = editor.body.edits.entries
					let entry = entries[index]

					// The pages resting, layout's view of the body takes edits only when asked (keepUp): a table blocks
					// came or went before is its own entry still, one edited in its text only looks as its previous
					// version did, else the view catches up.
					if (entry?.node !== table && editor.suspended) {
						const before = entries[index - (session.state.doc.childCount - entries.length)] ?? entry

						if (before !== undefined && (before.node === table || sameTableLook(before.node, table)))
							return laidTable(editor.edits.model, before.laid[0], editor.edits.rows)

						editor.keepUp()
						entry = editor.body.edits.entries[index]
					}

					return entry?.node === table
						? laidTable(editor.edits.model, entry.laid[0], editor.edits.rows)
						: sourceTable(session.story.part, table)
				}
			: table => sourceTable(session.story.part, table)
		this.readOnlyShown = this.readOnly
		host.register(this, mount)

		const nodeHost: ReflowNodeHost = host

		this.view = new EditorView(mount, {
			state: this.viewState(session.state),
			editable: () => !this.readOnly,
			dispatchTransaction: tr => this.dispatch(tr),
			// The session's plugins act on its own state; what stateless ones do in a view (paste, drop) acts here.
			plugins: session.state.plugins.flatMap(plugin =>
				plugin.spec.props === undefined || plugin.spec.state !== undefined ? [] : [new Plugin({ props: plugin.spec.props })]
			),
			nodeViews: reflowNodeViews(nodeHost, session),
			markViews: reflowMarkViews(nodeHost, session),
			decorations: () => this.decorations,
			clipboardSerializer: clipboardSerializer(),
			clipboardParser: clipboardParser(),
			transformPastedHTML: safeClipboardHtml,
			clipboardTextSerializer: () => {
				const state = this.session.state
				const { from, to } = state.selection

				return plainText(state.doc, from, to, this.markerTexts(from, to), host.editor.view)
			},
			clipboardTextParser: (text, $context) => plainSlice(text, $context),
			handlePaste: (_view, event) => this.pasteCut(event.clipboardData?.getData("text/plain")),
			// The view scrolls to the caret itself (ReflowView.scrollToCaret): never ProseMirror's own.
			handleScrollToSelection: () => true,
			handleKeyDown: (_view, event) => this.keyDown(event),
			handleDOMEvents: {
				keydown: (view, event) => {
					// An Escape the editor does not take, in the body's view, is the host's (see escapesToHost).
					if (windowed && escapesToHost(editor, event)) return true
					// Read-only, the view is not editable and ProseMirror's own key handling is off: the app's find and
					// the shortcuts that change nothing.
					if (view.editable || view.composing || event.isComposing || !this.shortcutKey(event, true)) return false

					event.preventDefault()

					return true
				},
				focus: () => {
					host.focused(this)

					return false
				},
				beforeinput: (view, event) => {
					if (event.inputType === "insertText") this.typing = true

					return this.historyInput(event) || this.editInput(view, event)
				},
				copy: (_view, event) => this.copyEvent(event, false),
				cut: (_view, event) => this.copyEvent(event, true),
				compositionstart: view => {
					// Composed over a selection: the selection goes first, as a transaction.
					if (!this.readOnly) {
						this.readSelection()
						this.composeFormatting = selectionFormatting(this.session.state) ?? this.session.typingMarks(this.session.state)
						this.run(deleteBeforeComposition(this.session.state))
					}

					this.compositionStart = view.state.selection.from
					this.compositionText = ""

					return false
				},
				compositionupdate: (_view, event) => {
					this.compositionText = event.data

					return false
				},
				compositionend: (view, event) => {
					readComposition(view)
					this.formatComposed(typeof event.data === "string" ? event.data : this.compositionText)
					this.compositionStart = -1
					this.compositionText = ""
					editor.setComposition(undefined)
					// What waited for the composition to end (blocks scrolled into view) is done now.
					queueMicrotask(() => this.host.afterComposition(this))

					return false
				}
			},
			attributes: () => ({
				role: "textbox",
				"aria-multiline": "true",
				"aria-label": label?.() ?? host.label,
				...(host.describedBy === undefined ? {} : { "aria-describedby": host.describedBy }),
				// The app's spelling is drawn as marks: the browser's own would mark the same words again.
				spellcheck: "false",
				translate: "no",
				class: windowed ? "fo-docx-reflow-doc" : "fo-docx-reflow-doc fo-docx-reflow-nested",
				...(this.readOnly ? { "aria-readonly": "true" } : {})
			})
		})
		// After ProseMirror's own dragstart (which writes the raw selection): a drag out writes what the revision
		// view shows, as a copy does. A move inside the editor takes view.dragging's slice, left whole.
		this.view.dom.addEventListener("dragstart", this.dragStart)
		this.made = true
	}

	private readonly dragStart = (event: DragEvent): void => {
		const data = event.dataTransfer

		if (data === null || this.view.dragging === null || this.host.editor.view === RevisionView.Markup) return

		const content = this.clipboardContent()

		if (content === undefined) return

		data.setData("text/html", content.html)
		data.setData("text/plain", content.text)
	}

	private get viewComposing(): boolean {
		return this.made && this.view.composing
	}

	get readOnly(): boolean {
		return this.host.readOnlyOption || this.session.readOnly
	}

	destroy(): void {
		this.gone = true
		this.host.unregister(this)
		this.view.dom.removeEventListener("dragstart", this.dragStart)
		this.view.destroy()
	}

	// The view's editability and attributes follow read-only.
	refreshReadOnly(): void {
		const readOnly = this.readOnly

		if (readOnly === this.readOnlyShown) return

		this.readOnlyShown = readOnly
		this.view.setProps({})
	}

	// Brings the view to the session's state; `force`: also when that did not change (the view's DOM may differ
	// from its state after a refused change).
	sync(force = false): void {
		const real = this.session.state

		if (real === this.real && !force) return

		if (real.doc !== this.real.doc) this.host.changed(this, this.real.doc, real.doc)

		const state = real === this.real ? this.view.state : this.viewState(real)

		this.real = real
		this.view.updateState(state)
		this.host.rendered(this)
	}

	// Brings the view to a session state made elsewhere (a command, another story's view), a caret move the
	// browser made that the view has not read yet taken into the session first (unreadSelection).
	follow(): void {
		this.readSelection()
		this.sync()
	}

	private readSelection(): void {
		// The view's positions are the session's only while its document is the one the view shows.
		if (this.session.state.doc !== this.real.doc) return

		const tr = unreadSelection(this.view)

		if (tr !== undefined) this.dispatch(tr)
	}

	// Fields may show their codes or results otherwise (the editor's view of them changed).
	recode(): void {
		this.codeScan.reset()
		this.counters.invalidate(-1)
		this.redraw()
	}

	// Takes the blocks in view anew (scrolling) or draws decorations anew (marks, look): never while composing.
	redraw(): void {
		if (this.gone) return

		if (this.view.composing) {
			this.rewindowed = true

			return
		}

		this.readSelection()
		this.view.updateState(this.viewState(this.real))
		this.host.rendered(this)
	}

	afterComposition(): void {
		if (!this.rewindowed) return

		this.rewindowed = false
		this.redraw()
	}

	// The view's state for the session's `real`: the blocks held (windowed) and its decorations.
	private viewState(real: EditorState): EditorState {
		const doc = real.doc
		const host = this.host
		let state: EditorState
		let windows: readonly number[] | undefined

		if (this.windowed) {
			const story = host.starts
			const { from, to } = real.selection
			const a = blockIndex(doc, story, from)
			const b = Math.max(a, blockIndex(doc, story, to))

			this.selectionWindows = windowAround(this.selectionWindows, a, b, doc.childCount, SELECTION_WINDOW)

			// Composing, the blocks stay what they were (the text being composed must not be drawn again).
			const merged = !this.viewComposing ? mergeWindows(this.selectionWindows, host.viewportWindow(doc)) : this.windows

			windows = sameWindows(merged, this.windows) ? this.windows : merged
			this.windows = windows

			const reference = host.pinned()
			const pinned = reference === undefined ? [] : [reference]
			const windowed = windowedState(real, windows, story, this.gaps, (index, table, pos) =>
				mergeWindows(rowsAround(table, pos, [from, to, ...pinned], ROW_MARGIN), host.screenRows(index))
			)

			this.gaps = windowed.gaps
			this.shownTables = windowed.tables
			state = windowed.state
		} else {
			state = windowedState(real, [0, doc.childCount], undefined, []).state
		}

		this.decorations = this.viewComposing
			? this.decorations.map(diffMap(this.view.state.doc, state.doc), state.doc)
			: storyDecorations({
					session: this.session,
					doc: real.doc,
					shown: state.doc,
					windows,
					starts: this.windowed ? host.starts : undefined,
					counters: this.counters,
					faces: host.faces,
					facesVersion: host.facesVersion,
					view: host.editor.view,
					marks: this.windowed ? host.marks : [],
					tables: this.tables,
					codeShown: field => host.editor.fieldCodeShown(field),
					codeScan: this.windowed ? this.codeScan : undefined,
					shownTables: this.shownTables,
					formattingMarks: host.formattingMarks
				})

		return state
	}

	// The list markers of the paragraphs in [from, to) as a copy writes them before their text (the paged
	// layout, resting, has none to give).
	private markerTexts(from: number, to: number): (pos: number) => string {
		const doc = this.session.state.doc
		const starts = this.windowed ? this.host.starts : undefined
		const texts = new Map<number, string>()

		this.counters.count(
			this.session,
			doc,
			blockIndex(doc, starts, from),
			blockIndex(doc, starts, to) + 1,
			blockPositions(doc, starts),
			(pos, text, paragraph, suffix) => texts.set(pos, markerCopy(this.session, paragraph, text, suffix)),
			() => undefined,
			(start, end) => start < to && end > from
		)

		return pos => texts.get(pos) ?? ""
	}

	invalidateCounters(index: number): void {
		this.counters.invalidate(index)
		this.codeScan.invalidate(index)
	}

	// A transaction of the view: applied to the session's state (positions are the same), and the view brought
	// to the result (whatever the browser changed that the session did not take is put back).
	private dispatch(viewTr: Transaction): void {
		const tr = viewTr.docChanged && this.readOnly ? undefined : sessionTransaction(viewTr, this.view.state.doc, this.session.state)

		if (tr === undefined) {
			this.sync(true)

			return
		}

		this.apply(tr, true)
	}

	// Applies a transaction on the session's state; `fromView`: it came from the view, which is brought up to
	// date even when the session refused it.
	apply(tr: Transaction, fromView = false): void {
		const editor = this.host.editor

		if (tr.docChanged && this.readOnly) {
			this.sync(fromView)

			return
		}

		if (this.compositionStart >= 0 && tr.docChanged) this.compositionStart = tr.mapping.map(this.compositionStart, -1)

		const event: unknown = tr.getMeta("uiEvent")

		// A pasted reference to a note that stays referenced elsewhere refers to a copy of it; a paste whose note
		// cannot be copied whole is refused.
		if ((event === "paste" || event === "drop") && !docxNotes(editor).pasted(tr)) {
			this.sync(fromView)

			return
		}

		// Typed in this view (it has focus): editing is in its story. A change the view read from its DOM while
		// another story's view has focus (a node view drawn anew) moves nothing.
		if (this.view.hasFocus()) this.host.enter(this)

		// The top-level blocks the change touches, found from its steps (what the body's heights and counters
		// redo), before the session's document moves on.
		if (this.windowed && tr.docChanged) {
			const changed = changedRange(tr)
			const story = this.host.starts
			const doc = tr.before

			this.host.hint(
				doc,
				changed === undefined ? undefined : [blockIndex(doc, story, changed.from), blockIndex(doc, story, changed.to)]
			)
		}

		this.dispatching = true

		try {
			this.session.dispatch(tr)
		} finally {
			this.dispatching = false
		}

		if (this.typing && fromView && tr.docChanged) {
			const selection = this.session.state.selection

			this.typing = false
			this.lineEnd = selection.empty ? selection : undefined
		}

		this.sync(fromView)

		if (this.view.composing && this.compositionStart >= 0) {
			const state = this.session.state
			const from = compositionFrom(state.doc, state.selection.head, this.compositionStart, this.compositionText)

			this.compositionStart = from
			editor.setComposition({
				from,
				to: this.compositionText.length > 0 ? from + this.compositionText.length : Math.max(from, state.selection.head)
			})
		}
	}

	get applying(): boolean {
		return this.dispatching
	}

	// A command's transaction on the session's state.
	run(tr: Transaction | null | false): boolean {
		if (tr === null) return false
		if (tr !== false) this.apply(tr)

		return true
	}

	// beforeinput historyUndo / historyRedo: the editor undoes or redoes in its order across stories.
	private historyInput(event: InputEvent): boolean {
		const type = event.inputType === "historyUndo" ? "history.undo" : event.inputType === "historyRedo" ? "history.redo" : undefined

		if (type === undefined) return false

		event.preventDefault()

		if (!this.readOnly) void this.host.editor.execute({ type })

		return true
	}

	// A composition that started over a selection ends: its text gets the formatting it takes, wherever the
	// browser composed it (it composes into the run its selection ended in).
	private formatComposed(text: string): void {
		const formatting = this.composeFormatting

		this.composeFormatting = undefined

		if (formatting === undefined || this.compositionStart < 0 || this.readOnly) return

		const state = this.session.state
		const from = compositionFrom(state.doc, state.selection.head, this.compositionStart, text)

		this.run(composedFormatting(state, from, text, formatting))
	}

	// beforeinput that would edit the DOM across runs (see inputTransaction): made on the session's state.
	private editInput(view: EditorView, event: InputEvent): boolean {
		if (this.readOnly || !event.cancelable) return false

		this.readSelection()

		const session = this.session
		const tr = inputTransaction(view, session.state, event, state => session.typingMarks(state))
		const linking = spaceEndsAddress(view, session, event)
		const typed = tr ?? (linking ? spaceTransaction(session) : undefined)

		if (typed === undefined) return false

		event.preventDefault()

		if (!linking) this.run(typed)
		else
			autoLinked(
				session,
				() => this.run(typed),
				link => this.run(link)
			)

		// Typed text leaves the caret right after a character on its line (see lineEnd).
		if (this.typing) {
			const selection = this.session.state.selection

			this.typing = false
			this.lineEnd = selection.empty ? selection : undefined
		}

		return true
	}

	// The selection as a copy writes it, or undefined when it is empty.
	clipboardContent(): { readonly html: string; readonly text: string } | undefined {
		const state = this.session.state

		if (state.selection.empty) return undefined

		const { dom, text } = this.view.serializeForClipboard(shownSlice(state.selection.content(), this.host.editor.view))

		return { html: dom.innerHTML, text }
	}

	// A copy or cut writes the session's selection, as ProseMirror's own would write the view's.
	private copyEvent(event: ClipboardEvent, cut: boolean): boolean {
		const content = event.clipboardData === null ? undefined : this.clipboardContent()

		if (!writeClipboardEvent(event, content) || content === undefined) return false

		this.host.cut.forget()

		if (cut && !this.readOnly) {
			this.host.cut.remember(this.session, () => content.text)
			this.apply(this.session.state.tr.deleteSelection().setMeta("uiEvent", "cut"))
		}

		return true
	}

	deleteSelection(): boolean {
		if (this.readOnly || this.session.state.selection.empty) return false

		this.host.cut.remember(this.session, slice => this.view.serializeForClipboard(slice).text)

		return this.run(this.session.state.tr.deleteSelection())
	}

	paste(content: { readonly html?: string; readonly text?: string }): boolean {
		if (this.readOnly) return false
		if (this.pasteCut(content.text)) return true
		if (content.html !== undefined && content.html.length > 0) return this.view.pasteHTML(content.html)
		if (content.text !== undefined && content.text.length > 0) return this.view.pasteText(content.text)

		return false
	}

	private pasteCut(text: string | undefined): boolean {
		if (this.readOnly) return false

		const tr = this.host.cut.take(this.host.editor, this.session, text)

		return tr === undefined ? false : this.run(tr)
	}

	selectAll(): boolean {
		return this.run(selectAll(this.session.state))
	}

	// Whether a line wraps at `pos` (it ends one line and starts the next).
	private wrapsAt(pos: number): boolean {
		if (this.session.state.doc !== this.real.doc) return false

		try {
			return Math.abs(this.view.coordsAtPos(pos, -1).top - this.view.coordsAtPos(pos, 1).top) > 1
		} catch {
			return false
		}
	}

	// Keys the view handles itself; caret motion is the browser's (the text is where it is drawn).
	private keyDown(event: KeyboardEvent): boolean {
		// A modifier pressed alone (Shift before Shift+Home) changes nothing.
		if (this.view.composing || event.isComposing || MODIFIER_KEYS.has(event.key)) return false

		const lineEnd = this.lineEnd

		this.lineEnd = undefined
		this.typing = false

		const host = this.host
		const editor = host.editor
		const apple = host.apple
		const mod = apple ? event.metaKey : event.ctrlKey
		const extend = event.shiftKey
		const readOnly = this.readOnly

		host.enter(this)

		const state = this.session.state

		switch (event.key) {
			case "Home":
			case "End": {
				// The document's start or end: the view holds it once the caret is there.
				if (mod) return this.windowed && editor.moveDocumentBoundary(event.key === "End" ? 1 : -1, extend)
				if (event.altKey || event.ctrlKey || event.metaKey) return false

				// The line's start or end, as on the pages (Safari on a Mac only scrolls).
				const selection = this.view.dom.ownerDocument.getSelection()

				if (selection === null || typeof selection.modify !== "function") return false

				const alter = extend ? "extend" : "move"
				const end = event.key === "End"
				const from = state.selection.head

				// The end of a line that wraps is where the next line starts, and the browser takes a caret End or
				// typing put there for the next line's (ProseMirror redraws the selection without the side it was
				// on): from there both keys step back over the character before it first, as Word's stay on the
				// line the caret ends.
				const upstream = state.selection === lineEnd && (extend || state.selection.empty) && this.wrapsAt(from)

				if (upstream) selection.modify(alter, "backward", "character")

				selection.modify(alter, end ? "forward" : "backward", "lineboundary")
				this.readSelection()

				const after = this.session.state.selection

				if (end && (after.head > from || upstream)) this.lineEnd = after

				return true
			}
			case "Enter":
				if (event.altKey || readOnly) return false
				// Mod+Enter: the page break's shortcut.
				if (mod) break

				return autoLinked(
					this.session,
					() => this.run(extend ? lineBreak(state) : splitParagraph(state, this.session.formats)),
					tr => this.run(tr)
				)
			case "Tab":
				return (
					!readOnly &&
					autoLinked(
						this.session,
						() => tabKey(editor, this.session, event, apple, tr => this.run(tr)),
						tr => this.run(tr)
					)
				)
			case "Backspace":
				if (readOnly) return false
				if (this.windowed && deletesBreakBefore(editor)) return true

				this.readSelection()

				return this.run(deleteSelectionKey(this.session.state) ?? joinBackward(this.session.state, this.session.formats))
			case "Delete":
				if (readOnly || extend) return false

				if (this.windowed && deletesBreakAtCaret(editor)) {
					void editor.execute({ type: "section.deleteBreak" })

					return true
				}

				this.readSelection()

				return this.run(deleteSelectionKey(this.session.state) ?? joinForward(this.session.state))
			case "Escape":
				if (editor.painter !== undefined) {
					editor.setPainter(undefined)

					return true
				}

				// Out of a note or text box, back to the body at its reference.
				if (this.windowed) return false

				host.leave(this)

				return true
		}

		if (mod && !event.altKey && !extend) {
			const key = event.key.toLowerCase()

			if (key === "a") return this.selectAll()
		}

		return this.shortcutKey(event, readOnly)
	}

	// The app's find, Repeat and the editor commands' shortcuts; read-only only what changes nothing (the view:
	// Alt+F9), as the host runs it.
	private shortcutKey(event: KeyboardEvent, readOnly: boolean): boolean {
		const host = this.host
		const editor = host.editor
		const apple = host.apple
		const find = findForKey(event, apple)

		if (find !== undefined) {
			host.find(find === "replace")

			return host.canFind
		}

		if (!readOnly && isRepeatKey(event, apple)) return editor.repeat()

		const command = commandForKey(event, apple, host.desktop)

		if (command === undefined || (readOnly && isWriteCommand(command.type))) return false

		host.enter(this)
		void editor.execute(command)

		return true
	}

	// The position under a point on screen in this story.
	positionAt(clientX: number, clientY: number): number | undefined {
		return this.view.posAtCoords({ left: clientX, top: clientY })?.pos
	}

	focus(): void {
		const dom = this.view.dom

		dom.focus({ preventScroll: true })
		this.view.focus()
	}
}

// A note or text box shown, not edited: its story's document built for showing (no editing session is made for
// a note scrolled past), drawn as the editable views draw it, until it is made editable (ReflowView.nest).
class ShownStory {
	readonly view: EditorView
	private readonly host: ReflowView
	private readonly source: ReflowSource
	private readonly counters: StoryCounters
	private decorations: DecorationSet

	constructor(host: ReflowView, story: Story, mount: HTMLElement) {
		const context = host.editor.body.session.context
		const built = new DocxDocBuilder(context).build(story)

		this.host = host
		this.source = {
			formats: new FormatResolver(context, built.part),
			context,
			story: built,
			state: EditorState.create({ doc: built.doc })
		}
		this.counters = new StoryCounters(host.editor, this.source)
		this.decorations = this.decorate()
		host.register(this)
		this.view = new EditorView(mount, {
			state: this.source.state,
			editable: () => false,
			nodeViews: reflowNodeViews(host, this.source),
			markViews: reflowMarkViews(host, this.source),
			decorations: () => this.decorations,
			attributes: { class: "fo-docx-reflow-doc fo-docx-reflow-nested", translate: "no" }
		})
	}

	private decorate(): DecorationSet {
		const host = this.host
		const part = this.source.story.part

		return storyDecorations({
			session: this.source,
			doc: this.source.state.doc,
			windows: undefined,
			starts: undefined,
			counters: this.counters,
			faces: host.faces,
			facesVersion: host.facesVersion,
			view: host.editor.view,
			marks: [],
			tables: table => sourceTable(part, table),
			codeShown: field => host.editor.fieldCodeShown(field),
			codeScan: undefined,
			formattingMarks: host.formattingMarks
		})
	}

	redraw(): void {
		this.decorations = this.decorate()
		this.view.updateState(this.view.state)
	}

	destroy(): void {
		this.host.unregister(this)
		this.view.destroy()
	}
}

export class ReflowView implements ReflowNodeHost {
	readonly editor: PagedEditor
	readonly scroller: HTMLElement
	readonly heights = new BlockHeights()
	readonly cut: CutMemory
	readonly main: StoryView
	private options: ReflowViewOptions
	private readonly layoutFaces: LayoutFaces
	private readonly content: HTMLElement
	private readonly stories = new Map<HTMLElement, StoryView>()
	private readonly targets = new WeakMap<Element, Target>()
	// Where each nested story's reference is in the body (the story being edited keeps its block held), how each
	// is made editable, the stories only shown, and the reference of a story entered while not shown.
	private readonly pins = new Map<number, () => number | undefined>()
	private readonly editors = new Map<number, () => StoryView | undefined>()
	private readonly shown = new Set<ShownStory>()
	private readonly refreshers = new Set<() => void>()
	private entered: { readonly story: number; readonly pos: number } | undefined
	// The blocks the keystroke being applied touches (see hint).
	private edited: { readonly doc: Node; readonly blocks: readonly [number, number] } | undefined
	// The blocks held for the screen ([from, to)), the gaps' boxes and the blocks' elements as last drawn.
	private viewport: readonly number[] = []
	// Of long tables on screen (by top-level index), the rows held for it ([from, to)); rows' measured heights; the
	// rows drawn, by element.
	private tableRows = new Map<number, readonly number[]>()
	private readonly rowHeights = new WeakMap<Node, number>()
	private rows = new Map<Element, Node>()
	private gapBoxes: { readonly element: HTMLElement; readonly from: number; readonly to: number }[] = []
	private blocks = new Map<Element, number>()
	private readonly blockObserver: ResizeObserver | undefined
	private readonly boxObserver: ResizeObserver | undefined
	private width = 0
	private frame = 0
	private work = { viewport: false, caret: false }
	private press: Press | undefined
	private handleFixed: { readonly end: "start" | "end"; readonly fixed: number } | undefined
	private readonly stopListening: () => void
	private readonly cleanups: (() => void)[] = []
	// Where the body's top-level blocks start, kept up edit by edit (layout's view of it is behind while the
	// pages rest).
	readonly starts: LiveStarts
	private warmed = false
	private equations: { readonly view: RevisionView; readonly value: OmmlRevisionView } | undefined
	private destroyed = false

	constructor(editor: PagedEditor, scroller: HTMLElement, options: ReflowViewOptions) {
		this.editor = editor
		this.scroller = scroller
		this.options = options
		this.cut = cutMemory(editor)
		this.layoutFaces = new LayoutFaces(editor)
		this.layoutFaces.refresh()
		this.width = scroller.clientWidth > 0 ? scroller.clientWidth : DEFAULT_WIDTH

		// Headers and footers are not shown here: editing goes back to the body, and their commands are off.
		if (editor.activeStory !== editor.body.session.story.story.index) {
			const active = editor.storySession(editor.activeStory)?.story.story.kind

			if (active === "header" || active === "footer") editor.exitStory()
		}

		editor.setHeadersShown(false)

		const doc = editor.body.session.state.doc
		const starts = new LiveStarts(doc)

		this.starts = starts
		this.cleanups.push(editor.body.session.onApplied(transactions => starts.applyAll(transactions)))
		this.heights.reset(doc, this.width)

		// The caret's block on screen a third of the way down.
		const caret = blockIndex(doc, starts, editor.body.session.state.selection.head)
		const top = Math.max(0, this.heights.top(caret) - this.screen() / 3)

		this.viewport = this.viewportAt(top)
		this.tableRows = this.rowsOnScreen(
			doc,
			this.viewport[0] ?? 0,
			(this.viewport[1] ?? 0) - 1,
			top - this.screen(),
			top + 2 * this.screen()
		)
		this.content = document.createElement("div")
		this.content.className = "fo-docx-reflow-content"
		scroller.appendChild(this.content)
		this.blockObserver = typeof ResizeObserver === "function" ? new ResizeObserver(entries => this.measured(entries)) : undefined
		this.boxObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.resized()) : undefined
		this.boxObserver?.observe(scroller)
		this.main = new StoryView(this, editor.body.session, this.content, true)
		this.rendered(this.main)
		this.showRevisions()
		this.showMarks()
		scroller.scrollTop = top + this.origin()

		const listen = <K extends keyof HTMLElementEventMap>(
			type: K,
			listener: (event: HTMLElementEventMap[K]) => void,
			capture = false
		): void => {
			scroller.addEventListener(type, listener, { capture, passive: type === "scroll" })
			this.cleanups.push(() => scroller.removeEventListener(type, listener, { capture }))
		}

		listen("scroll", () => this.request({ viewport: true }))
		listen("pointerdown", event => this.pointerDown(event), true)
		listen("pointerup", event => this.pointerUp(event), true)
		listen("pointercancel", () => {
			this.press = undefined
		})
		listen("focusin", () => {
			scroller.dataset["foFocused"] = ""
		})
		listen("focusout", event => {
			if (!(event.relatedTarget instanceof globalThis.Node && scroller.contains(event.relatedTarget)))
				delete scroller.dataset["foFocused"]
		})

		this.stopListening = editor.subscribe(event => {
			if (event.type === "pages") {
				// The faces fonts draw with: every paragraph's look and run decorations anew (in place).
				if (this.layoutFaces.refresh()) this.refresh()

				return
			}

			if (event.type === "document") {
				// Another revision view: equations are painted anew for it (their trees differ per view) and tables'
				// banding counts the rows it shows, in place.
				if (this.showRevisions()) this.refresh()

				// Formatting marks shown or hidden: the stories only shown drawn anew (the others are below).
				if (this.showMarks()) for (const shown of [...this.shown]) shown.redraw()

				// The view of field codes may have changed: decorations drawn anew.
				for (const story of [...this.stories.values()]) {
					story.refreshReadOnly()
					story.recode()
				}
			}

			for (const story of this.stories.values()) if (!story.applying) story.follow()

			if (event.type === "story") this.storyEntered()

			this.request({ caret: true })
		})

		this.request({ caret: true })
		this.warmUp()

		// Shown in place of a view that had focus: typing goes on here.
		if (takeFocus(editor)) this.focus()
	}

	// ---- what the nodes and stories ask -------------------------------------------------------------------------

	get document(): DocxDocument {
		return this.options.document
	}

	get faces(): (family: string) => string | undefined {
		return this.layoutFaces.faces
	}

	get facesVersion(): number {
		return this.layoutFaces.version
	}

	get label(): string {
		return this.options.label
	}

	get describedBy(): string | undefined {
		return this.options.describedBy
	}

	get apple(): boolean {
		return this.options.apple
	}

	get desktop(): boolean {
		return this.options.desktop === true
	}

	get readOnlyOption(): boolean {
		return this.options.readOnly
	}

	get marks(): readonly DocxEditorMark[] {
		return this.options.marks
	}

	// The accessible name of a note's (its mark as shown: "3", "" for none) or text box's text (the document's
	// name when the app gives none).
	storyLabel(kind: string, mark: string): string {
		return this.options.storyLabel?.(kind === "footnote" || kind === "endnote" ? kind : "textbox", mark) ?? this.options.label
	}

	get canFind(): boolean {
		return this.options.onFind !== undefined
	}

	find(replace: boolean): void {
		this.options.onFind?.(replace)
	}

	unregister(story: StoryView | ShownStory): void {
		if (story instanceof ShownStory) {
			this.shown.delete(story)

			return
		}

		for (const [mount, other] of this.stories) if (other === story) this.stories.delete(mount)
	}

	// Shows story `story` in `mount`: editable when it has a session (it was edited or is being edited), else
	// only shown (no session is made for a note scrolled past) until a press, focus or the editor going there
	// makes it editable.
	nest(story: number, mount: HTMLElement, at: () => number | undefined, mark: () => string = () => ""): NestedStory {
		const editor = this.editor
		const target = editor.edits.model.stories[story]

		if (target === undefined || this.destroyed) return { release: () => undefined, relabel: () => undefined }

		let editable: StoryView | undefined
		let shown: ShownStory | undefined
		const kind = target.kind
		const label = (): string => this.storyLabel(kind, mark())
		const edit = (): StoryView | undefined => {
			if (editable !== undefined || this.destroyed) return editable

			const session = editor.storySession(story)

			if (session === undefined) return undefined

			shown?.destroy()
			shown = undefined
			mount.removeAttribute("tabindex")
			editable = new StoryView(this, session, mount, false, label)

			return editable
		}
		const pointer = (event: PointerEvent): void => {
			if (editable !== undefined || event.button !== 0) return

			const view = edit()

			if (view === undefined) return

			// The press lands where it was made, now in the editable story.
			const pos = view.positionAt(event.clientX, event.clientY)

			event.preventDefault()
			view.focus()

			if (pos !== undefined) view.view.dispatch(view.view.state.tr.setSelection(TextSelection.near(view.view.state.doc.resolve(pos))))
		}
		const focus = (): void => {
			if (editable === undefined) edit()?.focus()
		}

		mount.setAttribute("aria-label", label())

		if (editor.sessions.some(session => session.story.story.index === story)) edit()
		else {
			shown = new ShownStory(this, target, mount)
			// Reachable from the keyboard: focusing it makes it editable.
			mount.tabIndex = 0
		}

		mount.addEventListener("pointerdown", pointer, true)
		mount.addEventListener("focusin", focus)
		this.pins.set(story, at)
		this.editors.set(story, edit)

		const relabel = (): void => {
			// An editable story's name is its view's attribute (drawn again with it).
			if (editable !== undefined) editable.view.setProps({})
			else mount.setAttribute("aria-label", label())
		}
		const release = (): void => {
			const focused = editable?.view.hasFocus() === true

			mount.removeEventListener("pointerdown", pointer, true)
			mount.removeEventListener("focusin", focus)
			shown?.destroy()
			editable?.destroy()

			if (this.pins.get(story) === at) this.pins.delete(story)
			if (this.editors.get(story) === edit) this.editors.delete(story)
			if (this.destroyed) return

			// A node view made anew (its paragraph drawn again) shows the story again at once: editing stays in it
			// (focus too). Only when its reference went does editing go back to the body.
			queueMicrotask(() => {
				if (this.destroyed) return

				const again = this.editors.get(story)

				if (again !== undefined) {
					if (focused) again()?.focus()
				} else if (this.editor.activeStory === story) {
					this.editor.exitStory()
				}
			})
		}

		return { release, relabel }
	}

	// Editing went to another story: a note or text box shown is made editable and takes focus (from the
	// keyboard, note.goto, review.next); one not shown has its reference block held, then made so. A header or
	// footer is left at once.
	private storyEntered(): void {
		const editor = this.editor
		const active = editor.activeStory

		if (active === editor.body.session.story.story.index) return

		const kind = editor.edits.model.stories[active]?.kind

		// Mobile view shows no headers or footers (as Word's): editing does not go to one (once the editor's
		// story change is done).
		if (kind === "header" || kind === "footer") {
			queueMicrotask(() => {
				if (!this.destroyed && editor.activeStory === active) editor.exitStory()
			})

			return
		}

		const edit = this.editors.get(active)

		if (edit !== undefined) {
			const view = edit()

			if (view !== undefined && !view.view.hasFocus() && this.hadFocus()) view.focus()

			return
		}

		// Its reference off the screen: found once (the story was entered), held, and shown.
		const note = docxNotes(editor).at()

		if (note === undefined || note.reference < 0) return

		this.entered = { story: active, pos: note.reference }
		this.main.redraw()

		const view = this.editors.get(active)?.()

		if (view !== undefined && this.hadFocus()) view.focus()
	}

	private hadFocus(): boolean {
		const active = this.scroller.ownerDocument.activeElement

		return active !== null && this.scroller.contains(active)
	}

	// Called again when the faces fonts draw with or the revision view change (a paragraph's look, an equation).
	live(refresh: () => void): () => void {
		this.refreshers.add(refresh)

		return () => {
			this.refreshers.delete(refresh)
		}
	}

	private refresh(): void {
		for (const refresh of [...this.refreshers]) refresh()
		for (const story of [...this.stories.values()]) story.redraw()
		for (const shown of [...this.shown]) shown.redraw()
	}

	register(story: ShownStory): void
	register(story: StoryView, mount: HTMLElement): void
	register(story: StoryView | ShownStory, mount?: HTMLElement): void {
		if (story instanceof ShownStory) {
			this.shown.add(story)

			return
		}

		if (mount === undefined) return

		mount.classList.add("fo-docx-reflow-story")
		this.stories.set(mount, story)
	}

	target(element: HTMLElement, kind: ObjectHitKind, session: ReflowSource, getPos: () => number | undefined): void {
		this.targets.set(element, { kind, session, getPos })
	}

	// Editing moves to the story of the view that took focus or input.
	focused(story: StoryView): void {
		this.enter(story)
	}

	enter(story: StoryView): void {
		const editor = this.editor

		if (editor.activeStory === story.story) return

		if (story === this.main) editor.exitStory()
		else editor.enterStory(story.story, -1)
	}

	// Escape from a note or text box: back to the body, its caret where it was (as on the pages).
	leave(story: StoryView): void {
		this.enter(story)
		this.editor.exitStory()
		this.main.focus()
		this.request({ caret: true })
	}

	afterComposition(story: StoryView): void {
		story.afterComposition()
	}

	// ---- the body's blocks, their heights and the screen --------------------------------------------------------

	// The view's height, or what it is taken to be before it is laid out.
	private screen(): number {
		return this.scroller.clientHeight > 0 ? this.scroller.clientHeight : DEFAULT_HEIGHT
	}

	// Where the body's blocks start in the scroll box.
	private origin(): number {
		return this.content.offsetTop
	}

	// The blocks to hold for a screen whose top is `top` (in the blocks' coordinates), a screen more each way.
	private viewportAt(top: number): readonly number[] {
		const screen = this.screen()
		const over = screen * OVERSCAN_SCREENS
		const count = this.heights.count

		return count === 0 ? [] : [this.heights.indexAt(top - over), Math.min(count, this.heights.indexAt(top + screen + over) + 1)]
	}

	// The rows of long table `index` on screen (a screen more each way).
	screenRows(index: number): readonly number[] {
		return this.tableRows.get(index) ?? []
	}

	private rowHeight(row: Node): number {
		return this.rowHeights.get(row) ?? estimateHeight(row, this.width)
	}

	// The rows of the long tables among blocks [first, last] that are within [top, bottom) (the blocks' offsets).
	private rowsOnScreen(doc: Node, first: number, last: number, top: number, bottom: number): Map<number, readonly number[]> {
		const out = new Map<number, readonly number[]>()

		for (let index = first; index <= last && index < doc.childCount; index++) {
			const table = doc.child(index)

			if (table.type.name !== "table" || table.childCount <= ROW_WINDOW_MIN) continue

			let y = this.heights.top(index)
			let from = -1
			let to = table.childCount

			for (let row = 0; row < table.childCount; row++) {
				const height = this.rowHeight(table.child(row))

				if (from < 0 && y + height > top) from = row

				y += height

				if (y >= bottom) {
					to = row + 1

					break
				}
			}

			if (from >= 0) out.set(index, [from, Math.max(from + 1, to)])
		}

		return out
	}

	// The blocks held for the screen, and the one holding the reference of a note or text box being edited.
	viewportWindow(doc: Node): readonly number[] {
		const [from = 0, to = 0] = this.viewport
		const count = doc.childCount
		const screen = [Math.min(from, count), Math.min(to, count)]
		const pinned = this.pinned()

		if (pinned === undefined) return screen

		const index = blockIndex(doc, this.starts, pinned)

		return mergeWindows(screen, [index, index + 1])
	}

	// Where in the body the reference of the note or text box being edited is (its block, and its row of a long
	// table, stay held), or undefined while the body is edited.
	pinned(): number | undefined {
		const active = this.editor.activeStory

		if (active === this.editor.body.session.story.story.index) return undefined

		return this.pins.get(active)?.() ?? (this.entered?.story === active ? this.entered.pos : undefined)
	}

	// A keystroke in the body about to change `doc`'s blocks [from, to] (indices).
	hint(doc: Node, blocks: readonly [number, number] | undefined): void {
		this.edited = blocks === undefined ? undefined : { doc, blocks }
	}

	// The body changed from `before` to `after`: the blocks it replaced are estimated anew (keeping what was
	// measured of a block edited in place) and counted again.
	changed(story: StoryView, before: Node, after: Node): void {
		if (story !== this.main) return

		const oldCount = before.childCount
		const newCount = after.childCount
		const delta = newCount - oldCount
		const hint = this.edited?.doc === before ? this.edited.blocks : undefined
		let start = 0
		let oldEnd = oldCount
		let newEnd = newCount

		this.edited = undefined

		// A keystroke: the blocks its step touched, when those beside them are the ones they were (else, a
		// command's change: the blocks compared from both ends).
		if (
			hint !== undefined &&
			(hint[0] === 0 || before.child(hint[0] - 1) === after.child(hint[0] - 1)) &&
			(hint[1] + 1 >= oldCount ? hint[1] + 1 + delta === newCount : before.child(hint[1] + 1) === after.child(hint[1] + 1 + delta))
		) {
			start = hint[0]
			oldEnd = hint[1] + 1
			newEnd = oldEnd + delta
		} else {
			while (start < oldCount && start < newCount && before.child(start) === after.child(start)) start++

			while (oldEnd > start && newEnd > start && before.child(oldEnd - 1) === after.child(newEnd - 1)) {
				oldEnd--
				newEnd--
			}
		}

		const inserted: Node[] = []

		for (let k = start; k < newEnd; k++) inserted.push(after.child(k))

		this.heights.splice(start, oldEnd - start, inserted, this.width)

		// The document's own properties (its final section's) or a section's end changed: notes are numbered
		// again from the start (a section's note properties apply from its start).
		const part = this.editor.body.session.story.part
		const ends = (block: Node | undefined): string =>
			block === undefined || !endsSection(part, block)
				? ""
				: `${String(block.attrs["sectPr"])}:${JSON.stringify(sectionEndOf(block).edit ?? null)}`
		let sections = before.attrs !== after.attrs

		if (!sections && oldEnd - start === inserted.length) {
			// Edited in place: a section end whose properties changed.
			for (let k = 0; !sections && k < inserted.length; k++) sections = ends(inserted[k]) !== ends(before.child(start + k))
		} else if (!sections) {
			// Blocks came or went: a section end among them.
			for (let k = start; !sections && k < oldEnd; k++) sections = ends(before.child(k)) !== ""
			for (let k = 0; !sections && k < inserted.length; k++) sections = ends(inserted[k]) !== ""
		}

		story.invalidateCounters(sections ? -1 : start)

		// Blocks after the edit moved: the screen's blocks are those at its position now.
		const [from = 0, to = 0] = this.viewport

		if (delta !== 0 && from > start) this.viewport = [Math.max(0, from + delta), Math.max(0, to + delta)]
		else if (delta !== 0 && to > start) this.viewport = [from, Math.max(from, to + delta)]

		// Long tables' rows on screen are found again for the blocks where they are now, and for a table whose rows
		// came or went (now, before the view holds rows it no longer has).
		if (this.tableRows.size > 0) {
			let stale = delta !== 0

			for (let k = 0; !stale && k < inserted.length && start + k < oldEnd; k++)
				stale = this.tableRows.has(start + k) && inserted[k]?.childCount !== before.child(start + k).childCount

			if (stale) {
				const top = this.scroller.scrollTop - this.origin()
				const screen = this.screen()
				const [first = 0, end = 0] = this.viewport

				this.tableRows = this.rowsOnScreen(after, first, end - 1, top - screen, top + 2 * screen)
				this.request({ viewport: true })
			}
		}
	}

	// After the body's view drew: the gaps take their blocks' height, the blocks shown are measured.
	rendered(story: StoryView): void {
		if (story !== this.main) return

		const view = story.view
		const doc = view.state.doc
		const children = view.dom.children
		const count = this.editor.body.session.state.doc.childCount
		const windows = story.windows
		const blocks = new Map<Element, number>()
		const gaps: { element: HTMLElement; from: number; to: number }[] = []

		if (children.length !== doc.childCount) return

		let at = 0
		let child = 0
		const gap = (from: number, to: number): void => {
			const element = children[child++]

			if (element instanceof HTMLElement) gaps.push({ element, from, to })
		}

		for (let w = 0; w + 1 < windows.length; w += 2) {
			const start = Math.max(at, windows[w] ?? 0)
			const end = Math.min(count, windows[w + 1] ?? 0)

			if (start > at) gap(at, start)

			for (let index = start; index < end; index++) {
				const element = children[child++]

				if (element !== undefined) blocks.set(element, index)
			}

			at = Math.max(at, end)
		}

		if (at < count) gap(at, count)

		this.gapBoxes = gaps
		this.sizeGaps()

		// A long table's gap rows take the height of their rows; its rows shown are measured. Each row's element is
		// the one the view drew for it (found by its position), never one counted among the table's elements.
		const rows = new Map<Element, Node>()
		const starts = this.starts

		for (const index of blocks.values()) {
			const shown = story.shownTables.get(index)
			const real = this.editor.body.session.state.doc.child(index)
			const start = starts.document === this.editor.body.session.state.doc ? starts.starts[index] : undefined

			if (shown === undefined || start === undefined) continue

			let r = 0

			shown.forEach((row, at) => {
				const dom = view.nodeDOM(start + 1 + at)
				const gap = gapRowCount(row)

				if (gap === undefined) {
					if (dom instanceof Element) rows.set(dom, row)

					r++

					return
				}

				let height = 0

				for (let k = r; k < r + gap && k < real.childCount; k++) height += this.rowHeight(real.child(k))

				r += gap

				const cell = dom instanceof Element ? dom.firstElementChild : null
				const css = `${String(Math.round(height))}px`

				if (cell instanceof HTMLElement && cell.style.height !== css) cell.style.height = css
			})
		}

		const observer = this.blockObserver

		if (observer !== undefined) {
			for (const element of this.blocks.keys()) if (!blocks.has(element)) observer.unobserve(element)
			for (const element of this.rows.keys()) if (!rows.has(element)) observer.unobserve(element)
			for (const element of blocks.keys()) if (!this.blocks.has(element)) observer.observe(element)
			for (const element of rows.keys()) if (!this.rows.has(element)) observer.observe(element)
		}

		this.blocks = blocks
		this.rows = rows
	}

	private sizeGaps(): void {
		for (const gap of this.gapBoxes) {
			const height = `${String(Math.round(this.heights.top(gap.to) - this.heights.top(gap.from)))}px`

			if (gap.element.style.height !== height) gap.element.style.height = height
		}
	}

	// Blocks were measured (shown, or their size changed): their heights are taken, the gaps resized, the screen
	// kept where it was.
	private measured(entries: readonly ResizeObserverEntry[]): void {
		if (this.destroyed || this.scroller.clientHeight === 0) return

		let changed = false

		for (const entry of entries) {
			const index = this.blocks.get(entry.target)
			const row = this.rows.get(entry.target)
			const height = entry.borderBoxSize[0]?.blockSize ?? entry.target.getBoundingClientRect().height

			if (row !== undefined) this.rowHeights.set(row, height)
			if (index !== undefined && this.heights.set(index, height)) changed = true
		}

		if (!changed) return

		this.anchored(() => this.sizeGaps())
		this.request({ viewport: true })
	}

	// The scroll box changed size: a new width wraps every block anew.
	private resized(): void {
		const width = this.scroller.clientWidth

		if (this.destroyed || width === 0 || width === this.width) {
			this.request({ viewport: true })

			return
		}

		this.width = width
		this.anchored(() => {
			this.heights.reset(this.editor.body.session.state.doc, width)
			this.sizeGaps()
		})
		this.request({ viewport: true })
	}

	// Runs `change` keeping the first block on screen where it is (what changed above it moves the rest).
	private anchored(change: () => void): void {
		const top = this.scroller.getBoundingClientRect().top
		let anchor: Element | undefined
		let before = 0

		for (const element of this.blocks.keys()) {
			const rect = element.getBoundingClientRect()

			if (rect.bottom > top) {
				anchor = element
				before = rect.top

				break
			}
		}

		change()

		if (anchor !== undefined && anchor.isConnected) {
			const after = anchor.getBoundingClientRect().top

			if (Math.abs(after - before) >= 0.5) this.scroller.scrollTop += after - before
		}
	}

	// The blocks on screen are held; when some are not, those a screen around them are taken.
	private checkViewport(): void {
		const top = this.scroller.scrollTop - this.origin()
		const screen = this.screen()
		const first = this.heights.indexAt(top)
		const last = this.heights.indexAt(top + screen)
		const [from = 0, to = 0] = this.viewport
		const doc = this.editor.body.session.state.doc
		// The rows on screen of long tables: those held while the screen stays inside them.
		const over = screen * OVERSCAN_SCREENS
		const visible = this.rowsOnScreen(doc, first, last, top, top + screen)
		let rowsHeld = true

		for (const [index, [start = 0, end = 0]] of visible) {
			const [heldFrom = 0, heldTo = 0] = this.tableRows.get(index) ?? []

			if (start < heldFrom || end > heldTo) rowsHeld = false
		}

		if (first >= from && last < to && rowsHeld) return

		const next = this.viewportAt(top)
		const rows = this.rowsOnScreen(doc, first, last, top - over, top + screen + over)

		if (sameWindows(next, this.viewport) && rowsHeld) return

		this.viewport = next
		this.tableRows = rows
		this.anchored(() => this.main.redraw())
	}

	private request(work: { viewport?: boolean; caret?: boolean }): void {
		if (work.viewport === true) this.work.viewport = true
		if (work.caret === true) this.work.caret = true
		if (this.frame !== 0 || this.destroyed) return

		this.frame = requestAnimationFrame(() => {
			this.frame = 0

			const { viewport, caret } = this.work

			this.work = { viewport: false, caret: false }

			if (viewport) this.checkViewport()
			if (caret && this.activeView()?.view.hasFocus() === true) this.scrollToCaret()
		})
	}

	// ---- what the handle does ---------------------------------------------------------------------------------

	// The view of the story being edited (the body's when that one is not shown).
	private activeView(): StoryView | undefined {
		for (const story of this.stories.values()) if (story.story === this.editor.activeStory) return story

		return undefined
	}

	private storyAt(target: EventTarget | null): StoryView {
		let element = target instanceof Element ? target : null

		while (element !== null && element !== this.scroller) {
			const story = element instanceof HTMLElement ? this.stories.get(element) : undefined

			if (story !== undefined) return story

			element = element.parentElement
		}

		return this.main
	}

	focus(): void {
		;(this.activeView() ?? this.main).focus()
	}

	// The editing view of story `story` while it is shown (the body's, a note's or text box's).
	viewOf(story: number): EditorView | undefined {
		for (const shown of this.stories.values()) if (shown.story === story) return shown.view

		return undefined
	}

	scrollToCaret(): void {
		const story = this.activeView() ?? this.main
		const head = story.session.state.selection.head
		let coords: { top: number; bottom: number }

		try {
			coords = story.view.coordsAtPos(head)
		} catch {
			return
		}

		const rect = this.scroller.getBoundingClientRect()
		const margin = Math.min(40, this.scroller.clientHeight / 4)

		if (coords.top < rect.top + margin) this.scroller.scrollTop -= rect.top + margin - coords.top
		else if (coords.bottom > rect.bottom - margin) this.scroller.scrollTop += coords.bottom - rect.bottom + margin
	}

	// There are no pages here: page `index` is where that share of the document is.
	scrollToPage(index: number): void {
		const pages = Math.max(1, this.editor.pageCount)
		const block = Math.floor((Math.max(0, index) / pages) * this.heights.count)

		this.scroller.scrollTop = this.heights.top(block) + this.origin()
	}

	selectionPoints(): { readonly start: ClientPoint | undefined; readonly end: ClientPoint | undefined } {
		const story = this.activeView() ?? this.main
		const selection = story.session.state.selection
		const point = (pos: number): ClientPoint | undefined => {
			try {
				const coords = story.view.coordsAtPos(pos)

				return { x: coords.left, y: coords.bottom, height: coords.bottom - coords.top }
			} catch {
				return undefined
			}
		}

		return { start: point(selection.from), end: point(selection.to) }
	}

	dragSelectionEnd(end: "start" | "end", clientX: number, clientY: number): void {
		const hit = this.hitTest(clientX, clientY)

		if (this.handleFixed?.end !== end) {
			const selection = this.editor.selection()

			this.handleFixed = { end, fixed: end === "start" ? selection.to : selection.from }
		}

		if (hit !== undefined) this.editor.selectRange(this.handleFixed.fixed, hit)
	}

	endSelectionDrag(): void {
		this.handleFixed = undefined
	}

	// The position under a point on screen; editing moves to the story shown there.
	hitTest(clientX: number, clientY: number): HitResult | undefined {
		const element = this.scroller.ownerDocument.elementFromPoint(clientX, clientY)
		const story = this.storyAt(element)
		const pos = story.positionAt(clientX, clientY)

		if (pos === undefined) return undefined

		this.enter(story)

		return { pos, affinity: 1, page: -1, line: -1, atom: false }
	}

	clipboardContent(): { readonly html: string; readonly text: string } | undefined {
		return (this.activeView() ?? this.main).clipboardContent()
	}

	deleteSelection(): boolean {
		return (this.activeView() ?? this.main).deleteSelection()
	}

	paste(content: { readonly html?: string; readonly text?: string }): boolean {
		return (this.activeView() ?? this.main).paste(content)
	}

	selectAll(): boolean {
		return (this.activeView() ?? this.main).selectAll()
	}

	// ---- presses on objects ----------------------------------------------------------------------------------

	// What a press at `target` hits: an object's element, a commented range, a content control.
	private hitAt(target: EventTarget | null, clientX: number, clientY: number): ObjectHit | undefined {
		let element = target instanceof Element ? target : null

		while (element !== null && element !== this.scroller) {
			const comment = element instanceof HTMLElement ? element.dataset["foComment"] : undefined

			if (comment !== undefined) {
				const anchor = docxComments(this.editor).anchor(comment)
				const story = this.storyAt(element)

				return {
					kind: "commentMarker",
					story: anchor?.story ?? story.story,
					pos: anchor?.from ?? story.positionAt(clientX, clientY) ?? 0,
					part: comment
				}
			}

			const found = this.targets.get(element)

			if (found !== undefined) {
				const pos = found.getPos()

				return pos === undefined ? undefined : this.objectHit(found, pos)
			}

			element = element.parentElement
		}

		return undefined
	}

	private objectHit(found: Target, pos: number): ObjectHit | undefined {
		const session = found.session
		const story = session.story.story.index
		const doc = session.state.doc

		if (found.kind === "field") {
			// A legacy form field is a control (a check box, a list); other fields are fields.
			const node = doc.nodeAt(pos)
			const field = node === null ? undefined : legacyFieldOf(session.story.part, node)

			if (field !== undefined && field.type !== "FORMTEXT")
				return { kind: "control", story, pos, part: field.type === "FORMCHECKBOX" ? "checkbox" : "list" }

			return { kind: "field", story, pos }
		}

		if (found.kind === "control") {
			const around = inlineControlAround(session.story.part, doc, pos, pos)
			const part = around === undefined ? undefined : controlPart(around.info)

			return around === undefined || part === undefined ? undefined : { kind: "control", story, pos: around.from, part }
		}

		// A note's reference shows the note itself here: a press on it is a press on the text.
		if (found.kind === "noteRef") return undefined

		return { kind: found.kind, story, pos }
	}

	// Calls the app's handler for the object at a press; true when it took it.
	private pressObject(event: PointerEvent, clicks: number): boolean {
		const interactions = this.options.interactions
		const hit = interactions === undefined ? undefined : this.hitAt(event.target, event.clientX, event.clientY)
		const handler = hit === undefined ? undefined : interactions?.[hit.kind]

		if (hit === undefined || handler === undefined) return false

		const press: DocxObjectPress = {
			hit,
			page: -1,
			x: 0,
			y: 0,
			clientX: event.clientX,
			clientY: event.clientY,
			pointerType: event.pointerType,
			pointerId: event.pointerId,
			clicks,
			shiftKey: event.shiftKey
		}

		return handler(press)
	}

	// A mouse press on an object goes to its handler before the caret moves (as on the pages); a touch is a tap
	// once it ends where it began.
	private pointerDown(event: PointerEvent): void {
		if (event.button !== 0) return

		if (event.pointerType === "touch") {
			this.press = { pointer: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp }

			return
		}

		if (this.pressObject(event, event.detail > 0 ? event.detail : 1)) {
			event.preventDefault()
			event.stopPropagation()
			this.storyAt(event.target).focus()
		}
	}

	private pointerUp(event: PointerEvent): void {
		const press = this.press

		this.press = undefined

		if (press?.pointer !== event.pointerId) return
		if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP || event.timeStamp - press.time > TAP_MS) return

		if (this.pressObject(event, 1)) event.preventDefault()
	}

	// ---- the rest ---------------------------------------------------------------------------------------------

	update(options: ReflowViewOptions): void {
		const previous = this.options

		this.options = options

		if (options.readOnly !== previous.readOnly) {
			for (const story of this.stories.values()) story.refreshReadOnly()

			if (!options.readOnly) this.warmUp()
		}

		if (options.label !== previous.label || options.describedBy !== previous.describedBy)
			for (const story of this.stories.values()) story.view.setProps({})
		if (options.marks !== previous.marks) this.main.redraw()

		const labels = options.markLabels ?? DOCX_MARK_LABELS
		const before = previous.markLabels ?? DOCX_MARK_LABELS

		if (this.editor.formattingMarks && labels !== before && !sameLabels(labels, before)) this.refresh()
	}

	// The labels formatting marks are drawn with while the editor shows them (Show/Hide ¶), else undefined.
	get formattingMarks(): DocxMarkLabels | undefined {
		return this.editor.formattingMarks ? (this.options.markLabels ?? DOCX_MARK_LABELS) : undefined
	}

	// Formatting marks shown or not on the view (its stylesheet draws some of them); true when that changed.
	private showMarks(): boolean {
		const shown = this.editor.formattingMarks

		if ((this.scroller.dataset["foMarks"] !== undefined) === shown) return false

		if (shown) this.scroller.dataset["foMarks"] = ""
		else delete this.scroller.dataset["foMarks"]

		return true
	}

	// The revision view (tracked changes shown inline, or the text as it will be or was); true when it changed.
	private showRevisions(): boolean {
		const shown = REVISION_VIEWS[this.editor.view] ?? "final"

		if (this.scroller.dataset["foRevisions"] === shown) return false

		this.scroller.dataset["foRevisions"] = shown

		return true
	}

	// How equations show their tracked changes now: per revision view, each author in the colour the pages and the
	// balloons give them (one numbering of the document's reviewers for every surface, session-new ones appended).
	get equationView(): OmmlRevisionView {
		const view = this.editor.view

		if (this.equations?.view !== view) {
			this.equations = { view, value: { ...equationView(view), author: modelAuthors(this.editor.edits.model).index } }
		}

		return this.equations.value
	}

	// Once editable, the code a first keystroke runs is compiled while the page is idle (once).
	private warmUp(): void {
		if (this.warmed || this.options.readOnly || this.editor.body.session.readOnly) return

		this.warmed = true

		const run = (): void => {
			if (!this.destroyed) this.editor.body.session.warmUp()
		}

		if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 })
		else setTimeout(run, 0)
	}

	// Before the view is taken out of the document (see EditSink.releaseFocus).
	releaseFocus(): void {
		if (this.scroller.dataset["foFocused"] !== undefined) handFocus(this.editor)
	}

	destroy(): void {
		this.destroyed = true

		if (this.scroller.dataset["foFocused"] !== undefined) handFocus(this.editor)

		this.stopListening()
		this.editor.setHeadersShown(true)

		for (const cleanup of this.cleanups) cleanup()

		if (this.frame !== 0) cancelAnimationFrame(this.frame)

		this.blockObserver?.disconnect()
		this.boxObserver?.disconnect()

		for (const story of [...this.stories.values()]) if (story !== this.main) story.destroy()

		this.main.destroy()
		this.content.remove()
		releaseGapText()
	}
}
