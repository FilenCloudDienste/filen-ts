import { afterEach, describe, expect, it } from "vitest"
import { ZipArchive, bytesSource } from "@filen/office/core/opc"
import { openDocxPackage } from "@filen/office/core/docx"
import { saveDocx } from "@filen/office/core/docx/write"
import { OBJECT_INTS } from "../../core/docx/layout/index"
import { DocxEngine, type DocxEvent, type DocxLinkTarget } from "@filen/office/dom/docx"
import { linkActivator } from "../../react/docx/links"
import { buildDocx, type ExtraPart, type ExtraRelationship } from "../docxSynthetic"
import { buildZip } from "../zipBuilder"
import { pagedEditor, settleAll } from "../pagedFixtures"
import { countingSource, deflateRawZeros, engineServices, trapGlobals, type Trap } from "./generate"

// Risky document content is inert: nothing is fetched, opened or run, risky fields keep their cached
// results, and embedded payloads are never read and are written back byte for byte.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function field(instruction: string, result: string): string {
	return (
		'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
		`<w:r><w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r>` +
		`<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${result}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
	)
}

// Field instructions that would reach a file, the network, another program or a macro if evaluated.
const RISKY_FIELDS: readonly (readonly [string, string])[] = [
	['DDEAUTO excel "C:\\\\data\\\\book.xls" "R1C1"', "DDEAUTO-CACHED"],
	['DDE excel "C:\\\\data\\\\book.xls" "R1C1"', "DDE-CACHED"],
	['INCLUDEPICTURE "http://attacker.invalid/p.png" \\d', "INCLUDEPICTURE-CACHED"],
	['INCLUDETEXT "\\\\\\\\attacker.invalid\\\\share\\\\a.docx"', "INCLUDETEXT-CACHED"],
	['LINK Excel.Sheet.12 "C:\\\\a.xlsx" "Sheet1!R1C1" \\a \\f 4', "LINK-CACHED"],
	['IMPORT "http://attacker.invalid/x.wmf"', "IMPORT-CACHED"],
	["MACROBUTTON AutoOpen Click", "MACROBUTTON-CACHED"],
	["GOTOBUTTON target Go", "GOTOBUTTON-CACHED"],
	['DATABASE \\d "C:\\\\db.mdb" \\s "SELECT 1"', "DATABASE-CACHED"],
	["AUTOTEXT Signature", "AUTOTEXT-CACHED"],
	['HYPERLINK "javascript:alert(document.domain)"', "JSLINK-CACHED"],
	['HYPERLINK "file:///etc/passwd"', "FILELINK-CACHED"]
]

const PICTURE = "http://schemas.openxmlformats.org/drawingml/2006/picture"
const PNG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0)

function picture(blip: string): string {
	return (
		'<w:p><w:r><w:drawing><wp:inline><wp:extent cx="95250" cy="95250"/><wp:docPr id="1" name="d"/><a:graphic>' +
		`<a:graphicData uri="${PICTURE}"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr>` +
		`<pic:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/>` +
		'<a:ext cx="95250" cy="95250"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
	)
}

// An embedded workbook that is itself a zip bomb, should anything ever open it.
const NESTED_BOMB = buildZip([
	{ name: "[Content_Types].xml", data: encoder.encode("<Types/>") },
	{ name: "xl/workbook.xml", data: new Uint8Array(0), compressed: deflateRawZeros(256), uncompressedSize: 0xfffffff0, crc: 0 }
])

const PAYLOADS: readonly ExtraPart[] = [
	{
		name: "word/embeddings/oleObject1.bin",
		contentType: "application/vnd.openxmlformats-officedocument.oleObject",
		data: new Uint8Array(4096).fill(0xd0)
	},
	{
		name: "word/embeddings/Microsoft_Excel_Worksheet.xlsx",
		contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		data: NESTED_BOMB
	},
	{ name: "word/activeX/activeX1.bin", contentType: "application/vnd.ms-office.activeX", data: new Uint8Array(2048).fill(0xac) },
	{ name: "word/vbaProject.bin", contentType: "application/vnd.ms-office.vbaProject", data: new Uint8Array(2048).fill(0xba) },
	{
		name: "word/afchunk.htm",
		contentType: "text/html",
		data: '<html><body><script>alert(1)</script><img src="http://attacker.invalid/a.png">chunk</body></html>'
	}
]

const RELATIONSHIPS: readonly ExtraRelationship[] = [
	{ id: "rImg", type: "image", target: "media/image1.png" },
	{ id: "rExtImg", type: "image", target: "http://attacker.invalid/linked.png", external: true },
	{ id: "rOle", type: "oleObject", target: "embeddings/oleObject1.bin" },
	{ id: "rPkg", type: "package", target: "embeddings/Microsoft_Excel_Worksheet.xlsx" },
	{ id: "rAx", type: "control", target: "activeX/activeX1.bin" },
	{ id: "rVba", type: "vbaProject", target: "vbaProject.bin" },
	{ id: "rAlt", type: "aFChunk", target: "afchunk.htm" },
	{ id: "rSub", type: "subDocument", target: "file:///C:/secret/sub.docx", external: true },
	{ id: "rJs", type: "hyperlink", target: "javascript:alert(document.domain)", external: true },
	{ id: "rUnc", type: "hyperlink", target: "\\\\attacker.invalid\\share", external: true }
]

const BODY =
	"<w:p><w:r><w:t>start</w:t></w:r></w:p>" +
	RISKY_FIELDS.map(([instruction, result]) => field(instruction, result)).join("") +
	picture('<a:blip r:link="rExtImg"/>') +
	picture('<a:blip r:embed="rExtImg"/>') +
	'<w:p><w:r><w:pict><v:shape id="ext" style="width:20pt;height:20pt"><v:imagedata r:id="rExtImg"/></v:shape></w:pict></w:r></w:p>' +
	'<w:p><w:r><w:object><v:shape id="ole" style="width:20pt;height:20pt"><v:imagedata r:id="rImg"/></v:shape>' +
	'<o:OLEObject Type="Embed" ProgID="Package" ShapeID="ole" DrawAspect="Content" ObjectID="_1" r:id="rOle"/></w:object></w:r></w:p>' +
	'<w:p><w:r><w:object><v:shape id="xl" style="width:20pt;height:20pt"><v:imagedata r:id="rImg"/></v:shape>' +
	'<o:OLEObject Type="Embed" ProgID="Excel.Sheet.12" ShapeID="xl" DrawAspect="Content" ObjectID="_2" r:id="rPkg"/></w:object></w:r></w:p>' +
	'<w:p><w:r><w:object><v:shape id="ax" style="width:20pt;height:20pt"><v:imagedata r:id="rImg"/></v:shape>' +
	'<w:control r:id="rAx" w:name="CheckBox1" w:shapeid="ax"/></w:object></w:r></w:p>' +
	'<w:altChunk r:id="rAlt"/><w:subDoc r:id="rSub"/>' +
	'<w:p><w:hyperlink r:id="rJs"><w:r><w:t>js</w:t></w:r></w:hyperlink><w:hyperlink r:id="rUnc"><w:r><w:t>unc</w:t></w:r></w:hyperlink></w:p>'

// Incompressible bytes after the payloads, so the end-record search (the archive's last 64 KiB) never covers
// them and any read of a payload is a real one.
const PADDING = Uint8Array.from({ length: 160 * 1024 }, (_, k) => (Math.imul(k, 2654435761) >>> 24) ^ (k & 0xff))

const DOCUMENT = buildDocx({
	body: BODY,
	relationships: RELATIONSHIPS,
	parts: [{ name: "word/media/image1.png", data: PNG }, ...PAYLOADS, { name: "word/padding.bin", data: PADDING }]
})

// Byte ranges (local header to the end of the data) of the embedded payloads.
async function payloadRanges(bytes: Uint8Array): Promise<Map<string, readonly [number, number]>> {
	const archive = await ZipArchive.open(bytesSource(bytes))
	const ranges = new Map<string, readonly [number, number]>()

	for (const { name } of PAYLOADS) {
		const entry = archive.get(name)

		if (entry === undefined) throw new Error(`missing ${name}`)

		const layout = await archive.layout(entry)

		ranges.set(name, [entry.localHeaderOffset, layout.dataOffset + entry.compressedSize])
	}

	return ranges
}

describe("inert content", () => {
	let trap: Trap | undefined

	afterEach(() => {
		trap?.restore()
		trap = undefined
	})

	it("views the document without a fetch, an open or a payload read", async () => {
		const source = countingSource(DOCUMENT)
		const events: DocxEvent[] = []

		trap = trapGlobals()

		const engine = new DocxEngine(source, engineServices(), event => events.push(event))

		await engine.run()

		expect(events.some(event => event.type === "pages" && event.final)).toBe(true)

		// What a renderer asks for: every object on the pages, then every picture those objects name.
		const ids = new Set<number>()

		for (const event of events) {
			if (event.type !== "pages") continue

			for (const page of event.pages) {
				for (let k = 0; k < page.objectCount; k++) ids.add(page.objectInts[k * OBJECT_INTS] ?? -1)
			}
		}

		const objects = await engine.objects([...ids].filter(id => id >= 0))
		const pictures = objects.flatMap(object =>
			object.kind === "drawing" ? object.drawing.images.flatMap(image => [image.partName, image.svgPartName]) : []
		)
		const requested = pictures.filter(name => name !== undefined)

		// The three objects' shapes name the embedded image, a signature stub that is not served; the external
		// pictures name none.
		for (const partName of requested) expect(await engine.media(partName), partName).toBeNull()

		await engine.find("CACHED")
		await engine.annotations()

		expect(trap.calls).toEqual([])
		// Object resolution and media serving ran: two blip pictures, the VML picture and the three objects.
		expect(objects.map(object => object.kind)).toEqual(["drawing", "drawing", "drawing", "drawing", "drawing", "drawing"])
		expect(requested).toEqual(["word/media/image1.png", "word/media/image1.png", "word/media/image1.png"])

		for (const [name, [start, end]] of await payloadRanges(DOCUMENT)) expect(source.touched(start, end), name).toBe(false)

		// Risky fields show their cached results.
		const text = events.flatMap(event => (event.type === "pages" ? event.pages.flatMap(page => page.sourceTexts) : [])).join("\n")

		for (const [, result] of RISKY_FIELDS) expect(text).toContain(result)

		expect(text).not.toContain("chunk")

		engine.close()
	})

	it("leaves dangerous link targets to the host's policy, which refuses them when clicked", async () => {
		const events: DocxEvent[] = []

		await new DocxEngine(bytesSource(DOCUMENT), engineServices(), event => events.push(event)).run()

		const links = events.flatMap(event => (event.type === "pages" ? event.links : []))
		const external = links.filter((link): link is Extract<DocxLinkTarget, { kind: "external" }> => link.kind === "external")
		const opened: string[] = []
		const refused: string[] = []
		const activate = linkActivator({
			allow: href => {
				try {
					return ["http:", "https:", "mailto:"].includes(new URL(href).protocol)
				} catch {
					return false
				}
			},
			open: href => opened.push(href),
			refused: href => refused.push(href)
		})

		for (const link of external) activate(link)

		expect(opened).toEqual([])
		expect(refused).toEqual(expect.arrayContaining(["javascript:alert(document.domain)", "file:///etc/passwd"]))
	})

	it("keeps cached field results through Update All and writes payloads back byte for byte", async () => {
		trap = trapGlobals()

		const opened = await pagedEditor(DOCUMENT)

		await settleAll(opened.editor)
		opened.editor.session.dispatch(opened.editor.session.state.tr.insertText("edited ", 1))
		await opened.editor.execute({ type: "field.updateAll" })
		await settleAll(opened.editor)

		const saved = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: opened.editor.sessions })

		expect(trap.calls).toEqual([])
		trap.restore()
		trap = undefined

		const bytes = saved.bytes ?? new Uint8Array(0)
		const reopened = await openDocxPackage(bytesSource(bytes))

		if (!reopened.ok) throw new Error(reopened.message)

		const xml = decoder.decode(await reopened.package.opc.read("word/document.xml"))

		expect(xml).toContain("edited start")

		for (const [instruction, result] of RISKY_FIELDS) {
			expect(xml, instruction).toContain(`<w:t>${result}</w:t>`)
		}

		const before = await ZipArchive.open(bytesSource(DOCUMENT))
		const after = await ZipArchive.open(bytesSource(bytes))

		for (const { name } of PAYLOADS) {
			const original = before.get(name)
			const copy = after.get(name)

			if (original === undefined || copy === undefined) throw new Error(`missing ${name}`)

			expect(copy.crc32, name).toBe(original.crc32)
			expect(copy.method, name).toBe(original.method)
			expect(Buffer.from(await after.raw(copy)).equals(Buffer.from(await before.raw(original))), name).toBe(true)
		}
	})
})
