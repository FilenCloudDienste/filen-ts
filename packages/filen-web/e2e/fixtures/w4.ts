import { closeSync, ftruncateSync, openSync, writeSync } from "node:fs"
import { JPEG_BYTES } from "../helpers/fixtureBytes"
import { scenarioModule } from "./scenarios"

// The large-file previews' fixtures: a 100 MiB PDF in the shared tree whose thumbnail needs only page 1, and the two
// big files the write-lane specs upload into their own scratch directories (a 300 MiB image for a public link, a
// ranged PDF that reads past the viewer's resident limit). Every one of them is mostly zeros, laid out so no zero is
// ever held in memory on the way to disk: a file is written sparse (its bytes, then a truncate up to its length).

export const MIB = 1024 * 1024

// One file's bytes in order: written bytes, or a run of that many zero bytes.
type LayoutPart = Uint8Array | number

function layoutLength(parts: readonly LayoutPart[]): number {
	return parts.reduce<number>((sum, part) => sum + (typeof part === "number" ? part : part.length), 0)
}

function layoutBuffer(parts: readonly LayoutPart[]): Buffer {
	const buffer = Buffer.alloc(layoutLength(parts))
	let at = 0

	for (const part of parts) {
		if (typeof part !== "number") {
			buffer.set(part, at)
		}

		at += typeof part === "number" ? part : part.length
	}

	return buffer
}

// Writes the layout to `path` as a sparse file; returns its length.
function writeLayout(path: string, parts: readonly LayoutPart[]): number {
	const fd = openSync(path, "w")
	let at = 0

	try {
		for (const part of parts) {
			if (typeof part !== "number") {
				writeSync(fd, part, 0, part.length, at)
			}

			at += typeof part === "number" ? part : part.length
		}

		ftruncateSync(fd, at)
	} finally {
		closeSync(fd)
	}

	return at
}

const latin1 = (text: string): Buffer => Buffer.from(text, "latin1")

interface SparseObject {
	readonly dict: string
	// A stream of this many zero bytes; its /Length is added to `dict`.
	readonly zeros?: number
	// A stream of these bytes; its /Length is added to `dict`.
	readonly stream?: string
}

interface PdfLayout {
	readonly parts: readonly LayoutPart[]
	// Each object's offset; index 0 is object 1.
	readonly offsets: readonly number[]
}

// A classic PDF (objects numbered from 1, catalog first, one cross-reference table at the end) as a layout.
function pdfLayout(objects: readonly SparseObject[]): PdfLayout {
	const parts: LayoutPart[] = []
	const offsets: number[] = []
	let at = 0
	const push = (part: LayoutPart): void => {
		parts.push(part)
		at += typeof part === "number" ? part : part.length
	}

	push(latin1("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"))

	objects.forEach((object, index) => {
		offsets.push(at)

		const head = `${String(index + 1)} 0 obj\n`
		const stream = object.stream === undefined ? undefined : latin1(object.stream)
		const length = object.zeros ?? stream?.length

		if (length === undefined) {
			push(latin1(`${head}${object.dict}\nendobj\n`))

			return
		}

		push(latin1(`${head}${object.dict.replace(/>>\s*$/u, `/Length ${String(length)} >>`)}\nstream\n`))
		push(stream ?? length)
		push(latin1("\nendstream\nendobj\n"))
	})

	const size = objects.length + 1
	const xref = at
	const entries = offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")

	push(latin1(`xref\n0 ${String(size)}\n0000000000 65535 f \n${entries}`))
	push(latin1(`trailer\n<< /Size ${String(size)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`))

	return { parts, offsets }
}

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const HELVETICA = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"

function pageText(label: string): string {
	return `BT /F1 28 Tf 72 700 Td (${label}) Tj ET`
}

// ---- the shared tree: a 100 MiB PDF whose page 1 sits in its first block ----------------------------------------

export const PDF_THUMB_LARGE_BYTES = 100 * MIB
// Room left for everything but the filler, so the file stays within its 100 blocks.
const PDF_THUMB_SYNTAX_BYTES = 4096

// Catalog, page tree, font, page 1 and its text in the first block, then an object nothing references (zeros, to
// just under 100 MiB), then the cross-reference table in the last block: a reader drawing page 1 reads the first and
// the last block and nothing between.
function largeThumbPdf(): Buffer {
	const objects: SparseObject[] = [
		{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
		{ dict: "<< /Type /Pages /Kids [4 0 R] /Count 1 >>" },
		{ dict: HELVETICA },
		{
			dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>`
		},
		{ dict: "<< >>", stream: pageText("Large PDF thumbnail") },
		{ dict: "<< >>", zeros: PDF_THUMB_LARGE_BYTES - PDF_THUMB_SYNTAX_BYTES }
	]

	return layoutBuffer(pdfLayout(objects).parts)
}

export const W4_SCENARIOS = scenarioModule(
	{
		// Synthesized on disk (100 MiB), so it is a scenario of its own.
		"pdf-thumb-large": ["pdf-thumb-large.pdf"]
	},
	() => ({
		"pdf-thumb-large.pdf": { generate: largeThumbPdf }
	})
)

// ---- uploaded by the write-lane specs ---------------------------------------------------------------------------

// Above the image buffer cap (256 MiB), so a preview never holds it whole.
export const LINK_IMAGE_BYTES = 300 * MIB

// A 1x1 JPEG followed by zeros up to 300 MiB: a decoder stops at the image's end marker, so the browser draws it
// whatever follows, and nothing about it may be held whole.
export function writeLargeLinkImage(path: string): number {
	return writeLayout(path, [JPEG_BYTES, LINK_IMAGE_BYTES - JPEG_BYTES.length])
}

// Pages of the resident PDF, each drawing one 4096 x 4096 grey image (16 MiB, uncompressed): 20 pages are 320 MiB,
// so viewing them in turn reads past the desktop's 256 MiB resident limit (pdfLimits.ts) after page 16.
export const RESIDENT_PDF_PAGES = 20
export const RESIDENT_PDF_IMAGE_SIDE = 4096

// Objects: catalog 1, page tree 2, font 3, then per page its page, content and image from 4. Returns the file's
// length and the byte ranges of each page's three objects, in page order.
export function writeResidentPdf(path: string): { readonly length: number; readonly pages: readonly (readonly [number, number])[] } {
	const perPage = 3
	const kids = Array.from({ length: RESIDENT_PDF_PAGES }, (_, index) => `${String(4 + index * perPage)} 0 R`).join(" ")
	const objects: SparseObject[] = [
		{ dict: "<< /Type /Catalog /Pages 2 0 R >>" },
		{ dict: `<< /Type /Pages /Kids [${kids}] /Count ${String(RESIDENT_PDF_PAGES)} >>` },
		{ dict: HELVETICA }
	]
	const side = String(RESIDENT_PDF_IMAGE_SIDE)

	for (let page = 1; page <= RESIDENT_PDF_PAGES; page++) {
		const first = 4 + (page - 1) * perPage

		objects.push(
			{
				dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(PAGE_WIDTH)} ${String(PAGE_HEIGHT)}] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 ${String(first + 2)} 0 R >> >> /Contents ${String(first + 1)} 0 R >>`
			},
			{
				dict: "<< >>",
				stream: `${pageText(`Page ${String(page)} of ${String(RESIDENT_PDF_PAGES)}`)}\nq ${String(PAGE_WIDTH - 144)} 0 0 400 72 160 cm /Im1 Do Q`
			},
			{
				dict: `<< /Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceGray /BitsPerComponent 8 >>`,
				zeros: RESIDENT_PDF_IMAGE_SIDE * RESIDENT_PDF_IMAGE_SIDE
			}
		)
	}

	const { parts, offsets } = pdfLayout(objects)
	const length = writeLayout(path, parts)
	const pages = Array.from({ length: RESIDENT_PDF_PAGES }, (_, index) => {
		const first = 3 + index * perPage

		return [offsets[first] ?? 0, offsets[first + perPage] ?? length] as const
	})

	return { length, pages }
}
