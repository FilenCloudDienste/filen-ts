import type { Mark } from "prosemirror-model"
import { Plugin, type EditorState, type Transaction } from "prosemirror-state"
import type { DirectEditorProps, EditorView } from "prosemirror-view"
import type { DocxEditorSession } from "../../../core/docx/edit/index"
import { joinBackward, joinForward, lineBreak, selectAll, splitParagraph, type PagedEditor } from "../../../core/docx/paged/index"
import { docxNotes } from "../../../core/docx/stories/notes"
import { deletesBreakAtCaret } from "../../../core/docx/stories/sections"
import {
	clipboardParser,
	clipboardSerializer,
	plainSlice,
	safeClipboardHtml,
	shownSlice,
	writeClipboardEvent,
	type CutMemory
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
import { compositionFrom, deletesBreakBefore, readComposition, sessionTransaction, tabKey } from "./window"

// The input pipeline the editing views share (the paged editor's input sink, a story of the reflowed view): a
// view's transactions applied to its story's session, commands run, beforeinput (undo, redo, edits across runs),
// IME composition, the clipboard with its cut memory, and the editing keys. Each view keeps what differs (which
// session, how the view follows it, what it does around a transaction) in its StoryInputHost.

export interface StoryInputHost {
	readonly editor: PagedEditor
	// The last cut of the editor's views.
	readonly cut: CutMemory
	// The session the view edits (the paged editor's: the story being edited).
	session(): DocxEditorSession
	view(): EditorView
	readOnly(): boolean
	// Brings the view to the session's state; `force`: also when that did not change.
	sync(force: boolean): void
	// A selection the browser made that the view has not read yet, taken into the session.
	readSelection(): void
	// The session is about to take `tr` (not refused).
	beforeDispatch?(tr: Transaction): void
	// The session took `tr`, before the view follows.
	afterDispatch?(tr: Transaction, fromView: boolean): void
	// Text typed through beforeinput was applied.
	afterTyping?(): void
	// A composition ended (after its text got its formatting).
	afterComposition?(): void
	// Escape that the format painter does not take; false leaves it to the host.
	escape(): boolean
}

// The plugins a view of a session's state holds: the session's own act on its state; what stateless ones do in a
// view (paste, drop) acts there. A stateful plugin's props read its state from the view's, which has none.
export function viewPlugins(state: EditorState): Plugin[] {
	return state.plugins.flatMap(plugin =>
		plugin.spec.props === undefined || plugin.spec.state !== undefined ? [] : [new Plugin({ props: plugin.spec.props })]
	)
}

// The editing area's attributes for assistive technology and the browser: a multi-line text box, spellcheck off
// (the app's is drawn as marks), not translated.
export function textboxAttributes(label: string, describedBy: string | undefined, readOnly: boolean): Record<string, string> {
	return {
		role: "textbox",
		"aria-multiline": "true",
		"aria-label": label,
		...(describedBy === undefined ? {} : { "aria-describedby": describedBy }),
		spellcheck: "false",
		translate: "no",
		...(readOnly ? { "aria-readonly": "true" } : {})
	}
}

export class StoryInput {
	private readonly host: StoryInputHost
	private compositionStart = -1
	// The text being composed (the last compositionupdate's).
	private compositionText = ""
	// What text composed over a selection takes (selectionFormatting), until the composition ends.
	private composeFormatting: readonly Mark[] | undefined = undefined
	private dispatching = false

	constructor(host: StoryInputHost) {
		this.host = host
	}

	// The session is taking a transaction from here.
	get applying(): boolean {
		return this.dispatching
	}

	// The view's clipboard: the editor's serializers and parsers, a paste of the last cut taken as it was.
	clipboardProps(text: () => string): Partial<DirectEditorProps> {
		return {
			clipboardSerializer: clipboardSerializer(),
			clipboardParser: clipboardParser(),
			transformPastedHTML: safeClipboardHtml,
			clipboardTextSerializer: text,
			clipboardTextParser: (pasted, $context) => plainSlice(pasted, $context),
			handlePaste: (_view, event) => this.pasteCut(event.clipboardData?.getData("text/plain"))
		}
	}

	// A transaction of the view: applied to the session's state (positions are the same), and the view brought
	// to the result (whatever the browser changed that the session did not take is put back).
	dispatch(viewTr: Transaction): void {
		const host = this.host
		const session = host.session()
		const tr = viewTr.docChanged && host.readOnly() ? undefined : sessionTransaction(viewTr, host.view().state.doc, session.state)

		if (tr === undefined) {
			host.sync(true)

			return
		}

		this.apply(tr, true)
	}

	// Applies a transaction on the session's state; `fromView`: it came from the view, which is brought up to
	// date even when the session refused it.
	apply(tr: Transaction, fromView = false): void {
		const host = this.host

		if (tr.docChanged && host.readOnly()) {
			host.sync(fromView)

			return
		}

		if (this.compositionStart >= 0 && tr.docChanged) this.compositionStart = tr.mapping.map(this.compositionStart, -1)

		const event: unknown = tr.getMeta("uiEvent")

		// A pasted reference to a note that stays referenced elsewhere refers to a copy of it; a paste whose note
		// cannot be copied whole is refused.
		if ((event === "paste" || event === "drop") && !docxNotes(host.editor).pasted(tr)) {
			host.sync(fromView)

			return
		}

		host.beforeDispatch?.(tr)

		const session = host.session()

		this.dispatching = true

		try {
			session.dispatch(tr)
		} finally {
			this.dispatching = false
		}

		host.afterDispatch?.(tr, fromView)
		host.sync(fromView)

		if (host.view().composing && this.compositionStart >= 0) {
			const state = host.session().state
			const from = compositionFrom(state.doc, state.selection.head, this.compositionStart, this.compositionText)

			this.compositionStart = from
			host.editor.setComposition({
				from,
				to: this.compositionText.length > 0 ? from + this.compositionText.length : Math.max(from, state.selection.head)
			})
		}
	}

	// A command's transaction on the session's state.
	run(tr: Transaction | null | false): boolean {
		if (tr === null) return false
		if (tr !== false) this.apply(tr)

		return true
	}

	// beforeinput: undo and redo from outside the keyboard (Edit menu, shake, a soft keyboard's key), in the
	// editor's order across stories; typing over a selection and word or line deletions as transactions.
	beforeInput(view: EditorView, event: InputEvent): boolean {
		return this.historyInput(event) || this.editInput(view, event)
	}

	// Composed over a selection: the selection goes first, as a transaction.
	compositionStarted(view: EditorView): void {
		const host = this.host

		if (!host.readOnly()) {
			host.readSelection()

			const session = host.session()

			this.composeFormatting = selectionFormatting(session.state) ?? session.typingMarks(session.state)
			this.run(deleteBeforeComposition(session.state))
		}

		this.compositionStart = view.state.selection.from
		this.compositionText = ""
	}

	compositionUpdated(event: CompositionEvent): void {
		this.compositionText = event.data
	}

	compositionEnded(view: EditorView, event: CompositionEvent): void {
		readComposition(view)
		this.formatComposed(typeof event.data === "string" ? event.data : this.compositionText)
		this.compositionStart = -1
		this.compositionText = ""
		this.host.editor.setComposition(undefined)
		this.host.afterComposition?.()
	}

	// The selection as a copy writes it (the same HTML and text as a copy event), or undefined when it is empty.
	clipboardContent(): { readonly html: string; readonly text: string } | undefined {
		const host = this.host
		const state = host.session().state

		if (state.selection.empty) return undefined

		const { dom, text } = host.view().serializeForClipboard(shownSlice(state.selection.content(), host.editor.view))

		return { html: dom.innerHTML, text }
	}

	// A copy or cut writes the session's selection, as ProseMirror's own would write the view's.
	copyEvent(event: ClipboardEvent, cut: boolean): boolean {
		const host = this.host
		const content = event.clipboardData === null ? undefined : this.clipboardContent()

		if (!writeClipboardEvent(event, content) || content === undefined) return false

		host.cut.forget()

		if (cut && !host.readOnly()) {
			const session = host.session()

			host.cut.remember(session, () => content.text)
			this.apply(session.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"))
		}

		return true
	}

	// Deletes the selection (the second half of an app's Cut); false when read-only or nothing is selected.
	deleteSelection(): boolean {
		const host = this.host
		const session = host.session()

		if (host.readOnly() || session.state.selection.empty) return false

		host.cut.remember(session, slice => host.view().serializeForClipboard(slice).text)

		return this.run(session.state.tr.deleteSelection())
	}

	// Pastes what an app read from the system clipboard, through the same parsers as a paste event: HTML
	// keeps paragraphs and basic formatting only (parsed in an inert document; nothing it references loads),
	// text is taken as typed. False when read-only or there is nothing to paste.
	paste(content: { readonly html?: string; readonly text?: string }): boolean {
		if (this.host.readOnly()) return false
		if (this.pasteCut(content.text)) return true

		const view = this.host.view()

		if (content.html !== undefined && content.html.length > 0) return view.pasteHTML(content.html)
		if (content.text !== undefined && content.text.length > 0) return view.pasteText(content.text)

		return false
	}

	// Pastes the last cut as it was (CutMemory.take); false for anything else.
	pasteCut(text: string | undefined): boolean {
		const host = this.host

		if (host.readOnly()) return false

		const tr = host.cut.take(host.editor, host.session(), text)

		return tr === undefined ? false : this.run(tr)
	}

	selectAll(): boolean {
		return this.run(selectAll(this.host.session().state))
	}

	// The editing keys both views take alike: Enter, Tab, Backspace, Delete, Escape and Mod+A. `sectionBreaks`:
	// Backspace and Delete at a section break delete it (the body's views). Undefined for any other key (and
	// Mod+Enter, the page break's shortcut).
	editingKey(event: KeyboardEvent, apple: boolean, readOnly: boolean, sectionBreaks: boolean): boolean | undefined {
		const host = this.host
		const editor = host.editor
		const session = host.session()
		const mod = apple ? event.metaKey : event.ctrlKey
		const extend = event.shiftKey
		const state = session.state

		switch (event.key) {
			case "Enter":
				if (event.altKey || readOnly) return false
				// Mod+Enter: the page break's shortcut.
				if (mod) break

				return autoLinked(
					session,
					() => this.run(extend ? lineBreak(state) : splitParagraph(state, session.formats)),
					tr => this.run(tr)
				)
			case "Tab":
				return (
					!readOnly &&
					autoLinked(
						session,
						() => tabKey(editor, session, event, apple, tr => this.run(tr)),
						tr => this.run(tr)
					)
				)
			// At a paragraph's edge any deletion (a character, a word, to the line's start) joins paragraphs.
			case "Backspace":
				if (readOnly) return false
				// After a section break: the break goes (the sections merge), as Word deletes it.
				if (sectionBreaks && deletesBreakBefore(editor)) return true

				host.readSelection()

				return this.run(deleteSelectionKey(session.state) ?? joinBackward(session.state, session.formats))
			case "Delete":
				// Shift+Delete cuts.
				if (readOnly || extend) return false
				// Before a section break: the break goes (the sections merge), as Word deletes it.
				if (sectionBreaks && deletesBreakAtCaret(editor)) {
					void editor.execute({ type: "section.deleteBreak" })

					return true
				}

				host.readSelection()

				return this.run(deleteSelectionKey(session.state) ?? joinForward(session.state))
			case "Escape":
				// The format painter goes first.
				if (editor.painter !== undefined) {
					editor.setPainter(undefined)

					return true
				}

				return host.escape()
		}

		if (mod && !event.altKey && !extend && event.key.toLowerCase() === "a") return this.selectAll()

		return undefined
	}

	// beforeinput historyUndo / historyRedo: the editor undoes or redoes in its order across stories (the
	// browser's own never runs).
	private historyInput(event: InputEvent): boolean {
		const type = event.inputType === "historyUndo" ? "history.undo" : event.inputType === "historyRedo" ? "history.redo" : undefined

		if (type === undefined) return false

		event.preventDefault()

		if (!this.host.readOnly()) void this.host.editor.execute({ type })

		return true
	}

	// A composition that started over a selection ends: its text gets the formatting it takes, wherever the
	// browser composed it (it composes into the run its selection ended in).
	private formatComposed(text: string): void {
		const formatting = this.composeFormatting

		this.composeFormatting = undefined

		if (formatting === undefined || this.compositionStart < 0 || this.host.readOnly()) return

		const state = this.host.session().state
		const from = compositionFrom(state.doc, state.selection.head, this.compositionStart, text)

		this.run(composedFormatting(state, from, text, formatting))
	}

	// beforeinput that would edit the DOM across runs (see inputTransaction): made on the session's state.
	private editInput(view: EditorView, event: InputEvent): boolean {
		const host = this.host

		if (host.readOnly() || !event.cancelable) return false

		host.readSelection()

		const session = host.session()
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

		host.afterTyping?.()

		return true
	}
}
