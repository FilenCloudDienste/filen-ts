// A minimal PDF writer for test fixtures: numbered objects, a classic cross-reference table, and optionally the
// linearized layout (ISO 32000-1 Annex F) whose first-page section lets a reader show page 1 before the rest arrives.
// The hint stream is a placeholder (readers do not need it to read the file).

export type PdfBody = string | Uint8Array

export interface PdfObject {
	// The dictionary or value, without "obj"/"endobj".
	readonly dict: string
	// A stream's bytes; its /Length is added.
	readonly stream?: Uint8Array
}

const encoder = new TextEncoder()

function bytes(part: PdfBody): Uint8Array {
	return typeof part === "string" ? encoder.encode(part) : part
}

function concat(parts: readonly PdfBody[]): Uint8Array {
	const chunks = parts.map(bytes)
	const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
	let at = 0

	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}

function serialise(number: number, object: PdfObject): Uint8Array {
	if (object.stream === undefined) return bytes(`${String(number)} 0 obj\n${object.dict}\nendobj\n`)

	const dict = object.dict.replace(/>>\s*$/, `/Length ${String(object.stream.length)} >>`)

	return concat([`${String(number)} 0 obj\n${dict}\nstream\n`, object.stream, "\nendstream\nendobj\n"])
}

function xrefEntry(offset: number): string {
	return `${String(offset).padStart(10, "0")} 00000 n \n`
}

const HEADER = concat(["%PDF-1.7\n%", Uint8Array.from([0xe2, 0xe3, 0xcf, 0xd3]), "\n"])

// Objects are numbered from 1 in list order; `root` is the catalog's number.
export function writePdf(objects: readonly PdfObject[], root: number): Uint8Array {
	const parts: Uint8Array[] = [HEADER]
	const offsets: number[] = []
	let at = HEADER.length

	objects.forEach((object, index) => {
		const body = serialise(index + 1, object)

		offsets.push(at)
		parts.push(body)
		at += body.length
	})

	const size = objects.length + 1
	const xref = `xref\n0 ${String(size)}\n0000000000 65535 f \n${offsets.map(xrefEntry).join("")}`
	const trailer = `trailer\n<< /Size ${String(size)} /Root ${String(root)} 0 R >>\nstartxref\n${String(at)}\n%%EOF\n`

	return concat([...parts, xref, trailer])
}

export interface LinearizedDocument {
	// Every object but the first page's, numbered from 1 (the catalog and page tree among them).
	readonly rest: readonly PdfObject[]
	// The first page's own objects: the page itself first, then its resources and content. Numbered after `rest`,
	// after the linearization dictionary and the hint stream.
	readonly firstPage: readonly PdfObject[]
	readonly root: number
	readonly pages: number
}

const NUMBER_WIDTH = 10

function padded(value: number): string {
	return String(value).padStart(NUMBER_WIDTH, "0")
}

// The linearized layout: header, linearization dictionary, first-page cross-reference section (with /Prev to the main
// one), hint stream, first-page objects, the rest, the main cross-reference section. Offsets in the linearization
// dictionary are fixed-width, so it is laid out once with every offset known.
export function writeLinearizedPdf(document: LinearizedDocument): Uint8Array {
	const restCount = document.rest.length
	const linNumber = restCount + 1
	const hintNumber = restCount + 2
	const pageNumber = restCount + 3
	const firstCount = document.firstPage.length + 2
	const size = restCount + firstCount + 1
	const hint: PdfObject = { dict: "<< /S 0 >>", stream: new Uint8Array(16) }
	const linDict = (fields: { length: number; hintOffset: number; hintLength: number; end: number; mainXref: number }): string =>
		`<< /Linearized 1 /L ${padded(fields.length)} /H [ ${padded(fields.hintOffset)} ${padded(fields.hintLength)} ] /O ${String(pageNumber)} /E ${padded(fields.end)} /N ${String(document.pages)} /T ${padded(fields.mainXref)} >>`
	const layout = (fields: { length: number; hintOffset: number; hintLength: number; end: number; mainXref: number }) => {
		const lin = serialise(linNumber, { dict: linDict(fields) })
		const firstBodies = [hint, ...document.firstPage].map((object, index) => serialise(hintNumber + index, object))
		const restBodies = document.rest.map((object, index) => serialise(index + 1, object))
		const firstXrefStart = HEADER.length + lin.length
		// The first-page section's xref lists objects by offset, so its own length is fixed (20 bytes an entry).
		const firstXrefLength = `xref\n${String(linNumber)} ${String(firstCount)}\n`.length + firstCount * 20
		const firstTrailer = `trailer\n<< /Size ${String(size)} /Root ${String(document.root)} 0 R /Prev ${padded(fields.mainXref)} >>\nstartxref\n0\n%%EOF\n`
		let at = firstXrefStart + firstXrefLength + firstTrailer.length
		const firstOffsets: number[] = []

		for (const body of firstBodies) {
			firstOffsets.push(at)
			at += body.length
		}

		const end = at
		const restOffsets: number[] = []

		for (const body of restBodies) {
			restOffsets.push(at)
			at += body.length
		}

		const mainXref = at
		const firstXref = `xref\n${String(linNumber)} ${String(firstCount)}\n${[HEADER.length, ...firstOffsets].map(xrefEntry).join("")}`
		const mainXrefText = `xref\n0 ${String(restCount + 1)}\n0000000000 65535 f \n${restOffsets.map(xrefEntry).join("")}`
		const mainTrailer = `trailer\n<< /Size ${String(restCount + 1)} >>\nstartxref\n${String(firstXrefStart)}\n%%EOF\n`
		const firstHint = firstBodies[0]
		const file = concat([HEADER, lin, firstXref, firstTrailer, ...firstBodies, ...restBodies, mainXrefText, mainTrailer])

		return {
			file,
			fields: {
				length: file.length,
				hintOffset: firstOffsets[0] ?? 0,
				hintLength: firstHint?.length ?? 0,
				end,
				mainXref
			}
		}
	}
	// Twice: the second pass has every offset (the fields are fixed-width, so they do not move anything).
	const first = layout({ length: 0, hintOffset: 0, hintLength: 0, end: 0, mainXref: 0 })

	return layout(first.fields).file
}
