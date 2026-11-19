import type { Node } from "prosemirror-model"
import { AllSelection, TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { bytesSource, OpcPackage } from "@filen/office/core/opc"
import {
	DocxEditorSession,
	docxSchema,
	parseDocxEditorCommand,
	type DocxEditorCommand,
	type DocxEditorSnapshot
} from "@filen/office/core/docx/edit"
import { saveDocx, writerProof } from "@filen/office/core/docx/write"
import { docxOutline, docxWordCount, goToOutlineEntry } from "../core/docx/paged/queries"
import { DOCX_FONT_SIZES } from "../core/docx/edit/commands/formatting"
import { DOCX_COMMON_FONTS, docxFontList } from "../core/docx/edit/fontList"
import { builtInStyleId } from "../core/docx/edit/formats"
import { steppedSize } from "../core/docx/edit/handlers/formatting"
import { SUBSTITUTIONS } from "../core/fonts/substitutes"
import { STYLES_PART, openBytes, type Opened } from "./docxEditFixtures"
import { buildDocx, p, type SyntheticDocx } from "./docxSynthetic"
import { pagedEditor, settleAll } from "./pagedFixtures"

const marks = docxSchema.marks
const decoder = new TextDecoder()

const THEME =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements>' +
	'<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
	'<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
	'<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
	'<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
	'<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office">' +
	'<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
	'<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
	'<a:fmtScheme name="Office"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>'

const STYLES = STYLES_PART(
	'<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/>' +
		'<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
		'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
		'<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/><w:ind w:left="360"/></w:pPr>' +
		'<w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:color w:val="2F5496" w:themeColor="accent1" w:themeShade="BF"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>' +
		'<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>' +
		'<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1" w:themeColor="hyperlink"/><w:u w:val="single"/></w:rPr></w:style>'
)

const FONT_TABLE =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
	'<w:font w:name="Calibri"/><w:font w:name="Verdana"/><w:font w:name="Times New Roman"/><w:font w:name="calibri light"/></w:fonts>'

function spec(body: string, extra: Partial<SyntheticDocx> = {}): SyntheticDocx {
	return {
		body,
		parts: [
			STYLES,
			{ name: "word/theme/theme1.xml", contentType: "application/vnd.openxmlformats-officedocument.theme+xml", data: THEME },
			{
				name: "word/fontTable.xml",
				contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml",
				data: FONT_TABLE
			},
			...(extra.parts ?? [])
		],
		relationships: [
			{ id: "rIdS", type: "styles", target: "styles.xml" },
			{ id: "rIdT", type: "theme", target: "theme/theme1.xml" },
			{ id: "rIdF", type: "fontTable", target: "fontTable.xml" },
			...(extra.relationships ?? [])
		],
		...(extra.settings === undefined ? {} : { settings: extra.settings })
	}
}

interface Doc extends Opened {
	readonly bytes: Uint8Array
	readonly session: DocxEditorSession
}

async function open(body: string, extra: Partial<SyntheticDocx> = {}, readOnly = false): Promise<Doc> {
	const bytes = buildDocx(spec(body, extra))
	const opened = await openBytes(bytes)

	return { ...opened, bytes, session: new DocxEditorSession(opened.context, { proof: writerProof(opened.context), readOnly }) }
}

// Saves through Gates 1 and 2 and returns the main part.
async function saved(doc: Doc): Promise<string> {
	const result = await saveDocx({ pkg: doc.pkg, context: doc.context, sessions: [doc.session] })

	if (result.bytes === undefined) throw new Error("No bytes")

	return decoder.decode(await (await OpcPackage.open(bytesSource(result.bytes))).read("word/document.xml"))
}

function body(xml: string): string {
	return xml.slice(xml.indexOf("<w:body>") + 8, xml.lastIndexOf("</w:body>"))
}

function select(session: DocxEditorSession, from: number, to: number = from): void {
	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

function run(session: DocxEditorSession, command: object): boolean {
	const parsed = parseDocxEditorCommand(command)

	if (parsed === undefined) throw new Error(`Invalid ${JSON.stringify(command)}`)

	return session.execute(parsed)
}

function markOf(node: Node | null | undefined, name: keyof typeof marks): Record<string, unknown> | undefined {
	return node?.marks.find(mark => mark.type === marks[name])?.attrs
}

// The text node at `pos`.
function textAt(session: DocxEditorSession, pos: number): Node | null {
	return session.state.doc.nodeAt(pos)
}

function values(session: DocxEditorSession): DocxEditorSnapshot["values"] {
	return session.snapshot().values
}

describe("formatting commands: parsing", () => {
	it("parses the new commands and refuses bad arguments", () => {
		expect(parseDocxEditorCommand({ type: "font.spacing", twips: -20 })).toEqual({ type: "font.spacing", twips: -20 })
		expect(parseDocxEditorCommand({ type: "font.spacing", twips: 1.5 })).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "font.spacing", twips: 40000 })).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "format.copy", sticky: true })).toEqual({ type: "format.copy", sticky: true })
		expect(parseDocxEditorCommand({ type: "format.copy" })).toEqual({ type: "format.copy" })
		expect(parseDocxEditorCommand({ type: "format.copy", sticky: "yes" })).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "font.family", family: "Arial\u0001" })).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "font.family", family: "Bad\ud800" })).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "font.family", family: "   " })).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "font.family", family: "+body" })).toEqual({ type: "font.family", family: "+body" })
		expect(parseDocxEditorCommand({ type: "color.highlight", name: "white" })).toEqual({ type: "color.highlight", name: "white" })
		expect(parseDocxEditorCommand({ type: "insert.symbol", text: "©" })).toEqual({ type: "insert.symbol", text: "©" })
		expect(parseDocxEditorCommand({ type: "insert.symbol", text: "a\u0000" })).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "insert.symbol", text: "" })).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "insert.symbol", text: "x".repeat(17) })).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "link.set", target: "https://filen.io/", text: "a\u0007" })).toBeUndefined()

		for (const type of ["format.doubleStrike", "format.smallCaps", "format.allCaps", "format.clearAll", "insert.lineBreak"]) {
			expect(parseDocxEditorCommand({ type })).toEqual({ type })
		}
	})

	it("steps font sizes through Word's list", () => {
		expect(steppedSize(22, true)).toBe(24)
		expect(steppedSize(22, false)).toBe(21)
		expect(steppedSize(144, true)).toBe(160)
		expect(steppedSize(165, true)).toBe(180)
		expect(steppedSize(165, false)).toBe(160)
		expect(steppedSize(160, false)).toBe(144)
		expect(steppedSize(16, false)).toBe(14)
		expect(steppedSize(2, false)).toBe(2)
		expect(steppedSize(10, true)).toBe(12)
		expect(steppedSize(3276, true)).toBe(3276)
		expect(DOCX_FONT_SIZES.every((size, k) => k === 0 || size > (DOCX_FONT_SIZES[k - 1] ?? 0))).toBe(true)
	})
})

describe("character formatting", () => {
	it("sets the font size on a selection, writes only that property, and drops it where the style gives it", async () => {
		const doc = await open(p("Hello world") + p("Second"))
		const session = doc.session

		select(session, 1, 6)
		expect(run(session, { type: "font.size", halfPoints: 28 })).toBe(true)
		expect(markOf(textAt(session, 1), "size")).toEqual({ value: 28, cs: 28 })
		expect(values(session).size).toBe(28)
		expect(body(await saved(doc))).toContain('<w:r><w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t>Hello</w:t></w:r>')

		// The style's 11 points: no direct size.
		expect(run(session, { type: "font.size", halfPoints: 22 })).toBe(true)
		expect(markOf(textAt(session, 1), "size")).toBeUndefined()
		expect(values(session).size).toBe(22)

		run(session, { type: "history.undo" })
		expect(values(session).size).toBe(28)
	})

	it("grows and shrinks each piece from its own size", async () => {
		const doc = await open('<w:p><w:r><w:t>Ab</w:t></w:r><w:r><w:rPr><w:sz w:val="40"/></w:rPr><w:t>Cd</w:t></w:r></w:p>')
		const session = doc.session

		select(session, 1, 5)
		expect(values(session).size).toBe("mixed")
		run(session, { type: "font.grow" })
		expect(markOf(textAt(session, 1), "size")).toEqual({ value: 24, cs: 24 })
		expect(markOf(textAt(session, 3), "size")).toEqual({ value: 44, cs: 44 })
		run(session, { type: "font.shrink" })
		run(session, { type: "font.shrink" })
		expect(markOf(textAt(session, 1), "size")).toEqual({ value: 21, cs: 21 })
		expect(body(await saved(doc))).toContain('<w:sz w:val="36"/>')
	})

	it("sets a concrete or theme font, and reports the resolved family", async () => {
		const doc = await open(p("Hello world"))
		const session = doc.session

		select(session, 1, 6)
		expect(values(session).font).toBe("Calibri")
		run(session, { type: "font.family", family: "Verdana" })
		expect(markOf(textAt(session, 1), "font")).toMatchObject({ ascii: "Verdana", hAnsi: "Verdana", cs: "Verdana", asciiTheme: null })
		expect(values(session).font).toBe("Verdana")

		// The theme has no complex script fonts: that slot resolves as the defaults' does and stays theirs.
		run(session, { type: "font.family", family: "+headings" })
		expect(markOf(textAt(session, 1), "font")).toMatchObject({
			ascii: null,
			asciiTheme: "majorHAnsi",
			hAnsiTheme: "majorHAnsi",
			csTheme: null
		})
		expect(values(session).font).toBe("Calibri Light")
		expect(body(await saved(doc))).toContain('<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/>')

		// Back to the body font the defaults give: no direct fonts left.
		run(session, { type: "font.family", family: "+body" })
		expect(markOf(textAt(session, 1), "font")).toBeUndefined()

		// The same typeface by name is set by name, as Word does: it must not follow a later theme change.
		run(session, { type: "font.family", family: "Calibri" })
		expect(markOf(textAt(session, 1), "font")).toMatchObject({ ascii: "Calibri", hAnsi: "Calibri", asciiTheme: null })
		expect(values(session).font).toBe("Calibri")
	})

	it("sets theme, RGB and automatic colours", async () => {
		const doc = await open(p("Hello world"))
		const session = doc.session

		select(session, 1, 6)
		run(session, { type: "color.text", color: { kind: "theme", theme: "accent1", shade: 191 } })
		expect(markOf(textAt(session, 1), "color")).toEqual({ value: "2F5496", themeColor: "accent1", themeTint: null, themeShade: 191 })
		expect(values(session).color).toBe("theme:accent1/shade:191")
		expect(values(session).colorRgb).toBe("2F5496")
		expect(body(await saved(doc))).toContain('<w:color w:val="2F5496" w:themeColor="accent1" w:themeShade="BF"/>')

		run(session, { type: "color.text", color: { kind: "rgb", value: "ff0000" } })
		expect(values(session).color).toBe("FF0000")
		run(session, { type: "color.text", color: { kind: "auto" } })
		expect(markOf(textAt(session, 1), "color")).toBeUndefined()
		expect(values(session).color).toBe("auto")
	})

	it("highlights, and removes a highlight", async () => {
		const doc = await open(p("Hello world"))
		const session = doc.session

		select(session, 1, 6)
		run(session, { type: "color.highlight", name: "yellow" })
		expect(values(session).highlight).toBe("yellow")
		expect(body(await saved(doc))).toContain('<w:highlight w:val="yellow"/>')
		run(session, { type: "color.highlight", name: "none" })
		expect(markOf(textAt(session, 1), "highlight")).toBeUndefined()
		expect(values(session).highlight).toBe("none")
	})

	it("toggles superscript and subscript, which exclude each other", async () => {
		const doc = await open(p("Hello world"))
		const session = doc.session

		select(session, 1, 6)
		run(session, { type: "format.superscript" })
		expect(values(session).vertAlign).toBe("superscript")
		run(session, { type: "format.subscript" })
		expect(values(session).vertAlign).toBe("subscript")
		select(session, 1, 9)
		expect(values(session).vertAlign).toBe("mixed")
		run(session, { type: "format.subscript" })
		expect(values(session).vertAlign).toBe("subscript")
		run(session, { type: "format.subscript" })
		expect(values(session).vertAlign).toBe("baseline")
		expect(markOf(textAt(session, 1), "vert_align")).toBeUndefined()
	})

	it("toggles double strikethrough and the caps, each excluding its pair", async () => {
		const doc = await open("<w:p><w:r><w:rPr><w:strike/><w:caps/></w:rPr><w:t>Hello</w:t></w:r></w:p>")
		const session = doc.session

		select(session, 1, 6)
		expect(values(session).allCaps).toBe("on")
		run(session, { type: "format.doubleStrike" })
		expect(markOf(textAt(session, 1), "double_strike")).toEqual({ value: true })
		expect(markOf(textAt(session, 1), "strike")).toBeUndefined()
		expect(session.snapshot().formats.strike).toBe("off")
		expect(values(session).doubleStrike).toBe("on")

		run(session, { type: "format.smallCaps" })
		expect(values(session).smallCaps).toBe("on")
		expect(values(session).allCaps).toBe("off")

		const xml = body(await saved(doc))

		expect(xml).toContain("<w:smallCaps/>")
		expect(xml).toContain("<w:dstrike/>")
		expect(xml).not.toContain("<w:caps/>")
		expect(xml).not.toContain("<w:strike/>")

		run(session, { type: "format.doubleStrike" })
		expect(values(session).doubleStrike).toBe("off")
	})

	it("sets character spacing", async () => {
		const doc = await open(p("Hello world"))
		const session = doc.session

		select(session, 1, 6)
		run(session, { type: "font.spacing", twips: -15 })
		expect(values(session).charSpacing).toBe(-15)
		expect(body(await saved(doc))).toContain('<w:spacing w:val="-15"/>')
		run(session, { type: "font.spacing", twips: 0 })
		expect(markOf(textAt(session, 1), "spacing")).toBeUndefined()
	})

	it("formats what is typed next at an empty selection", async () => {
		const doc = await open(p("Hello"))
		const session = doc.session

		select(session, 6)
		run(session, { type: "font.size", halfPoints: 40 })
		run(session, { type: "color.text", color: { kind: "rgb", value: "00FF00" } })
		expect(values(session).size).toBe(40)
		expect(values(session).color).toBe("00FF00")
		session.dispatch(session.state.tr.insertText("!"))
		expect(markOf(textAt(session, 6), "size")).toEqual({ value: 40, cs: 40 })
		expect(markOf(textAt(session, 6), "color")).toMatchObject({ value: "00FF00" })
		await saved(doc)
	})

	it("always writes direct values in tables, whose style the resolver does not see", async () => {
		const doc = await open(
			'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>' +
				p("Cell") +
				"</w:tc></w:tr></w:tbl>" +
				p("After")
		)
		const session = doc.session
		let at = -1

		session.state.doc.descendants((node, pos) => {
			if (at < 0 && node.isText && node.text === "Cell") at = pos

			return at < 0
		})
		select(session, at, at + 4)
		run(session, { type: "font.size", halfPoints: 22 })
		expect(markOf(textAt(session, at), "size")).toEqual({ value: 22, cs: 22 })
		await saved(doc)
	})

	it("is disabled and refused read-only", async () => {
		const doc = await open(p("Hello"), {}, true)
		const session = doc.session

		select(session, 1, 3)
		expect(session.snapshot().enabled["font.size"]).toBe(false)
		expect(run(session, { type: "font.size", halfPoints: 40 })).toBe(false)
	})
})

describe("Clear All Formatting", () => {
	it("clears character formatting and resets paragraphs to Normal, one undo step", async () => {
		const doc = await open(
			'<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/><w:ind w:left="720"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="40"/><w:lang w:val="de-DE"/></w:rPr><w:t>Title</w:t></w:r></w:p>' +
				p("Body")
		)
		const session = doc.session
		const before = session.state.doc

		select(session, 1, 6)
		run(session, { type: "format.clearAll" })

		const paragraph = session.state.doc.child(0)

		expect(paragraph.attrs).toMatchObject({ styleId: null, align: null, indent: null })
		expect(markOf(paragraph.firstChild, "bold")).toBeUndefined()
		expect(markOf(paragraph.firstChild, "size")).toBeUndefined()
		expect(markOf(paragraph.firstChild, "lang")).toEqual({ latin: "de-DE", eastAsia: null, bidi: null })
		expect(markOf(paragraph.firstChild, "plain")).toEqual({})

		const xml = body(await saved(doc))

		expect(xml).toContain('<w:r><w:rPr><w:lang w:val="de-DE"/></w:rPr><w:t>Title</w:t></w:r>')
		expect(xml).not.toContain("Heading1")

		run(session, { type: "history.undo" })
		expect(session.state.doc.eq(before)).toBe(true)
	})
})

describe("paragraph formatting", () => {
	it("sets indents, a first line or a hanging indent, and keeps the source's own w:ind when set back", async () => {
		const doc = await open(p("Indented", '<w:ind w:left="720" w:hanging="360"/>') + p("Plain"))
		const session = doc.session
		const source = session.state.doc.child(0).attrs["indent"] as object

		select(session, 2)
		expect(values(session).indent).toEqual({ start: 720, end: 0, firstLine: 0, hanging: 360 })
		run(session, { type: "paragraph.indent", firstLine: 240 })
		expect(session.state.doc.child(0).attrs["indent"]).toEqual({ start: 720, firstLine: 240 })
		expect(values(session).indent).toEqual({ start: 720, end: 0, firstLine: 240, hanging: 0 })
		expect(body(await saved(doc))).toContain('<w:ind w:left="720" w:firstLine="240"/>')

		run(session, { type: "paragraph.indent", hanging: 360 })
		expect(session.state.doc.child(0).attrs["indent"]).toBe(source)

		// The second paragraph: a start the style already gives is no direct property.
		select(session, 12)
		run(session, { type: "paragraph.indent", start: 0 })
		expect(session.state.doc.child(1).attrs["indent"]).toBeNull()
		run(session, { type: "paragraph.indent", start: 1440, end: 720 })
		expect(session.state.doc.child(1).attrs["indent"]).toEqual({ start: 1440, end: 720 })
		select(session, 2, 12)
		expect(values(session).indent).toBe("mixed")
		await saved(doc)
	})

	it("switches off an indent in character units the paragraph inherits when one is set in twips", async () => {
		const doc = await open(
			'<w:p><w:pPr><w:pStyle w:val="Heading2"/><w:ind w:leftChars="200" w:left="400"/></w:pPr><w:r><w:t>Chars</w:t></w:r></w:p>'
		)
		const session = doc.session

		select(session, 2)
		run(session, { type: "paragraph.indent", start: 720 })
		expect(session.state.doc.child(0).attrs["indent"]).toEqual({ start: 720 })

		const chars = await open(p("Chars", '<w:pStyle w:val="Indented"/>'), {
			parts: [
				STYLES_PART(
					'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
						'<w:style w:type="paragraph" w:styleId="Indented"><w:name w:val="Indented"/><w:pPr><w:ind w:leftChars="200" w:firstLineChars="100"/></w:pPr></w:style>'
				)
			]
		})

		select(chars.session, 2)
		run(chars.session, { type: "paragraph.indent", start: 720, firstLine: 0 })
		expect(chars.session.state.doc.child(0).attrs["indent"]).toEqual({ start: 720, startChars: 0, firstLine: 0, firstLineChars: 0 })
		expect(values(chars.session).indent).toEqual({ start: 720, end: 0, firstLine: 0, hanging: 0 })
		expect(body(await saved(chars))).toContain('<w:ind w:left="720" w:leftChars="0" w:firstLine="0" w:firstLineChars="0"/>')
	})

	it("leaves an indent the paragraph style gives to the style", async () => {
		const doc = await open(p("Heading", '<w:pStyle w:val="Heading1"/>'))
		const session = doc.session

		select(session, 2)
		run(session, { type: "paragraph.indent", start: 720 })
		expect(session.state.doc.child(0).attrs["indent"]).toEqual({ start: 720 })
		run(session, { type: "paragraph.indent", start: 360 })
		expect(session.state.doc.child(0).attrs["indent"]).toBeNull()
	})

	it("reports paragraph spacing and line spacing", async () => {
		const doc = await open(p("One", '<w:spacing w:before="120" w:line="360" w:lineRule="auto"/>') + p("Two"))
		const session = doc.session

		select(session, 2)
		expect(values(session).spacing).toEqual({ before: 120, after: 160 })
		expect(values(session).lineSpacing).toEqual({ rule: "auto", value: 360 })
		select(session, 2, 8)
		expect(values(session).lineSpacing).toBe("mixed")
		expect(session.snapshot().enabled["paragraph.spacing"]).toBe(true)
		expect(session.snapshot().enabled["paragraph.lineSpacing"]).toBe(true)
	})

	it("sets paragraph spacing and line spacing", async () => {
		const doc = await open(p("One", '<w:spacing w:before="120" w:beforeLines="50"/>') + p("Two"))
		const session = doc.session

		select(session, 2, 8)
		run(session, { type: "paragraph.spacing", before: 240, after: 0 })
		expect(session.state.doc.child(0).attrs["spacing"]).toEqual({ before: 240, after: 0 })
		expect(values(session).spacing).toEqual({ before: 240, after: 0 })
		run(session, { type: "paragraph.lineSpacing", rule: "exact", value: 300 })
		expect(values(session).lineSpacing).toEqual({ rule: "exact", value: 300 })

		const xml = body(await saved(doc))

		expect(xml).toContain('w:before="240"')
		expect(xml).toContain('w:lineRule="exact"')

		// The defaults' 1.08 lines: no direct line spacing.
		run(session, { type: "paragraph.lineSpacing", rule: "auto", value: 259 })
		expect(session.state.doc.child(1).attrs["spacing"]).toEqual({ before: 240, after: 0 })
	})
})

describe("selection values", () => {
	it("keeps the values object while typing and moving within the same formatting", async () => {
		const doc = await open(p("Hello world") + '<w:p><w:r><w:rPr><w:sz w:val="40"/></w:rPr><w:t>Big</w:t></w:r></w:p>')
		const session = doc.session

		select(session, 2)

		const first = values(session)

		session.dispatch(session.state.tr.insertText("x", 2))
		select(session, 4)
		expect(values(session)).toBe(first)
		select(session, 16)
		expect(values(session)).not.toBe(first)
		expect(values(session).size).toBe(40)
	})

	it("updates a growing selection by its difference to what a fresh count gives", async () => {
		const doc = await open(
			p("Hello world") + '<w:p><w:r><w:rPr><w:sz w:val="40"/><w:color w:val="FF0000"/></w:rPr><w:t>Big</w:t></w:r></w:p>' + p("End")
		)
		const session = doc.session
		const fresh = async (from: number, to: number): Promise<DocxEditorSnapshot["values"]> => {
			const other = new DocxEditorSession(doc.context, { proof: null })

			select(other, from, to)

			return other.snapshot().values
		}

		for (const [from, to] of [
			[1, 3],
			[1, 9],
			[1, 16],
			[3, 16],
			[3, 22],
			[14, 22],
			[14, 16]
		] as const) {
			select(session, from, to)
			expect(values(session), `${from}-${to}`).toEqual(await fresh(from, to))
		}

		session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))
		expect(values(session)).toMatchObject({ size: "mixed", color: "mixed", font: "Calibri" })
	})
})

describe("links and insertions", () => {
	it("inserts a link at the caret with the Hyperlink style, edits it and removes it", async () => {
		const doc = await open(p("See here"))
		const session = doc.session

		select(session, 4)
		expect(session.snapshot().enabled["link.remove"]).toBe(false)
		expect(run(session, { type: "link.set", target: "https://filen.io/", text: "Filen" })).toBe(true)
		expect(session.state.doc.child(0).textContent).toBe("SeeFilen here")
		expect(markOf(textAt(session, 4), "link")).toMatchObject({ target: "https://filen.io/", src: -1 })
		expect(markOf(textAt(session, 4), "char_style")).toEqual({ styleId: "Hyperlink" })

		select(session, 6)
		expect(session.snapshot().context.link).toEqual({ target: "https://filen.io/", anchor: null, text: "Filen" })
		expect(session.snapshot().enabled["link.remove"]).toBe(true)

		const xml = await saved(doc)

		expect(xml).toMatch(
			/<w:hyperlink r:id="rId\d+"><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr><w:t>Filen<\/w:t><\/w:r><\/w:hyperlink>/
		)

		run(session, { type: "link.set", target: "https://filen.io/drive", text: "Drive" })
		// The caret ends after the link.
		expect(session.state.selection.from).toBe(9)
		select(session, 6)
		expect(session.snapshot().context.link).toEqual({ target: "https://filen.io/drive", anchor: null, text: "Drive" })
		expect(session.state.doc.child(0).textContent).toBe("SeeDrive here")
		await saved(doc)

		run(session, { type: "link.remove" })
		expect(session.state.doc.rangeHasMark(0, session.state.doc.content.size, marks.link)).toBe(false)
		expect(markOf(textAt(session, 4), "char_style")).toBeUndefined()
		expect(body(await saved(doc))).not.toContain("hyperlink")
	})

	it("makes a selection a link to a bookmark, and edits a source link", async () => {
		const doc = await open(
			'<w:p><w:bookmarkStart w:id="0" w:name="Target"/><w:r><w:t>Top</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>' +
				'<w:p><w:hyperlink r:id="rIdL"><w:r><w:t>Old link</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> and text</w:t></w:r></w:p>',
			{ relationships: [{ id: "rIdL", type: "hyperlink", target: "https://example.com/", external: true }] }
		)
		const session = doc.session
		let link = -1
		let text = -1

		session.state.doc.descendants((node, pos) => {
			if (node.isText && node.text === "Old link") link = pos
			if (node.isText && node.text === " and text") text = pos

			return true
		})

		select(session, link + 1)
		expect(session.snapshot().context.link).toEqual({ target: "https://example.com/", anchor: null, text: "Old link" })
		run(session, { type: "link.set", target: "https://filen.io/" })
		expect(markOf(textAt(session, link), "link")).toMatchObject({ target: "https://filen.io/", src: -1 })
		expect(markOf(textAt(session, link), "char_style")).toBeUndefined()

		select(session, text + 1, text + 4)
		run(session, { type: "link.set", anchor: "Target" })
		expect(markOf(textAt(session, text + 1), "link")).toMatchObject({ anchor: "Target", target: null })

		const xml = body(await saved(doc))

		expect(xml).toContain('<w:hyperlink w:anchor="Target">')
		expect(xml).not.toContain("rIdL")
	})

	it("inserts a page break that starts a new paragraph, only in the body outside tables", async () => {
		const doc = await open(p("Before after"))
		const session = doc.session

		select(session, 8)
		expect(session.snapshot().enabled["insert.pageBreak"]).toBe(true)
		run(session, { type: "insert.pageBreak" })
		expect(session.state.doc.childCount).toBe(2)
		expect(session.state.doc.child(0).lastChild?.type.name).toBe("break")
		expect(session.state.doc.child(1).textContent).toBe("after")
		expect(session.state.selection.$from.parent).toBe(session.state.doc.child(1))
		expect(body(await saved(doc))).toContain('<w:br w:type="page"/>')
	})

	it("inserts a horizontal line", async () => {
		const doc = await open(p("Above") + p(""))
		const session = doc.session

		select(session, 3)
		expect(session.snapshot().enabled["insert.horizontalLine"]).toBe(true)

		run(session, { type: "insert.horizontalLine" })
		expect(session.state.doc.childCount).toBe(4)
		expect(session.state.doc.child(1).attrs["borders"]).toMatchObject({ bottom: { style: "single", size: 6, space: 1 } })
		expect(session.state.selection.$from.parent).toBe(session.state.doc.child(2))

		// On an empty paragraph: the border goes on it.
		select(session, session.state.doc.content.size - 1)
		run(session, { type: "insert.horizontalLine" })
		expect(session.state.doc.child(3).attrs["borders"]).toMatchObject({ bottom: { style: "single" } })
		expect(body(await saved(doc))).toContain('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>')
	})

	it("inserts line breaks and symbols, with Word's hyphens as their own elements", async () => {
		const doc = await open(p("AB"))
		const session = doc.session

		select(session, 2)
		run(session, { type: "insert.lineBreak" })
		run(session, { type: "insert.symbol", text: "©‑­" })
		expect(session.state.doc.child(0).childCount).toBeGreaterThan(3)

		const xml = body(await saved(doc))

		expect(xml).toContain("<w:br/>")
		expect(xml).toContain("©")
		expect(xml).toContain("<w:noBreakHyphen/>")
		expect(xml).toContain("<w:softHyphen/>")
	})
})

describe("format painter", () => {
	it("copies the caret's formatting and paints a selection, then turns off", async () => {
		const bytes = buildDocx(
			spec(
				'<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="FF0000"/><w:sz w:val="36"/></w:rPr><w:t>Source</w:t></w:r></w:p>' +
					"<w:p><w:r><w:rPr><w:i/></w:rPr><w:t>Target words</w:t></w:r></w:p>"
			)
		)
		const { editor } = await pagedEditor(bytes)
		const session = editor.session

		select(session, 3)
		expect(editor.snapshot().enabled["format.paste"]).toBe(false)
		expect(await editor.execute({ type: "format.copy" })).toBe(true)
		expect(editor.painter?.paragraph).toMatchObject({ align: "center" })
		expect(editor.snapshot().enabled["format.paste"]).toBe(true)

		// Painting a word inside the second paragraph: the word only, and the paragraph's alignment.
		select(session, 12)
		expect(await editor.execute({ type: "format.paste" })).toBe(true)
		expect(editor.painter).toBeUndefined()

		const target = session.state.doc.child(1)

		expect(target.attrs["align"]).toBe("center")
		expect(markOf(target.firstChild, "bold")).toMatchObject({ value: true })
		expect(markOf(target.firstChild, "italic")).toBeUndefined()
		expect(markOf(target.firstChild, "size")).toMatchObject({ value: 36 })
		expect(target.firstChild?.text).toBe("Target")
		expect(markOf(target.child(1), "italic")).toMatchObject({ value: true })

		await settleAll(editor)
		run(session, { type: "history.undo" })
		expect(session.state.doc.child(1).attrs["align"]).toBeNull()
		editor.dispose()
	})

	it("paints every property of the source w:rPr, also those without marks", async () => {
		const bytes = buildDocx(
			spec(
				'<w:p><w:r><w:rPr><w:b/><w:kern w:val="28"/><w:position w:val="6"/><w:lang w:val="de-DE"/></w:rPr><w:t>Source</w:t></w:r></w:p>' +
					'<w:p><w:r><w:rPr><w:i/><w:w w:val="150"/></w:rPr><w:t>Target</w:t></w:r></w:p>'
			)
		)
		const { editor, pkg, context } = await pagedEditor(bytes)
		const session = editor.session

		select(session, 1, 3)
		await editor.execute({ type: "format.copy" })
		select(session, 9, 15)
		await editor.execute({ type: "format.paste" })

		const result = await saveDocx({ pkg, context, sessions: [session] })
		const xml = body(
			decoder.decode(await (await OpcPackage.open(bytesSource(result.bytes ?? new Uint8Array()))).read("word/document.xml"))
		)
		const target = xml.slice(xml.indexOf("</w:p>") + 6)

		expect(target).toContain('<w:kern w:val="28"/>')
		expect(target).toContain('<w:position w:val="6"/>')
		expect(target).toContain('<w:lang w:val="de-DE"/>')
		expect(target).toContain("<w:b/>")
		expect(target).not.toContain("<w:i/>")
		expect(target).not.toContain("<w:w ")
		editor.dispose()
	})

	it("stays on when sticky until cancelled, and carries character formatting only from part of a paragraph", async () => {
		const bytes = buildDocx(
			spec('<w:p><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>Underlined text</w:t></w:r></w:p>' + p("One two three"))
		)
		const { editor } = await pagedEditor(bytes)
		const session = editor.session

		select(session, 1, 5)
		await editor.execute({ type: "format.copy", sticky: true })
		expect(editor.painter?.paragraph).toBeNull()
		select(session, 18, 21)
		await editor.execute({ type: "format.paste" })
		select(session, 26, 31)
		await editor.execute({ type: "format.paste" })
		expect(editor.painter).toBeDefined()
		expect(markOf(session.state.doc.nodeAt(18), "underline")).toMatchObject({ style: "single" })
		expect(markOf(session.state.doc.nodeAt(26), "underline")).toMatchObject({ style: "single" })
		editor.setPainter(undefined)
		expect(editor.snapshot().enabled["format.paste"]).toBe(false)
		editor.dispose()
	})
})

describe("queries", () => {
	it("counts words like Word, incrementally across edits", async () => {
		const bytes = buildDocx(
			spec(
				p("Hello  world, e-mail x") +
					p("") +
					p("   ") +
					p("漢字abc def") +
					'<w:p><w:r><w:t>Gone</w:t></w:r><w:del w:id="1" w:author="A"><w:r><w:delText>deleted</w:delText></w:r></w:del></w:p>'
			)
		)
		const { editor } = await pagedEditor(bytes)
		const count = await docxWordCount(editor)

		expect(count).toMatchObject({ words: 3 + 4 + 1, paragraphs: 3 })
		expect(count.characters).toBe(22 + 3 + 9 + 4)
		expect(count.charactersNoSpaces).toBe(19 + 8 + 4)

		editor.dispatch(editor.state.tr.insertText(" more", 2))
		expect((await docxWordCount(editor)).words).toBe(count.words + 1)
		editor.dispose()
	})

	it("lists the headings and goes to one, also after edits", async () => {
		const bytes = buildDocx(
			spec(
				p("Intro") +
					p("Chapter", '<w:pStyle w:val="Heading1"/>') +
					p("Text") +
					p("Section", '<w:pStyle w:val="Heading2"/>') +
					p("Direct", '<w:outlineLvl w:val="2"/>') +
					p("Body text", '<w:pStyle w:val="Heading2"/><w:outlineLvl w:val="9"/>')
			)
		)
		const { editor } = await pagedEditor(bytes)
		const outline = docxOutline(editor)

		expect(outline.entries.map(entry => [entry.level, entry.text])).toEqual([
			[0, "Chapter"],
			[1, "Section"],
			[2, "Direct"]
		])
		expect(docxOutline(editor)).toBe(outline)

		editor.dispatch(editor.state.tr.insertText("New ", 1))
		expect(goToOutlineEntry(editor, outline, outline.entries[1] as (typeof outline.entries)[number])).toBe(true)
		expect(editor.state.selection.$from.parent.textContent).toBe("Section")
		editor.dispose()
	})

	it("lists the theme's, the document's and the common fonts", async () => {
		const doc = await open(p("x"))
		const list = await docxFontList(doc.context)

		expect(list.slice(0, 2)).toEqual([
			{ family: "+headings", name: "Calibri Light", kind: "theme", role: "headings" },
			{ family: "+body", name: "Calibri", kind: "theme", role: "body" }
		])
		expect(list.filter(font => font.kind === "document").map(font => font.name)).toEqual([
			"Calibri",
			"calibri light",
			"Times New Roman",
			"Verdana"
		])
		expect(list.filter(font => font.kind === "common").map(font => font.name)).toEqual([
			"Aptos",
			"Arial",
			"Cambria",
			"Courier New",
			"Georgia",
			"Segoe UI"
		])
		expect(await docxFontList(doc.context)).toBe(list)

		for (const name of DOCX_COMMON_FONTS) expect(SUBSTITUTIONS.has(name.toLowerCase()), name).toBe(true)
	})
})

describe("undo", () => {
	it("takes every formatting command back to the document it changed", async () => {
		const commands: DocxEditorCommand[] = [
			{ type: "format.superscript" },
			{ type: "format.doubleStrike" },
			{ type: "format.smallCaps" },
			{ type: "format.allCaps" },
			{ type: "format.clearAll" },
			{ type: "font.family", family: "Georgia" },
			{ type: "font.size", halfPoints: 30 },
			{ type: "font.grow" },
			{ type: "font.shrink" },
			{ type: "font.spacing", twips: 40 },
			{ type: "color.text", color: { kind: "theme", theme: "accent2", tint: 153 } },
			{ type: "color.highlight", name: "green" },
			{ type: "paragraph.indent", start: 360, hanging: 240 },
			{ type: "link.set", target: "https://filen.io/" },
			{ type: "insert.lineBreak" },
			{ type: "insert.symbol", text: "—" }
		]

		for (const command of commands) {
			const doc = await open(
				'<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold </w:t></w:r><w:r><w:rPr><w:sz w:val="30"/><w:color w:val="00FF00"/></w:rPr><w:t>big green</w:t></w:r></w:p>' +
					p("Plain")
			)
			const session = doc.session
			const before = session.state.doc

			select(session, 3, 18)
			expect(session.execute(command), command.type).toBe(true)
			expect(session.state.doc.eq(before), command.type).toBe(false)
			await saved(doc)
			session.execute({ type: "history.undo" })
			expect(session.state.doc.eq(before), command.type).toBe(true)
		}
	})
})

describe("Word's rules the commands follow", () => {
	it("turns double strikethrough off when strikethrough goes on, at a selection and at the caret", async () => {
		const doc = await open("<w:p><w:r><w:rPr><w:dstrike/></w:rPr><w:t>Twice struck</w:t></w:r></w:p>")
		const session = doc.session

		select(session, 1, 6)
		run(session, { type: "format.strike" })
		expect(markOf(textAt(session, 1), "strike")).toEqual({ value: true })
		expect(markOf(textAt(session, 1), "double_strike")).toBeUndefined()
		expect(body(await saved(doc))).toContain("<w:r><w:rPr><w:strike/></w:rPr><w:t>Twice</w:t></w:r>")

		select(session, 9)
		run(session, { type: "format.strike" })
		session.dispatch(session.state.tr.insertText("x"))
		expect(markOf(textAt(session, 9), "strike")).toEqual({ value: true })
		expect(markOf(textAt(session, 9), "double_strike")).toBeUndefined()
	})

	it("keeps highlighting when clearing formatting", async () => {
		for (const type of ["format.clearAll", "format.clear"] as const) {
			const doc = await open('<w:p><w:r><w:rPr><w:b/><w:highlight w:val="yellow"/></w:rPr><w:t>Marked</w:t></w:r></w:p>')
			const session = doc.session

			select(session, 1, 7)
			run(session, { type })
			expect(markOf(textAt(session, 1), "bold"), type).toBeUndefined()
			expect(markOf(textAt(session, 1), "highlight"), type).toEqual({ value: "yellow" })
			expect(body(await saved(doc)), type).toContain('<w:highlight w:val="yellow"/>')
		}
	})

	it("compares a colour with the style's as chosen: a theme colour is not the same RGB, nor the other way", async () => {
		const doc = await open('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Heading</w:t></w:r></w:p>')
		const session = doc.session

		// Heading 1 gives accent1 shaded BF (2F5496).
		select(session, 1, 8)
		run(session, { type: "color.text", color: { kind: "rgb", value: "2F5496" } })
		expect(markOf(textAt(session, 1), "color")).toMatchObject({ value: "2F5496", themeColor: null })

		run(session, { type: "color.text", color: { kind: "theme", theme: "accent1", shade: 191 } })
		expect(markOf(textAt(session, 1), "color")).toBeUndefined()
	})

	it("types after a link inserted at the caret without the link's look", async () => {
		const doc = await open(p("See here"))
		const session = doc.session

		select(session, 4)
		run(session, { type: "link.set", target: "https://filen.io/", text: "Filen" })
		session.dispatch(session.state.tr.insertText("!"))

		const typed = textAt(session, 9)

		expect(typed?.text).toMatch(/^!/)
		expect(markOf(typed, "link")).toBeUndefined()
		expect(markOf(typed, "char_style")).toBeUndefined()
	})

	it("keeps what a link from the file says besides its target when the target changes, and changes nothing for the same target", async () => {
		const doc = await open(
			'<w:p><w:hyperlink r:id="rIdL" w:tgtFrame="_blank" w:history="1" w:docLocation="here" w:tooltip="Tip"><w:r><w:t>Old link</w:t></w:r></w:hyperlink></w:p>',
			{ relationships: [{ id: "rIdL", type: "hyperlink", target: "https://example.com/", external: true }] }
		)
		const session = doc.session
		const before = session.state.doc

		select(session, 3)
		expect(run(session, { type: "link.set", target: "https://example.com/" })).toBe(true)
		expect(session.state.doc).toBe(before)

		run(session, { type: "link.set", target: "https://filen.io/" })

		const xml = body(await saved(doc))

		expect(xml).toMatch(/<w:hyperlink [^>]*w:tgtFrame="_blank"/)
		expect(xml).toMatch(/<w:hyperlink [^>]*w:history="1"/)
		expect(xml).toMatch(/<w:hyperlink [^>]*w:docLocation="here"/)
		expect(xml).toMatch(/<w:hyperlink [^>]*w:tooltip="Tip"/)
	})

	it("drops the hyperlink relationships edits leave unused, and keeps those the file did not use", async () => {
		const link = (id: string, text: string): string =>
			`<w:p><w:hyperlink r:id="${id}"><w:r><w:t>${text}</w:t></w:r></w:hyperlink></w:p>`
		const doc = await open(link("rIdL", "Replaced") + link("rIdD", "Deleted") + link("rIdK", "Kept") + link("rIdK", "Again"), {
			relationships: ["rIdL", "rIdD", "rIdK", "rIdU"].map(id => ({
				id,
				type: "hyperlink",
				target: `https://example.com/${id}`,
				external: true
			}))
		})
		const session = doc.session
		const at = (text: string): number => {
			let found = -1

			session.state.doc.descendants((node, pos) => {
				if (found < 0 && node.isText && node.text === text) found = pos
			})

			return found
		}
		const relationships = async (result: Awaited<ReturnType<typeof saveDocx>>): Promise<string> =>
			decoder.decode(
				await (await OpcPackage.open(bytesSource(result.bytes ?? new Uint8Array()))).read("word/_rels/document.xml.rels")
			)

		// An edit undone leaves the relationships as they were.
		select(session, at("Replaced") + 1)
		run(session, { type: "link.set", target: "https://filen.io/" })
		run(session, { type: "history.undo" })
		expect((await saveDocx({ pkg: doc.pkg, context: doc.context, sessions: [session] })).changedParts).toEqual([])

		select(session, at("Replaced") + 1)
		run(session, { type: "link.set", target: "https://filen.io/" })

		const deleted = at("Deleted")

		session.dispatch(session.state.tr.delete(deleted, deleted + "Deleted".length))
		select(session, at("Again") + 1)
		run(session, { type: "link.remove" })

		const result = await saveDocx({ pkg: doc.pkg, context: doc.context, sessions: [session] })
		const rels = await relationships(result)

		expect(rels).not.toContain('Id="rIdL"')
		expect(rels).not.toContain('Id="rIdD"')
		expect(rels).toContain('Id="rIdK"')
		expect(rels).toContain('Id="rIdU"')
		expect(rels).toContain('Target="https://filen.io/"')
	})

	it("keeps an empty hyperlink of an edited paragraph, and its relationship", async () => {
		const doc = await open(
			'<w:p><w:r><w:t xml:space="preserve">one </w:t></w:r><w:hyperlink r:id="rIdE"/><w:r><w:t>two</w:t></w:r></w:p>',
			{
				relationships: [{ id: "rIdE", type: "hyperlink", target: "https://example.com/e", external: true }]
			}
		)

		doc.session.dispatch(doc.session.state.tr.insertText("X", 2))

		const result = await saveDocx({ pkg: doc.pkg, context: doc.context, sessions: [doc.session] })
		const pkg = await OpcPackage.open(bytesSource(result.bytes ?? new Uint8Array()))

		expect(body(decoder.decode(await pkg.read("word/document.xml")))).toContain('<w:hyperlink r:id="rIdE"/>')
		expect(decoder.decode(await pkg.read("word/_rels/document.xml.rels"))).toContain('Id="rIdE"')
	})

	it("keeps a hyperlink relationship a kept link names with character references", async () => {
		const doc = await open(
			'<w:p><w:hyperlink r:id="rIdK"><w:r><w:t>Removed</w:t></w:r></w:hyperlink></w:p>' +
				'<w:p><w:hyperlink r:id="rId&#75;"><w:r><w:t>Kept</w:t></w:r></w:hyperlink></w:p>',
			{ relationships: [{ id: "rIdK", type: "hyperlink", target: "https://example.com/k", external: true }] }
		)
		const session = doc.session
		let at = -1

		session.state.doc.descendants((node, pos) => {
			if (at < 0 && node.isText && node.text === "Removed") at = pos
		})

		select(session, at + 1)
		run(session, { type: "link.remove" })

		const result = await saveDocx({ pkg: doc.pkg, context: doc.context, sessions: [session] })
		const rels = decoder.decode(
			await (await OpcPackage.open(bytesSource(result.bytes ?? new Uint8Array()))).read("word/_rels/document.xml.rels")
		)

		expect(rels).toContain('Id="rIdK"')
	})

	it("counts a symbol without a valid character as nothing", async () => {
		const { editor } = await pagedEditor(
			buildDocx(
				spec(
					'<w:p><w:r><w:t xml:space="preserve">One </w:t></w:r><w:r><w:sym w:font="Wingdings"/></w:r><w:r><w:t xml:space="preserve"> two</w:t></w:r></w:p>'
				)
			)
		)

		expect(await docxWordCount(editor)).toMatchObject({ words: 2, characters: 8 })
		editor.dispose()
	})
})

describe("styles commands add", () => {
	it("defines Word's comment styles when content uses them, and leaves unused ones out", async () => {
		const doc = await open(p("Comment text") + p("Other"))
		const session = doc.session
		const text = builtInStyleId(doc.context, "annotation text")
		const reference = builtInStyleId(doc.context, "annotation reference")

		builtInStyleId(doc.context, "heading 3")
		expect([text, reference]).toEqual(["CommentText", "CommentReference"])

		const tr = session.state.tr.setNodeAttribute(0, "styleId", text)

		tr.addMark(1, 5, marks.char_style.create({ styleId: reference }))
		session.dispatch(tr)
		expect([...session.missingStyles.keys()]).toEqual(["CommentText", "CommentReference"])

		const result = await saveDocx({ pkg: doc.pkg, context: doc.context, sessions: [session] })
		const styles = decoder.decode(await (await OpcPackage.open(bytesSource(result.bytes ?? new Uint8Array()))).read("word/styles.xml"))

		expect(styles).toContain(
			'<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/>' +
				'<w:unhideWhenUsed/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>'
		)
		expect(styles).toContain(
			'<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:uiPriority w:val="99"/>' +
				'<w:semiHidden/><w:unhideWhenUsed/><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>'
		)
		expect(styles).not.toContain("heading 3")
	})
})

describe("format painter and revisions", () => {
	const TRACKED =
		"<w:p><w:r><w:rPr><w:i/></w:rPr><w:t>Source</w:t></w:r></w:p>" +
		'<w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="5" w:author="A" w:date="2024-01-01T00:00:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t>Tracked</w:t></w:r></w:p>' +
		p("Plain")

	async function painted(tracking: boolean): Promise<{ xml: string; session: DocxEditorSession }> {
		const { editor, pkg, context } = await pagedEditor(buildDocx(spec(TRACKED)))
		const session = editor.session

		context.identity.author = "Me"
		context.review.tracking = tracking
		select(session, 1, 3)
		await editor.execute({ type: "format.copy", sticky: true })
		select(session, 9, 16)
		await editor.execute({ type: "format.paste" })
		select(session, 18, 23)
		await editor.execute({ type: "format.paste" })

		const result = await saveDocx({ pkg, context, sessions: [session] })
		const xml = body(
			decoder.decode(await (await OpcPackage.open(bytesSource(result.bytes ?? new Uint8Array()))).read("word/document.xml"))
		)

		editor.dispose()

		return { xml, session }
	}

	it("keeps a run's tracked formatting change, painting only its properties", async () => {
		for (const tracking of [false, true]) {
			const { xml, session } = await painted(tracking)
			const tracked = session.state.doc.child(1).firstChild

			expect(markOf(tracked, "format_change"), String(tracking)).toMatchObject({ author: "A" })
			expect(markOf(tracked, "italic"), String(tracking)).toMatchObject({ value: true })
			expect(xml, String(tracking)).toMatch(
				/<w:r><w:rPr><w:i\/><w:rPrChange w:id="\d+" w:author="A" w:date="2024-01-01T00:00:00Z"><w:rPr\/><\/w:rPrChange><\/w:rPr><w:t>Tracked<\/w:t><\/w:r>/
			)
		}
	})

	it("records the painted formatting as a tracked change when tracking", async () => {
		const { xml, session } = await painted(true)

		expect(markOf(session.state.doc.child(2).firstChild, "format_change")).toMatchObject({ author: "Me" })
		expect(xml).toMatch(
			/<w:r><w:rPr><w:i\/><w:rPrChange w:id="\d+" w:author="Me" [^>]*><w:rPr\/><\/w:rPrChange><\/w:rPr><w:t>Plain<\/w:t><\/w:r>/
		)
	})

	it("rejecting a tracked paint gives the painted run back as it was", async () => {
		const target = '<w:r w:rsidR="00A1B2C3"><w:rPr><w:u w:val="single"/><w:color w:val="00FF00"/></w:rPr><w:t>Target</w:t></w:r>'
		const { editor, pkg, context } = await pagedEditor(
			buildDocx(spec(`<w:p><w:r><w:rPr><w:i/><w:sz w:val="30"/></w:rPr><w:t>Source</w:t></w:r></w:p><w:p>${target}</w:p>`))
		)
		const session = editor.session

		context.identity.author = "Me"
		context.review.tracking = true
		select(session, 1, 3)
		await editor.execute({ type: "format.copy" })
		select(session, 9, 15)
		expect(await editor.execute({ type: "format.paste" })).toBe(true)
		expect(markOf(session.state.doc.child(1).firstChild, "format_change")).toMatchObject({ author: "Me" })
		expect(await editor.execute({ type: "review.rejectAll" })).toBe(true)

		const result = await saveDocx({ pkg, context, sessions: [session] })
		const xml = body(
			decoder.decode(await (await OpcPackage.open(bytesSource(result.bytes ?? new Uint8Array()))).read("word/document.xml"))
		)

		editor.dispose()
		expect(xml).toContain(`<w:p>${target}</w:p>`)
	})

	it("rejecting a formatting change read from the file gives back the properties it recorded", async () => {
		const rejected = async (bytes: Uint8Array): Promise<string> => {
			const { editor, pkg, context } = await pagedEditor(bytes)

			expect(await editor.execute({ type: "review.rejectAll" })).toBe(true)

			const result = await saveDocx({ pkg, context, sessions: [editor.session] })

			editor.dispose()

			return body(
				decoder.decode(await (await OpcPackage.open(bytesSource(result.bytes ?? new Uint8Array()))).read("word/document.xml"))
			)
		}

		expect(
			await rejected(
				buildDocx(
					spec(
						'<w:p><w:r><w:rPr><w:b/><w:kern w:val="28"/><w:rPrChange w:id="3" w:author="A" w:date="2024-01-01T00:00:00Z"><w:rPr><w:u w:val="single"/><w:w w:val="150"/></w:rPr></w:rPrChange></w:rPr><w:t>x</w:t></w:r></w:p>'
					)
				)
			)
		).toContain('<w:r><w:rPr><w:u w:val="single"/><w:w w:val="150"/></w:rPr><w:t>x</w:t></w:r>')

		// A paint recorded in a session, saved, then rejected after the file is opened again.
		const { editor, pkg, context } = await pagedEditor(
			buildDocx(
				spec(
					'<w:p><w:r><w:rPr><w:i/></w:rPr><w:t>Source</w:t></w:r></w:p><w:p><w:r><w:rPr><w:u w:val="single"/><w:w w:val="150"/></w:rPr><w:t>Target</w:t></w:r></w:p>'
				)
			)
		)

		context.identity.author = "Me"
		context.review.tracking = true
		select(editor.session, 1, 3)
		await editor.execute({ type: "format.copy" })
		select(editor.session, 9, 15)
		expect(await editor.execute({ type: "format.paste" })).toBe(true)

		const painted = await saveDocx({ pkg, context, sessions: [editor.session] })

		editor.dispose()
		expect(await rejected(painted.bytes ?? new Uint8Array())).toContain(
			'<w:r><w:rPr><w:u w:val="single"/><w:w w:val="150"/></w:rPr><w:t>Target</w:t></w:r>'
		)
	})

	it("pastes content of another part as new content: no source bytes of the part it goes into", async () => {
		const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
		const head = (inner: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${ns}>${inner}</w:hdr>`
		// The header's runs and paragraphs sit at the same item numbers as the body's.
		const runs = (word: string, color: string): string =>
			`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r w:rsidR="00AA${color.slice(0, 4)}"><w:rPr><w:b/><w:color w:val="${color}"/></w:rPr><w:t>${word}</w:t></w:r></w:p>`
		const bytes = buildDocx({
			...spec(
				`${runs("Bodyword", "00FF00")}${runs("Second", "00FF00")}<w:p><w:r><w:footnoteReference w:id="1"/></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>`,
				{
					parts: [
						{
							name: "word/header1.xml",
							contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",
							data: head(`${runs("Headword", "FF0000")}${runs("Headtwo", "FF0000")}`)
						}
					],
					relationships: [{ id: "rIdH", type: "header", target: "header1.xml" }]
				}
			),
			footnotes: `<w:footnote w:id="1">${runs("Noteword", "0000FF")}</w:footnote>`
		})

		for (const kind of ["header", "footnote"] as const) {
			const { editor, pkg, context } = await pagedEditor(bytes)
			const body = editor.session.state.doc
			// A whole paragraph, and the text of another one (open at both ends).
			const whole = body.slice(0, body.child(0).nodeSize)
			const text = body.slice(body.child(0).nodeSize + 2, body.child(0).nodeSize + 5)
			const story = context.model.stories.findIndex(item => item.kind === kind && (kind === "header" || item.id === "1"))

			expect(editor.enterStory(story, 0)).toBe(true)

			const session = editor.session

			session.dispatch(session.state.tr.insert(0, whole.content))
			session.dispatch(
				session.state.tr
					.setSelection(
						TextSelection.create(
							session.state.doc,
							session.state.doc.child(0).nodeSize + session.state.doc.child(1).nodeSize - 1
						)
					)
					.replaceSelection(text)
			)

			const result = await saveDocx({ pkg, context, sessions: editor.sessions })
			const xml = decoder.decode(
				await (
					await OpcPackage.open(bytesSource(result.bytes ?? new Uint8Array()))
				).read(kind === "header" ? "word/header1.xml" : "word/footnotes.xml")
			)
			const own = kind === "header" ? ["Headword", "Headtwo"] : ["Noteword"]

			editor.dispose()
			// The pasted text once, formatted as it was; the story's own text once each; no run of its own copied
			// for a pasted one.
			expect(xml.match(/Bodyword/g), kind).toHaveLength(1)
			expect(xml, kind).toMatch(/<w:color w:val="00FF00"\/><\/w:rPr><w:t>Bodyword<\/w:t>/)
			expect(xml, kind).toMatch(/<w:color w:val="00FF00"\/><\/w:rPr><w:t>eco<\/w:t>/)
			for (const word of own) expect(xml.match(new RegExp(word, "g")), `${kind} ${word}`).toHaveLength(1)
			expect(xml, kind).not.toContain("00AA00FF")
		}
	})

	it("writes content pasted from the body into a footnote as new, never as the notes part's items of its numbers", async () => {
		const note = (id: number, word: string): string => `<w:footnote w:id="${id}"><w:p><w:r><w:t>${word}</w:t></w:r></w:p></w:footnote>`
		// The positional tab's item number is that of the second note's paragraph in the notes part.
		const { editor, pkg, context } = await pagedEditor(
			buildDocx({
				...spec(
					'<w:p><w:r><w:t>Tab</w:t></w:r><w:r><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/></w:r></w:p>' +
						'<w:p><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>'
				),
				footnotes: note(1, "NoteA") + note(2, "NoteB")
			})
		)
		const body = editor.session.state.doc
		const content = body.slice(1, body.child(0).nodeSize - 1)

		expect(
			editor.enterStory(
				context.model.stories.findIndex(story => story.kind === "footnote" && story.id === "1"),
				0
			)
		).toBe(true)

		const session = editor.session

		session.dispatch(
			session.state.tr
				.setSelection(TextSelection.create(session.state.doc, session.state.doc.content.size - 1))
				.replaceSelection(content)
		)

		const result = await saveDocx({ pkg, context, sessions: editor.sessions })
		const xml = decoder.decode(await (await OpcPackage.open(bytesSource(result.bytes ?? new Uint8Array()))).read("word/footnotes.xml"))

		editor.dispose()
		expect(result.bytes).toBeDefined()
		expect(xml).toContain("NoteATab")
		expect(xml.match(/NoteB/g)).toHaveLength(1)
	})

	it("paints into another part from the marks alone when the source bytes use prefixes the part does not bind", async () => {
		const header =
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
			p("Head text") +
			"</w:hdr>"
		const bytes = buildDocx(
			spec(
				'<w:p><w:r><w:rPr><w:b/><w14:ligatures w14:val="standard"/></w:rPr><w:t>Source</w:t></w:r></w:p>' +
					'<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
				{
					parts: [
						{
							name: "word/header1.xml",
							contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",
							data: header
						}
					],
					relationships: [{ id: "rIdH", type: "header", target: "header1.xml" }]
				}
			)
		)
		const { editor, pkg, context } = await pagedEditor(bytes)

		select(editor.session, 1, 3)
		await editor.execute({ type: "format.copy" })

		const story = context.model.stories.findIndex(item => item.kind === "header")

		expect(editor.enterStory(story, 0)).toBe(true)
		select(editor.session, 1, 5)
		expect(await editor.execute({ type: "format.paste" })).toBe(true)

		const result = await saveDocx({ pkg, context, sessions: editor.sessions })

		expect(result.bytes, JSON.stringify(result)).toBeDefined()

		const xml = decoder.decode(await (await OpcPackage.open(bytesSource(result.bytes ?? new Uint8Array()))).read("word/header1.xml"))

		expect(xml).toContain("<w:r><w:rPr><w:b/></w:rPr><w:t>Head</w:t></w:r>")
		expect(xml).not.toContain("w14:")
		editor.dispose()
	})
})

describe("the session's toggles and alignment", () => {
	const BOLD = (text: string): string => `<w:r><w:rPr><w:b/></w:rPr><w:t>${text}</w:t></w:r>`
	const PAGE =
		'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
		'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'

	function textPos(session: DocxEditorSession, text: string): number {
		let at = -1

		session.state.doc.descendants((node, pos) => {
			if (at < 0 && node.isText && node.text?.includes(text) === true) at = pos + (node.text.indexOf(text) ?? 0)

			return at < 0
		})

		if (at < 0) throw new Error(`no ${text}`)

		return at
	}

	it("counts a field the same in a paragraph selected whole or in part, as Bold then finds it", async () => {
		const body = `<w:p>${BOLD("One")}</w:p><w:p>${BOLD("Bold")}${PAGE}</w:p><w:p>${BOLD("Three")}</w:p>`
		const whole = (await open(body)).session

		// The middle paragraph wholly selected.
		select(whole, textPos(whole, "One") + 1, textPos(whole, "Three") + 2)
		expect(whole.snapshot().formats.bold).toBe("mixed")

		const part = (await open(body)).session

		// The middle paragraph partly selected, the selection reached by shrinking a larger one.
		select(part, textPos(part, "One"), textPos(part, "Three") + 2)
		part.snapshot()
		select(part, textPos(part, "Bold") + 1, textPos(part, "Three") + 2)
		expect(part.snapshot().formats.bold).toBe("mixed")

		// Bold finds the field not bold and turns bold on everywhere.
		expect(run(whole, { type: "format.bold" })).toBe(true)
		expect(whole.snapshot().formats.bold).toBe("on")
	})

	it("turns bold off over a selection holding a w:fldSimple without a result", async () => {
		const doc = await open(`<w:p>${BOLD("Bold")}<w:fldSimple w:instr=" PAGE "/>${BOLD("After")}</w:p>`)
		const session = doc.session

		session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))
		expect(session.snapshot().formats.bold).toBe("on")
		expect(run(session, { type: "format.bold" })).toBe(true)
		expect(markOf(textAt(session, textPos(session, "Bold")), "bold")).toBeUndefined()
		expect(session.snapshot().formats.bold).toBe("off")
	})

	it("writes a direct alignment in a cell, whose table style the resolver does not see", async () => {
		const doc = await open(
			'<w:tbl><w:tblPr><w:tblStyle w:val="Centred"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>' +
				p("Cell") +
				"</w:tc></w:tr></w:tbl>" +
				p("After"),
			{
				parts: [
					STYLES_PART(
						'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
							'<w:style w:type="table" w:styleId="Centred"><w:name w:val="Centred"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style>'
					)
				]
			}
		)
		const session = doc.session

		select(session, textPos(session, "Cell") + 2, textPos(session, "After") + 2)
		expect(run(session, { type: "align.start" })).toBe(true)

		const xml = body(await saved(doc))

		expect(xml).toMatch(/<w:jc w:val="(left|start)"\/><\/w:pPr><w:r><w:t[^>]*>Cell/)
		// Outside a table, what the paragraph style gives is left to it.
		expect(xml).not.toMatch(/<w:jc[^>]*\/><\/w:pPr><w:r><w:t[^>]*>After/)
	})
})
