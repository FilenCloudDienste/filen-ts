import { effectiveAdjustments } from "@/features/preview/imageEdit/lib/filters"
import { IDENTITY_ADJUSTMENTS, affineMatrix3, multiplyMatrix3, type Matrix3, type Size } from "@/features/preview/imageEdit/lib/recipe"
import type { GradeAdjustments } from "@/lib/gl/colorGrade"
import { hasColourWork } from "@/features/preview/videoEdit/lib/plan"
import type { HdrHandling, TextOverlay, VideoEditRecipe, VideoRotation } from "@/features/preview/videoEdit/types"

// The frame pass's geometry and decisions, DOM- and GL-free: which source texel each output pixel samples, which
// adjustments the grade applies, whether a recipe needs the pass at all, and where a text box lands. The output size,
// the timeline mapping and what counts as colour work are the export plan's (lib/plan.ts), so the preview and the
// export draw the same frame.

function quarterTurns(rotation: VideoRotation): number {
	return rotation / 90
}

// The crop, or the whole frame.
function cropRect(frame: Size, recipe: Pick<VideoEditRecipe, "crop">): { x: number; y: number; width: number; height: number } {
	return recipe.crop ?? { x: 0, y: 0, width: frame.width, height: frame.height }
}

// The output frame before any resize: the crop, turned by the recipe's rotation.
function turnedSize(frame: Size, recipe: Pick<VideoEditRecipe, "crop" | "rotate">): Size {
	const crop = cropRect(frame, recipe)

	return quarterTurns(recipe.rotate) % 2 === 1 ? { width: crop.height, height: crop.width } : { width: crop.width, height: crop.height }
}

// `size` fitted inside `maxWidth` (never enlarged), for a preview; at least 1×1.
export function fitWidth(size: Size, maxWidth: number): Size {
	const scale = Math.min(1, Math.max(1, Math.floor(maxWidth)) / size.width)

	return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
}

// Turns `unturn` back by `turns` clockwise quarter turns: maps a point of the turned frame (`turned`, its size) to the
// frame before the turns. One clockwise turn maps upright (x, y) in a frame H high to (H − y, x); its inverse maps
// turned (X, Y) to (Y, H − X).
function unturnMatrix(turns: number, turned: Size): Matrix3 {
	let matrix: Matrix3 = affineMatrix3(1, 0, 0, 1, 0, 0)
	let width = turned.width
	let height = turned.height

	for (let turn = 0; turn < turns; turn++) {
		// This step's frame is width×height; the one before it is height×width.
		matrix = multiplyMatrix3(affineMatrix3(0, -1, 1, 0, 0, width), matrix)

		const previousWidth = height

		height = width
		width = previousWidth
	}

	return matrix
}

// Output pixel (x right, y DOWN, pixel centres at +0.5) → texture coordinate of the decoded picture as uploaded (its
// natural frame, displayWidth × displayHeight, 0..1, top row first). `display` is that frame turned by
// `sourceRotation`, the space the crop is given in.
//
// Order: crop → rotate clockwise → flip in the turned frame → scale to `out`. Two ways in, the same picture out: the
// export hands the frame's own orientation (sourceRotation 0, the crop mapped into it and the source's rotation folded
// into `rotate`, exportApi.ts); the preview hands the recipe as the user sees it (display-space crop, the user's
// rotation) with the source's rotation as `sourceRotation`.
export function outputToTexture(
	display: Size,
	sourceRotation: VideoRotation,
	recipe: Pick<VideoEditRecipe, "crop" | "rotate" | "flipH" | "flipV">,
	out: Size
): Matrix3 {
	const crop = cropRect(display, recipe)
	const turned = turnedSize(display, recipe)
	// Output px → turned-and-flipped crop px.
	const toTurned = affineMatrix3(turned.width / out.width, 0, 0, turned.height / out.height, 0, 0)
	const unflip = affineMatrix3(
		recipe.flipH ? -1 : 1,
		0,
		0,
		recipe.flipV ? -1 : 1,
		recipe.flipH ? turned.width : 0,
		recipe.flipV ? turned.height : 0
	)
	// Turned crop → crop px → display px.
	const unrotate = unturnMatrix(quarterTurns(recipe.rotate), turned)
	const uncrop = affineMatrix3(1, 0, 0, 1, crop.x, crop.y)
	// Display px → natural (decoded) px.
	const sourceTurns = quarterTurns(sourceRotation)
	const unsource = unturnMatrix(sourceTurns, display)
	const natural = sourceTurns % 2 === 1 ? { width: display.height, height: display.width } : display
	const normalise = affineMatrix3(1 / natural.width, 0, 0, 1 / natural.height, 0, 0)

	return multiplyMatrix3(
		normalise,
		multiplyMatrix3(unsource, multiplyMatrix3(uncrop, multiplyMatrix3(unrotate, multiplyMatrix3(unflip, toTurned))))
	)
}

// The adjustments the grade applies: the recipe's plus its filter preset's (the image editor's math), with no
// sharpening (the video pass has none) and the vignette only a filter brings.
export function videoGrade(recipe: Pick<VideoEditRecipe, "adjust" | "filter">): GradeAdjustments {
	return effectiveAdjustments({ adjustments: { ...IDENTITY_ADJUSTMENTS, ...recipe.adjust }, filter: recipe.filter })
}

export interface PipelineNeedOptions {
	// The output is scaled from the source (plan.ts outputGeometry `scaled`).
	scaled?: boolean
	hdr?: HdrHandling | null
}

// Whether a recipe needs the GPU pass: colour work, text, a flip, a resize or a tone map. Neither a crop (a VideoFrame
// visibleRect view) nor a rotation (written as metadata) does on its own; when the pass runs for another reason, it
// applies them too.
export function needsGpuPass(recipe: VideoEditRecipe, options: PipelineNeedOptions = {}): boolean {
	return (
		hasColourWork(recipe) ||
		recipe.text.length > 0 ||
		recipe.flipH ||
		recipe.flipV ||
		options.hdr === "toSdr" ||
		options.scaled === true
	)
}

// Whether a text box shows at an output time: from its start, up to (not including) its end.
export function overlayVisible(overlay: Pick<TextOverlay, "startSec" | "endSec">, outputTimeSec: number): boolean {
	return outputTimeSec >= overlay.startSec && outputTimeSec < overlay.endSec
}

// Where a text raster of `size` output px lands: centred on the overlay's normalised point, in output px (top-down).
export function overlayBox(
	overlay: Pick<TextOverlay, "x" | "y">,
	size: Size,
	out: Size
): { left: number; top: number; right: number; bottom: number } {
	const left = Math.round(overlay.x * out.width - size.width / 2)
	const top = Math.round(overlay.y * out.height - size.height / 2)

	return { left, top, right: left + size.width, bottom: top + size.height }
}

// How much the pass shrinks the source along its larger reduction (texels per output pixel); past 2 a mipmapped
// sample keeps a strong downscale from aliasing.
// `m` maps output px to texture coordinates (outputToTexture).
export function minification(texture: Size, m: Matrix3): number {
	// Texture px per output px along each output axis.
	const alongX = Math.hypot(m[0] * texture.width, m[1] * texture.height)
	const alongY = Math.hypot(m[3] * texture.width, m[4] * texture.height)

	return Math.max(alongX, alongY)
}
