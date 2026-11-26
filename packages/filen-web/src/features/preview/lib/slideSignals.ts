import { createContext } from "react"

// What the viewers under a running slideshow tell it, beyond being shown (ImageShownContext).
export interface SlideSignals {
	readonly active: true
	// A video ended or failed, or an animated image finished its first loop.
	mediaEnded: () => void
	// The animated player took over from the still: the slide waits for its first loop.
	animating: () => void
}

// Null outside a running slideshow: the viewers loop and repeat as they always do.
export const SlideSignalsContext = createContext<SlideSignals | null>(null)
