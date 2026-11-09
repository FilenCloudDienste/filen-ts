import type { Matrix3, Rect } from "@/features/preview/imageEdit/lib/recipe"

// The render worker's plane math: affine helpers over recipe.ts's Matrix3, tile plans for the full-resolution
// export and the preview texture build, and the fit of the output into a viewport. Pure, so node tests cover it.

export type { Rect }

// A column-major affine Matrix3 (recipe.ts's layout) from canvas-order coefficients: x' = a·x + c·y + e,
// y' = b·x + d·y + f.
export function affine(a: number, b: number, c: number, d: number, e: number, f: number): Matrix3 {
	return [a, b, 0, c, d, 0, e, f, 1]
}

// `outer` after `inner`: transformPoint(composeMatrix3(outer, inner), p) === transformPoint(outer, transformPoint(inner, p)).
export function composeMatrix3(outer: Matrix3, inner: Matrix3): Matrix3 {
	return affine(
		outer[0] * inner[0] + outer[3] * inner[1],
		outer[1] * inner[0] + outer[4] * inner[1],
		outer[0] * inner[3] + outer[3] * inner[4],
		outer[1] * inner[3] + outer[4] * inner[4],
		outer[0] * inner[6] + outer[3] * inner[7] + outer[6],
		outer[1] * inner[6] + outer[4] * inner[7] + outer[7]
	)
}

// Scale then translate: (x, y) → (x·sx + tx, y·sy + ty).
export function scaleTranslate(sx: number, sy: number, tx: number, ty: number): Matrix3 {
	return affine(sx, 0, 0, sy, tx, ty)
}

// The uniform scale of a similarity map (rotation, flips and one zoom): lengths grow by this factor.
export function matrixScale(m: Matrix3): number {
	return Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3]))
}

// The two rows as GLSL vec3s: x' = dot(rowX, vec3(x, y, 1)).
export function matrixRows(m: Matrix3): { x: [number, number, number]; y: [number, number, number] } {
	return { x: [m[0], m[3], m[6]], y: [m[1], m[4], m[7]] }
}

// Integer tiles of at most `edge` covering width × height, row-major from the top left.
export function planTiles(width: number, height: number, edge: number): Rect[] {
	const tiles: Rect[] = []
	const step = Math.max(1, Math.floor(edge))

	for (let y = 0; y < height; y += step) {
		for (let x = 0; x < width; x += step) {
			tiles.push({ x, y, width: Math.min(step, width - x), height: Math.min(step, height - y) })
		}
	}

	return tiles
}

export function expandRect(rect: Rect, pad: number): Rect {
	return { x: rect.x - pad, y: rect.y - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad }
}

// The export's output tile edge. A tile is rendered `pad` wider on every side for the sharpen pass, and the
// source rectangle its inverse map covers (a straightened tile's bounding box is up to √2 wider, scaled by the
// output→source zoom) plus `sourcePad` and a pixel of rounding each side must also fit one texture.
export function exportTileEdge(limit: number, pad: number, sourcePad: number, outputToSource: Matrix3): number {
	const spread = Math.max(
		Math.abs(outputToSource[0]) + Math.abs(outputToSource[3]),
		Math.abs(outputToSource[1]) + Math.abs(outputToSource[4]),
		1e-6
	)
	const bySource = Math.floor((limit - 2 * sourcePad - 2) / spread) - 2 * pad
	const byTarget = limit - 2 * pad

	return Math.max(1, Math.min(bySource, byTarget))
}

// The preview texture's size: the source scaled to at most `maxEdge` on its long side, never up.
export function previewSize(width: number, height: number, maxEdge: number): { width: number; height: number; scale: number } {
	const scale = Math.min(1, maxEdge / Math.max(width, height))

	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale }
}

// The source split for the preview build: each `upload` (within one texture of `edge`) carries `margin` extra
// source pixels around the `inner` part it contributes, so a mip level's filter footprint never reaches a tile's
// clamped edge and no seam shows between neighbours.
export function previewUploadTiles(width: number, height: number, edge: number, margin: number): { upload: Rect; inner: Rect }[] {
	const innerEdge = Math.max(1, edge - 2 * margin)

	return planTiles(width, height, innerEdge).map(inner => {
		const x0 = Math.max(0, inner.x - margin)
		const y0 = Math.max(0, inner.y - margin)
		const x1 = Math.min(width, inner.x + inner.width + margin)
		const y1 = Math.min(height, inner.y + inner.height + margin)

		return { upload: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, inner }
	})
}

// Source pixels a mip level's footprint can reach beyond a texel when shrinking by `scale` (≤ 1): one texel of
// the level trilinear filtering blends up to, plus one for its bilinear neighbour.
export function previewMargin(scale: number): number {
	return 2 * Math.ceil(1 / Math.max(scale, 1e-6)) + 2
}

// Output pixels → viewport pixels for the output drawn whole and centred in the viewport (top-down y).
export function containTransform(output: { width: number; height: number }, viewport: { width: number; height: number }): Matrix3 {
	const scale = Math.min(viewport.width / output.width, viewport.height / output.height)

	return scaleTranslate(scale, scale, (viewport.width - output.width * scale) / 2, (viewport.height - output.height * scale) / 2)
}

// Output pixels → square-thumbnail pixels for the output filling the square, centred (top-down y).
export function coverTransform(output: { width: number; height: number }, size: number): Matrix3 {
	const scale = Math.max(size / output.width, size / output.height)

	return scaleTranslate(scale, scale, (size - output.width * scale) / 2, (size - output.height * scale) / 2)
}

// The unsharp mask's radius in output pixels: a fixed share of the output's long side, so the preview (drawn
// smaller) and the export sharpen the same detail. Never under one output pixel.
export function sharpenRadius(outputWidth: number, outputHeight: number): number {
	return Math.max(1, Math.max(outputWidth, outputHeight) / 2000)
}

// The rows of output each tile adds around itself for the sharpen pass's neighbours.
export function sharpenPad(radius: number): number {
	return Math.ceil(radius) + 1
}
