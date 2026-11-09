import { afterEach, describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { XmlError, assertWellFormed, decodeCharacterData, parseXml } from "@filen/office/core/xml"
import { DocxEngine, type DocxEvent } from "@filen/office/dom/docx"
import { NUMBERING_PART, STYLES_PART } from "../docxEditFixtures"
import { openDocxPackage } from "@filen/office/core/docx"
import { saveDocx } from "@filen/office/core/docx/write"
import { NAMESPACES, buildDocx, modelOf, type SyntheticDocx } from "../docxSynthetic"
import { pagedEditor, settleAll } from "../pagedFixtures"
import { engineServices, nest, trapGlobals, type Trap } from "./generate"
import { budget, cpuMs } from "../timing"

// XML from documents: no entity can expand, no external resource is read, and no part reader recurses on
// the document's nesting.

const encoder = new TextEncoder()

function xmlCode(run: () => unknown): string | undefined {
	try {
		run()

		return undefined
	} catch (error) {
		if (error instanceof XmlError) return error.code

		throw error
	}
}

interface Opened {
	readonly events: DocxEvent[]
	readonly text: string
	readonly ms: number
}

async function openInEngine(spec: SyntheticDocx | Uint8Array): Promise<Opened> {
	const bytes = spec instanceof Uint8Array ? spec : buildDocx(spec)
	const events: DocxEvent[] = []
	const started = performance.now()

	await new DocxEngine(bytesSource(bytes), engineServices(), event => events.push(event)).run()

	const text = events.flatMap(event => (event.type === "pages" ? event.pages.flatMap(page => page.sourceTexts) : [])).join("\n")

	return { events, text, ms: performance.now() - started }
}

function finalPages(opened: Opened): boolean {
	return opened.events.some(event => event.type === "pages" && event.final) && !opened.events.some(event => event.type === "error")
}

const LAUGHS =
	'<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY lol "lol">' +
	Array.from({ length: 9 }, (_, k) => `<!ENTITY lol${k + 1} "${`&lol${k === 0 ? "" : k};`.repeat(10)}">`).join("") +
	"]>"

describe("entities", () => {
	it("refuses billion laughs and quadratic blowup at the internal subset, before any reference is read", () => {
		const laughs = `${LAUGHS}<w:document ${NAMESPACES}><w:body><w:p><w:r><w:t>&lol9;</w:t></w:r></w:p></w:body></w:document>`
		const big = "x".repeat(100_000)
		const quadratic = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "${big}">]><r>${"&a;".repeat(100_000)}</r>`
		const started = performance.now()

		expect(xmlCode(() => parseXml(encoder.encode(laughs)))).toBe("doctype")
		expect(xmlCode(() => parseXml(encoder.encode(quadratic)))).toBe("doctype")
		expect(performance.now() - started).toBeLessThan(budget(1000))
	})

	it("shows nothing of a main part that declares entities", async () => {
		const opened = await openInEngine({
			document: `${LAUGHS}<w:document ${NAMESPACES}><w:body><w:p><w:r><w:t>&lol9;</w:t></w:r></w:p></w:body></w:document>`
		})

		// The part is refused whole (the model lists it as rejected); nothing of it is shown.
		expect(opened.text).not.toContain("lol")
		expect(opened.ms).toBeLessThan(budget(2000))
	})

	it("knows only the five predefined entities and never expands another", () => {
		const bytes = encoder.encode("<r>&xxe;&amp;</r>")
		const document = parseXml(bytes)

		expect(xmlCode(() => decodeCharacterData(bytes, 3, bytes.length - 4, false))).toBe("invalidReference")
		expect(xmlCode(() => assertWellFormed(document))).toBe("invalidReference")
	})

	it("refuses character references to code points XML cannot carry", () => {
		for (const reference of [
			"&#0;",
			"&#x0;",
			"&#1;",
			"&#xD800;",
			"&#xDFFF;",
			"&#xFFFE;",
			"&#xFFFF;",
			"&#x110000;",
			"&#99999999999999999999;",
			"&#x;"
		]) {
			const bytes = encoder.encode(`<r a="${reference}">${reference}</r>`)

			expect(
				xmlCode(() => decodeCharacterData(bytes, 4 + 6, 4 + 6 + reference.length, true)),
				reference
			).toBe("invalidReference")
			expect(
				xmlCode(() => assertWellFormed(parseXml(bytes))),
				reference
			).toBe("invalidReference")
		}

		expect(decodeCharacterData(encoder.encode("&#x1F600;&#9;"), 0, 15, false)).toBe("\u{1F600}\t")
	})
})

describe("external resources", () => {
	let trap: Trap | undefined

	afterEach(() => {
		trap?.restore()
		trap = undefined
	})

	it("keeps an external DTD as an opaque node and never reads it", async () => {
		const document =
			'<?xml version="1.0"?><!DOCTYPE w:document SYSTEM "http://attacker.invalid/x.dtd">' +
			`<w:document ${NAMESPACES}><w:body><w:p><w:r><w:t>kept</w:t></w:r></w:p></w:body></w:document>`
		const bytes = buildDocx({ document })

		trap = trapGlobals()

		const opened = await openInEngine(bytes)

		expect(trap.calls).toEqual([])
		expect(finalPages(opened)).toBe(true)
		expect(opened.text).toContain("kept")
	})

	it("refuses a DOCTYPE anywhere but before the root", () => {
		expect(xmlCode(() => parseXml(encoder.encode('<r><!DOCTYPE r SYSTEM "x"></r>')))).toBe("doctype")
		expect(xmlCode(() => parseXml(encoder.encode('<!DOCTYPE r SYSTEM "x"><!DOCTYPE r SYSTEM "y"><r/>')))).toBe("doctype")
	})
})

describe("size and shape", () => {
	it("reads a 16 MiB attribute value and 16 MiB of text in linear time", () => {
		const value = "v".repeat(16 * 1024 * 1024)
		const bytes = encoder.encode(`<r a="${value}">${value}</r>`)
		const started = performance.now()
		const document = parseXml(bytes)

		expect(document.attribute(1, "a")?.length).toBe(value.length)
		expect(performance.now() - started).toBeLessThan(budget(3000))
	})

	it("handles a million nested elements without recursing", () => {
		const depth = 1_000_000
		const bytes = encoder.encode(nest("<a>", "</a>", "", depth))
		const document = parseXml(bytes)

		expect(document.count).toBe(depth + 1)
		expect(() => assertWellFormed(document)).not.toThrow()
	})

	it("checks a start tag with many prefixed attributes for duplicates by expanded name in linear time", () => {
		const count = 40_000
		const declarations = 'xmlns:a="urn:x" xmlns:b="urn:x"'
		let attributes = ""

		for (let i = 0; i < count; i++) attributes += ` a:x${i}="1"`

		const distinct = parseXml(encoder.encode(`<r ${declarations}${attributes}/>`))
		// b:x7 is a:x7 by expanded name: both prefixes are bound to the same URI.
		const repeated = parseXml(encoder.encode(`<r ${declarations}${attributes} b:x${count - 7}="2"/>`))
		const started = cpuMs()

		expect(() => assertWellFormed(distinct)).not.toThrow()
		expect(xmlCode(() => assertWellFormed(repeated))).toBe("invalidAttribute")
		expect(cpuMs() - started).toBeLessThan(budget(500))
	})
})

const DEPTH = 100_000
const RUN = "<w:r><w:t>deep</w:t></w:r>"
const PARAGRAPH = `<w:p>${RUN}</w:p>`
// Shown in every case: content nested past the model's depth limit is kept as one opaque item instead.
const TOP = "<w:p><w:r><w:t>top</w:t></w:r></w:p>"

// Each part reader and each construct that nests, nested far deeper than any stack.
const NESTED: Record<string, SyntheticDocx> = {
	"block content controls": { body: nest("<w:sdt><w:sdtContent>", "</w:sdtContent></w:sdt>", PARAGRAPH, DEPTH) },
	"run content controls": { body: `<w:p>${nest("<w:sdt><w:sdtContent>", "</w:sdtContent></w:sdt>", RUN, DEPTH)}</w:p>` },
	tables: { body: nest("<w:tbl><w:tr><w:tc>", "<w:p/></w:tc></w:tr></w:tbl>", PARAGRAPH, 20_000) },
	insertions: { body: `<w:p>${nest('<w:ins w:id="1" w:author="a">', "</w:ins>", RUN, DEPTH)}</w:p>` },
	hyperlinks: { body: `<w:p>${nest('<w:hyperlink w:anchor="a">', "</w:hyperlink>", RUN, DEPTH)}</w:p>` },
	"smart tags": { body: `<w:p>${nest('<w:smartTag w:uri="u" w:element="e">', "</w:smartTag>", RUN, DEPTH)}</w:p>` },
	"custom XML": { body: nest('<w:customXml w:element="e">', "</w:customXml>", PARAGRAPH, DEPTH) },
	"simple fields": { body: `<w:p>${nest('<w:fldSimple w:instr="MERGEFIELD x">', "</w:fldSimple>", RUN, DEPTH)}</w:p>` },
	"unknown elements": { body: `<w:p><w:r>${nest("<w14:x>", "</w14:x>", "", DEPTH)}<w:t>deep</w:t></w:r></w:p>` },
	"alternate content": {
		body: `<w:p>${nest('<mc:AlternateContent><mc:Choice Requires="w14">', "</mc:Choice></mc:AlternateContent>", RUN, DEPTH)}</w:p>`
	},
	equations: {
		body: `<w:p>${RUN}<m:oMath>${nest("<m:f><m:num>", "</m:num><m:den><m:r><m:t>1</m:t></m:r></m:den></m:f>", "<m:r><m:t>1</m:t></m:r>", DEPTH)}</m:oMath></w:p>`
	},
	"VML groups": {
		body: `<w:p>${RUN}<w:r><w:pict>${nest('<v:group style="width:10pt;height:10pt" coordsize="10,10">', "</v:group>", '<v:rect style="width:1pt;height:1pt"/>', DEPTH)}</w:pict></w:r></w:p>`
	},
	"DrawingML groups": {
		body:
			`<w:p>${RUN}<w:r><w:drawing><wp:inline><wp:extent cx="1000" cy="1000"/><wp:docPr id="1" name="d"/><a:graphic>` +
			'<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:wgp><wpg:grpSpPr/>' +
			nest(
				"<wpg:grpSp><wpg:grpSpPr/>",
				"</wpg:grpSp>",
				'<wps:wsp><wps:spPr><a:prstGeom prst="rect"/></wps:spPr><wps:bodyPr/></wps:wsp>',
				DEPTH
			) +
			"</wpg:wgp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
	},
	"text boxes": {
		body: nest(
			'<w:p><w:r><w:pict><v:shape style="width:10pt;height:10pt"><v:textbox><w:txbxContent>',
			"</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>",
			PARAGRAPH,
			20_000
		)
	},
	comments: {
		body: '<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>deep</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>',
		comments: `<w:comment w:id="1" w:author="a">${nest("<w:sdt><w:sdtContent>", "</w:sdtContent></w:sdt>", PARAGRAPH, DEPTH)}</w:comment>`
	},
	footnotes: {
		body: `<w:p>${RUN}<w:r><w:footnoteReference w:id="2"/></w:r></w:p>`,
		footnotes: `<w:footnote w:id="2">${nest('<w:customXml w:element="e">', "</w:customXml>", PARAGRAPH, DEPTH)}</w:footnote>`
	},
	headers: {
		body: `${PARAGRAPH}<w:sectPr><w:headerReference w:type="default" r:id="rH"/></w:sectPr>`,
		headers: { rH: nest("<w:sdt><w:sdtContent>", "</w:sdtContent></w:sdt>", PARAGRAPH, DEPTH) }
	},
	settings: { body: PARAGRAPH, settings: `${nest("<w14:x>", "</w14:x>", "", DEPTH)}<w:zoom w:percent="100"/>` },
	"style chains": {
		body: '<w:p><w:pPr><w:pStyle w:val="S0"/></w:pPr><w:r><w:rPr><w:rStyle w:val="C0"/></w:rPr><w:t>deep</w:t></w:r></w:p>',
		parts: [
			STYLES_PART(
				Array.from(
					{ length: 20_000 },
					(_, k) => `<w:style w:type="paragraph" w:styleId="S${k}"><w:basedOn w:val="S${k + 1}"/></w:style>`
				).join("") +
					Array.from(
						{ length: 20_000 },
						(_, k) => `<w:style w:type="character" w:styleId="C${k}"><w:basedOn w:val="C${k + 1}"/></w:style>`
					).join("")
			)
		],
		relationships: [{ id: "rSt", type: "styles", target: "styles.xml" }]
	},
	"numbering style links": {
		body: '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>deep</w:t></w:r></w:p>',
		parts: [
			STYLES_PART(
				Array.from(
					{ length: 5000 },
					(_, k) =>
						`<w:style w:type="numbering" w:styleId="N${k}"><w:pPr><w:numPr><w:numId w:val="${k + 1}"/></w:numPr></w:pPr></w:style>`
				).join("")
			),
			NUMBERING_PART(
				Array.from(
					{ length: 5000 },
					(_, k) =>
						`<w:abstractNum w:abstractNumId="${k}"><w:numStyleLink w:val="N${k + 1}"/></w:abstractNum><w:num w:numId="${k + 1}"><w:abstractNumId w:val="${k}"/></w:num>`
				).join("")
			)
		],
		relationships: [
			{ id: "rSt", type: "styles", target: "styles.xml" },
			{ id: "rNum", type: "numbering", target: "numbering.xml" }
		]
	}
}

describe("deep nesting in every part reader", () => {
	it.each(Object.entries(NESTED))("opens and lays out %s nested past any stack", async (_, spec) => {
		const opened = await openInEngine({ ...spec, body: TOP + (spec.body ?? "") })

		expect(finalPages(opened)).toBe(true)
		expect(opened.text).toContain("top")
		expect(opened.ms).toBeLessThan(budget(10_000))
	})

	it("keeps content past the depth limit opaque and writes it back unchanged after an edit", async () => {
		const body = TOP + nest("<w:sdt><w:sdtContent>", "</w:sdtContent></w:sdt>", "<w:p><w:r><w:t>innermost</w:t></w:r></w:p>", 1000)
		const model = await modelOf({ body })

		expect(model.counts.depthLimited).toBeGreaterThan(0)

		const opened = await pagedEditor(buildDocx({ body }))

		await settleAll(opened.editor)
		opened.editor.session.dispatch(opened.editor.session.state.tr.insertText("edited ", 1))

		const saved = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })
		const reopened = await openDocxPackage(bytesSource(saved.bytes ?? new Uint8Array(0)))

		if (!reopened.ok) throw new Error(reopened.message)

		const xml = new TextDecoder().decode(await reopened.package.opc.read("word/document.xml"))

		expect(xml).toContain("edited top")
		expect(xml).toContain(
			nest("<w:sdt><w:sdtContent>", "</w:sdtContent></w:sdt>", "<w:p><w:r><w:t>innermost</w:t></w:r></w:p>", 800).slice(0, 4000)
		)
		expect(xml).toContain("innermost")
	})
})
