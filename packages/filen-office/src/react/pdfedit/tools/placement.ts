import { normalizeRect, type PdfPoint, type PdfRect } from "../../../core/pdfedit/annotations"
import {
	arrowDelta,
	boxCentre,
	centredRect,
	clampPoint,
	clampRect,
	distance,
	isArrow,
	TOOL_CLICK_SLOP,
	TOOL_MIN_SIZE,
	type ToolKey,
	type ToolPage,
	type ToolPointer,
	type ToolStep
} from "./types"

// The two ways every rect tool (text box, shapes, stamp, and later signature fields, redaction areas, crop) places a
// rect: dragging it out with the pointer, or from the keyboard (Enter on the focused page places a default-size rect
// at its centre or at `at`; arrows move it, Shift ×10; Alt+arrows resize it; Enter commits; Escape cancels). The host
// announces the placement's position in a live region on every step.

export interface RectSize {
	readonly width: number
	readonly height: number
	// Width / height kept when Shift is held (or always, for a stamp); absent: Shift makes a square.
	readonly aspect?: number
	readonly lockAspect?: boolean
}

export interface Placement {
	readonly page: number
	readonly box: PdfRect
	readonly rect: PdfRect
	readonly aspect?: number
}

// The keyboard placement a tool starts on Enter.
export function startPlacement(target: ToolPage, size: RectSize, at?: PdfPoint): Placement {
	const rect = centredRect(at ?? boxCentre(target.box), size.width, size.height, target.box)

	return {
		page: target.page,
		box: target.box,
		rect,
		...(size.lockAspect === true && size.aspect !== undefined ? { aspect: size.aspect } : {})
	}
}

// One key on a keyboard placement: the moved/resized placement, null when cancelled, or the rect to commit.
export function placementKey(placement: Placement, key: ToolKey): ToolStep<Placement | null, PdfRect> {
	if (key.key === "Escape") return { state: null }
	if (key.key === "Enter") return { state: null, commit: placement.rect }
	if (!isArrow(key.key)) return { state: placement }

	const [dx, dy] = arrowDelta(key.key, key.shift === true)
	const [x0, y0, x1, y1] = placement.rect

	if (key.alt !== true) return { state: { ...placement, rect: clampRect([x0 + dx, y0 + dy, x1 + dx, y1 + dy], placement.box) } }

	let width = Math.max(TOOL_MIN_SIZE, x1 - x0 + dx)
	let height = Math.max(TOOL_MIN_SIZE, y1 - y0 + dy)

	if (placement.aspect !== undefined) {
		if (dx !== 0) height = width / placement.aspect
		else width = height * placement.aspect
	}

	const rect: PdfRect = [x0, y0, Math.min(placement.box[2], x0 + width), Math.min(placement.box[3], y0 + height)]

	return { state: { ...placement, rect } }
}

export interface RectDrag {
	readonly page: number
	readonly anchor: PdfPoint
	readonly rect: PdfRect
	// Whether the pointer went further than a click.
	readonly dragged: boolean
}

// The rect from `anchor` to `point`, a square or the kept aspect while constrained.
export function dragRect(anchor: PdfPoint, point: PdfPoint, constrain: boolean, aspect: number | undefined): PdfRect {
	if (!constrain) return normalizeRect([anchor[0], anchor[1], point[0], point[1]])

	const dx = point[0] - anchor[0]
	const dy = point[1] - anchor[1]
	const ratio = aspect ?? 1
	const width = Math.max(Math.abs(dx), Math.abs(dy) * ratio)
	const height = width / ratio

	return normalizeRect([anchor[0], anchor[1], anchor[0] + Math.sign(dx || 1) * width, anchor[1] + Math.sign(dy || 1) * height])
}

// One pointer event of a rect drag (`drag` null before the press). A click places `size` centred at the point; a drag
// shorter than the minimum size on either side is grown to it. The rect stays inside the page box.
export function rectDragPointer(
	drag: RectDrag | null,
	event: ToolPointer,
	size: RectSize
): ToolStep<RectDrag | null, { page: number; rect: PdfRect }> {
	const box = event.box
	const point = clampPoint(event.point, box)

	switch (event.type) {
		case "down":
			return { state: { page: event.page, anchor: point, rect: [point[0], point[1], point[0], point[1]], dragged: false } }
		case "move": {
			if (drag === null || event.page !== drag.page) return { state: drag }

			const dragged = drag.dragged || distance(drag.anchor, point) > TOOL_CLICK_SLOP

			return {
				state: {
					...drag,
					dragged,
					rect: dragRect(drag.anchor, point, event.shift === true || size.lockAspect === true, size.aspect)
				}
			}
		}
		case "up": {
			if (drag === null) return { state: null }
			if (!drag.dragged)
				return { state: null, commit: { page: drag.page, rect: centredRect(drag.anchor, size.width, size.height, box) } }

			const [x0, y0, x1, y1] = drag.rect
			const rect = clampRect([x0, y0, Math.max(x1, x0 + TOOL_MIN_SIZE), Math.max(y1, y0 + TOOL_MIN_SIZE)], box)

			return { state: null, commit: { page: drag.page, rect } }
		}
		case "cancel":
			return { state: null }
	}
}
