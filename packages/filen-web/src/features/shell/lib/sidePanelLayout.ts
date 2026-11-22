import { useSyncExternalStore } from "react"
import { contentRoomWidth, SHELL_ROW_GAP_PX, subscribeToContentRoom } from "@/features/shell/lib/contentRoom"

// The inline side panel's width (DockedSidePanel's w-80): the chat info panel and the note participants panel.
export const SIDE_PANEL_WIDTH_PX = 320

// The narrowest the content card may get with a panel beside it. A message row needs its avatar gutter, a line of
// readable text and the floating action bar (about 150px) over its right corner; the composer needs its attach button,
// a field long enough to type in and its send button; 560px keeps both at roughly 60 characters of text, and is still
// under what a 1280px window leaves the card with the icon rail and a default-width sidebar. A note editor fits the
// same budget. Below it the panel is the sheet, so the panel never squeezes the card, nor pushes the assistant (whose
// own cap keeps the same promise) past the window's edge.
export const SIDE_PANEL_MIN_CARD_WIDTH_PX = 560

const INLINE_ROOM_PX = SIDE_PANEL_MIN_CARD_WIDTH_PX + SHELL_ROW_GAP_PX + SIDE_PANEL_WIDTH_PX

// The room the shell leaves (contentRoom.ts), not the viewport: the sidebar's and the assistant's widths count. Also
// true outside the shell, where nothing is measured.
export function isSidePanelNarrow(): boolean {
	return contentRoomWidth() < INLINE_ROOM_PX
}

// Fires only when the answer flips, not on every resize.
export function subscribeToSidePanelBreakpoint(listener: () => void): () => void {
	let narrow = isSidePanelNarrow()

	return subscribeToContentRoom(() => {
		const next = isSidePanelNarrow()

		if (next !== narrow) {
			narrow = next
			listener()
		}
	})
}

export function useIsSidePanelNarrow(): boolean {
	return useSyncExternalStore(subscribeToSidePanelBreakpoint, isSidePanelNarrow, () => false)
}
