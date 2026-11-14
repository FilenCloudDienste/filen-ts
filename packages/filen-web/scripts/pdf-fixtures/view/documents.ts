import { randomFillSync } from "node:crypto"
import { deflateSync } from "node:zlib"
import { writeLinearizedPdf, writePdf, type PdfObject } from "./pdfWriter"
import { jbig2Embedded, type Bitmap } from "./jbig2"

// The PDF viewer's fixture documents, built from nothing but this code (and, for two of them, a font and an encoder
// named where they are used). Each one exercises one thing the viewer must read or render.

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792

function contentStream(text: string): PdfObject {
	const data = deflateSync(Buffer.from(text, "latin1"))

	return { dict: "<< /Filter /FlateDecode >>", stream: data }
}

// "Page N of M" in Helvetica (a standard font: drawn with pdf.js's bundled standard font data), with an image filling
// the lower half when `image` is set.
function latinPage(page: number, pages: number, image: boolean): string {
	const lines = [
		"BT /F1 28 Tf 72 700 Td",
		`(Page ${String(page)} of ${String(pages)}) Tj`,
		"0 -40 Td /F1 14 Tf (The quick brown fox jumps over the lazy dog.) Tj ET"
	]

	if (image) lines.push(`q ${String(PAGE_WIDTH - 144)} 0 0 400 72 160 cm /Im1 Do Q`)

	return lines.join("\n")
}

export interface LatinOptions {
	readonly pages: number
	// One grey image per page of this many pixels a side, uncompressed noise: the bytes a reader must fetch to draw
	// the page, so the file is mostly its images and ranged reading shows in what is read. 0: no images.
	readonly imageSide: number
	readonly linearized: boolean
}

// Multi-page Latin text, optionally with a large image per page, in the classic or the linearized layout.
export function latinDocument(options: LatinOptions): Uint8Array {
	const { pages, imageSide, linearized } = options
	const image = imageSide > 0
	const imageObject = (): PdfObject => {
		const pixels = new Uint8Array(imageSide * imageSide)

		randomFillSync(pixels)

		return {
			dict: `<< /Type /XObject /Subtype /Image /Width ${String(imageSide)} /Height ${String(imageSide)} /ColorSpace /DeviceGray /BitsPerComponent 8 >>`,
			stream: pixels
		}
	}
	// Shared: catalog 1, page tree 2, font 3. Then per page: page, content, image.
	const font: PdfObject = { dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" }
	const perPage = image ? 3 : 2
	const pageObjects = (page: number, first: number): PdfObject[] => {
		const resources = image ? `<< /Font << /F1 3 0 R >> /XObject << /Im1 ${String(first + 2)} 0 R >> >>` : "<< /Font << /F1 3 0 R >> >>"
		const objects: PdfObject[] = [
			{
				dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] /Resources ${resources} /Contents ${String(first + 1)} 0 R >>`
			},
			contentStream(latinPage(page, pages, image))
		]

		if (image) objects.push(imageObject())

		return objects
	}

	if (!linearized) {
		const kids = Array.from({ length: pages }, (_, index) => `${String(4 + index * perPage)} 0 R`).join(" ")
		const objects: PdfObject[] = [
			{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
			{ dict: `<< /Type /Pages /Kids [${kids}] /Count ${String(pages)} >>` },
			font
		]

		for (let page = 1; page <= pages; page++) objects.push(...pageObjects(page, 4 + (page - 1) * perPage))

		return writePdf(objects, 1)
	}

	// Linearized: pages 2..N with the shared objects are "rest" (numbered from 1), page 1 comes after the
	// linearization dictionary and the hint stream.
	const restCount = 3 + (pages - 1) * perPage
	const firstPageNumber = restCount + 3
	const kids = [firstPageNumber, ...Array.from({ length: pages - 1 }, (_, index) => 4 + index * perPage)].map(n => `${String(n)} 0 R`)
	const rest: PdfObject[] = [
		{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
		{ dict: `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${String(pages)} >>` },
		font
	]

	for (let page = 2; page <= pages; page++) rest.push(...pageObjects(page, 4 + (page - 2) * perPage))

	return writeLinearizedPdf({ rest, firstPage: pageObjects(1, firstPageNumber), root: 1, pages })
}

function singlePage(resources: string, content: string, extra: readonly PdfObject[]): Uint8Array {
	// Catalog 1, pages 2, page 3, content 4, then `extra` from 5.
	return writePdf(
		[
			{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
			{ dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
			{
				dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] /Resources ${resources} /Contents 4 0 R >>`
			},
			contentStream(content),
			...extra
		],
		1
	)
}

const HELVETICA = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"

function utf16Hex(text: string): string {
	return Array.from(text)
		.map(char => (char.codePointAt(0) ?? 0).toString(16).padStart(4, "0"))
		.join("")
}

export const CJK_TEXT = "日本語のテキスト"

// Japanese text in a font the file does not embed (Adobe-Japan1, UniJIS-UCS2-H): drawn only with the character maps
// and a system font.
export function cjkNonEmbedded(): Uint8Array {
	return singlePage(
		"<< /Font << /F1 5 0 R /F2 6 0 R >> >>",
		["BT /F2 18 Tf 72 720 Td (Non-embedded Japanese font) Tj ET", `BT /F1 36 Tf 72 640 Td <${utf16Hex(CJK_TEXT)}> Tj ET`].join("\n"),
		[
			{ dict: "<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [7 0 R] >>" },
			{ dict: HELVETICA },
			{
				dict: "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 8 0 R /DW 1000 >>"
			},
			{
				dict: "<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 6 /FontBBox [-195 -272 1110 1075] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 740 /StemV 80 >>"
			}
		]
	)
}

// A checkerboard with a frame and a diagonal: enough structure to see a decoder got every pixel right.
export const JBIG2_BITMAP: Bitmap = {
	width: 256,
	height: 128,
	pixel: (x, y) => x < 4 || y < 4 || x >= 252 || y >= 124 || Math.abs(x - y * 2) < 3 || ((x >> 4) + (y >> 4)) % 2 === 0
}

// One JBIG2 image (generic region, arithmetic coding), encoded by ./jbig2.ts.
export function jbig2Document(): Uint8Array {
	const { width, height } = JBIG2_BITMAP

	return singlePage(
		"<< /Font << /F1 6 0 R >> /XObject << /Im1 5 0 R >> >>",
		["BT /F1 18 Tf 72 720 Td (JBIG2 image) Tj ET", `q ${String(width * 2)} 0 0 ${String(height * 2)} 72 400 cm /Im1 Do Q`].join("\n"),
		[
			{
				dict: `<< /Type /XObject /Subtype /Image /Width ${String(width)} /Height ${String(height)} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode >>`,
				stream: jbig2Embedded(JBIG2_BITMAP)
			},
			{ dict: HELVETICA }
		]
	)
}

// One JPEG 2000 image: `jp2` is a JP2 file (with its own colour space, so the image dictionary names none).
export function jpxDocument(jp2: Uint8Array, width: number, height: number): Uint8Array {
	return singlePage(
		"<< /Font << /F1 6 0 R >> /XObject << /Im1 5 0 R >> >>",
		["BT /F1 18 Tf 72 720 Td (JPEG 2000 image) Tj ET", `q ${String(width)} 0 0 ${String(height)} 72 300 cm /Im1 Do Q`].join("\n"),
		[
			{
				dict: `<< /Type /XObject /Subtype /Image /Width ${String(width)} /Height ${String(height)} /Filter /JPXDecode >>`,
				stream: jp2
			},
			{ dict: HELVETICA }
		]
	)
}

// DeviceCMYK fills and a DeviceCMYK image: converted for display with pdf.js's CMYK ICC profile.
export function cmykDocument(): Uint8Array {
	const side = 64
	const pixels = new Uint8Array(side * side * 4)

	for (let y = 0; y < side; y++) {
		for (let x = 0; x < side; x++) {
			const at = (y * side + x) * 4

			pixels[at] = x * 4
			pixels[at + 1] = y * 4
			pixels[at + 2] = 255 - x * 4
			pixels[at + 3] = 0
		}
	}

	const swatches = [
		"1 0 0 0 k 72 560 100 100 re f",
		"0 1 0 0 k 192 560 100 100 re f",
		"0 0 1 0 k 312 560 100 100 re f",
		"0 0 0 1 k 432 560 100 100 re f"
	]

	return singlePage(
		"<< /Font << /F1 6 0 R >> /XObject << /Im1 5 0 R >> >>",
		["BT /F1 18 Tf 72 720 Td (CMYK colours) Tj ET", ...swatches, "q 256 0 0 256 72 240 cm /Im1 Do Q"].join("\n"),
		[
			{
				dict: `<< /Type /XObject /Subtype /Image /Width ${String(side)} /Height ${String(side)} /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /FlateDecode >>`,
				stream: deflateSync(pixels)
			},
			{ dict: HELVETICA }
		]
	)
}
