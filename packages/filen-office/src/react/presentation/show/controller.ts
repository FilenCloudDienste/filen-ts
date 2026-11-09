import type { PresentationNotice } from "../../../dom/presentation/protocol"
import { refused, type Refused, type SlideRef } from "../../../core/presentation/model"

// The slideshow as the page drives it (the stage, the presenter view, keys, clickers and touch all go through one
// controller), and the presenter's window. The player (show/stage) implements the controller; the presenter view
// listens to it in its portal.

// "end": the black screen after the last slide ("End of slide show, click to exit."); the next advance ends the show.
export type ShowScreen = "slide" | "black" | "white" | "end"

export type ShowEvent =
	// The slide on stage and its main-sequence step (0 before the first click).
	| {
			readonly type: "slide"
			readonly index: number
			readonly slide: SlideRef
			readonly step: number
			readonly steps: number
			// The deck index the show goes to after this slide; null when this is the last; absent when the player does not say.
			readonly next?: number | null
	  }
	| { readonly type: "step"; readonly index: number; readonly step: number }
	| { readonly type: "screen"; readonly screen: ShowScreen }
	| { readonly type: "notice"; readonly notice: PresentationNotice }
	| { readonly type: "ended" }

export type ShowEventType = ShowEvent["type"]

export type ShowFrom = { readonly index: number } | { readonly slide: SlideRef } | { readonly customShow: number }

export type ShowStart = { readonly kind: "started" } | Refused

export interface ShowController {
	// From a slide by its index in the deck or its ref, or a custom show from its start; the first shown slide by
	// default.
	start(from?: ShowFrom): Promise<ShowStart>
	next(): void
	prev(): void
	goto(index: number): void
	// The first and last slide of the running sequence (custom show or visible slides).
	first?(): void
	last?(): void
	// The slide right after the current one in the deck, only when it is hidden (PowerPoint's H); else nothing.
	nextHidden?(): void
	// Black or white screen; again the same one returns to the slide.
	black(): void
	white(): void
	end(): void
	on<T extends ShowEventType>(type: T, listener: (event: Extract<ShowEvent, { type: T }>) => void): () => void
}

// The presenter view's window: a same-origin popup the presenter is portaled into, or the show's own window when the
// popup is blocked.
export interface PresenterWindowLike {
	readonly closed: boolean
	close(): void
	focus(): void
}

export type PresenterOpen = { readonly kind: "opened"; readonly window: PresenterWindowLike } | { readonly kind: "blocked" } | Refused

export interface PresenterPortal {
	// From a user activation (the click that starts the presenter view).
	open(): PresenterOpen
	close(): void
	readonly window: PresenterWindowLike | undefined
}

// A controller with no player behind it: start is refused as notImplemented, everything else does nothing.
export function unavailableShowController(): ShowController {
	const nothing = (): void => undefined

	return {
		start: () => Promise.resolve(refused("notImplemented", "show")),
		next: nothing,
		prev: nothing,
		goto: nothing,
		black: nothing,
		white: nothing,
		end: nothing,
		on: () => nothing
	}
}

// A portal with no presenter view behind it: open is refused as notImplemented.
export function unavailablePresenterPortal(): PresenterPortal {
	return {
		open: () => refused("notImplemented", "presenter"),
		close: () => undefined,
		window: undefined
	}
}
