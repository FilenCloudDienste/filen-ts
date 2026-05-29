import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockGetSdkClients, mockChatsQueryUpdate, mockChatMessagesQueryUpdate, mockChatsQueryGet } = vi.hoisted(() => ({
	mockGetSdkClients: vi.fn().mockResolvedValue({
		authedSdkClient: {
			editMessage: vi.fn(),
			muteChat: vi.fn(),
			disableMessageEmbed: vi.fn(),
			addChatParticipant: vi.fn()
		}
	}),
	mockChatsQueryUpdate: vi.fn(),
	mockChatsQueryGet: vi.fn().mockReturnValue([]),
	mockChatMessagesQueryUpdate: vi.fn()
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/queries/useChats.query", () => ({
	chatsQueryUpdate: mockChatsQueryUpdate,
	chatsQueryGet: mockChatsQueryGet,
	fetchData: vi.fn().mockResolvedValue([])
}))

vi.mock("@/queries/useChatMessages.query", () => ({
	chatMessagesQueryUpdate: mockChatMessagesQueryUpdate,
	fetchData: vi.fn().mockResolvedValue([])
}))

vi.mock("@filen/sdk-rs", () => ({
	ChatTypingType: { Up: 0, Down: 1 },
	AnyNormalDir: {
		Dir: class {
			constructor(v: unknown) {
				Object.assign(this, { tag: "Dir", inner: [v] })
			}
		},
		Root: class {
			constructor(v: unknown) {
				Object.assign(this, { tag: "Root", inner: [v] })
			}
		}
	},
	DirMeta_Tags: { Decoded: "Decoded" }
}))

import chats from "@/lib/chats"
import type { Chat, ChatMessage } from "@/types"

function makeChat(overrides: Partial<Chat> = {}): Chat {
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

function makeMessage(messageText: string | undefined, overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		chat: "chat-1",
		inner: {
			uuid: "msg-1",
			message: messageText,
			senderId: 1n,
			senderEmail: "test@test.com",
			senderNickName: undefined
		},
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp: 0n,
		replyTo: undefined,
		undecryptable: messageText === undefined,
		...overrides
	} as unknown as ChatMessage
}

describe("chats.editMessage", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
		mockChatMessagesQueryUpdate.mockClear()
	})

	it("returns the original message without calling SDK when content is unchanged", async () => {
		const message = makeMessage("hello")
		const chat = makeChat()

		const result = await chats.editMessage({ chat, message, newMessage: "hello" })

		expect(result).toBe(message)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
		expect(mockChatsQueryUpdate).not.toHaveBeenCalled()
		expect(mockChatMessagesQueryUpdate).not.toHaveBeenCalled()
	})
})

describe("chats.mute", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
	})

	it("returns the original chat without calling SDK when mute state is already correct (muted=true)", async () => {
		const chat = makeChat({ muted: true })

		const result = await chats.mute({ chat, mute: true })

		expect(result).toBe(chat)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
		expect(mockChatsQueryUpdate).not.toHaveBeenCalled()
	})

	it("returns the original chat without SDK call when unmuting an already-unmuted chat", async () => {
		const chat = makeChat({ muted: false })

		const result = await chats.mute({ chat, mute: false })

		expect(result).toBe(chat)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})
})

describe("chats.disableMessageEmbed", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatMessagesQueryUpdate.mockClear()
	})

	it("returns the original message without calling SDK when embed is already disabled", async () => {
		const message = makeMessage("hello", { embedDisabled: true })

		const result = await chats.disableMessageEmbed({ message })

		expect(result).toBe(message)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
		expect(mockChatMessagesQueryUpdate).not.toHaveBeenCalled()
	})
})

describe("chats.addParticipant", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
	})

	it("returns the original chat without calling SDK when participant already exists", async () => {
		const existingParticipant = {
			userId: 42n,
			email: "existing@test.com",
			nickName: undefined,
			permissionsAdd: true,
			added: 0n,
			appearOffline: false,
			lastActive: 0n,
			avatar: undefined
		}
		const chat = makeChat({ participants: [existingParticipant] })
		const contact = { userId: 42n, email: "existing@test.com" } as any

		const result = await chats.addParticipant({ chat, contact })

		expect(result).toBe(chat)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
		expect(mockChatsQueryUpdate).not.toHaveBeenCalled()
	})
})
