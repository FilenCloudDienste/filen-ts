// The CAD viewer's 2D view: the scene point at the canvas's centre and the scene width the canvas shows, its height
// following from the canvas's aspect (dxf-viewer's SetView). Positions and deltas are in backing pixels, y down.

export interface DxfView {
	readonly x: number
	readonly y: number
	readonly width: number
}

export interface CanvasSize {
	readonly width: number
	readonly height: number
}

// Zoom stays within these factors of the fitted width, in and out.
export const DXF_MAX_ZOOM_IN = 100_000
export const DXF_MAX_ZOOM_OUT = 10

function scenePerPixel(view: DxfView, canvas: CanvasSize): number {
	return view.width / Math.max(canvas.width, 1)
}

// The drawing follows the pointer: a drag right moves the view's centre left.
export function panDxfView(view: DxfView, dx: number, dy: number, canvas: CanvasSize): DxfView {
	const step = scenePerPixel(view, canvas)

	return { x: view.x - dx * step, y: view.y + dy * step, width: view.width }
}

// Zoomed by `factor` (above 1 is in) about the canvas point `at`, which keeps the scene point under it.
export function zoomDxfView(view: DxfView, factor: number, at: { x: number; y: number }, canvas: CanvasSize, fitted: number): DxfView {
	if (!(factor > 0) || !Number.isFinite(factor)) return view

	const width = Math.min(fitted * DXF_MAX_ZOOM_OUT, Math.max(fitted / DXF_MAX_ZOOM_IN, view.width / factor))
	const before = scenePerPixel(view, canvas)
	const after = width / Math.max(canvas.width, 1)
	const offsetX = at.x - canvas.width / 2
	const offsetY = at.y - canvas.height / 2

	return {
		x: view.x + offsetX * (before - after),
		y: view.y - offsetY * (before - after),
		width
	}
}
