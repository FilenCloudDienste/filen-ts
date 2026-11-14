import type * as Mupdf from "mupdf"
import type { MupdfModule } from "../protocol"
import { isRedaction } from "./marks"

// Pending (not yet applied) redaction marks print filled: the printed raster must not show what they cover. The
// document is not changed: the boxes are drawn on the print device after the page, through the same matrix.
//
// Print path: render the page as usual (display list or page.run onto a DrawDevice with `ctm`), then call
// drawPendingRedactions(mupdf, page, device, ctm) on that device before closing it.

export function drawPendingRedactions(mupdf: MupdfModule, page: Mupdf.PDFPage, device: Mupdf.Device, ctm: Mupdf.Matrix): number {
	let drawn = 0

	for (const annotation of page.getAnnotations()) {
		if (!isRedaction(annotation)) continue

		const path = new mupdf.Path()
		const quads = annotation.hasQuadPoints() ? annotation.getQuadPoints() : []

		if (quads.length > 0) {
			for (const quad of quads) {
				path.moveTo(quad[0], quad[1])
				path.lineTo(quad[2], quad[3])
				path.lineTo(quad[6], quad[7])
				path.lineTo(quad[4], quad[5])
				path.closePath()
			}
		} else {
			const [x0, y0, x1, y1] = annotation.getRect()

			path.rect(x0, y0, x1, y1)
		}

		device.fillPath(path, false, ctm, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1)
		path.destroy()
		drawn++
	}

	return drawn
}

// Whether a page has pending marks (the print path can skip the extra pass otherwise).
export function hasPendingRedactions(page: Mupdf.PDFPage): boolean {
	return page.getAnnotations().some(isRedaction)
}
