import type * as Mupdf from "mupdf"
import type { CropMargins } from "../../../core/pdfedit/crop"
import type { RedactionMark } from "../../../core/pdfedit/redactVerify"
import { cropPages, cropPagesToContent, outsideCropRects } from "../pages/index"
import { applyPageRedactions, markArea, markText, pageRedactionMarks, removeRedactionMark } from "../redact/index"
import type { MupdfModule } from "../protocol"
import { isIndex, isRecord, type PdfCommandTable } from "./types"

// Cropping: a crop box set from margins (points off each side of each page as it shows), each page fitted to what it
// draws ("Remove white margins"), and a crop that also deletes what lies outside it. Cropping alone hides content
// (it stays in the file); the deleting one marks the outside as redaction areas and applies them through the
// redaction block (drawings touching the outside go whole, text and image pixels there go), then crops. Pending
// redaction marks the user made on those pages are set aside meanwhile and put back, so only the outside is applied.

const MAX_PAGES = 100_000
// Points: a margin or padding no page reaches (MuPDF's page limit is 14 400 pt a side).
const MAX_POINTS = 100_000

export interface PdfCropCommands {
	"crop.set": { readonly pages: readonly number[]; readonly margins: CropMargins }
	"crop.toContent": { readonly pages: readonly number[]; readonly padding: number }
	"crop.removeOutside": { readonly pages: readonly number[]; readonly margins: CropMargins }
}

function isPoints(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_POINTS
}

function parsePages(args: unknown): readonly number[] | null {
	if (!isRecord(args)) return null

	const pages = args["pages"]

	return Array.isArray(pages) && pages.length > 0 && pages.length <= MAX_PAGES && pages.every(isIndex) ? pages : null
}

function parseMargins(args: unknown): { readonly pages: readonly number[]; readonly margins: CropMargins } | null {
	const pages = parsePages(args)
	const margins = isRecord(args) ? args["margins"] : undefined

	if (pages === null || !isRecord(margins)) return null

	const { left, top, right, bottom } = margins

	return isPoints(left) && isPoints(top) && isPoints(right) && isPoints(bottom) ? { pages, margins: { left, top, right, bottom } } : null
}

// Deletes what lies outside `margins`' crop on each page; returns the pages that changed (a form field's other widgets
// on other pages lose a removed value too).
function removeOutside(mupdf: MupdfModule, document: Mupdf.PDFDocument, pages: readonly number[], margins: CropMargins): number[] {
	const changed = new Set<number>()

	for (const [index, rects] of outsideCropRects(document, pages, margins)) {
		if (rects.length === 0) continue

		let page = document.loadPage(index)
		const pending: RedactionMark[] = pageRedactionMarks(page, index)

		for (const mark of pending) removeRedactionMark(page, mark.id)
		for (const rect of rects) markArea(page, rect)

		page.destroy()

		for (const other of applyPageRedactions(mupdf, document, index, { removeAnnotations: true }).pages) changed.add(other)

		page = document.loadPage(index)

		for (const mark of pending) {
			if (mark.kind === "text") markText(page, mark.quads)
			else markArea(page, mark.rect)
		}

		page.destroy()
		changed.add(index)
	}

	return [...changed]
}

function sorted(pages: Iterable<number>): number[] {
	return [...new Set(pages)].sort((a, b) => a - b)
}

export const CROP_COMMANDS: PdfCommandTable<PdfCropCommands> = {
	"crop.set": {
		tool: "pages",
		parse: parseMargins,
		run: (context, { pages, margins }) => [...cropPages(context.document, pages, margins).touched]
	},
	"crop.toContent": {
		tool: "pages",
		parse: args => {
			const pages = parsePages(args)
			const padding = isRecord(args) ? args["padding"] : undefined

			return pages !== null && isPoints(padding) ? { pages, padding } : null
		},
		run: (context, { pages, padding }) => [...cropPagesToContent(context.mupdf, context.document, pages, padding).touched]
	},
	"crop.removeOutside": {
		tool: "content",
		// What was outside stays in the file's earlier versions.
		removesContent: true,
		parse: parseMargins,
		run: (context, { pages, margins }) => {
			const removed = removeOutside(context.mupdf, context.document, pages, margins)

			return sorted([...removed, ...cropPages(context.document, pages, margins).touched])
		}
	}
}
