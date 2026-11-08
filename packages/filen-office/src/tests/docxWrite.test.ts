import { Fragment } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { unzipSync, zipSync } from "fflate"
import { describe, expect, it, vi } from "vitest"
import {
	bytesSource,
	crc32,
	joinBytes,
	memorySink,
	OpcPackage,
	partKey,
	planZip,
	writeZip,
	type PartBytes,
	type PartChange
} from "@filen/office/core/opc"
import { encodeUtf8, parseXml } from "@filen/office/core/xml"
import { parseRunProps, PropsReader } from "@filen/office/core/docx"
import { DocxEditorSession, docxSchema, formattingMarks, proveBlocks } from "@filen/office/core/docx/edit"
import {
	Names,
	Out,
	PARAGRAPH_PROPERTIES,
	RUN_PROPERTIES,
	PROPERTY_MARKS,
	elementsOf,
	saveDocx,
	paragraphSignature,
	serializeDocx,
	StoryWriter,
	verifyDocxParts,
	verifyDocxZip,
	writeRunProperties,
	writerProof
} from "@filen/office/core/docx/write"
import { elementOrder } from "../scripts/wmlOrder"
import { NUMBERING_PART, RICH, STYLES_PART, openBytes, type Opened } from "./docxEditFixtures"
import { buildDocx, p, type SyntheticDocx } from "./docxSynthetic"
import { ZIP_ENTRY_TIME } from "./zipTime"

const decoder = new TextDecoder()

async function read(bytes: Uint8Array, name: string): Promise<string> {
	return decoder.decode(await (await OpcPackage.open(bytesSource(bytes))).read(name))
}

async function opened(spec: SyntheticDocx): Promise<Opened & { bytes: Uint8Array }> {
	const bytes = buildDocx(spec)

	return { ...(await openBytes(bytes)), bytes }
}

function session(document: Opened, proved: boolean = true): DocxEditorSession {
	return new DocxEditorSession(document.context, { proof: proved ? writerProof(document.context) : null })
}

async function save(document: Opened, ...edits: DocxEditorSession[]): Promise<{ bytes: Uint8Array; changedParts: readonly string[] }> {
	const result = await saveDocx({ pkg: document.pkg, context: document.context, sessions: edits })

	if (result.bytes === undefined) throw new Error("No bytes")

	return { bytes: result.bytes, changedParts: result.changedParts }
}

function select(edit: DocxEditorSession, from: number, to: number = from): void {
	edit.dispatch(edit.state.tr.setSelection(TextSelection.create(edit.state.doc, from, to)))
}

function body(xml: string): string {
	return xml.slice(xml.indexOf("<w:body>") + 8, xml.lastIndexOf("</w:body>"))
}

const PARTS = {
	parts: [
		STYLES_PART(
			'<w:style w:type="paragraph" w:default="1" w:styleId="Standard"><w:name w:val="Normal"/></w:style>' +
				'<w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/><w:basedOn w:val="Standard"/></w:style>'
		),
		NUMBERING_PART(
			'<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>' +
				'<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
				'<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
		)
	],
	relationships: [
		{ id: "rIdS", type: "styles", target: "styles.xml" },
		{ id: "rIdN", type: "numbering", target: "numbering.xml" }
	]
}

const TWO_RUNS =
	'<w:p w:rsidR="00A1" w14:paraId="11111111" w14:textId="77777777"><w:pPr><w:jc w:val="left"/></w:pPr>' +
	'<w:r w:rsidR="00B2"><w:rPr><w:i/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">first run </w:t></w:r>' +
	'<w:r w:rsidR="00C3"><w:t>second</w:t></w:r></w:p>'

describe("docx writer: run properties", () => {
	const names = new Names("w", "r")

	it("lists the property containers in the schema's child order", () => {
		expect(RUN_PROPERTIES.slice(0, 5)).toEqual(["rStyle", "rFonts", "b", "bCs", "i"])
		expect(RUN_PROPERTIES.at(-1)).toBe("rPrChange")
		expect(PARAGRAPH_PROPERTIES.indexOf("numPr")).toBeLessThan(PARAGRAPH_PROPERTIES.indexOf("jc"))
		expect(PARAGRAPH_PROPERTIES.slice(-3)).toEqual(["rPr", "sectPr", "pPrChange"])
		// The generator flattens groups and extension bases.
		const schema = parseXml(
			encodeUtf8(
				'<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"><xsd:group name="G"><xsd:choice><xsd:element name="b"/><xsd:element name="c"/></xsd:choice></xsd:group>' +
					'<xsd:complexType name="Base"><xsd:sequence><xsd:element name="a"/></xsd:sequence></xsd:complexType>' +
					'<xsd:complexType name="T"><xsd:complexContent><xsd:extension base="Base"><xsd:sequence><xsd:group ref="G"/><xsd:element name="d"/></xsd:sequence></xsd:extension></xsd:complexContent></xsd:complexType></xsd:schema>'
			)
		)

		expect(elementOrder(schema, "T")).toEqual(["a", "b", "c", "d"])
	})

	it("writes every property mark so that it reads back as the same mark", () => {
		const props = {
			styleId: "Strong",
			fonts: { ascii: "Arial", hAnsi: "Arial", csTheme: "minorBidi" as const },
			bold: true,
			boldCs: false,
			italic: false,
			strike: true,
			doubleStrike: false,
			caps: true,
			smallCaps: false,
			vertAlign: "superscript" as const,
			color: { val: "1F3864", themeColor: "accent1" as const, themeShade: 128 },
			highlight: "yellow",
			shading: { pattern: "clear", color: { val: "auto" }, fill: { val: "DDDDDD" } },
			size: 28,
			sizeCs: 30,
			spacing: -10,
			lang: { latin: "de-DE", bidi: "ar-SA" },
			underline: { style: "double", val: "FF0000" },
			noProof: true,
			webHidden: false
		}
		const marks = formattingMarks(props)
		const out = new Out()

		writeRunProperties(out, names, marks, undefined)

		const markup = decoder.decode(out.finish())
		const document = parseXml(
			encodeUtf8(`<w:rPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${markup.slice(7, -8)}</w:rPr>`)
		)
		const reread = formattingMarks(parseRunProps(PropsReader.for(document), document.documentElement()))

		expect(reread.map(mark => [mark.type.name, mark.attrs])).toEqual(marks.map(mark => [mark.type.name, mark.attrs]))

		// Children come out in schema order.
		const locals: string[] = []

		for (let child = document.firstChildElement(document.documentElement()); child >= 0; child = document.nextSiblingElement(child)) {
			locals.push(document.localName(child))
		}

		expect(locals).toEqual([...locals].sort((a, b) => RUN_PROPERTIES.indexOf(a) - RUN_PROPERTIES.indexOf(b)))
		expect(PROPERTY_MARKS.length).toBe(18)
		expect(elementsOf(names, docxSchema.marks.bold, undefined)).toEqual(
			new Map([
				["b", ""],
				["bCs", ""]
			])
		)
	})
})

describe("docx writer", () => {
	it("writes an unedited document back byte for byte", async () => {
		const document = await opened({ ...RICH, ...PARTS })
		const result = await save(document, session(document))

		expect(result.changedParts).toEqual([])
		expect(result.bytes).toEqual(document.bytes)
	})

	it("proves every block of a rich document and locks what cannot be reproduced", async () => {
		const document = await opened({
			body: RICH.body + "<w:p><w:r><w:t>a</w:t></w:r><w:sdt><w:sdtPr/><w:sdtContent></w:sdtContent></w:sdt></w:p>",
			relationships: RICH.relationships
		})
		const edit = session(document, false)
		const requests = proveBlocks(edit.story, edit.state.doc, writerProof(document.context))

		expect(requests.map(request => request.reason)).toEqual(["proof"])
		expect(edit.state.doc.nodeAt(requests[0]?.pos ?? 0)?.textContent).toBe("a")
	})

	it("rewrites only the edited run and keeps the rest of the part as it was", async () => {
		const document = await opened({ body: TWO_RUNS + p("untouched"), ...PARTS })
		const edit = session(document)

		edit.dispatch(edit.state.tr.insertText("my ", 7))

		const result = await save(document, edit)
		const xml = await read(result.bytes, "word/document.xml")
		const original = await read(document.bytes, "word/document.xml")

		expect(result.changedParts).toEqual(["word/document.xml"])
		// The edited run keeps its start tag and properties; the other run and paragraph are their bytes.
		// The rebuilt paragraph drops w14:textId (a hash of its text) and keeps w14:paraId.
		expect(body(xml)).toBe(
			body(original)
				.replace(' w14:textId="77777777"', "")
				.replace('<w:t xml:space="preserve">first run </w:t>', '<w:t xml:space="preserve">first my run </w:t>')
		)
		// Everything outside w:body is untouched.
		expect(xml.slice(0, xml.indexOf("<w:body>"))).toBe(original.slice(0, original.indexOf("<w:body>")))
	})

	it("splices a toggled property into the run's own properties and clears formatting to the language", async () => {
		const document = await opened({ body: TWO_RUNS, ...PARTS })
		const edit = session(document)

		select(edit, 1, 6)
		edit.execute({ type: "format.bold" })

		let xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml).toContain('<w:r w:rsidR="00B2"><w:rPr><w:b/><w:bCs/><w:i/><w:sz w:val="24"/></w:rPr><w:t>first</w:t></w:r>')
		expect(xml).toContain('<w:r><w:rPr><w:i/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve"> run </w:t></w:r>')

		select(edit, 1, 11)
		edit.execute({ type: "format.clear" })
		xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))
		expect(xml).toContain('<w:r w:rsidR="00B2"><w:t xml:space="preserve">first run </w:t></w:r>')
	})

	it("adds a missing heading style with Word's definition and a new list with its numbering", async () => {
		const document = await opened({ body: p("one") + p("two") + p("three"), ...PARTS })
		const edit = session(document)

		select(edit, 2)
		edit.execute({ type: "style.set", style: "heading2" })
		select(edit, 7)
		edit.execute({ type: "list.numbered" })

		const result = await save(document, edit)
		const styles = await read(result.bytes, "word/styles.xml")
		const numbering = await read(result.bytes, "word/numbering.xml")
		const xml = await read(result.bytes, "word/document.xml")

		expect([...result.changedParts].sort()).toEqual(["word/document.xml", "word/numbering.xml", "word/styles.xml"])
		expect(styles).toContain(
			'<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Standard"/>'
		)
		expect(styles).toContain('<w:outlineLvl w:val="1"/>')
		expect(xml).toContain('<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>')
		// A numbered list restarts on the document's numbered definition: a new w:num after the others.
		expect(numbering).toContain(
			'<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>'
		)
		// The Normal paragraph made a list item takes List Paragraph, as in Word.
		expect(xml).toContain('<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr>')
		expect(styles).toContain(
			'<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Standard"/>'
		)
	})

	it("copies a paragraph out of any list with the level the file gives it (numId 0, level past 8)", async () => {
		const removed = '<w:numPr><w:ilvl w:val="12"/><w:numId w:val="0"/></w:numPr>'
		const document = await opened({ body: p("Notice", removed) + p("two") })
		const edit = session(document)
		const doc = edit.state.doc
		const copy = doc.child(0)

		edit.dispatch(edit.state.tr.insert(doc.content.size, copy.type.create(copy.attrs, copy.content, copy.marks)))

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml.split('<w:numPr><w:ilvl w:val="12"/><w:numId w:val="0"/></w:numPr>').length).toBe(3)
	})

	it("creates numbering and styles parts when the document has none", async () => {
		const document = await opened({ body: p("one") + p("two") })
		const edit = session(document)

		select(edit, 2)
		edit.execute({ type: "list.bullet" })
		edit.execute({ type: "style.set", style: "title" })

		const result = await save(document, edit)
		const written = await OpcPackage.open(bytesSource(result.bytes))
		const relationships = await written.relationships("word/document.xml")

		expect([...result.changedParts].sort()).toEqual(
			["[Content_Types].xml", "word/_rels/document.xml.rels", "word/numbering.xml", "word/styles.xml"]
				.concat("word/document.xml")
				.sort()
		)
		expect(
			relationships.all
				.map(relationship => relationship.target)
				.filter(target => target === "numbering.xml" || target === "styles.xml")
				.sort()
		).toEqual(["numbering.xml", "styles.xml"])
		expect((await written.contentTypes()).typeOf("word/numbering.xml")).toBe(
			"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"
		)
		expect(await read(result.bytes, "word/numbering.xml")).toContain(
			'<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>'
		)
	})

	it("adds a relationship for a new hyperlink", async () => {
		const document = await opened({ body: p("click here"), ...PARTS })
		const edit = session(document)

		edit.dispatch(edit.state.tr.addMark(1, 6, docxSchema.marks.link.create({ target: "https://filen.io/" })))

		const result = await save(document, edit)
		const xml = await read(result.bytes, "word/document.xml")
		const relationships = await (await OpcPackage.open(bytesSource(result.bytes))).relationships("word/document.xml")
		const link = relationships.all.find(relationship => relationship.target === "https://filen.io/")

		expect(link?.external).toBe(true)
		expect(xml).toContain(`<w:hyperlink r:id="${link?.id}"><w:r><w:t>click</w:t></w:r></w:hyperlink>`)
	})

	it("writes a split paragraph's second half without the paragraph id and moves the section break with it", async () => {
		const document = await opened({
			body:
				'<w:p w14:paraId="12345678"><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr><w:r><w:t>end of section</w:t></w:r></w:p>' +
				p("after"),
			...PARTS
		})
		const edit = session(document)

		edit.dispatch(edit.state.tr.split(4))

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml).toMatch(/^<w:p w14:paraId="12345678"><w:r><w:t>end<\/w:t><\/w:r><\/w:p><w:p><w:pPr><w:sectPr>/)
		expect(xml.match(/w14:paraId="12345678"/g)?.length).toBe(1)
		expect(xml.match(/<w:sectPr>/g)?.length).toBe(1)
	})

	it("gives a revision split by new text a new id", async () => {
		const document = await opened({
			body: '<w:p><w:ins w:id="7" w:author="Ann"><w:r><w:t>inserted</w:t></w:r></w:ins></w:p>',
			...PARTS
		})
		const edit = session(document)

		edit.dispatch(edit.state.tr.setSelection(TextSelection.create(edit.state.doc, 4)).insertText("NEW"))

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml).toContain('<w:ins w:id="7" w:author="Ann">')
		expect(xml).toMatch(/<w:ins w:id="8" w:author="Ann">/)
		expect(xml).toContain("NEW")
	})

	it("gives a tracked formatting change written as several runs new ids", async () => {
		const document = await opened({
			body: '<w:p><w:r><w:rPr><w:i/><w:rPrChange w:id="4" w:author="Ann"><w:rPr/></w:rPrChange></w:rPr><w:t>one two three</w:t></w:r></w:p>',
			...PARTS
		})
		const edit = session(document)

		select(edit, 5, 8)
		edit.execute({ type: "format.bold" })

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml.match(/<w:rPrChange w:id="\d+"/g)).toEqual(['<w:rPrChange w:id="4"', '<w:rPrChange w:id="5"', '<w:rPrChange w:id="6"'])
	})

	it("keeps a macro-enabled document's content types and refuses view-only documents", async () => {
		const docm = await opened({
			body: p("macro text"),
			mainContentType: "application/vnd.ms-word.document.macroEnabled.main+xml",
			...PARTS
		})
		const edit = session(docm)

		edit.dispatch(edit.state.tr.insertText("x", 2))

		const result = await save(docm, edit)

		expect(await read(result.bytes, "[Content_Types].xml")).toBe(await read(docm.bytes, "[Content_Types].xml"))

		// A template is saved as one.
		const template = await opened({
			body: p("template"),
			mainContentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml"
		})
		const templateEdit = session(template)

		templateEdit.dispatch(templateEdit.state.tr.insertText("x", 2))
		expect(await read((await save(template, templateEdit)).bytes, "[Content_Types].xml")).toBe(
			await read(template.bytes, "[Content_Types].xml")
		)

		// A document protected against editing is not.
		const protectedDocument = await opened({
			body: p("protected"),
			settings: '<w:documentProtection w:edit="readOnly" w:enforcement="1"/>'
		})

		await expect(save(protectedDocument, session(protectedDocument))).rejects.toMatchObject({ reason: "readOnly" })

		// A read-only session is not written.
		const host = await opened({ body: p("text") })
		const hosted = new DocxEditorSession(host.context, { readOnly: true })

		hosted.dispatch(hosted.state.tr.insertText("x", 2))
		expect((await save(host, hosted)).changedParts).toEqual([])
	})
})

// Gate 2 on files that were changed after writing (the rest of each file is the original, entries raw).
describe("docx save verifier", () => {
	async function tampered(
		change: (xml: string) => PartChange[],
		changedParts: readonly string[] = ["word/document.xml"]
	): Promise<unknown> {
		const document = await opened({
			body: '<w:p w14:paraId="0000AAAA"><w:pPr><w:pStyle w:val="Standard"/></w:pPr><w:r><w:t>text</w:t></w:r></w:p>',
			...PARTS
		})
		const xml = await read(document.bytes, "word/document.xml")
		const declared = new Set(changedParts.map(partKey))
		const all = change(xml)
		const parts = all.filter(part => declared.has(partKey(part.name)))
		const changes = {
			replace: parts.filter(part => document.pkg.has(part.name)),
			add: parts.filter(part => !document.pkg.has(part.name)),
			numIds: new Map<number, number>(),
			stories: [],
			removed: [],
			roots: new Map()
		}
		// The zip may hold more than was declared (an entry changed behind the writer's back).
		const plan = planZip(document.pkg.opc.zip, {
			replace: all.filter(part => document.pkg.has(part.name)),
			add: all.filter(part => !document.pkg.has(part.name))
		})
		const sink = memorySink()

		await writeZip(plan, document.pkg.opc.zip, sink)

		try {
			await verifyDocxParts({ original: document.pkg, context: document.context, changes })
			await verifyDocxZip(document.pkg, bytesSource(sink.bytes()), {
				crcs: new Map(await Promise.all(parts.map(async part => [partKey(part.name), crc32(await joinBytes(part.bytes))] as const)))
			})

			return undefined
		} catch (error) {
			return (error as { reason?: unknown }).reason
		}
	}
	const documentXml = (xml: string): PartChange[] => [{ name: "word/document.xml", bytes: encodeUtf8(xml) }]

	it("accepts a document whose changed part is sound", async () => {
		expect(await tampered(xml => documentXml(xml.replace(">text<", ">other<")))).toBeUndefined()
	})

	it("refuses a changed entry that should have been copied", async () => {
		expect(await tampered(() => [{ name: "word/styles.xml", bytes: encodeUtf8("<x/>") }], [])).toBe("untouchedChanged")
	})

	it("refuses malformed markup and undeclared prefixes", async () => {
		expect(await tampered(xml => documentXml(xml.replace("<w:t>text</w:t>", "<w:t>text</w:x>")))).toBe("malformedPart")
		expect(await tampered(xml => documentXml(xml.replace("<w:t>text</w:t>", "<q:t>text</q:t>")))).toBe("malformedPart")
	})

	it("refuses new duplicate ids, dangling styles and missing relationships", async () => {
		expect(await tampered(xml => documentXml(xml.replace("</w:body>", '<w:p w14:paraId="0000AAAA"/></w:body>')))).toBe("duplicateId")
		expect(await tampered(xml => documentXml(xml.replace('w:val="Standard"', 'w:val="Nowhere"')))).toBe("danglingReference")
		expect(
			await tampered(xml =>
				documentXml(
					xml.replace(
						"<w:t>text</w:t>",
						'<w:t>text</w:t><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId99"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>'
					)
				)
			)
		).toBe("relationship")
	})

	it("refuses a new part without a content type", async () => {
		expect(await tampered(() => [{ name: "word/extra.bin", bytes: encodeUtf8("x") }], ["word/extra.bin"])).toBe("contentType")
	})

	it("refuses content that reads back differently", async () => {
		const document = await opened({ body: p("text"), ...PARTS })
		const edit = session(document)

		edit.dispatch(edit.state.tr.insertText("more ", 1))

		const changes = await serializeDocx({ pkg: document.pkg, context: document.context, sessions: [edit] })
		const story = changes.stories[0]

		if (story === undefined) throw new Error("No story change")

		// Same length, so the written paragraph offsets still hold.
		const tamper = async (bytes: PartBytes): Promise<Uint8Array> =>
			encodeUtf8(decoder.decode(await joinBytes(bytes)).replace(">more text<", ">mode text<"))
		const tampered = {
			...changes,
			replace: await Promise.all(
				changes.replace.map(async part => (part.name === "word/document.xml" ? { ...part, bytes: await tamper(part.bytes) } : part))
			),
			stories: [{ ...story, output: { ...story.output, bytes: await tamper(story.output.bytes) } }]
		}

		await expect(verifyDocxParts({ original: document.pkg, context: document.context, changes })).resolves.toBeUndefined()
		await expect(verifyDocxParts({ original: document.pkg, context: document.context, changes: tampered })).rejects.toMatchObject({
			reason: "content"
		})
	})
})

describe("docx writer: structure and values", () => {
	const TABLE =
		'<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
		'<w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>cell one</w:t></w:r></w:p></w:tc>' +
		'<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>cell two</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'

	it("splices properties in schema order around elements of other namespaces", async () => {
		const document = await opened({
			body: '<w:p><w:r><w:rPr><w:i/><w14:ligatures w14:val="standard"/></w:rPr><w:t>some words</w:t></w:r></w:p>',
			...PARTS
		})
		const edit = session(document)

		select(edit, 1, 5)
		edit.execute({ type: "format.bold" })

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml).toContain('<w:rPr><w:b/><w:bCs/><w:i/><w14:ligatures w14:val="standard"/></w:rPr><w:t>some</w:t>')
	})

	it("rewrites properties a source has out of schema order in order", async () => {
		const document = await opened({
			body: '<w:p><w:pPr><w:jc w:val="right"/> <w:pStyle w:val="Standard"/><w14:x/></w:pPr><w:r><w:t>text</w:t></w:r></w:p>',
			...PARTS
		})
		const edit = session(document)

		select(edit, 2)
		edit.execute({ type: "align.center" })

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml).toContain('<w:pPr><w:pStyle w:val="Standard"/><w:jc w:val="center"/> <w14:x/></w:pPr>')
	})

	it("keeps a table's properties when a paragraph is dragged into its first cell", async () => {
		const document = await opened({ body: p("moved") + TABLE + p("after"), ...PARTS })
		const edit = session(document)
		const doc = edit.state.doc
		const paragraph = doc.child(0)
		const slice = doc.slice(0, paragraph.nodeSize)
		// Inside the first cell, before its paragraph.
		const into = paragraph.nodeSize + 3
		const tr = edit.state.tr

		tr.replace(into, into, slice)
		tr.delete(0, paragraph.nodeSize)
		edit.dispatch(tr)

		const result = await save(document, edit)
		const xml = body(await read(result.bytes, "word/document.xml"))

		expect(xml.match(/<w:tblPr>/g)?.length).toBe(1)
		expect(xml).toContain('<w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>')
		expect(xml).toContain("<w:trPr><w:cantSplit/></w:trPr>")
		expect(xml.match(/<w:tcPr>/g)?.length).toBe(2)
		expect(xml.indexOf("moved")).toBeGreaterThan(xml.indexOf("<w:tc>"))
	})

	it("makes a table structure an unsanitised copy opened new", async () => {
		const row = (text: string): string =>
			`<w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:p><w:r><w:t>${text} one</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr>`
		const document = await opened({
			body: `<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>${row("a")}${row("b")}</w:tbl>` + p("after"),
			...PARTS
		})
		const edit = session(document)
		const doc = edit.state.doc
		const first = doc.child(0).child(0)
		// From inside the first row's first cell to inside the second row's first cell, copied into the first
		// row's last (empty) paragraph.
		const from = 1 + 1 + 1 + 1 + 2
		const to = 1 + first.nodeSize + 1 + 1 + 1 + 2
		const at = 1 + 1 + first.child(0).nodeSize + 1 + 1

		edit.dispatch(edit.state.tr.replaceRange(at, at, doc.slice(from, to)))

		const sources: number[] = []

		edit.state.doc.descendants(node => {
			const src = node.attrs["src"]

			if (node.type !== docxSchema.nodes.paragraph && !node.isInline && typeof src === "number" && src >= 0) sources.push(src)

			return !node.isTextblock
		})

		expect(new Set(sources).size).toBe(sources.length)
		await expect(save(document, edit)).resolves.toBeDefined()
	})

	it("writes a node object standing at two places once as its source and once as a copy", async () => {
		const document = await opened({
			body: '<w:p w14:paraId="0000ABCD"><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>shared</w:t></w:r></w:p>' + p("after"),
			...PARTS
		})
		const edit = session(document)
		const doc = edit.state.doc
		const twice = doc.copy(doc.content.append(Fragment.from(doc.child(0))))
		const writer = new StoryWriter(
			{ context: document.context, nextRevisionId: () => 100, numId: id => id, hyperlink: () => "rId100" },
			edit.story
		)
		const xml = decoder.decode(writer.writeStory(twice).bytes)

		expect(xml.match(/w14:paraId="0000ABCD"/g)?.length).toBe(1)
		expect(xml.match(/<w:jc w:val="center"\/>/g)?.length).toBe(2)
		expect(xml.match(/shared/g)?.length).toBe(2)
	})

	it("drops markers an unsanitised copy repeats in the lists of a paragraph it opened", async () => {
		const document = await opened({
			body: p("aaaa") + '<w:bookmarkStart w:id="5" w:name="b"/>' + p("bbbb") + '<w:bookmarkEnd w:id="5"/>' + p("cccc"),
			...PARTS
		})
		const edit = session(document)
		const doc = edit.state.doc
		const second = doc.child(0).nodeSize
		const third = second + doc.child(1).nodeSize

		expect((doc.child(1).attrs["before"] as unknown[]).length).toBe(1)

		edit.dispatch(edit.state.tr.replaceRange(third + 3, third + 3, doc.slice(2, second + 3)))

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml.match(/<w:bookmarkStart /g)?.length).toBe(1)
		expect(xml.match(/<w:bookmarkEnd /g)?.length).toBe(1)
	})

	it("keeps a cell's markers on the cell when an unsanitised copy repeats the cell", async () => {
		const document = await opened({
			body:
				p("first") +
				"<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>one</w:t></w:r></w:p></w:tc>" +
				'<w:bookmarkStart w:id="8" w:name="cell"/><w:tc><w:p><w:r><w:t>two</w:t></w:r><w:bookmarkEnd w:id="8"/></w:p></w:tc>' +
				"<w:tc><w:p><w:r><w:t>three</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
				p("last"),
			...PARTS
		})
		const edit = session(document)
		const doc = edit.state.doc
		const row = doc.child(1).child(0)
		const first = doc.child(0).nodeSize + 2
		const third = first + row.child(0).nodeSize + row.child(1).nodeSize

		expect((row.child(1).attrs["before"] as unknown[]).length).toBe(1)

		// Dragged from inside the second cell to inside the third into the first paragraph: the copy of the
		// second cell comes first, the deletion joins what is left of both cells.
		const from = first + row.child(0).nodeSize + 3
		const tr = edit.state.tr.delete(from, third + 3)

		edit.dispatch(tr.replaceRange(3, 3, doc.slice(from, third + 3)))

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml.match(/<w:bookmarkStart /g)?.length).toBe(1)
		expect(xml.indexOf("<w:bookmarkStart")).toBeGreaterThan(xml.lastIndexOf("first"))
	})

	it("keeps the only copy of a marker inside a repeated paragraph made new", async () => {
		const document = await opened({
			body:
				'<w:p><w:bookmarkStart w:id="3" w:name="m"/><w:r><w:t>aa</w:t></w:r></w:p><w:p><w:r><w:t>bb</w:t></w:r><w:bookmarkEnd w:id="3"/></w:p>' +
				p("cc"),
			...PARTS
		})
		const edit = session(document)
		const doc = edit.state.doc
		const second = doc.child(0).nodeSize
		const copy = doc.child(1)
		const end = second + 1 + copy.content.size - 1

		// The marker leaves the paragraph and a copy of the paragraph holding it lands at the end.
		edit.dispatch(edit.state.tr.insert(doc.content.size, copy).delete(end, end + 1))

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml.match(/<w:bookmarkEnd /g)?.length).toBe(1)
		expect(xml.indexOf("<w:bookmarkEnd")).toBeGreaterThan(xml.lastIndexOf("bb"))
	})

	it("saves a document edited and undone back byte for byte", async () => {
		const document = await opened({ body: TWO_RUNS + p("untouched"), ...PARTS })
		const edit = session(document)

		edit.dispatch(edit.state.tr.insertText("my ", 7))
		select(edit, 1, 6)
		edit.execute({ type: "format.bold" })
		edit.dispatch(edit.state.tr.split(4))

		while (edit.execute({ type: "history.undo" })) {
			// Back to the opened document.
		}

		const result = await save(document, edit)

		expect(result.changedParts).toEqual([])
		expect(result.bytes).toEqual(document.bytes)
	})

	it("keeps a bookmark around a paragraph moved whole", async () => {
		const document = await opened({
			body:
				p("one") +
				'<w:p><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t>moved</w:t></w:r></w:p><w:bookmarkEnd w:id="0"/>' +
				p("two") +
				p("three"),
			...PARTS
		})
		const edit = session(document)
		const doc = edit.state.doc
		const from = doc.child(0).nodeSize
		const to = from + doc.child(1).nodeSize
		const at = to + doc.child(2).nodeSize + doc.child(3).nodeSize
		const tr = edit.state.tr.delete(from, to)
		const slice = doc.slice(from, to)

		edit.dispatch(tr.replaceRange(tr.mapping.map(at), tr.mapping.map(at), slice))

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml).toMatch(
			/>three<\/w:t><\/w:r><\/w:p><w:p><w:bookmarkStart w:id="0" w:name="_Toc1"\/><w:r><w:t>moved<\/w:t><\/w:r><\/w:p><w:bookmarkEnd w:id="0"\/>$/
		)
	})

	it("keeps the tracked changes of a paragraph moved whole", async () => {
		const document = await opened({
			body: p("one") + '<w:p><w:ins w:id="7" w:author="Ann"><w:r><w:t>tracked</w:t></w:r></w:ins></w:p>' + p("two"),
			...PARTS
		})
		const edit = session(document)
		const doc = edit.state.doc
		const from = doc.child(0).nodeSize
		const to = from + doc.child(1).nodeSize
		const tr = edit.state.tr.delete(from, to)

		edit.dispatch(tr.replaceRange(tr.doc.content.size, tr.doc.content.size, doc.slice(from, to)))

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml).toMatch(/>two<\/w:t><\/w:r><\/w:p><w:p><w:ins w:id="7" w:author="Ann"><w:r><w:t>tracked<\/w:t><\/w:r><\/w:ins><\/w:p>$/)
	})

	it("ends a cell whose last block is a table in a content control with a paragraph", async () => {
		const inner = "<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
		const document = await opened({
			body:
				"<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:sdt><w:sdtPr/><w:sdtContent>" +
				inner +
				"<w:p><w:r><w:t>last</w:t></w:r></w:p></w:sdtContent></w:sdt></w:tc></w:tr></w:tbl>" +
				p("after"),
			...PARTS
		})
		const edit = session(document)
		const sdt = edit.state.doc.child(0).child(0).child(0).child(0)
		const size = sdt.lastChild?.nodeSize ?? 0
		const last = 4 + sdt.content.size - size

		edit.dispatch(edit.state.tr.delete(last, last + size))

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml).toMatch(/<\/w:sdtContent><\/w:sdt><w:p\/?>(<\/w:p>)?<\/w:tc>/)
	})

	it("closes a range whose start was moved past its end", async () => {
		const document = await opened({
			body:
				'<w:p><w:bookmarkStart w:id="1" w:name="mark"/><w:r><w:t>start here</w:t></w:r></w:p>' +
				'<w:p><w:r><w:t>end here</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>' +
				p("last"),
			...PARTS
		})
		const edit = session(document)
		const doc = edit.state.doc
		const first = doc.child(0)
		const slice = doc.slice(0, first.nodeSize)
		const into = doc.content.size
		const tr = edit.state.tr

		tr.replace(into, into, slice)
		tr.delete(0, first.nodeSize)
		edit.dispatch(tr)

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml.indexOf("<w:bookmarkStart")).toBeLessThan(xml.indexOf("<w:bookmarkEnd"))
		expect(xml.match(/<w:bookmarkStart /g)?.length).toBe(1)
		expect(xml.match(/<w:bookmarkEnd /g)?.length).toBe(1)
	})

	it("keeps a comment's range start before its reference", async () => {
		const document = await opened({
			body:
				'<w:p><w:commentRangeStart w:id="3"/><w:r><w:t>start here</w:t></w:r></w:p>' +
				'<w:p><w:r><w:t>end here</w:t></w:r><w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r></w:p>' +
				p("last"),
			comments: '<w:comment w:id="3" w:author="Ann"><w:p><w:r><w:t>remark</w:t></w:r></w:p></w:comment>',
			...PARTS
		})
		const edit = session(document)
		const doc = edit.state.doc
		const first = doc.child(0)
		const tr = edit.state.tr

		tr.replace(doc.content.size, doc.content.size, doc.slice(0, first.nodeSize))
		tr.delete(0, first.nodeSize)
		edit.dispatch(tr)

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml.indexOf("<w:commentRangeStart")).toBeLessThan(xml.indexOf("<w:commentReference"))
		expect(xml.match(/<w:commentRangeStart /g)?.length).toBe(1)
	})

	it("puts back a deleted cell's comment reference into a paragraph", async () => {
		// The comment starts in the cell that stays: its end and reference come back (a comment the deletion took
		// whole would go with it).
		const document = await opened({
			body:
				'<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p><w:commentRangeStart w:id="1"/><w:r><w:t>kept</w:t></w:r></w:p></w:tc>' +
				'<w:tc><w:p><w:r><w:t>gone</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p></w:tc></w:tr></w:tbl>' +
				p("after"),
			comments: '<w:comment w:id="1" w:author="Ann"><w:p><w:r><w:t>remark</w:t></w:r></w:p></w:comment>',
			...PARTS
		})
		const edit = session(document)
		const row = edit.state.doc.child(0).child(0)
		const second = 1 + 1 + row.child(0).nodeSize

		edit.dispatch(edit.state.tr.delete(second, second + row.child(1).nodeSize))

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml).toMatch(/<w:commentRangeStart w:id="1"\/><w:r><w:t>kept<\/w:t>/)
		expect(xml).toMatch(
			/<w:commentRangeEnd w:id="1"\/><w:r>(<w:rPr>.*?<\/w:rPr>)?<w:commentReference w:id="1"\/><\/w:r><\/w:p><\/w:tc><\/w:tr>/
		)
	})

	it("ends a cell that ends with a table with a paragraph", async () => {
		const document = await opened({ body: TABLE + p("after"), ...PARTS })
		const edit = session(document)
		const doc = edit.state.doc
		const table = doc.child(0)
		// The end of the first cell's content.
		const cellEnd = 1 + 1 + table.child(0).child(0).nodeSize - 1

		edit.dispatch(edit.state.tr.insert(cellEnd, table.copy(table.content)))

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml).toMatch(/<\/w:tbl><w:p\/?>(<\/w:p>)?<\/w:tc>/)
	})

	it("writes a link with both a target and an anchor", async () => {
		const document = await opened({ body: p("click here"), ...PARTS })
		const edit = session(document)

		edit.dispatch(edit.state.tr.addMark(1, 6, docxSchema.marks.link.create({ target: "https://filen.io/", anchor: "top" })))

		const xml = await read((await save(document, edit)).bytes, "word/document.xml")

		expect(xml).toMatch(/<w:hyperlink r:id="rId\d+" w:anchor="top">/)
	})

	it("puts a new link around a tracked change, not inside it", async () => {
		const document = await opened({
			body: '<w:p><w:del w:id="3" w:author="Ann"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>',
			...PARTS
		})
		const edit = session(document)

		edit.dispatch(edit.state.tr.addMark(1, 5, docxSchema.marks.link.create({ target: "https://filen.io/" })))

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml).toMatch(
			/^<w:p><w:hyperlink r:id="rId\d+"><w:del w:id="\d+" w:author="Ann"><w:r><w:delText>gone<\/w:delText><\/w:r><\/w:del><\/w:hyperlink><\/w:p>$/
		)
	})

	it("writes vertical tabs as breaks, drops controls and replaces lone surrogates", async () => {
		const document = await opened({ body: p("text"), ...PARTS })
		const edit = session(document)

		edit.dispatch(edit.state.tr.insertText("a\vb\u0001c\ud800d", 5))

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml).toContain("<w:br/>")
		expect(xml).toContain("bc\ufffdd")
		expect(xml.includes("\u0001")).toBe(false)
	})

	it("keeps a surrogate pair whole against a deletion of half of it and drops a link to nowhere", async () => {
		const document = await opened({ body: p("a\u{1F600}b"), ...PARTS })
		const edit = session(document)

		// Deleting the low half of the emoji only is refused.
		expect(edit.dispatch(edit.state.tr.delete(3, 4))).toBe(false)
		expect(edit.state.doc.textContent).toBe("a\u{1F600}b")

		const empty = docxSchema.marks.link.create({ target: "", anchor: null })

		edit.dispatch(edit.state.tr.addMark(1, 2, empty))
		expect(edit.state.doc.rangeHasMark(1, 2, docxSchema.marks.link)).toBe(false)

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml).not.toContain("hyperlink")
	})

	it("looks at every node of overlapping changes", async () => {
		const document = await opened({
			body: "<w:p><w:r><w:t>ab</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>cd</w:t></w:r></w:p>",
			...PARTS
		})
		const edit = session(document)
		const empty = docxSchema.marks.link.create({ target: "", anchor: null })

		edit.dispatch(edit.state.tr.addMark(1, 2, empty).addMark(1, 5, empty))
		expect(edit.state.doc.rangeHasMark(1, 5, docxSchema.marks.link)).toBe(false)
	})

	it("writes no wrapper around a rendered page break alone", async () => {
		const document = await opened({
			body: "<w:p><w:r><w:t>x</w:t></w:r><w:r><w:lastRenderedPageBreak/></w:r></w:p>" + p("after"),
			...PARTS
		})
		const edit = session(document)
		const end = edit.state.doc.child(0).nodeSize - 1

		edit.dispatch(edit.state.tr.addMark(1, end, docxSchema.marks.link.create({ target: "https://filen.io/" })).delete(1, 2))

		const xml = body(await read((await save(document, edit)).bytes, "word/document.xml"))

		expect(xml).not.toContain("hyperlink")
	})

	it("reads unpreserved edge whitespace the way Word does", async () => {
		const document = await opened({
			body: '<w:p><w:r><w:t> lead</w:t></w:r><w:r><w:t xml:space="preserve"> kept </w:t></w:r></w:p>',
			...PARTS
		})

		expect(session(document).state.doc.textContent).toBe("lead kept ")
	})

	it("refuses a value its schema type does not allow", async () => {
		const document = await opened({ body: p("text"), ...PARTS })
		const edit = session(document)

		edit.dispatch(edit.state.tr.addMark(1, 3, docxSchema.marks.highlight.create({ value: "notAColor" })))

		await expect(save(document, edit)).rejects.toMatchObject({ reason: "write" })
	})

	it("numbers new lists past ids the model could not read, across sessions", async () => {
		const document = await opened({
			body: p("one") + p("two") + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
			headers: { rIdH: p("header text") },
			parts: [
				STYLES_PART('<w:style w:type="paragraph" w:default="1" w:styleId="Standard"><w:name w:val="Normal"/></w:style>'),
				NUMBERING_PART(
					'<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>' +
						'<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="9"/>'
				)
			],
			relationships: PARTS.relationships
		})
		const header = document.model.stories.find(story => story.kind === "header")

		if (header === undefined) throw new Error("No header")

		const main = session(document)
		const top = new DocxEditorSession(document.context, { story: header, proof: writerProof(document.context) })

		select(main, 2)
		main.execute({ type: "list.numbered" })
		select(top, 2)
		top.execute({ type: "list.numbered" })

		const result = await save(document, main, top)
		const numbering = await read(result.bytes, "word/numbering.xml")
		const ids = [...numbering.matchAll(/<w:num w:numId="(\d+)"/g)].map(match => match[1])

		expect(ids).toEqual(["1", "9", "10", "11"])
		expect(await read(result.bytes, "word/document.xml")).toMatch(/<w:numId w:val="1[01]"\/>/)
		expect(await read(result.bytes, "word/header1.xml")).toMatch(/<w:numId w:val="1[01]"\/>/)
	})

	it("edits a text box that has no fallback copy", async () => {
		const document = await opened({
			body:
				'<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="5" name="Box"/><a:graphic>' +
				'<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:spPr/><wps:txbx><w:txbxContent>' +
				"<w:p><w:r><w:t>boxed</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>",
			...PARTS
		})
		const box = document.model.stories.find(story => story.kind === "textbox")

		if (box === undefined) throw new Error("No text box")

		const edit = new DocxEditorSession(document.context, { story: box })

		expect(edit.readOnly).toBe(false)
		expect(edit.snapshot().readOnlyReasons).toEqual([])
	})

	it("types a new relationships part the package has no type for", async () => {
		const files = unzipSync(
			buildDocx({
				body: p("body") + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
				headers: { rIdH: p("header text") },
				...PARTS
			})
		)
		const types = decoder.decode(files["[Content_Types].xml"])

		files["[Content_Types].xml"] = new Uint8Array(encodeUtf8(types.replace(/<Default Extension="rels"[^>]*\/>/, "")))

		const document = await openBytes(zipSync(files, { mtime: ZIP_ENTRY_TIME }))
		const header = document.model.stories.find(story => story.kind === "header")

		if (header === undefined) throw new Error("No header")

		const edit = new DocxEditorSession(document.context, { story: header, proof: writerProof(document.context) })

		edit.dispatch(edit.state.tr.addMark(1, 7, docxSchema.marks.link.create({ target: "https://filen.io/" })))

		const result = await saveDocx({ pkg: document.pkg, context: document.context, sessions: [edit] })
		const written = await OpcPackage.open(bytesSource(result.bytes ?? new Uint8Array()))

		expect((await written.contentTypes()).typeOf("word/_rels/header1.xml.rels")).toBe(
			"application/vnd.openxmlformats-package.relationships+xml"
		)
	})

	it("plans a save for a sink of the caller's and checks what the sink received", async () => {
		const document = await opened({ body: p("text"), ...PARTS })
		const edit = session(document)

		edit.dispatch(edit.state.tr.insertText("more ", 1))

		const sink = memorySink()
		const result = await saveDocx(
			{ pkg: document.pkg, context: document.context, sessions: [edit] },
			{ sink, readBack: async () => bytesSource(sink.bytes()) }
		)

		expect(result.bytes).toBeUndefined()
		expect(await read(sink.bytes(), "word/document.xml")).toContain("more text")
		expect(result.timings.verifyZipMs).toBeGreaterThanOrEqual(0)
	})
})

// Gate 2 against writer bugs: the copies the writer claims are checked, not trusted.
describe("docx save verifier against the writer", () => {
	const THREE = p("first") + p("second") + p("third")

	async function savedWith(copy: (this: Out, source: Uint8Array, from: number, to: number) => void): Promise<unknown> {
		const document = await opened({ body: THREE, ...PARTS })
		const edit = session(document)
		const original = Out.prototype.copy

		edit.dispatch(edit.state.tr.insertText("X", 2))
		vi.spyOn(Out.prototype, "copy").mockImplementation(function (this: Out, source: Uint8Array, from: number, to: number) {
			if (decoder.decode(source.subarray(from, to)).includes("second")) copy.call(this, source, from, to)
			else original.call(this, source, from, to)
		})

		try {
			await save(document, edit)

			return undefined
		} catch (error) {
			return (error as { reason?: unknown }).reason
		}
	}

	it("refuses a copied paragraph written twice", async () => {
		const original = Out.prototype.copy

		expect(
			await savedWith(function (this: Out, source, from, to) {
				original.call(this, source, from, to)
				original.call(this, source, from, to)
			})
		).toBe("content")
	})

	it("refuses a copied paragraph left out", async () => {
		expect(await savedWith(() => undefined)).toBe("content")
	})

	it("refuses a copy whose bytes are not the source's", async () => {
		const original = Out.prototype.copy

		expect(
			await savedWith(function (this: Out, source, from, to) {
				const changed = source.slice()

				changed[from + 1] = 0x58
				original.call(this, changed, from, to)
			})
		).toBe("content")
	})

	it("accepts the same edit when the writer is sound", async () => {
		expect(await savedWith(Out.prototype.copy)).toBeUndefined()
	})
})

describe("docx paragraph signature", () => {
	it("reads a lone surrogate as the U+FFFD written for it", () => {
		const paragraph = (text: string) => docxSchema.nodes.paragraph.create(null, docxSchema.text(text))

		expect(paragraphSignature(paragraph("a\ud83db\ude00"), new Map())).toBe(paragraphSignature(paragraph("a\ufffdb\ufffd"), new Map()))
		expect(paragraphSignature(paragraph("a\u{1F600}"), new Map())).not.toBe(paragraphSignature(paragraph("a\ufffd"), new Map()))
	})
})

describe("docx writer: templates and macro-enabled documents", () => {
	it("saves an edited .dotm with its content types and macro project as they were", async () => {
		const vba = new Uint8Array(Array.from({ length: 512 }, (_, k) => (k * 37) & 0xff))
		const document = await opened({
			body: p("Template text"),
			mainContentType: "application/vnd.ms-word.template.macroEnabledTemplate.main+xml",
			relationships: [{ id: "rIdVba", type: "vbaProject", target: "vbaProject.bin" }],
			parts: [{ name: "word/vbaProject.bin", contentType: "application/vnd.ms-office.vbaProject", data: vba }]
		})

		expect(document.pkg.facts).toMatchObject({ variant: "dotm", macros: true, template: true })
		expect(document.context.gate).toEqual([])

		const edit = session(document)
		const unedited = await save(document, edit)

		expect(unedited.changedParts).toEqual([])
		expect(unedited.bytes).toEqual(document.bytes)

		edit.dispatch(edit.state.tr.insertText("Edited ", 1))

		const edited = await save(document, edit)
		const original = await OpcPackage.open(bytesSource(document.bytes))
		const written = await OpcPackage.open(bytesSource(edited.bytes))

		expect(edited.changedParts).toEqual(["word/document.xml"])
		expect(await read(edited.bytes, "[Content_Types].xml")).toBe(await read(document.bytes, "[Content_Types].xml"))
		expect(await read(edited.bytes, "[Content_Types].xml")).toContain("application/vnd.ms-word.template.macroEnabledTemplate.main+xml")
		expect(await written.read("word/vbaProject.bin")).toEqual(vba)
		expect(written.entry("word/vbaProject.bin")?.crc32).toBe(original.entry("word/vbaProject.bin")?.crc32)
		expect(await read(edited.bytes, "word/document.xml")).toContain("Edited Template text")
	})
})
