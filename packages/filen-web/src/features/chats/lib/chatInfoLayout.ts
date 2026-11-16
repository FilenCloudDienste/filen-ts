import { useSyncExternalStore } from "react"
import { mediaQueryStore } from "@/features/shell/lib/breakpoints"

// From this width the chat info panel sits beside the thread; below it the panel is a sheet from the right. Wide
// enough for the icon rail, a default-width sidebar, a readable thread and the 20rem panel side by side.
export const CHAT_INFO_INLINE_QUERY = "(min-width: 68.75rem)"

const chatInfoInline = mediaQueryStore(CHAT_INFO_INLINE_QUERY)

export function isChatInfoNarrow(): boolean {
	return !chatInfoInline.matches()
}

export function subscribeToChatInfoBreakpoint(listener: () => void): () => void {
	return chatInfoInline.subscribe(listener)
}

// Wide when there is no matchMedia to ask (a non-browser render), as useIsNarrowViewport reads it.
export function useIsChatInfoNarrow(): boolean {
	return useSyncExternalStore(subscribeToChatInfoBreakpoint, isChatInfoNarrow, () => false)
}
