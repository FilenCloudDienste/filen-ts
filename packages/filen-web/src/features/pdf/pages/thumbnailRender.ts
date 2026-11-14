import { isMupdfDocument, type PdfEditEngine } from "@filen/office/react/pdfedit"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import type { RenderThumbnail } from "@/features/pdf/pages/thumbnails"

// Where the pages rail's thumbnails come from: before the editor has the document, pdf.js draws each into a canvas of
// the thumbnail's size (turned into a bitmap, the canvas freed at once); after, the engine draws the whole page as one
// tile at "thumbnail" priority (below the pages in view), handed over as a bitmap with no canvas on the page.

function aborted(): Error {
	return new DOMException("aborted", "AbortError")
}

async function pageSize(document: PdfDomDocument, page: number): Promise<{ readonly width: number; readonly height: number }> {
	const viewport = (await document.getPage(page + 1)).getViewport({ scale: 1 })

	return { width: viewport.width, height: viewport.height }
}

function pdfjsThumbnail(document: PdfDomDocument): RenderThumbnail {
	return async (page, widthPx, signal) => {
		const pdfPage = await document.getPage(page + 1)

		if (signal.aborted) throw aborted()

		const base = pdfPage.getViewport({ scale: 1 })
		const viewport = pdfPage.getViewport({ scale: widthPx / Math.max(1, base.width) })
		const canvas = window.document.createElement("canvas")

		canvas.width = Math.max(1, Math.round(viewport.width))
		canvas.height = Math.max(1, Math.round(viewport.height))

		const task = pdfPage.render({ canvas, viewport })
		const cancel = (): void => {
			task.cancel()
		}

		signal.addEventListener("abort", cancel, { once: true })

		try {
			await task.promise

			return await createImageBitmap(canvas)
		} finally {
			signal.removeEventListener("abort", cancel)
			canvas.width = 0
			canvas.height = 0
		}
	}
}

function engineThumbnail(document: PdfDomDocument, engine: PdfEditEngine): RenderThumbnail {
	return async (page, widthPx, signal) => {
		const size = await pageSize(document, page)

		if (signal.aborted) throw aborted()

		const scale = widthPx / Math.max(1, size.width)
		const queued = engine.queued("render", {
			page,
			scale,
			rotation: 0,
			tile: [0, 0, Math.max(1, Math.round(size.width * scale)), Math.max(1, Math.round(size.height * scale))],
			priority: "thumbnail"
		})
		const cancel = (): void => {
			queued.cancel()
		}

		signal.addEventListener("abort", cancel, { once: true })

		try {
			const drawn = await queued.promise

			return drawn.bitmap
		} finally {
			signal.removeEventListener("abort", cancel)
		}
	}
}

// pdf.js draws the thumbnails: the editor does not have the document (yet).
export function pdfjsDrawsThumbnails(document: PdfDomDocument, engine: PdfEditEngine | null): boolean {
	return engine === null || !isMupdfDocument(document)
}

// The renderer for the document shown: the engine's when the editor has it.
export function thumbnailRenderer(document: PdfDomDocument, engine: PdfEditEngine | null): RenderThumbnail {
	return engine !== null && isMupdfDocument(document) ? engineThumbnail(document, engine) : pdfjsThumbnail(document)
}
