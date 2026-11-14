import { isOcrCandidate } from "../../core/pdfedit/ocrGeometry"
import type { PdfFontAssets } from "../../core/pdfwrite/fonts"
import { PdfEngineRefusal, type PdfEngineContext } from "./context"
import { ocrPageSummary, renderPageForOcr } from "./ocr/page"
import type { PdfRequestHandler } from "./requests"
import { prepareTextEdit } from "./textEdit/prepare"
import { hitTestText } from "./textEdit/target"

// The requests tools make besides commands: what a click on a page could edit, new text laid out ahead of the command
// that grafts it, and text recognition's page scan, renders and store flushes.

type ToolOp = "textHit" | "textPrepare" | "ocrScan" | "ocrRender" | "ocrFlush"

type Handlers = { readonly [K in ToolOp]: PdfRequestHandler<K> }

// Text one edit lays out at most.
const MAX_TEXT = 100_000

function pageIndex(context: PdfEngineContext, page: number): number {
	if (!Number.isInteger(page) || page < 0 || page >= context.open().document.countPages()) throw new PdfEngineRefusal("badRequest")

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
	// Font files are the host's: a worker without them never lays out text.
	textPrepare: () => {
		throw new PdfEngineRefusal("badRequest", "text layout is not served")
	},
	ocrScan: context => {
		const { document } = context.open()
		const count = document.countPages()
		const scanned: number[] = []

		for (let index = 0; index < count; index++) {
			const page = document.loadPage(index)

			try {
				if (isOcrCandidate(ocrPageSummary(context.mupdf, page))) scanned.push(index)
			} finally {
				page.destroy()
			}
		}

		// The pass read every page's resources: let them go.
		context.mupdf.shrinkStore(50)

		return { value: { scanned } }
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
