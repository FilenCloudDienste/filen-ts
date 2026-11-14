import type * as Mupdf from "mupdf"
import type { MupdfModule } from "./protocol"

// Grafts page 0 of a separately produced one-page PDF (an overlay) onto a page of the open document as a Form XObject
// drawn over the page's content. Producers: office pdfwrite (edited and added text, core/pdfedit/textLayout.ts) and
// Tesseract's text-only PDF renderer (OCR). Mutates the document; the caller wraps the call in one journal operation.
//
// Spaces (MuPDF's): a page's "display space" is points, y down, origin at the top-left of the page as shown, i.e.
// after /Rotate, from the CropBox origin, scaled by /UserUnit (PDFPage.getTransform() maps the page's content space
// into it). `toDisplay` maps the overlay page's display space into the target page's display space, so producers
// never see /Rotate, /UserUnit or CropBox origins:
// - text layout makes the overlay the size of the target's display box: `toDisplay` = identity;
// - an overlay of another size is stretched over the target's display box by `fitOverlay`;
// - OCR knows its overlay → page content matrix from the render (core/pdfedit/ocrGeometry.ts) and passes it as
//   `toPage`, used as it is.
//
// Content: the target's content streams are wrapped in q … Q (whatever state they leave behind cannot shift the
// overlay), then `q /<name> Do Q` is appended. The Form XObject keeps the overlay page's own resources (grafted
// through ONE graft map per call, so shared objects are copied once) under a new, unused XObject name in a copy of
// the page's resources: names never clash and resources shared with other pages are never changed. Nothing else of
// the overlay page (annotations, actions, metadata) is carried over.

export type PdfMatrix = readonly [number, number, number, number, number, number]

export interface GraftOverlayOptions {
	// Overlay display space → target display space; default identity.
	readonly toDisplay?: PdfMatrix
	// Instead: overlay content space → target content space, as it is (OCR's matrix, core/pdfedit/ocrGeometry.ts).
	readonly toPage?: PdfMatrix
}

export interface GraftedOverlay {
	// The XObject's name in the page's /Resources /XObject.
	readonly name: string
	// The Form XObject (indirect).
	readonly xobject: Mupdf.PDFObject
}

export class PdfOverlayError extends Error {}

const IDENTITY: PdfMatrix = [1, 0, 0, 1, 0, 0]

export function concatMatrix(one: PdfMatrix, two: PdfMatrix): PdfMatrix {
	return [
		one[0] * two[0] + one[1] * two[2],
		one[0] * two[1] + one[1] * two[3],
		one[2] * two[0] + one[3] * two[2],
		one[2] * two[1] + one[3] * two[3],
		one[4] * two[0] + one[5] * two[2] + two[4],
		one[4] * two[1] + one[5] * two[3] + two[5]
	]
}

export function invertMatrix(m: PdfMatrix): PdfMatrix {
	const det = m[0] * m[3] - m[1] * m[2]

	if (Math.abs(det) < 1e-12) throw new PdfOverlayError("The matrix cannot be inverted")

	const a = m[3] / det
	const b = -m[1] / det
	const c = -m[2] / det
	const d = m[0] / det

	return [a, b, c, d, -m[4] * a - m[5] * c, -m[4] * b - m[5] * d]
}

// The scale that stretches an overlay page of overlayWidth × overlayHeight display points over a target display box
// of targetWidth × targetHeight (OCR: the page rendered at some dpi, read back as points).
export function fitOverlay(overlayWidth: number, overlayHeight: number, targetWidth: number, targetHeight: number): PdfMatrix {
	if (!(overlayWidth > 0 && overlayHeight > 0)) throw new PdfOverlayError("The overlay page is empty")

	return [targetWidth / overlayWidth, 0, 0, targetHeight / overlayHeight, 0, 0]
}

// Grafts page 0 of `overlay` (PDF bytes, copied into MuPDF's heap and freed before returning) onto page `pageIndex`.
// Throws PdfOverlayError when the overlay has no page; the document is then unchanged.
export function graftOverlay(
	mupdf: MupdfModule,
	document: Mupdf.PDFDocument,
	pageIndex: number,
	overlay: Uint8Array,
	options: GraftOverlayOptions = {}
): GraftedOverlay {
	const source = new mupdf.PDFDocument(overlay)

	try {
		if (source.countPages() < 1) throw new PdfOverlayError("The overlay has no page")

		const overlayPage = source.loadPage(0)
		const overlayObject = overlayPage.getObject()
		const page = document.loadPage(pageIndex)
		const pageObject = page.getObject()
		const box = overlayObject.getInheritable("MediaBox")

		if (!box.isArray() || box.length !== 4) throw new PdfOverlayError("The overlay page has no MediaBox")

		// Overlay content space → overlay display → target display → target content space.
		const matrix =
			options.toPage ??
			concatMatrix(concatMatrix(overlayPage.getTransform(), options.toDisplay ?? IDENTITY), invertMatrix(page.getTransform()))
		const map = document.newGraftMap()
		const contents = overlayObject.get("Contents")
		// One content stream is copied as stored (still compressed); a content array is decoded and joined.
		const xobject = contents.isStream() ? map.graftObject(contents) : document.addStream(joinedContent(contents), {})

		xobject.put("Type", document.newName("XObject"))
		xobject.put("Subtype", document.newName("Form"))
		xobject.put("BBox", [box.get(0).asNumber(), box.get(1).asNumber(), box.get(2).asNumber(), box.get(3).asNumber()])
		xobject.put("Matrix", [...matrix])

		const resources = overlayObject.getInheritable("Resources")

		if (resources.isDictionary()) xobject.put("Resources", map.graftObject(resources))

		const group = overlayObject.get("Group")

		if (group.isDictionary()) xobject.put("Group", map.graftObject(group))

		const name = attachXObject(document, pageObject, xobject)

		appendContent(document, pageObject, `q /${name} Do Q\n`)
		map.destroy()
		overlayPage.destroy()
		page.destroy()

		return { name, xobject }
	} finally {
		source.destroy()
	}
}

// A content array is one stream split anywhere (§7.8.2): its parts decoded and joined with line breaks.
function joinedContent(contents: Mupdf.PDFObject): Uint8Array {
	const parts: Uint8Array[] = []

	if (contents.isArray()) {
		for (let index = 0; index < contents.length; index++) {
			const part = contents.get(index)

			if (part.isStream()) parts.push(part.readStream().asUint8Array().slice(), NEWLINE)
		}
	}

	const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		joined.set(part, at)
		at += part.length
	}

	return joined
}

const NEWLINE = Uint8Array.of(0x0a)

// Adds the XObject under a fresh name to a copy of the page's (possibly inherited or shared) resources.
function attachXObject(document: Mupdf.PDFDocument, pageObject: Mupdf.PDFObject, xobject: Mupdf.PDFObject): string {
	const inherited = pageObject.getInheritable("Resources")
	const resources = copyDictionary(document, inherited.isDictionary() ? inherited : null)
	const existing = resources.get("XObject")
	const xobjects = copyDictionary(document, existing.isDictionary() ? existing : null)
	let index = 1

	while (!xobjects.get(`FoOv${String(index)}`).isNull()) index++

	const name = `FoOv${String(index)}`

	xobjects.put(name, xobject)
	resources.put("XObject", xobjects)
	pageObject.put("Resources", resources)

	return name
}

function copyDictionary(document: Mupdf.PDFDocument, source: Mupdf.PDFObject | null): Mupdf.PDFObject {
	const copy = document.newDictionary()

	source?.resolve().forEach((value, key) => {
		copy.put(key, value)
	})

	return copy
}

// Contents becomes [q, …existing, Q + tail]: the existing streams are kept as they are (never decoded or rewritten).
function appendContent(document: Mupdf.PDFDocument, pageObject: Mupdf.PDFObject, tail: string): void {
	const contents = pageObject.get("Contents")
	const list = document.newArray()

	list.push(document.addStream("q\n", {}))

	if (contents.isArray()) {
		for (let index = 0; index < contents.length; index++) list.push(contents.get(index))
	} else if (!contents.isNull()) {
		list.push(contents)
	}

	list.push(document.addStream(`Q\n${tail}`, {}))
	pageObject.put("Contents", list)
}
