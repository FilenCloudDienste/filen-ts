// Mouse wheel navigation of a browsed show: one step forward (wheel down) or back (wheel up) per wheel gesture, as
// PowerPoint's window moves a slide per turn. A gesture is a run of wheel events with no gap over QUIET_MS between
// them, so a trackpad's flick and its momentum tail move one slide, not dozens; turning the other way within a
// gesture steps the other way once. Horizontal scrolls are not steps.

// Longest gap between two events of one gesture.
export const WHEEL_QUIET_MS = 150

// How far a gesture scrolls before it steps (filters a trackpad's touch noise), CSS px.
export const WHEEL_STEP_PX = 4

// WheelEvent.deltaMode: DOM_DELTA_LINE and DOM_DELTA_PAGE, as px.
const LINE_PX = 40
const PAGE_PX = 800

export interface WheelInput {
	readonly deltaX: number
	readonly deltaY: number
	readonly deltaMode: number
	// WheelEvent.timeStamp, ms.
	readonly timeStamp: number
}

export class WheelSteps {
	private last = -Infinity
	private sum = 0
	private stepped = false

	// 1: next, -1: previous, 0: no step.
	take(event: WheelInput): -1 | 0 | 1 {
		const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? PAGE_PX : 1
		const delta = event.deltaY * unit

		if (event.timeStamp - this.last > WHEEL_QUIET_MS) {
			this.sum = 0
			this.stepped = false
		}

		this.last = event.timeStamp

		if (delta === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return 0

		// The other way: a new step that way.
		if (this.sum !== 0 && Math.sign(this.sum) !== Math.sign(delta)) {
			this.sum = 0
			this.stepped = false
		}

		this.sum += delta

		if (this.stepped || Math.abs(this.sum) < WHEEL_STEP_PX) return 0

		this.stepped = true

		return this.sum > 0 ? 1 : -1
	}
}
