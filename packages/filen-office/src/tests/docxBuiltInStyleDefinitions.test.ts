import type { Node } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { OpcPackage, bytesSource } from "@filen/office/core/opc"
import { DocxEditorSession, docxSchema, parseDocxEditorCommand } from "@filen/office/core/docx/edit"
import { saveDocx, styleDefinition, writerProof } from "@filen/office/core/docx/write"
import { Names } from "../core/docx/write/markup"
import { openBytes } from "./docxEditFixtures"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor, settleAll } from "./pagedFixtures"

const decoder = new TextDecoder()
const marks = docxSchema.marks
const NORMAL = '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
const STYLES = {
	name: "word/styles.xml",
	contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
	data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${NORMAL}</w:styles>`
}
const RELATIONSHIPS = [{ id: "rIdS", type: "styles", target: "styles.xml" }]

async function read(bytes: Uint8Array, name: string): Promise<string> {
	return decoder.decode(await (await OpcPackage.open(bytesSource(bytes))).read(name))
}

function headerStyle(styles: string, id: string): string | undefined {
	return new RegExp(`<w:style w:type="paragraph" w:styleId="${id}">.*?</w:style>`).exec(styles)?.[0]
}

describe("built-in style definitions: Header and Footer tabs", () => {
	it("sets the centre and right tabs at half and all of the text width, US Letter's without one", () => {
		const names = new Names("w", "")
		const based = { paragraph: "Normal", character: undefined }

		expect(styleDefinition(names, "Header", "header", based)).toContain(
			'<w:tab w:val="center" w:pos="4680"/><w:tab w:val="right" w:pos="9360"/>'
		)
		expect(styleDefinition(names, "Footer", "footer", based, 9026)).toContain(
			'<w:tab w:val="center" w:pos="4513"/><w:tab w:val="right" w:pos="9026"/>'
		)
	})

	it("defines a new Header style with the tabs of an A4 section's text width, a gutter at the side taking its share", async () => {
		const section = (gutter: number): string =>
			`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="${String(gutter)}"/></w:sectPr>`

		for (const [gutter, center, right] of [
			[0, 4513, 9026],
			[360, 4333, 8666]
		] as const) {
			const opened = await pagedEditor(
				buildDocx({ body: p("Body text") + section(gutter), parts: [STYLES], relationships: RELATIONSHIPS })
			)
			const { editor } = opened
			const session = editor.session

			session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 3)))
			expect(await editor.execute({ type: "header.edit" })).toBe(true)
			editor.session.dispatch(editor.session.state.tr.insertText("Title"))
			await settleAll(editor)

			const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: editor.sessions })

			if (result.bytes === undefined) throw new Error("No bytes")

			expect(headerStyle(await read(result.bytes, "word/styles.xml"), "Header")).toContain(
				`<w:tabs><w:tab w:val="center" w:pos="${String(center)}"/><w:tab w:val="right" w:pos="${String(right)}"/></w:tabs>`
			)
		}
	})
})

describe("built-in style definitions: Hyperlink", () => {
	function textAt(session: DocxEditorSession, pos: number): Node | null {
		return session.state.doc.nodeAt(pos)
	}

	function run(session: DocxEditorSession, command: object): boolean {
		const parsed = parseDocxEditorCommand(command)

		if (parsed === undefined) throw new Error(`Invalid ${JSON.stringify(command)}`)

		return session.execute(parsed)
	}

	it("gives a new link Word's Hyperlink style in a document that lacks it, and drops it with the link", async () => {
		const opened = await openBytes(buildDocx({ body: p("See here"), parts: [STYLES], relationships: RELATIONSHIPS }))
		const session = new DocxEditorSession(opened.context, { proof: writerProof(opened.context) })
		const save = async (): Promise<Uint8Array> => {
			const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })

			if (result.bytes === undefined) throw new Error("No bytes")

			return result.bytes
		}

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 4)))
		expect(run(session, { type: "link.set", target: "https://filen.io/", text: "Filen" })).toBe(true)

		const link = textAt(session, 4)

		expect(link?.marks.find(mark => mark.type === marks.char_style)?.attrs).toEqual({ styleId: "Hyperlink" })
		expect(link?.marks.some(mark => mark.type === marks.color || mark.type === marks.underline)).toBe(false)

		const bytes = await save()

		expect(await read(bytes, "word/document.xml")).toMatch(
			/<w:hyperlink r:id="rId\d+"><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr><w:t>Filen<\/w:t><\/w:r><\/w:hyperlink>/
		)
		expect(await read(bytes, "word/styles.xml")).toContain(
			'<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>' +
				'<w:rPr><w:color w:val="467886" w:themeColor="hyperlink"/><w:u w:val="single"/></w:rPr></w:style>'
		)

		// Typing after it takes neither the link nor its look.
		session.dispatch(session.state.tr.insertText("!"))
		expect(textAt(session, 9)?.marks.some(mark => mark.type === marks.char_style || mark.type === marks.link)).toBe(false)

		session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, 6)))
		expect(run(session, { type: "link.remove" })).toBe(true)
		expect(textAt(session, 4)?.marks.some(mark => mark.type === marks.char_style)).toBe(false)
		expect(await read(await save(), "word/styles.xml")).not.toContain("Hyperlink")
	})
})
