// Spring-loaded directories (Finder's name): a drag that rests on a directory it could drop into opens it
// after a delay, and keeps going there. The timing lives here, in one place.

// How long a drag rests on a listing directory (row, tile, breadcrumb crumb) before it opens.
export const SPRING_LOAD_DELAY_MS = 2000

// Finder's blink just before the open: the drop highlight goes off and back on this many times, one
// phase each way, the last "on" ending exactly at the open. The phase is capped so a short delay still
// spends most of itself resting.
export const SPRING_LOAD_BLINK_FLASHES = 2
export const SPRING_LOAD_BLINK_PHASE_MS = Math.min(100, Math.floor(SPRING_LOAD_DELAY_MS / (4 * SPRING_LOAD_BLINK_FLASHES)))

// The sidebar tree's hover-expand. It only discloses a level, nothing navigates, so it stays quick and
// doesn't blink; it runs on the same single timer below.
export const TREE_HOVER_EXPAND_MS = 700

// Set on the armed element: "off" while a blink phase hides its highlight, "on" while it shows (index.css).
export const SPRING_BLINK_ATTRIBUTE = "data-spring-blink"

export interface SpringTiming {
	delayMs: number
	blink: boolean
}

export const LISTING_SPRING: SpringTiming = { delayMs: SPRING_LOAD_DELAY_MS, blink: true }
export const TREE_EXPAND_SPRING: SpringTiming = { delayMs: TREE_HOVER_EXPAND_MS, blink: false }

// When each blink phase starts, relative to arming, and which way it turns the highlight. Empty when the
// timing doesn't blink or the user prefers reduced motion: then the target just opens after the delay.
export function springBlinkSchedule(timing: SpringTiming, reducedMotion: boolean): { atMs: number; state: "off" | "on" }[] {
	if (!timing.blink || reducedMotion) {
		return []
	}

	const phases = 2 * SPRING_LOAD_BLINK_FLASHES
	const start = timing.delayMs - phases * SPRING_LOAD_BLINK_PHASE_MS

	return Array.from({ length: phases }, (_, index) => ({
		atMs: start + index * SPRING_LOAD_BLINK_PHASE_MS,
		state: index % 2 === 0 ? ("off" as const) : ("on" as const)
	}))
}

function prefersReducedMotion(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

interface Armed {
	owner: object
	element: HTMLElement
	timer: ReturnType<typeof setTimeout>
}

// ONE armed target for the whole page, and one pending timeout for it: arming another target disarms
// the first, and each blink phase schedules the next rather than all of them up front.
let armed: Armed | null = null

function disarm(): void {
	if (armed === null) {
		return
	}

	clearTimeout(armed.timer)
	armed.element.removeAttribute(SPRING_BLINK_ATTRIBUTE)
	armed = null
	window.removeEventListener("drop", disarm, true)
	window.removeEventListener("dragend", disarm, true)
	window.removeEventListener("keydown", disarmOnEscape, true)
}

function disarmOnEscape(event: KeyboardEvent): void {
	if (event.key === "Escape") {
		disarm()
	}
}

// Arms `element` for `owner` (a drop target's own identity): after the timing's delay, blinking first
// when it does, `open` runs. Arming the target already armed keeps its timer running; arming another
// restarts. A drop or the drag ending anywhere, or Escape, disarms.
export function armSpringLoad(owner: object, element: HTMLElement, timing: SpringTiming, open: () => void): void {
	if (armed?.owner === owner && armed.element === element) {
		return
	}

	disarm()

	const steps = springBlinkSchedule(timing, prefersReducedMotion())
	let elapsed = 0

	function next(index: number): void {
		const step = steps[index]
		const atMs = step === undefined ? timing.delayMs : step.atMs
		const timer = setTimeout(() => {
			elapsed = atMs

			if (step === undefined) {
				disarm()
				open()

				return
			}

			element.setAttribute(SPRING_BLINK_ATTRIBUTE, step.state)
			next(index + 1)
		}, atMs - elapsed)

		if (armed !== null) {
			armed.timer = timer
		} else {
			armed = { owner, element, timer }
		}
	}

	next(0)
	window.addEventListener("drop", disarm, true)
	window.addEventListener("dragend", disarm, true)
	window.addEventListener("keydown", disarmOnEscape, true)
}

// Disarms, but only the target `owner` armed: another target's timer is left running.
export function cancelSpringLoad(owner: object): void {
	if (armed?.owner === owner) {
		disarm()
	}
}
