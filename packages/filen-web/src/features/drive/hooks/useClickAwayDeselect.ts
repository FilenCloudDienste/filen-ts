import { useEffect, useRef } from "react"
import { isAnyDialogOpen, isAnyMenuOpen } from "@/lib/keymap/dialogGuard"
import { DRAG_THRESHOLD_PX } from "@/features/drive/lib/marquee.logic"
import { isKeepSelectionTarget, isPlainPointerClick, isScrollbarPress } from "@/features/drive/lib/clickAway.logic"

// The press a click resolves against. `ignore` is decided at pointerdown, before anything reacts to it:
// a press that dismisses an open menu or lands on a dialog's backdrop only closes that layer, and a
// press in a scrollbar gutter only scrolls.
interface Press {
	x: number
	y: number
	ignore: boolean
}

// Clears a listing's selection on a plain click anywhere outside its items and controls
// (clickAway.logic.ts decides what counts). Listens only while `active` — the listing is mounted with a
// non-empty selection. Window-level and capture-phase, so it sees every click before any handler can
// stop it and while a clicked menu or dialog is still in the DOM to be recognised. A press that travels
// past the drag threshold (a marquee, a text selection, a resize, a drag-and-drop) is not a click.
export function useClickAwayDeselect(active: boolean, clear: () => void): void {
	const clearRef = useRef(clear)

	useEffect(() => {
		clearRef.current = clear
	})

	useEffect(() => {
		if (!active) {
			return
		}

		let press: Press | null = null

		function onPointerDown(event: PointerEvent): void {
			if (!event.isPrimary) {
				return
			}

			let ignore = isAnyDialogOpen() || isAnyMenuOpen()

			if (!ignore && event.target instanceof HTMLElement) {
				const bounds = event.target.getBoundingClientRect()

				ignore = isScrollbarPress(event.clientX - bounds.left, event.clientY - bounds.top, event.target)
			}

			press = { x: event.clientX, y: event.clientY, ignore }
		}

		function onPointerMove(event: PointerEvent): void {
			if (press && !press.ignore && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= DRAG_THRESHOLD_PX) {
				press.ignore = true
			}
		}

		// The browser took the pointer over (a native drag, a touch pan) — no click follows it.
		function onPointerCancel(): void {
			if (press) {
				press.ignore = true
			}
		}

		function onClick(event: MouseEvent): void {
			const current = press

			press = null

			if (!current || current.ignore || !isPlainPointerClick(event)) {
				return
			}

			if (isKeepSelectionTarget(event.target, document.getElementById("root"))) {
				return
			}

			clearRef.current()
		}

		window.addEventListener("pointerdown", onPointerDown, true)
		window.addEventListener("pointermove", onPointerMove, true)
		window.addEventListener("pointercancel", onPointerCancel, true)
		window.addEventListener("click", onClick, true)

		return () => {
			window.removeEventListener("pointerdown", onPointerDown, true)
			window.removeEventListener("pointermove", onPointerMove, true)
			window.removeEventListener("pointercancel", onPointerCancel, true)
			window.removeEventListener("click", onClick, true)
		}
	}, [active])
}
