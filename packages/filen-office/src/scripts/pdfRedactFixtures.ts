import { mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"
import { PAGE_HEIGHT, PAGE_WIDTH, SECRET, SPEC, type PdfBox } from "../tests/pdfedit/redactFixtureSpec"

// Generates the redaction fixtures in src/tests/fixtures/pdfredact/. Every file is written object by object here
// (no PDF library), so the redaction code is tested against structure it did not produce: patterns, shadings,
// stencil and soft masks, text in Form XObjects, invisible (render mode 3) and clipping text, hidden layers and
// memberships, an OCR'd scan, tagged content with ActualText, annotations, form fields, XMP and every other place
// a term can hide, and an incremental update over an earlier revision. Positions come from redactFixtureSpec.ts.
//
//   pnpm exec tsx src/scripts/pdfRedactFixtures.ts

const OUT = fileURLToPath(new URL("../tests/fixtures/pdfredact/", import.meta.url))
const latin1 = (text: string): Buffer => Buffer.from(text, "latin1")

// A PDF literal string.
const str = (text: string): string => `(${text.replace(/[\\()]/g, char => `\\${char}`)})`
const utf16 = (text: string): string => `<feff${Buffer.from(text, "utf16le").swap16().toString("hex")}>`
const ref = (number: number): string => `${String(number)} 0 R`
const box = (rect: PdfBox): string => `[${rect.join(" ")}]`
const text = (line: { readonly text: string; readonly x: number; readonly y: number; readonly size: number }, mode = 0): string =>
	`BT ${String(mode)} Tr /F1 ${String(line.size)} Tf ${String(line.x)} ${String(line.y)} Td ${str(line.text)} Tj ET\n`

class Pdf {
	private readonly bodies: Buffer[] = []

	reserve(): number {
		this.bodies.push(Buffer.alloc(0))

		return this.bodies.length
	}

	put(number: number, body: string | Buffer): number {
		this.bodies[number - 1] = typeof body === "string" ? latin1(body) : body

		return number
	}

	add(body: string | Buffer): number {
		return this.put(this.reserve(), body)
	}

	stream(dict: string, data: string | Buffer, compress = true, number = this.reserve()): number {
		const raw = typeof data === "string" ? latin1(data) : data
		const bytes = compress ? deflateSync(raw) : raw
		const filter = compress ? " /Filter /FlateDecode" : ""

		return this.put(
			number,
			Buffer.concat([latin1(`<< ${dict}${filter} /Length ${String(bytes.length)} >>\nstream\n`), bytes, latin1("\nendstream")])
		)
	}

	font(): number {
		return this.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
	}

	bytes(root: number, info?: number): Buffer {
		const parts: Buffer[] = [latin1("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")]
		const offsets: number[] = []
		let length = parts[0]?.length ?? 0

		this.bodies.forEach((body, index) => {
			const object = Buffer.concat([latin1(`${String(index + 1)} 0 obj\n`), body, latin1("\nendobj\n")])

			offsets.push(length)
			parts.push(object)
			length += object.length
		})

		const xref = [
			`xref\n0 ${String(this.bodies.length + 1)}\n0000000000 65535 f \n`,
			...offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`)
		].join("")
		const trailer = `trailer\n<< /Size ${String(this.bodies.length + 1)} /Root ${ref(root)}${info === undefined ? "" : ` /Info ${ref(info)}`} >>\nstartxref\n${String(length)}\n%%EOF\n`

		parts.push(latin1(xref + trailer))

		return Buffer.concat(parts)
	}
}

// A catalog over the given page objects (content streams and resources already added).
function finish(
	pdf: Pdf,
	pages: readonly { readonly content: number; readonly resources: string; readonly extra?: string; readonly number?: number }[],
	catalog = ""
): number {
	const tree = pdf.reserve()
	const kids = pages.map(entry =>
		pdf.put(
			entry.number ?? pdf.reserve(),
			`<< /Type /Page /Parent ${ref(tree)} /MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] /Resources ${entry.resources} /Contents ${ref(entry.content)}${entry.extra ?? ""} >>`
		)
	)

	pdf.put(tree, `<< /Type /Pages /Kids [${kids.map(ref).join(" ")}] /Count ${String(kids.length)} >>`)

	return pdf.add(`<< /Type /Catalog /Pages ${ref(tree)}${catalog} >>`)
}

function noise(length: number, seed: number, low: number, high: number): Buffer {
	const bytes = Buffer.alloc(length)
	let state = seed

	for (let index = 0; index < length; index++) {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		bytes[index] = low + (Math.abs(state) % (high - low + 1))
	}

	return bytes
}

const fixtures: Record<string, () => Buffer> = {
	"text.pdf": () => {
		const pdf = new Pdf()
		const font = pdf.font()
		const { line1, line2, page2, line, triangle } = SPEC.text
		const shapes =
			`q 0 0 1 RG ${String(line.width)} w ${line.from.join(" ")} m ${line.to.join(" ")} l S Q\n` +
			`q 1 0 0 rg ${triangle[0].join(" ")} m ${triangle[1].join(" ")} l ${triangle[2].join(" ")} l h f Q\n`
		const first = pdf.stream("", text(line1) + text(line2) + shapes)
		const second = pdf.stream("", text(page2))
		const resources = `<< /Font << /F1 ${ref(font)} >> >>`

		return pdf.bytes(
			finish(pdf, [
				{ content: first, resources },
				{ content: second, resources }
			])
		)
	},
	"form.pdf": () => {
		const pdf = new Pdf()
		const font = pdf.font()
		const { at, text: words, size } = SPEC.form
		const form = pdf.stream(
			`/Type /XObject /Subtype /Form /BBox [0 0 300 50] /Resources << /Font << /F1 ${ref(font)} >> >>`,
			`BT /F1 ${String(size)} Tf 0 10 Td ${str(words)} Tj ET`
		)
		const resources = `<< /Font << /F1 ${ref(font)} >> /XObject << /X1 ${ref(form)} >> >>`
		const draw = `q 1 0 0 1 ${String(at[0])} ${String(at[1] - 10)} cm /X1 Do Q\n`
		const first = pdf.stream("", draw + text({ text: "Page one", x: 72, y: 300, size: 14 }))
		const second = pdf.stream("", draw)

		return pdf.bytes(
			finish(pdf, [
				{ content: first, resources },
				{ content: second, resources }
			])
		)
	},
	"invisible.pdf": () => {
		const pdf = new Pdf()
		const font = pdf.font()
		const { area } = SPEC.invisible
		const content = pdf.stream(
			"",
			`q 0.8 g ${String(area[0])} ${String(area[1])} ${String(area[2] - area[0])} ${String(area[3] - area[1])} re f Q\n` +
				text(SPEC.invisible, 3) +
				text({ text: "Visible line", x: 72, y: 300, size: 14 })
		)

		return pdf.bytes(finish(pdf, [{ content, resources: `<< /Font << /F1 ${ref(font)} >> >>` }]))
	},
	"ocr.pdf": () => {
		const pdf = new Pdf()
		const font = pdf.font()
		const [x0, y0, x1, y1] = SPEC.ocr.image
		// A grey "scan": light paper with dark rows standing in for printed lines.
		const pixels = noise(200 * 100, 7, 200, 255)

		for (let row = 0; row < 100; row++) {
			if (row % 20 < 6) for (let column = 10; column < 190; column++) pixels[row * 200 + column] = 40
		}

		const image = pdf.stream(
			"/Type /XObject /Subtype /Image /Width 200 /Height 100 /ColorSpace /DeviceGray /BitsPerComponent 8",
			pixels
		)
		const content = pdf.stream(
			"",
			`q ${String(x1 - x0)} 0 0 ${String(y1 - y0)} ${String(x0)} ${String(y0)} cm /Im1 Do Q\n` + text(SPEC.ocr, 3)
		)

		return pdf.bytes(finish(pdf, [{ content, resources: `<< /Font << /F1 ${ref(font)} >> /XObject << /Im1 ${ref(image)} >> >>` }]))
	},
	"clipped.pdf": () => {
		const pdf = new Pdf()
		const font = pdf.font()
		const { clipped, clipRect, clipping } = SPEC.clipped
		const content = pdf.stream(
			"",
			`q ${String(clipRect[0])} ${String(clipRect[1])} ${String(clipRect[2] - clipRect[0])} ${String(clipRect[3] - clipRect[1])} re W n\n` +
				text(clipped) +
				"Q\n" +
				`q ${text(clipping, 7)}0 0 1 rg 0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)} re f Q\n`
		)

		return pdf.bytes(finish(pdf, [{ content, resources: `<< /Font << /F1 ${ref(font)} >> >>` }]))
	},
	"layer.pdf": () => {
		const pdf = new Pdf()
		const font = pdf.font()
		const off = pdf.add(`<< /Type /OCG /Name ${str("Notes")} >>`)
		const on = pdf.add(`<< /Type /OCG /Name ${str("Main")} >>`)
		// Visible only while "Main" is off: hidden by default and also when every layer is on.
		const membership = pdf.add(`<< /Type /OCMD /OCGs [${ref(on)}] /P /AllOff >>`)
		const { off: offText, membership: memberText, visible } = SPEC.layer
		const content = pdf.stream(
			"",
			`/OC /L1 BDC ${text(offText)}EMC\n/OC /M1 BDC ${text(memberText)}EMC\n/OC /L2 BDC ${text(visible)}EMC\n`
		)
		const resources = `<< /Font << /F1 ${ref(font)} >> /Properties << /L1 ${ref(off)} /L2 ${ref(on)} /M1 ${ref(membership)} >> >>`
		const catalog = ` /OCProperties << /OCGs [${ref(off)} ${ref(on)}] /D << /Order [${ref(off)} ${ref(on)}] /OFF [${ref(off)}] >> >>`

		return pdf.bytes(finish(pdf, [{ content, resources }], catalog))
	},
	"tagged.pdf": () => {
		const pdf = new Pdf()
		const font = pdf.font()
		const { first, second } = SPEC.tagged
		const content = pdf.stream(
			"",
			`/Span << /MCID 0 /ActualText ${str(first.actual)} >> BDC ${text(first)}EMC\n/P << /MCID 1 >> BDC ${text(second)}EMC\n`
		)
		const root = pdf.reserve()
		const documentElement = pdf.reserve()
		const pageNumber = pdf.reserve()
		const one = pdf.add(
			`<< /Type /StructElem /S /P /P ${ref(documentElement)} /Pg ${ref(pageNumber)} /K 0 /ActualText ${str(first.actual)} /Alt ${utf16(`${SECRET} Alt`)} >>`
		)
		const two = pdf.add(`<< /Type /StructElem /S /P /P ${ref(documentElement)} /Pg ${ref(pageNumber)} /K 1 /Alt ${str("Kept alt")} >>`)

		pdf.put(documentElement, `<< /Type /StructElem /S /Document /P ${ref(root)} /K [${ref(one)} ${ref(two)}] >>`)
		pdf.put(
			root,
			`<< /Type /StructTreeRoot /K ${ref(documentElement)} /ParentTree << /Nums [0 [${ref(one)} ${ref(two)}]] >> /ParentTreeNextKey 1 >>`
		)

		const catalog = finish(
			pdf,
			[{ content, resources: `<< /Font << /F1 ${ref(font)} >> >>`, extra: " /StructParents 0", number: pageNumber }],
			` /MarkInfo << /Marked true >> /StructTreeRoot ${ref(root)}`
		)

		return pdf.bytes(catalog)
	},
	// The text alternatives sit on ancestors of the redacted content: a section's ActualText and the document's Alt
	// spell out its words; the kept paragraph has its own Alt.
	"tagged-parent.pdf": () => {
		const pdf = new Pdf()
		const font = pdf.font()
		const { first, second, sectionActual, documentAlt } = SPEC.taggedParent
		const content = pdf.stream("", `/P << /MCID 0 >> BDC ${text(first)}EMC\n/P << /MCID 1 >> BDC ${text(second)}EMC\n`)
		const root = pdf.reserve()
		const documentElement = pdf.reserve()
		const section = pdf.reserve()
		const pageNumber = pdf.reserve()
		const one = pdf.add(`<< /Type /StructElem /S /P /P ${ref(section)} /Pg ${ref(pageNumber)} /K 0 >>`)
		// No /Type: it is optional on a structure element.
		const two = pdf.add(`<< /S /P /P ${ref(documentElement)} /Pg ${ref(pageNumber)} /K 1 /Alt ${str("Kept alt")} >>`)

		pdf.put(section, `<< /Type /StructElem /S /Sect /P ${ref(documentElement)} /K [${ref(one)}] /ActualText ${utf16(sectionActual)} >>`)
		pdf.put(
			documentElement,
			`<< /Type /StructElem /S /Document /P ${ref(root)} /K [${ref(section)} ${ref(two)}] /Alt ${str(documentAlt)} >>`
		)
		pdf.put(
			root,
			`<< /Type /StructTreeRoot /K ${ref(documentElement)} /ParentTree << /Nums [0 [${ref(one)} ${ref(two)}]] >> /ParentTreeNextKey 1 >>`
		)

		const catalog = finish(
			pdf,
			[{ content, resources: `<< /Font << /F1 ${ref(font)} >> >>`, extra: " /StructParents 0", number: pageNumber }],
			` /MarkInfo << /Marked true >> /StructTreeRoot ${ref(root)}`
		)

		return pdf.bytes(catalog)
	},
	"annotations.pdf": () => {
		const pdf = new Pdf()
		const font = pdf.font()
		const { note, freeText, link, field, elsewhereNote } = SPEC.annotations
		const content = pdf.stream("", text(SPEC.annotations.text))
		const pageNumber = pdf.reserve()
		const appearance = (rect: PdfBox, words: string): number =>
			pdf.stream(
				`/Type /XObject /Subtype /Form /BBox [0 0 ${String(rect[2] - rect[0])} ${String(rect[3] - rect[1])}] /Resources << /Font << /F1 ${ref(font)} >> >>`,
				`BT /F1 12 Tf 2 6 Td ${str(words)} Tj ET`
			)
		const noteObject = pdf.reserve()
		const popup = pdf.add(`<< /Type /Annot /Subtype /Popup /Rect [100 700 300 760] /Parent ${ref(noteObject)} /P ${ref(pageNumber)} >>`)

		pdf.put(
			noteObject,
			`<< /Type /Annot /Subtype /Text /Rect ${box(note)} /Contents ${str(`${SECRET} note`)} /T ${str("Reviewer")} /Popup ${ref(popup)} /P ${ref(pageNumber)} >>`
		)

		const free = pdf.add(
			`<< /Type /Annot /Subtype /FreeText /Rect ${box(freeText)} /Contents ${str(`${SECRET} free text`)} /RC ${str(`<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml"><p>${SECRET} rich</p></body>`)} /DA (/Helv 12 Tf 0 g) /AP << /N ${ref(appearance(freeText, `${SECRET} free text`))} >> /P ${ref(pageNumber)} >>`
		)
		const linkObject = pdf.add(
			`<< /Type /Annot /Subtype /Link /Rect ${box(link)} /Border [0 0 0] /A << /S /URI /URI ${str(`https://example.com/${SECRET}`)} >> /P ${ref(pageNumber)} >>`
		)
		const widget = pdf.add(
			`<< /Type /Annot /Subtype /Widget /FT /Tx /T ${str("name")} /TU ${str(`${SECRET} tooltip`)} /V ${str(`${SECRET} value`)} /DA (/Helv 12 Tf 0 g) /Rect ${box(field)} /F 4 /AP << /N ${ref(appearance(field, `${SECRET} value`))} >> /P ${ref(pageNumber)} >>`
		)
		const elsewhere = pdf.add(
			`<< /Type /Annot /Subtype /Text /Rect ${box(elsewhereNote)} /Contents ${str(`Another ${SECRET} elsewhere`)} /P ${ref(pageNumber)} >>`
		)
		const tree = pdf.reserve()

		pdf.put(
			pageNumber,
			`<< /Type /Page /Parent ${ref(tree)} /MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] /Resources << /Font << /F1 ${ref(font)} >> >> /Contents ${ref(content)} /Annots [${[noteObject, popup, free, linkObject, widget, elsewhere].map(ref).join(" ")}] >>`
		)
		pdf.put(tree, `<< /Type /Pages /Kids [${ref(pageNumber)}] /Count 1 >>`)

		return pdf.bytes(
			pdf.add(
				`<< /Type /Catalog /Pages ${ref(tree)} /AcroForm << /Fields [${ref(widget)}] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv ${ref(font)} >> >> >> >>`
			)
		)
	},
	"metadata.pdf": () => {
		const pdf = new Pdf()
		const font = pdf.font()
		const info = pdf.add(`<< /Title ${str(`${SECRET} Info`)} /Producer ${str("fixture")} >>`)
		const xmp = (body: string): string =>
			`<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">${body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
		// Spelled with a character reference, as XMP may.
		const catalogXmp = pdf.stream("/Type /Metadata /Subtype /XML", xmp("<dc:title>S&#101;cret XMP</dc:title>"), false)
		const pageXmp = pdf.stream("/Type /Metadata /Subtype /XML", xmp(`<dc:description>page ${SECRET} meta</dc:description>`))
		// UTF-16, which XMP also allows.
		const imageXmp = pdf.stream("/Type /Metadata /Subtype /XML", Buffer.from(`<x>${SECRET} image meta</x>`, "utf16le").swap16(), false)
		const image = pdf.stream(
			`/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Metadata ${ref(imageXmp)}`,
			Buffer.from([0, 255, 255, 0])
		)
		const thumb = pdf.stream("/Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8", Buffer.from([0, 255, 255, 0]))
		const embedded = pdf.stream("/Type /EmbeddedFile /Subtype /text#2Fplain", "hello")
		const filespec = pdf.add(
			`<< /Type /Filespec /F ${str(`${SECRET}.txt`)} /UF ${utf16(`${SECRET}.txt`)} /EF << /F ${ref(embedded)} >> >>`
		)
		const content = pdf.stream("", text(SPEC.metadata.text) + "q 20 0 0 20 72 600 cm /Im1 Do Q\n")
		const pageNumber = pdf.reserve()
		const tree = pdf.reserve()
		const outlines = pdf.reserve()
		const item = pdf.add(`<< /Title ${str(`${SECRET} chapter`)} /Parent ${ref(outlines)} /Dest [${ref(pageNumber)} /Fit] >>`)

		pdf.put(outlines, `<< /Type /Outlines /First ${ref(item)} /Last ${ref(item)} /Count 1 >>`)
		pdf.put(
			pageNumber,
			`<< /Type /Page /Parent ${ref(tree)} /MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] /Resources << /Font << /F1 ${ref(font)} >> /XObject << /Im1 ${ref(image)} >> >> /Contents ${ref(content)} /Metadata ${ref(pageXmp)} /Thumb ${ref(thumb)} /PieceInfo << /Fixture << /LastModified (D:20260101000000Z) /Private ${str(`${SECRET} piece`)} >> >> >>`
		)
		pdf.put(tree, `<< /Type /Pages /Kids [${ref(pageNumber)}] /Count 1 >>`)

		const javascript = pdf.add(`<< /S /JavaScript /JS ${str(`app.alert('${SECRET}')`)} >>`)
		const root = pdf.add(
			`<< /Type /Catalog /Pages ${ref(tree)} /Metadata ${ref(catalogXmp)} /Outlines ${ref(outlines)} /OpenAction ${ref(javascript)} /PageLabels << /Nums [0 << /S /D /P ${str(`${SECRET}-`)} >>] >> /Names << /EmbeddedFiles << /Names [${str(`${SECRET}.txt`)} ${ref(filespec)}] >> /Dests << /Names [${str(`${SECRET}Dest`)} [${ref(pageNumber)} /XYZ 0 792 0]] >> >> >>`
		)

		return pdf.bytes(root, info)
	},
	"images.pdf": () => {
		const pdf = new Pdf()
		const { rgb, stencil, cmyk, inline } = SPEC.images
		const side = 16
		const rgbPixels = Buffer.alloc(side * side * 3)

		for (let index = 0; index < side * side; index++) rgbPixels.set([30, 60, 90], index * 3)

		const smask = pdf.stream(
			`/Type /XObject /Subtype /Image /Width ${String(side)} /Height ${String(side)} /ColorSpace /DeviceGray /BitsPerComponent 8`,
			Buffer.alloc(side * side, 128)
		)
		const rgbImage = pdf.stream(
			`/Type /XObject /Subtype /Image /Width ${String(side)} /Height ${String(side)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${ref(smask)}`,
			rgbPixels
		)
		// 1 bit per pixel, 0 paints (the default Decode): every pixel painted.
		const stencilImage = pdf.stream(
			`/Type /XObject /Subtype /Image /Width ${String(side)} /Height ${String(side)} /ImageMask true /BitsPerComponent 1`,
			Buffer.alloc((side / 8) * side, 0)
		)
		const cmykImage = pdf.stream(
			`/Type /XObject /Subtype /Image /Width ${String(side)} /Height ${String(side)} /ColorSpace /DeviceCMYK /BitsPerComponent 8`,
			Buffer.alloc(side * side * 4, 0).fill(Buffer.from([0, 128, 128, 80]))
		)
		const place = (rect: PdfBox, name: string): string =>
			`q ${String(rect[2] - rect[0])} 0 0 ${String(rect[3] - rect[1])} ${String(rect[0])} ${String(rect[1])} cm ${name} Q\n`
		const inlineData = Buffer.alloc(side * side, 40)
		const content = pdf.stream(
			"",
			Buffer.concat([
				latin1(place(rgb, "/Im1 Do") + `q 1 0 0 rg ${place(stencil, "/Im2 Do")}Q\n` + place(cmyk, "/Im3 Do")),
				latin1(
					`q ${String(inline[2] - inline[0])} 0 0 ${String(inline[3] - inline[1])} ${String(inline[0])} ${String(inline[1])} cm BI /W ${String(side)} /H ${String(side)} /CS /G /BPC 8 ID `
				),
				inlineData,
				latin1("\nEI Q\n")
			])
		)

		return pdf.bytes(
			finish(pdf, [
				{ content, resources: `<< /XObject << /Im1 ${ref(rgbImage)} /Im2 ${ref(stencilImage)} /Im3 ${ref(cmykImage)} >> >>` }
			])
		)
	},
	"vector.pdf": () => {
		const pdf = new Pdf()
		const font = pdf.font()
		const { tiled, shading, shadingFill } = SPEC.vector
		const tile = pdf.stream(
			`/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 50 20] /XStep 50 /YStep 20 /Resources << /Font << /F1 ${ref(font)} >> >>`,
			`0 0.5 0 rg 0 0 4 4 re f 0 g BT /F1 8 Tf 6 6 Td ${str(`${SECRET} Tile`)} Tj ET`
		)
		const axial = pdf.add(
			`<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${String(shading[0])} 0 ${String(shading[2])} 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> /Extend [true true] >>`
		)
		const radial = pdf.add(
			"<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [186 300 0 186 300 120] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 1 0] /C1 [0 1 1] /N 1 >> /Extend [true true] >>"
		)
		const shadingPattern = pdf.add(`<< /Type /Pattern /PatternType 2 /Shading ${ref(radial)} >>`)
		const rect = (r: PdfBox): string => `${String(r[0])} ${String(r[1])} ${String(r[2] - r[0])} ${String(r[3] - r[1])} re`
		const content = pdf.stream(
			"",
			`q /Pattern cs /P1 scn ${rect(tiled)} f Q\n` +
				`q ${rect(shading)} W n /Sh1 sh Q\n` +
				`q /Pattern cs /P2 scn ${rect(shadingFill)} f Q\n`
		)

		return pdf.bytes(
			finish(pdf, [
				{
					content,
					resources: `<< /Font << /F1 ${ref(font)} >> /Pattern << /P1 ${ref(tile)} /P2 ${ref(shadingPattern)} >> /Shading << /Sh1 ${ref(axial)} >> >>`
				}
			])
		)
	},
	"revision.pdf": () => {
		const pdf = new Pdf()
		const font = pdf.font()
		const line = (words: string): string => text({ text: words, x: 72, y: 700, size: 18 })
		const content = pdf.stream("", line(SPEC.revision.original))
		const resources = `<< /Font << /F1 ${ref(font)} >> >>`
		const root = finish(pdf, [{ content, resources }])
		const base = pdf.bytes(root)
		// The incremental update: a new content stream (object 6) and the page (object 4) pointing at it.
		const startxref = Number(/startxref\n(\d+)/.exec(base.toString("latin1"))?.[1] ?? "0")
		const fresh = deflateSync(latin1(line(SPEC.revision.replacement)))
		const objects = [
			Buffer.concat([
				latin1(`6 0 obj\n<< /Filter /FlateDecode /Length ${String(fresh.length)} >>\nstream\n`),
				fresh,
				latin1("\nendstream\nendobj\n")
			]),
			latin1(
				`4 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] /Resources ${resources} /Contents 6 0 R >>\nendobj\n`
			)
		]
		let offset = base.length
		const offsets: number[] = []

		for (const object of objects) {
			offsets.push(offset)
			offset += object.length
		}

		const xref =
			`xref\n4 1\n${String(offsets[1]).padStart(10, "0")} 00000 n \n6 1\n${String(offsets[0]).padStart(10, "0")} 00000 n \n` +
			`trailer\n<< /Size 7 /Root ${ref(root)} /Prev ${String(startxref)} >>\nstartxref\n${String(offset)}\n%%EOF\n`

		return Buffer.concat([base, ...objects, latin1(xref)])
	}
}

mkdirSync(OUT, { recursive: true })

for (const [name, make] of Object.entries(fixtures)) writeFileSync(`${OUT}${name}`, make())
