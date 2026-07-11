import { create } from "zustand"

// Per-chat RECEIVE-side typing state — a port of filen-mobile's useChatsStore typing slice
// (features/chats/store/useChats.store.ts setTyping). Keyed by chatUuid → the list of remote users
// currently typing in that chat. senderId is stored as BIGINT (coerced from the wasm event's `number`
// senderId at the socket seam) so self-exclusion compares to the bigint account id without re-coercing.
export interface ChatTypingUser {
	senderId: bigint
	senderEmail: string
	senderNickName: string
	senderAvatar: string | undefined
	timestamp: bigint
}

export type ChatTypingState = Record<string, ChatTypingUser[]>

export interface ChatTypingStore {
	typing: ChatTypingState
	setTyping: (fn: ChatTypingState | ((prev: ChatTypingState) => ChatTypingState)) => void
}

export const useChatTypingStore = create<ChatTypingStore>(set => ({
	typing: {},
	setTyping(fn) {
		set(state => ({ typing: typeof fn === "function" ? fn(state.typing) : fn }))
	}
}))

export default useChatTypingStore
