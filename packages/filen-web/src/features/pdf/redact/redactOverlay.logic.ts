import { pdfBox, type PdfViewport } from "@filen/office/dom/pdf"

// Between a page's box on screen and the editor's page space (MuPDF's: points, origin at the page's top left, y down,
// after the page's own rotation and crop). The viewport maps the page's bottom-left user space to its box, whatever
// the view's zoom and rotation; page space is that user space flipped about the box's top.

export type PagePoint = readonly [number, number]
export type PageRect = readonly [number, number, number, number]

// The page's box in page space: [0, 0, width, height].
export function pageSpaceBox(viewport: PdfViewport): PageRect {
	const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = viewport.viewBox

	return [0, 0, x1 - x0, y1 - y0]
}

// A point of the page's box (CSS pixels from its top left) in page space.
export function toPageSpace(viewport: PdfViewport, x: number, y: number): PagePoint {
	const [ux, uy] = viewport.convertToPdfPoint(x, y)
	const [x0 = 0, , , y1 = 0] = viewport.viewBox

	return [Number(ux) - x0, y1 - Number(uy)]
}

// A page-space rectangle as the CSS box it covers on the page.
export function toBoxStyle(
	viewport: PdfViewport,
	rect: PageRect
): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } {
	const [x0 = 0, , , y1 = 0] = viewport.viewBox
	const [ax, ay] = viewport.convertToViewportPoint(rect[0] + x0, y1 - rect[1])
	const [bx, by] = viewport.convertToViewportPoint(rect[2] + x0, y1 - rect[3])

	return pdfBox(Number(ax), Number(ay), Number(bx), Number(by))
}
