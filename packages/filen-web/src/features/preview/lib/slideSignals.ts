import { createContext } from "react"
import type { ShownImage } from "@/features/preview/lib/imageDisplay"

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

// What a running slideshow hands the slot its current slide shows in (SlideshowSlot): one object per slide, so the
// signals of a slide already left reach nothing. `signals` is null for an item that is no slide (paged to by hand).
export interface SlideshowSlotValue {
	readonly shown: (image: ShownImage) => void
	readonly signals: SlideSignals | null
	// The grid's thumbnail, drawn under the slide until it shows.
	readonly placeholderUrl: string | null
	// Whether the slide is to be seen: it reported shown, or the show paused on it or it never showed in time (so its
	// error state is seen); with its subscription, for useSyncExternalStore.
	readonly visible: () => boolean
	readonly subscribe: (listener: () => void) => () => void
}
