import * as mupdf from "mupdf"

// PDFs for the text recognition tests, made with MuPDF at test time: pages with a black marker square at a known
// place in user space (geometry), and "scans" (a text page rendered to a grey image and placed as the only content,
// possibly on its side).

export interface MarkerPageOptions {
	readonly mediaBox?: readonly [number, number, number, number]
	readonly cropBox?: readonly [number, number, number, number]
	readonly rotate?: 0 | 90 | 180 | 270
	readonly userUnit?: number
	// The marker, in user space: [x0, y0, x1, y1].
	readonly marker: readonly [number, number, number, number]
}

export function markerPage(options: MarkerPageOptions): mupdf.PDFDocument {
	const document = new mupdf.PDFDocument()
	const [x0, y0, x1, y1] = options.marker
	const page = document.addPage(
		[...(options.mediaBox ?? [0, 0, 612, 792])],
		options.rotate ?? 0,
		document.addObject({}),
		`0 g ${String(x0)} ${String(y0)} ${String(x1 - x0)} ${String(y1 - y0)} re f\n`
	)

	if (options.cropBox !== undefined) page.put("CropBox", [...options.cropBox])
	if (options.userUnit !== undefined) page.put("UserUnit", options.userUnit)

	document.insertPage(-1, page)

	return document
}

// The source page of a scan: these lines set in Times-Roman 24 pt on a US Letter page from (72, 700), 40 pt apart.
export function textPage(lines: readonly string[]): mupdf.PDFDocument {
	const source = new mupdf.PDFDocument()
	const font = source.addSimpleFont(new mupdf.Font("Times-Roman"))
	const escaped = lines.map(line => `(${line.replace(/[\\()]/g, match => `\\${match}`)}) Tj 0 -40 Td`).join(" ")
	const page = source.addPage([0, 0, 612, 792], 0, source.addObject({ Font: { F1: font } }), `BT /F1 24 Tf 72 700 Td ${escaped} ET`)

	source.insertPage(-1, page)

	return source
}

// A grey image of textPage(lines) rendered at `dpi`, its content turned clockwise by `turns` (a sheet scanned on its
// side or upside down).
export function textImage(lines: readonly string[], dpi: number, turns: 0 | 1 | 2 | 3 = 0): mupdf.Image {
	const source = textPage(lines)
	const matrix = mupdf.Matrix.concat(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.Matrix.rotate(turns * 90))
	const pixmap = source.loadPage(0).toPixmap(matrix, mupdf.ColorSpace.DeviceGray, false, false)
	const image = new mupdf.Image(pixmap)

	pixmap.destroy()
	source.destroy()

	return image
}

export interface ScanOptions {
	readonly lines: readonly string[]
	readonly dpi?: number
	// The image placed turned clockwise on a page of the turned size.
	readonly imageTurns?: 0 | 1 | 2 | 3
	// The scanned sheet's content turned clockwise inside the image (placed as if upright).
	readonly contentTurns?: 0 | 2
	readonly rotate?: 0 | 90 | 180 | 270
	// Visible characters drawn over the scan (a page number).
	readonly footer?: string
}

// User-space image matrices placing the unit square on a 612 × 792 (or 792 × 612) page, the image turned clockwise.
const PLACEMENTS: Readonly<Record<0 | 1 | 2 | 3, string>> = {
	0: "612 0 0 792 0 0",
	1: "0 -612 792 0 0 612",
	2: "-612 0 0 -792 612 792",
	3: "0 612 -792 0 792 0"
}

export function scannedPdf(options: ScanOptions): Uint8Array {
	const document = new mupdf.PDFDocument()
	const turns = options.imageTurns ?? 0
	const image = document.addImage(textImage(options.lines, options.dpi ?? 150, options.contentTurns ?? 0))
	const font = document.addSimpleFont(new mupdf.Font("Helvetica"))
	const footer = options.footer === undefined ? "" : `BT /F1 8 Tf 20 20 Td (${options.footer}) Tj ET\n`
	const page = document.addPage(
		turns % 2 === 0 ? [0, 0, 612, 792] : [0, 0, 792, 612],
		options.rotate ?? 0,
		document.addObject({ XObject: { Im0: image }, Font: { F1: font } }),
		`q ${PLACEMENTS[turns]} cm /Im0 Do Q\n${footer}`
	)

	document.insertPage(-1, page)

	const saved = document.saveToBuffer("compress,garbage=compact").asUint8Array().slice()

	document.destroy()

	return saved
}

function contentOf(contents: mupdf.PDFObject): string {
	if (!contents.isArray()) return contents.readStream().asString()

	const parts: string[] = []

	for (let index = 0; index < contents.length; index++) parts.push(contents.get(index).readStream().asString())

	return parts.join("\n")
}

// A stand-in for the editor's overlay graft (tests only): the overlay's page becomes a Form XObject drawn on the
// target page with `matrix`.
export function stubGraft(
	target: mupdf.PDFDocument,
	pageIndex: number,
	overlayPdf: Uint8Array,
	matrix: [number, number, number, number, number, number]
): void {
	const overlay = new mupdf.PDFDocument(overlayPdf)
	const source = overlay.findPage(0)
	const graft = target.newGraftMap()
	const form = target.addStream(contentOf(source.get("Contents")), {
		Type: "XObject",
		Subtype: "Form",
		BBox: graft.graftObject(source.get("MediaBox")),
		Matrix: matrix,
		Resources: graft.graftObject(source.get("Resources"))
	})
	const page = target.findPage(pageIndex)
	const resources = page.get("Resources").isNull() ? target.newDictionary() : page.get("Resources")
	const xobjects = resources.get("XObject").isNull() ? target.newDictionary() : resources.get("XObject")
	const name = `Ocr${String(xobjects.length)}`
	const contents = target.newArray()
	const existing = page.get("Contents")

	xobjects.put(name, form)
	resources.put("XObject", xobjects)
	page.put("Resources", resources)

	if (existing.isArray()) for (let index = 0; index < existing.length; index++) contents.push(existing.get(index))
	else if (!existing.isNull()) contents.push(existing)

	contents.push(target.addStream(`q /${name} Do Q\n`, {}))
	page.put("Contents", contents)
	overlay.destroy()
}
