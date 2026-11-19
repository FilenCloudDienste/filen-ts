import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { pdfSignatureFields, type PdfSignatureFieldHint } from "../../dom/pdf/signatureFields"
import { openPdf, pageText } from "../docxPdfFixtures"

// What pdf.js reads of a saved file, for the engine and page tests. Kept out of fixtures.ts, which the engine worker
// imports.

// Each page's text.
export async function pdfjsTexts(bytes: Uint8Array, password?: string): Promise<string[]> {
	const pdf = await openPdf(bytes, password)
	const out: string[] = []

	for (let page = 1; page <= pdf.numPages; page++) out.push(await pageText(pdf, page))

	await pdf.loadingTask.destroy()

	return out
}

// The signatures pdf.js reads, the hints the engine's check cross-checks.
export async function pdfjsHints(bytes: Uint8Array): Promise<PdfSignatureFieldHint[] | null> {
	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
	const hints = pdfSignatureFields(await (await task.promise).getSignatures())

	await task.destroy()

	return hints
}
