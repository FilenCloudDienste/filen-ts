import type { PdfPoint, PdfRect } from "../../../core/pdfedit/annotations"

// What the annotation tools take: pointer and key events already mapped to a page and to page space (points, y down,
// the space the annotation engine uses). The tools are headless state machines: each step is a pure function
// returning the next state and, when the gesture finished, what to commit (one engine command). The host renders the
// state (overlays.tsx) and runs the commit.

export interface ToolPointer {
	readonly type: "down" | "move" | "up" | "cancel"
	readonly page: number
	// The page's box in page space ([0, 0, width, height]): gestures stay inside it.
	readonly box: PdfRect
	readonly point: PdfPoint
	// Shift held: constrain (square, circle, 45° line, kept aspect).
	readonly shift?: boolean
}

export type ToolKeyName = "Enter" | "Escape" | "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Delete" | "Backspace"

export interface ToolKey {
	readonly key: ToolKeyName
	readonly shift?: boolean
	readonly alt?: boolean
}

// A step: the next state, and what the finished gesture commits (absent while it goes on).
export interface ToolStep<S, C> {
	readonly state: S
	readonly commit?: C
}

// The page a key event acts on: its index and its box (page space; [0, 0, width, height]).
export interface ToolPage {
	readonly page: number
	readonly box: PdfRect
}

// Sizes in points.
export const TOOL_MIN_SIZE = 4
// A click (no drag) is shorter than this.
export const TOOL_CLICK_SLOP = 3
export const TOOL_NUDGE = 1
export const TOOL_NUDGE_LARGE = 10

export function isArrow(key: ToolKeyName): key is "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" {
	return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown"
}

// An arrow key's direction, scaled by Shift.
export function arrowDelta(key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown", shift: boolean): PdfPoint {
	const step = shift ? TOOL_NUDGE_LARGE : TOOL_NUDGE

	switch (key) {
		case "ArrowLeft":
			return [-step, 0]
		case "ArrowRight":
			return [step, 0]
		case "ArrowUp":
			return [0, -step]
		case "ArrowDown":
			return [0, step]
	}
}

export function distance(a: PdfPoint, b: PdfPoint): number {
	return Math.hypot(b[0] - a[0], b[1] - a[1])
}

// `rect` moved inside `box` (as far as it fits).
export function clampRect(rect: PdfRect, box: PdfRect): PdfRect {
	const width = Math.min(rect[2] - rect[0], box[2] - box[0])
	const height = Math.min(rect[3] - rect[1], box[3] - box[1])
	const x = Math.min(Math.max(rect[0], box[0]), box[2] - width)
	const y = Math.min(Math.max(rect[1], box[1]), box[3] - height)

	return [x, y, x + width, y + height]
}

export function clampPoint(point: PdfPoint, box: PdfRect): PdfPoint {
	return [Math.min(Math.max(point[0], box[0]), box[2]), Math.min(Math.max(point[1], box[1]), box[3])]
}

// A rect of `width` × `height` centred on `at`, kept inside `box`.
export function centredRect(at: PdfPoint, width: number, height: number, box: PdfRect): PdfRect {
	return clampRect([at[0] - width / 2, at[1] - height / 2, at[0] + width / 2, at[1] + height / 2], box)
}

export function boxCentre(box: PdfRect): PdfPoint {
	return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]
}
