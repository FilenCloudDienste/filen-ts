import type { Mark, Node } from "prosemirror-model"
import { Plugin, Selection, type EditorState, type Transaction } from "prosemirror-state"
import { EditorView, type NodeView, type NodeViewConstructor } from "prosemirror-view"
import { docxSchema, isWriteCommand } from "../../../core/docx/edit/index"
import {
	besideNode,
	docxKeyBindings,
	docxKeyFor,
	joinBackward,
	joinForward,
	lineBreak,
	selectAll,
	splitParagraph,
	type DocxKeyBindings,
	type DocxKeyRun,
	type PagedEditor
} from "../../../core/docx/paged/index"
import { drawingName } from "../../../core/docx/objects/edit"
import { docxNotes } from "../../../core/docx/stories/notes"
import { deletesBreakAtCaret } from "../../../core/docx/stories/sections"
import {
	attrText,
	clipboardParser,
	clipboardSerializer,
	cutMemory,
	type CutMemory,
	fieldText,
	plainSlice,
	plainText,
	safeClipboardHtml,
	shownSlice,
	symbolText,
	writeClipboardEvent
} from "./clipboard"
import {
	autoLinked,
	composedFormatting,
	deleteBeforeComposition,
	deleteSelectionKey,
	inputTransaction,
	selectionFormatting,
	spaceEndsAddress,
	spaceTransaction
} from "./input"
import {
	blockIndex,
	compositionFrom,
	readComposition,
	gapRowCount,
	mergeWindows,
	rowsAround,
	deletesBreakBefore,
	escapesToHost,
	isGap,
	handFocus,
	releaseGapText,
	sessionTransaction,
	tabKey,
	takeFocus,
	unreadSelection,
	windowAround,
	windowedState
} from "./window"

export { plainSlice, plainText, safeClipboardHtml }

// The input sink of paged editing: a real ProseMirror view that holds focus and receives all input (keys,
// beforeinput, IME composition, clipboard, drag and drop) while the pages show the document. It is invisible
// and holds only the top-level blocks around the selection: each run of other blocks is one gap paragraph of
// the same size (never rendered), so positions are the document's, a transaction from the view applies to the
// session's state step for step, and a keystroke costs the same however long the document. It is moved so its
// own caret sits where the caret is painted, which is where IME candidate windows and magnifiers anchor.

export interface EditSinkOptions {
	// The accessible name of the editing area.
	readonly label: string
	// The id of an element describing it (how to leave it from the keyboard).
	readonly describedBy?: string
	readonly readOnly?: boolean
	// Cmd (Apple platforms) or Ctrl as the shortcut modifier.
	readonly apple?: boolean
	// In the desktop app: the shortcuts the browser owns are the editor's (DocxKey.desktop). Read for the default
	// keys only.
	readonly desktop?: boolean
	// The Word keys in effect (DOCX_KEYS' ids), read at each key press; Word's on this platform without it.
	readonly keyBindings?: () => DocxKeyBindings | undefined
	// Top-level blocks held on each side of the selection's ends (default 20).
	readonly window?: number
	// The painted caret on screen (client px) and the width of its column, or undefined when it is not drawn.
	readonly caretClientRect: () =>
		{ readonly left: number; readonly top: number; readonly height: number; readonly width?: number } | undefined
	// Page Up / Page Down.
	readonly pageMove?: (dir: 1 | -1, extend: boolean) => boolean
	// The app's find (Mod+F), with its replace row (Ctrl+H): the browser's would search the hidden text.
	readonly onFind?: (replace: boolean) => void
	// Word's Go To (Ctrl+G); without it the key finds.
	readonly onGoTo?: () => void
}

const DEFAULT_WINDOW = 20
// Rows of a long table held on each side of the selection's ends.
const ROW_MARGIN = 20

function element<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
	return document.createElement(tag)
}

// Inline atoms as text a screen reader or a keyboard's text context can use.
function atom(text: (node: Node) => string, tag: "span" | "br" = "span"): NodeViewConstructor {
	return node => {
		const dom = element(tag)

		if (tag === "span") dom.textContent = text(node)

		dom.contentEditable = "false"

		return { dom, ignoreMutation: () => true }
	}
}

export const NODE_VIEWS: Readonly<Record<string, NodeViewConstructor>> = {
	paragraph: node => {
		if (isGap(node)) {
			return {
				dom: element("p"),
				update: (next: Node) => isGap(next),
				ignoreMutation: () => true
			} satisfies NodeView
		}

		const dom = element("p")

		// Right-to-left paragraphs: the browser's own caret motion and IME follow the text's direction.
		dom.dir = "auto"

		return { dom, contentDOM: dom, update: (next: Node) => next.type === node.type && !isGap(next) } satisfies NodeView
	},
	table: () => {
		const dom = element("table")
		const contentDOM = element("tbody")

		dom.appendChild(contentDOM)

		return { dom, contentDOM }
	},
	table_row: node => {
		// Rows of a long table the view does not hold (one gap row for each run of them).
		if (gapRowCount(node) !== undefined)
			return { dom: element("tr"), update: (next: Node) => gapRowCount(next) !== undefined, ignoreMutation: () => true }

		const dom = element("tr")

		return { dom, contentDOM: dom, update: (next: Node) => next.type === node.type && gapRowCount(next) === undefined }
	},
	table_cell: () => {
		const dom = element("td")

		return { dom, contentDOM: dom }
	},
	sdt: () => {
		const dom = element("div")

		return { dom, contentDOM: dom }
	},
	locked_block: node => {
		const dom = element("div")

		dom.contentEditable = "false"
		dom.textContent = typeof node.attrs["text"] === "string" ? node.attrs["text"] : ""

		return { dom, ignoreMutation: () => true }
	},
	tab: atom(() => "\t"),
	break: atom(() => "", "br"),
	hyphen: atom(node => (node.attrs["soft"] === true ? "­" : "‑")),
	symbol: atom(symbolText),
	note_ref: atom(() => ""),
	comment_ref: atom(() => ""),
	drawing: atom(() => ""),
	run_object: atom(attrText("text")),
	field: atom(fieldText),
	marker: atom(() => ""),
	// A field character of a field spanning paragraphs: its result is the text around it.
	field_char: atom(() => ""),
	math: atom(() => ""),
	proof_err: atom(() => ""),
	rendered_break: atom(() => ""),
	opaque_inline: atom(attrText("text"))
}

// A drawing: an image named by its alternative text (else its title), or nothing to read without one. Made
// anew when its node changes (an alt text edit), as every atom here.
function drawingView(editor: PagedEditor): NodeViewConstructor {
	return node => {
		const dom = element("span")
		const name = drawingName(editor.session.context, node)

		dom.contentEditable = "false"

		if (name !== "") {
			dom.setAttribute("role", "img")
			dom.setAttribute("aria-label", name)
		}

		return { dom, ignoreMutation: () => true }
	}
}

const MARK_VIEWS = Object.fromEntries(Object.keys(docxSchema.marks).map(name => [name, () => ({ dom: element("span") })]))

export class EditSink {
	readonly element: HTMLDivElement
	readonly view: EditorView
	private readonly editor: PagedEditor
	private readonly options: EditSinkOptions
	private readonly windowSize: number
	// The session's state the view's was made from, the top-level blocks the view holds ([from, to) index
	// ranges, ascending) and its gap paragraphs (kept while their size does not change).
	private real: EditorState
	private windows: readonly number[] = []
	private gaps: readonly Node[] = []
	private offsetX = 0
	private offsetY = 0
	private compositionStart = -1
	// The text being composed (the last compositionupdate's).
	private compositionText = ""
	// What text composed over a selection takes (selectionFormatting), until the composition ends.
	private composeFormatting: readonly Mark[] | undefined = undefined
	private dispatching = false
	private readOnlyOption: boolean
	private readOnlyShown: boolean
	// The input view's font size and width as last set (px, client space).
	private lineHeight = 0
	private width = 0
	private readonly stopListening: () => void
	private warmed = false
	private destroyed = false
	// The last cut, when it took out comment anchors (pasted back, it moves them).
	private readonly cut: CutMemory
	// Focus as the view's own events tell it (a view taken out of the document hears no blur).
	private hasFocus = false

	constructor(editor: PagedEditor, parent: HTMLElement, options: EditSinkOptions) {
		this.editor = editor
		this.options = options
		this.cut = cutMemory(editor)
		this.windowSize = Math.max(1, options.window ?? DEFAULT_WINDOW)
		this.element = element("div")
		this.element.className = "fo-docx-sink"
		parent.appendChild(this.element)

		this.readOnlyOption = options.readOnly === true
		this.readOnlyShown = this.readOnly
		this.real = editor.state
		this.view = new EditorView(this.element, {
			state: this.viewState(editor.state),
			editable: () => !this.readOnly,
			dispatchTransaction: tr => this.dispatch(tr),
			// The session's plugins act on its own state; what stateless ones do in a view (paste, drop) acts here.
			// A stateful plugin's props read its state from the view's, which has none (history's undo is below).
			plugins: editor.state.plugins.flatMap(plugin =>
				plugin.spec.props === undefined || plugin.spec.state !== undefined ? [] : [new Plugin({ props: plugin.spec.props })]
			),
			nodeViews: { ...NODE_VIEWS, drawing: drawingView(editor) },
			markViews: MARK_VIEWS,
			clipboardSerializer: clipboardSerializer(),
			clipboardParser: clipboardParser(),
			transformPastedHTML: safeClipboardHtml,
			clipboardTextSerializer: () => {
				const state = this.editor.state
				const { from, to } = state.selection

				return plainText(state.doc, from, to, pos => this.editor.geometry.markerText(pos), this.editor.view)
			},
			clipboardTextParser: (text, $context) => plainSlice(text, $context),
			handlePaste: (_view, event) => this.pasteCut(event.clipboardData?.getData("text/plain")),
			// The pages scroll to the painted caret; the sink never scrolls anything.
			handleScrollToSelection: () => true,
			handleKeyDown: (view, event) => this.keyDown(view, event),
			handleDOMEvents: {
				keydown: (view, event) => {
					// An Escape the editor does not take (no format painter, the body being edited) is the host's (it
					// closes a dialog or the editor): ProseMirror's own key handling would prevent it.
					if (escapesToHost(editor, event)) return true

					// Read-only, the view is not editable and ProseMirror's own key handling is off: selection keys only.
					return view.editable ? false : this.readOnlyKeyDown(view, event)
				},
				// Undo and redo from outside the keyboard (Edit menu, shake, a soft keyboard's key): the editor's,
				// in its order across stories. Typing over a selection and word or line deletions: transactions.
				beforeinput: (view, event) => this.historyInput(event) || this.editInput(view, event),
				// The document's selection, not the view's (whose gaps hold no content).
				copy: (_view, event) => this.copyEvent(event, false),
				cut: (_view, event) => this.copyEvent(event, true),
				focus: () => {
					this.hasFocus = true

					return false
				},
				blur: () => {
					this.hasFocus = false

					return false
				},
				compositionstart: view => {
					// Composed over a selection: the selection goes first, as a transaction.
					if (!this.readOnly) {
						this.readSelection(view)
						this.composeFormatting =
							selectionFormatting(this.editor.state) ?? this.editor.session.typingMarks(this.editor.state)
						this.run(deleteBeforeComposition(this.editor.state))
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
					this.editor.setComposition(undefined)

					return false
				}
			},
			attributes: () => ({
				role: "textbox",
				"aria-multiline": "true",
				"aria-label": options.label,
				...(options.describedBy === undefined ? {} : { "aria-describedby": options.describedBy }),
				spellcheck: "false",
				translate: "no",
				// Not editable but still focused (selection, copy).
				...(this.readOnly ? { "aria-readonly": "true", inputmode: "none", tabindex: "0" } : {})
			})
		})

		// Commands from a toolbar change the session without the view, and editing can move to another story
		// (a header): the view follows.
		this.stopListening = editor.subscribe(event => {
			if (event.type === "pages") {
				if (event.final) this.warmUp()

				return
			}

			if (this.dispatching) return

			if (this.real !== editor.state) {
				if (event.type === "story") this.windows = []

				this.sync()
			}

			this.refreshReadOnly()
		})

		if (editor.layout.final) this.warmUp()

		// Shown in place of a view that had focus: typing goes on here.
		if (takeFocus(editor)) this.focus()
	}

	// Read-only: the host's option or the story's session (a gate, a text box).
	get readOnly(): boolean {
		return this.readOnlyOption || this.editor.session.readOnly
	}

	setReadOnly(readOnly: boolean): void {
		this.readOnlyOption = readOnly
		this.refreshReadOnly()

		if (!readOnly) this.warmUp()
	}

	// Once laid out and editable, the code a first keystroke runs is compiled while the page is idle (see
	// DocxEditorSession.warmUp): once.
	private warmUp(): void {
		if (this.warmed || this.readOnly) return

		this.warmed = true

		const run = (): void => {
			if (!this.destroyed && !this.readOnly) this.editor.body.session.warmUp()
		}

		if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 })
		else setTimeout(run, 0)
	}

	// The view's editability and attributes follow read-only.
	private refreshReadOnly(): void {
		const readOnly = this.readOnly

		if (readOnly === this.readOnlyShown) return

		this.readOnlyShown = readOnly
		this.view.setProps({})
	}

	// Before the view is taken out of the document (a host's layout cleanup, ahead of the removal, which blurs it
	// in some browsers): focus it holds goes on in the view shown in its place.
	releaseFocus(): void {
		if (this.view.hasFocus()) handFocus(this.editor)
	}

	destroy(): void {
		this.destroyed = true

		if (this.hasFocus) handFocus(this.editor)

		this.stopListening()
		this.view.destroy()
		this.element.remove()
		releaseGapText()
	}

	focus(): void {
		const view = this.view

		if (!view.editable) {
			// ProseMirror only syncs a read-only view's selection once the document's selection is inside it.
			const selection = view.dom.ownerDocument.getSelection()

			view.dom.focus({ preventScroll: true })

			if (selection !== null && !view.dom.contains(selection.anchorNode)) selection.collapse(view.dom, 0)
		}

		view.focus()
	}

	get focused(): boolean {
		return this.view.hasFocus()
	}

	// The selection as a copy writes it (the same HTML and text as a copy event), or undefined when it is
	// empty. For an app's own Cut and Copy commands (menus, touch), which write the system clipboard itself.
	clipboardContent(): { readonly html: string; readonly text: string } | undefined {
		const state = this.editor.state

		if (state.selection.empty) return undefined

		const { dom, text } = this.view.serializeForClipboard(shownSlice(state.selection.content(), this.editor.view))

		return { html: dom.innerHTML, text }
	}

	// Deletes the selection (the second half of an app's Cut); false when read-only or nothing is selected.
	deleteSelection(): boolean {
		if (this.readOnly || this.editor.state.selection.empty) return false

		this.rememberCut()

		return this.run(this.editor.state.tr.deleteSelection())
	}

	// Pastes what an app read from the system clipboard, through the same parsers as a paste event: HTML
	// keeps paragraphs and basic formatting only (parsed in an inert document; nothing it references loads),
	// text is taken as typed. False when read-only or there is nothing to paste.
	paste(content: { readonly html?: string; readonly text?: string }): boolean {
		if (this.readOnly) return false
		if (this.pasteCut(content.text)) return true
		if (content.html !== undefined && content.html.length > 0) return this.view.pasteHTML(content.html)
		if (content.text !== undefined && content.text.length > 0) return this.view.pasteText(content.text)

		return false
	}

	selectAll(): boolean {
		return this.run(selectAll(this.editor.state))
	}

	get composing(): boolean {
		return this.view.composing
	}

	// Sizes the sink's text like the painted caret's line (IME windows take the caret's height) and its
	// column, and moves it so its own caret lies on the painted one.
	align(): void {
		const target = this.options.caretClientRect()

		if (target === undefined) return

		const style = this.element.style
		const lineHeight = Math.round(target.height * 10) / 10
		const width = target.width === undefined ? 0 : Math.max(1, Math.round(target.width))

		if (lineHeight > 0 && lineHeight !== this.lineHeight) {
			this.lineHeight = lineHeight
			style.fontSize = `${String(Math.round((lineHeight / 1.2) * 10) / 10)}px`
			style.lineHeight = `${String(lineHeight)}px`
			style.height = `${String(lineHeight)}px`
		}

		if (width > 0 && width !== this.width) {
			this.width = width
			style.width = `${String(width)}px`
		}

		let coords: { left: number; top: number }

		try {
			coords = this.view.coordsAtPos(this.view.state.selection.head)
		} catch {
			return
		}

		const dx = target.left - coords.left
		const dy = target.top - coords.top

		if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return

		this.offsetX += dx
		this.offsetY += dy
		this.element.style.transform = `translate(${Math.round(this.offsetX * 10) / 10}px,${Math.round(this.offsetY * 10) / 10}px)`
	}

	// A transaction of the view: applied to the session's state (positions are the same), and the view brought
	// to the result (whatever the browser changed that the session did not take is put back).
	private dispatch(viewTr: Transaction): void {
		const tr = viewTr.docChanged && this.readOnly ? undefined : sessionTransaction(viewTr, this.view.state.doc, this.editor.state)

		if (tr === undefined) {
			this.sync(true)

			return
		}

		this.apply(tr, true)
	}

	// Applies a transaction on the session's state; `fromView`: it came from the view, which is brought up to
	// date even when the session refused it.
	private apply(tr: Transaction, fromView = false): void {
		if (tr.docChanged && this.readOnly) {
			this.sync(fromView)

			return
		}

		if (this.compositionStart >= 0 && tr.docChanged) this.compositionStart = tr.mapping.map(this.compositionStart, -1)

		const event: unknown = tr.getMeta("uiEvent")

		// A pasted reference to a note that stays referenced elsewhere refers to a copy of it; a paste whose note
		// cannot be copied whole is refused.
		if ((event === "paste" || event === "drop") && !docxNotes(this.editor).pasted(tr)) {
			this.sync(fromView)

			return
		}

		this.dispatching = true

		try {
			this.editor.dispatch(tr)
		} finally {
			this.dispatching = false
		}

		this.sync(fromView)

		if (this.view.composing && this.compositionStart >= 0) {
			const state = this.editor.state
			const from = compositionFrom(state.doc, state.selection.head, this.compositionStart, this.compositionText)

			this.compositionStart = from
			this.editor.setComposition({
				from,
				to: this.compositionText.length > 0 ? from + this.compositionText.length : Math.max(from, state.selection.head)
			})
		}
	}

	// A command's transaction on the session's state.
	private run(tr: Transaction | null | false): boolean {
		if (tr === null) return false
		if (tr !== false) this.apply(tr)

		return true
	}

	// beforeinput historyUndo / historyRedo: the editor undoes or redoes in its order across stories (the
	// browser's own never runs).
	private historyInput(event: InputEvent): boolean {
		const type = event.inputType === "historyUndo" ? "history.undo" : event.inputType === "historyRedo" ? "history.redo" : undefined

		if (type === undefined) return false

		event.preventDefault()

		if (!this.readOnly) void this.editor.execute({ type })

		return true
	}

	// A composition that started over a selection ends: its text gets the formatting it takes, wherever the
	// browser composed it (it composes into the run its selection ended in).
	private formatComposed(text: string): void {
		const formatting = this.composeFormatting

		this.composeFormatting = undefined

		if (formatting === undefined || this.compositionStart < 0 || this.readOnly) return

		const state = this.editor.state
		const from = compositionFrom(state.doc, state.selection.head, this.compositionStart, text)

		this.run(composedFormatting(state, from, text, formatting))
	}

	// beforeinput that would edit the DOM across runs (see inputTransaction): made on the session's state.
	private editInput(view: EditorView, event: InputEvent): boolean {
		if (this.readOnly || !event.cancelable) return false

		this.readSelection(view)

		const session = this.editor.session
		const tr = inputTransaction(view, this.editor.state, event, state => session.typingMarks(state))
		const linking = spaceEndsAddress(view, session, event)
		const typed = tr ?? (linking ? spaceTransaction(session) : undefined)

		if (typed === undefined) return false

		event.preventDefault()

		if (!linking) return this.run(typed)

		return autoLinked(
			session,
			() => this.run(typed),
			link => this.run(link)
		)
	}

	// A selection the browser made that the view has not read yet (a key's selectionchange still queued), taken
	// into the session before an edit replaces it.
	private readSelection(view: EditorView): void {
		const moved = unreadSelection(view)

		if (moved !== undefined) view.dispatch(moved)
	}

	// A copy or cut writes the document's selection, as ProseMirror's own would write the view's.
	private copyEvent(event: ClipboardEvent, cut: boolean): boolean {
		const content = event.clipboardData === null ? undefined : this.clipboardContent()

		if (!writeClipboardEvent(event, content) || content === undefined) return false

		this.cut.forget()

		if (cut && !this.readOnly) {
			this.rememberCut(content.text)
			this.apply(this.editor.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"))
		}

		return true
	}

	private rememberCut(text?: string): void {
		this.cut.remember(this.editor.session, slice => text ?? this.view.serializeForClipboard(slice).text)
	}

	// Pastes the last cut as it was (CutMemory.take); false for anything else.
	private pasteCut(text: string | undefined): boolean {
		if (this.readOnly) return false

		const tr = this.cut.take(this.editor, this.editor.session, text)

		return tr === undefined ? false : this.run(tr)
	}

	// Brings the view to the session's state; `force`: also when that did not change (the view's DOM may
	// differ from its state after a refused change).
	private sync(force = false): void {
		const real = this.editor.state

		if (real === this.real && !force) return

		const state = real === this.real ? this.view.state : this.viewState(real)

		this.real = real
		this.view.updateState(state)
	}

	// The view's state for the session's `real`: its document's top-level blocks around the selection's ends,
	// each run of other blocks one gap paragraph of the run's size, and the selection there.
	private viewState(real: EditorState): EditorState {
		const doc = real.doc
		const story = this.editor.story
		const { from, to } = real.selection
		const a = blockIndex(doc, story, from)
		const b = Math.max(a, blockIndex(doc, story, to))

		this.windows = windowAround(this.windows, a, b, doc.childCount, this.windowSize)

		const windowed = windowedState(real, this.windows, story, this.gaps, (_index, table, pos) =>
			mergeWindows(rowsAround(table, pos, [from, to], ROW_MARGIN))
		)

		this.gaps = windowed.gaps

		return windowed.state
	}

	// Keys of a read-only view: what moves the selection; character and word steps through the document's
	// selection (the browser moves no caret in content that is not editable).
	private readOnlyKeyDown(view: EditorView, event: KeyboardEvent): boolean {
		if (this.keyDown(view, event, true)) {
			event.preventDefault()

			return true
		}

		// Some browsers go back in history on Backspace outside editable content.
		if (event.key === "Backspace") {
			event.preventDefault()

			return true
		}

		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false

		const apple = this.options.apple === true
		const selection = view.dom.ownerDocument.getSelection()

		if (selection === null || (apple ? event.ctrlKey : event.metaKey)) return false

		selection.modify(
			event.shiftKey ? "extend" : "move",
			event.key === "ArrowLeft" ? "left" : "right",
			(apple ? event.altKey : event.ctrlKey) ? "word" : "character"
		)

		const moved = unreadSelection(view)

		if (moved !== undefined) view.dispatch(moved)

		event.preventDefault()

		return true
	}

	private keyDown(view: EditorView, event: KeyboardEvent, readOnly = false): boolean {
		if (view.composing || event.isComposing) return false

		const editor = this.editor
		const apple = this.options.apple === true
		const mod = apple ? event.metaKey : event.ctrlKey
		const extend = event.shiftKey
		const state = editor.state

		// In sideways text (a table cell's text direction) the arrows move as the text is drawn.
		if (event.key.startsWith("Arrow") && !mod && !event.altKey && !event.metaKey && !event.ctrlKey) {
			const turn = editor.caretTurn()

			if (turn !== 0) return turnedArrow(editor, event.key, turn, extend)
		}

		switch (event.key) {
			case "ArrowUp":
			case "ArrowDown": {
				if (event.altKey) return false

				const dir = event.key === "ArrowDown" ? 1 : -1

				if (apple && event.metaKey) editor.moveDocumentBoundary(dir, extend)
				else if (!mod) editor.moveVertical(dir, extend)
				else return false

				return true
			}
			case "ArrowLeft":
			case "ArrowRight": {
				const dir = event.key === "ArrowRight" ? 1 : -1

				// Cmd+Arrow, and Ctrl+Arrow as macOS has it: the line's start or end.
				if (apple && (event.metaKey || (event.ctrlKey && !event.altKey))) return editor.moveLineBoundary(dir, extend)
				// Word steps: the browser's.
				if (mod || event.altKey || event.metaKey || event.ctrlKey) return false

				if (!extend) {
					const beside = besideNode(state, dir)

					if (beside !== null) return this.run(beside)
				}

				if (state.selection.empty || extend) {
					const head = state.selection.head
					// Right-to-left text: steps on screen, as the arrows show.
					const hit = editor.geometry.visualMove(head, editor.affinity, dir)

					if (hit !== undefined) return editor.moveTo(hit, extend, false)

					// Where a line wraps the input view wraps too, and a browser may only move its caret to the other
					// line's side of the same position: one character, as Word steps.
					const pos = editor.geometry.wrapsAt(head) ? stepCharacter(state.doc, head, dir) : undefined

					if (pos !== undefined) return editor.moveTo({ pos, affinity: 1, page: -1, line: -1, atom: false }, extend, false)
				}

				return false
			}
			case "Home":
			case "End": {
				const dir = event.key === "End" ? 1 : -1

				return mod ? editor.moveDocumentBoundary(dir, extend) : editor.moveLineBoundary(dir, extend)
			}
			case "PageUp":
			case "PageDown":
				return this.options.pageMove?.(event.key === "PageDown" ? 1 : -1, extend) ?? false
			case "Enter":
				if (event.altKey || readOnly) return false
				// Mod+Enter: the page break's shortcut.
				if (mod) break

				return autoLinked(
					editor.session,
					() => this.run(extend ? lineBreak(state) : splitParagraph(state, editor.session.formats)),
					tr => this.run(tr)
				)
			case "Tab":
				return (
					!readOnly &&
					autoLinked(
						editor.session,
						() => tabKey(editor, editor.session, event, apple, tr => this.run(tr)),
						tr => this.run(tr)
					)
				)
			// At a paragraph's edge any deletion (a character, a word, to the line's start) joins paragraphs.
			case "Backspace":
				if (readOnly) return false
				// After a section break: the break goes (the sections merge), as Word deletes it.
				if (deletesBreakBefore(this.editor)) return true

				this.readSelection(view)

				return this.run(deleteSelectionKey(editor.state) ?? joinBackward(editor.state, editor.session.formats))
			case "Delete":
				// Shift+Delete cuts.
				if (readOnly || extend) return false
				// Before a section break: the break goes (the sections merge), as Word deletes it.
				if (deletesBreakAtCaret(editor)) {
					void editor.execute({ type: "section.deleteBreak" })

					return true
				}

				this.readSelection(view)

				return this.run(deleteSelectionKey(editor.state) ?? joinForward(editor.state))
			case "Escape":
				// The format painter goes first; then out of a header, footer or note, back to the body.
				if (editor.painter !== undefined) {
					editor.setPainter(undefined)

					return true
				}

				if (editor.activeStory === editor.body.session.story.story.index) return false

				editor.exitStory()

				return true
		}

		if (mod && !event.altKey && !extend) {
			const key = event.key.toLowerCase()

			if (key === "a") return this.run(selectAll(state))
		}

		return this.runKey(docxKeyFor(event, this.keyBindings(), apple), readOnly)
	}

	private keyBindings(): DocxKeyBindings {
		return this.options.keyBindings?.() ?? docxKeyBindings(this.options.apple === true, this.options.desktop === true)
	}

	// A Word key's work; the host's own keys (DocxKeyRun "host") go on to the host.
	private runKey(run: DocxKeyRun | undefined, readOnly: boolean): boolean {
		if (run === undefined || run.kind === "host") return false

		const editor = this.editor

		if (run.kind === "app") {
			switch (run.key) {
				case "goTo":
					if (this.options.onGoTo !== undefined) {
						this.options.onGoTo()

						return true
					}

					this.options.onFind?.(false)

					return this.options.onFind !== undefined
				case "find":
				case "replace":
					this.options.onFind?.(run.key === "replace")

					return this.options.onFind !== undefined
				case "repeat":
					return !readOnly && editor.repeat()
			}
		}

		// Read-only: only what changes nothing (the view: Alt+F9), as the host runs it.
		if (readOnly && isWriteCommand(run.command.type)) return false

		// Undo and redo follow the order across stories; story commands go to the story being edited.
		void editor.execute(run.command)

		return true
	}
}

// An arrow key in sideways text (`turn` 90: top to bottom, lines right to left; 270: bottom to top, lines left to
// right), as Word moves in it: along the text by characters (on into the next or previous paragraph), across it by
// lines.
export function turnedArrow(editor: PagedEditor, key: string, turn: 90 | 270, extend: boolean): boolean {
	const forward = turn === 90 ? "ArrowDown" : "ArrowUp"
	const backward = turn === 90 ? "ArrowUp" : "ArrowDown"

	if (key === forward || key === backward) {
		const dir = key === forward ? 1 : -1
		const selection = editor.state.selection
		const doc = editor.state.doc

		// A selection collapses to its end in the direction of the key.
		if (!extend && !selection.empty) {
			const pos = dir > 0 ? selection.to : selection.from

			return editor.moveTo({ pos, affinity: 1, page: -1, line: -1, atom: false }, false, false)
		}

		const head = selection.head
		const pos = stepCharacter(doc, head, dir) ?? Selection.findFrom(doc.resolve(edgeOf(doc, head, dir)), dir, true)?.head

		if (pos === undefined) return true

		return editor.moveTo({ pos, affinity: 1, page: -1, line: -1, atom: false }, extend, false)
	}

	if (key !== "ArrowLeft" && key !== "ArrowRight") return false

	// The next line lies left of a top to bottom line, right of a bottom to top one.
	const next = turn === 90 ? "ArrowLeft" : "ArrowRight"

	editor.moveVertical(key === next ? 1 : -1, extend)

	return true
}

// Just past the end (dir 1) or before the start (-1) of the textblock holding `pos`.
function edgeOf(doc: Node, pos: number, dir: 1 | -1): number {
	const $pos = doc.resolve(pos)

	return $pos.depth === 0 ? pos : dir > 0 ? $pos.after() : $pos.before()
}

// The position one character (a surrogate pair, an inline atom) after (dir 1) or before (-1) `pos` in its
// textblock, or undefined at the textblock's edge.
function stepCharacter(doc: Node, pos: number, dir: 1 | -1): number | undefined {
	const $pos = doc.resolve(pos)
	const parent = $pos.parent
	const offset = $pos.parentOffset

	if (!parent.isTextblock || (dir > 0 ? offset >= parent.content.size : offset <= 0)) return undefined

	const pair =
		dir > 0
			? parent.textBetween(offset, Math.min(parent.content.size, offset + 2), undefined, "\ufffc")
			: parent.textBetween(Math.max(0, offset - 2), offset, undefined, "\ufffc")
	const surrogates = pair.length === 2 && /^[\ud800-\udbff][\udc00-\udfff]$/.test(pair)

	return pos + dir * (surrogates ? 2 : 1)
}
