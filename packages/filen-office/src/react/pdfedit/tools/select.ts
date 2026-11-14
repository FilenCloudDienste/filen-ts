import { translateRect, type PdfAnnotationInfo, type PdfAnnotationRef, type PdfRect } from "../../../core/pdfedit/annotations"
import {
	arrowDelta,
	clampRect,
	distance,
	isArrow,
	TOOL_CLICK_SLOP,
	TOOL_MIN_SIZE,
	type ToolKey,
	type ToolPointer,
	type ToolStep
} from "./types"

// The select tool: a press picks the topmost annotation under it (or a handle of the selected one), a drag moves or
// resizes it and commits once when the pointer lifts (one journal operation per drag); arrows nudge it (Shift ×10),
// Alt+arrows resize it, Delete removes it, Escape deselects. Annotations whose geometry the engine can't change (text
// markups, locked ones) are selected for the popover and the comments, never moved. Hit tests run on the annotation
// rects the host already holds (listAnnotations), never on the engine.

export type SelectHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w"

export const SELECT_HANDLES: readonly SelectHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"]

export interface SelectDrag {
	readonly kind: "move" | "resize"
	readonly handle?: SelectHandle
	readonly start: readonly [number, number]
	// The selected annotation's rect when the press started, and its rect as dragged.
	readonly from: PdfRect
	readonly rect: PdfRect
	readonly moved: boolean
}

export interface SelectState {
	readonly selected: PdfAnnotationInfo | null
	readonly drag: SelectDrag | null
}

export type SelectCommit =
	| { readonly kind: "select"; readonly ref: PdfAnnotationRef | null }
	| { readonly kind: "move"; readonly ref: PdfAnnotationRef; readonly dx: number; readonly dy: number }
	| { readonly kind: "resize"; readonly ref: PdfAnnotationRef; readonly rect: PdfRect }
	| { readonly kind: "delete"; readonly ref: PdfAnnotationRef }

export const SELECT_IDLE: SelectState = { selected: null, drag: null }

// What the host knows of the page under the pointer: its annotations in drawing order, and how far (points) a press
// may miss a rect or handle (a few pixels at the current zoom).
export interface SelectContext {
	readonly annotations: readonly PdfAnnotationInfo[]
	readonly tolerance: number
}

export function canMove(info: PdfAnnotationInfo): boolean {
	return info.geometry !== null && !info.locked
}

// Sticky notes keep their icon size: they move but never resize.
export function canResize(info: PdfAnnotationInfo): boolean {
	return canMove(info) && info.type !== "Text"
}

export function handlePoint(rect: PdfRect, handle: SelectHandle): readonly [number, number] {
	const [x0, y0, x1, y1] = rect
	const mx = (x0 + x1) / 2
	const my = (y0 + y1) / 2

	switch (handle) {
		case "nw":
			return [x0, y0]
		case "n":
			return [mx, y0]
		case "ne":
			return [x1, y0]
		case "e":
			return [x1, my]
		case "se":
			return [x1, y1]
		case "s":
			return [mx, y1]
		case "sw":
			return [x0, y1]
		case "w":
			return [x0, my]
	}
}

function contains(rect: PdfRect, point: readonly [number, number], slop: number): boolean {
	return point[0] >= rect[0] - slop && point[0] <= rect[2] + slop && point[1] >= rect[1] - slop && point[1] <= rect[3] + slop
}

// The topmost annotation under `point` (the last drawn wins).
export function hitAnnotation(
	annotations: readonly PdfAnnotationInfo[],
	point: readonly [number, number],
	tolerance: number
): PdfAnnotationInfo | null {
	for (let index = annotations.length - 1; index >= 0; index--) {
		const info = annotations[index]

		if (info !== undefined && contains(info.rect, point, tolerance)) return info
	}

	return null
}

export function hitHandle(rect: PdfRect, point: readonly [number, number], tolerance: number): SelectHandle | null {
	for (const handle of SELECT_HANDLES) if (distance(handlePoint(rect, handle), point) <= tolerance) return handle

	return null
}

// `from` with the dragged handle at (dx, dy); Shift keeps the aspect on corner handles. Never smaller than the
// minimum size.
export function resizeRect(from: PdfRect, handle: SelectHandle, dx: number, dy: number, keepAspect: boolean): PdfRect {
	let [x0, y0, x1, y1] = from

	if (handle.includes("w")) x0 = Math.min(x0 + dx, x1 - TOOL_MIN_SIZE)
	if (handle.includes("e")) x1 = Math.max(x1 + dx, x0 + TOOL_MIN_SIZE)
	if (handle.includes("n")) y0 = Math.min(y0 + dy, y1 - TOOL_MIN_SIZE)
	if (handle.includes("s")) y1 = Math.max(y1 + dy, y0 + TOOL_MIN_SIZE)

	if (keepAspect && handle.length === 2) {
		const aspect = (from[2] - from[0]) / Math.max(TOOL_MIN_SIZE, from[3] - from[1])
		const height = (x1 - x0) / aspect

		if (handle.includes("n")) y0 = y1 - height
		else y1 = y0 + height
	}

	return [x0, y0, x1, y1]
}

const same = (a: PdfRect, b: PdfRect): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]

function refOf(info: PdfAnnotationInfo): PdfAnnotationRef {
	return { page: info.page, id: info.id }
}

export function selectPointer(state: SelectState, event: ToolPointer, context: SelectContext): ToolStep<SelectState, SelectCommit> {
	const selected = state.selected

	switch (event.type) {
		case "down": {
			if (selected !== null && selected.page === event.page && canResize(selected)) {
				const handle = hitHandle(selected.rect, event.point, context.tolerance)

				if (handle !== null) {
					return {
						state: {
							selected,
							drag: { kind: "resize", handle, start: event.point, from: selected.rect, rect: selected.rect, moved: false }
						}
					}
				}
			}

			const hit = hitAnnotation(context.annotations, event.point, context.tolerance)

			if (hit === null) return selected === null ? { state } : { state: SELECT_IDLE, commit: { kind: "select", ref: null } }

			const drag: SelectDrag | null = canMove(hit)
				? { kind: "move", start: event.point, from: hit.rect, rect: hit.rect, moved: false }
				: null
			const changed = selected?.page !== hit.page || selected.id !== hit.id

			return { state: { selected: hit, drag }, ...(changed ? { commit: { kind: "select", ref: refOf(hit) } } : {}) }
		}
		case "move": {
			const drag = state.drag

			if (drag === null || selected === null || event.page !== selected.page) return { state }

			const dx = event.point[0] - drag.start[0]
			const dy = event.point[1] - drag.start[1]
			const moved = drag.moved || distance(drag.start, event.point) > TOOL_CLICK_SLOP

			if (!moved) return { state }

			const rect =
				drag.kind === "move"
					? clampRect(translateRect(drag.from, dx, dy), event.box)
					: resizeRect(drag.from, drag.handle ?? "se", dx, dy, event.shift === true)

			return { state: { selected, drag: { ...drag, rect, moved } } }
		}
		case "up": {
			const drag = state.drag

			if (drag === null || selected === null) return { state }

			const next: SelectState = { selected: drag.moved ? { ...selected, rect: drag.rect } : selected, drag: null }

			if (!drag.moved || same(drag.rect, drag.from)) return { state: next }

			return {
				state: next,
				commit:
					drag.kind === "move"
						? { kind: "move", ref: refOf(selected), dx: drag.rect[0] - drag.from[0], dy: drag.rect[1] - drag.from[1] }
						: { kind: "resize", ref: refOf(selected), rect: drag.rect }
			}
		}
		case "cancel":
			return { state: { selected, drag: null } }
	}
}

export function selectKey(state: SelectState, key: ToolKey): ToolStep<SelectState, SelectCommit> {
	const selected = state.selected

	if (selected === null || state.drag !== null) return { state }
	if (key.key === "Escape") return { state: SELECT_IDLE, commit: { kind: "select", ref: null } }
	if (key.key === "Delete" || key.key === "Backspace")
		return selected.locked ? { state } : { state: SELECT_IDLE, commit: { kind: "delete", ref: refOf(selected) } }
	if (!isArrow(key.key)) return { state }

	const [dx, dy] = arrowDelta(key.key, key.shift === true)

	if (key.alt === true) {
		if (!canResize(selected)) return { state }

		const rect = resizeRect(selected.rect, "se", dx, dy, false)

		return { state: { selected: { ...selected, rect }, drag: null }, commit: { kind: "resize", ref: refOf(selected), rect } }
	}

	if (!canMove(selected)) return { state }

	return {
		state: { selected: { ...selected, rect: translateRect(selected.rect, dx, dy) }, drag: null },
		commit: { kind: "move", ref: refOf(selected), dx, dy }
	}
}

// The selection follows the document: the host passes a page's annotations after every change to it (an undo, a
// commit), and the selected one's info is refreshed, or dropped when it is gone.
export function selectRefresh(state: SelectState, page: number, annotations: readonly PdfAnnotationInfo[]): SelectState {
	const selected = state.selected

	if (selected?.page !== page) return state

	const now = annotations.find(info => info.id === selected.id)

	return now === undefined ? SELECT_IDLE : { selected: now, drag: state.drag }
}
