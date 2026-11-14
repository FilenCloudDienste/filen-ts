import type { CropRect } from "@filen/office/core/pdfedit/crop"
import type { PdfViewport } from "@filen/office/dom/pdf"
import { PdfCropBar } from "@/features/pdf/pages/cropBar"
import { PdfCropOverlay } from "@/features/pdf/pages/cropOverlay"
import type { PdfPagesController } from "@/features/pdf/pages/pagesController"
import { usePagesView, usePdfPagesSurface } from "@/features/pdf/pages/pagesSurfaceContext"
import { cropMargins, hasMargins, unrotateMargins } from "@/features/pdf/pages/pagesSurface.logic"
import type { PdfToolOverlayProps, PdfToolPanelProps } from "@/features/pdf/tools/registry"

// The crop tool's surfaces: handles on the current page (drag them, or Tab to them and use the arrows; Enter crops
// that page, Escape leaves) and the scope bar (this page, the selected pages, all, odd, even, a range; Remove white
// margins; delete what lies outside). The crop drawn on the page as the view shows it applies to each chosen page as
// margins off its box.

// The page's box as the view shows it (points, the view's turn applied) and CSS px per point.
function viewBounds(viewport: PdfViewport): { readonly bounds: CropRect; readonly scale: number } {
	const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = viewport.viewBox
	const quarter = Math.abs(viewport.rotation) % 180 === 90
	const width = Math.max(1, quarter ? y1 - y0 : x1 - x0)
	const height = Math.max(1, quarter ? x1 - x0 : y1 - y0)

	return { bounds: [0, 0, width, height], scale: viewport.width / width }
}

function apply(controller: PdfPagesController, pages: readonly number[], removeOutside: boolean, viewRotation: number): boolean {
	const crop = controller.getSnapshot().crop

	if (crop === null) return false

	const margins = unrotateMargins(cropMargins(crop.bounds, crop.rect), viewRotation)

	if (!hasMargins(margins)) return false

	controller.crop(pages, margins, removeOutside)

	return true
}

export function PdfCropToolOverlay({ context, page, viewport }: PdfToolOverlayProps) {
	const surface = usePdfPagesSurface()
	const view = usePagesView(surface.controller)
	const { bounds, scale } = viewBounds(viewport)

	if (page !== view.current) return null

	const rect = view.crop?.page === page ? view.crop.rect : bounds

	return (
		<PdfCropOverlay
			bounds={bounds}
			scale={scale}
			rect={rect}
			onChange={next => {
				surface.controller.setCrop({ page, bounds, rect: next })
			}}
			onCommit={() => {
				if (apply(surface.controller, [page], false, surface.viewRotation)) context.finish()
			}}
			onCancel={() => {
				surface.controller.setCrop(null)
				context.finish()
			}}
		/>
	)
}

export function PdfCropToolPanel({ context }: PdfToolPanelProps) {
	const surface = usePdfPagesSurface()
	const view = usePagesView(surface.controller)
	const crop = view.crop
	const drawn = crop !== null && crop.page === view.current && hasMargins(cropMargins(crop.bounds, crop.rect))

	return (
		<PdfCropBar
			pageCount={surface.document.numPages}
			current={view.current}
			selected={[...view.selected].sort((a, b) => a - b)}
			canApply={drawn}
			onRemoveMargins={pages => {
				surface.controller.cropToContent(pages)
				context.finish()
			}}
			onApply={request => {
				if (apply(surface.controller, request.pages, request.removeOutside, surface.viewRotation)) context.finish()
			}}
			onCancel={() => {
				surface.controller.setCrop(null)
				context.finish()
			}}
		/>
	)
}
