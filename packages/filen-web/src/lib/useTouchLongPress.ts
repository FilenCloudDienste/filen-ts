import { useEffect, useRef, type DragEvent, type MouseEvent, type PointerEvent, type TouchEvent } from "react"
import { clickPointerType } from "@/features/drive/lib/listbox"

// Base UI's ContextMenuTrigger long-press delay and move threshold: the press this replaces on touch.
export const LONG_PRESS_DELAY_MS = 500
const LONG_PRESS_SLOP_PX = 10

// Present on events dispatched through a Base UI element's merged props (every caller but the contacts
// rows, which sit under no ContextMenuTrigger).
interface BaseUIPreventable {
	preventBaseUIHandler?: () => void
}

interface Press {
	pointerId: number
	x: number
	y: number
	timer: ReturnType<typeof setTimeout>
}

export interface UseTouchLongPressParams<E extends HTMLElement> {
	onLongPress: () => void
	// The element's own context-menu handler, for a mouse or pen right-click. A touch never reaches it.
	onContextMenu?: (event: MouseEvent<E>) => void
}

export interface TouchLongPressHandlers<E extends HTMLElement> {
	onPointerDown: (event: PointerEvent<E>) => void
	onPointerMove: (event: PointerEvent<E>) => void
	onPointerUp: () => void
	onPointerCancel: () => void
	onTouchStart: (event: TouchEvent<E> & BaseUIPreventable) => void
	onContextMenu: (event: MouseEvent<E> & BaseUIPreventable) => void
	onClickCapture: (event: MouseEvent<E>) => void
	onDragStartCapture: (event: DragEvent<E>) => void
}

export interface TouchLongPress<E extends HTMLElement> {
	// Spread onto the list item, which for a ContextMenuTrigger is its render element: Base UI merges
	// those props to the right of the trigger's own, so these handlers run first and can decline its.
	handlers: TouchLongPressHandlers<E>
	// The pointer behind a click or double click on the item (or on a Link inside it).
	pointerType: (event: MouseEvent) => string
}

// A long-press presses a button in its own right; anything else on the item starts one.
function startsPress(event: PointerEvent<HTMLElement>): boolean {
	const target = event.target

	return target instanceof Element && event.currentTarget.contains(target) && target.closest("button") === null
}

// A light tick on the long-press where the platform has one. Chrome ignores vibrate before the page's
// first activation and logs an intervention for it, so it is skipped until then.
function longPressHaptic(): void {
	if ("vibrate" in navigator && navigator.userActivation.hasBeenActive) {
		navigator.vibrate(10)
	}
}

// The touch half of the click-to-select lists: a held touch selects (onLongPress) where a mouse would
// right-click, and the context menu stays mouse-only. One timer per press, started only for a touch;
// a move past the slop, a lift or the browser taking the pointer over for a scroll (pointercancel)
// ends it, so a scroll never selects. The click a long-press may still produce on lift is swallowed —
// for a Link row that is the navigation too.
export function useTouchLongPress<E extends HTMLElement>({ onLongPress, onContextMenu }: UseTouchLongPressParams<E>): TouchLongPress<E> {
	const pressRef = useRef<Press | null>(null)
	// The long-press fired and its gesture has not ended in a click yet (the next press resets it).
	const firedRef = useRef(false)
	// The type of the last pointer pressed on the item. Pointerdown reports it reliably everywhere, the
	// click that follows does not.
	const pointerTypeRef = useRef("")

	useEffect(() => {
		return () => {
			const press = pressRef.current

			if (press !== null) {
				clearTimeout(press.timer)
			}
		}
	}, [])

	function cancel(): void {
		const press = pressRef.current

		if (press !== null) {
			clearTimeout(press.timer)
			pressRef.current = null
		}
	}

	function fire(): void {
		cancel()
		firedRef.current = true
		longPressHaptic()
		onLongPress()
	}

	// A context menu event the touch press raised: Chrome reports its pointer type, otherwise it is one
	// arriving while the press is still held or right after it fired.
	function isTouchContextMenu(event: MouseEvent<E>): boolean {
		const own = clickPointerType(event.nativeEvent)

		if (own !== "") {
			return own === "touch"
		}

		return pressRef.current !== null || firedRef.current
	}

	const handlers: TouchLongPressHandlers<E> = {
		onPointerDown: event => {
			cancel()
			pointerTypeRef.current = event.pointerType
			firedRef.current = false

			if (event.pointerType !== "touch" || !event.isPrimary || !startsPress(event)) {
				return
			}

			pressRef.current = {
				pointerId: event.pointerId,
				x: event.clientX,
				y: event.clientY,
				timer: setTimeout(fire, LONG_PRESS_DELAY_MS)
			}
		},
		onPointerMove: event => {
			const press = pressRef.current

			if (
				press !== null &&
				event.pointerId === press.pointerId &&
				(Math.abs(event.clientX - press.x) > LONG_PRESS_SLOP_PX || Math.abs(event.clientY - press.y) > LONG_PRESS_SLOP_PX)
			) {
				cancel()
			}
		},
		onPointerUp: cancel,
		onPointerCancel: cancel,
		// Base UI's own touch timer would open the context menu. Its propagation stop is kept, so an
		// enclosing trigger (the listing's empty-space menu) still never sees an item's touch.
		onTouchStart: event => {
			event.preventBaseUIHandler?.()
			event.stopPropagation()
		},
		// Android Chrome raises contextmenu for a held touch at about the same delay: the platform's own
		// long-press, taken as this one if the timer has not fired yet. iOS Safari raises none; the timer
		// covers it there.
		onContextMenu: event => {
			if (!isTouchContextMenu(event)) {
				onContextMenu?.(event)

				return
			}

			event.preventBaseUIHandler?.()
			event.preventDefault()
			event.stopPropagation()

			if (pressRef.current !== null) {
				fire()
			}
		},
		onClickCapture: event => {
			if (!firedRef.current) {
				return
			}

			firedRef.current = false
			event.preventDefault()
			event.stopPropagation()
		},
		// A held touch selects; it does not start a native drag of a draggable item as well.
		onDragStartCapture: event => {
			if (pointerTypeRef.current === "touch") {
				event.preventDefault()
				event.stopPropagation()
			}
		}
	}

	function pointerType(event: MouseEvent): string {
		// A keyboard or scripted click (detail 0) had no press behind it.
		if (event.detail > 0 && pointerTypeRef.current !== "") {
			return pointerTypeRef.current
		}

		return clickPointerType(event.nativeEvent)
	}

	return { handlers, pointerType }
}
