import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { cfbBytes, CfbFile, type CfbWriteEntry } from "@filen/office/core/cfb"
import { bytesSource, memorySink, ZipArchive } from "@filen/office/core/opc"
import { pptToPptx } from "../core/ppt/toPptx"
import { richDeck } from "./pptFixtures"
import { convertPresentation, type ConversionLoss, type ConversionSource } from "../core/convert/presentation/index"
import { openOdp } from "../core/odp/read/document"
import { openPptx } from "../core/pptx/package"
import { CORPUS_DIR } from "./corpusDir"
import { odpBytes, page } from "./odpFixtures"
import { body, buildPptx, para, sp } from "./pptxFixtures"

// What a conversion carries over between PresentationML and OpenDocument beyond the slides: comments (pptx comments
// as officeooo:annotation and back), the document's properties (docProps core and custom ↔ meta.xml), and what it
// cannot carry named in its report (replies and resolved state, sections, embedded fonts, macros), never dropped.

const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const P188 =
	'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"'
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"
const CUSTOM = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties"
const MODERN_REL = "http://schemas.microsoft.com/office/2018/10/relationships/comments"
const AUTHORS_REL = "http://schemas.microsoft.com/office/2018/10/relationships/authors"
const ANN = "{11111111-1111-4111-8111-111111111111}"

async function entryText(bytes: Uint8Array, name: string): Promise<string | undefined> {
	const zip = await ZipArchive.open(bytesSource(bytes))
	const entry = zip.get(name)

	return entry === undefined ? undefined : new TextDecoder().decode(await zip.read(entry))
}

async function names(bytes: Uint8Array): Promise<string[]> {
	return (await ZipArchive.open(bytesSource(bytes))).entries.map(entry => entry.name)
}

async function pptxToOdp(bytes: Uint8Array): Promise<{ readonly out: Uint8Array; readonly losses: readonly ConversionLoss[] }> {
	const open = await openPptx(bytesSource(bytes))

	if (open.kind !== "opened") throw new Error(open.reason)

	const input = {
		format: "pptx",
		parts: open.parts,
		source: { archive: await ZipArchive.open(bytesSource(bytes)), package: open.parts.opc }
	} as ConversionSource
	const sink = memorySink()
	const converted = await convertPresentation(open.deck, input, "odp", sink)

	if ("kind" in converted) throw new Error(`${converted.reason} ${converted.detail ?? ""}`)

	return { out: sink.bytes(), losses: converted.losses }
}

async function odpToPptx(bytes: Uint8Array): Promise<{ readonly out: Uint8Array; readonly losses: readonly ConversionLoss[] }> {
	const open = await openOdp(bytesSource(bytes))

	if (open.kind !== "opened") throw new Error(open.reason)

	const sink = memorySink()
	const converted = await convertPresentation(open.deck, { format: "odp", parts: open.parts }, "pptx", sink)

	if ("kind" in converted) throw new Error(`${converted.reason} ${converted.detail ?? ""}`)

	return { out: sink.bytes(), losses: converted.losses }
}

function countOf(losses: readonly ConversionLoss[], kind: string): number {
	return losses.find(loss => loss.kind === kind)?.count ?? 0
}

function commentedDeck(): Uint8Array {
	const legacy = `<p:cmLst ${P}><p:cm authorId="0" dt="2024-03-01T09:00:00.000" idx="1"><p:pos x="80" y="160"/><p:text>Legacy note &amp; more</p:text></p:cm></p:cmLst>`
	const modern =
		`<p188:cmLst ${P188}><p188:cm id="{AAAAAAAA-0000-4000-8000-000000000001}" authorId="${ANN}" created="2024-03-02T10:00:00.000" status="resolved">` +
		`<p188:replyLst><p188:reply id="{AAAAAAAA-0000-4000-8000-000000000002}" authorId="${ANN}" created="2024-03-02T11:00:00.000"><p188:txBody><a:bodyPr/><a:p><a:r><a:t>A reply</a:t></a:r></a:p></p188:txBody></p188:reply></p188:replyLst>` +
		'<p188:pos x="1270000" y="635000"/><p188:txBody><a:bodyPr/><a:p><a:r><a:t>Modern root</a:t></a:r></a:p></p188:txBody></p188:cm></p188:cmLst>'

	return buildPptx({
		slides: [
			{ shapes: sp(2, "T", undefined, "", body(para("One"))), rels: [["rIdC", "comments", "../comments/comment1.xml"]] },
			{ shapes: sp(2, "T", undefined, "", body(para("Two"))), rels: [["rIdM", MODERN_REL, "../comments/modernComment_1.xml"]] }
		],
		presentationRels: [
			["rId81", "commentAuthors", "commentAuthors.xml"],
			["rId82", AUTHORS_REL, "authors.xml"]
		],
		packageRels: [
			["rId2", PKG, "docProps/core.xml"],
			["rId3", CUSTOM, "docProps/custom.xml"]
		],
		parts: {
			"ppt/comments/comment1.xml": {
				type: "application/vnd.openxmlformats-officedocument.presentationml.comments+xml",
				data: legacy
			},
			"ppt/comments/modernComment_1.xml": { type: "application/vnd.ms-powerpoint.comments+xml", data: modern },
			"ppt/commentAuthors.xml": {
				type: "application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml",
				data: `<p:cmAuthorLst ${P}><p:cmAuthor id="0" name="Lee Legacy" initials="LL" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`
			},
			"ppt/authors.xml": {
				type: "application/vnd.ms-powerpoint.authors+xml",
				data: `<p188:authorLst ${P188}><p188:author id="${ANN}" name="Ann Modern" initials="AM" userId="Ann Modern" providerId="None"/></p188:authorLst>`
			},
			"docProps/core.xml": {
				type: "application/vnd.openxmlformats-package.core-properties+xml",
				data:
					'<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
					"<dc:title>Water Finance</dc:title><dc:creator>Cora Creator</dc:creator><cp:keywords>rivers, money</cp:keywords>" +
					'<dcterms:created xsi:type="dcterms:W3CDTF">2024-01-02T03:04:05Z</dcterms:created><cp:category>Reports</cp:category></cp:coreProperties>'
			},
			"docProps/custom.xml": {
				type: "application/vnd.openxmlformats-officedocument.custom-properties+xml",
				data:
					'<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
					'<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Project"><vt:lpwstr>Delta</vt:lpwstr></property>' +
					'<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="Budget"><vt:r8>12.5</vt:r8></property>' +
					'<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="4" name="Blob"><vt:blob>AAAA</vt:blob></property></Properties>'
			}
		}
	})
}

describe("a .pptx converted to .odp", () => {
	it("writes its comments as annotations, naming replies and resolved state it cannot keep", { timeout: 60_000 }, async () => {
		const { out, losses } = await pptxToOdp(commentedDeck())
		const content = (await entryText(out, "content.xml")) ?? ""
		const annotations = content.match(/<officeooo:annotation\b/gu) ?? []

		expect(annotations).toHaveLength(3)
		expect(content).toContain("<dc:creator>Lee Legacy</dc:creator>")
		expect(content).toContain("<dc:creator>Ann Modern</dc:creator>")
		expect(content).toContain("Legacy note &amp; more")
		expect(content).toContain("A reply")
		expect(countOf(losses, "commentReply")).toBe(1)
		expect(countOf(losses, "commentState")).toBe(1)

		const back = await openOdp(bytesSource(out))

		if (back.kind !== "opened") throw new Error(back.reason)
	})

	it("writes its core and custom properties into meta.xml, naming the ones ODF has no place for", { timeout: 60_000 }, async () => {
		const { out, losses } = await pptxToOdp(commentedDeck())
		const meta = (await entryText(out, "meta.xml")) ?? ""
		const manifest = (await entryText(out, "META-INF/manifest.xml")) ?? ""

		expect(meta).toContain("<dc:title>Water Finance</dc:title>")
		expect(meta).toContain("<meta:initial-creator>Cora Creator</meta:initial-creator>")
		expect(meta).toContain("<meta:creation-date>2024-01-02T03:04:05Z</meta:creation-date>")
		expect(meta).toContain("<meta:keyword>rivers, money</meta:keyword>")
		expect(meta).toContain('<meta:user-defined meta:name="Project">Delta</meta:user-defined>')
		expect(meta).toContain('<meta:user-defined meta:name="Budget" meta:value-type="float">12.5</meta:user-defined>')
		expect(manifest).toContain('manifest:full-path="meta.xml"')
		// The category and the binary custom property have no form in meta.xml.
		expect(countOf(losses, "properties")).toBe(2)
	})

	for (const [file, kind] of [
		["pptx/lo__slide-sections.pptx", "section"],
		["pptx/lo__BoldonseFontEmbedded.pptx", "embeddedFont"],
		["pptm/lo__macro.pptm", "macros"]
	] as const)
		it.skipIf(!existsSync(join(CORPUS_DIR, file)))(`names what it cannot keep: ${kind} (corpus)`, { timeout: 120_000 }, async () => {
			const { losses } = await pptxToOdp(new Uint8Array(readFileSync(join(CORPUS_DIR, file))))

			expect(countOf(losses, kind)).toBeGreaterThan(0)
		})

	it.skipIf(!existsSync(join(CORPUS_DIR, "pptx/poi__45545_Comment.pptx")))(
		"keeps every comment of a corpus deck (corpus)",
		{ timeout: 120_000 },
		async () => {
			const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, "pptx/poi__45545_Comment.pptx")))
			const source = await names(bytes)
			const { out } = await pptxToOdp(bytes)
			const content = (await entryText(out, "content.xml")) ?? ""
			let expected = 0

			for (const name of source.filter(each => /^ppt\/comments\/comment\d+\.xml$/u.test(each)))
				expected += ((await entryText(bytes, name)) ?? "").match(/<p:cm\b/gu)?.length ?? 0

			expect(expected).toBeGreaterThan(0)
			expect(content.match(/<officeooo:annotation\b/gu)?.length ?? 0).toBe(expected)
		}
	)
})

describe("an .odp converted to .pptx", () => {
	const annotation =
		'<officeooo:annotation xmlns:dc="http://purl.org/dc/elements/1.1/" svg:x="1cm" svg:y="2cm" svg:width="1cm" svg:height="1cm"><dc:creator>Ann</dc:creator><dc:date>2026-01-01T00:00:00</dc:date><text:p>Look here</text:p><text:p>and here</text:p></officeooo:annotation>'
	const frame =
		'<draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>T</text:p></draw:text-box></draw:frame>'
	const meta =
		'<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.3"><office:meta>' +
		"<dc:title>River Notes</dc:title><meta:initial-creator>Ivo Initial</meta:initial-creator><dc:creator>Lia Last</dc:creator><meta:keyword>delta</meta:keyword>" +
		'<meta:user-defined meta:name="Project">Delta</meta:user-defined><meta:user-defined meta:name="Budget" meta:value-type="float">12.5</meta:user-defined></office:meta></office:document-meta>'
	const deck = () =>
		odpBytes({
			body: page(`${annotation}${frame}`),
			extra: [
				{ name: "meta.xml", data: new TextEncoder().encode(meta), mediaType: "text/xml" },
				{
					name: "Basic/Standard/Module1.xml",
					data: new TextEncoder().encode(
						'<?xml version="1.0" encoding="UTF-8"?><script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">Sub Main\nEnd Sub</script:module>'
					),
					mediaType: "text/xml"
				}
			]
		})

	it("writes its annotations as comments with their authors", { timeout: 60_000 }, async () => {
		const { out } = await odpToPptx(deck())
		const parts = await names(out)
		const comments = parts.filter(name => /^ppt\/comments\/comment\d+\.xml$/u.test(name))

		expect(comments).toHaveLength(1)

		const part = (await entryText(out, comments[0] as string)) ?? ""

		expect(part).toContain("Look here\nand here")
		expect(part).toMatch(/ dt="20\d\d-\d\d-\d\dT[^"]+"/u)
		expect((await entryText(out, "ppt/commentAuthors.xml")) ?? "").toContain('name="Ann"')

		const back = await openPptx(bytesSource(out))

		if (back.kind !== "opened") throw new Error(back.reason)
	})

	it("writes its meta.xml into docProps, and names the macro library it cannot keep", { timeout: 60_000 }, async () => {
		const { out, losses } = await odpToPptx(deck())
		const core = (await entryText(out, "docProps/core.xml")) ?? ""
		const custom = (await entryText(out, "docProps/custom.xml")) ?? ""

		expect(core).toContain("<dc:title>River Notes</dc:title>")
		expect(core).toContain("<dc:creator>Ivo Initial</dc:creator>")
		expect(core).toContain("<cp:lastModifiedBy>Lia Last</cp:lastModifiedBy>")
		expect(core).toContain("<cp:keywords>delta</cp:keywords>")
		expect(custom).toContain('name="Project"><vt:lpwstr>Delta</vt:lpwstr>')
		expect(custom).toContain('name="Budget"><vt:r8>12.5</vt:r8>')
		expect(countOf(losses, "macros")).toBe(1)
	})
})

describe("a signed .ppt saved as .pptx", () => {
	for (const storage of ["_signatures", "_xmlsignatures"])
		it(`names the ${storage} signature it cannot keep`, async () => {
			const file = await CfbFile.open(bytesSource((await richDeck()).bytes))
			const entries: CfbWriteEntry[] = []

			for (const entry of [...file.walk()].slice(1))
				if (entry.kind === "stream") entries.push({ path: entry.path, bytes: await file.read(entry) })

			entries.push({ path: [storage], storage: true }, { path: [storage, "1"], bytes: Uint8Array.of(1, 2, 3) })

			const converted = await pptToPptx(bytesSource(await cfbBytes(entries)))

			if (converted.kind !== "converted") throw new Error(converted.reason)

			expect(countOf(converted.losses, "signature")).toBe(1)
		})
})
