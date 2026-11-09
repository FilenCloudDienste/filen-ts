import type { AspectPreset, Geometry, MarkupItem } from "@/features/preview/imageEdit/types"
import { aspectRatio, MIN_CROP, type Crop, type Size } from "@/features/preview/imageEdit/lib/recipe"

// The editor surface's own math: where the picture sits on screen, the crop tab's gestures, and which markup item a
// point hits. The recipe's geometry itself (orientation, straighten scale, output size, the output↔source mapping)
// lives in lib/recipe.ts.

export interface Box {
	left: number
	top: number
	width: number
	height: number
}

// `content` fitted whole and centred in `container`, as the render worker draws it.
export function fitBox(content: Size, container: Size): Box {
	if (content.width <= 0 || content.height <= 0 || container.width <= 0 || container.height <= 0) {
		return { left: 0, top: 0, width: 0, height: 0 }
	}

	const scale = Math.min(container.width / content.width, container.height / content.height)
	const width = content.width * scale
	const height = content.height * scale

	return { left: (container.width - width) / 2, top: (container.height - height) / 2, width, height }
}

const PORTRAIT_OF: Readonly<Partial<Record<AspectPreset, AspectPreset>>> = {
	"4:3": "3:4",
	"3:4": "4:3",
	"3:2": "2:3",
	"2:3": "3:2",
	"16:9": "9:16",
	"9:16": "16:9"
}

// A quarter turn counter-clockwise of what is shown: the turn joins the others, a flip already made swaps axis (turning
// then flipping one way is flipping the other way then turning), and the crop turns with the picture.
export function rotateLeft(geometry: Geometry): Geometry {
	const { x, y, width, height } = geometry.crop

	return {
		...geometry,
		quarterTurns: ((geometry.quarterTurns + 3) % 4) as Geometry["quarterTurns"],
		flipH: geometry.flipV,
		flipV: geometry.flipH,
		crop: { x: y, y: 1 - x - width, width: height, height: width },
		aspect: PORTRAIT_OF[geometry.aspect] ?? geometry.aspect
	}
}

// A mirror of what is shown: the straighten tilt mirrors with it and the crop keeps the same part of the picture.
export function flip(geometry: Geometry, axis: "horizontal" | "vertical"): Geometry {
	const { x, y, width, height } = geometry.crop

	return axis === "horizontal"
		? { ...geometry, flipH: !geometry.flipH, angle: -geometry.angle, crop: { x: 1 - x - width, y, width, height } }
		: { ...geometry, flipV: !geometry.flipV, angle: -geometry.angle, crop: { x, y: 1 - y - height, width, height } }
}

// Width over height of a preset in the frame's normalised units (null: free).
export function normalisedRatio(aspect: AspectPreset, frame: Size): number | null {
	const ratio = aspectRatio(aspect, frame)

	return ratio === null ? null : (ratio * frame.height) / frame.width
}

export type CropHandle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}

// `start` with `handle` dragged by (dx, dy) in the frame's normalised units, kept inside the frame, at least MIN_CROP
// a side, and at `ratio` (normalised width over height) when one is set: the side dragged leads, the other follows,
// anchored at the opposite edge or corner.
export function dragCrop(start: Crop, handle: CropHandle, dx: number, dy: number, ratio: number | null): Crop {
	if (handle === "move") {
		return {
			...start,
			x: clamp(start.x + dx, 0, 1 - start.width),
			y: clamp(start.y + dy, 0, 1 - start.height)
		}
	}

	const right = start.x + start.width
	const bottom = start.y + start.height
	const west = handle.includes("w")
	const east = handle.includes("e")
	const north = handle.includes("n")
	const south = handle.includes("s")

	let left = west ? clamp(start.x + dx, 0, right - MIN_CROP) : start.x
	let top = north ? clamp(start.y + dy, 0, bottom - MIN_CROP) : start.y
	let width = east ? clamp(start.width + dx, MIN_CROP, 1 - start.x) : right - left
	let height = south ? clamp(start.height + dy, MIN_CROP, 1 - start.y) : bottom - top

	if (ratio !== null) {
		const horizontal = west || east
		const vertical = north || south

		if (horizontal && (!vertical || Math.abs(dx) >= Math.abs(dy))) {
			height = width / ratio
		} else {
			width = height * ratio
		}

		// The room the anchor leaves, in each direction the crop may grow.
		const centreX = start.x + start.width / 2
		const centreY = start.y + start.height / 2
		const roomWidth = west ? right : east ? 1 - start.x : 2 * Math.min(centreX, 1 - centreX)
		const roomHeight = north ? bottom : south ? 1 - start.y : 2 * Math.min(centreY, 1 - centreY)
		const fit = Math.min(1, roomWidth / width, roomHeight / height)

		width *= fit
		height *= fit
		left = west ? right - width : east ? start.x : centreX - width / 2
		top = north ? bottom - height : south ? start.y : centreY - height / 2
	}

	return { x: left, y: top, width, height }
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const vx = bx - ax
	const vy = by - ay
	const length = vx * vx + vy * vy
	const t = length === 0 ? 0 : clamp(((px - ax) * vx + (py - ay) * vy) / length, 0, 1)

	return Math.hypot(px - (ax + t * vx), py - (ay + t * vy))
}

// The topmost stroke or arrow within `tolerance` (source px) of (x, y) in source space; text is hit in output space
// (textHit), since it is drawn upright there.
export function strokeHit(items: readonly MarkupItem[], x: number, y: number, tolerance: number): MarkupItem | null {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index]

		if (item === undefined || item.kind === "text") {
			continue
		}

		const reach = item.width / 2 + tolerance

		if (item.kind === "arrow") {
			if (distanceToSegment(x, y, item.from[0], item.from[1], item.to[0], item.to[1]) <= reach) {
				return item
			}

			continue
		}

		const points = item.points

		for (let at = 0; at + 1 < points.length; at += 2) {
			const ax = points[at] ?? 0
			const ay = points[at + 1] ?? 0
			const bx = points[at + 2] ?? ax
			const by = points[at + 3] ?? ay

			if (distanceToSegment(x, y, ax, ay, bx, by) <= reach) {
				return item
			}
		}
	}

	return null
}

// A text item's box on screen: anchored at its top left, one line, glyphs about 0.6 em wide.
export function textBox(anchor: readonly [number, number], text: string, fontSize: number): Box {
	return { left: anchor[0], top: anchor[1], width: Math.max(1, text.length) * fontSize * 0.6, height: fontSize * 1.2 }
}

export function inBox(box: Box, x: number, y: number, slack: number): boolean {
	return x >= box.left - slack && x <= box.left + box.width + slack && y >= box.top - slack && y <= box.top + box.height + slack
}

// Moves a crop's centre by `angle` degrees (clockwise on screen) about the frame's centre, in frame px.
function turnCentre(crop: Crop, angle: number, frame: Size): Crop {
	const radians = (angle * Math.PI) / 180
	const c = Math.cos(radians)
	const s = Math.sin(radians)
	const dx = (crop.x + crop.width / 2 - 0.5) * frame.width
	const dy = (crop.y + crop.height / 2 - 0.5) * frame.height
	const centreX = 0.5 + (c * dx - s * dy) / frame.width
	const centreY = 0.5 + (s * dx + c * dy) / frame.height

	return { x: centreX - crop.width / 2, y: centreY - crop.height / 2, width: crop.width, height: crop.height }
}

// The crop tab shows the whole frame, straightened about the frame's centre, while the export straightens about the
// crop's own centre: the same part of the picture then sits at the crop's centre turned about the frame's centre.
export function cropOnFrame(crop: Crop, angle: number, frame: Size): Crop {
	return angle === 0 ? crop : turnCentre(crop, angle, frame)
}

// The recipe's crop for a crop drawn over the frame (cropOnFrame's inverse).
export function cropFromFrame(shown: Crop, angle: number, frame: Size): Crop {
	return angle === 0 ? shown : turnCentre(shown, -angle, frame)
}
