import type { GeoBounds } from "@/features/preview/lib/geo/stats.logic"
import { IMAGE_WHEEL_SENSITIVITY } from "@/features/preview/components/imageViewer.logic"

// The plot's projection and view: equirectangular in metres around the bounds' centre, scaled by cos(φ₀) so distances
// read true near it; a view is a centre and a scale (canvas pixels per metre) that pans and zooms toward the pointer.

const METRES_PER_DEGREE = 111_320
// The fitted track leaves this much of the canvas as margin on each side.
const FIT_MARGIN = 0.08
// How far a view zooms out and in from the fitted one.
const MIN_ZOOM = 0.25
const MAX_ZOOM = 4096

export interface Projection {
	readonly lon0: number
	readonly lat0: number
	readonly cosLat0: number
}

export function projection(bounds: GeoBounds): Projection {
	const lat0 = (bounds.minLat + bounds.maxLat) / 2

	return { lon0: (bounds.minLon + bounds.maxLon) / 2, lat0, cosLat0: Math.cos((lat0 * Math.PI) / 180) }
}

// Metres east of the centre.
export function projectX(p: Projection, lon: number): number {
	return (lon - p.lon0) * p.cosLat0 * METRES_PER_DEGREE
}

// Metres south of the centre (canvas y grows down).
export function projectY(p: Projection, lat: number): number {
	return (p.lat0 - lat) * METRES_PER_DEGREE
}

export interface GeoView {
	// The canvas centre, in projected metres.
	readonly x: number
	readonly y: number
	// Canvas pixels per metre.
	readonly scale: number
}

// The view that fits the bounds into a canvas of `width` × `height` pixels.
export function fitView(p: Projection, bounds: GeoBounds, width: number, height: number): GeoView {
	const spanX = Math.max(1, projectX(p, bounds.maxLon) - projectX(p, bounds.minLon))
	const spanY = Math.max(1, projectY(p, bounds.minLat) - projectY(p, bounds.maxLat))
	const usable = 1 - 2 * FIT_MARGIN

	return { x: 0, y: 0, scale: Math.min((width * usable) / spanX, (height * usable) / spanY) }
}

// A canvas point's projected position.
export function toWorld(view: GeoView, width: number, height: number, px: number, py: number): { x: number; y: number } {
	return { x: view.x + (px - width / 2) / view.scale, y: view.y + (py - height / 2) / view.scale }
}

export function toCanvas(view: GeoView, width: number, height: number, x: number, y: number): { x: number; y: number } {
	return { x: (x - view.x) * view.scale + width / 2, y: (y - view.y) * view.scale + height / 2 }
}

// The image viewer's pan and zoom (imageViewer.logic.ts) do not fit a plot: they clamp the scale to 0.25–8× of an image
// contained in its box and its pan to the image's edges, in CSS pixels; a plot zooms 0.25–4096× of the fitted track
// and pans freely over world metres. Only the wheel's sensitivity is shared.

// Panned by a drag of (dx, dy) canvas pixels.
export function panView(view: GeoView, dx: number, dy: number): GeoView {
	return { ...view, x: view.x - dx / view.scale, y: view.y - dy / view.scale }
}

// Zoomed by `factor` keeping the world point under (px, py) fixed, within MIN_ZOOM..MAX_ZOOM of `fitted`.
export function zoomView(view: GeoView, fitted: GeoView, factor: number, width: number, height: number, px: number, py: number): GeoView {
	const scale = Math.min(fitted.scale * MAX_ZOOM, Math.max(fitted.scale * MIN_ZOOM, view.scale * factor))
	const anchor = toWorld(view, width, height, px, py)

	return { scale, x: anchor.x - (px - width / 2) / scale, y: anchor.y - (py - height / 2) / scale }
}

// A wheel turn's zoom factor, at the image viewer's sensitivity: about 15 % a notch.
export function wheelFactor(deltaY: number): number {
	return Math.exp(-deltaY * IMAGE_WHEEL_SENSITIVITY)
}

const NICE = [1, 2, 5] as const

// The scale bar: a round length (1, 2 or 5 × 10ⁿ metres) about `target` pixels long at `scale`.
export function scaleBar(scale: number, target: number): { metres: number; pixels: number } {
	const raw = target / scale
	const power = 10 ** Math.floor(Math.log10(raw))
	let metres = power

	for (const step of NICE) {
		if (step * power <= raw) metres = step * power
	}

	return { metres, pixels: metres * scale }
}
