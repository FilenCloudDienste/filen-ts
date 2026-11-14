import type * as Mupdf from "mupdf"
import {
	fitOcrWords,
	imageUprightTurns,
	ocrRenderDpi,
	ocrRenderMatrix,
	ocrUprightTurns,
	pixelToPageMatrix,
	type OcrImageUse,
	type OcrMatrix,
	type OcrPageSummary,
	type QuarterTurns
} from "../../../core/pdfedit/ocrGeometry"
import type { MupdfModule } from "../protocol"

// The engine's side of text recognition: what a page draws (to pick scanned pages), its render for the recogniser,
// and the command that lays the recognised text over it.

function clippedArea(ctm: OcrMatrix, width: number, height: number): number {
	const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]]
	const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]]
	const x0 = Math.max(0, Math.min(...xs))
	const x1 = Math.min(width, Math.max(...xs))
	const y0 = Math.max(0, Math.min(...ys))
	const y1 = Math.min(height, Math.max(...ys))

	return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0
}

// The page's characters (visible or not) and images, from one pass over its content in view space (annotations
// left out). Nothing is decoded or rendered.
export function ocrPageSummary(mupdf: MupdfModule, page: Mupdf.PDFPage): OcrPageSummary {
	const bounds = page.getBounds("CropBox")
	const width = bounds[2] - bounds[0]
	const height = bounds[3] - bounds[1]
	const images: OcrImageUse[] = []
	let chars = 0

	const count = (text: Mupdf.Text): void => {
		text.walk({
			showGlyph: () => {
				chars++
			}
		})
	}
	const image = (picture: Mupdf.Image, ctm: Mupdf.Matrix): void => {
		const drawnWidth = Math.hypot(ctm[0], ctm[1])

		images.push({
			area: clippedArea([ctm[0], ctm[1], ctm[2], ctm[3], ctm[4] - bounds[0], ctm[5] - bounds[1]], width, height),
			dpi: drawnWidth > 0 ? (picture.getWidth() * 72) / drawnWidth : 0,
			upright: imageUprightTurns(ctm)
		})
	}
	const device = new mupdf.Device({
		fillText: count,
		strokeText: count,
		clipText: count,
		clipStrokeText: count,
		ignoreText: count,
		fillImage: image,
		fillImageMask: image
	})

	try {
		page.runPageContents(device, mupdf.Matrix.identity)
		device.close()
	} finally {
		device.destroy()
	}

	return { width, height, chars, images }
}

export interface OcrRender {
	// DeviceGray, 8 bits, no alpha, `stride` bytes per row; a fresh buffer (transferable).
	readonly pixels: Uint8Array<ArrayBuffer>
	readonly width: number
	readonly height: number
	readonly stride: number
	readonly dpi: number
	// Pixel space → page space (core/pdfedit/ocrGeometry.ts).
	readonly pixelToPage: OcrMatrix
	readonly summary: OcrPageSummary
}

// Renders a page for the recogniser: its CropBox, in DeviceGray without alpha, at `dpi` (by default the page's own
// resolution rule, ocrRenderDpi), upright (the page's /Rotate and /UserUnit applied, then turned so its largest
// image stands up). The pixels are copied out of MuPDF's heap once and the pixmap freed; the caller empties MuPDF's
// store after a batch (emptyStore).
export function renderPageForOcr(mupdf: MupdfModule, document: Mupdf.PDFDocument, pageIndex: number, dpi?: number): OcrRender {
	const page = document.loadPage(pageIndex)

	try {
		const summary = ocrPageSummary(mupdf, page)
		const resolution = dpi ?? ocrRenderDpi(summary)
		const turns: QuarterTurns = ocrUprightTurns(summary)
		const matrix = ocrRenderMatrix(resolution, turns)
		const pixmap = page.toPixmap([...matrix], mupdf.ColorSpace.DeviceGray, false, false, "View", "CropBox")

		try {
			const pixels = new Uint8Array(pixmap.getPixels())

			return {
				pixels,
				width: pixmap.getWidth(),
				height: pixmap.getHeight(),
				stride: pixmap.getStride(),
				dpi: resolution,
				pixelToPage: pixelToPageMatrix(page.getTransform(), matrix, [pixmap.getX(), pixmap.getY()]),
				summary
			}
		} finally {
			pixmap.destroy()
		}
	} finally {
		page.destroy()
	}
}

// Grafts a one-page overlay PDF onto a page as a Form XObject drawn with `matrix` (overlay space → page space).
export type OcrGraft = (
	target: Mupdf.PDFDocument,
	pageIndex: number,
	overlayPdf: Uint8Array,
	matrix: [number, number, number, number, number, number]
) => void

export interface OcrPageEdit {
	readonly page: number
	// The recogniser's text-only page.
	readonly pdf: Uint8Array
	// Overlay → page (ocrOverlayMatrix).
	readonly matrix: OcrMatrix
}

// The recogniser's page with its words' glyphs stretched to their boxes (fitOcrWords); a new PDF.
export function fitOcrOverlay(mupdf: MupdfModule, overlayPdf: Uint8Array): Uint8Array {
	const overlay = new mupdf.PDFDocument(overlayPdf)

	try {
		const page = overlay.findPage(0)
		const contents = page.get("Contents")
		const streams = contents.isArray() ? Array.from({ length: contents.length }, (_, index) => contents.get(index)) : [contents]

		for (const stream of streams) if (stream.isStream()) stream.writeStream(fitOcrWords(stream.readStream().asString()))

		return overlay.saveToBuffer("compress").asUint8Array().slice()
	} finally {
		overlay.destroy()
	}
}

// The "recognise text" command for one page (one journal operation): lays the invisible recognised text over the
// page, its words fitted to the scanned words (fitOcrOverlay). Returns the pages it touched.
export function applyOcrPage(mupdf: MupdfModule, graft: OcrGraft, document: Mupdf.PDFDocument, edit: OcrPageEdit): readonly number[] {
	graft(document, edit.page, fitOcrOverlay(mupdf, edit.pdf), [...edit.matrix])

	return [edit.page]
}
