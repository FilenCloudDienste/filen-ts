import { type Chat as SdkChat, type ChatMessage as SdkChatMessage } from "@filen/sdk-rs"
import { type Chat, type ChatMessage } from "@/types"
import type { ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"

// inflightId of a server message: it has no queued twin (the real id only matters for send sync).
export const NO_INFLIGHT_ID = ""

export function wrapChat(chat: SdkChat): Chat {
	return {
		...chat,
		undecryptable: chat.key === undefined
	}
}

export function wrapMessage(message: SdkChatMessage): ChatMessage {
	return {
		...message,
		undecryptable: message.inner.message === undefined
	}
}

export function withoutInflight(message: ChatMessage): ChatMessageWithInflightId {
	return {
		...message,
		inflightId: NO_INFLIGHT_ID
	}
}

// wrapMessage + withoutInflight in one spread; the query cache holds thousands of these.
export function wrapQueryMessage(message: SdkChatMessage): ChatMessageWithInflightId {
	return {
		...message,
		undecryptable: message.inner.message === undefined,
		inflightId: NO_INFLIGHT_ID
	}
}
