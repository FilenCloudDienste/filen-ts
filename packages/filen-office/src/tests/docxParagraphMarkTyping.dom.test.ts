import type { Node } from "prosemirror-model"
import { TextSelection, type EditorState } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import { describe, expect, it } from "vitest"
import { bytesSource, OpcPackage } from "@filen/office/core/opc"
import { docxSchema, type DocxEditorSession } from "@filen/office/core/docx/edit"
import { saveDocx } from "@filen/office/core/docx/write"
import { inputTransaction } from "../react/docx/edit/input"
import { openSpec } from "./docxEditFixtures"
import { p } from "./docxSynthetic"
import { DocxEditorSession as Session } from "../core/docx/edit/session"

// Text typed into a paragraph holding no content takes the paragraph mark's run properties (w:pPr/w:rPr), as
// Word types there; the toolbar reports them at the caret.

const marks = docxSchema.marks
const decoder = new TextDecoder()

const EMPTY_FORMATTED = '<w:p><w:pPr><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:pPr></w:p>'

async function open(body: string): Promise<{ session: DocxEditorSession; save: () => Promise<string> }> {
	const opened = await openSpec({ body })
	const session = new Session(opened.context)

	return {
		session,
		save: async () => {
			const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })

			if (result.bytes === undefined) throw new Error("No bytes")

			return decoder.decode(await (await OpcPackage.open(bytesSource(result.bytes))).read("word/document.xml"))
		}
	}
}

function caret(session: DocxEditorSession, pos: number): void {
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, pos)))
}

// A beforeinput typing `text` at the caret, made as the views make it.
function type(session: DocxEditorSession, text: string): boolean {
	const view = { composing: false } as unknown as EditorView
	const event = { inputType: "insertText", isComposing: false, data: text, getTargetRanges: () => [] } as unknown as InputEvent
	const tr = inputTransaction(view, session.state, event, (state: EditorState) => session.typingMarks(state))

	// Left to the browser: ProseMirror reads the typed text back with the caret's marks.
	return session.dispatch(tr ?? session.state.tr.insertText(text))
}

function markOf(node: Node | null, name: keyof typeof marks): Record<string, unknown> | undefined {
	return node?.marks.find(mark => mark.type === marks[name])?.attrs
}

describe("typing into an empty paragraph", () => {
	it("takes the paragraph mark's formatting, reports it, and writes it", async () => {
		const doc = await open(EMPTY_FORMATTED + p("After"))
		const session = doc.session

		caret(session, 1)
		expect(session.snapshot().formats.bold).toBe("on")
		expect(session.snapshot().values.size).toBe(48)
		expect(type(session, "x")).toBe(true)

		const typed = session.state.doc.nodeAt(1)

		expect(typed?.text).toBe("x")
		expect(markOf(typed, "bold")).toEqual({ value: true, cs: null })
		expect(markOf(typed, "size")).toEqual({ value: 48, cs: null })

		// What follows the typed text keeps its formatting.
		expect(type(session, "y")).toBe(true)
		expect(markOf(session.state.doc.nodeAt(2), "bold")).toEqual({ value: true, cs: null })

		const xml = await doc.save()
		const first = xml.slice(xml.indexOf("<w:p>"), xml.indexOf("</w:p>"))

		expect(first).toMatch(/<w:r><w:rPr><w:b\/><w:sz w:val="48"\/><\/w:rPr><w:t[^>]*>xy<\/w:t><\/w:r>/)
	})

	it("turns bold off at the caret and keeps the mark's size", async () => {
		const { session } = await open(EMPTY_FORMATTED)

		caret(session, 1)
		expect(session.execute({ type: "format.bold" })).toBe(true)
		expect(session.snapshot().formats.bold).toBe("off")
		expect(session.snapshot().values.size).toBe(48)
		type(session, "x")
		// The style is not bold: turning bold off drops the direct value.
		expect(markOf(session.state.doc.nodeAt(1), "bold")).toBeUndefined()
		expect(markOf(session.state.doc.nodeAt(1), "size")).toEqual({ value: 48, cs: null })
	})

	it("takes nothing from a mark carrying only a revision or a property change", async () => {
		const revised =
			'<w:p><w:pPr><w:rPr><w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"/>' +
			'<w:rPrChange w:id="2" w:author="A" w:date="2024-01-01T00:00:00Z"><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr></w:pPr></w:p>'
		const { session } = await open(revised)

		caret(session, 1)
		expect(session.typingMarks(session.state)).toBeUndefined()
		type(session, "x")
		expect(session.state.doc.nodeAt(1)?.marks).toEqual([])
		expect(session.snapshot().formats.italic).toBe("off")
	})

	it("ignores the paragraph mark in a paragraph with content", async () => {
		const { session } = await open("<w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:t>ab</w:t></w:r></w:p>")

		caret(session, 2)
		expect(session.typingMarks(session.state)).toBeUndefined()
		expect(session.snapshot().formats.bold).toBe("off")
		type(session, "x")
		expect(markOf(session.state.doc.nodeAt(2), "bold")).toBeUndefined()
	})

	it("takes the mark's formatting past range markers", async () => {
		const { session } = await open(
			'<w:p><w:pPr><w:rPr><w:i/></w:rPr></w:pPr><w:bookmarkStart w:id="0" w:name="b"/><w:bookmarkEnd w:id="0"/></w:p>'
		)

		caret(session, 1)
		expect(session.snapshot().formats.italic).toBe("on")
	})
})
