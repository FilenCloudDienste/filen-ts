// Word's Mini toolbar: where it is placed, how opaque it is for where the pointer is, and which presses show it.

// Faded as it first appears; opaque once the pointer is on it.
export const MINI_TOOLBAR_FADED = 0.4
// Moving this far (px) past where the pointer was when it appeared fades it out completely and hides it.
export const MINI_TOOLBAR_FADE_OUT = 96
// The least distance the fade-in is measured over: a toolbar shown right at the pointer still fades in.
export const MINI_TOOLBAR_MIN_START = 24
// The gap (px) between the toolbar and the line or pointer it is placed above, and its margin to the edges.
export const MINI_TOOLBAR_GAP = 8
export const MINI_TOOLBAR_EDGE = 8

export interface MiniRect {
	readonly left: number
	readonly top: number
	readonly right: number
	readonly bottom: number
}

// The distance (px) of a point to a rectangle, 0 inside it.
export function rectDistance(rect: MiniRect, x: number, y: number): number {
	const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0
	const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0

	return Math.hypot(dx, dy)
}

// The toolbar's opacity with the pointer `distance` px away, when it appeared `start` px away: faded at the start,
// opaque on it, fading out moving away; null once faded out (hidden).
export function miniToolbarOpacity(distance: number, start: number): number | null {
	const from = Math.max(start, MINI_TOOLBAR_MIN_START)

	if (distance <= 0) {
		return 1
	}

	if (distance <= from) {
		return MINI_TOOLBAR_FADED + (1 - MINI_TOOLBAR_FADED) * (1 - distance / from)
	}

	const left = 1 - (distance - from) / MINI_TOOLBAR_FADE_OUT

	return left <= 0 ? null : MINI_TOOLBAR_FADED * left
}

export interface MiniPlacement {
	// The point it is placed above (client px): the line's top at the selection's moving end, or the pointer.
	readonly x: number
	readonly y: number
	// The height (px) of what is at the point (the line), skipped when it goes below for want of room above.
	readonly below: number
}

// Where the toolbar goes (client px, its top left): above the point, starting a little left of it, inside `bounds`
// (the viewport, or less); below the point where there is no room above. Clear of `avoid` (the context menu): above
// it, else below it.
export function placeMiniToolbar(
	width: number,
	height: number,
	at: MiniPlacement,
	bounds: MiniRect,
	avoid?: MiniRect
): { left: number; top: number } {
	const minLeft = bounds.left + MINI_TOOLBAR_EDGE
	const maxLeft = Math.max(minLeft, bounds.right - MINI_TOOLBAR_EDGE - width)
	const minTop = bounds.top + MINI_TOOLBAR_EDGE
	const maxTop = Math.max(minTop, bounds.bottom - MINI_TOOLBAR_EDGE - height)
	const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)
	const left = clamp(at.x - MINI_TOOLBAR_EDGE, minLeft, maxLeft)
	let top = at.y - MINI_TOOLBAR_GAP - height

	if (top < minTop) {
		top = at.y + at.below + MINI_TOOLBAR_GAP
	}

	top = clamp(top, minTop, maxTop)

	if (avoid !== undefined && left < avoid.right && left + width > avoid.left && top < avoid.bottom && top + height > avoid.top) {
		const above = avoid.top - MINI_TOOLBAR_GAP - height

		top = clamp(above >= minTop ? above : avoid.bottom + MINI_TOOLBAR_GAP, minTop, maxTop)
	}

	return { left, top }
}

// A context menu asked for with the mouse (a right click), not the keyboard's menu key or Shift+F10, nor touch.
export function mouseContextMenu(event: { readonly button: number; readonly pointerType?: string | undefined }): boolean {
	return event.pointerType === undefined || event.pointerType === "" ? event.button === 2 : event.pointerType === "mouse"
}

// Keys that only modify another (held for a shortcut or a click): they leave the toolbar shown.
const MODIFIERS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn", "OS"])

export function hidesMiniToolbar(key: string): boolean {
	return !MODIFIERS.has(key)
}
