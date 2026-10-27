// Touch on the stage: a horizontal swipe goes to the next slide (leftwards) or the previous one (rightwards), and the
// click a swipe ends in is swallowed so it does not advance as well. A tap stays a click (the stage's own: next,
// or a shape's trigger). Mouse and pen are left alone: they click, and the pen draws when the pen tool is on.

export interface SwipePointer {
	readonly pointerId: number
	readonly pointerType: string
	readonly clientX: number
	readonly clientY: number
	readonly timeStamp: number
	readonly isPrimary?: boolean
}

export interface SwipeOptions {
	readonly next: () => void
	readonly prev: () => void
	// Off while an ink tool takes the pointer.
	readonly enabled?: () => boolean
}

export interface ShowSwipe {
	onPointerDown(event: SwipePointer): void
	// Whether the pointer ended a swipe (the show went on or back).
	onPointerUp(event: SwipePointer): boolean
	onPointerCancel(event: SwipePointer): void
	// In the capture phase: swallows the click a swipe ended in; true when it did.
	onClickCapture(event: { preventDefault(): void; stopPropagation(): void }): boolean
}

// CSS px a finger travels for a swipe, and how much more horizontal than vertical it must be.
export const SWIPE_MIN_PX = 48
const SWIPE_RATIO = 1.5
const SWIPE_MAX_MS = 800

export function createShowSwipe(options: SwipeOptions): ShowSwipe {
	let start: { id: number; x: number; y: number; at: number } | undefined
	let swallow = false

	return {
		onPointerDown: event => {
			swallow = false

			if (event.pointerType !== "touch" || event.isPrimary === false || options.enabled?.() === false) {
				start = undefined

				return
			}

			start = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp }
		},
		onPointerUp: event => {
			const from = start

			start = undefined

			if (from === undefined || from.id !== event.pointerId) return false

			const dx = event.clientX - from.x
			const dy = event.clientY - from.y

			if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO || event.timeStamp - from.at > SWIPE_MAX_MS)
				return false

			swallow = true

			if (dx < 0) options.next()
			else options.prev()

			return true
		},
		onPointerCancel: () => {
			start = undefined
		},
		onClickCapture: event => {
			if (!swallow) return false

			swallow = false
			event.preventDefault()
			event.stopPropagation()

			return true
		}
	}
}
