// Placing a rectangle on a page from the keyboard (every rect tool: text box, shape, stamp, signature, redaction area,
// crop): Enter on the focused page puts a default-size rectangle at its centre (or at a given point), the arrows move
// it (Shift: ten times as far), Alt with the arrows resizes it, Enter commits and Escape cancels. Coordinates are the
// page's bottom-left user space in points, as the engine's widgets and annotations; the rectangle never leaves the page.

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

// Points per arrow press, and with Shift.
export const PLACEMENT_STEP = 1
export const PLACEMENT_STEP_LARGE = 10
// The smallest rectangle resizing leaves.
export const PLACEMENT_MIN_SIZE = 4

function clampRect(rect: PlacementRect, page: PlacementPage): PlacementRect {
	const width = Math.min(Math.max(PLACEMENT_MIN_SIZE, rect.width), page.width)
	const height = Math.min(Math.max(PLACEMENT_MIN_SIZE, rect.height), page.height)

	return {
		x: Math.min(Math.max(0, rect.x), page.width - width),
		y: Math.min(Math.max(0, rect.y), page.height - height),
		width,
		height
	}
}

// The first rectangle: `size` centred on `at` (the page's centre without it), inside the page.
export function placementStart(
	page: PlacementPage,
	size: { readonly width: number; readonly height: number },
	at?: { readonly x: number; readonly y: number }
): PlacementRect {
	const centre = at ?? { x: page.width / 2, y: page.height / 2 }

	return clampRect({ x: centre.x - size.width / 2, y: centre.y - size.height / 2, width: size.width, height: size.height }, page)
}

// What a key does to the rectangle; null for a key placement leaves alone.
export function placementKey(rect: PlacementRect, page: PlacementPage, event: PlacementKey): PlacementStep | null {
	if (event.key === "Enter") return { kind: "commit" }
	if (event.key === "Escape") return { kind: "cancel" }

	const step = event.shiftKey ? PLACEMENT_STEP_LARGE : PLACEMENT_STEP
	const [dx, dy] =
		event.key === "ArrowLeft"
			? [-step, 0]
			: event.key === "ArrowRight"
				? [step, 0]
				: event.key === "ArrowUp"
					? [0, step]
					: event.key === "ArrowDown"
						? [0, -step]
						: [0, 0]

	if (dx === 0 && dy === 0) return null

	// Resizing keeps the top left corner where it is: right and down grow the rectangle, left and up shrink it (y is up,
	// so its bottom edge moves).
	const next = event.altKey
		? { x: rect.x, y: rect.y + dy, width: rect.width + dx, height: rect.height - dy }
		: { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height }

	return { kind: "move", rect: clampRect(next, page) }
}

// The rectangle as a live region tells it: its top-left corner from the page's top-left, and its size, in whole points.
export function placementPosition(
	rect: PlacementRect,
	page: PlacementPage
): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } {
	return {
		left: Math.round(rect.x),
		top: Math.round(page.height - rect.y - rect.height),
		width: Math.round(rect.width),
		height: Math.round(rect.height)
	}
}
