import type { PdfFaceSource } from "../../fonts/manager"
import { NO_HINTS, SUBSTITUTIONS, fallbackFor } from "../../fonts/substitutes"
import {
	PdfWriter,
	type PdfAbortSignal,
	type PdfDeflate,
	type PdfImageDecoder,
	type PdfOutput,
	type RandomBytes
} from "../../pdfwrite/index"
import { PdfFontSet, type PdfFontAssets, type PdfFontFaceRequest } from "../../pdfwrite/fonts/index"
import type { Slicing } from "../../slicing"
import { DocxPagePainter, type DocxPdfRefusal, type PagePaintContext } from "./paint"
import type { DocxPdfDocument, DocxPdfFace } from "./types"

// A laid-out document (DocxPdfDocument) as a tagged PDF (PDF 1.7, ISO 14289-1 PDF/UA-1): pages written one
// at a time as they are painted, fonts subset after the last page, bookmarks as named destinations, headings
// as the outline. A password encrypts it (AES-256). The output is a list of parts for a Blob.

export interface DocxPdfOptions {
	readonly assets: PdfFontAssets
	// Encrypts the PDF with this user password (the source's own, for a password-protected document).
	readonly password?: string
	// Same input, same bytes (no dates; tests).
	readonly deterministic?: boolean
	readonly signal?: PdfAbortSignal
	readonly slicing?: Slicing
	// Pages written so far of all.
	readonly onProgress?: (done: number, total: number) => void
	readonly deflate?: PdfDeflate | null
	readonly decoder?: PdfImageDecoder
	readonly random?: RandomBytes
	// Untagged output (no structure tree); tagged by default.
	readonly tagged?: boolean
	// BCP 47 language of a document that declares none (the app's locale): a tagged PDF must give one
	// (ISO 14289-1 §7.2).
	readonly lang?: string
}

export interface DocxPdfReport {
	// Characters drawn as .notdef because no face has them, by ISO 15924 script.
	readonly missing: ReadonlyMap<string, number>
	// Content drawn approximately or left out, by kind.
	readonly refused: ReadonlyMap<DocxPdfRefusal, number>
}

export interface DocxPdfResult extends PdfOutput {
	readonly report: DocxPdfReport
}

// Requests for the styles' faces name them by index under this prefix (no document family starts with it).
const FACE_PREFIX = "\u0001face:"

function faceSource(face: DocxPdfFace): PdfFaceSource {
	if (face.kind === "bundled") return face

	const bytes = face.bytes

	return {
		kind: "embedded",
		key: face.key,
		read: async maxBytes => {
			if (bytes.length > maxBytes) throw new Error("The embedded font is larger than allowed")

			return Promise.resolve(bytes)
		},
		fsType: face.fsType,
		weight: face.weight,
		italic: face.italic,
		substitute: face.substitute
	}
}

// Families without a face of the document's own (an equation's text): the bundled substitute, as layout
// substitutes them.
function bundledSource(request: PdfFontFaceRequest): PdfFaceSource {
	const substitution = SUBSTITUTIONS.get(request.family.toLowerCase())
	const family = substitution?.family ?? fallbackFor(request.family, NO_HINTS, true).family ?? "arimo"

	return { kind: "bundled", family, weight: request.bold ? 700 : (substitution?.weight ?? 400), italic: request.italic }
}

function abortError(signal: PdfAbortSignal): unknown {
	return signal.reason ?? Object.assign(new Error("The PDF export was aborted"), { name: "AbortError" })
}

// An abort surfaces as itself, whatever was under way (a font load wraps what stopped it).
export async function writeDocxPdf(doc: DocxPdfDocument, options: DocxPdfOptions): Promise<DocxPdfResult> {
	const signal = options.signal

	const aborted = (): boolean => signal?.aborted === true

	if (signal !== undefined && aborted()) throw abortError(signal)

	try {
		return await write(doc, options)
	} catch (error) {
		if (signal !== undefined && aborted()) throw abortError(signal)

		throw error
	}
}

async function write(doc: DocxPdfDocument, options: DocxPdfOptions): Promise<DocxPdfResult> {
	const sources = doc.faces.map(faceSource)
	const fonts = new PdfFontSet({
		assets: options.assets,
		resolve: request => {
			if (request.family.startsWith(FACE_PREFIX)) {
				const source = sources[Number(request.family.slice(FACE_PREFIX.length))]

				if (source !== undefined) return source
			}

			return bundledSource(request)
		},
		deterministic: options.deterministic === true,
		...(options.signal === undefined ? {} : { signal: options.signal })
	})

	try {
		const writer = await PdfWriter.create({
			tagged: options.tagged !== false,
			deterministic: options.deterministic === true,
			title: doc.title,
			...(doc.properties === undefined ? {} : { properties: doc.properties }),
			...((doc.lang ?? options.lang) === undefined ? {} : { lang: doc.lang ?? options.lang }),
			...(options.password === undefined ? {} : { password: options.password }),
			...(options.signal === undefined ? {} : { signal: options.signal }),
			...(options.slicing === undefined ? {} : { slicing: options.slicing }),
			...(options.deflate === undefined ? {} : { deflate: options.deflate }),
			...(options.decoder === undefined ? {} : { decoder: options.decoder }),
			...(options.random === undefined ? {} : { random: options.random })
		})
		const requests: PdfFontFaceRequest[] = doc.styles.map(style => ({
			family: `${FACE_PREFIX}${style.face}`,
			bold: style.bold,
			italic: style.italic,
			slot: style.slot,
			...(style.language === undefined ? {} : { language: style.language })
		}))
		const refused = new Map<DocxPdfRefusal, number>()
		const context: PagePaintContext = {
			writer,
			fonts,
			doc,
			requests,
			media: doc.media,
			seen: new Set(),
			heading: 0,
			refused,
			yieldIfDue: () => writer.yieldIfDue()
		}

		for (const [name, target] of doc.destinations) writer.destination(name, { page: target.page, y: target.y })

		for (const entry of doc.outline) writer.outline(entry.title, entry.level, { page: entry.page, y: entry.y })

		const total = doc.pages.length

		for (let index = 0; index < total; index++) {
			const data = doc.pages[index]

			if (data === undefined) continue

			const page = writer.beginPage(data.width, data.height)
			const painter = new DocxPagePainter(context, page, data)

			await painter.paint()
			painter.closeAll()
			await writer.endPage(page)
			options.onProgress?.(index + 1, total)
		}

		const output = await writer.finish()

		const unshaped = fonts.unshaped()

		if (unshaped > 0) refused.set("shaping", unshaped)

		return { ...output, report: { missing: new Map(fonts.missing()), refused } }
	} finally {
		fonts.close()
	}
}
