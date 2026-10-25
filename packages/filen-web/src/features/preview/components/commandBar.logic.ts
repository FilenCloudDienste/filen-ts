import { useEffect } from "react"
import { toggleFullscreen } from "@/lib/media/fullscreen"

// ribbonFit's width estimates for the document viewers' command bars (commandBarControls.tsx): an icon button with
// its gap, a dropdown button, the page number field with its total, the zoom menu's button.
export const BAR_BUTTON = 30
export const BAR_MENU = 44
const PAGE_FIELD = 92
const ZOOM_MENU = 70

export type ZoomFit = "fitWidth" | "fitPage"

// `ends`: with first and last.
export function pageControlsWidth(ends: boolean): number {
	return PAGE_FIELD + (ends ? 4 : 2) * BAR_BUTTON
}

export const ZOOM_CONTROLS_WIDTH = 2 * BAR_BUTTON + ZOOM_MENU

// The page number field's value as a page to go to, or null for nothing usable (empty, not a number).
export function typedPage(text: string, total: number): number | null {
	const typed = Number.parseInt(text, 10)

	return Number.isFinite(typed) && total > 0 ? Math.min(Math.max(1, typed), total) : null
}

// Full screen is the whole page's (the document's root): menus, tooltips and dialogs portal to the body and would
// not show over a fullscreened element of their own. Left again once no document viewer is open: paging from one to
// the next keeps it (the next mounts in the same commit), closing the preview or paging to a photo leaves it.
let entered = false
let viewers = 0

export function toggleViewerFullScreen(): Promise<void> {
	entered = document.fullscreenElement !== document.documentElement

	return toggleFullscreen(document.documentElement)
}

// In every document viewer, from its first render (before its file has loaded).
export function useLeaveViewerFullScreen(): void {
	useEffect(() => {
		viewers++

		return () => {
			viewers--
			queueMicrotask(() => {
				if (viewers === 0 && entered && document.fullscreenElement === document.documentElement) {
					entered = false
					document.exitFullscreen().catch(() => {
						// Already left (Escape) by the time this ran.
					})
				}
			})
		}
	}, [])
}
