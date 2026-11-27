import { isOcrCandidate } from "../../core/pdfedit/ocrGeometry"
import type { PdfFontAssets } from "../../core/pdfwrite/fonts"
import { parseTextEditChars } from "./commands/textEdit"
import { checkPage, parseRect } from "./commands/types"
import { PdfEngineRefusal, type PdfEngineContext } from "./context"
import { editing } from "./editRequests"
import { ocrPageSummary, renderPageForOcr } from "./ocr/page"
import type { PdfRequestHandler } from "./requests"
import { previewTextEdit } from "./textEdit/apply"
import { prepareTextEdit } from "./textEdit/prepare"
import { hitTestText } from "./textEdit/target"

// The requests tools make besides commands: what a click on a page could edit, the page under an opened text editor
// without the text it replaces, new text laid out ahead of the command that grafts it, and text recognition's page
// scan, renders and store flushes.

type ToolOp = "textHit" | "textPreview" | "textPrepare" | "ocrScan" | "ocrRender" | "ocrFlush"

type Handlers = { readonly [K in ToolOp]: PdfRequestHandler<K> }

// Text one edit lays out at most.
const MAX_TEXT = 100_000
// A preview's margin around its rect (points), and its most pixels (its scale is lowered to fit: 4 MiB of RGBA).
const PREVIEW_MARGIN = 2
const PREVIEW_MAX_PIXELS = 1024 * 1024

function pageIndex(context: PdfEngineContext, page: number): number {
	checkPage(context.open().document, page)

	return page
}

// textPrepare with the font files the worker serves (the office PDF writer's faces, fetched there on first use).
export function textPrepareRequest(assets: PdfFontAssets): PdfRequestHandler<"textPrepare"> {
	return async (_context, { source, text, style }) => {
		if (typeof text !== "string" || text.length > MAX_TEXT) throw new PdfEngineRefusal("badRequest")

		const overlay = await prepareTextEdit(source, text, assets, style)

		return overlay === null ? { value: null } : { value: overlay, transfer: [overlay.buffer] }
	}
}

export const TOOL_REQUESTS: Handlers = {
	textHit: (context, { page, point, unit }) => {
		const { document } = context.open()
		const [x, y] = point

		if (!Number.isFinite(x) || !Number.isFinite(y)) throw new PdfEngineRefusal("badRequest")

		const loaded = document.loadPage(pageIndex(context, page))

		try {
			return { value: hitTestText(loaded, [x, y], unit === undefined ? {} : { unit }) }
		} finally {
			loaded.destroy()
		}
	},
	textPreview: async (context, { page, chars, rect, scale }) => {
		const { document, edit, renderer } = editing(context)
		const glyphs = parseTextEditChars(chars)
		const box = parseRect(rect)

		if (glyphs === null || box === null || box[2] <= box[0] || box[3] <= box[1] || !Number.isFinite(scale) || !(scale > 0))
			throw new PdfEngineRefusal("badRequest")

		const index = pageIndex(context, page)
		const [x0, y0, x1, y1] = box
		const width = x1 - x0 + 2 * PREVIEW_MARGIN
		const height = y1 - y0 + 2 * PREVIEW_MARGIN
		const drawScale = Math.min(scale, Math.sqrt(PREVIEW_MAX_PIXELS / (width * height)))
		// Null: busy; `drawn` null: unsafe. The pixels are out of the heap before the operation is abandoned.
		const preview = edit.preview(document, () => ({
			drawn: previewTextEdit(context.mupdf, document, index, { chars: glyphs }, loaded => {
				const [bx = 0, by = 0] = loaded.getBounds()

				return renderer.renderLoaded(loaded, drawScale, [
					(x0 - PREVIEW_MARGIN - bx) * drawScale,
					(y0 - PREVIEW_MARGIN - by) * drawScale,
					(x1 + PREVIEW_MARGIN - bx) * drawScale,
					(y1 + PREVIEW_MARGIN - by) * drawScale
				])
			})
		}))

		if (preview === null) return { value: { status: "busy" } }

		const { drawn } = preview

		if (drawn === null) return { value: { status: "unsafe" } }

		const bitmap = await context.host.toBitmap(drawn.rgba, drawn.width, drawn.height)

		return { value: { status: "clean", bitmap, tile: drawn.tile, scale: drawScale }, transfer: [bitmap] }
	},
	// Font files are the host's: a worker without them never lays out text.
	textPrepare: () => {
		throw new PdfEngineRefusal("badRequest", "text layout is not served")
	},
	ocrScan: (context, { from, count }) => {
		const { document } = context.open()
		const total = document.countPages()
		const start = from ?? 0
		const end = count === undefined ? total : Math.min(total, start + count)

		if (!Number.isInteger(start) || start < 0 || start > total) throw new PdfEngineRefusal("badRequest")

		if (count !== undefined && (!Number.isInteger(count) || count < 1)) throw new PdfEngineRefusal("badRequest")

		const scanned: number[] = []

		for (let index = start; index < end; index++) {
			const page = document.loadPage(index)

			try {
				if (isOcrCandidate(ocrPageSummary(context.mupdf, page))) scanned.push(index)
			} finally {
				page.destroy()
			}
		}

		// The pass loaded the run's images (their compressed streams) and resources: let them go.
		context.mupdf.shrinkStore(50)

		return { value: { scanned, pageCount: total } }
	},
	ocrRender: (context, { page }) => {
		const { document } = context.open()
		const render = renderPageForOcr(context.mupdf, document, pageIndex(context, page))

		return {
			value: {
				pixels: render.pixels,
				width: render.width,
				height: render.height,
				stride: render.stride,
				dpi: render.dpi,
				pixelToPage: render.pixelToPage
			},
			transfer: [render.pixels.buffer]
		}
	},
	ocrFlush: context => {
		context.mupdf.emptyStore()

		return { value: null }
	}
}
