import type { Window } from "@/features/preview/lib/dicom/pixels.logic"

// The DICOM canvas's view: the frame fitted to the canvas, zoomed about a point and panned (backing pixels), and the
// window a drag sets. Pure: the worker holds the state.

export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 32

export interface View {
	// Times the fitted size.
	readonly zoom: number
	// The frame's centre from the canvas's, in backing pixels.
	readonly x: number
	readonly y: number
}

export const FITTED: View = { zoom: 1, x: 0, y: 0 }

export interface Box {
	readonly width: number
	readonly height: number
}

// Backing pixels per frame column at zoom 1: the frame (its rows stretched by the pixel aspect) fitted into the canvas.
export function fitScale(canvas: Box, frame: Box, aspect: number): number {
	return Math.min(canvas.width / Math.max(1, frame.width), canvas.height / Math.max(1, frame.height * aspect))
}

// The frame's rectangle on the canvas.
export function placement(canvas: Box, frame: Box, aspect: number, view: View): { x: number; y: number; width: number; height: number } {
	const scale = fitScale(canvas, frame, aspect) * view.zoom
	const width = frame.width * scale
	const height = frame.height * aspect * scale

	return { x: canvas.width / 2 + view.x - width / 2, y: canvas.height / 2 + view.y - height / 2, width, height }
}

// Zooms by `factor` keeping the frame point under (px, py) where it is.
export function zoomAt(view: View, factor: number, canvas: Box, px: number, py: number): View {
	const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor))
	const applied = zoom / view.zoom
	const cx = canvas.width / 2 + view.x
	const cy = canvas.height / 2 + view.y

	return { zoom, x: px - (px - cx) * applied - canvas.width / 2, y: py - (py - cy) * applied - canvas.height / 2 }
}

export function panBy(view: View, dx: number, dy: number): View {
	return { ...view, x: view.x + dx, y: view.y + dy }
}

// The zoom a wheel turn of `deltaY` pixels applies.
export function wheelFactor(deltaY: number): number {
	return Math.exp(-deltaY * 0.002)
}

// A drag of (dx, dy) backing pixels on the window: right widens, down raises the level, at `perPixel` modality units a
// pixel.
export function dragWindow(window: Window, dx: number, dy: number, perPixel: number): Window {
	return { center: window.center + dy * perPixel, width: Math.max(1, window.width + dx * perPixel) }
}

// Modality units a pixel of drag moves the window: the default window's width over 256 pixels.
export function windowStep(base: Window): number {
	return Math.max(1, base.width) / 256
}
