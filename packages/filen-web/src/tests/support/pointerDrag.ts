import { vi } from "vitest"
import { act } from "@testing-library/react"
import { getDragPayload } from "@/features/drive/lib/dnd"
import { cancelPointerDrag, pressPointerDrag } from "@/features/drive/lib/pointerDrag"

// Drives the pointer drag engine (pointerDrag.ts) in jsdom, which lays nothing out: the element under the
// pointer is whatever the test last pointed at, and frames run when the test says so. Needs fake
// animation frames (FAKE_FRAMES); jsdom's off-macOS copy modifier is Ctrl.

export const FAKE_FRAMES = ["requestAnimationFrame", "cancelAnimationFrame"] as const
export const FAKE_FRAMES_AND_TIMEOUTS = [...FAKE_FRAMES, "setTimeout", "clearTimeout"] as const

let pointed: Element | null = null

export function stubHitTest(): void {
	pointed = null
	document.elementFromPoint = () => pointed
}

// A primary mouse press at (10, 10), on a drag source element (through its React onPointerDown).
export function pressOn(element: Element, pointerType = "mouse"): void {
	act(() => {
		element.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				cancelable: true,
				pointerId: 1,
				pointerType,
				button: 0,
				isPrimary: true,
				clientX: 10,
				clientY: 10
			})
		)
	})
}

// A drag of whatever the test put in the payload, from no source element.
export function beginDrag(): void {
	act(() => {
		pressPointerDrag(
			{ pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true, clientX: 10, clientY: 10, altKey: false, ctrlKey: false },
			{ start: getDragPayload, chip: () => null, end: () => undefined }
		)
	})
	moveOver(null)
}

// Moves the held pointer over `element` (null: over nothing) and runs the frame that hit-tests it.
export function moveOver(element: Element | null, copy = false): void {
	pointed = element
	act(() => {
		window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 30, clientY: 30, buttons: 1, ctrlKey: copy }))
		vi.advanceTimersToNextFrame()
	})
}

// Lets go over `element`.
export function releaseOver(element: Element | null, copy = false): void {
	pointed = element
	act(() => {
		window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 30, clientY: 30, buttons: 0, ctrlKey: copy }))
	})
}

export function pressEscape(): void {
	act(() => {
		document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
	})
}

export function endDrag(): void {
	act(() => {
		cancelPointerDrag()
	})
}
