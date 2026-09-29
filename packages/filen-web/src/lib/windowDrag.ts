// Pointer travel (px) that turns a press into a drag. Below it the press is still a click: a marquee
// never arms (a zero-size replace-mode marquee would clear the selection on every click), a click-away
// may still clear the selection, and a rail link still navigates.
export const DRAG_THRESHOLD_PX = 4

export function exceedsDragThreshold(dx: number, dy: number): boolean {
	return Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX
}

export interface WindowDragHandlers {
	move: (event: PointerEvent) => void
	up: (event: PointerEvent) => void
	cancel: (event: PointerEvent) => void
	key?: (event: KeyboardEvent) => void
	menu?: (event: MouseEvent) => void
}

// Follows a pointer gesture on the window until it ends. Keys and context menus listen in the capture
// phase so the gesture sees them before any document-level handler. Returns the one detach; calling it
// twice is harmless.
export function listenWindowDrag({ move, up, cancel, key, menu }: WindowDragHandlers): () => void {
	window.addEventListener("pointermove", move)
	window.addEventListener("pointerup", up)
	window.addEventListener("pointercancel", cancel)

	if (key) {
		window.addEventListener("keydown", key, true)
	}

	if (menu) {
		window.addEventListener("contextmenu", menu, true)
	}

	return () => {
		window.removeEventListener("pointermove", move)
		window.removeEventListener("pointerup", up)
		window.removeEventListener("pointercancel", cancel)

		if (key) {
			window.removeEventListener("keydown", key, true)
		}

		if (menu) {
			window.removeEventListener("contextmenu", menu, true)
		}
	}
}
