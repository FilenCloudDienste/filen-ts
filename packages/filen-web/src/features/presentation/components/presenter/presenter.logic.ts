import type { SlideRef } from "@filen/office/core/presentation"
import type { ShowEvent, ShowScreen } from "@filen/office/react/presentation"

// Where the show is, as its controller's events tell it: what the presenter view, the stage's ink layer and the keys
// (erase the slide's ink) read.
export interface PresenterPosition {
	readonly index: number
	readonly slide: SlideRef | undefined
	readonly step: number
	readonly steps: number
	readonly screen: ShowScreen
	readonly ended: boolean
	// The deck index the show goes to after this slide, when the player says ("end" after the last one).
	readonly next: number | "end" | undefined
}

export const PRESENTER_START: PresenterPosition = {
	index: 0,
	slide: undefined,
	step: 0,
	steps: 0,
	screen: "slide",
	ended: false,
	next: undefined
}

// The player's next slide on a "slide" event, where it tells it.
function nextOf(event: Extract<ShowEvent, { type: "slide" }>): number | "end" | undefined {
	const next: unknown = Reflect.get(event, "next")

	return typeof next === "number" ? next : next === null ? "end" : undefined
}

export function presenterReduce(position: PresenterPosition, event: ShowEvent): PresenterPosition {
	switch (event.type) {
		case "slide":
			return {
				...position,
				index: event.index,
				slide: event.slide,
				step: event.step,
				steps: event.steps,
				screen: "slide",
				next: nextOf(event)
			}
		case "step":
			return event.index === position.index ? { ...position, step: event.step } : position
		case "screen":
			return position.screen === event.screen ? position : { ...position, screen: event.screen }
		case "ended":
			return { ...position, ended: true }
		case "notice":
			return position
	}
}

// What the presenter view shows as "next": an animation still to play on this slide, the next slide the show goes to
// (hidden slides skipped, or the custom show's order when it runs one), or the end.
export type PresenterNext = { readonly kind: "step" } | { readonly kind: "slide"; readonly index: number } | { readonly kind: "end" }

export function presenterNext(
	position: PresenterPosition,
	slides: readonly { readonly ref: SlideRef; readonly hidden: boolean }[],
	sequence?: readonly number[]
): PresenterNext {
	if (position.step < position.steps) return { kind: "step" }

	if (position.next === "end") return { kind: "end" }

	if (position.next !== undefined) return { kind: "slide", index: position.next }

	if (sequence !== undefined) {
		const at = sequence.indexOf(position.index)
		const after = at === -1 ? sequence.find(index => index > position.index) : sequence[at + 1]

		return after === undefined ? { kind: "end" } : { kind: "slide", index: after }
	}

	for (let index = position.index + 1; index < slides.length; index++)
		if (slides[index]?.hidden === false) return { kind: "slide", index }

	return { kind: "end" }
}

// Notes text sizes (CSS px) the presenter steps through.
export const NOTES_SIZES: readonly number[] = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48]
export const NOTES_DEFAULT_SIZE_INDEX = 3

// The scale that fits a slide of `slide` px inside `box` px.
export function fitScale(
	box: { readonly width: number; readonly height: number },
	slide: { readonly width: number; readonly height: number }
): number {
	if (box.width <= 0 || box.height <= 0 || slide.width <= 0 || slide.height <= 0) return 0

	return Math.min(box.width / slide.width, box.height / slide.height)
}
