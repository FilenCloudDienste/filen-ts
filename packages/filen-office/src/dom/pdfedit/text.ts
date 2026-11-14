import type * as Mupdf from "mupdf"
import type { PdfRect } from "../../core/pdfedit/state"
import { pdfExternalLink } from "../pdf/links"
import { flipRect } from "./formState"

// A destination's point in its page's bottom-left user space; an axis its fit type leaves alone is null.
export function pointOf(
	destination: { readonly x: number; readonly y: number; readonly type: string },
	bounds: Mupdf.Rect
): { readonly left: number | null; readonly top: number | null } {
	const { type, x, y } = destination
	const left = type === "XYZ" || type === "FitR" || type === "FitV" || type === "FitBV"
	const top = type === "XYZ" || type === "FitR" || type === "FitH" || type === "FitBH"

	return { left: left && Number.isFinite(x) ? x - bounds[0] : null, top: top && Number.isFinite(y) ? bounds[3] - y : null }
}

// A page's text and links from MuPDF's structured text, in the shapes the viewer's pdf.js path already uses: one text
// item per line (its string, baseline origin, size, direction and advance), as pdf.js's text content gives one item
// per run, and link rectangles with either a URL or a destination. Coordinates are the page's bottom-left user space
// (state.ts), so a pdf.js-style viewport over the page's size places them.

export interface PdfTextLine {
	readonly str: string
	// Baseline origin of the first character.
	readonly x: number
	readonly y: number
	// Font size in points.
	readonly size: number
	// Unit writing direction (y up).
	readonly dx: number
	readonly dy: number
	// Advance along the direction from the origin to the end of the last character.
	readonly width: number
}

export type PdfTextLink =
	| { readonly rect: PdfRect; readonly url: string }
	// A 0-based page and the point to show at the view's top left, in that page's user space (null: keep the axis).
	| { readonly rect: PdfRect; readonly page: number; readonly left: number | null; readonly top: number | null }

export interface PdfPageText {
	readonly lines: readonly PdfTextLine[]
	readonly links: readonly PdfTextLink[]
}

interface LineDraft {
	str: string
	x: number
	y: number
	size: number
	dx: number
	dy: number
	endX: number
	endY: number
}

// Text lines of a loaded page (whitespace kept, so find and copy see spaces).
export function pageTextLines(page: Mupdf.PDFPage): PdfTextLine[] {
	const bounds = page.getBounds()
	const lines: PdfTextLine[] = []
	const text = page.toStructuredText("preserve-whitespace")
	let line: LineDraft | null = null
	let direction: Mupdf.Point = [1, 0]

	try {
		text.walk({
			beginLine: (_bbox, _wmode, dir) => {
				direction = dir
				line = null
			},
			onChar: (c, origin, _font, size, quad) => {
				// The lower right corner of the character's quad: where the next one would start.
				const endX = quad[6]
				const endY = quad[7]

				if (line === null) {
					line = { str: c, x: origin[0], y: origin[1], size, dx: direction[0], dy: direction[1], endX, endY }

					return
				}

				line.str += c
				line.size = Math.max(line.size, size)
				line.endX = endX
				line.endY = endY
			},
			endLine: () => {
				const done: LineDraft | null = line

				line = null

				if (done === null || done.str.trim().length === 0) return

				// Page space is y down; the item's direction and origin are given y up.
				const width = (done.endX - done.x) * done.dx + (done.endY - done.y) * done.dy

				lines.push({
					str: done.str,
					x: done.x - bounds[0],
					y: bounds[3] - done.y,
					size: done.size,
					dx: done.dx,
					dy: done.dy === 0 ? 0 : -done.dy,
					width: Math.max(0, width)
				})
			}
		})
	} finally {
		text.destroy()
	}

	return lines
}

// The page's links; `boundsOf` gives another page's bounds for a destination on it. A URL is kept only when the shared
// link policy allows it (the viewer's own gate, pdfExternalLink): MuPDF gives other files' destinations (GoToR) and
// launch actions as file: URIs, and the document's own URI actions as written, so everything else is dropped. A
// destination in the document is MuPDF's "#..." URI, resolved to a page and point.
export function pageTextLinks(
	document: Mupdf.PDFDocument,
	page: Mupdf.PDFPage,
	boundsOf: (index: number) => Mupdf.Rect | null
): PdfTextLink[] {
	const bounds = page.getBounds()
	const links: PdfTextLink[] = []

	for (const link of page.getLinks()) {
		const rect = flipRect(link.getBounds(), bounds)
		const uri = link.getURI()

		if (link.isExternal() || !uri.startsWith("#")) {
			const url = pdfExternalLink(uri)

			if (url !== null) links.push({ rect, url })

			continue
		}

		let destination: ReturnType<Mupdf.PDFDocument["resolveLinkDestination"]>

		try {
			destination = document.resolveLinkDestination(uri)
		} catch {
			continue
		}

		const target = boundsOf(destination.page)

		if (target === null) continue

		links.push({ rect, page: destination.page, ...pointOf(destination, target) })
	}

	return links
}
