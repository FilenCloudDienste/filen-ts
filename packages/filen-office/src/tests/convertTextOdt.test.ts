import { describe, expect, it } from "vitest"
import { convertText } from "../core/convert/text/index"
import { LOWERED_NAMESPACES, LoweredIds, Lowering } from "../core/convert/text/lower"
import { standaloneParts } from "../core/convert/text/odtPackage"
import { LossyCounts } from "../core/convert/text/report"
import { bytesSource, ZipArchive } from "../core/opc/index"
import { translateOdt } from "../core/odt/index"
import { decodeUtf8, encodeUtf8, parseXml } from "../core/xml/index"
import { docxConvertServer } from "../dom/docx/convert"
import { buildDoc, plc, prl } from "./docFixtures"
import { buildDocx, p, type SyntheticDocx } from "./docxSynthetic"

const WML = "application/vnd.openxmlformats-officedocument.wordprocessingml"
// A 1×1 PNG.
const PNG = Uint8Array.from(
	atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
	char => char.charCodeAt(0)
)

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>
</w:styles>`

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\uF0B7"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%1)"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`

function spec(body: string, extra: Partial<SyntheticDocx> = {}): SyntheticDocx {
	return {
		body,
		parts: [
			{ name: "word/styles.xml", contentType: `${WML}.styles+xml`, data: STYLES },
			{ name: "word/numbering.xml", contentType: `${WML}.numbering+xml`, data: NUMBERING },
			{ name: "word/media/image1.png", data: PNG },
			...(extra.parts ?? [])
		],
		relationships: [
			{ id: "rIdS", type: "styles", target: "styles.xml" },
			{ id: "rIdN", type: "numbering", target: "numbering.xml" },
			{ id: "rIdImg", type: "image", target: "media/image1.png" },
			{ id: "rIdLink", type: "hyperlink", target: "https://filen.io/", external: true },
			...(extra.relationships ?? [])
		],
		...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "parts" && key !== "relationships"))
	}
}

async function odtParts(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
	const archive = await ZipArchive.open(bytesSource(bytes))
	const out = new Map<string, Uint8Array>()

	for (const entry of archive.entries) out.set(entry.name, await archive.read(entry))

	return out
}

// The text of each body paragraph as the ODT translator reads the written file back.
async function readBack(bytes: Uint8Array): Promise<string[]> {
	const translated = await translateOdt(bytesSource(bytes), { strict: true })

	if (!translated.ok) throw new Error(`${translated.reason}: ${translated.message}`)

	const document = translated.translation.parts.get("word/document.xml")
	const xml = document instanceof Uint8Array ? decodeUtf8(document) : ""

	return [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gu)].map(match =>
		[...(match[1] ?? "").matchAll(/<w:(t|delText)\b[^>]*>([^<]*)<\/w:\1>|<w:tab\/>/gu)]
			.map(run => (run[0] === "<w:tab/>" ? "\t" : (run[2] ?? "")))
			.join("")
	)
}

const PICTURE =
	'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="457200"/><wp:docPr id="1" name="Picture 1" descr="A dot"/>' +
	'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="dot.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
	'<pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'

describe("convertText docx → odt", () => {
	it("writes an ODF 1.3 text whose text reads back as the source's", async () => {
		const body =
			p("Title", '<w:pStyle w:val="Heading1"/>') +
			'<w:p><w:r><w:t xml:space="preserve">Plain </w:t></w:r><w:r><w:rPr><w:rStyle w:val="Strong"/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:hyperlink r:id="rIdLink"><w:r><w:t>a link</w:t></w:r></w:hyperlink><w:r><w:footnoteReference w:id="1"/></w:r></w:p>' +
			p("Bullet one", '<w:pStyle w:val="ListBullet"/>') +
			p("Bullet two", '<w:pStyle w:val="ListBullet"/>') +
			p("Letter", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>') +
			'<w:p><w:r><w:t>Before</w:t><w:br w:type="page"/><w:t>after</w:t></w:r></w:p>' +
			`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/><w:gridSpan w:val="2"/></w:tcPr>${p("Wide")}</w:tc></w:tr><w:tr><w:tc>${p("A")}</w:tc><w:tc>${p("B")}</w:tc></w:tr></w:tbl>` +
			`<w:p>${PICTURE}<w:ins w:id="5" w:author="Ann" w:date="2024-01-02T03:04:05Z"><w:r><w:t>inserted</w:t></w:r></w:ins></w:p>` +
			`<w:sdt><w:sdtPr><w:alias w:val="Box"/></w:sdtPr><w:sdtContent>${p("In a control")}</w:sdtContent></w:sdt>` +
			'<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
		const source = buildDocx(
			spec(body, {
				headers: {
					rIdH: '<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
				},
				footnotes:
					'<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> A note.</w:t></w:r></w:p></w:footnote>'
			})
		)
		const converted = await convertText(source, "docx", "odt")

		if (!converted.ok) throw new Error(converted.refusal.message)

		const parts = await odtParts(converted.bytes)
		const content = decodeUtf8(parts.get("content.xml") ?? new Uint8Array())
		const styles = decodeUtf8(parts.get("styles.xml") ?? new Uint8Array())
		const manifest = decodeUtf8(parts.get("META-INF/manifest.xml") ?? new Uint8Array())

		expect([...parts.keys()][0]).toBe("mimetype")
		expect(decodeUtf8(parts.get("mimetype") ?? new Uint8Array())).toBe("application/vnd.oasis.opendocument.text")
		expect(content).toContain('office:version="1.3"')
		// No internal placeholders or WordprocessingML reach the ODF streams.
		expect(content.includes("\u0002") || content.includes("\u0003")).toBe(false)
		expect(styles.includes("\u0002") || styles.includes("\u0003")).toBe(false)
		expect(content).not.toMatch(/<w:|w:val/u)
		expect(styles).not.toMatch(/<w:/u)
		// The heading's style, the bullet list (the Symbol bullet as Unicode) and the letter list (aa, bb...).
		expect(styles).toMatch(
			/<style:style style:name="Heading1" style:display-name="heading 1" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Standard" style:default-outline-level="1">/u
		)
		expect(styles).toContain('text:bullet-char="•"')
		expect(styles).not.toContain('style:font-name="Symbol"')
		expect(styles).toContain('style:num-format="a" style:num-letter-sync="true" style:num-prefix="(" style:num-suffix=")"')
		expect(content).toMatch(
			/<text:list text:style-name="WWNum0"[^>]*><text:list-item><text:p[^>]*>Bullet one<\/text:p><\/text:list-item><text:list-item><text:p[^>]*>Bullet two/u
		)
		// The page break starts a paragraph of its own on a new page.
		expect(content).toMatch(/>Before<\/text:p><text:p text:style-name="(P\d+)">after<\/text:p>/u)
		expect(content).toContain('<text:note text:note-class="footnote" text:id="filen-footnote-1">')
		expect(content).toMatch(
			/<text:tracked-changes text:track-changes="false"><text:changed-region [^>]*><text:insertion><office:change-info><dc:creator>Ann<\/dc:creator><dc:date>2024-01-02T03:04:05<\/dc:date>/u
		)
		expect(content).toMatch(
			/<draw:frame [^>]*text:anchor-type="as-char" svg:width="2.54cm" svg:height="1.27cm"><draw:image xlink:href="Pictures\/1.png"[^>]*\/><svg:desc>A dot<\/svg:desc><\/draw:frame>/u
		)
		expect(manifest).toContain('manifest:full-path="Pictures/1.png" manifest:media-type="image/png"')
		expect(parts.get("Pictures/1.png")).toEqual(PNG)
		expect(styles).toMatch(
			/<style:header><text:p[^>]*>Page <text:page-number text:select-page="current">1<\/text:page-number><\/text:p><\/style:header>/u
		)
		expect(content).toContain('<text:a xlink:type="simple" xlink:href="https://filen.io/">a link</text:a>')

		expect(await readBack(converted.bytes)).toEqual([
			"Title",
			"Plain bold and a link",
			"Bullet one",
			"Bullet two",
			"Letter",
			"Before",
			"after",
			"Wide",
			"A",
			"B",
			"inserted",
			"In a control"
		])
		expect(converted.lossy.features).toEqual([{ kind: "contentControl", count: 1 }])
	})

	it("adds no empty paragraph for a page break at the start or end of a paragraph (as LibreOffice reads it)", async () => {
		const body =
			p("A") +
			'<w:p><w:r><w:br w:type="page"/></w:r><w:r><w:t>B</w:t></w:r></w:p>' +
			'<w:p><w:r><w:t>C</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>' +
			p("D") +
			'<w:p><w:r><w:t>E</w:t><w:br w:type="page"/><w:t>F</w:t></w:r></w:p>'
		const converted = await convertText(buildDocx(spec(body)), "docx", "odt")

		if (!converted.ok) throw new Error(converted.refusal.message)

		const content = decodeUtf8((await odtParts(converted.bytes)).get("content.xml") ?? new Uint8Array())
		const breaks = new Set(
			[...content.matchAll(/<style:style style:name="([^"]+)"[^>]*><style:paragraph-properties fo:break-before="page"\/>/gu)].map(
				match => match[1]
			)
		)
		const paragraphs = [...content.matchAll(/<text:p(?: text:style-name="([^"]*)")?(?:\/>|>([^<]*)<\/text:p>)/gu)].map(
			match => `${breaks.has(match[1]) ? "|" : ""}${match[2] ?? ""}`
		)

		expect(paragraphs).toEqual(["A", "|B", "C", "|D", "E", "|F"])
	})

	it("keeps a block's text where the emitter cannot write it, and counts it", async () => {
		const cells = Array.from({ length: 64 }, (_, k) => `<w:tc>${p(`c${String(k)}`)}</w:tc>`).join("")
		const grid = '<w:gridCol w:w="100"/>'.repeat(64)
		const converted = await convertText(
			buildDocx(spec(`<w:tbl><w:tblGrid>${grid}</w:tblGrid><w:tr>${cells}</w:tr></w:tbl>`)),
			"docx",
			"odt"
		)

		if (!converted.ok) throw new Error(converted.refusal.message)

		expect(converted.lossy.features).toContainEqual({ kind: "blockFormat", count: 1 })

		const content = decodeUtf8((await odtParts(converted.bytes)).get("content.xml") ?? new Uint8Array())

		// Every cell's text (the ODT reader shows 63 columns at most, so the written file is read directly).
		expect([...content.matchAll(/<text:p>(c\d+)<\/text:p>/gu)].map(match => match[1])).toEqual(
			Array.from({ length: 64 }, (_, k) => `c${String(k)}`)
		)
	})

	it("counts what it leaves out: macros, run properties, drawings (their text kept), fields kept as results", async () => {
		const body =
			'<w:p><w:r><w:rPr><w:kern w:val="28"/></w:rPr><w:t>kerned</w:t></w:r></w:p>' +
			'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> DATE \\@ "d MMMM yyyy" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>2 January 2024</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
			`<w:p><w:r><w:pict><v:shape style="width:100pt;height:50pt"><v:textbox><w:txbxContent>${p("Boxed text")}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`
		const converted = await convertText(
			buildDocx(spec(body, { mainContentType: "application/vnd.ms-word.document.macroEnabled.main+xml" })),
			"docx",
			"odt"
		)

		if (!converted.ok) throw new Error(converted.refusal.message)

		expect(converted.lossy.features).toEqual([
			{ kind: "drawing", count: 1 },
			{ kind: "field", count: 1 },
			{ kind: "macros", count: 1 },
			{ kind: "runFormat", count: 1 }
		])
		expect(await readBack(converted.bytes)).toEqual(["kerned", "2 January 2024", "", "Boxed text"])
	})

	it("refuses what is not a .docx, and an aborted job", async () => {
		expect(await convertText(encodeUtf8("not a zip"), "docx", "odt")).toMatchObject({ ok: false, refusal: { reason: "notSource" } })
		expect(
			await convertText(buildDocx(spec(p("x"))), "docx", "odt", {
				turns: { signal: { aborted: true }, slicing: { pause: () => Promise.resolve(), sliceMs: 0, now: () => 0 } }
			})
		).toMatchObject({ ok: false, refusal: { reason: "aborted" } })
	})
})

async function converted(
	source: SyntheticDocx
): Promise<{ parts: Map<string, string>; features: readonly { kind: string; count: number }[] }> {
	const result = await convertText(buildDocx(source), "docx", "odt")

	if (!result.ok) throw new Error(result.refusal.message)

	const parts = new Map<string, string>()

	for (const [name, bytes] of await odtParts(result.bytes)) if (name.endsWith(".xml")) parts.set(name, decodeUtf8(bytes))

	return { parts, features: result.lossy.features }
}

const WPS = 'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"'
const LETTER = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'
const TEXT_BOX = `<w:drawing><wp:anchor ${WPS} distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="3000000" cy="1000000"/><wp:wrapNone/><wp:docPr id="1" name="TB"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr><wps:txbx><w:txbxContent>${p("item a", LETTER)}${p("item b", LETTER)}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing>`

describe("convertText docx → odt: tracked changes, notes, protection and links", () => {
	it("writes a tracked deletion of a text box holding a list as well-formed content, its list named", async () => {
		const { parts } = await converted(
			spec(
				`<w:p><w:r><w:t>Before</w:t></w:r><w:del w:id="5" w:author="A" w:date="2020-01-01T00:00:00Z"><w:r>${TEXT_BOX}</w:r></w:del><w:r><w:t>After</w:t></w:r></w:p>${p("Later", LETTER)}`
			)
		)
		const content = parts.get("content.xml") ?? ""

		expect(content.includes("\u0002") || content.includes("\u0003")).toBe(false)
		expect(() => parseXml(encodeUtf8(content))).not.toThrow()
		expect(content).toMatch(
			/<text:tracked-changes text:track-changes="false"><text:changed-region [^>]*><text:deletion>[\s\S]*<text:list [^>]*xml:id="[^"]+"/u
		)
	})

	it("keeps an automatic style only a tracked deletion names, and none no markup names", async () => {
		const { parts } = await converted(
			spec(
				'<w:p><w:r><w:t>Before</w:t></w:r><w:del w:id="5" w:author="A" w:date="2020-01-01T00:00:00Z"><w:r><w:rPr><w:color w:val="00FF00"/></w:rPr><w:delText>gone</w:delText></w:r></w:del><w:r><w:t>After</w:t></w:r></w:p>'
			)
		)
		const content = parts.get("content.xml") ?? ""
		const automatic = /<office:automatic-styles>([\s\S]*?)<\/office:automatic-styles>/u.exec(content)?.[1] ?? ""
		const deleted = /<text:deletion>[\s\S]*?<\/text:deletion>/u.exec(content)?.[0] ?? ""
		const named = /<text:span text:style-name="([^"]+)">gone<\/text:span>/u.exec(deleted)?.[1]
		const defined = [...automatic.matchAll(/<style:style style:name="([^"]+)"/gu)].map(match => match[1])

		expect(named).toBeDefined()
		expect(automatic).toMatch(new RegExp(`<style:style style:name="${named ?? ""}" style:family="text">.*fo:color="#00ff00"`, "iu"))
		expect(defined.every(name => content.slice(content.indexOf("</office:automatic-styles>")).includes(`="${name ?? ""}"`))).toBe(true)
	})

	it("writes Word's footnote and endnote numbering as notes configurations, counting what has no form", async () => {
		const notes = (kind: "footnote" | "endnote"): string =>
			`<w:${kind} w:id="1"><w:p><w:r><w:${kind}Ref/></w:r><w:r><w:t xml:space="preserve"> a note</w:t></w:r></w:p></w:${kind}>`
		const body = (sectPr: string): string =>
			`<w:p><w:r><w:t>Text</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:endnoteReference w:id="1"/></w:r></w:p><w:sectPr>${sectPr}</w:sectPr>`
		const configurations = (styles: string): string[] =>
			[...styles.matchAll(/<text:notes-configuration [^>]*\/>/gu)].map(match => match[0])
		const exact = await converted(
			spec(body('<w:footnotePr><w:numFmt w:val="lowerLetter"/><w:numRestart w:val="eachPage"/></w:footnotePr>'), {
				footnotes: notes("footnote"),
				endnotes: notes("endnote"),
				settings:
					'<w:footnotePr><w:numFmt w:val="decimal"/></w:footnotePr><w:endnotePr><w:numFmt w:val="upperRoman"/><w:numStart w:val="5"/></w:endnotePr>'
			})
		)

		// The section's settings win over the document's; a start other than 1 is counted from 0, as LibreOffice reads it.
		expect(configurations(exact.parts.get("styles.xml") ?? "")).toEqual([
			'<text:notes-configuration text:note-class="footnote" style:num-format="a" style:num-letter-sync="true" text:footnotes-position="page" text:start-numbering-at="page"/>',
			'<text:notes-configuration text:note-class="endnote" style:num-format="I" text:start-value="4"/>'
		])
		expect(exact.features).toEqual([])

		const approximated = await converted(
			spec(
				body(
					'<w:footnotePr><w:pos w:val="beneathText"/><w:numFmt w:val="chicago"/><w:numRestart w:val="eachSect"/></w:footnotePr><w:endnotePr><w:pos w:val="sectEnd"/></w:endnotePr>'
				),
				{ footnotes: notes("footnote"), endnotes: notes("endnote") }
			)
		)

		expect(configurations(approximated.parts.get("styles.xml") ?? "")).toEqual([
			'<text:notes-configuration text:note-class="footnote" style:num-format="1" text:footnotes-position="text" text:start-numbering-at="chapter"/>',
			'<text:notes-configuration text:note-class="endnote" style:num-format="i"/>'
		])
		expect(approximated.features).toEqual([{ kind: "noteSettings", count: 3 }])

		const atEnd = await converted(
			spec(body('<w:footnotePr><w:pos w:val="docEnd"/></w:footnotePr>'), { footnotes: notes("footnote"), endnotes: notes("endnote") })
		)

		expect(configurations(atEnd.parts.get("styles.xml") ?? "")[0]).toContain('text:footnotes-position="document"')
		expect(atEnd.features).toEqual([])
	})

	it("keeps read-only protection, forms protection and Track Changes as LibreOffice does, counting what has no form", async () => {
		const settings = (xml: string): string =>
			xml.match(/<config:config-item-set config:name="ooo:configuration-settings">[\s\S]*?<\/config:config-item-set>/u)?.[0] ?? ""
		const readOnly = await converted(
			spec(p("Locked"), { settings: '<w:documentProtection w:edit="readOnly" w:enforcement="1"/><w:trackRevisions/>' })
		)

		expect(settings(readOnly.parts.get("settings.xml") ?? "")).toContain(
			'<config:config-item config:name="LoadReadonly" config:type="boolean">true</config:config-item>'
		)
		// LibreOffice reads the set's name as a qualified name.
		expect(readOnly.parts.get("settings.xml")).toContain('xmlns:ooo="http://openoffice.org/2004/office"')
		expect(readOnly.parts.get("content.xml")).toContain('<text:tracked-changes text:track-changes="true"/>')
		expect(readOnly.features).toEqual([])

		// Forms protection: ProtectForm, and each section Word protects (all but those with w:formProt off) a protected section.
		const forms = await converted(
			spec(
				`<w:p><w:pPr><w:sectPr><w:formProt w:val="0"/></w:sectPr></w:pPr><w:r><w:t>Free</w:t></w:r></w:p>${p("Locked")}<w:sectPr/>`,
				{
					settings: '<w:documentProtection w:edit="forms" w:enforcement="1"/>'
				}
			)
		)
		const content = forms.parts.get("content.xml") ?? ""

		expect(settings(forms.parts.get("settings.xml") ?? "")).toContain(
			'<config:config-item config:name="ProtectForm" config:type="boolean">true</config:config-item>'
		)
		expect(content).toMatch(
			/<text:p[^>]*>Free<\/text:p><text:section text:name="[^"]+" text:protected="true"><text:p[^>]*>Locked<\/text:p><\/text:section>/u
		)
		expect(() => parseXml(encodeUtf8(content))).not.toThrow()
		expect(forms.features).toEqual([])

		// What ODF holds no form for: comments-only editing, a password, an editable range; unenforced protection is none.
		const comments = await converted(spec(p("Locked"), { settings: '<w:documentProtection w:edit="comments" w:enforcement="1"/>' }))
		const password = await converted(
			spec(
				'<w:p><w:r><w:t>Locked</w:t></w:r><w:permStart w:id="1" w:edGrp="everyone"/><w:r><w:t>free</w:t></w:r><w:permEnd w:id="1"/></w:p>',
				{
					settings:
						'<w:documentProtection w:edit="readOnly" w:enforcement="1" w:cryptProviderType="rsaAES" w:cryptAlgorithmClass="hash" w:cryptAlgorithmType="typeAny" w:cryptAlgorithmSid="14" w:cryptSpinCount="100000" w:hash="oYUhnRSm+XHtRUzWvE6CO+f+b6Poo1K+Lvfb9bCIkIwxtmabNieIN7lxTaRfbYFaLurTi/W1d+fsH55dIt7VSg==" w:salt="l35GbpzSqi3r6QltK5QyFw=="/>'
				}
			)
		)
		const unenforced = await converted(spec(p("Open"), { settings: '<w:documentProtection w:edit="readOnly" w:enforcement="0"/>' }))

		expect(comments.features).toEqual([{ kind: "documentProtection", count: 1 }])
		expect(password.features).toEqual([{ kind: "documentProtection", count: 2 }])
		expect(settings(password.parts.get("settings.xml") ?? "")).toContain('"LoadReadonly" config:type="boolean">true<')
		expect(unenforced.parts.get("settings.xml")).not.toContain("LoadReadonly")
		expect(unenforced.features).toEqual([])
	})

	it("writes the layout compatibility settings LibreOffice's Word import sets, so a reader fills in none of an old document's", async () => {
		const MODE = '<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>'
		const items = async (settings?: string): Promise<Map<string | undefined, string>> =>
			new Map(
				[
					...(
						(await converted(spec(p("Text"), settings === undefined ? {} : { settings }))).parts.get("settings.xml") ?? ""
					).matchAll(/<config:config-item config:name="([^"]+)" config:type="([^"]+)">([^<]*)</gu)
				].map(match => [match[1], `${match[2] ?? ""} ${match[3] ?? ""}`])
			)
		const word2013 = await items(`<w:compat>${MODE}</w:compat>`)

		// A set missing these reads as a document from before them: no external leading, the former line spacing,
		// printer metrics.
		expect(word2013.get("AddExternalLeading")).toBe("boolean true")
		expect(word2013.get("UseFormerLineSpacing")).toBe("boolean false")
		expect(word2013.get("UseFormerObjectPositioning")).toBe("boolean false")
		expect(word2013.get("UseFormerTextWrapping")).toBe("boolean false")
		expect(word2013.get("AddParaTableSpacingAtStart")).toBe("boolean true")
		expect(word2013.get("PrinterIndependentLayout")).toBe("string high-resolution")
		expect(word2013.get("UseOldPrinterMetrics")).toBe("boolean false")
		// Word's layout: tab stops from the margin, its table and wrapping rules.
		expect(word2013.get("TabsRelativeToIndent")).toBe("boolean false")
		expect(word2013.get("TableRowKeep")).toBe("boolean true")
		expect(word2013.get("TabOverMargin")).toBe("boolean false")
		expect(word2013.size).toBe(57)
		// What is no layout: the printer, the session, protection unless set.
		expect(word2013.has("PrinterName")).toBe(false)
		expect(word2013.has("Rsid")).toBe(false)
		expect(word2013.has("LoadReadonly")).toBe(false)

		// Before Word 2013's layout (an earlier compatibility mode, or none), and each compatibility option LibreOffice
		// keeps; an option set off is none.
		const changed = (from: Map<string | undefined, string>): Record<string, string> =>
			Object.fromEntries([...from].filter(([name, value]) => word2013.get(name) !== value))
		const earlier = { AddFrameOffsets: "boolean true", MsWordCompMinLineHeightByFly: "boolean true", TabOverMargin: "boolean true" }

		expect(changed(await items(""))).toEqual(earlier)
		// Without a settings part LibreOffice keeps fixed paragraph spacing for HTML auto spacing too.
		expect(changed(await items())).toEqual({ ...earlier, AddParaTableSpacing: "boolean true" })
		expect(changed(await items(`<w:compat>${MODE.replace('"15"', '"14"')}</w:compat>`))).toEqual(earlier)
		expect(
			changed(
				await items(
					`<w:gutterAtTop/><w:compat><w:noLeading/><w:usePrinterMetrics/><w:doNotExpandShiftReturn/><w:doNotUseHTMLParagraphAutoSpacing/><w:spaceForUL/>${MODE}</w:compat>`
				)
			)
		).toEqual({
			AddExternalLeading: "boolean false",
			PrinterIndependentLayout: "string disabled",
			DoNotJustifyLinesWithManualBreak: "boolean true",
			AddParaTableSpacing: "boolean true",
			GutterAtTop: "boolean true"
		})
		expect(
			changed(await items(`<w:compat><w:noLeading w:val="0"/><w:doNotExpandShiftReturn w:val="false"/>${MODE}</w:compat>`))
		).toEqual({})
	})

	it("joins a Word 97–2003 document's protection report with what the OpenDocument text keeps", async () => {
		const server = docxConvertServer({ pause: () => Promise.resolve(), sliceMs: 1_000_000, now: () => 0 })
		const doc = async (setup: (dop: Uint8Array) => void): Promise<Uint8Array> => {
			const dop = new Uint8Array(616)

			setup(dop)

			return buildDoc({ pieces: [{ text: "x\r" }], structures: { dop }, nFib: 0x10d })
		}
		// Forms protection (Dop2003's iDocProtCur 2, enforced) with a password: kept, its password not.
		const forms = await server.convert(
			1,
			await doc(dop => {
				new DataView(dop.buffer).setUint32(78, 0x1234_5678, true)
				dop[598] = 0x08 | (2 << 4)
			}),
			"doc",
			"odt"
		)
		// Comments-only editing: the .docx keeps it, the OpenDocument text does not.
		const comments = await server.convert(1, await doc(dop => (dop[598] = 0x08 | (1 << 4))), "doc", "odt")

		if (!forms.ok || !comments.ok) throw new Error("refused")

		expect(forms.lossy.features).toEqual([{ kind: "passwordProtection", count: 1 }])
		expect(decodeUtf8((await odtParts(forms.bytes)).get("settings.xml") ?? new Uint8Array())).toContain(
			'"ProtectForm" config:type="boolean">true<'
		)
		expect(comments.lossy.features).toEqual([{ kind: "documentProtection", count: 1 }])
	})

	it("numbers a list from 0 as Word does, counting a deeper level that restarts at 1 (ODF level styles start at 1)", async () => {
		const level = (ilvl: number): string =>
			`<w:lvl w:ilvl="${String(ilvl)}"><w:start w:val="0"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${String(ilvl + 1)}."/></w:lvl>`
		const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0">${level(0)}${level(1)}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`
		const { parts, features } = await converted({
			body: p("Zero", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
			parts: [{ name: "word/numbering.xml", contentType: `${WML}.numbering+xml`, data: numbering }],
			relationships: [{ id: "rIdN", type: "numbering", target: "numbering.xml" }]
		})

		expect(parts.get("styles.xml")).toMatch(/<text:list-level-style-number text:level="1" style:num-format="1"/u)
		expect(parts.get("styles.xml")).not.toMatch(/text:start-value="0"/u)
		expect(parts.get("content.xml")).toMatch(/<text:list-item text:start-value="0"><text:p[^>]*>Zero</u)
		expect(features).toEqual([{ kind: "listFormat", count: 1 }])
	})

	it("writes link targets as URIs (RFC 3986), keeping a link that cannot be one as its text, counted", async () => {
		const link = (id: string, text: string): string => `<w:hyperlink r:id="${id}"><w:r><w:t>${text}</w:t></w:r></w:hyperlink>`
		const targets = [
			"&quot;http://example.com/",
			"http://example.com/a b/ü?q=[1]",
			"#A#B",
			"G:\\dir\\f.xls#R",
			"mailto:",
			"https://[::1]:80/x",
			"https://example.com/page.htm"
		]
		const { parts, features } = await converted(
			spec(
				`<w:p>${targets.map((_, k) => link(`rIdT${String(k)}`, `t${String(k)}`)).join("")}` +
					// An external link that also names a place in its target, and a HYPERLINK field naming both.
					'<w:hyperlink r:id="rIdT6" w:anchor="a b#1%"><w:r><w:t>t7</w:t></w:r></w:hyperlink>' +
					'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.com/f.htm" \\l "p 2" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>t8</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' +
					// A field's quoted text holds a backslash or quotation mark escaped by a backslash; a fragment's escapes stay.
					'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "file:///C:\\\\d\\\\a\\&quot;b.xls" \\l "S!A1#%20" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>t9</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
				{
					relationships: targets.map((target, k) => ({ id: `rIdT${String(k)}`, type: "hyperlink", target, external: true }))
				}
			)
		)
		const hrefs = [...(parts.get("content.xml") ?? "").matchAll(/<text:a [^>]*xlink:href="([^"]*)">(t\d)</gu)].map(match => [
			match[2],
			match[1]
		])

		expect(hrefs).toEqual([
			["t0", "./%22http://example.com/"],
			["t1", "http://example.com/a%20b/%C3%BC?q=%5B1%5D"],
			["t2", "#A%23B"],
			["t3", "file:///G:/dir/f.xls#R"],
			["t5", "https://[::1]:80/x"],
			["t6", "https://example.com/page.htm"],
			["t7", "https://example.com/page.htm#a%20b%231%25"],
			["t8", "https://example.com/f.htm#p%202"],
			["t9", "file:///C:%5Cd%5Ca%22b.xls#S!A1%23%20"]
		])
		expect(parts.get("content.xml")).toMatch(/>t4</u)
		expect(features).toEqual([{ kind: "linkTarget", count: 1 }])
	})
})

const BEGIN = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
const SEPARATE = '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
const END = '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
const instruction = (code: string): string => `<w:r><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r>`
const inserted = (markup: string, id: number): string =>
	`<w:ins w:id="${String(id)}" w:author="A" w:date="2024-01-01T00:00:00Z">${markup}</w:ins>`

describe("convertText docx → odt: fields across inline elements", () => {
	it("keeps the result of a field whose separator and end sit in different changes as text, counted", async () => {
		for (const code of ["PAGE", 'HYPERLINK "https://filen.io/"']) {
			const { parts, features } = await converted(
				spec(
					`<w:p>${inserted(BEGIN, 1)}${inserted(instruction(code), 2)}${inserted(SEPARATE, 3)}${inserted("<w:r><w:t>1</w:t></w:r>", 4)}${inserted(END, 5)}</w:p>`
				)
			)
			const content = parts.get("content.xml") ?? ""

			expect(() => parseXml(encodeUtf8(content))).not.toThrow()
			expect(content).toMatch(/>1</u)
			expect(content).not.toContain("text:page-number")
			expect(content).not.toContain("<text:a ")
			expect(features).toEqual([{ kind: "field", count: 1 }])
		}
	})

	it("keeps the result of a field that starts inside a hyperlink and ends outside it as text", async () => {
		const { parts, features } = await converted(
			spec(
				`<w:p><w:hyperlink r:id="rIdLink">${BEGIN}${instruction("PAGE")}${SEPARATE}<w:r><w:t>2</w:t></w:r></w:hyperlink>${END}</w:p>`
			)
		)
		const content = parts.get("content.xml") ?? ""

		expect(() => parseXml(encodeUtf8(content))).not.toThrow()
		expect(content).toContain('<text:a xlink:type="simple" xlink:href="https://filen.io/">2</text:a>')
		expect(features).toEqual([{ kind: "field", count: 1 }])
	})

	it("still writes a field wholly inside one change as a field", async () => {
		const { parts, features } = await converted(
			spec(`<w:p>${inserted(`${BEGIN}${instruction("PAGE")}${SEPARATE}<w:r><w:t>3</w:t></w:r>${END}`, 1)}</w:p>`)
		)

		expect(parts.get("content.xml")).toMatch(/<text:page-number text:select-page="current">3<\/text:page-number>/u)
		expect(features).toEqual([])
	})

	it("converts a Word 97–2003 document's tracked inserted PAGE field (each field character its own w:ins)", async () => {
		const insert = prl.toggle(0x0801, 1)
		const special = [...prl.toggle(0x0855, 1), ...insert]
		const doc = await buildDoc({
			pieces: [{ text: "\u0013 PAGE \u00141\u0015\r" }],
			runs: [
				{ start: 0, end: 1, grpprl: special },
				{ start: 1, end: 7, grpprl: insert },
				{ start: 7, end: 8, grpprl: special },
				{ start: 8, end: 9, grpprl: insert },
				{ start: 9, end: 10, grpprl: special }
			],
			structures: {
				plcfFldMom: plc(
					[0, 7, 9, 11],
					[
						[0x13, 33],
						[0x14, 0],
						[0x15, 0x80]
					]
				)
			}
		})
		const docx = await convertText(doc, "doc", "docx")

		if (!docx.ok) throw new Error(docx.refusal.message)

		expect(decodeUtf8((await odtParts(docx.bytes)).get("word/document.xml") ?? new Uint8Array())).toMatch(
			/<w:ins [^>]*><w:r>(?:<w:rPr>.*?<\/w:rPr>)?<w:fldChar w:fldCharType="separate"\/>/u
		)

		const odt = await convertText(docx.bytes, "docx", "odt")

		if (!odt.ok) throw new Error(odt.refusal.message)

		const content = decodeUtf8((await odtParts(odt.bytes)).get("content.xml") ?? new Uint8Array())

		expect(() => parseXml(encodeUtf8(content))).not.toThrow()
		expect(content).toMatch(/>1</u)
		expect(odt.lossy.features).toContainEqual({ kind: "field", count: 1 })
	})

	it("keeps the result of a PAGE field that a page break splits as text, counted", async () => {
		const { parts, features } = await converted(
			spec(`<w:p>${BEGIN}${instruction("PAGE")}${SEPARATE}<w:r><w:t>1</w:t><w:br w:type="page"/><w:t>2</w:t></w:r>${END}</w:p>`)
		)
		const content = parts.get("content.xml") ?? ""

		expect(() => parseXml(encodeUtf8(content))).not.toThrow()
		expect(content).toMatch(/>1</u)
		expect(content).toMatch(/>2</u)
		expect(content).not.toContain("text:page-number")
		expect(features).toEqual([{ kind: "field", count: 1 }])
	})

	it("lowers a story with many unclosed fields in time linear in its size", () => {
		const pair = '<w:r><w:fldChar w:fldCharType="begin"/><w:fldChar w:fldCharType="separate"/></w:r>'
		const document = parseXml(
			encodeUtf8(
				`<w:document ${LOWERED_NAMESPACES}><w:body><w:p>${pair.repeat(100_000)}${"<w:r><w:t>x</w:t></w:r>".repeat(10_000)}</w:p></w:body></w:document>`
			)
		)
		const lowering = new Lowering(new LossyCounts(), new LoweredIds(), undefined)
		const { blocks } = lowering.openBody(document, { relationship: () => undefined })
		const started = performance.now()
		const { xml } = lowering.lowerBlocks(blocks, true)

		expect(performance.now() - started).toBeLessThan(2000)
		expect(xml.split("<w:t ").length - 1).toBe(10_000)
	})
})

describe("convertText docx → odt: spacing, escaping", () => {
	it("writes a style's automatic spacing as a paragraph's (14 pt before and after), its line spacing kept, counted", async () => {
		const spacing =
			'<w:spacing w:before="100" w:beforeAutospacing="1" w:after="100" w:afterAutospacing="1" w:line="360" w:lineRule="auto"/>'
		const styles = STYLES.replace(
			"</w:styles>",
			`<w:style w:type="paragraph" w:styleId="NormalWeb"><w:name w:val="Normal (Web)"/><w:basedOn w:val="Normal"/><w:pPr>${spacing}</w:pPr></w:style></w:styles>`
		)
		const { parts, features } = await converted({
			body:
				p("Web", '<w:pStyle w:val="NormalWeb"/>') +
				p("Direct", spacing) +
				'<w:p><w:r><w:rPr><w:spacing w:val="20"/></w:rPr><w:t>Spaced</w:t></w:r></w:p>',
			parts: [{ name: "word/styles.xml", contentType: `${WML}.styles+xml`, data: styles }],
			relationships: [{ id: "rIdS", type: "styles", target: "styles.xml" }]
		})
		const style = /<style:style style:name="NormalWeb"[^>]*>(.*?)<\/style:style>/u.exec(parts.get("styles.xml") ?? "")?.[1] ?? ""
		const content = parts.get("content.xml") ?? ""

		expect(style).toContain('fo:margin-top="14pt"')
		expect(style).toContain('fo:margin-bottom="14pt"')
		expect(style).toContain('fo:line-height="150%"')
		expect(content).toContain('<style:paragraph-properties fo:line-height="150%" fo:margin-bottom="14pt" fo:margin-top="14pt"/>')
		expect(content).toContain('fo:letter-spacing="1pt"')
		expect(features).toEqual([{ kind: "paragraphFormat", count: 4 }])
	})

	it("keeps line breaks and tabs in a picture's description", async () => {
		const { parts } = await converted(spec(`<w:p>${PICTURE.replace('descr="A dot"', 'descr="Line one&#10;Line two&#9;end"')}</w:p>`))

		expect(parts.get("content.xml")).toContain("<svg:desc>Line one\nLine two\tend</svg:desc>")
	})

	it("converts a paragraph split by a page break whose properties hold a value with '/>'", async () => {
		const { parts } = await converted(
			spec('<w:p><w:pPr><w:keepNext w:val="a/&gt;b"/></w:pPr><w:r><w:t>x</w:t><w:br w:type="page"/><w:t>y</w:t></w:r></w:p>')
		)
		const content = parts.get("content.xml") ?? ""

		expect(() => parseXml(encodeUtf8(content))).not.toThrow()
		expect(content).toMatch(/>x</u)
		expect(content).toMatch(/>y</u)
	})

	it("writes a symbol run's own font when its run fonts hold a value with '/>'", async () => {
		const { parts } = await converted(
			spec(
				'<w:p><w:r><w:rPr><w:rStyle w:val="s/&gt;t"/><w:rFonts w:ascii="A/&gt;B"/></w:rPr><w:sym w:font="Odd/&gt;Font" w:char="0041"/></w:r></w:p>'
			)
		)
		const content = parts.get("content.xml") ?? ""

		expect(() => parseXml(encodeUtf8(content))).not.toThrow()
		expect(content).toMatch(/>A</u)
		expect(content).toContain('style:font-name="Odd/>Font"')
	})
})

describe("odt → docx: the paragraph-padding setting", () => {
	const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
	const lossOf = (body: string): readonly string[] => {
		const parts = new Map([
			["word/document.xml", encodeUtf8(`<w:document ${W}><w:body>${body}</w:body></w:document>`)],
			["word/styles.xml", encodeUtf8(`<w:styles ${W}/>`)],
			[
				"word/settings.xml",
				encodeUtf8(
					`<w:settings ${W}><w:compat><w:compatSetting w:name="paragraph-padding" w:uri="urn:filen" w:val="borders"/></w:compat></w:settings>`
				)
			]
		])
		const lossy = new LossyCounts()

		standaloneParts(parts, lossy)

		expect(decodeUtf8(parts.get("word/settings.xml") ?? new Uint8Array())).not.toContain("paragraph-padding")

		return lossy.report("odt", "docx").features.map(feature => feature.kind)
	}

	it("counts a paragraph with a left or right border, and nothing for a document without paragraph borders", () => {
		expect(
			lossOf('<w:p><w:pPr><w:pBdr><w:left w:val="single" w:sz="4" w:space="1" w:color="000000"/></w:pBdr></w:pPr></w:p>')
		).toContain("paragraphPadding")
		expect(
			lossOf('<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="1" w:color="000000"/></w:pBdr></w:pPr></w:p>')
		).not.toContain("paragraphPadding")
		expect(lossOf('<w:p><w:pPr><w:ind w:left="720"/></w:pPr><w:r><w:t>plain</w:t></w:r></w:p>')).not.toContain("paragraphPadding")
	})
})
