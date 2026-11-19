import { vi } from "vitest"
import type { Chat, ChatMessage } from "@filen/sdk-rs"
import { buildOptimisticMessage, type OptimisticSender, type RemoteChatEnqueue } from "@/features/chats/lib/sync.logic"
import {
	useChatsInflightStore,
	type ChatMessageWithInflightId,
	type InflightChatMessageError,
	type InflightChatMessages
} from "@/features/chats/store/useChatsInflight"
import { mockChat, mockChatMessage } from "@/tests/fixtures/sdk"

// The chat send outbox's worker-free harness. vi.mock factories are hoisted and cannot close over a static
// import, so a test file reaches the mock bodies with an awaited import inside its own vi.hoisted call:
//
//   const { sendChatMessage, ... } = await vi.hoisted(async () => (await import("@/tests/support/chatsOutbox")).chatsSdkMocks())
//   vi.mock("@/lib/sdk/client", () => ({ sdkApi: { sendChatMessage, ... } }))

export const SENDER: OptimisticSender = { id: 7n, email: "me@filen.io", avatarUrl: undefined, nickName: "Me" }

export function outboxChat(uuid: string): Chat {
	return mockChat({ uuid: uuid as Chat["uuid"], ownerId: 7n })
}

// The sdk client calls the outbox makes. getChat answers a live chat for any uuid, so a send resolves on a
// list-cache miss.
export function chatsSdkMocks() {
	return {
		sendChatMessage: vi.fn<(chat: Chat, message: string, replyTo?: unknown) => Promise<Chat>>(),
		markChatRead: vi.fn(() => Promise.resolve()),
		updateLastChatFocusTimesNow: vi.fn((chats: Chat[]) => Promise.resolve(chats)),
		listChats: vi.fn(() => Promise.resolve([] as Chat[])),
		getChat: vi.fn((uuid: string): Promise<Chat | undefined> => Promise.resolve(outboxChat(uuid)))
	}
}

// The kv adapter over a plain map, without schema decoding: tests assert on the spies and seed raw rows.
export function chatsKvMocks() {
	const store = new Map<string, unknown>()

	return {
		kvStore: store,
		kvGetJson: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
		kvSetJson: vi.fn((key: string, value: unknown) => {
			store.set(key, value)

			return Promise.resolve()
		}),
		kvDelete: vi.fn((key: string) => {
			store.delete(key)

			return Promise.resolve()
		})
	}
}

// The message a committed send carries back on the chat.
export function confirmedMessage(chatUuid: string, uuid: string): ChatMessage {
	return mockChatMessage({
		uuid: uuid as ChatMessage["uuid"],
		chat: chatUuid as ChatMessage["chat"],
		senderId: 7,
		senderEmail: "me@filen.io",
		senderNickName: "Me",
		sentTimestamp: 1n
	})
}

export function optimistic(chatUuid: string, inflightId: string, sentTimestamp: bigint, content = "hi"): ChatMessageWithInflightId {
	return buildOptimisticMessage({
		chatUuid: chatUuid as ChatMessageWithInflightId["chat"],
		inflightId: inflightId as ChatMessageWithInflightId["uuid"],
		content,
		replyTo: undefined,
		sentTimestamp,
		sender: SENDER
	})
}

export function group(chatUuid: string, ...messages: ChatMessageWithInflightId[]): InflightChatMessages {
	return { [chatUuid]: { chat: outboxChat(chatUuid), messages } }
}

// Inferred return type keeps each field a precisely-typed Mock<Sig> — assignable to ChatOutboxTransport AND
// carrying .mock/.mockClear. An explicit mapped-type annotation collapses them to a bare Mock, no longer
// assignable to the method signatures, so it is deliberately left to inference.
export function mockTransport() {
	return {
		sendEnqueue: vi.fn<(msg: RemoteChatEnqueue) => void>(),
		sendExecuteNow: vi.fn<() => void>(),
		requestState: vi.fn<() => void>(),
		broadcastState: vi.fn<(state: InflightChatMessages) => void>(),
		broadcastLeaderHello: vi.fn<() => void>(),
		broadcastPushed: vi.fn<(id: string, hash: string) => void>(),
		broadcastFailed: vi.fn<(failed: InflightChatMessageError) => void>(),
		broadcastAnswered: vi.fn<(id: string) => void>(),
		close: vi.fn<() => void>()
	}
}

export function getStore(): InflightChatMessages {
	return useChatsInflightStore.getState().inflightMessages
}

export function inflightIds(chatUuid: string): string[] {
	return (getStore()[chatUuid]?.messages ?? []).map(m => m.inflightId)
}

// One macrotask turn: the single-tab loop settles within it.
export function tick(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0))
}

// A longer turn for the multi-tab passes, whose broadcasts chain behind disk writes.
export function settle(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 15))
}
