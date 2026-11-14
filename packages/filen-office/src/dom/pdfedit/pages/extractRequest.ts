import { estimateSavePeak, fitsBudget, type PdfMemoryProfile } from "../../../core/pdfedit/budget"
import { PdfEngineRefusal } from "../context"
import type { PdfRequestHandler } from "../requests"
import { extractDocument, extractSaveOptions } from "./extract"

// A new file made of pages of the edited document (extract, split, a copy without signatures), written into the heap
// and held there like a save's output: the page checks it in a verifying engine (serveOutput, checkSaved), streams it to
// its upload (writeOutput) and ends it (saveEnd "copied" or "failed"), one file at a time. The document and its
// history do not change. Encrypted like the document when it is (AES-256, with the password it was opened with)
// unless `protect` is false; an unencrypted document makes unencrypted files.

export interface PdfExtractArgs {
	// 0-based pages of the document as it stands, in order.
	readonly pages: readonly number[]
	readonly protect: boolean
	// The open file's size, for the memory estimate.
	readonly inputBytes: number
	readonly memory: PdfMemoryProfile
}

export type PdfExtractBegun =
	| {
			readonly status: "written"
			readonly size: number
			readonly pageCount: number
			// What checkSaved expects: "None", or PDF_EXTRACT_ENCRYPTION.
			readonly encryption: string
			// Signed signature fields drawn as page content.
			readonly flattenedSignatures: number
	  }
	| { readonly status: "refused"; readonly reason: "overBudget" | "unsupportedPassword" }

// How MuPDF names the encryption an encrypted new file gets (extractSaveOptions: AES-256, revision 6).
export const PDF_EXTRACT_ENCRYPTION = "Standard V5 R6 256-bit AES"

export const EXTRACT_REQUESTS: { readonly extractBegin: PdfRequestHandler<"extractBegin"> } = {
	extractBegin: (context, { pages, protect, inputBytes, memory }) => {
		const { document, edit } = context.open()

		if (edit === null) throw new PdfEngineRefusal("badRequest", "the document is not open for editing")
		if (edit.output !== null) throw new PdfEngineRefusal("badRequest", "a save is under way")

		const count = document.countPages()

		if (!Array.isArray(pages) || pages.length === 0 || pages.some(page => !Number.isInteger(page) || page < 0 || page >= count))
			throw new PdfEngineRefusal("badRequest", "no such page")

		const plan = {
			mode: "full" as const,
			encryption: "keep" as const,
			invalidates: [],
			// The copied pages' share of the file, written once.
			peakBytes: estimateSavePeak(Math.ceil((inputBytes * pages.length) / count), false),
			options: "",
			refuse: null
		}

		if (!fitsBudget(plan.peakBytes, memory)) return { value: { status: "refused", reason: "overBudget" } }

		const options = extractSaveOptions(document, edit.password === undefined ? null : { user: edit.password }, protect)

		if (!options.ok) return { value: { status: "refused", reason: options.reason } }

		// An open gesture ends first: the file shows the document as the user sees it.
		edit.endOpen(document)

		const extracted = extractDocument(context.mupdf, document, pages)
		let buffer

		try {
			buffer = extracted.document.saveToBuffer(options.options)
		} finally {
			extracted.document.destroy()
		}

		// Held as a save's output, ended without becoming the document's file.
		edit.output = {
			buffer,
			plan,
			serving: [],
			previousSaved: edit.savedApplied,
			security: null,
			encryption: options.encrypted ? PDF_EXTRACT_ENCRYPTION : "None",
			resets: false
		}
		context.mupdf.shrinkStore(50)

		return {
			value: {
				status: "written",
				size: buffer.getLength(),
				pageCount: pages.length,
				encryption: options.encrypted ? PDF_EXTRACT_ENCRYPTION : "None",
				flattenedSignatures: extracted.flattenedSignatures
			}
		}
	}
}
