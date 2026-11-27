import { createContext } from "react"

// What the OS's next/previous track keys do while a previewed video or audio file holds the Media Session: the
// overlay's pager steps (or a running slideshow's), null where there is nowhere to go or stepping is held off.
export interface PreviewMediaPager {
	readonly next: (() => void) | null
	readonly previous: (() => void) | null
}

export const NO_MEDIA_PAGER: PreviewMediaPager = { next: null, previous: null }

export const PreviewMediaPagerContext = createContext<PreviewMediaPager>(NO_MEDIA_PAGER)
