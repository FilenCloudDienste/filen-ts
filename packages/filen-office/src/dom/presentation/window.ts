import type { SlideRef } from "../../core/presentation/model"
import type { SlideRender } from "../../core/presentation/output"
import type { CallSignal, EngineSession, MethodHandler, PresentationScheduler } from "./engine"
import type { PresentationOpenOptions } from "./protocol"

// The open window (PresentationOpenOptions.window): the slides around the one the page shows, rendered right after
// "opened" in the priority lane and sent one per "slides" event, the shown slide first, so it paints without waiting
// for its neighbours. The last event is `final`. Slides outside the window are rendered when the page asks for them.

// Slides streamed at most (the page keeps a window of renders, not the deck).
export const MAX_OPEN_WINDOW = 64

// The refs a window names, in the order they are sent: `from` (clamped into the deck) first, then the ones after it.
export function openWindowRefs(slides: readonly SlideRef[], window: NonNullable<PresentationOpenOptions["window"]>): SlideRef[] {
	if (slides.length === 0 || !(window.count >= 1)) return []

	const from = Math.min(slides.length - 1, Math.max(0, Math.trunc(window.from)))
	const last = Math.min(slides.length, from + Math.min(MAX_OPEN_WINDOW, Math.trunc(window.count)))

	return slides.slice(from, last)
}

// `signal` is the session's: closing the deck stops the stream.
export function streamOpenWindow(
	session: EngineSession,
	window: NonNullable<PresentationOpenOptions["window"]>,
	render: MethodHandler<"render">,
	scheduler: PresentationScheduler,
	signal: CallSignal
): void {
	const refs = openWindowRefs(session.deck.slides, window)

	if (refs.length === 0) {
		session.emit({ type: "slides", renders: [], final: true })

		return
	}

	scheduler.schedule(
		"priority",
		async slicing => {
			for (let at = 0; at < refs.length; at++) {
				if (signal.aborted) return

				const ref = refs[at] as SlideRef
				let renders: readonly SlideRender[] = []

				try {
					// With the editor's prompts when the open carries them (an editable deck: view.ts editorPrompts).
					renders = await render({ session, signal, lane: "priority", slicing }, [ref], { prompts: true })
				} catch {
					// A slide that cannot be rendered is left to the page's own request (which gets the typed refusal).
				}

				if (signal.aborted) return

				session.emit({ type: "slides", renders, final: at === refs.length - 1 })
			}
		},
		signal
	)
}
