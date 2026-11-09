import type { Adjustments, AspectPreset, Geometry, ImageEditRecipe, Orientation, QuarterTurns } from "@/features/preview/imageEdit/types"

// Recipe math. Pixel spaces: "source" is the upright decoded original (W×H), "turned" is it after the quarter
// turns (W'×H', swapped on odd turns), "output" is the exported image (outputSize). Positive `angle` turns the
// picture clockwise on screen (y down).

export interface Size {
	width: number
	height: number
}

export interface Rect {
	x: number
	y: number
	width: number
	height: number
}

export type Crop = Geometry["crop"]

// A 2D affine transform as a column-major 3×3 matrix (the layout uniformMatrix3fv takes): x' = m[0]x + m[3]y + m[6],
// y' = m[1]x + m[4]y + m[7]. A canvas takes it as setTransform(m[0], m[1], m[3], m[4], m[6], m[7]).
export type Matrix3 = readonly [number, number, number, number, number, number, number, number, number]

export const IDENTITY_ADJUSTMENTS: Readonly<Adjustments> = Object.freeze({
	exposure: 0,
	brightness: 0,
	contrast: 0,
	highlights: 0,
	shadows: 0,
	warmth: 0,
	tint: 0,
	saturation: 0,
	vibrance: 0,
	sharpness: 0,
	vignette: 0
})

const FULL_CROP: Readonly<Crop> = Object.freeze({ x: 0, y: 0, width: 1, height: 1 })

// Below a millionth of the frame a crop edge is on the frame edge: a handle dragged back lands within float noise.
const EPSILON = 1e-6

// The smallest crop side, as a fraction of the frame.
export const MIN_CROP = 0.02

export function identityRecipe(): ImageEditRecipe {
	return {
		geometry: { quarterTurns: 0, flipH: false, flipV: false, angle: 0, crop: { ...FULL_CROP }, aspect: "free" },
		adjustments: { ...IDENTITY_ADJUSTMENTS },
		filter: null,
		markup: []
	}
}

function isFullCrop(crop: Crop): boolean {
	return (
		Math.abs(crop.x) < EPSILON &&
		Math.abs(crop.y) < EPSILON &&
		Math.abs(crop.width - 1) < EPSILON &&
		Math.abs(crop.height - 1) < EPSILON
	)
}

function hasNoAdjustments(adjustments: Adjustments): boolean {
	for (const key in IDENTITY_ADJUSTMENTS) {
		if (adjustments[key as keyof Adjustments] !== 0) {
			return false
		}
	}

	return true
}

// Turns, flips and the aspect preset aside, nothing changes the pixels.
function isPixelIdentity(recipe: ImageEditRecipe): boolean {
	return (
		recipe.geometry.angle === 0 &&
		isFullCrop(recipe.geometry.crop) &&
		recipe.filter === null &&
		recipe.markup.length === 0 &&
		hasNoAdjustments(recipe.adjustments)
	)
}

// The aspect preset alone is a crop-tool setting, not an edit.
export function isIdentity(recipe: ImageEditRecipe): boolean {
	const g = recipe.geometry

	return g.quarterTurns === 0 && !g.flipH && !g.flipV && isPixelIdentity(recipe)
}

// Only quarter turns and flips: a JPEG can then be saved by rewriting its Orientation tag, losslessly. Also true
// for the identity recipe (the rewrite is then a no-op).
export function isGeometryOnly(recipe: ImageEditRecipe): boolean {
	return isPixelIdentity(recipe)
}

export function turnedSize(turns: QuarterTurns, source: Size): Size {
	return turns % 2 === 1 ? { width: source.height, height: source.width } : { width: source.width, height: source.height }
}

export function outputSize(recipe: ImageEditRecipe, source: Size): Size {
	const frame = turnedSize(recipe.geometry.quarterTurns, source)
	const crop = recipe.geometry.crop

	return { width: Math.max(1, Math.round(crop.width * frame.width)), height: Math.max(1, Math.round(crop.height * frame.height)) }
}

// How much a w×h picture turned by `angle` degrees must grow to still cover a w×h rectangle on the same centre:
// the turned rectangle's bounding box over the rectangle, on the tighter axis.
export function straightenScale(angle: number, width: number, height: number): number {
	const radians = (angle * Math.PI) / 180
	const c = Math.abs(Math.cos(radians))
	const s = Math.abs(Math.sin(radians))

	return Math.max((width * c + height * s) / width, (width * s + height * c) / height)
}

// Keeps a crop (normalised to the turned frame `frame`) inside the frame, at least MIN_CROP a side, and, when
// straightened, inside the turned picture: its corners turned back by `angle` about its own centre must land in
// the frame. Too large a crop shrinks about its centre, which keeps its aspect ratio.
export function clampCrop(crop: Crop, angle: number, frame: Size): Crop {
	let width = Math.min(1, Math.max(MIN_CROP, crop.width))
	let height = Math.min(1, Math.max(MIN_CROP, crop.height))
	let x = Math.min(1 - width, Math.max(0, crop.x))
	let y = Math.min(1 - height, Math.max(0, crop.y))

	if (angle !== 0) {
		const radians = (angle * Math.PI) / 180
		const c = Math.abs(Math.cos(radians))
		const s = Math.abs(Math.sin(radians))
		const cx = (x + width / 2) * frame.width
		const cy = (y + height / 2) * frame.height
		const halfW = (width * frame.width) / 2
		const halfH = (height * frame.height) / 2
		// The crop's corners turned back by the angle: their bounding box's half extents.
		const reachX = halfW * c + halfH * s
		const reachY = halfW * s + halfH * c
		const roomX = Math.min(cx, frame.width - cx)
		const roomY = Math.min(cy, frame.height - cy)
		const scale = Math.min(1, roomX / reachX, roomY / reachY)

		if (scale < 1) {
			const cxN = x + width / 2
			const cyN = y + height / 2

			width *= scale
			height *= scale
			x = cxN - width / 2
			y = cyN - height / 2
		}
	}

	return { x, y, width, height }
}

// Width over height of a preset in pixels; "original" is the turned frame's own; "free" has none.
export function aspectRatio(aspect: AspectPreset, frame: Size): number | null {
	switch (aspect) {
		case "free": {
			return null
		}

		case "original": {
			return frame.width / frame.height
		}

		case "square": {
			return 1
		}

		default: {
			const [w, h] = aspect.split(":").map(Number)

			return w !== undefined && h !== undefined && w > 0 && h > 0 ? w / h : null
		}
	}
}

// The largest crop of `aspect`'s ratio inside `within` (normalised to the turned frame `frame`), on its centre.
export function aspectRect(aspect: AspectPreset, frame: Size, within: Crop = FULL_CROP): Crop {
	const ratio = aspectRatio(aspect, frame)

	if (ratio === null) {
		return { ...within }
	}

	const availableW = within.width * frame.width
	const availableH = within.height * frame.height
	const widthPx = Math.min(availableW, availableH * ratio)
	const heightPx = widthPx / ratio
	const width = widthPx / frame.width
	const height = heightPx / frame.height

	return { x: within.x + (within.width - width) / 2, y: within.y + (within.height - height) / 2, width, height }
}

function multiply(a: Matrix3, b: Matrix3): Matrix3 {
	return [
		a[0] * b[0] + a[3] * b[1],
		a[1] * b[0] + a[4] * b[1],
		0,
		a[0] * b[3] + a[3] * b[4],
		a[1] * b[3] + a[4] * b[4],
		0,
		a[0] * b[6] + a[3] * b[7] + a[6],
		a[1] * b[6] + a[4] * b[7] + a[7],
		1
	]
}

function affine(a: number, b: number, c: number, d: number, e: number, f: number): Matrix3 {
	return [a, b, 0, c, d, 0, e, f, 1]
}

// Output px → upright source px. The shader samples the source through it; its inverse places markup.
export function geometryMatrix(recipe: ImageEditRecipe, source: Size): Matrix3 {
	const g = recipe.geometry
	const frame = turnedSize(g.quarterTurns, source)
	const out = outputSize(recipe, source)
	const cropX = g.crop.x * frame.width
	const cropY = g.crop.y * frame.height
	const cropW = g.crop.width * frame.width
	const cropH = g.crop.height * frame.height
	const cx = cropX + cropW / 2
	const cy = cropY + cropH / 2
	// Output px → straightened frame px (the crop is a whole number of output px, so scale by the exact ratio).
	const toStraightened = affine(cropW / out.width, 0, 0, cropH / out.height, cropX, cropY)
	// Straightened → turned-and-flipped frame: turn back by −angle about the crop centre.
	const radians = (-g.angle * Math.PI) / 180
	const c = Math.cos(radians)
	const s = Math.sin(radians)
	const unstraighten = affine(c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy)
	// Undo the flips (each its own inverse).
	const unflip = affine(g.flipH ? -1 : 1, 0, 0, g.flipV ? -1 : 1, g.flipH ? frame.width : 0, g.flipV ? frame.height : 0)
	// Undo the clockwise turns: one turn maps upright (x, y) to (H − y, x) in an H-wide frame, so its inverse maps
	// turned (X, Y) to (Y, H − X), H being the upright height.
	let unturn: Matrix3 = affine(1, 0, 0, 1, 0, 0)
	let width = frame.width
	let height = frame.height

	for (let turn = 0; turn < g.quarterTurns; turn++) {
		// This step's frame is width×height; the one before it is height×width.
		unturn = multiply(affine(0, -1, 1, 0, 0, width), unturn)

		const previousWidth = height

		height = width
		width = previousWidth
	}

	return multiply(unturn, multiply(unflip, multiply(unstraighten, toStraightened)))
}

export function invertMatrix3(m: Matrix3): Matrix3 {
	const det = m[0] * m[4] - m[1] * m[3]

	if (det === 0) {
		throw new Error("singular transform")
	}

	const a = m[4] / det
	const b = -m[1] / det
	const c = -m[3] / det
	const d = m[0] / det

	return affine(a, b, c, d, -(a * m[6] + c * m[7]), -(b * m[6] + d * m[7]))
}

export function transformPoint(m: Matrix3, x: number, y: number): [number, number] {
	return [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]]
}

// Upright source px → output px. For many points, invert geometryMatrix once and use transformPoint.
export function mapMarkupPoint(recipe: ImageEditRecipe, source: Size, x: number, y: number): [number, number] {
	return transformPoint(invertMatrix3(geometryMatrix(recipe, source)), x, y)
}

// The upright source px a tile of output px (x, y, width, height) samples from: the bounding box of its inverse
// mapped corners grown by `pad` (a filter's reach), in whole px and clamped to the source. Empty (0 wide or
// high) only when the tile lies wholly outside the source.
export function sourceRectForTile(recipe: ImageEditRecipe, source: Size, tile: Rect, pad: number): Rect {
	const m = geometryMatrix(recipe, source)
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity

	for (const [tx, ty] of [
		[tile.x, tile.y],
		[tile.x + tile.width, tile.y],
		[tile.x, tile.y + tile.height],
		[tile.x + tile.width, tile.y + tile.height]
	] as const) {
		const [sx, sy] = transformPoint(m, tx, ty)

		minX = Math.min(minX, sx)
		minY = Math.min(minY, sy)
		maxX = Math.max(maxX, sx)
		maxY = Math.max(maxY, sy)
	}

	const x0 = Math.max(0, Math.floor(minX - pad))
	const y0 = Math.max(0, Math.floor(minY - pad))
	const x1 = Math.min(source.width, Math.ceil(maxX + pad))
	const y1 = Math.min(source.height, Math.ceil(maxY + pad))

	return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) }
}

// Exif orientations as 2×2 matrices [a, b, c, d] (x' = ax + cy, y' = bx + dy) mapping centred stored px to
// displayed px, y down (CIPA DC-008 §4.6.4 Table 4: the 0th row/column's visual position). Index = value − 1.
const ORIENTATION_MATRICES: readonly (readonly [number, number, number, number])[] = [
	[1, 0, 0, 1], // 1: as stored
	[-1, 0, 0, 1], // 2: mirrored horizontally
	[-1, 0, 0, -1], // 3: turned 180°
	[1, 0, 0, -1], // 4: mirrored vertically
	[0, 1, 1, 0], // 5: transposed (0th row on the left, 0th column on top)
	[0, 1, -1, 0], // 6: turned 90° clockwise (0th row on the right, 0th column on top)
	[0, -1, -1, 0], // 7: transversed (0th row on the right, 0th column at the bottom)
	[0, -1, 1, 0] // 8: turned 90° anticlockwise (0th row on the left, 0th column at the bottom)
]

const TURN_CLOCKWISE = [0, 1, -1, 0] as const
const FLIP_H = [-1, 0, 0, 1] as const
const FLIP_V = [1, 0, 0, -1] as const

function multiply2(p: readonly number[], q: readonly number[]): [number, number, number, number] {
	const [pa = 0, pb = 0, pc = 0, pd = 0] = p
	const [qa = 0, qb = 0, qc = 0, qd = 0] = q

	return [pa * qa + pc * qb, pb * qa + pd * qb, pa * qc + pc * qd, pb * qc + pd * qd]
}

// The Orientation that shows the stored pixels as they look after the edit's turns then flips: new = U ∘ T_old.
export function composeOrientation(stored: Orientation, turns: QuarterTurns, flipH: boolean, flipV: boolean): Orientation {
	let m: readonly number[] = ORIENTATION_MATRICES[stored - 1] ?? [1, 0, 0, 1]

	for (let turn = 0; turn < turns; turn++) {
		m = multiply2(TURN_CLOCKWISE, m)
	}

	if (flipH) {
		m = multiply2(FLIP_H, m)
	}

	if (flipV) {
		m = multiply2(FLIP_V, m)
	}

	const index = ORIENTATION_MATRICES.findIndex(o => o[0] === m[0] && o[1] === m[1] && o[2] === m[2] && o[3] === m[3])

	return (index + 1) as Orientation
}
