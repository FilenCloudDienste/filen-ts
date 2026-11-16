import type * as Mupdf from "mupdf"
import { PdfEngineRefusal, type PdfEngineContext } from "./context"
import type { PdfPageInfo, PdfRenderArgs, PdfRenderValue } from "./protocol"
import type { TileRenderer } from "./render"

// The page requests a PDF and a read document answer alike.

export function pageInfos(document: Mupdf.Document, from: number, count: number): PdfPageInfo[] {
	const total = document.countPages()
	const pages: PdfPageInfo[] = []

	for (let index = Math.max(0, from); index < Math.min(total, from + count); index++) {
		const page = document.loadPage(index)
		const bounds = page.getBounds()

		pages.push({ width: bounds[2] - bounds[0], height: bounds[3] - bounds[1], label: page.getLabel() })
		page.destroy()
	}

	return pages
}

export async function drawTile(
	context: PdfEngineContext,
	document: Mupdf.Document,
	renderer: TileRenderer,
	{ page, scale, rotation, tile, print, priority }: PdfRenderArgs
): Promise<{ readonly value: PdfRenderValue; readonly transfer: readonly unknown[] }> {
	if (!Number.isInteger(page) || page < 0 || page >= document.countPages() || !(scale > 0)) throw new PdfEngineRefusal("badRequest")

	const drawn = renderer.render(
		page,
		scale,
		rotation,
		tile,
		print === undefined ? undefined : { annotations: print.annotations === true },
		priority === "thumbnail"
	)
	const bitmap = await context.host.toBitmap(drawn.rgba, drawn.width, drawn.height)

	return { value: { bitmap, tile: drawn.tile }, transfer: [bitmap] }
}
