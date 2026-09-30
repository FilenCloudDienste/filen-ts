import type { Chat, ChatMessage } from "@/types"
import type { ChatParticipant } from "@filen/sdk-rs"

export type ChatMessageOverrides = Omit<Partial<ChatMessage>, "inner"> & {
	inner?: Partial<ChatMessage["inner"]>
}

export function makeChat(overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: "chat-1",
		ownerId: 1n,
		muted: false,
		participants: [],
		undecryptable: false,
		key: "some-key",
		created: 1n,
		lastFocus: 1n,
		...overrides
	} as Chat
}

// `inner` overrides merge into the default inner rather than replacing it.
export function makeChatMessage(overrides: ChatMessageOverrides = {}): ChatMessage {
	return {
		chat: "chat-1",
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 0n,
		replyTo: undefined,
		undecryptable: false,
		...overrides,
		inner: {
			uuid: "msg-1",
			message: "hello",
			senderId: 1n,
			senderEmail: "test@test.com",
			senderNickName: undefined,
			...overrides.inner
		}
	} as ChatMessage
}

export function makeParticipant(userId: bigint, email: string): ChatParticipant {
	return {
		userId,
		email,
		nickName: undefined,
		permissionsAdd: true,
		added: 0n,
		appearOffline: false,
		lastActive: 0n,
		avatar: undefined
	} as unknown as ChatParticipant
}
