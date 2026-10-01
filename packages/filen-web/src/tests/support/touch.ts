import { vi } from "vitest"
import { act, fireEvent } from "@testing-library/react"
import { LONG_PRESS_DELAY_MS } from "@/lib/useTouchLongPress"

// A finger landing, as a browser reports it: a touch pointerdown, then the touchstart Base UI's own
// long-press runs off.
function touchDown(target: Element): void {
	fireEvent.pointerDown(target, { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: 5, clientY: 5, button: 0 })
	fireEvent.touchStart(target, { touches: [{ clientX: 5, clientY: 5 }] })
}

function touchUp(target: Element): void {
	fireEvent.pointerUp(target, { pointerType: "touch", pointerId: 1 })
	fireEvent.touchEnd(target)
}

// A tap. The click carries no pointer type of its own, as on browsers that still dispatch a MouseEvent.
// False when the click was preventDefaulted (for a link: it did not navigate).
export function touchTap(target: Element): boolean {
	touchDown(target)
	touchUp(target)

	return fireEvent.click(target, { detail: 1 })
}

// A held touch, ending in the click some browsers still dispatch on lift (its result as touchTap's).
// Needs fake timers.
export function touchLongPress(target: Element): boolean {
	touchDown(target)
	act(() => {
		vi.advanceTimersByTime(LONG_PRESS_DELAY_MS)
	})
	touchUp(target)

	return fireEvent.click(target, { detail: 1 })
}
