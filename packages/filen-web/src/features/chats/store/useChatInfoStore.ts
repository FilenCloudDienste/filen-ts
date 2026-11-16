import { create } from "zustand"
import { isChatInfoNarrow } from "@/features/chats/lib/chatInfoLayout"

// Mounted at most once (inline beside the thread, or in the sheet), so fixed ids are unique.
export const CHAT_INFO_PANEL_ID = "chat-info-panel"
export const CHAT_INFO_TITLE_ID = "chat-info-panel-title"
export const CHAT_INFO_TOGGLE_ID = "chat-info-toggle"

interface ChatInfoState {
	// The inline panel, from the chat info breakpoint up: one flag for the whole session, so it stays open from one
	// conversation to the next. In memory only, never persisted.
	panelOpen: boolean
	// The sheet below the breakpoint: the conversation it was opened for, so it never reopens over another one.
	drawerChatUuid: string | null
	// The conversation whose inline panel should take focus when it mounts: set when the user opens a panel not yet on
	// screen, and cleared by the next panel to mount whichever conversation it is for, so it can never fire later.
	focusRequestedFor: string | null
}

export const useChatInfoStore = create<ChatInfoState>(() => ({ panelOpen: false, drawerChatUuid: null, focusRequestedFor: null }))

// Opens the panel (or, below the breakpoint, the sheet) for a conversation. The caller opens the conversation itself.
export function openChatInfo(chatUuid: string): void {
	if (isChatInfoNarrow()) {
		useChatInfoStore.setState({ drawerChatUuid: chatUuid })

		return
	}

	// Already showing for this conversation: nothing will mount, so focus moves now.
	const panel = document.getElementById(CHAT_INFO_PANEL_ID)

	if (useChatInfoStore.getState().panelOpen && panel?.dataset["chatUuid"] === chatUuid) {
		panel.focus()

		return
	}

	useChatInfoStore.setState({ panelOpen: true, focusRequestedFor: chatUuid })
}

export function closeChatInfoPanel(): void {
	useChatInfoStore.setState({ panelOpen: false, focusRequestedFor: null })
}

export function closeChatInfoDrawer(): void {
	if (useChatInfoStore.getState().drawerChatUuid !== null) {
		useChatInfoStore.setState({ drawerChatUuid: null })
	}
}

// Whether the panel now mounting for this conversation should take focus; consumes any request either way.
export function takeChatInfoFocusRequest(chatUuid: string | undefined): boolean {
	const requested = useChatInfoStore.getState().focusRequestedFor

	if (requested === null) {
		return false
	}

	useChatInfoStore.setState({ focusRequestedFor: null })

	return requested === chatUuid
}

// Whether the chat info surface for this conversation is showing at the current width.
export function useChatInfoOpen(chatUuid: string, narrow: boolean): boolean {
	return useChatInfoStore(state => (narrow ? state.drawerChatUuid === chatUuid : state.panelOpen))
}
