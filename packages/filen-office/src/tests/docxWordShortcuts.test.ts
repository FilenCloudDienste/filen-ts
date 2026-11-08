import type { Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { docxSchema, type DocxEditorCommand, type DocxEditorSession } from "@filen/office/core/docx/edit"
import { commandForKey, isRepeatKey, type KeyLike } from "../core/docx/paged/keys"
import { firstCaseMode } from "../core/docx/edit/changeCase"
import { sessionOf } from "./docxEditFixtures"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor } from "./pagedFixtures"

const marks = docxSchema.marks

function key(init: Partial<KeyLike> & { key: string }): KeyLike {
	return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init }
}

function select(session: DocxEditorSession, from: number, to: number = from): void {
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

function text(session: DocxEditorSession): string {
	return session.state.doc.textBetween(0, session.state.doc.content.size, "\n")
}

function markOf(node: Node | null | undefined, name: keyof typeof marks): Record<string, unknown> | undefined {
	return node?.marks.find(mark => mark.type === marks[name])?.attrs
}

const run = (session: DocxEditorSession, command: DocxEditorCommand): boolean => session.execute(command)

describe("Word's character shortcuts", () => {
	const cases: readonly [KeyLike, boolean, DocxEditorCommand["type"]][] = [
		// Ctrl+Shift+> and Ctrl+Shift+< (US layout: the key gives the shifted character).
		[key({ key: ">", code: "Period", ctrlKey: true, shiftKey: true }), false, "font.grow"],
		[key({ key: "<", code: "Comma", ctrlKey: true, shiftKey: true }), false, "font.shrink"],
		[key({ key: ">", code: "Period", metaKey: true, shiftKey: true }), true, "font.grow"],
		[key({ key: "]", code: "BracketRight", ctrlKey: true }), false, "font.growPoint"],
		[key({ key: "[", code: "BracketLeft", metaKey: true }), true, "font.shrinkPoint"],
		// Ctrl+Shift+Plus and Ctrl+Shift+Minus.
		[key({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }), false, "format.superscript"],
		[key({ key: "_", code: "Minus", ctrlKey: true, shiftKey: true }), false, "format.subscript"],
		[key({ key: "_", code: "Minus", metaKey: true, shiftKey: true }), true, "format.subscript"],
		[key({ key: "D", code: "KeyD", ctrlKey: true, shiftKey: true }), false, "format.doubleUnderline"],
		[key({ key: "A", code: "KeyA", ctrlKey: true, shiftKey: true }), false, "format.allCaps"],
		[key({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }), false, "format.smallCaps"],
		[key({ key: "F3", code: "F3", shiftKey: true }), false, "format.changeCase"],
		[key({ key: "F3", code: "F3", shiftKey: true }), true, "format.changeCase"]
	]

	it.each(cases)("maps %j (apple %s) to %s", (event, apple, type) => {
		expect(commandForKey(event, apple)?.type).toBe(type)
	})

	it("leaves the unshifted punctuation and the wrong modifier alone", () => {
		expect(commandForKey(key({ key: ".", code: "Period", ctrlKey: true }), false)).toBeUndefined()
		expect(commandForKey(key({ key: "]", code: "BracketRight", ctrlKey: true }), true)).toBeUndefined()
		expect(commandForKey(key({ key: "F3", code: "F3" }), false)).toBeUndefined()
	})

	it("binds Repeat to F4 off Apple platforms only", () => {
		expect(isRepeatKey(key({ key: "F4", code: "F4" }), false)).toBe(true)
		expect(isRepeatKey(key({ key: "F4", code: "F4" }), true)).toBe(false)
		expect(isRepeatKey(key({ key: "F4", code: "F4", altKey: true }), false)).toBe(false)
	})
})

describe("one-point font size steps", () => {
	it("grows and shrinks by one point from each piece's size, within Word's limits", async () => {
		const session = await sessionOf({
			body: '<w:p><w:r><w:t>Ab</w:t></w:r><w:r><w:rPr><w:sz w:val="21"/></w:rPr><w:t>Cd</w:t></w:r><w:r><w:rPr><w:sz w:val="2"/></w:rPr><w:t>Ef</w:t></w:r></w:p>'
		})

		select(session, 1, 7)
		expect(run(session, { type: "font.growPoint" })).toBe(true)
		// Default 10 points, 10.5 points and 1 point, each one point larger.
		expect(markOf(session.state.doc.nodeAt(1), "size")).toEqual({ value: 22, cs: 22 })
		expect(markOf(session.state.doc.nodeAt(3), "size")).toEqual({ value: 23, cs: 23 })
		expect(markOf(session.state.doc.nodeAt(5), "size")).toEqual({ value: 4, cs: 4 })
		run(session, { type: "font.shrinkPoint" })
		run(session, { type: "font.shrinkPoint" })
		expect(markOf(session.state.doc.nodeAt(3), "size")).toEqual({ value: 19, cs: 19 })
		expect(markOf(session.state.doc.nodeAt(5), "size")).toEqual({ value: 2, cs: 2 })
	})
})

describe("double underline", () => {
	it("turns double underline on over a mixed selection, keeps an underline colour, and off when all have it", async () => {
		const session = await sessionOf({
			body: '<w:p><w:r><w:t>Ab</w:t></w:r><w:r><w:rPr><w:u w:val="single" w:color="FF0000"/></w:rPr><w:t>Cd</w:t></w:r></w:p>'
		})

		select(session, 1, 5)
		expect(run(session, { type: "format.doubleUnderline" })).toBe(true)
		expect(markOf(session.state.doc.nodeAt(1), "underline")).toMatchObject({ style: "double", value: null })
		expect(markOf(session.state.doc.nodeAt(3), "underline")).toMatchObject({ style: "double", value: "FF0000" })
		expect(run(session, { type: "format.doubleUnderline" })).toBe(true)
		expect(markOf(session.state.doc.nodeAt(1), "underline")).toBeUndefined()
		expect(markOf(session.state.doc.nodeAt(3), "underline")).toMatchObject({ style: "none", value: "FF0000" })
	})
})

describe("Change Case", () => {
	it("picks Word's next case", () => {
		expect(firstCaseMode("hello world")).toBe("title")
		expect(firstCaseMode("HELLO WORLD")).toBe("lower")
		expect(firstCaseMode("Hello World")).toBe("upper")
		expect(firstCaseMode("123 !")).toBeUndefined()
	})

	it("cycles a selection through title, upper and lower case, keeping each run's formatting", async () => {
		const session = await sessionOf({
			body: '<w:p><w:r><w:t xml:space="preserve">hello </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>wor</w:t></w:r><w:r><w:t>ld don\'t</w:t></w:r></w:p>'
		})
		const end = session.state.doc.child(0).content.size + 1

		select(session, 1, end)
		expect(run(session, { type: "format.changeCase" })).toBe(true)
		expect(text(session)).toBe("Hello World Don't")
		// The bold run is still bold and the selection still covers the text.
		expect(markOf(session.state.doc.nodeAt(7), "bold")).toBeDefined()
		expect(session.state.selection.from).toBe(1)
		expect(session.state.selection.to).toBe(end)
		run(session, { type: "format.changeCase" })
		expect(text(session)).toBe("HELLO WORLD DON'T")
		run(session, { type: "format.changeCase" })
		expect(text(session)).toBe("hello world don't")
		run(session, { type: "history.undo" })
		expect(text(session)).toBe("HELLO WORLD DON'T")
	})

	it("changes the caret's word, keeps the caret, and maps with the run's language and length changes", async () => {
		const session = await sessionOf({
			body: p("one two") + '<w:p><w:r><w:rPr><w:lang w:val="tr-TR"/></w:rPr><w:t>istanbul straße</w:t></w:r></w:p>'
		})

		// Inside "two".
		select(session, 6)
		expect(run(session, { type: "format.changeCase" })).toBe(true)
		expect(text(session)).toBe("one Two\nistanbul straße")
		expect(session.state.selection.from).toBe(6)

		const second = session.state.doc.child(0).nodeSize
		const end = second + session.state.doc.child(1).nodeSize - 1

		select(session, second + 1, end)
		run(session, { type: "format.changeCase" })
		run(session, { type: "format.changeCase" })
		// Turkish dotted capital I; "ß" becomes "SS".
		expect(text(session)).toBe("one Two\nİSTANBUL STRASSE")
		expect(session.state.selection.to).toBe(end + 1)
	})

	it("does nothing at a caret outside a word or over text without letters", async () => {
		const session = await sessionOf({ body: p("one two") + p("123") })

		select(session, 4)
		expect(run(session, { type: "format.changeCase" })).toBe(false)
		select(session, 10, 13)
		expect(run(session, { type: "format.changeCase" })).toBe(false)
	})
})

describe("Repeat", () => {
	it("runs the last story command again where the selection is now, and nothing after typing", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("Hello world") }))
		const session = editor.session

		expect(editor.repeat()).toBe(false)
		select(session, 1, 6)
		expect(editor.execute({ type: "font.size", halfPoints: 40 })).toBe(true)
		select(session, 7, 12)
		expect(editor.repeat()).toBe(true)
		expect(markOf(session.state.doc.nodeAt(7), "size")).toEqual({ value: 40, cs: 40 })

		// Selection changes keep it; an edit not made by a command ends it.
		select(session, 1)
		session.dispatch(session.state.tr.insertText("x"))
		select(session, 1, 6)
		expect(editor.repeat()).toBe(false)
	})

	it("does not record commands that do not write", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("Hello world") }))

		select(editor.session, 1, 6)
		expect(await editor.execute({ type: "format.copy" })).toBe(true)
		expect(editor.repeat()).toBe(false)
	})
})
