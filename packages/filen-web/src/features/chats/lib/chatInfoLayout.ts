import { useSyncExternalStore } from "react"
import { contentRoomWidth, SHELL_ROW_GAP_PX, subscribeToContentRoom } from "@/features/shell/lib/contentRoom"

// The inline panel's width (chatInfoPanel.tsx's w-80).
export const CHAT_INFO_PANEL_WIDTH_PX = 320

// The narrowest the thread card may get with the panel beside it. A message row needs its avatar gutter, a line of
// readable text and the floating action bar (about 150px) over its right corner; the composer needs its attach button,
// a field long enough to type in and its send button; 560px keeps both at roughly 60 characters of text, and is still
// under what a 1280px window leaves the card with the icon rail and a default-width sidebar. Below it the panel is the
// sheet, so the panel never squeezes the card, nor pushes the assistant (whose own cap keeps the same promise) past the
// window's edge.
export const CHAT_INFO_MIN_THREAD_WIDTH_PX = 560

const INLINE_ROOM_PX = CHAT_INFO_MIN_THREAD_WIDTH_PX + SHELL_ROW_GAP_PX + CHAT_INFO_PANEL_WIDTH_PX

// The room the shell leaves (contentRoom.ts), not the viewport: the sidebar's and the assistant's widths count. Also
// true outside the shell, where nothing is measured.
export function isChatInfoNarrow(): boolean {
	return contentRoomWidth() < INLINE_ROOM_PX
}

// Fires only when the answer flips, not on every resize.
export function subscribeToChatInfoBreakpoint(listener: () => void): () => void {
	let narrow = isChatInfoNarrow()

	return subscribeToContentRoom(() => {
		const next = isChatInfoNarrow()

		if (next !== narrow) {
			narrow = next
			listener()
		}
	})
}

export function useIsChatInfoNarrow(): boolean {
	return useSyncExternalStore(subscribeToChatInfoBreakpoint, isChatInfoNarrow, () => false)
}
