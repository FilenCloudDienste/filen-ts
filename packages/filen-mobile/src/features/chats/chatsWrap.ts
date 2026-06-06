import { type Chat as SdkChat, type ChatMessage as SdkChatMessage } from "@filen/sdk-rs"
import { type Chat, type ChatMessage } from "@/types"

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
