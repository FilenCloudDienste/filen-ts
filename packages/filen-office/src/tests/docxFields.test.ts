import type { Node as ProseMirrorNode } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { Mapping } from "prosemirror-transform"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { bytesSource, OpcPackage } from "@filen/office/core/opc"
import { docxSchema, type DocxEditContext } from "@filen/office/core/docx/edit"
import { prepareDocxSave, saveDocx, serializeDocx } from "@filen/office/core/docx/write"
import { parseXml } from "@filen/office/core/xml"
import type { CheckInput } from "../core/docx/write/checks/index"
import { fieldChecks } from "../core/docx/write/checks/fields"
import type { DocxPackage } from "@filen/office/core/docx"
import { hitObject, type PagedEditor } from "@filen/office/core/docx/paged"
import { markInternal } from "../core/docx/edit/invariants/index"
import { sessionBookmarks } from "../core/docx/fields/bookmarks"
import * as fieldFormat from "../core/docx/fields/format"
import { datePicture, numericPicture, parseFieldCode } from "../core/docx/fields/evaluate"
import { numberSwitchFormat, numberText } from "../core/docx/layout/fields"
import { NUMBERING_PART } from "./docxEditFixtures"
import { NAMESPACES, buildDocx, p, type SyntheticDocx } from "./docxSynthetic"
import { pageLines } from "./layoutFixtures"
import { pageDigest, pagedEditor, savedDigest, settleAll } from "./pagedFixtures"

const decoder = new TextDecoder()

const encoder = new TextEncoder()
const nodes = docxSchema.nodes

beforeEach(() => {
	vi.stubEnv("TZ", "UTC")
})

interface Opened {
	readonly editor: PagedEditor
	readonly pkg: DocxPackage
	readonly context: DocxEditContext
}

async function open(source: SyntheticDocx | Uint8Array): Promise<Opened> {
	const opened = await pagedEditor(source instanceof Uint8Array ? source : buildDocx(source))

	opened.context.identity.now = () => Date.UTC(2026, 9, 12, 14, 5, 9)
	await settleAll(opened.editor)

	return opened
}

async function save(opened: Opened): Promise<Uint8Array> {
	return (await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })).bytes as Uint8Array
}

async function refusal(opened: Opened): Promise<string | undefined> {
	try {
		await prepareDocxSave({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })

		return undefined
	} catch (error) {
		return (error as { reason: string }).reason
	}
}

async function read(bytes: Uint8Array, name = "word/document.xml"): Promise<string> {
	const pkg = await OpcPackage.open(bytesSource(bytes))

	return decoder.decode(await pkg.read(name))
}

function select(editor: PagedEditor, from: number, to: number = from): void {
	const session = editor.session

	session.dispatch(session.state.tr.setSelection(TextSelection.create(session.state.doc, from, to)))
}

function find(doc: ProseMirrorNode, text: string): number {
	let found = -1

	doc.descendants((node, pos) => {
		if (found >= 0) return false
		if (node.isText && (node.text ?? "").includes(text)) found = pos + (node.text ?? "").indexOf(text)

		return true
	})

	return found
}

function fieldsOf(doc: ProseMirrorNode): { node: ProseMirrorNode; pos: number }[] {
	const out: { node: ProseMirrorNode; pos: number }[] = []

	doc.descendants((node, pos) => {
		if (node.type === nodes.field) out.push({ node, pos })

		return true
	})

	return out
}

// The fields of a document: type and result.
function fields(doc: ProseMirrorNode): string[] {
	const out: string[] = []

	doc.descendants(node => {
		if (node.type === nodes.field) out.push(`${node.attrs["type"] as string}=${node.attrs["result"] as string}`)

		return true
	})

	return out
}

const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'

// A complex field as Word writes it.
function complex(instruction: string, result: string, rPr = "", options: { dirty?: boolean; lock?: boolean } = {}): string {
	const begin = `<w:fldChar w:fldCharType="begin"${options.dirty === true ? ' w:dirty="true"' : ""}${options.lock === true ? ' w:fldLock="true"' : ""}/>`

	return (
		`<w:r>${rPr}${begin}</w:r><w:r>${rPr}<w:instrText xml:space="preserve">${instruction}</w:instrText></w:r>` +
		`<w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPr}<w:t>${result}</w:t></w:r><w:r>${rPr}<w:fldChar w:fldCharType="end"/></w:r>`
	)
}

describe("field codes and pictures", () => {
	it("parses types, arguments and switches (ECMA-376 §17.16.1)", () => {
		expect(parseFieldCode(" REF _Ref1 \\h \\* MERGEFORMAT ")).toEqual({
			type: "REF",
			args: ["_Ref1"],
			switches: [
				{ name: "h", arg: undefined },
				{ name: "*", arg: "MERGEFORMAT" }
			]
		})
		expect(parseFieldCode(' DATE \\@ "d \\"MMMM\\" yyyy" ').switches).toEqual([{ name: "@", arg: 'd "MMMM" yyyy' }])
		expect(parseFieldCode(" SEQ Figure \\r 4 \\* roman ").switches).toEqual([
			{ name: "r", arg: "4" },
			{ name: "*", arg: "roman" }
		])
	})

	it("formats numbers with \\* switches (§17.16.4.3)", async () => {
		const page = (switches: string): string => `<w:p>${complex(` PAGE ${switches} `, "?")}</w:p>`
		const opened = await open({
			body:
				page("\\* hex") +
				page("\\* HEX") +
				page("\\* ArabicDash") +
				page("\\* CardText") +
				page("\\* CardText \\* Caps") +
				page("\\* OrdText") +
				page("\\* DollarText \\* Upper") +
				page("\\* roman") +
				page("\\* ROMAN")
		})

		expect(await opened.editor.execute({ type: "field.updateAll" })).toBe(true)
		expect(fields(opened.editor.session.state.doc)).toEqual(
			["1", "1", "- 1 -", "one", "One", "first", "ONE AND 00/100", "i", "I"].map(result => `PAGE=${result}`)
		)
		// Hex digits upper case whichever the switch's case.
		expect(numberText(458, numberSwitchFormat("hex"))).toBe("1CA")
		expect(numberText(14.55, numberSwitchFormat("DollarText"))).toBe("fourteen and 55/100")
	})

	it("formats dates with \\@ pictures (§17.16.4.1)", () => {
		const date = new Date(2026, 9, 2, 14, 5, 9)

		expect(datePicture(date, "dddd, d MMMM yyyy")).toBe("Friday, 2 October 2026")
		expect(datePicture(date, "dd/MM/yy")).toBe("02/10/26")
		// am/pm shows upper case too (Microsoft's "Format field results").
		expect(datePicture(date, "h:mm am/pm")).toBe("2:05 PM")
		expect(datePicture(date, "HH:mm:ss 'o''clock'")).toBe("14:05:09 oclock")
		expect(datePicture(date, "MMM d, yyyy h:mm AM/PM")).toBe("Oct 2, 2026 2:05 PM")
		// Names in the field's language.
		expect(datePicture(date, "dddd, d. MMMM yyyy", "de-DE")).toBe("Freitag, 2. Oktober 2026")
		expect(datePicture(date, "dddd d MMMM", "fr-FR")).toBe("vendredi 2 octobre")
		expect(datePicture(date, "dddd", "en-GB")).toBe("Friday")
	})

	it("formats numbers with \\# pictures (§17.16.4.2)", () => {
		// Microsoft's "Format field results" examples.
		const examples: [number, string, string][] = [
			[9, "00.00", "09.00"],
			[15, "$###", "$ 15"],
			[222492, "x##", "492"],
			[0.125, "0.00x", "0.125"],
			[0.75, ".x", ".8"],
			[495.47, "$###.00", "$495.47"],
			[2456800, "$#,###,###", "$2,456,800"],
			[-80, "-##", "-80"],
			[80, "-##", " 80"],
			[10, "+##", "+10"],
			[-10, "+##", "-10"],
			[-345.56, "$#,##0.00;($#,##0.00);$0", "($ 345.56)"],
			[0, "$#,##0.00;($#,##0.00);$0", "$0"],
			[347.44, "$##0.00 'is sales tax'", "$347.44 is sales tax"],
			// A quoted point is text, not the decimal point.
			[5, "0 'a.b'", "5 a.b"]
		]

		expect(examples.map(([value, picture]) => numericPicture(value, picture))).toEqual(examples.map(example => example[2]))
		expect(numericPicture(1234.5, "#,##0.00")).toBe("1,234.50")
		expect(numericPicture(7, "00")).toBe("07")
		expect(numericPicture(-3, "0;(0)")).toBe("(3)")
		expect(numericPicture(0, "0;-0;'none'")).toBe("none")
		expect(numericPicture(42, "'No. '0")).toBe("No. 42")
	})
})

describe("updating fields", () => {
	it("recomputes page numbers, page counts, sequences, references and dates, and saves only what changed", async () => {
		const opened = await open({
			body:
				'<w:p><w:bookmarkStart w:id="1" w:name="Target"/><w:r><w:t>Old heading</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>' +
				`<w:p><w:r><w:t xml:space="preserve">See </w:t></w:r>${complex(" REF Target \\h ", "stale")}<w:r><w:t xml:space="preserve"> on page </w:t></w:r>${complex(" PAGEREF Target \\h ", "9")}</w:p>` +
				pageBreak +
				`<w:p>${complex(" SEQ Figure \\* ARABIC ", "7")}${complex(" SEQ Figure \\* ARABIC ", "7")}${complex(" SEQ Figure \\c ", "7")}</w:p>` +
				`<w:p>${complex(" PAGE ", "5", "<w:rPr><w:b/></w:rPr>")} of ${complex(" NUMPAGES \\* roman ", "x")}</w:p>` +
				`<w:p>${complex(' DATE \\@ "d MMMM yyyy" ', "1 January 2000")}${complex(" PAGE ", "8", "", { lock: true })}</w:p>`
		})
		const editor = opened.editor
		const session = editor.session

		// The bookmarked text changes; the reference shows it once updated.
		const at = find(session.state.doc, "Old heading")

		session.dispatch(session.state.tr.insertText("New heading", at, at + "Old heading".length))
		expect(await editor.execute({ type: "field.updateAll" })).toBe(true)

		expect(fields(session.state.doc)).toEqual([
			"REF=New heading",
			"PAGEREF=1",
			"SEQ=1",
			"SEQ=2",
			"SEQ=2",
			"PAGE=2",
			"NUMPAGES=ii",
			"DATE=12 October 2026",
			// Locked (w:fldLock): kept.
			"PAGE=8"
		])

		const bytes = await save(opened)
		const xml = await read(bytes)

		// The result written anew, the code and its run formatting kept; the locked field as it was.
		expect(xml).toContain(
			'<w:r><w:rPr><w:b/></w:rPr><w:t>2</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>'
		)
		expect(xml).toContain('<w:fldChar w:fldCharType="begin" w:fldLock="true"/>')
		expect(xml).toContain("<w:t>8</w:t>")

		const reopened = await open(bytes)

		expect(fields(reopened.editor.session.state.doc)).toEqual(fields(session.state.doc))
		expect(pageDigest(reopened.editor.layout)).toEqual(await savedDigest(bytes))
	})

	it("updates the field at the caret only, as one undo step", async () => {
		const opened = await open({
			body: `<w:p>${complex(" PAGE ", "4")}<w:r><w:t xml:space="preserve"> and </w:t></w:r>${complex(" PAGE ", "4")}</w:p>`
		})
		const editor = opened.editor
		const doc = editor.session.state.doc

		select(editor, 1)
		expect(editor.canExecute("field.update")).toBe(true)
		expect(await editor.execute({ type: "field.update" })).toBe(true)
		expect(fields(editor.session.state.doc)).toEqual(["PAGE=1", "PAGE=4"])
		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		expect(editor.session.state.doc.eq(doc)).toBe(true)
	})

	it("keeps w:dirty, markers in the old result and the field's own runs", async () => {
		const opened = await open({
			body:
				'<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
				'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:bookmarkStart w:id="3" w:name="inside"/><w:r><w:t>7</w:t></w:r><w:bookmarkEnd w:id="3"/>' +
				'<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		})

		expect(await opened.editor.execute({ type: "field.updateAll" })).toBe(true)

		const xml = await read(await save(opened))

		expect(xml).toContain('<w:fldChar w:fldCharType="begin" w:dirty="true"/>')
		expect(xml).toContain('<w:bookmarkStart w:id="3" w:name="inside"/><w:bookmarkEnd w:id="3"/><w:r><w:t>1</w:t></w:r>')
	})

	it("gives a referenced paragraph's number without context, in full context or relative to the reference (\\n \\w \\r)", async () => {
		const level = (ilvl: number, format: string, text: string): string =>
			`<w:lvl w:ilvl="${String(ilvl)}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/></w:lvl>`
		const numbering = (id: number, levels: string): string => `<w:abstractNum w:abstractNumId="${String(id)}">${levels}</w:abstractNum>`
		const item = (numId: number, ilvl: number, text: string, bookmark = ""): string =>
			`<w:p><w:pPr><w:numPr><w:ilvl w:val="${String(ilvl)}"/><w:numId w:val="${String(numId)}"/></w:numPr></w:pPr>` +
			(bookmark === "" ? "" : `<w:bookmarkStart w:id="${String(bookmark.length)}" w:name="${bookmark}"/>`) +
			`<w:r><w:t>${text}</w:t></w:r>${bookmark === "" ? "" : `<w:bookmarkEnd w:id="${String(bookmark.length)}"/>`}</w:p>`
		const ref = (switches: string): string => `<w:p>${complex(` REF Target ${switches} \\h `, "?")}</w:p>`
		const parts = [
			NUMBERING_PART(
				numbering(1, level(0, "decimal", "%1.") + level(1, "lowerLetter", "%2.") + level(2, "lowerRoman", "%3.")) +
					numbering(2, level(0, "decimal", "%1.") + level(1, "decimal", "%1.%2.") + level(2, "decimal", "%1.%2.%3.")) +
					'<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>'
			)
		]
		const relationships = [{ id: "rIdN", type: "numbering", target: "numbering.xml" }]
		// An outline list (1. a. i.): the referenced item is 1.a.ii.
		const outline = await open({
			body:
				item(1, 0, "One") +
				item(1, 1, "A") +
				item(1, 2, "First") +
				item(1, 2, "Second", "Target") +
				ref("\\n") +
				ref("\\w") +
				ref("\\w \\d -") +
				ref("\\r"),
			parts,
			relationships
		})

		expect(await outline.editor.execute({ type: "field.updateAll" })).toBe(true)
		expect(fields(outline.editor.session.state.doc)).toEqual(["REF=ii", "REF=1.a.ii", "REF=1-a-ii", "REF=1.a.ii"])

		// A legal list (4.5.2), referenced from inside 4.3.1: relative leaves out the 4 both share.
		const legal = await open({
			body:
				item(2, 0, "1") +
				item(2, 0, "2") +
				item(2, 0, "3") +
				item(2, 0, "4") +
				item(2, 1, "4.1") +
				item(2, 1, "4.2") +
				item(2, 1, "4.3") +
				`<w:p><w:pPr><w:numPr><w:ilvl w:val="2"/><w:numId w:val="2"/></w:numPr></w:pPr>${complex(" REF Target \\r \\h ", "?")}</w:p>` +
				item(2, 1, "4.4") +
				item(2, 1, "4.5") +
				item(2, 2, "4.5.1") +
				item(2, 2, "4.5.2", "Target") +
				ref("\\n") +
				ref("\\w"),
			parts,
			relationships
		})

		expect(await legal.editor.execute({ type: "field.updateAll" })).toBe(true)
		expect(fields(legal.editor.session.state.doc)).toEqual(["REF=5.2", "REF=4.5.2", "REF=4.5.2"])
	})

	it("writes a date in the language of the field's runs", async () => {
		const opened = await open({
			body: `<w:p>${complex(' DATE \\@ "dddd, d. MMMM yyyy" ', "x", '<w:rPr><w:lang w:val="de-DE"/></w:rPr>')}</w:p>`
		})

		expect(await opened.editor.execute({ type: "field.updateAll" })).toBe(true)
		expect(fields(opened.editor.session.state.doc)).toEqual(["DATE=Montag, 12. Oktober 2026"])
	})

	it("keeps a reference's result when its bookmark holds a list number field it cannot count", async () => {
		const opened = await open({
			body:
				'<w:p><w:bookmarkStart w:id="1" w:name="Annex"/><w:r><w:t xml:space="preserve">Annex </w:t></w:r>' +
				'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> LISTNUM Appendix </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' +
				'<w:r><w:t xml:space="preserve"> Data</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>' +
				`<w:p>${complex(" REF Annex \\h ", "Annex A Data")}</w:p>`
		})

		expect(await opened.editor.execute({ type: "field.updateAll" })).toBe(true)
		expect(fields(opened.editor.session.state.doc)).toEqual(["LISTNUM=", "REF=Annex A Data"])
	})

	it("counts sequences and reads bookmarked text kept in locked paragraphs", async () => {
		// A field character sharing a run with text: a paragraph kept as its bytes.
		const lockedCaption =
			'<w:p><w:bookmarkStart w:id="7" w:name="Target"/><w:r><w:t xml:space="preserve">Figure </w:t><w:fldChar w:fldCharType="begin"/></w:r>' +
			'<w:r><w:instrText xml:space="preserve"> SEQ Figure \\* ARABIC </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
			'<w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>: kept</w:t></w:r><w:bookmarkEnd w:id="7"/></w:p>'
		const opened = await open({
			body:
				p("Intro") +
				lockedCaption +
				`<w:p><w:r><w:t xml:space="preserve">Figure </w:t></w:r>${complex(" SEQ Figure \\* ARABIC ", "9")}</w:p>` +
				`<w:p><w:r><w:t xml:space="preserve">See </w:t></w:r>${complex(" REF Target \\h ", "old")}</w:p>`
		})
		const doc = opened.editor.session.state.doc

		expect(doc.child(1).type).toBe(nodes.locked_block)
		expect(await opened.editor.execute({ type: "field.updateAll" })).toBe(true)
		expect(fields(opened.editor.session.state.doc)).toEqual(["SEQ=2", "REF=Figure 1: kept"])
	})

	it("reads a renumbered caption's new number in a reference after it in one update", async () => {
		const opened = await open({
			body:
				`<w:p><w:bookmarkStart w:id="7" w:name="Target"/><w:r><w:t xml:space="preserve">Figure </w:t></w:r>${complex(" SEQ Figure \\* ARABIC ", "9")}<w:bookmarkEnd w:id="7"/></w:p>` +
				`<w:p><w:r><w:t xml:space="preserve">See </w:t></w:r>${complex(" REF Target \\h ", "old")}</w:p>`
		})

		expect(await opened.editor.execute({ type: "field.updateAll" })).toBe(true)
		expect(fields(opened.editor.session.state.doc)).toEqual(["SEQ=1", "REF=Figure 1"])
	})

	it("numbers captions in body text boxes in one sequence with the body, by where each box is anchored", async () => {
		const caption = (result: string): string =>
			`<w:p><w:r><w:t xml:space="preserve">Figure </w:t></w:r>${complex(" SEQ Figure \\* ARABIC ", result)}</w:p>`
		const box = (id: number, result: string): string =>
			`<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${String(id)}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">` +
			'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
			`<wp:extent cx="1828800" cy="457200"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${String(id)}" name="Text Box ${String(id)}"/>` +
			'<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/>' +
			'<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>' +
			`<wps:txbx><w:txbxContent>${caption(result)}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`
		const opened = await open({
			body: caption("7") + `<w:p>${box(5, "7")}<w:r><w:t>Anchor</w:t></w:r>${box(6, "7")}</w:p>` + caption("7")
		})
		const editor = opened.editor
		const boxes = editor.edits.model.stories.filter(story => story?.kind === "textbox")

		expect(boxes).toHaveLength(2)

		// The body counts the boxes anchored before its captions.
		expect(await editor.execute({ type: "field.updateAll" })).toBe(true)
		expect(fields(editor.session.state.doc)).toEqual(["SEQ=1", "SEQ=4"])

		// Updated in a box, its caption runs on from the body before its anchor; boxes on one anchor in order.
		for (const [index, expected] of [
			[1, "SEQ=3"],
			[0, "SEQ=2"]
		] as const) {
			expect(editor.enterStory(boxes[index]?.index ?? -1, 0)).toBe(true)
			expect(await editor.execute({ type: "field.updateAll" })).toBe(true)
			expect(fields(editor.session.state.doc)).toEqual([expected])
			editor.exitStory()
		}

		// Counted again from the boxes' edited sessions.
		expect(await editor.execute({ type: "field.updateAll" })).toBe(true)
		expect(fields(editor.session.state.doc)).toEqual(["SEQ=1", "SEQ=4"])
	})
})

describe("inserting fields", () => {
	it("inserts page numbers, page counts and dates as Word's complex fields", async () => {
		const opened = await open({ body: p("Page ") + pageBreak + p("End") })
		const editor = opened.editor

		select(editor, 6)
		expect(editor.execute({ type: "insert.pageNumber" })).toBe(true)
		expect(editor.execute({ type: "insert.date", format: "d/M/yyyy" })).toBe(true)
		await settleAll(editor)
		expect(editor.execute({ type: "insert.pageCount" })).toBe(true)
		expect(fields(editor.session.state.doc)).toEqual(["PAGE=1", "DATE=12/10/2026", "NUMPAGES=2"])

		const bytes = await save(opened)
		const xml = await read(bytes)

		expect(xml).toContain(
			'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE \\* MERGEFORMAT </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
		)
		expect(pageDigest((await open(bytes)).editor.layout)).toEqual(await savedDigest(bytes))
	})

	it("inserts cross-references to bookmarks it has, and no others", async () => {
		const opened = await open({
			body:
				'<w:p><w:bookmarkStart w:id="1" w:name="Figure1"/><w:r><w:t>Figure 1</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>' + p("See ")
		})
		const editor = opened.editor
		const end = editor.session.state.doc.content.size - 1

		select(editor, end)
		expect(editor.execute({ type: "insert.field", instruction: "REF Missing \\h" })).toBe(false)
		expect(editor.execute({ type: "insert.field", instruction: "REF Figure1 \\h" })).toBe(true)
		expect(fields(editor.session.state.doc)).toEqual(["REF=Figure 1"])
		expect(await refusal(opened)).toBeUndefined()
		// Word keeps a reference whose bookmark goes (an update shows its error text).
		expect(editor.execute({ type: "bookmark.delete", name: "Figure1" })).toBe(true)
		expect(await refusal(opened)).toBeUndefined()
		expect(await editor.execute({ type: "field.updateAll" })).toBe(true)
		// Word's error text for a reference (a page reference's is "Error! Bookmark not defined.").
		expect(fields(editor.session.state.doc)).toEqual(["REF=Error! Reference source not found."])
	})
})

describe("a result for a field without one", () => {
	it("writes the separator after the code, leaving no run of the end character's behind", async () => {
		const rPr = '<w:rPr><w:sz w:val="20"/></w:rPr>'
		const begin = `<w:r>${rPr}<w:fldChar w:fldCharType="begin"/></w:r>`
		const code = '<w:instrText xml:space="preserve"> PAGE </w:instrText>'
		const end = '<w:fldChar w:fldCharType="end"/>'
		// The end character in a run of its own, and in the code's run.
		for (const runs of [`${begin}<w:r>${rPr}${code}</w:r><w:r>${rPr}${end}</w:r>`, `${begin}<w:r>${rPr}${code}${end}</w:r>`]) {
			const opened = await open({ body: `<w:p>${runs}<w:r><w:t xml:space="preserve"> after</w:t></w:r></w:p>` })

			expect(await opened.editor.execute({ type: "field.updateAll" })).toBe(true)
			expect(fields(opened.editor.session.state.doc)).toEqual(["PAGE=1"])

			const xml = await read(await save(opened))

			expect(xml).toContain(
				`<w:r>${rPr}${code}</w:r><w:r>${rPr}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPr}<w:t>1</w:t></w:r><w:r>${rPr}${end}</w:r>`
			)
			expect(xml).not.toMatch(/<w:r>(<w:rPr>(?:(?!<\/w:rPr>).)*<\/w:rPr>)?<\/w:r>/)
		}
	})
})

describe("tracked updates", () => {
	it("records an update while tracking as Word does (old result deleted, new inserted), accepted or rejected whole", async () => {
		const body = `<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r>${complex(" PAGE ", "9", "<w:rPr><w:b/></w:rPr>")}</w:p>`
		const opened = await open({ body })
		const editor = opened.editor
		const session = editor.session

		opened.context.identity.author = "Ann Lee"
		opened.context.review.tracking = true
		expect(await editor.execute({ type: "field.updateAll" })).toBe(true)

		const [field] = fieldsOf(session.state.doc)

		expect(field?.node.attrs["result"]).toBe("1")
		expect(field?.node.attrs["update"]).toMatchObject({ result: "9", author: "Ann Lee" })
		expect(session.snapshot().review.revisionCount).toBe(1)

		// Updated again: still one change, from the result before the first.
		expect(await editor.execute({ type: "field.updateAll" })).toBe(true)
		expect(fieldsOf(session.state.doc)[0]?.node.attrs["update"]).toMatchObject({ result: "9" })

		const bytes = await save(opened)
		const xml = await read(bytes)

		expect(xml).toMatch(
			/<w:fldChar w:fldCharType="separate"\/><\/w:r><w:del w:id="\d+" w:author="Ann Lee" w:date="[^"]+"><w:r><w:rPr><w:b\/><\/w:rPr><w:delText>9<\/w:delText><\/w:r><\/w:del><w:ins w:id="\d+" w:author="Ann Lee" w:date="[^"]+"><w:r><w:rPr><w:b\/><\/w:rPr><w:t>1<\/w:t><\/w:r><\/w:ins><w:r><w:rPr><w:b\/><\/w:rPr><w:fldChar w:fldCharType="end"\/>/
		)

		// Reopened, the update is the field's again, and resolves as one.
		const reopened = await open(bytes)
		const again = reopened.editor.session

		expect(pageDigest(reopened.editor.layout)).toEqual(await savedDigest(bytes))
		expect(fieldsOf(again.state.doc)[0]?.node.attrs).toMatchObject({ result: "1", update: { result: "9", author: "Ann Lee" } })
		expect(again.snapshot().review.revisionCount).toBe(1)
		expect(await reopened.editor.execute({ type: "review.rejectAll" })).toBe(true)
		expect(fieldsOf(again.state.doc)[0]?.node.attrs).toMatchObject({ result: "9", update: null })
		// As the file had it before the update.
		expect(await read(await save(reopened))).toContain(body)

		expect(await reopened.editor.execute({ type: "history.undo" })).toBe(true)
		expect(await reopened.editor.execute({ type: "review.acceptAll" })).toBe(true)
		expect(fieldsOf(again.state.doc)[0]?.node.attrs).toMatchObject({ result: "1", update: null })

		const accepted = await read(await save(reopened))

		expect(accepted).not.toContain("<w:del ")
		expect(accepted).toContain("<w:r><w:rPr><w:b/></w:rPr><w:t>1</w:t></w:r>")
	})

	it("leaves fields deleted while tracking as they are when every field is updated", async () => {
		const figure = (result: string, text: string): string =>
			`<w:p><w:r><w:t xml:space="preserve">Figure </w:t></w:r>${complex(" SEQ Figure ", result)}<w:r><w:t xml:space="preserve"> ${text}</w:t></w:r></w:p>`
		const page = `<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r>${complex(" PAGE ", "7")}</w:p>`
		const opened = await open({ body: page + figure("2", "second") + figure("3", "third") })
		const editor = opened.editor
		const session = editor.session

		opened.context.identity.author = "Ann Lee"
		opened.context.review.tracking = true

		const [first] = fieldsOf(session.state.doc)

		select(editor, first?.pos ?? 0, (first?.pos ?? 0) + 1)
		session.dispatch(session.state.tr.deleteSelection())
		expect(await editor.execute({ type: "field.updateAll" })).toBe(true)

		const fields = fieldsOf(session.state.doc)

		// The deleted one keeps its result and records no update.
		expect(fields.map(field => field.node.attrs["result"])).toEqual(["7", "1", "2"])
		expect(fields[0]?.node.attrs["update"]).toBeNull()
		expect(docxSchema.marks.deletion.isInSet(fields[0]?.node.marks ?? [])).toBeDefined()
		expect(await refusal(opened)).toBeUndefined()

		const bytes = await save(opened)
		const reopened = await open(bytes)

		expect(pageDigest(reopened.editor.layout)).toEqual(await savedDigest(bytes))
		expect(fieldsOf(reopened.editor.session.state.doc).map(field => field.node.attrs["result"])).toEqual(["7", "1", "2"])
	})

	it("leaves a field inserted while tracking to its insertion, and needs the author's name", async () => {
		const opened = await open({ body: p("Text") })
		const editor = opened.editor

		opened.context.review.tracking = true
		select(editor, 3)
		expect(await editor.execute({ type: "field.updateAll" })).toBe(false)

		opened.context.identity.author = "Ann Lee"
		expect(await editor.execute({ type: "insert.pageCount" })).toBe(true)
		expect(await editor.execute({ type: "field.updateAll" })).toBe(true)
		expect(fieldsOf(editor.session.state.doc)[0]?.node.attrs["update"]).toBeNull()
		expect(await refusal(opened)).toBeUndefined()
	})

	it("accepts or rejects every tracked update of many fields at once", async () => {
		const body = Array.from({ length: 40 }, () => `<w:p>${complex(" PAGE ", "9")}</w:p>`).join("")

		for (const accept of [true, false]) {
			const opened = await open({ body })
			const editor = opened.editor

			opened.context.identity.author = "Ann Lee"
			opened.context.review.tracking = true
			expect(await editor.execute({ type: "field.updateAll" })).toBe(true)
			expect(await editor.execute({ type: accept ? "review.acceptAll" : "review.rejectAll" })).toBe(true)

			const fields = fieldsOf(editor.session.state.doc)

			expect(fields.filter(field => field.node.attrs["update"] !== null)).toHaveLength(0)
			expect(new Set(fields.map(field => field.node.attrs["result"]))).toEqual(new Set([accept ? "1" : "9"]))
			expect(editor.session.snapshot().review.revisionCount).toBe(0)
		}
	})
})

describe("field codes view", () => {
	const text = (editor: PagedEditor): string[] => pageLines(editor.layout, 0).map(line => line.text)

	it("shows every field as its code (Alt+F9) and one field at a time (Shift+F9), a view the file never sees", async () => {
		const opened = await open({
			body:
				`<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r>${complex(" PAGE \\* MERGEFORMAT ", "1")}<w:r><w:t xml:space="preserve"> of </w:t></w:r>` +
				'<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve"> see </w:t></w:r>' +
				`${complex(" REF Target \\h ", "the target")}</w:p>` +
				'<w:p><w:bookmarkStart w:id="1" w:name="Target"/><w:r><w:t>the target</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>'
		})
		const editor = opened.editor
		const before = pageDigest(editor.layout)

		expect(text(editor)[0]).toBe("Page 1 of 1 see the target")
		expect(editor.canExecute("view.fieldCodes")).toBe(true)
		expect(await editor.execute({ type: "view.fieldCodes" })).toBe(true)
		await settleAll(editor)
		expect(editor.fieldCodes).toBe(true)
		expect(text(editor)[0]).toBe("Page { PAGE \\* MERGEFORMAT } of { NUMPAGES } see { REF Target \\h }")

		// Typing after a field shown as its code lands after the field.
		const [page, , ref] = fieldsOf(editor.session.state.doc)

		select(editor, (ref?.pos ?? 0) + 1)
		editor.session.dispatch(editor.session.state.tr.insertText("!"))
		await settleAll(editor)
		expect(text(editor)[0]).toBe("Page { PAGE \\* MERGEFORMAT } of { NUMPAGES } see { REF Target \\h }!")

		// Shift+F9 on the page number shows its result again.
		select(editor, page?.pos ?? 0)
		expect(await editor.execute({ type: "view.fieldCode" })).toBe(true)
		await settleAll(editor)
		expect(text(editor)[0]).toBe("Page 1 of { NUMPAGES } see { REF Target \\h }!")

		expect(await editor.execute({ type: "view.fieldCodes" })).toBe(true)
		await settleAll(editor)
		expect(editor.fieldCodes).toBe(false)
		expect(text(editor)[0]).toBe("Page 1 of 1 see the target!")

		// One field alone, in the results view.
		select(editor, (fieldsOf(editor.session.state.doc)[2]?.pos ?? 0) + 1)
		expect(await editor.execute({ type: "view.fieldCode" })).toBe(true)
		await settleAll(editor)
		expect(text(editor)[0]).toBe("Page 1 of 1 see { REF Target \\h }!")

		// What a save writes and its fresh layout are the results view's.
		expect(editor.setFieldCodes(false)).toBe(true)
		await settleAll(editor)

		const bytes = await save(opened)

		expect(pageDigest(editor.layout)).toEqual(await savedDigest(bytes))
		expect(before).not.toEqual(pageDigest(editor.layout))
		expect(await read(bytes)).not.toContain("{")
	})

	it("lays out again from the page a field switched one by one is on, as switching every field would show it", async () => {
		const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
		const body =
			["One", "Two", "Three", "Four"].map(text => p(text) + pageBreak).join("") +
			`<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r>${complex(" PAGE ", "3")}<w:r><w:t xml:space="preserve"> of the text</w:t></w:r></w:p>`
		const switched = async (whole: boolean): Promise<{ digest: string[]; kept: boolean[] }> => {
			const opened = await open({ body })
			const editor = opened.editor
			const before = [...editor.layout.pages]
			const [field] = fieldsOf(editor.session.state.doc)

			select(editor, field?.pos ?? 0)

			if (whole) expect(editor.toggleFieldCodes(field === undefined ? [] : [field.node])).toBe(true)
			else expect(await editor.execute({ type: "view.fieldCode" })).toBe(true)

			await settleAll(editor)

			return { digest: pageDigest(editor.layout), kept: before.map((page, index) => editor.layout.pages[index] === page) }
		}
		const one = await switched(false)
		const all = await switched(true)

		expect(one.digest).toEqual(all.digest)
		expect(one.digest[4]).toContain("{ PAGE }")
		// Laid out again from the page the field is on (or the one before, which it might now fit at the end of).
		expect(one.kept).toEqual([true, true, true, false, false])
		expect(all.kept).toEqual([false, false, false, false, false])
	})

	it("shows a table of contents spanning paragraphs as its code alone", async () => {
		const opened = await open({
			body:
				'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r>' +
				'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>One</w:t></w:r></w:p>' +
				'<w:p><w:r><w:t>Two</w:t></w:r></w:p><w:p><w:r><w:t>Three</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
				p("After")
		})
		const editor = opened.editor

		expect(text(editor)).toEqual(["One", "Two", "Three", "After"])
		await editor.execute({ type: "view.fieldCodes" })
		await settleAll(editor)
		expect(text(editor)).toEqual(['{ TOC \\o "1-3" }', "After"])

		// Its paragraphs edited (laid out from the edit) stay under the code, the first and last too.
		for (const entry of ["Two", "One", "Three"]) {
			select(editor, find(editor.session.state.doc, entry) + 1)
			editor.session.dispatch(editor.session.state.tr.insertText("x"))
			await settleAll(editor)
			expect(text(editor)).toEqual(['{ TOC \\o "1-3" }', "After"])
		}

		await editor.execute({ type: "view.fieldCodes" })
		await settleAll(editor)
		expect(text(editor)).toEqual(["Oxne", "Txwo", "Txhree", "After"])
	})

	it("shows codes after one edit changed two paragraphs (positions of the blocks between kept)", async () => {
		const opened = await open({ body: p("Alpha one") + p("Beta two") + `<w:p>${complex(" PAGE ", "1")}</w:p>` })
		const editor = opened.editor
		const session = editor.session
		const tr = session.state.tr

		tr.insertText("x", find(session.state.doc, "two"))
		tr.insertText("y", find(session.state.doc, "one"))
		session.dispatch(tr)
		await settleAll(editor)
		expect(editor.setFieldCodes(true)).toBe(true)
		await settleAll(editor)
		expect(text(editor)).toEqual(["Alpha yone", "Beta xtwo", "{ PAGE }"])
	})
})

describe("tracked changes in field codes", () => {
	const codes = (doc: ProseMirrorNode): string[] => fieldsOf(doc).map(field => field.node.attrs["instruction"] as string)

	it("accepts or rejects tracked changes inside a field's code with all others", async () => {
		const ins = (id: number, inner: string): string =>
			`<w:ins w:id="${String(id)}" w:author="Ann" w:date="2026-01-01T00:00:00Z">${inner}</w:ins>`
		const del = (id: number, inner: string): string =>
			`<w:del w:id="${String(id)}" w:author="Bob" w:date="2026-01-02T00:00:00Z">${inner}</w:del>`
		const code = (text: string, rPr = ""): string => `<w:r>${rPr}<w:instrText xml:space="preserve">${text}</w:instrText></w:r>`
		const gone = (text: string, rPr = ""): string => `<w:r>${rPr}<w:delInstrText xml:space="preserve">${text}</w:delInstrText></w:r>`
		const field = (inner: string): string =>
			`<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r>${inner}` +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>9</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		// The code: its tracked changes, the code after accepting and after rejecting them.
		const cases = [
			[ins(1, del(2, gone(" NUMPAGES "))) + code(" PAGE "), " PAGE ", " PAGE "],
			[ins(1, code(" PAGE ")), " PAGE ", ""],
			[ins(1, del(2, gone(" PAGE "))), "", ""],
			[ins(1, del(2, gone(" PAGE ", "<w:rPr><w:b/></w:rPr>"))), "", ""],
			// A switch inserted in a run of its own, its properties other than the code's.
			[code(" PAGE ", "<w:rPr><w:b/></w:rPr>") + ins(1, code("\\* roman ", "<w:rPr><w:i/></w:rPr>")), " PAGE \\* roman ", " PAGE "],
			[del(1, gone(" PAGE ")) + code(" NUMPAGES "), " NUMPAGES ", " PAGE  NUMPAGES "]
		] as const

		for (const [inner, accepted, rejected] of cases)
			for (const accept of [true, false]) {
				const source = buildDocx({ body: field(inner) })
				const opened = await open(source)

				expect(await read(await save(opened))).toBe(await read(source))
				// The code an update evaluates: the code after its tracked changes.
				expect(codes(opened.editor.session.state.doc)).toEqual([accepted])
				expect(await opened.editor.execute({ type: accept ? "review.acceptAll" : "review.rejectAll" })).toBe(true)

				const instruction = accept ? accepted : rejected
				const bytes = await save(opened)
				const xml = await read(bytes)

				expect(codes(opened.editor.session.state.doc)).toEqual([instruction])
				expect(xml).not.toMatch(/<w:(ins|del) /)
				expect(xml).toContain(
					`<w:instrText xml:space="preserve">${instruction}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/>`
				)
				expect(xml).toContain("<w:t>9</w:t>")
				expect(codes((await open(bytes)).editor.session.state.doc)).toEqual([instruction])
				expect(pageDigest(opened.editor.layout)).toEqual(await savedDigest(bytes))
			}
	})
})

describe("formatting fields", () => {
	const body = `<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r>${complex(" PAGE ", "1", "<w:rPr><w:i/></w:rPr>")}<w:r><w:t xml:space="preserve"> end</w:t></w:r></w:p>`

	it("gives every run of a field the formatting a selection takes, keeping each run's own, and undoes it", async () => {
		const source = buildDocx({ body })
		const opened = await open(source)
		const editor = opened.editor
		const session = editor.session

		select(editor, 1, session.state.doc.content.size - 1)
		expect(editor.execute({ type: "format.allCaps" })).toBe(true)
		expect(docxSchema.marks.caps.isInSet(fieldsOf(session.state.doc)[0]?.node.marks ?? [])).toBeDefined()

		const bytes = await save(opened)
		const xml = await read(bytes)

		// Code and result runs alike: caps added, italic kept.
		expect(xml.match(/<w:r><w:rPr><w:i\/><w:caps\/><\/w:rPr><w:(fldChar|instrText|t)\b/g)).toHaveLength(5)
		await settleAll(editor)
		expect(pageDigest(editor.layout)).toEqual(await savedDigest(bytes))

		// Read back, the field shows it, and an update keeps it (its code's first character has it).
		const reopened = await open(bytes)

		expect(docxSchema.marks.caps.isInSet(fieldsOf(reopened.editor.session.state.doc)[0]?.node.marks ?? [])).toBeDefined()
		reopened.editor.session.dispatch(
			markInternal(
				reopened.editor.session.state.tr.setNodeAttribute(fieldsOf(reopened.editor.session.state.doc)[0]?.pos ?? 0, "result", "7")
			)
		)
		expect(await read(await save(reopened))).toContain("<w:r><w:rPr><w:i/><w:caps/></w:rPr><w:t>7</w:t></w:r>")

		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		expect(await read(await save(opened))).toBe(await read(source))
	})

	it("reads a field deleted while tracking with the formatting it had (its code deleted too)", async () => {
		const merged =
			'<w:p><w:r><w:t xml:space="preserve">Field: </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TIME \\* MERGEFORMAT </w:instrText></w:r>' +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:noProof/></w:rPr><w:t>6:25 PM</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		const opened = await open({ body: merged })
		const session = opened.editor.session

		opened.context.identity.author = "Ann Lee"
		opened.context.review.tracking = true
		select(opened.editor, 1, session.state.doc.content.size - 1)
		session.dispatch(session.state.tr.deleteSelection())
		expect(await refusal(opened)).toBeUndefined()
		expect(fieldsOf((await open(await save(opened))).editor.session.state.doc)[0]?.node.marks.map(mark => mark.type.name)).toEqual([
			"deletion",
			"no_proof"
		])
	})

	it("bolds a field with the rest of a selection (Ctrl+B)", async () => {
		const opened = await open({ body })
		const session = opened.editor.session

		select(opened.editor, 1, session.state.doc.content.size - 1)
		expect(opened.editor.execute({ type: "format.bold" })).toBe(true)
		expect(docxSchema.marks.bold.isInSet(fieldsOf(session.state.doc)[0]?.node.marks ?? [])).toBeDefined()
	})

	it("records the formatting of a field while tracking in each of its runs, accepted or rejected whole", async () => {
		const source = buildDocx({ body })

		for (const accept of [true, false]) {
			const opened = await open(source)
			const editor = opened.editor
			const session = editor.session

			opened.context.identity.author = "Ann Lee"
			opened.context.review.tracking = true
			select(editor, 1, session.state.doc.content.size - 1)
			expect(editor.execute({ type: "format.allCaps" })).toBe(true)

			const bytes = await save(opened)
			const xml = await read(bytes)

			expect(
				xml.match(
					/<w:r><w:rPr><w:i\/><w:caps\/><w:rPrChange w:id="\d+" w:author="Ann Lee" w:date="[^"]+"><w:rPr><w:i\/><\/w:rPr><\/w:rPrChange><\/w:rPr><w:(fldChar|instrText|t)\b/g
				)
			).toHaveLength(5)

			const reopened = await open(bytes)

			expect(pageDigest(reopened.editor.layout)).toEqual(await savedDigest(bytes))
			expect(await reopened.editor.execute({ type: accept ? "review.acceptAll" : "review.rejectAll" })).toBe(true)

			const resolved = await read(await save(reopened))

			expect(resolved).not.toContain("rPrChange")
			expect(resolved.match(/<w:rPr><w:i\/><w:caps\/><\/w:rPr>/g) ?? []).toHaveLength(accept ? 5 : 0)
		}
	})

	// Only the field's runs, from its begin to its end.
	const fieldXml = (xml: string): string => {
		const from = xml.indexOf("Page </w:t></w:r>") + 17
		const end = '<w:fldChar w:fldCharType="end"/></w:r>'

		return xml.slice(from, xml.indexOf(end, from) + end.length)
	}

	it("resolves a tracked formatting of a field run by run: rejected, each run gets back what its own change recorded", async () => {
		// Only the result italic, the code upright: italic given to the whole field while tracking (the result
		// records it had it).
		const mixed =
			'<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> end</w:t></w:r></w:p>'
		const source = buildDocx({ body: mixed })

		for (const accept of [false, true]) {
			const opened = await open(source)
			const session = opened.editor.session

			opened.context.identity.author = "Ann Lee"
			opened.context.review.tracking = true
			select(opened.editor, 1, session.state.doc.content.size - 1)
			expect(opened.editor.execute({ type: "format.italic" })).toBe(true)

			const reopened = await open(await save(opened))

			expect(await reopened.editor.execute({ type: accept ? "review.acceptAll" : "review.rejectAll" })).toBe(true)

			const field = fieldXml(await read(await save(reopened)))

			expect(field).not.toContain("<w:rPr></w:rPr>")
			expect(field).not.toContain("rPrChange")
			if (accept) expect(field.match(/<w:r><w:rPr><w:i\/><w:iCs\/><\/w:rPr>/g)).toHaveLength(5)
			else expect(field).toBe(fieldXml(mixed))
		}
	})

	it("resolves a change of the file's some runs of a field record, and records tracked formatting over it in the others", async () => {
		// Bob's change on the code's run alone.
		const partial =
			'<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><w:i/><w:rPrChange w:id="90" w:author="Bob" w:date="2026-01-01T00:00:00Z"><w:rPr/></w:rPrChange></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> end</w:t></w:r></w:p>'

		// The change shows and resolves: rejected, the code's run upright again; accepted, italic stays.
		for (const accept of [false, true]) {
			const opened = await open({ body: partial })

			expect(fieldsOf(opened.editor.session.state.doc)[0]?.node.marks.map(mark => mark.type.name)).toEqual([
				"italic",
				"format_change"
			])
			expect(await opened.editor.execute({ type: accept ? "review.acceptAll" : "review.rejectAll" })).toBe(true)

			const field = fieldXml(await read(await save(opened)))

			expect(field).not.toContain("rPrChange")
			expect(field.includes("<w:i/>")).toBe(accept)
		}

		// Tracked formatting over it: every run records a change, the code's run Bob's (the oldest), the rest Ann's.
		const opened = await open({ body: partial })
		const session = opened.editor.session

		opened.context.identity.author = "Ann Lee"
		opened.context.review.tracking = true
		select(opened.editor, 1, session.state.doc.content.size - 1)
		expect(opened.editor.execute({ type: "format.allCaps" })).toBe(true)

		const bytes = await save(opened)
		const field = fieldXml(await read(bytes))

		expect(field.match(/<w:rPrChange w:id="\d+" w:author="Ann Lee"/g)).toHaveLength(4)
		expect(field.match(/<w:rPrChange w:id="\d+" w:author="Bob"/g)).toHaveLength(1)

		// Read back, rejected: the field as it was before both.
		const reopened = await open(bytes)

		expect(await reopened.editor.execute({ type: "review.rejectAll" })).toBe(true)
		expect(fieldXml(await read(await save(reopened)))).not.toMatch(/rPrChange|<w:i\/>|<w:caps\/>/)
	})

	it("formats a field again after its tracked formatting change was accepted or rejected, and saves", async () => {
		const run = (k: number, inner: string): string =>
			`<w:r><w:rPr><w:b/><w:rPrChange w:id="${String(k)}" w:author="Bob" w:date="2026-01-01T00:00:00Z"><w:rPr/></w:rPrChange></w:rPr>${inner}</w:r>`
		const whole =
			'<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r>' +
			run(1, '<w:fldChar w:fldCharType="begin"/>') +
			run(2, '<w:instrText xml:space="preserve"> PAGE </w:instrText>') +
			run(3, '<w:fldChar w:fldCharType="separate"/>') +
			run(4, "<w:t>1</w:t>") +
			run(5, '<w:fldChar w:fldCharType="end"/>') +
			'<w:r><w:t xml:space="preserve"> end</w:t></w:r></w:p>'

		for (const accept of [true, false]) {
			const opened = await open({ body: whole })
			const session = opened.editor.session

			expect(await opened.editor.execute({ type: accept ? "review.acceptAll" : "review.rejectAll" })).toBe(true)
			select(opened.editor, 1, session.state.doc.content.size - 1)
			expect(opened.editor.execute({ type: "format.italic" })).toBe(true)
			expect(await refusal(opened)).toBeUndefined()

			const field = fieldXml(await read(await save(opened)))

			expect(field).not.toContain("rPrChange")
			expect(field.match(/<w:r><w:rPr>(<w:b\/>)?<w:i\/><w:iCs\/><\/w:rPr>/g)).toHaveLength(5)
			expect(field.includes("<w:b/>")).toBe(accept)
		}
	})

	it("writes a w:fldSimple's new result without properties unless MERGEFORMAT keeps the previous (§17.16.4.3)", async () => {
		for (const [instr, rPr] of [
			[" PAGE ", ""],
			[" PAGE \\* MERGEFORMAT ", '<w:rPr><w:sz w:val="28"/></w:rPr>']
		] as const) {
			const opened = await open({
				body: `<w:p><w:fldSimple w:instr="${instr}"><w:r><w:rPr><w:sz w:val="28"/></w:rPr><w:t>9</w:t></w:r></w:fldSimple></w:p>`
			})
			const session = opened.editor.session

			expect(await opened.editor.execute({ type: "field.updateAll" })).toBe(true)
			expect(fields(session.state.doc)).toEqual(["PAGE=1"])
			expect(await read(await save(opened))).toContain(`<w:r>${rPr}<w:t>1</w:t></w:r></w:fldSimple>`)
		}
	})

	it("keeps a w:fldSimple's result properties while its tracked update is pending, and back when it is rejected", async () => {
		const simple = (instr: string): string =>
			`<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr="${instr}"><w:r><w:rPr><w:b/></w:rPr><w:t>9</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve"> end</w:t></w:r></w:p>`

		for (const [instr, merge] of [
			[" PAGE ", false],
			[" PAGE \\* MERGEFORMAT ", true]
		] as const)
			for (const reopen of [false, true])
				for (const accept of [false, true]) {
					const opened = await open({ body: simple(instr) })

					opened.context.identity.author = "Ann Lee"
					opened.context.review.tracking = true
					expect(await opened.editor.execute({ type: "field.updateAll" })).toBe(true)

					const pending = await read(await save(opened))
					const fresh = merge ? "<w:rPr><w:b/></w:rPr>" : ""

					// The result before keeps its properties; the new one has them only under MERGEFORMAT.
					expect(pending).toMatch(
						new RegExp(
							`<w:del [^>]*><w:r><w:rPr><w:b/></w:rPr><w:delText>9</w:delText></w:r></w:del><w:ins [^>]*><w:r>${fresh}<w:t>1</w:t></w:r></w:ins>`
						)
					)

					const target = reopen ? await open(await save(opened)) : opened

					expect(await target.editor.execute({ type: accept ? "review.acceptAll" : "review.rejectAll" })).toBe(true)
					expect(await read(await save(target))).toContain(
						accept
							? `<w:r>${fresh}<w:t>1</w:t></w:r></w:fldSimple>`
							: "<w:r><w:rPr><w:b/></w:rPr><w:t>9</w:t></w:r></w:fldSimple>"
					)
				}
	})

	it("types and formats without walking the document for fields no run can format", async () => {
		const opened = await open({
			body: Array.from(
				{ length: 200 },
				() =>
					'<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve"> of text</w:t></w:r></w:p>'
			).join("")
		})
		const editor = opened.editor
		const session = editor.session
		const word = (): number => session.state.doc.content.size - 1 - "text".length

		select(editor, word(), word() + "text".length)
		expect(editor.execute({ type: "format.bold" })).toBe(true)

		const checked = vi.spyOn(fieldFormat, "holdsFormatting")

		for (const char of "typed") session.dispatch(session.state.tr.insertText(char, 2))

		select(editor, word(), word() + "text".length)
		expect(editor.execute({ type: "format.italic" })).toBe(true)
		expect(checked.mock.calls.length).toBeLessThan(10)
		checked.mockRestore()
	})

	it("keeps a w:fldSimple without a result, or a copy of one, unformatted through undo, redo, raw marks and paste", async () => {
		const opened = await open({
			body: '<w:p><w:r><w:t xml:space="preserve">Alpha </w:t></w:r><w:fldSimple w:instr=" NUMPAGES "/><w:r><w:t xml:space="preserve"> end</w:t></w:r></w:p>'
		})
		const editor = opened.editor
		const session = editor.session
		const original = session.state.doc
		const marked = (): string[] => fieldsOf(session.state.doc).flatMap(field => field.node.marks.map(mark => mark.type.name))
		const all = (): void => select(editor, 1, session.state.doc.content.size - 1)

		// Bold, undone: the document as it was (the text unbolded too), redone: bold but the field.
		all()
		expect(editor.execute({ type: "format.bold" })).toBe(true)
		expect(marked()).toEqual([])
		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		expect(session.state.doc.eq(original)).toBe(true)
		expect(await editor.execute({ type: "history.redo" })).toBe(true)
		expect(marked()).toEqual([])
		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		expect(session.state.doc.eq(original)).toBe(true)

		// A raw mark, and a copy pasted at the end, formatted with what holds it.
		session.dispatch(
			session.state.tr.addMark(1, session.state.doc.content.size - 1, docxSchema.marks.italic.create({ value: true, cs: true }))
		)
		expect(marked()).toEqual([])

		const at = session.state.doc.content.size - 1

		session.dispatch(session.state.tr.insert(at, original.slice(6, 9).content))
		expect(fieldsOf(session.state.doc)).toHaveLength(2)
		all()
		expect(editor.execute({ type: "format.underline" })).toBe(true)
		expect(marked()).toEqual([])
		expect(await refusal(opened)).toBeUndefined()
	})

	it("looks at no field on the first tracked keystrokes and Bold, nor follows formatting states over a tracked deletion of everything or its undo", async () => {
		const opened = await open({
			body: Array.from(
				{ length: 200 },
				() =>
					'<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve"> of text</w:t></w:r></w:p>'
			).join("")
		})
		const editor = opened.editor
		const session = editor.session
		const checked = vi.spyOn(fieldFormat, "holdsFormatting")

		opened.context.identity.author = "Ann Lee"
		opened.context.review.tracking = true

		for (const char of "typed") session.dispatch(session.state.tr.insertText(char, 2))

		const word = session.state.doc.content.size - 1 - "text".length

		select(editor, word, word + "text".length)
		expect(editor.execute({ type: "format.bold" })).toBe(true)
		expect(checked.mock.calls.length).toBeLessThan(10)
		select(editor, 1, session.state.doc.content.size - 1)

		// (Following formatting states maps positions back through a transaction.)
		const followed = vi.spyOn(Mapping.prototype, "invert")

		session.dispatch(session.state.tr.deleteSelection())
		expect(await editor.execute({ type: "history.undo" })).toBe(true)
		expect(followed).not.toHaveBeenCalled()
		followed.mockRestore()
		checked.mockRestore()
	})

	it("formats the rest of a selection holding a w:fldSimple without a result", async () => {
		const opened = await open({
			body: '<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr=" PAGE "/><w:r><w:t xml:space="preserve"> end</w:t></w:r></w:p>'
		})
		const session = opened.editor.session

		for (const command of [{ type: "font.size", halfPoints: 28 }, { type: "format.bold" }] as const) {
			select(opened.editor, 1, session.state.doc.content.size - 1)
			expect(opened.editor.execute(command)).toBe(true)
			expect(fieldsOf(session.state.doc)[0]?.node.marks).toEqual([])
		}

		expect(await refusal(opened)).toBeUndefined()
	})

	it("formats a w:fldSimple's result runs, until an update without MERGEFORMAT writes its result anew (§17.16.4.3)", async () => {
		const simple = (instr: string, content: string): string =>
			`<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr="${instr}">${content}</w:fldSimple><w:r><w:t xml:space="preserve"> end</w:t></w:r></w:p>`
		const result = '<w:r><w:rPr><w:sz w:val="28"/></w:rPr><w:t>9</w:t></w:r>'

		for (const [instr, kept] of [
			[" PAGE ", false],
			[" PAGE \\* MERGEFORMAT ", true]
		] as const) {
			const opened = await open({ body: simple(instr, result) })
			const editor = opened.editor
			const session = editor.session

			// The atom shows the result's formatting; bold reaches the result run.
			expect(fieldsOf(session.state.doc)[0]?.node.marks.map(mark => mark.type.name)).toEqual(["size"])
			select(editor, 1, session.state.doc.content.size - 1)
			expect(editor.execute({ type: "format.bold" })).toBe(true)
			expect(await read(await save(opened))).toContain(
				'<w:r><w:rPr><w:b/><w:bCs/><w:sz w:val="28"/></w:rPr><w:t>9</w:t></w:r></w:fldSimple>'
			)

			// Updated: without MERGEFORMAT the new result has no properties, and the atom none either.
			expect(await editor.execute({ type: "field.updateAll" })).toBe(true)
			expect(fieldsOf(session.state.doc)[0]?.node.marks.length).toBe(kept ? 2 : 0)
			expect(await read(await save(opened))).toContain(
				kept
					? '<w:r><w:rPr><w:b/><w:bCs/><w:sz w:val="28"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>'
					: "<w:r><w:t>1</w:t></w:r></w:fldSimple>"
			)
		}

		// A w:fldSimple without a result has no run to hold formatting: formatting given it goes.
		const empty = await open({ body: simple(" PAGE ", "") })
		const session = empty.editor.session
		const at = fieldsOf(session.state.doc)[0]?.pos ?? 0

		expect(session.dispatch(session.state.tr.addMark(at, at + 1, docxSchema.marks.bold.create({ value: true })))).toBe(true)
		expect(fieldsOf(session.state.doc)[0]?.node.marks).toEqual([])
		expect(await refusal(empty)).toBeUndefined()
	})
})

describe("field hits", () => {
	it("finds a field under a press, and a table of contents whole for its Update Table control", async () => {
		const opened = await open({
			body:
				'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r>' +
				'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Entry one</w:t></w:r></w:p>' +
				'<w:p><w:r><w:t>Entry two</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
				`<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r>${complex(" PAGE ", "1")}<w:r><w:t xml:space="preserve"> of the text</w:t></w:r></w:p>`
		})
		const editor = opened.editor
		const doc = editor.session.state.doc
		const center = (from: number, to: number): [number, number] => {
			const rect = editor.rangeRects(from, to, 0)[0]

			return [(rect?.x ?? 0) + (rect?.width ?? 0) / 2, (rect?.y ?? 0) + (rect?.height ?? 0) / 2]
		}
		const [field] = fieldsOf(doc)
		const at = field?.pos ?? 0

		expect(hitObject(editor, 0, ...center(at, at + 1))).toMatchObject({ kind: "field", pos: at, story: editor.activeStory })

		const entry = find(doc, "Entry two")
		const toc = hitObject(editor, 0, ...center(entry, entry + 5))

		expect(toc).toMatchObject({ kind: "field", part: "toc", pos: 0 })
		// The box holds both entries' lines.
		expect(toc?.box?.height ?? 0).toBeGreaterThan(20)
		expect(hitObject(editor, 0, ...center(find(doc, "of the text") + 3, find(doc, "of the text") + 6))).toBeUndefined()
	})
})

describe("bookmarks", () => {
	it("adds, moves, renames and deletes bookmarks, keeping names unique", async () => {
		const opened = await open({
			body: '<w:p><w:bookmarkStart w:id="0" w:name="Kept"/><w:r><w:t>Alpha beta gamma</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>'
		})
		const editor = opened.editor
		const session = editor.session
		const ranges = (): string[] =>
			sessionBookmarks(session).list.map(bookmark => `${bookmark.name}:${session.state.doc.textBetween(bookmark.from, bookmark.to)}`)
		const beta = find(session.state.doc, "beta")

		select(editor, beta, beta + 4)
		expect(editor.execute({ type: "bookmark.add", name: "Beta" })).toBe(true)
		expect(ranges()).toEqual(["Kept:Alpha beta gamma", "Beta:beta"])

		// Word's Add with a name the document has moves that bookmark.
		const gamma = find(session.state.doc, "gamma")

		select(editor, gamma, gamma + 5)
		expect(editor.execute({ type: "bookmark.add", name: "kept" })).toBe(true)
		expect(ranges()).toEqual(["Beta:beta", "Kept:gamma"])
		expect(editor.execute({ type: "bookmark.rename", name: "Beta", to: "Delta" })).toBe(true)
		expect(editor.execute({ type: "bookmark.rename", name: "Delta", to: "Kept" })).toBe(false)

		let xml = await read(await save(opened))

		expect(xml).toMatch(/<w:bookmarkStart w:id="1" w:name="Delta"\/><w:r><w:t>beta<\/w:t><\/w:r><w:bookmarkEnd w:id="1"\/>/)
		expect(xml).toMatch(/<w:bookmarkStart w:id="0" w:name="Kept"\/><w:r><w:t>gamma<\/w:t><\/w:r><w:bookmarkEnd w:id="0"\/>/)
		expect(editor.execute({ type: "bookmark.delete", name: "Kept" })).toBe(true)
		xml = await read(await save(opened))
		expect(xml).not.toContain("Kept")
		expect(xml).toContain('w:name="Delta"')
	})
})

describe("snapshot", () => {
	it("tells the field at the caret, the same object while it is the same field", async () => {
		const opened = await open({
			body: `<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r>${complex(" PAGE ", "1")}<w:r><w:t xml:space="preserve"> and </w:t></w:r>${complex(" HYPERLINK \\l x ", "link")}</w:p>`
		})
		const editor = opened.editor
		const field = fieldsOf(editor.session.state.doc)

		select(editor, field[0]?.pos ?? 0)

		const first = editor.snapshot().context.field

		expect(first).toEqual({ type: "PAGE", updatable: true, toc: false, instruction: " PAGE ", refusal: null })
		select(editor, (field[0]?.pos ?? 0) + 1)
		// Right after the field: the same one.
		expect(editor.snapshot().context.field).toBe(first)
		select(editor, (field[1]?.pos ?? 0) + 1)
		expect(editor.snapshot().context.field).toEqual({
			type: "HYPERLINK",
			updatable: false,
			toc: false,
			instruction: " HYPERLINK \\l x ",
			refusal: null
		})
		select(editor, 2)
		expect(editor.snapshot().context.field).toBeNull()
	})

	it("tells why a table of contents kept as the file's locked blocks cannot be updated", async () => {
		const begin =
			'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
		const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
		// A field inside it spanning two of its paragraphs: the table stays locked blocks.
		const spanning =
			`<w:p>${begin}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> QUOTE "x" </w:instrText></w:r>` +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>One</w:t></w:r></w:p>' +
			`<w:p><w:r><w:t>Two</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>${end}</w:p>`
		const table =
			`<w:p>${begin}<w:r><w:t>One</w:t></w:r></w:p><w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>${p("Cell")}</w:tc></w:tr></w:tbl>` +
			`<w:p><w:r><w:t>Two</w:t></w:r>${end}</w:p>`
		const cases = [
			{ body: spanning, untracked: null, tracked: "trackedLockedTable" },
			{ body: spanning.replace('TOC \\o "1-3"', "TOC \\f"), untracked: "unsupportedTable", tracked: "unsupportedTable" },
			{ body: table, untracked: "tableWithOtherContent", tracked: "tableWithOtherContent" }
		] as const

		for (const entry of cases) {
			const opened = await open({ body: entry.body + p("Heading", '<w:outlineLvl w:val="0"/>') })
			const editor = opened.editor

			opened.context.identity.author = "Ann Lee"
			select(editor, 0)
			expect(editor.session.state.doc.child(0).type).toBe(nodes.locked_block)

			const untracked = editor.snapshot().context.field

			expect(untracked).toMatchObject({ type: "TOC", toc: true, updatable: entry.untracked === null, refusal: entry.untracked })
			opened.context.review.tracking = true
			editor.session.dispatch(editor.session.state.tr)
			expect(editor.snapshot().context.field).toMatchObject({ updatable: false, refusal: entry.tracked })
			expect(await editor.execute({ type: "toc.update", pagesOnly: false })).toBe(false)
			opened.context.review.tracking = false
			editor.session.dispatch(editor.session.state.tr)
			expect(editor.snapshot().context.field).toBe(untracked)
			expect(await editor.execute({ type: "toc.update", pagesOnly: false })).toBe(entry.untracked === null)
		}
	})
})

describe("update field and tables of contents", () => {
	it("updates page numbers only around a table of contents of the file kept as locked blocks, the table as it is", async () => {
		const begin =
			'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
		// A field inside it spanning two of its paragraphs: the table stays locked blocks.
		const toc =
			`<w:p>${begin}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> QUOTE "x" </w:instrText></w:r>` +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Stale entry</w:t></w:r></w:p>' +
			'<w:p><w:r><w:t>Two</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		const opened = await open({ body: toc + p("Heading", '<w:outlineLvl w:val="0"/>') + `<w:p>${complex(" PAGE ", "7")}</w:p>` })
		const editor = opened.editor
		const locked = editor.session.state.doc.child(0)

		expect(locked.type).toBe(nodes.locked_block)

		for (const command of [{ type: "field.updateAll" }, { type: "field.update" }, { type: "toc.update", pagesOnly: true }] as const) {
			select(editor, command.type === "field.updateAll" ? 1 : 0)
			expect(await editor.execute(command)).toBe(true)
			expect(editor.session.state.doc.child(0)).toBe(locked)
		}

		expect(fields(editor.session.state.doc)).toEqual(["PAGE=1"])
		expect(await read(await save(opened))).toContain("Stale entry")
	})
})

describe("field codes kept in their paragraph", () => {
	it("keeps a table's code in one paragraph when paragraphs are pasted inside it", async () => {
		const toc =
			'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r>' +
			'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Entry</w:t></w:r></w:p>' +
			'<w:p><w:r><w:t>Two</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'

		for (const typed of ["", "x"]) {
			const opened = await open({ body: toc + p("Alpha") + p("Beta") })
			const session = opened.editor.session
			let begin = -1

			session.state.doc.descendants((node, pos) => {
				if (node.type === nodes.field_char && node.attrs["kind"] === "begin") begin = pos

				return begin < 0
			})
			expect(begin).toBeGreaterThanOrEqual(0)

			// Text inside the code (a form typed into it), then two paragraphs' pieces pasted after it.
			if (typed !== "") session.dispatch(session.state.tr.insertText(typed, begin + 1))

			const alpha = find(session.state.doc, "Alpha")

			session.dispatch(
				session.state.tr.replace(begin + 1 + typed.length, begin + 1 + typed.length, session.state.doc.slice(alpha + 2, alpha + 10))
			)

			// Every character of the code in one paragraph.
			let codes = 0

			session.state.doc.descendants(node => {
				if (node.type !== nodes.paragraph) return true

				const kinds: string[] = []

				node.forEach(child => {
					if (child.type === nodes.field_char) kinds.push(child.attrs["kind"] as string)
				})

				if (kinds.includes("begin")) {
					codes++
					expect(kinds.slice(0, 3)).toEqual(["begin", "instruction", "separate"])
				}

				return false
			})
			expect(codes).toBe(1)
			expect(await refusal(opened)).toBeUndefined()
		}
	})
})

describe("field characters kept with their partners", () => {
	it("takes a whole table of contents out when Reject takes its end character's insertion, its bookmark kept", async () => {
		const opened = await open({ body: p("Heading", '<w:outlineLvl w:val="0"/>') + p("Text") })
		const editor = opened.editor
		const session = editor.session

		opened.context.identity.author = "Ann Lee"
		opened.context.review.tracking = true
		select(editor, 1)
		expect(await editor.execute({ type: "toc.insert", levels: 3, hyperlinks: true })).toBe(true)
		await settleAll(editor)

		const chars = (): { kind: string; pos: number }[] => {
			const out: { kind: string; pos: number }[] = []

			session.state.doc.descendants((node, pos) => {
				if (node.type === nodes.field_char) out.push({ kind: node.attrs["kind"] as string, pos })

				return true
			})

			return out
		}
		const begin = chars().find(char => char.kind === "begin")?.pos ?? -1
		const end = chars().find(char => char.kind === "end")?.pos ?? -1

		expect(begin).toBeGreaterThanOrEqual(0)
		expect(end).toBeGreaterThan(begin)
		opened.context.review.tracking = false
		select(editor, find(session.state.doc, "Heading") + 1)
		expect(find(session.state.doc, "Heading")).toBeLessThan(end)
		expect(editor.execute({ type: "bookmark.add", name: "Inside" })).toBe(true)

		const at = chars().find(char => char.kind === "end")?.pos ?? -1

		select(editor, at, at + 1)
		expect(await editor.execute({ type: "review.reject" })).toBe(true)
		expect(chars()).toEqual([])
		expect(sessionBookmarks(session).list.map(bookmark => bookmark.name)).toContain("Inside")
		expect(await refusal(opened)).toBeUndefined()
	})
})

describe("gate 2", () => {
	it("refuses field characters without partners and duplicate bookmark names", async () => {
		const cases: { readonly label: string; readonly node: () => ProseMirrorNode; readonly reason: string }[] = [
			{ label: "stray begin", node: () => nodes.field_char.create({ kind: "begin", instruction: " TOC " }), reason: "content" },
			{
				label: "duplicate name",
				node: () => nodes.marker.create({ kind: "bookmarkStart", id: "77", name: "Kept" }),
				reason: "duplicateId"
			}
		]

		for (const entry of cases) {
			const opened = await open({
				body: '<w:p><w:bookmarkStart w:id="0" w:name="Kept"/><w:r><w:t>Alpha</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>'
			})
			const session = opened.editor.session
			const tr = session.state.tr.insert(find(session.state.doc, "Alpha") + 2, entry.node())

			if (entry.label === "duplicate name") tr.insert(tr.doc.content.size - 1, nodes.marker.create({ kind: "bookmarkEnd", id: "77" }))

			session.dispatch(markInternal(tr))
			expect(await refusal(opened), entry.label).toBe(entry.reason)
		}
	})

	it("refuses a save whose writer dropped a kept field's w:dirty", async () => {
		const opened = await open({
			body: `<w:p>${complex(" PAGE ", "1", "", { dirty: true })}<w:r><w:t xml:space="preserve"> x</w:t></w:r></w:p>`
		})
		const session = opened.editor.session
		const at = find(session.state.doc, " x")

		session.dispatch(session.state.tr.insertText("y", at + 2))

		expect(await refusal(opened)).toBeUndefined()

		// The same save with the flag taken out of the written markup, as SuperDoc's writer does.
		const [check] = fieldChecks
		const changes = await serializeDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })
		const story = changes.stories[0]

		if (story === undefined || check?.part === undefined || check.done === undefined) throw new Error("No story written")

		const bytes = story.output.bytes
		const joined = new Uint8Array(bytes.length)

		if (bytes instanceof Uint8Array) joined.set(bytes)
		else
			bytes.visit(0, bytes.length, (piece, from, count, at) => {
				joined.set(piece.subarray(from, from + count), at)

				return true
			})

		const markup = decoder.decode(joined)
		const input = {
			original: opened.pkg,
			context: opened.context,
			changes,
			ids: () => 1,
			added: () => []
		} as unknown as CheckInput

		await check.part(input, {
			name: "word/document.xml",
			part: story.part,
			document: parseXml(encoder.encode(`<w:body ${NAMESPACES}>${markup.replace(' w:dirty="true"', "")}</w:body>`)),
			skeleton: true
		})
		await expect(Promise.resolve().then(() => check.done?.(input))).rejects.toThrow("w:dirty")
	})
})
