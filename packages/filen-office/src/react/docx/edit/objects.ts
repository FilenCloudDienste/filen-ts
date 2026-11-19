import { CROP_MAX_PAD, CROP_WHOLE, type DocxCrop } from "../../../core/docx/edit/commands/drawings"
import type { DocxDrawingContext } from "../../../core/docx/edit/snapshot/drawing"
import type { DocxEditorCommand } from "../../../core/docx/edit/index"
import { EMU_PER_PX as EMU_PER_PAGE_PX } from "../../../core/docx/objects/edit"
import { DRAWING_HANDLES, HANDLE_PLACES, type DrawingHandle, type PageBox } from "../../../core/docx/objects/hits"

// Moving and resizing a drawing with a pointer, headless: the selection frame's handles, the box a drag gives
// (shown meanwhile as a CSS transform of the painted object, so nothing is laid out until the pointer is
// released) and the one command the drag ends with. Page px throughout (a view divides pointer deltas by its
// zoom); EMUs only in the commands. The frame and handles are drawn by the app (data-fo-handle, --fo-*
// variables in docx-objects.css). Cropping a picture works the same way (CropDrag): its crop handles sit where
// the resize handles do, and a drag of one moves that edge over the picture, which stays where it is.

export { DRAWING_HANDLES, type DrawingHandle, type PageBox }

// Layout px are 1/96 inch.
export { EMU_PER_PAGE_PX }
// The smallest a drag makes a drawing (page px).
export const MIN_DRAWING_PX = 4

// Where each handle of a box is (page px), for drawing the frame.
export function handlePoints(box: PageBox): { readonly handle: DrawingHandle; readonly x: number; readonly y: number }[] {
	return DRAWING_HANDLES.map(handle => {
		const [fx, fy] = HANDLE_PLACES[handle]

		return { handle, x: box.x + box.width * fx, y: box.y + box.height * fy }
	})
}

// The CSS cursor a handle shows.
export function handleCursor(handle: DrawingHandle): string {
	return `${handle}-resize`
}

// The box after dragging `handle` of `box` by (dx, dy): the opposite edge or corner stays; with `keepRatio`
// (a corner dragged with Shift, or a picture whose proportions are locked) the box keeps its proportions,
// following the larger of the two moves.
export function resizedBox(box: PageBox, handle: DrawingHandle, dx: number, dy: number, keepRatio: boolean): PageBox {
	const [fx, fy] = HANDLE_PLACES[handle]
	const horizontal = fx !== 0.5
	const vertical = fy !== 0.5
	let width = horizontal ? box.width + (fx === 1 ? dx : -dx) : box.width
	let height = vertical ? box.height + (fy === 1 ? dy : -dy) : box.height

	width = Math.max(MIN_DRAWING_PX, width)
	height = Math.max(MIN_DRAWING_PX, height)

	if (keepRatio && box.width > 0 && box.height > 0) {
		const scale =
			horizontal && vertical ? Math.max(width / box.width, height / box.height) : horizontal ? width / box.width : height / box.height

		width = Math.max(MIN_DRAWING_PX, box.width * scale)
		height = Math.max(MIN_DRAWING_PX, box.height * scale)
	}

	// The handle moves; the edges it does not hold stay (a side handle keeps the box centred across).
	const x = fx === 0 ? box.x + box.width - width : fx === 1 ? box.x : box.x + (box.width - width) / 2
	const y = fy === 0 ? box.y + box.height - height : fy === 1 ? box.y : box.y + (box.height - height) / 2

	return { x, y, width, height }
}

// The transform that shows the object painted in `from` as `to` (transform-origin 0 0 on the object).
export function previewTransform(from: PageBox, to: PageBox): string {
	const sx = from.width > 0 ? to.width / from.width : 1
	const sy = from.height > 0 ? to.height / from.height : 1

	return `translate(${to.x - from.x}px, ${to.y - from.y}px) scale(${sx}, ${sy})`
}

// The resize a box drag ends with: the drawing's extent scaled as its box was (the box may include effects).
// A turned drawing's box is the bounds of its turned extent (w|cos| + h|sin| wide, w|sin| + h|cos| high): the
// extent is the one whose bounds scale so (a quarter turn swaps the axes); near 45 degrees, where that has no
// stable answer, it scales alike along both axes by the side that changed most.
export function resizeCommand(drawing: DocxDrawingContext, from: PageBox, to: PageBox): DocxEditorCommand | undefined {
	if (!drawing.resizable || from.width <= 0 || from.height <= 0) return undefined

	const sx = to.width / from.width
	const sy = to.height / from.height
	const angle = (drawing.rotation * Math.PI) / 180
	const cos = Math.abs(Math.cos(angle))
	const sin = Math.abs(Math.sin(angle))
	const bx = drawing.cx * cos + drawing.cy * sin
	const by = drawing.cx * sin + drawing.cy * cos
	const det = cos * cos - sin * sin
	let width = (cos * bx * sx - sin * by * sy) / det
	let height = (cos * by * sy - sin * bx * sx) / det

	if (Math.abs(det) < 0.5 || !(width > 0) || !(height > 0)) {
		const scale = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy

		width = drawing.cx * scale
		height = drawing.cy * scale
	}

	const cx = Math.max(1, Math.round(width))
	const cy = Math.max(1, Math.round(height))

	return cx === drawing.cx && cy === drawing.cy ? undefined : { type: "drawing.resize", cx, cy }
}

// The move a drag of a floating drawing by (dx, dy) page px ends with: its offsets from what it is placed
// against, moved as far.
export function moveCommand(drawing: DocxDrawingContext, dx: number, dy: number): DocxEditorCommand | undefined {
	if (!drawing.placeable || !drawing.anchored || (dx === 0 && dy === 0)) return undefined

	return {
		type: "drawing.position",
		x: Math.round((drawing.x ?? 0) + dx * EMU_PER_PAGE_PX),
		y: Math.round((drawing.y ?? 0) + dy * EMU_PER_PAGE_PX)
	}
}

// One pointer drag on a selected drawing: from the press (a handle, or the body of a floating drawing) to the
// release. move() gives the box to show; end() the command to run (undefined: nothing changed, or the drag
// cannot change the drawing).
export class DrawingDrag {
	readonly drawing: DocxDrawingContext
	readonly from: PageBox
	readonly handle: DrawingHandle | undefined
	private box: PageBox
	private dx = 0
	private dy = 0

	constructor(drawing: DocxDrawingContext, from: PageBox, handle: DrawingHandle | undefined) {
		this.drawing = drawing
		this.from = from
		this.handle = handle
		this.box = from
	}

	// Whether the drag can do anything: a handle of a resizable drawing, or a floating one moved.
	get active(): boolean {
		return this.handle === undefined ? this.drawing.placeable && this.drawing.anchored : this.drawing.resizable
	}

	// The pointer moved by (dx, dy) page px from the press; `free`: proportions not kept even where they are
	// locked (Word's Shift inverts the lock at corners).
	move(dx: number, dy: number, free = false): PageBox {
		this.dx = dx
		this.dy = dy

		if (!this.active) return this.box

		if (this.handle === undefined) {
			this.box = { ...this.from, x: this.from.x + dx, y: this.from.y + dy }
		} else {
			const corner = HANDLE_PLACES[this.handle][0] !== 0.5 && HANDLE_PLACES[this.handle][1] !== 0.5
			const keep = corner && this.drawing.lockAspect !== free

			this.box = resizedBox(this.from, this.handle, dx, dy, keep)
		}

		return this.box
	}

	get transform(): string {
		return previewTransform(this.from, this.box)
	}

	end(): DocxEditorCommand | undefined {
		if (!this.active) return undefined

		return this.handle === undefined ? moveCommand(this.drawing, this.dx, this.dy) : resizeCommand(this.drawing, this.from, this.box)
	}
}

// ---- cropping ------------------------------------------------------------------------------------------

export type CropSide = keyof DocxCrop

type ScreenSide = "left" | "top" | "right" | "bottom"

const TURN: Readonly<Record<ScreenSide, ScreenSide>> = { top: "right", right: "bottom", bottom: "left", left: "top" }

// Which side of the picture each side of its box on the page shows: mirrored first, then turned clockwise (as
// DrawingML draws a shape). Undefined while it is turned by other than quarter turns.
export function cropSides(drawing: DocxDrawingContext): Readonly<Record<ScreenSide, CropSide>> | undefined {
	const rotation = ((drawing.rotation % 360) + 360) % 360

	if (rotation % 90 !== 0) return undefined

	const out: Partial<Record<ScreenSide, CropSide>> = {}

	for (const side of ["left", "top", "right", "bottom"] as const) {
		let at: ScreenSide = side

		if (drawing.flipH && (at === "left" || at === "right")) at = at === "left" ? "right" : "left"
		if (drawing.flipV && (at === "top" || at === "bottom")) at = at === "top" ? "bottom" : "top"

		for (let turn = 0; turn < rotation / 90; turn++) at = TURN[at]

		out[at] = side
	}

	return out as Record<ScreenSide, CropSide>
}

function horizontal(side: ScreenSide | CropSide): boolean {
	return side === "left" || side === "right"
}

// How much of the picture's side `side` axis shows (1: all of it), in fractions.
function shown(crop: DocxCrop, side: CropSide): number {
	return horizontal(side) ? (CROP_WHOLE - crop.left - crop.right) / CROP_WHOLE : (CROP_WHOLE - crop.top - crop.bottom) / CROP_WHOLE
}

// One pointer drag in crop mode on a selected picture: from the press on a crop handle (an edge or corner of
// what shows) or on the picture itself (moving the picture under what shows) to the release. move() gives
// the box what shows takes (`box`) and where the whole picture is (`picture`, for showing what is cropped
// off); end() the drawing.crop to run (undefined: nothing changed, or the picture cannot be cropped so).
// Dragging an edge out past the picture pads it, as Word's crop does.
export class CropDrag {
	readonly drawing: DocxDrawingContext
	readonly from: PageBox
	readonly handle: DrawingHandle | undefined
	private readonly sides: Readonly<Record<ScreenSide, CropSide>> | undefined
	private crop: DocxCrop
	private frame: PageBox
	private whole: PageBox

	constructor(drawing: DocxDrawingContext, from: PageBox, handle: DrawingHandle | undefined) {
		this.drawing = drawing
		this.from = from
		this.handle = handle
		this.sides = drawing.croppable && from.width > 0 && from.height > 0 ? cropSides(drawing) : undefined
		this.crop = drawing.crop
		this.frame = from
		this.whole = this.pictureBox(from, drawing.crop)
	}

	get active(): boolean {
		return this.sides !== undefined
	}

	get box(): PageBox {
		return this.frame
	}

	get picture(): PageBox {
		return this.whole
	}

	// The whole picture's length (page px) along the page axis of `side`, at the drag's start.
	private full(side: ScreenSide): number {
		const sides = this.sides as Record<ScreenSide, CropSide>
		const length = horizontal(side) ? this.from.width : this.from.height

		return length / shown(this.drawing.crop, sides[side])
	}

	// The whole picture's box when `frame` shows it cropped by `crop`.
	private pictureBox(frame: PageBox, crop: DocxCrop): PageBox {
		const sides = this.sides

		if (sides === undefined) return frame

		const reach = (side: ScreenSide): number => (crop[sides[side]] / CROP_WHOLE) * this.full(side)
		const left = reach("left")
		const top = reach("top")

		return {
			x: frame.x - left,
			y: frame.y - top,
			width: frame.width + left + reach("right"),
			height: frame.height + top + reach("bottom")
		}
	}

	// The pointer moved by (dx, dy) page px from the press.
	move(dx: number, dy: number): PageBox {
		const sides = this.sides

		if (sides === undefined) return this.frame

		const start = this.drawing.crop
		const next: Record<CropSide, number> = { ...start }
		// Crop units per page px along each page axis.
		const unitsX = CROP_WHOLE / this.full("left")
		const unitsY = CROP_WHOLE / this.full("top")

		if (this.handle === undefined) {
			// The picture moves under what shows: as much more cut off one side as less off the other.
			next[sides.left] -= dx * unitsX
			next[sides.right] += dx * unitsX
			next[sides.top] -= dy * unitsY
			next[sides.bottom] += dy * unitsY
		} else {
			const [fx, fy] = HANDLE_PLACES[this.handle]

			if (fx === 0) next[sides.left] += dx * unitsX
			if (fx === 1) next[sides.right] -= dx * unitsX
			if (fy === 0) next[sides.top] += dy * unitsY
			if (fy === 1) next[sides.bottom] -= dy * unitsY
		}

		// What shows stays at least MIN_DRAWING_PX each way; a side pads at most CROP_MAX_PAD.
		const fit = (moved: ScreenSide, other: ScreenSide, units: number): void => {
			const keep = CROP_WHOLE - Math.max(1, MIN_DRAWING_PX * units)
			const a = sides[moved]
			const b = sides[other]

			next[a] = Math.max(-CROP_MAX_PAD, next[a])
			next[b] = Math.max(-CROP_MAX_PAD, next[b])

			if (next[a] + next[b] <= keep) return

			// The side the drag moved gives way (both alike when the picture is moved).
			if (this.handle === undefined) {
				const over = (next[a] + next[b] - keep) / 2

				next[a] -= over
				next[b] -= over
			} else if (next[a] !== start[a]) {
				next[a] = keep - next[b]
			} else {
				next[b] = keep - next[a]
			}
		}

		fit("left", "right", unitsX)
		fit("top", "bottom", unitsY)

		this.crop = next

		if (this.handle === undefined) {
			this.frame = this.from
		} else {
			const moved = (side: ScreenSide): number => ((next[sides[side]] - start[sides[side]]) / CROP_WHOLE) * this.full(side)
			const left = moved("left")
			const top = moved("top")

			this.frame = {
				x: this.from.x + left,
				y: this.from.y + top,
				width: this.from.width - left - moved("right"),
				height: this.from.height - top - moved("bottom")
			}
		}

		this.whole = this.pictureBox(this.frame, next)

		return this.frame
	}

	end(): DocxEditorCommand | undefined {
		if (this.sides === undefined) return undefined

		const round = (side: CropSide): number => Math.round(this.crop[side])
		const crop = { left: round("left"), top: round("top"), right: round("right"), bottom: round("bottom") }
		const start = this.drawing.crop

		if (crop.left === start.left && crop.top === start.top && crop.right === start.right && crop.bottom === start.bottom)
			return undefined
		if (crop.left + crop.right >= CROP_WHOLE || crop.top + crop.bottom >= CROP_WHOLE) return undefined

		return { type: "drawing.crop", ...crop }
	}
}
