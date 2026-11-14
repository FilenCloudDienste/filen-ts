import type { PdfMatrix } from "../../../core/pdfedit/matrix"
import { PdfEngineRefusal } from "../context"
import { applyOcrPage, type OcrGraft } from "../ocr/page"
import { graftOverlay } from "../overlay"
import type { MupdfModule } from "../protocol"
import { isIndex, isRecord, type PdfCommandTable } from "./types"

// Text recognition's change to a page: the recogniser's invisible text laid over it (one journal operation per page).
// It adds page content (a Form XObject drawn by the page), so it is a content edit for the signature policy and the
// author's restrictions, like editing text.

// A text-only page of recognised words is a few hundred KiB at most.
const MAX_OVERLAY_BYTES = 16 * 1024 * 1024

export interface PdfOcrCommands {
	"ocr.applyPage": { readonly page: number; readonly pdf: Uint8Array; readonly matrix: PdfMatrix }
}

// The graft OCR takes: overlay.ts with the overlay → page content matrix as it is.
export function ocrGraft(mupdf: MupdfModule): OcrGraft {
	return (document, pageIndex, overlayPdf, matrix) => {
		graftOverlay(mupdf, document, pageIndex, overlayPdf, { toPage: matrix })
	}
}

function parseMatrix(value: unknown): PdfMatrix | null {
	if (!Array.isArray(value) || value.length !== 6) return null

	const numbers = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item))

	if (numbers.length !== 6) return null

	const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = numbers

	return a * d - b * c === 0 ? null : [a, b, c, d, e, f]
}

export const OCR_COMMANDS: PdfCommandTable<PdfOcrCommands> = {
	"ocr.applyPage": {
		tool: "content",
		parse: args => {
			if (!isRecord(args) || !isIndex(args["page"])) return null

			const pdf = args["pdf"]
			const matrix = parseMatrix(args["matrix"])

			if (!(pdf instanceof Uint8Array) || pdf.byteLength === 0 || pdf.byteLength > MAX_OVERLAY_BYTES || matrix === null) return null

			return { page: args["page"], pdf, matrix }
		},
		run: (context, args) => {
			if (args.page >= context.document.countPages()) throw new PdfEngineRefusal("badRequest", "no such page")

			return applyOcrPage(context.mupdf, ocrGraft(context.mupdf), context.document, args)
		}
	}
}
