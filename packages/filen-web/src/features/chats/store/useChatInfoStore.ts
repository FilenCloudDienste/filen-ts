import { create } from "zustand"
import { isChatInfoNarrow } from "@/features/chats/lib/chatInfoLayout"

interface ChatInfoState {
	// The inline panel, from the chat info breakpoint up: one flag for the whole session, so it stays open from one
	// conversation to the next. In memory only, never persisted.
	panelOpen: boolean
	// The sheet below the breakpoint: the conversation it was opened for, so it never reopens over another one.
	drawerChatUuid: string | null
	// Set when the user opens the inline panel; the panel takes focus once when it mounts.
	focusRequested: boolean
}

export const useChatInfoStore = create<ChatInfoState>(() => ({ panelOpen: false, drawerChatUuid: null, focusRequested: false }))

// Opens the panel (or, below the breakpoint, the sheet) for a conversation. The caller opens the conversation itself.
export function openChatInfo(chatUuid: string): void {
	if (isChatInfoNarrow()) {
		useChatInfoStore.setState({ drawerChatUuid: chatUuid })

		return
	}

	useChatInfoStore.setState({ panelOpen: true, focusRequested: true })
}

export function closeChatInfoPanel(): void {
	useChatInfoStore.setState({ panelOpen: false, focusRequested: false })
}

export function closeChatInfoDrawer(): void {
	if (useChatInfoStore.getState().drawerChatUuid !== null) {
		useChatInfoStore.setState({ drawerChatUuid: null })
	}
}

export function takeChatInfoFocusRequest(): boolean {
	if (!useChatInfoStore.getState().focusRequested) {
		return false
	}

	useChatInfoStore.setState({ focusRequested: false })

	return true
}

// Whether the chat info surface for this conversation is showing at the current width.
export function useChatInfoOpen(chatUuid: string, narrow: boolean): boolean {
	return useChatInfoStore(state => (narrow ? state.drawerChatUuid === chatUuid : state.panelOpen))
}
