import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import * as mupdf from "mupdf"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { readStext, allChars, type StextChar } from "../../dom/pdfedit/textEdit/stext"

// PDFs for the text-editing and overlay tests, written with MuPDF from content streams typed here (no binary
// fixtures): Helvetica (standard 14, not embedded) lines, a Type 3 font, vertical CJK-style writing through an
// Identity-V Type0 font made from the bundled Arimo, glyph-like outlines without text, a rotated page with a CropBox
// away from the origin, a tagged catalog.

const FONTS = new URL("../../../assets/fonts/", import.meta.url)

export interface PageSpec {
	readonly content: string
	readonly mediaBox?: readonly [number, number, number, number]
	readonly cropBox?: readonly [number, number, number, number]
	readonly rotate?: 0 | 90 | 180 | 270
	readonly userUnit?: number
}

export interface DocumentSpec {
	readonly pages: readonly PageSpec[]
	readonly tagged?: boolean
}

export const LINE = "Hello brave new world"
export const SECOND = "Second line stays"

// Helvetica 12 pt: LINE on a baseline 120 pt below the top of an A4 page, SECOND 30 pt under it.
export const LATIN_CONTENT = `BT /F1 12 Tf 72 722 Td (${LINE}) Tj ET BT /F1 12 Tf 72 692 Td (${SECOND}) Tj ET`

// Pages have the fonts F1 (Helvetica), F2 (Times-Bold, as "ABCDEF+Garamond-Italic" when `garamond`), F3 (Type 3,
// one square glyph for "A"), F4 (Arimo as an Identity-V Type0 font).
export function makeDocument(spec: DocumentSpec): mupdf.PDFDocument {
	const document = new mupdf.PDFDocument()
	const helvetica = document.addSimpleFont(new mupdf.Font("Helvetica"))
	const times = document.addSimpleFont(new mupdf.Font("Times-Italic"))

	times.put("BaseFont", document.newName("ABCDEF+Garamond-Italic"))

	const glyph = document.addStream("600 0 0 0 500 700 d1 0 0 500 700 re f", {})
	const type3 = document.addObject({
		Type: "Font",
		Subtype: "Type3",
		FontBBox: [0, 0, 1000, 1000],
		FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
		CharProcs: { square: glyph },
		Encoding: { Type: "Encoding", Differences: [65, "square"] },
		FirstChar: 65,
		LastChar: 65,
		Widths: [600],
		Resources: {}
	})
	const arimo = document.addFont(new mupdf.Font("Arimo", arimoBytes()))

	arimo.put("Encoding", document.newName("Identity-V"))

	const resources = document.addObject({ Font: { F1: helvetica, F2: times, F3: type3, F4: arimo } })

	for (const page of spec.pages) {
		const object = document.addPage([...(page.mediaBox ?? [0, 0, 595, 842])], page.rotate ?? 0, resources, page.content)

		if (page.cropBox !== undefined) object.put("CropBox", [...page.cropBox])
		if (page.userUnit !== undefined) object.put("UserUnit", page.userUnit)

		document.insertPage(-1, object)
	}

	if (spec.tagged === true) document.getTrailer().get("Root").put("MarkInfo", { Marked: true })

	return document
}

let arimo: Uint8Array | undefined

export function arimoBytes(): Uint8Array {
	return (arimo ??= new Uint8Array(gunzipSync(readFileSync(new URL("arimo/Arimo-Regular.ttf.gz", FONTS)))))
}

// Hex glyph ids of `text` in Arimo, for F4 (Identity: code = glyph id).
export function arimoCodes(text: string): string {
	const font = new mupdf.Font("Arimo", arimoBytes())

	return `<${[...text].map(char => font.encodeCharacter(char).toString(16).padStart(4, "0")).join("")}>`
}

export function save(document: mupdf.PDFDocument): Uint8Array {
	return document.saveToBuffer("garbage=compact,compress").asUint8Array().slice()
}

export function reopen(bytes: Uint8Array): mupdf.PDFDocument {
	const document = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()

	if (document === null) throw new Error("Not a PDF")

	return document
}

export function pageChars(document: mupdf.PDFDocument, index: number): StextChar[] {
	const page = document.loadPage(index)
	const chars = allChars(readStext(page))

	page.destroy()

	return chars
}

export function pageString(document: mupdf.PDFDocument, index: number): string {
	return pageChars(document, index)
		.map(char => char.c)
		.join("")
}

// The fonts MuPDF reports for the characters of `text` on a page.
export function fontsOf(document: mupdf.PDFDocument, index: number, text: string): Set<string> {
	const page = document.loadPage(index)
	const names = new Set<string>()
	const wanted = new Set(text)

	page.toDisplayList(false)
		.toStructuredText("preserve-whitespace")
		.walk({
			onChar: (c, _origin, font) => {
				if (wanted.has(c)) names.add(font.getName())
			}
		})
	page.destroy()

	return names
}

export interface PdfjsGlyphRun {
	readonly text: string
	// Start of the run on its baseline, display space of the page as shown (points, y down).
	readonly x: number
	readonly y: number
}

export async function pdfjsRuns(bytes: Uint8Array, pageNumber: number): Promise<PdfjsGlyphRun[]> {
	const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 })
	const pdf = await task.promise

	try {
		const page = await pdf.getPage(pageNumber)
		const viewport = page.getViewport({ scale: 1 })
		const content = await page.getTextContent()
		const runs: PdfjsGlyphRun[] = []

		for (const item of content.items) {
			if (!("str" in item) || item.str.length === 0) continue

			const [x, y] = viewport.convertToViewportPoint(item.transform[4] ?? 0, item.transform[5] ?? 0)

			runs.push({ text: item.str, x: x ?? 0, y: y ?? 0 })
		}

		return runs
	} finally {
		await task.destroy()
	}
}
