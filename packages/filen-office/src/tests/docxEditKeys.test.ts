import type { Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import type { DocxEditorSession } from "@filen/office/core/docx/edit"
import { commandForKey, joinBackward, splitParagraph, type KeyLike } from "../core/docx/paged/keys"
import { NUMBERING_PART, STYLES_PART, sessionOf } from "./docxEditFixtures"
import { p } from "./docxSynthetic"

// Enter, Backspace and shortcuts as Word's.

const STYLES = STYLES_PART(
	'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
		'<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/></w:style>' +
		'<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:next w:val="Quote"/></w:style>' +
		'<w:style w:type="paragraph" w:styleId="Bulleted"><w:name w:val="Bulleted"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>'
)

const NUMBERING = NUMBERING_PART(
	'<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>' +
		'<w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
		'<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
)

const PARTS = {
	parts: [STYLES, NUMBERING],
	relationships: [
		{ id: "rIdS", type: "styles", target: "styles.xml" },
		{ id: "rIdN", type: "numbering", target: "numbering.xml" }
	]
}

const NUM = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'

function caret(session: DocxEditorSession, pos: number): void {
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, pos)))
}

function enter(session: DocxEditorSession): void {
	const tr = splitParagraph(session.state, session.formats)

	expect(tr).not.toBeNull()
	expect(tr !== null && session.dispatch(tr)).toBe(true)
}

function type(session: DocxEditorSession, text: string): void {
	session.dispatch(session.state.tr.insertText(text))
}

function markNames(paragraph: Node): string[] {
	const names: string[] = []

	paragraph.forEach(child => {
		for (const mark of child.marks)
			names.push(mark.attrs["value"] === undefined ? mark.type.name : `${mark.type.name}=${String(mark.attrs["value"])}`)
	})

	return names.filter(name => name !== "run").sort()
}

function key(key: string, code: string, modifiers: Partial<KeyLike> = {}): KeyLike {
	return { key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers }
}

describe("docx Enter", () => {
	it("keeps the caret's run formatting for text typed in the new paragraph", async () => {
		const session = await sessionOf({
			body: '<w:p><w:r><w:rPr><w:b/><w:sz w:val="40"/></w:rPr><w:t>Bold big</w:t></w:r></w:p>',
			...PARTS
		})

		caret(session, 9)
		enter(session)
		type(session, "x")

		expect(session.state.doc.childCount).toBe(2)
		expect(session.state.doc.child(1).textContent).toBe("x")
		expect(markNames(session.state.doc.child(1))).toEqual(markNames(session.state.doc.child(0)))
		expect(markNames(session.state.doc.child(1))).toContain("size=40")
	})

	it("keeps a formatting toggled at the caret", async () => {
		const session = await sessionOf({ body: p("plain"), ...PARTS })

		caret(session, 6)
		expect(session.execute({ type: "format.bold" })).toBe(true)
		enter(session)
		type(session, "x")

		expect(markNames(session.state.doc.child(1))).toEqual(["bold=true"])
	})

	it("does not carry a link into the new paragraph", async () => {
		const session = await sessionOf({
			body: '<w:p><w:hyperlink w:anchor="top"><w:r><w:rPr><w:i/></w:rPr><w:t>link</w:t></w:r></w:hyperlink></w:p>',
			...PARTS
		})

		caret(session, 5)
		enter(session)
		type(session, "x")

		const names = markNames(session.state.doc.child(1))

		expect(names).toContain("italic=true")
		expect(names).not.toContain("link")
	})

	it("gives the new paragraph the style's following style at the paragraph's end only", async () => {
		const session = await sessionOf({
			body: p("Title", '<w:pStyle w:val="Heading1"/>') + p("Said", '<w:pStyle w:val="Quote"/>'),
			...PARTS
		})

		caret(session, 6)
		enter(session)
		expect(session.state.doc.child(0).attrs["styleId"]).toBe("Heading1")
		// Normal is the default paragraph style: no style id.
		expect(session.state.doc.child(1).attrs["styleId"]).toBeNull()

		// A style following itself keeps it.
		const quote = session.state.doc.child(0).nodeSize + session.state.doc.child(1).nodeSize

		caret(session, quote + 5)
		enter(session)
		expect(session.state.doc.child(3).attrs["styleId"]).toBe("Quote")

		// Mid-paragraph: both halves keep the heading.
		caret(session, 3)
		enter(session)
		expect(session.state.doc.child(0).attrs["styleId"]).toBe("Heading1")
		expect(session.state.doc.child(1).attrs["styleId"]).toBe("Heading1")
	})

	it("ends the list in an empty item instead of adding another", async () => {
		const session = await sessionOf({
			body: p("one", NUM) + `<w:p><w:pPr>${NUM}</w:pPr></w:p>` + p("styled", '<w:pStyle w:val="Bulleted"/>'),
			...PARTS
		})
		const second = session.state.doc.child(0).nodeSize + 1

		caret(session, second)
		enter(session)
		expect(session.state.doc.childCount).toBe(3)
		expect(session.formats.listOf(session.state.doc.child(1))).toBeUndefined()
		expect(session.state.doc.child(1).attrs["numId"]).toBeNull()

		// Text in a list item: Enter at its end adds an item.
		caret(session, second - 2)
		enter(session)
		expect(session.state.doc.childCount).toBe(4)
		expect(session.formats.listOf(session.state.doc.child(1))).toBeDefined()
	})

	it("switches off numbering a style gives in an empty item", async () => {
		const session = await sessionOf({ body: p("one", '<w:pStyle w:val="Bulleted"/>'), ...PARTS })

		caret(session, 4)
		enter(session)
		expect(session.formats.listOf(session.state.doc.child(1))).toBeDefined()
		enter(session)
		expect(session.state.doc.childCount).toBe(2)
		expect(session.state.doc.child(1).attrs["numId"]).toBe(0)
		expect(session.formats.listOf(session.state.doc.child(1))).toBeUndefined()
	})
})

describe("docx Backspace", () => {
	it("removes the number at a list item's start, the text staying where it was", async () => {
		const session = await sessionOf({ body: p("one", NUM) + p("two", NUM), ...PARTS })

		for (const at of [session.state.doc.child(0).nodeSize + 1, 1]) {
			caret(session, at)

			const tr = joinBackward(session.state, session.formats)

			expect(tr).toBeTruthy()
			expect(tr !== null && tr !== false && session.dispatch(tr)).toBe(true)
		}

		expect(session.state.doc.childCount).toBe(2)

		for (let k = 0; k < 2; k++) {
			const paragraph = session.state.doc.child(k)

			expect(session.formats.listOf(paragraph)).toBeUndefined()
			expect(session.formats.paragraph(paragraph).props.indent).toMatchObject({ start: 720, firstLine: 0 })
		}

		// Without numbering, the next Backspace joins.
		caret(session, session.state.doc.child(0).nodeSize + 1)

		const join = joinBackward(session.state, session.formats)

		expect(join !== null && join !== false && session.dispatch(join)).toBe(true)
		expect(session.state.doc.childCount).toBe(1)
		expect(session.state.doc.child(0).textContent).toBe("onetwo")
	})
})

describe("docx shortcuts", () => {
	it("follow the character the layout gives", () => {
		// Dvorak: C is where QWERTY has I, X where it has B.
		expect(commandForKey(key("c", "KeyI", { ctrlKey: true }), false)).toBeUndefined()
		expect(commandForKey(key("x", "KeyB", { ctrlKey: true }), false)).toBeUndefined()
		expect(commandForKey(key("i", "KeyC", { ctrlKey: true }), false)).toEqual({ type: "format.italic" })
		// Cyrillic: the physical key.
		expect(commandForKey(key("и", "KeyB", { ctrlKey: true }), false)).toEqual({ type: "format.bold" })
		// macOS Option+B composes a character: the physical key.
		expect(commandForKey(key("∫", "KeyB", { metaKey: true, altKey: true }), true)).toBeUndefined()
		expect(commandForKey(key("∫", "KeyB", { metaKey: true }), true)).toEqual({ type: "format.bold" })
		// AZERTY: the digit row gives "&" unshifted; a shifted digit is the digit.
		expect(commandForKey(key("&", "Digit1", { metaKey: true, altKey: true }), true)).toEqual({ type: "style.set", style: "heading1" })
		expect(commandForKey(key("7", "Digit7", { ctrlKey: true, shiftKey: true }), false)).toEqual({ type: "list.numbered" })
		expect(commandForKey(key("1", "Digit1", { metaKey: true, altKey: true }), true)).toEqual({ type: "style.set", style: "heading1" })
	})

	it("leave characters AltGr gives to typing", () => {
		const altGr = { ctrlKey: true, altKey: true }

		expect(commandForKey(key("²", "Digit2", altGr), false)).toBeUndefined()
		expect(commandForKey(key("³", "Digit3", altGr), false)).toBeUndefined()
		expect(commandForKey({ ...key("2", "Digit2", altGr), getModifierState: name => name === "AltGraph" }, false)).toBeUndefined()
		expect(commandForKey(key("2", "Digit2", altGr), false)).toEqual({ type: "style.set", style: "heading2" })
	})

	it("redo with Mod+Y on every platform", () => {
		expect(commandForKey(key("y", "KeyY", { metaKey: true }), true)).toEqual({ type: "history.redo" })
		expect(commandForKey(key("y", "KeyY", { ctrlKey: true }), false)).toEqual({ type: "history.redo" })
	})

	it("indent, outdent and line spacing as Word's", () => {
		expect(commandForKey(key("m", "KeyM", { ctrlKey: true }), false)).toEqual({ type: "list.indent" })
		expect(commandForKey(key("M", "KeyM", { ctrlKey: true, shiftKey: true }), false)).toEqual({ type: "list.outdent" })
		// Word for Mac: Control+Shift+M indents, Cmd+Shift+M outdents; Cmd+M is the window's.
		expect(commandForKey(key("M", "KeyM", { ctrlKey: true, shiftKey: true }), true)).toEqual({ type: "list.indent" })
		expect(commandForKey(key("M", "KeyM", { metaKey: true, shiftKey: true }), true)).toEqual({ type: "list.outdent" })
		expect(commandForKey(key("m", "KeyM", { metaKey: true }), true)).toBeUndefined()
		// Line spacing only where the browser does not own Ctrl+digit.
		expect(commandForKey(key("2", "Digit2", { ctrlKey: true }), false)).toBeUndefined()
		expect(commandForKey(key("2", "Digit2", { ctrlKey: true }), false, true)).toEqual({
			type: "paragraph.lineSpacing",
			rule: "auto",
			value: 480
		})
		expect(commandForKey(key("5", "Digit5", { metaKey: true }), true, true)).toEqual({
			type: "paragraph.lineSpacing",
			rule: "auto",
			value: 360
		})
		expect(commandForKey(key("1", "Digit1", { ctrlKey: true }), false, true)).toEqual({
			type: "paragraph.lineSpacing",
			rule: "auto",
			value: 240
		})
	})
})
