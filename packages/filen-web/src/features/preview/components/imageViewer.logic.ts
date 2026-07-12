// Pure zoom/pan math for imageViewer.tsx's ZoomableImage — framework-free (no DOM) so it is testable
// in node, mirroring every other viewer's own *.logic.ts sibling (e.g. pdfViewer.logic.ts).

export const IMAGE_MIN_SCALE = 0.25
export const IMAGE_MAX_SCALE = 8
export const IMAGE_DOUBLE_CLICK_SCALE = 2.5
// Wheel delta -> scale factor; a typical mouse-wheel notch (~100 deltaY) nudges zoom by ~15%.
export const IMAGE_WHEEL_SENSITIVITY = 0.0015

export interface ZoomTransform {
	scale: number
	x: number
	y: number
}

export interface Size {
	width: number
	height: number
}

export function clampImageScale(scale: number): number {
	return Math.min(IMAGE_MAX_SCALE, Math.max(IMAGE_MIN_SCALE, scale))
}

// object-fit:contain's own sizing recipe — the rendered (unscaled, i.e. at ZoomTransform.scale === 1)
// box of `natural` fitted inside `container`, letterboxed on whichever axis has slack. Falls back to
// the container's own size when either input is degenerate (a pre-layout 0×0 rect, or an image whose
// naturalWidth/Height hasn't resolved yet) rather than dividing by zero.
export function containSize(container: Size, natural: Size): Size {
	if (container.width <= 0 || container.height <= 0 || natural.width <= 0 || natural.height <= 0) {
		return container
	}

	const fit = Math.min(container.width / natural.width, container.height / natural.height)

	return { width: natural.width * fit, height: natural.height * fit }
}

// Clamps a pan offset so the scaled content can never be dragged far enough to leave a gap between
// its own edge and the container's edge — i.e. the content can slide until ITS edge reaches the
// container's edge, never further. When the scaled content is smaller than the container on an axis
// there is nothing to pan on that axis at all (maxX/Y floors at 0), so the content stays centered.
export function clampPan(container: Size, content: Size, scale: number, offset: { x: number; y: number }): { x: number; y: number } {
	const maxX = Math.max(0, (content.width * scale - container.width) / 2)
	const maxY = Math.max(0, (content.height * scale - container.height) / 2)

	return {
		x: Math.min(maxX, Math.max(-maxX, offset.x)),
		y: Math.min(maxY, Math.max(-maxY, offset.y))
	}
}

// A pointer-drag step: adds `delta` (the drag distance since pointerdown, in unscaled screen pixels —
// CSS translate() composes AFTER scale() in `translate(x,y) scale(s)`, so a drag delta needs no
// division by scale) to `origin` (the transform's own x/y at pointerdown) and clamps the result.
// `natural` is null before the image's own dimensions are known (can't clamp yet — returns the
// unclamped sum, which the caller re-clamps once a real size resolves via the same helper).
export function dragPan(
	origin: { x: number; y: number },
	delta: { x: number; y: number },
	scale: number,
	container: Size,
	natural: Size | null
): { x: number; y: number } {
	const raw = { x: origin.x + delta.x, y: origin.y + delta.y }

	if (natural === null) {
		return raw
	}

	return clampPan(container, containSize(container, natural), scale, raw)
}

// Wheel-zoom step: rescales by `deltaY` (a native WheelEvent's own field — see imageViewer.tsx's
// comment on why the listener must be a real, non-passive one) and re-anchors the pan offset so the
// point under the cursor (`pointerOffset`, the cursor's own position relative to the CONTAINER's
// center) stays visually fixed — the standard "zoom toward point" formula: for a point p in
// (unscaled, origin-at-container-center) content space, translate + scale * p must equal the same
// on-screen offset before and after, which solves to translate' = pointerOffset + (translate -
// pointerOffset) * (nextScale / prevScale). Snaps pan back to (0, 0) once zoomed back out to 1x or
// below — mirrors doubleClickZoom's own reset, so a wheel-zoomed-out image never leaves a stray,
// now-invisible-at-1x pan offset for the NEXT zoom-in to inherit.
export function wheelZoom(
	current: ZoomTransform,
	deltaY: number,
	pointerOffset: { x: number; y: number },
	container: Size,
	natural: Size | null
): ZoomTransform {
	const nextScale = clampImageScale(current.scale - deltaY * IMAGE_WHEEL_SENSITIVITY)

	if (nextScale <= 1) {
		return { scale: nextScale, x: 0, y: 0 }
	}

	const ratio = nextScale / current.scale
	const raw = {
		x: pointerOffset.x + (current.x - pointerOffset.x) * ratio,
		y: pointerOffset.y + (current.y - pointerOffset.y) * ratio
	}

	if (natural === null) {
		return { scale: nextScale, ...raw }
	}

	return { scale: nextScale, ...clampPan(container, containSize(container, natural), nextScale, raw) }
}

// Double-click toggle: zoomed in (scale > 1) snaps back to 1x with pan reset (nothing left to clamp
// against at 1x — the whole content already fits); at rest, jumps to IMAGE_DOUBLE_CLICK_SCALE centered
// (no pan offset — a centered zoom-in is the sensible default the spec calls for, unlike wheel-zoom's
// toward-cursor behavior, which double-click doesn't attempt).
export function doubleClickZoom(current: ZoomTransform): ZoomTransform {
	return current.scale > 1 ? { scale: 1, x: 0, y: 0 } : { scale: IMAGE_DOUBLE_CLICK_SCALE, x: 0, y: 0 }
}
