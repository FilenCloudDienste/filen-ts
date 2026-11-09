import type { Transition } from "../../../core/anim/model"
import { isInstantCut } from "../../../core/anim/presets/transitions/catalog"
import { transitionFrame, type SlideMotion } from "../../../core/anim/transitions"
import { clipPathCss, polygonsOf } from "./filters"

// A slide transition as CSS on the two slide boxes (each the slide's size at slide px, scaled with the stage): the
// ECMA-376 progress functions of core/anim/transitions.ts at progress p, the incoming slide moved, faded and clipped
// to the revealed region, the outgoing one moved and faded, black between them (thruBlk). Transforms, opacity and
// clip-path only, so frames are composited, never repainted from the slide's content.

// p:transition spd (and the ODP transition speed): PowerPoint's durations.
export const TRANSITION_SPEED_MS: Readonly<Record<"slow" | "med" | "fast", number>> = { slow: 1000, med: 750, fast: 500 }

export interface SlideBoxStyle {
	readonly transform: string
	readonly opacity: number
	// "" for none.
	readonly clipPath: string
}

export interface TransitionStyles {
	readonly incoming: SlideBoxStyle
	readonly outgoing: SlideBoxStyle
	// Opacity of the overlay over the outgoing slide.
	readonly black: number
	// The overlay's CSS colour (black; white for flash).
	readonly overlay: string
	readonly outgoingOnTop: boolean
}

// The frame of an instant cut never changes, so it plays in no time: the timeline begins at once.
export function transitionDurationMs(transition: Transition): number {
	if (isInstantCut(transition)) return 0
	if (transition.durationMs !== undefined && Number.isFinite(transition.durationMs)) return Math.max(0, transition.durationMs)

	return TRANSITION_SPEED_MS[transition.speed ?? "fast"]
}

function motion(m: SlideMotion, w: number, h: number): string {
	const parts: string[] = []

	if (m.dx !== 0 || m.dy !== 0) parts.push(`translate(${String(m.dx * w)}px,${String(m.dy * h)}px)`)
	if (m.rotation !== 0) parts.push(`rotate(${String(m.rotation)}deg)`)
	if (m.scale !== 1) parts.push(`scale(${String(m.scale)})`)

	return parts.join(" ")
}

export function transitionStyles(
	transition: Transition,
	progress: number,
	slide: { readonly w: number; readonly h: number }
): TransitionStyles {
	const frame = transitionFrame(transition.kind, transition.options, progress)
	const reveal = polygonsOf(frame.reveal)

	return {
		incoming: {
			transform: motion(frame.incoming, slide.w, slide.h),
			opacity: frame.incoming.opacity,
			clipPath: reveal === undefined ? "" : clipPathCss(reveal, { x: 0, y: 0, w: slide.w, h: slide.h })
		},
		outgoing: { transform: motion(frame.outgoing, slide.w, slide.h), opacity: frame.outgoing.opacity, clipPath: "" },
		black: frame.black,
		overlay: frame.overlay,
		outgoingOnTop: frame.outgoingOnTop
	}
}
