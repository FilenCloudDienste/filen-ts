import type { Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import type { DocxEditorSession } from "@filen/office/core/docx/edit"
import { abstractNumbering, planNumbering } from "../core/docx/write/numbering"
import { styleDefinition } from "../core/docx/write/styles"
import { Names } from "../core/docx/write/markup"
import { NUMBERING_PART, STYLES_PART, nodeText, sessionOf } from "./docxEditFixtures"
import { p } from "./docxSynthetic"

const STYLES = STYLES_PART(
	'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="160"/></w:pPr></w:style>' +
		'<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style>'
)

const NUMBERING = NUMBERING_PART(
	'<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>' +
		'<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
		'<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
)

const PARTS = {
	parts: [STYLES, NUMBERING],
	relationships: [
		{ id: "rIdS", type: "styles", target: "styles.xml" },
		{ id: "rIdN", type: "numbering", target: "numbering.xml" }
	]
}

function select(session: DocxEditorSession, from: number, to: number = from): void {
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

// Types `text` at the caret one character at a time, as a view dispatches typing.
function type(session: DocxEditorSession, text: string): void {
	for (const character of text) session.dispatch(session.state.tr.insertText(character))
}

// [text, mark names] of each text node of a paragraph.
function runs(paragraph: Node): [string, string[]][] {
	const out: [string, string[]][] = []

	paragraph.forEach(child => {
		if (child.isText) out.push([child.text ?? "", child.marks.filter(mark => mark.type.name !== "run").map(mark => mark.type.name)])
	})

	return out
}

describe("docx character formatting at a caret inside a word", () => {
	it("formats the whole word and keeps the caret", async () => {
		const session = await sessionOf({ body: p("alpha beta gamma"), ...PARTS })

		// "be|ta"
		select(session, 9)
		session.execute({ type: "format.bold" })
		expect(runs(session.state.doc.child(0))).toEqual([
			["alpha ", []],
			["beta", ["bold"]],
			[" gamma", []]
		])
		expect(session.state.selection.empty).toBe(true)
		expect(session.state.selection.from).toBe(9)
		expect(session.snapshot().formats.bold).toBe("on")

		// Again: the word goes back.
		session.execute({ type: "format.bold" })
		expect(runs(session.state.doc.child(0))).toEqual([["alpha beta gamma", []]])

		// A run command (font size) and Ctrl+Space take the word too.
		session.execute({ type: "font.size", halfPoints: 40 })
		expect(runs(session.state.doc.child(0))).toEqual([
			["alpha ", []],
			["beta", ["size"]],
			[" gamma", []]
		])
		session.execute({ type: "format.clear" })
		expect(runs(session.state.doc.child(0))[1]).toEqual(["beta", ["plain"]])
		expect(session.state.selection.from).toBe(9)
	})

	it("sets what is typed next at a word's edge", async () => {
		const session = await sessionOf({ body: p("alpha beta"), ...PARTS })

		// "alpha |beta": the start of a word is not inside it.
		select(session, 7)
		session.execute({ type: "format.bold" })
		expect(runs(session.state.doc.child(0))).toEqual([["alpha beta", []]])
		expect(session.state.storedMarks?.map(mark => mark.type.name)).toContain("bold")

		// "alpha| beta": nor is its end.
		select(session, 6)
		session.execute({ type: "font.size", halfPoints: 40 })
		expect(runs(session.state.doc.child(0))).toEqual([["alpha beta", []]])
		expect(session.state.storedMarks?.map(mark => mark.type.name)).toContain("size")
	})
})

describe("docx AutoFormat As You Type", () => {
	it("starts a bulleted list from '* ' and undoes to the typed text", async () => {
		const session = await sessionOf({ body: p(""), ...PARTS })

		select(session, 1)
		type(session, "* ")
		expect(nodeText(session.state.doc.child(0))).toBe("")
		expect(session.state.doc.child(0).attrs).toMatchObject({ numId: 1, ilvl: 0, styleId: "ListParagraph" })
		expect(session.snapshot().paragraph.list).toBe("bullet")

		// Typing goes on in the item; undo takes the typing back, then the AutoFormat alone.
		type(session, "x")
		session.execute({ type: "history.undo" })
		expect(nodeText(session.state.doc.child(0))).toBe("")
		expect(session.state.doc.child(0).attrs["numId"]).toBe(1)
		session.execute({ type: "history.undo" })
		expect(nodeText(session.state.doc.child(0))).toBe("* ")
		expect(session.state.doc.child(0).attrs).toMatchObject({ numId: null, styleId: null })
	})

	it("starts a numbered list at the typed number and format", async () => {
		const cases: [string, { format: string; suffix: string; start: number }][] = [
			["1. ", { format: "decimal", suffix: ".", start: 1 }],
			["3) ", { format: "decimal", suffix: ")", start: 3 }],
			["b. ", { format: "lowerLetter", suffix: ".", start: 2 }],
			["A) ", { format: "upperLetter", suffix: ")", start: 1 }],
			["i. ", { format: "lowerRoman", suffix: ".", start: 1 }],
			["IV. ", { format: "upperRoman", suffix: ".", start: 4 }]
		]

		for (const [typed, first] of cases) {
			const session = await sessionOf({ body: p(""), ...PARTS })

			select(session, 1)
			type(session, typed)

			const paragraph = session.state.doc.child(0)

			expect(nodeText(paragraph), typed).toBe("")
			expect(paragraph.attrs["numId"], typed).toBe(-1)
			expect([...session.newLists], typed).toEqual([[-1, { kind: "numbered", basedOn: null, first }]])
		}
	})

	it("leaves other text, list items, content after the start and a disabled setting alone", async () => {
		for (const typed of ["1.5 ", "ab. ", "iiii. ", "x1. ", "** "]) {
			const session = await sessionOf({ body: p(""), ...PARTS })

			select(session, 1)
			type(session, typed)
			expect(nodeText(session.state.doc.child(0)), typed).toBe(typed)
			expect(session.state.doc.child(0).attrs["numId"], typed).toBeNull()
		}

		// Not at the start of the paragraph.
		const later = await sessionOf({ body: p("text"), ...PARTS })

		select(later, 5)
		type(later, " 1. ")
		expect(nodeText(later.state.doc.child(0))).toBe("text 1. ")

		const off = await sessionOf({ body: p(""), ...PARTS }, { autoFormat: { lists: false, quotes: false } })

		select(off, 1)
		type(off, '1. "a"')
		expect(nodeText(off.state.doc.child(0))).toBe('1. "a"')
	})

	it("makes typed quotes curly, each undoable on its own", async () => {
		const session = await sessionOf({ body: p(""), ...PARTS })

		select(session, 1)
		type(session, "\"It's ('a') 'b' —\"c\"")
		expect(nodeText(session.state.doc.child(0))).toBe("“It’s (‘a’) ‘b’ —“c”")

		// Undo right after a quote gives back the straight one.
		session.execute({ type: "history.undo" })
		expect(nodeText(session.state.doc.child(0)).endsWith('c"')).toBe(true)
	})
})

describe("docx lists and the List Paragraph style", () => {
	it("gives a Normal paragraph List Paragraph and takes it away with the list", async () => {
		const session = await sessionOf({ body: p("one") + p("two", '<w:pStyle w:val="Quote"/>'), ...PARTS })

		select(session, 2, session.state.doc.content.size - 2)
		session.execute({ type: "list.bullet" })
		expect(session.state.doc.child(0).attrs).toMatchObject({ numId: 1, styleId: "ListParagraph" })
		// Another style stays.
		expect(session.state.doc.child(1).attrs).toMatchObject({ numId: 1, styleId: "Quote" })
		expect([...session.missingStyles]).toEqual([["ListParagraph", "List Paragraph"]])
		select(session, 2)
		expect(session.snapshot().paragraph).toMatchObject({ style: "custom", styleName: "List Paragraph", list: "bullet" })
		select(session, 2, session.state.doc.content.size - 2)

		session.execute({ type: "list.bullet" })
		expect(session.state.doc.child(0).attrs).toMatchObject({ numId: null, styleId: null })
		expect(session.state.doc.child(1).attrs).toMatchObject({ numId: null, styleId: "Quote" })
		expect([...session.missingStyles]).toEqual([])
	})

	it("uses the document's own List Paragraph", async () => {
		const styles = STYLES_PART(
			'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
				'<w:style w:type="paragraph" w:styleId="Listenabsatz"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>'
		)
		const session = await sessionOf({ body: p("one"), ...PARTS, parts: [styles, NUMBERING] })

		select(session, 2)
		session.execute({ type: "list.numbered" })
		expect(session.state.doc.child(0).attrs["styleId"]).toBe("Listenabsatz")
		session.execute({ type: "list.numbered" })
		expect(session.state.doc.child(0).attrs["styleId"]).toBeNull()
	})

	it("writes Word's List Paragraph definition", () => {
		const xml = styleDefinition(new Names("w", ""), "ListParagraph", "List Paragraph", { paragraph: "Normal", character: undefined })

		expect(xml).toBe(
			'<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>' +
				'<w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr><w:rPr></w:rPr></w:style>'
		)
	})

	it("writes an AutoFormat list's first level from its typed number", () => {
		const xml = abstractNumbering(new Names("w", ""), 7, "numbered", { format: "upperRoman", suffix: ")", start: 4 })

		expect(xml).toContain(
			'<w:lvl w:ilvl="0"><w:start w:val="4"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1)"/><w:lvlJc w:val="right"/>'
		)
		expect(xml).toContain('<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/>')

		const planned = planNumbering(
			undefined,
			undefined,
			new Map([[-1, { kind: "numbered", basedOn: null, first: { format: "decimal", suffix: ".", start: 3 } }]])
		)

		expect(new TextDecoder().decode(planned.bytes() ?? new Uint8Array())).toContain('<w:start w:val="3"/>')
	})
})
