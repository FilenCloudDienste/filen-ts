// @vitest-environment happy-dom
import type { Mark, Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import { afterEach, describe, expect, it } from "vitest"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import { EditSink } from "@filen/office/react/docx/editor"
import { ReflowView } from "../react/docx/reflow/view"
import { buildDocx } from "./docxSynthetic"
import { emptyDocxDocument } from "./docxDocumentStubs.dom"
import { pagedEditor } from "./pagedDomFixtures"

// Deleting or typing over a selection that crosses runs, and word deletions, are transactions on the document
// (never the browser's DOM edit read back): the rest of the last run keeps its own formatting, scale, kerning
// and position included, and track changes records exactly what went and what was typed.

const DOCUMENT = emptyDocxDocument()

const cleanups: (() => void)[] = []

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup()
})

const SURFACES: readonly { readonly name: string; open(editor: PagedEditor): EditorView }[] = [
	{
		name: "the pages' input view",
		open(editor) {
			const host = document.createElement("div")

			document.body.appendChild(host)

			const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })

			cleanups.push(() => {
				sink.destroy()
				host.remove()
			})

			return sink.view
		}
	},
	{
		name: "Mobile view",
		open(editor) {
			const scroller = document.createElement("div")

			document.body.appendChild(scroller)
			editor.suspend()

			const reflow = new ReflowView(editor, scroller, {
				label: "Document",
				readOnly: false,
				apple: false,
				onFind: undefined,
				marks: [],
				interactions: undefined,
				document: DOCUMENT
			})

			cleanups.push(() => {
				reflow.destroy()
				scroller.remove()
				editor.resume()
			})

			return reflow.main.view
		}
	}
]

const BOLD = "<w:rPr><w:b/><w:bCs/></w:rPr>"
const FANCY =
	'<w:rPr><w:color w:val="C00000"/><w:spacing w:val="20"/><w:w w:val="150"/><w:kern w:val="28"/><w:position w:val="4"/><w:highlight w:val="yellow"/><w:u w:val="single"/><w:lang w:val="en-GB"/></w:rPr>'
const DOC = buildDocx({
	body:
		`<w:p><w:r>${BOLD}<w:t>Targeted FSM</w:t></w:r><w:r>${FANCY}<w:t xml:space="preserve">: for households</w:t></w:r></w:p>` +
		`<w:p><w:r>${BOLD}<w:t>BP</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>1</w:t></w:r><w:r>${BOLD}<w:t>5</w:t></w:r><w:r>${FANCY}<w:t xml:space="preserve"> Directions</w:t></w:r></w:p>`
})

// The text of `doc`, inserted text in [], deleted in {}.
function marked(doc: Node): string {
	let out = ""

	doc.descendants(node => {
		if (node.isText) {
			const names = node.marks.map(mark => mark.type.name)

			out += names.includes("insertion")
				? `[${node.text ?? ""}]`
				: names.includes("deletion")
					? `{${node.text ?? ""}}`
					: (node.text ?? "")
		} else if (node.isTextblock && out !== "") out += "|"

		return true
	})

	return out
}

// The marks of the text node holding `text` (without review marks).
function marksOf(doc: Node, text: string): readonly Mark[] | undefined {
	let found: readonly Mark[] | undefined

	doc.descendants(node => {
		if (found === undefined && node.isText && (node.text ?? "").includes(text))
			found = node.marks.filter(mark => mark.type.name !== "insertion" && mark.type.name !== "deletion")

		return found === undefined
	})

	return found
}

function sameMarks(a: readonly Mark[] | undefined, b: readonly Mark[] | undefined): boolean {
	return a !== undefined && b !== undefined && a.length === b.length && a.every((mark, k) => b[k]?.eq(mark) === true)
}

function startOf(doc: Node, text: string): number {
	let start = -1

	doc.descendants((node, pos) => {
		if (start < 0 && node.isTextblock && node.textContent.startsWith(text)) start = pos + 1

		return start < 0
	})

	return start
}

async function open(surface: (typeof SURFACES)[number], tracked: boolean): Promise<{ editor: PagedEditor; view: EditorView }> {
	const { editor } = await pagedEditor(DOC)
	const session = editor.body.session

	if (tracked) {
		session.context.review.tracking = true
		session.context.identity.author = "Ann"
	}

	return { editor, view: surface.open(editor) }
}

function select(editor: PagedEditor, from: number, to: number): void {
	const session = editor.body.session

	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

function key(view: EditorView, name: string): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })

	view.dom.dispatchEvent(event)

	return event
}

function input(view: EditorView, inputType: string, data: string | null, range?: { from: number; to: number }): InputEvent {
	const event = new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true })

	if (range !== undefined) {
		const start = view.domAtPos(range.from, 1)
		const end = view.domAtPos(range.to, -1)
		const target = document.createRange()

		target.setStart(start.node, start.offset)
		target.setEnd(end.node, end.offset)
		Object.defineProperty(event, "getTargetRanges", { value: () => [target] })
	}

	view.dom.dispatchEvent(event)

	return event
}

for (const surface of SURFACES) {
	describe(`Editing over a selection that crosses runs in ${surface.name}`, () => {
		for (const name of ["Backspace", "Delete"]) {
			it(`${name} deletes it and the rest of the last run keeps its own formatting`, async () => {
				const { editor, view } = await open(surface, false)
				const doc = editor.body.session.state.doc
				const start = startOf(doc, "Targeted FSM")
				const before = marksOf(doc, ": for households")

				select(editor, start, start + "Targeted FSM: f".length)

				expect(key(view, name).defaultPrevented).toBe(true)

				const after = editor.body.session.state.doc

				expect(marked(after)).toBe("or households|BP15 Directions")
				expect(sameMarks(marksOf(after, "or households"), before)).toBe(true)
			})
		}

		it("typing replaces it with text in the first selected character's formatting, the rest keeping its own", async () => {
			const { editor, view } = await open(surface, false)
			const doc = editor.body.session.state.doc
			const start = startOf(doc, "Targeted FSM")
			const bold = marksOf(doc, "Targeted FSM")
			const fancy = marksOf(doc, ": for households")

			select(editor, start, start + "Targeted FSM: f".length)

			expect(input(view, "insertText", "X").defaultPrevented).toBe(true)

			const after = editor.body.session.state.doc

			expect(marked(after)).toBe("Xor households|BP15 Directions")
			expect(sameMarks(marksOf(after, "X"), bold)).toBe(true)
			expect(sameMarks(marksOf(after, "or households"), fancy)).toBe(true)
		})

		it("a replacement replaces its target range", async () => {
			const { editor, view } = await open(surface, false)
			const start = startOf(editor.body.session.state.doc, "Targeted FSM")

			input(view, "insertReplacementText", "Target", { from: start, to: start + "Targeted".length })

			expect(marked(editor.body.session.state.doc)).toBe("Target FSM: for households|BP15 Directions")
		})

		it("a word deletion across runs deletes its target range and the next run keeps its own formatting", async () => {
			const { editor, view } = await open(surface, false)
			const doc = editor.body.session.state.doc
			const start = startOf(doc, "BP15")
			const fancy = marksOf(doc, " Directions")

			select(editor, start + 4, start + 4)

			expect(input(view, "deleteWordBackward", null, { from: start, to: start + 4 }).defaultPrevented).toBe(true)

			const after = editor.body.session.state.doc

			expect(marked(after)).toBe("Targeted FSM: for households| Directions")
			expect(sameMarks(marksOf(after, " Directions"), fancy)).toBe(true)
		})

		it("a composition that starts over it deletes it first", async () => {
			const { editor, view } = await open(surface, false)
			const start = startOf(editor.body.session.state.doc, "Targeted FSM")

			select(editor, start, start + "Targeted FSM: f".length)
			view.dom.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }))

			expect(marked(editor.body.session.state.doc)).toBe("or households|BP15 Directions")
			expect(editor.body.session.state.selection.from).toBe(start)
		})

		// A composition read as ProseMirror reads one: the committed text typed where the browser composed it
		// (here the start of the run after the deleted selection, plain).
		const compose = async (view: EditorView, editor: PagedEditor, start: number, text: string): Promise<void> => {
			view.dom.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }))
			view.dispatch(view.state.tr.insertText(text, start, start).setMeta("composition", 1))
			const end = new CompositionEvent("compositionend", { data: text, bubbles: true })

			// happy-dom leaves the event without its data.
			Object.defineProperty(end, "data", { value: text })
			view.dom.dispatchEvent(end)
			await new Promise(resolve => setTimeout(resolve, 20))
			expect(editor.body.session.state.doc.textBetween(start, start + text.length)).toBe(text)
		}

		it("text composed over it takes the first selected character's formatting, the rest keeping its own", async () => {
			const { editor, view } = await open(surface, false)
			const doc = editor.body.session.state.doc
			const start = startOf(doc, "Targeted FSM")
			const bold = marksOf(doc, "Targeted FSM")
			const fancy = marksOf(doc, ": for households")

			select(editor, start, start + "Targeted FSM: f".length)
			await compose(view, editor, start, "日本")

			const after = editor.body.session.state.doc

			expect(marked(after)).toBe("日本or households|BP15 Directions")
			expect(sameMarks(marksOf(after, "日本"), bold)).toBe(true)
			expect(sameMarks(marksOf(after, "or households"), fancy)).toBe(true)
		})

		it("one undo takes back a composition over it, its formatting included", async () => {
			const { editor, view } = await open(surface, false)
			const before = editor.body.session.state.doc
			const start = startOf(before, "Targeted FSM")

			select(editor, start, start + "Targeted FSM: f".length)
			await compose(view, editor, start, "日本")
			await editor.execute({ type: "history.undo" })

			expect(editor.body.session.state.doc.eq(before)).toBe(true)
		})

		it("with track changes on, a composition over it records the selection as deleted and one insertion in its formatting", async () => {
			const { editor, view } = await open(surface, true)
			const doc = editor.body.session.state.doc
			const start = startOf(doc, "Targeted FSM")
			const bold = marksOf(doc, "Targeted FSM")

			select(editor, start, start + "Targeted FSM: f".length)
			await compose(view, editor, start, "日本")

			const after = editor.body.session.state.doc

			expect(marked(after)).toMatch(
				/^(\{Targeted FSM\}\{: f\}\[日本\]|\[日本\]\{Targeted FSM\}\{: f\})or households\|BP15 Directions$/
			)
			expect(sameMarks(marksOf(after, "日本"), bold)).toBe(true)
		})

		it("with track changes on, Backspace records exactly the selected text as deleted", async () => {
			const { editor, view } = await open(surface, true)
			const start = startOf(editor.body.session.state.doc, "Targeted FSM")

			select(editor, start, start + "Targeted FSM: f".length)
			key(view, "Backspace")

			expect(marked(editor.body.session.state.doc)).toBe("{Targeted FSM}{: f}or households|BP15 Directions")
		})

		it("with track changes on, typing over it records the selected text as deleted and the typed text as inserted", async () => {
			const { editor, view } = await open(surface, true)
			const start = startOf(editor.body.session.state.doc, "BP15")

			select(editor, start + 2, start + 4)
			input(view, "insertText", "X")

			expect(marked(editor.body.session.state.doc)).toMatch(
				/^Targeted FSM: for households\|BP(\{1\}\{5\}\[X\]|\[X\]\{1\}\{5\}) Directions$/
			)
		})
	})
}

describe("Focus across a switch of views", () => {
	it("goes on in Mobile view when the pages' input view is taken out with it", async () => {
		const { editor } = await pagedEditor(DOC)
		const host = document.createElement("div")

		document.body.appendChild(host)

		const sink = new EditSink(editor, host, { label: "Document", caretClientRect: () => undefined })

		sink.focus()
		expect(sink.focused).toBe(true)
		// Taken out first, blurred on the way as Chromium does, destroyed after.
		sink.releaseFocus()
		sink.view.dom.blur()
		host.remove()
		sink.destroy()

		const reflow = SURFACES[1]?.open(editor)

		expect(reflow?.hasFocus()).toBe(true)
	})
})
