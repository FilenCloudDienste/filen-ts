import type { PdfRect } from "../../core/pdfedit/annotations"
import { placementKey, rectPosition, startPlacement, type Placement } from "./tools/placement"
import type { ToolKeyName } from "./tools/types"

// Keyboard placement of a rectangle in the page's bottom-left user space (points, y up, as the engine's widgets and
// annotations), for hosts that work in it (signature, fill-and-sign, text edit). The rules (Enter commits, Escape
// cancels, arrows move, Shift ×10, Alt resizes, the rectangle stays on the page) are the tools' own
// (tools/placement.ts, page space, y down): this converts at the boundary.

export interface PlacementRect {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

export interface PlacementPage {
	readonly width: number
	readonly height: number
}

export interface PlacementKey {
	readonly key: string
	readonly shiftKey: boolean
	readonly altKey: boolean
}

export type PlacementStep =
	{ readonly kind: "move"; readonly rect: PlacementRect } | { readonly kind: "commit" } | { readonly kind: "cancel" }

function pageBox(page: PlacementPage): PdfRect {
	return [0, 0, page.width, page.height]
}

function toPageSpace(rect: PlacementRect, page: PlacementPage): PdfRect {
	return [rect.x, page.height - rect.y - rect.height, rect.x + rect.width, page.height - rect.y]
}

function fromPageSpace(rect: PdfRect, page: PlacementPage): PlacementRect {
	return { x: rect[0], y: page.height - rect[3], width: rect[2] - rect[0], height: rect[3] - rect[1] }
}

function toolKey(key: string): ToolKeyName | null {
	return key === "Enter" || key === "Escape" || key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown"
		? key
		: null
}

// The first rectangle: `size` centred on `at` (the page's centre without it), inside the page.
export function placementStart(
	page: PlacementPage,
	size: { readonly width: number; readonly height: number },
	at?: { readonly x: number; readonly y: number }
): PlacementRect {
	const placement = startPlacement({ page: 0, box: pageBox(page) }, size, at === undefined ? undefined : [at.x, page.height - at.y])

	return fromPageSpace(placement.rect, page)
}

// What a key does to the rectangle; null for a key placement leaves alone.
export function placementRectKey(rect: PlacementRect, page: PlacementPage, event: PlacementKey): PlacementStep | null {
	const key = toolKey(event.key)

	if (key === null) return null

	const placement: Placement = { page: 0, box: pageBox(page), rect: toPageSpace(rect, page) }
	const step = placementKey(placement, { key, shift: event.shiftKey, alt: event.altKey })

	if (step.commit !== undefined) return { kind: "commit" }
	if (step.state === null) return { kind: "cancel" }

	return { kind: "move", rect: fromPageSpace(step.state.rect, page) }
}

// The rectangle as a live region tells it: its top-left corner from the page's top-left, and its size, in whole points.
export function placementPosition(
	rect: PlacementRect,
	page: PlacementPage
): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } {
	return rectPosition(toPageSpace(rect, page), pageBox(page))
}
