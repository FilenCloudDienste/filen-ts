import type { PdfPoint, PdfRect } from "../../../core/pdfedit/annotations"
import { placementKey, rectDragPointer, startPlacement, type Placement, type RectDrag, type RectSize } from "./placement"
import { clampPoint, distance, TOOL_CLICK_SLOP, type ToolKey, type ToolPage, type ToolPointer, type ToolStep } from "./types"

// The rect tools: shapes (rectangle, ellipse, line), stamps, and the placing half of the text box (textBox.ts edits
// what it placed). Each places by pointer or keyboard (placement.ts) and commits one placed geometry.

export interface RectToolState {
	readonly drag: RectDrag | null
	readonly placement: Placement | null
}

export const RECT_TOOL_IDLE: RectToolState = { drag: null, placement: null }

export interface RectPlaced {
	readonly page: number
	readonly rect: PdfRect
}

// One pointer event: a drag or a click places a rect of `size` (a keyboard placement in progress is dropped).
export function rectToolPointer(state: RectToolState, event: ToolPointer, size: RectSize): ToolStep<RectToolState, RectPlaced> {
	const step = rectDragPointer(state.drag, event, size)

	return { state: { drag: step.state, placement: null }, ...(step.commit === undefined ? {} : { commit: step.commit }) }
}

// One key on the focused page: Enter starts a keyboard placement (at `at`, else the page centre), then placementKey.
export function rectToolKey(
	state: RectToolState,
	key: ToolKey,
	target: ToolPage,
	size: RectSize,
	at?: PdfPoint
): ToolStep<RectToolState, RectPlaced> {
	if (state.placement === null) {
		return key.key === "Enter" && state.drag === null
			? { state: { drag: null, placement: startPlacement(target, size, at) } }
			: { state }
	}

	const step = placementKey(state.placement, key)

	return {
		state: { drag: null, placement: step.state },
		...(step.commit === undefined ? {} : { commit: { page: state.placement.page, rect: step.commit } })
	}
}

// The rect the tool shows (a drag or a placement), or null.
export function rectToolDraft(state: RectToolState): RectPlaced | null {
	if (state.drag !== null) return { page: state.drag.page, rect: state.drag.rect }
	if (state.placement !== null) return { page: state.placement.page, rect: state.placement.rect }

	return null
}

// Shapes.

export type ShapeKind = "Square" | "Circle" | "Line"

export const SHAPE_SIZE: RectSize = { width: 120, height: 80 }
// A clicked line runs this long to the right.
export const LINE_LENGTH = 120

export interface LineDrag {
	readonly page: number
	readonly from: PdfPoint
	readonly to: PdfPoint
	readonly dragged: boolean
}

export interface ShapeState extends RectToolState {
	readonly kind: ShapeKind
	readonly line: LineDrag | null
}

export type ShapeCommit =
	| { readonly kind: "Square" | "Circle"; readonly page: number; readonly rect: PdfRect }
	| { readonly kind: "Line"; readonly page: number; readonly from: PdfPoint; readonly to: PdfPoint }

export function shapeTool(kind: ShapeKind): ShapeState {
	return { kind, line: null, ...RECT_TOOL_IDLE }
}

// `to` snapped to the nearest 45° direction from `from`.
export function snapAngle(from: PdfPoint, to: PdfPoint): PdfPoint {
	const length = distance(from, to)
	const angle = Math.round(Math.atan2(to[1] - from[1], to[0] - from[0]) / (Math.PI / 4)) * (Math.PI / 4)

	return [from[0] + Math.cos(angle) * length, from[1] + Math.sin(angle) * length]
}

function shapeCommit(kind: ShapeKind, placed: RectPlaced): ShapeCommit {
	return kind === "Line"
		? { kind, page: placed.page, from: [placed.rect[0], placed.rect[1]], to: [placed.rect[2], placed.rect[3]] }
		: { kind, page: placed.page, rect: placed.rect }
}

export function shapePointer(state: ShapeState, event: ToolPointer): ToolStep<ShapeState, ShapeCommit> {
	if (state.kind !== "Line") {
		const step = rectToolPointer(state, event, SHAPE_SIZE)

		return {
			state: { ...state, ...step.state },
			...(step.commit === undefined ? {} : { commit: shapeCommit(state.kind, step.commit) })
		}
	}

	const point = clampPoint(event.point, event.box)
	const line = state.line

	switch (event.type) {
		case "down":
			return { state: { ...state, placement: null, line: { page: event.page, from: point, to: point, dragged: false } } }
		case "move": {
			if (line === null || line.page !== event.page) return { state }

			const to = clampPoint(event.shift === true ? snapAngle(line.from, point) : point, event.box)

			return { state: { ...state, line: { ...line, to, dragged: line.dragged || distance(line.from, point) > TOOL_CLICK_SLOP } } }
		}
		case "up": {
			if (line === null) return { state }

			const to = line.dragged ? line.to : clampPoint([line.from[0] + LINE_LENGTH, line.from[1]], event.box)

			return { state: { ...state, line: null }, commit: { kind: "Line", page: line.page, from: line.from, to } }
		}
		case "cancel":
			return { state: { ...state, line: null } }
	}
}

export function shapeKey(state: ShapeState, key: ToolKey, target: ToolPage, at?: PdfPoint): ToolStep<ShapeState, ShapeCommit> {
	if (state.line !== null) return { state }

	const step = rectToolKey(state, key, target, SHAPE_SIZE, at)

	return { state: { ...state, ...step.state }, ...(step.commit === undefined ? {} : { commit: shapeCommit(state.kind, step.commit) }) }
}

// Stamps: the chosen stamp's natural size (an image's, scaled to fit; a preset's drawn proportions) keeps its aspect.

// A stamp's default width on the page, and the tallest it starts.
export const STAMP_WIDTH = 150
export const STAMP_MAX_HEIGHT = 200

// The size a stamp whose natural size is `width` × `height` (pixels or any unit) is placed at.
export function stampSize(width: number, height: number): RectSize {
	const aspect = width > 0 && height > 0 ? width / height : 1
	const placedHeight = Math.min(STAMP_MAX_HEIGHT, STAMP_WIDTH / aspect)

	return { width: placedHeight * aspect, height: placedHeight, aspect, lockAspect: true }
}
