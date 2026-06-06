import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

const {
	mockGetSdkClients,
	mockChatsQueryUpdate,
	mockChatMessagesQueryUpdate,
	mockChatsQueryGet,
	mockChatsQueryFetch,
	mockChatMessagesQueryFetch,
	mockSdkClient
} = vi.hoisted(() => {
	const mockSdkClient = {
		editMessage: vi.fn(),
		muteChat: vi.fn(),
		disableMessageEmbed: vi.fn(),
		addChatParticipant: vi.fn(),
		removeChatParticipant: vi.fn(),
		deleteMessage: vi.fn(),
		renameChat: vi.fn(),
		leaveChat: vi.fn(),
		deleteChat: vi.fn(),
		sendChatMessage: vi.fn(),
		sendTypingSignal: vi.fn(),
		markChatRead: vi.fn(),
		updateChatOnlineStatus: vi.fn(),
		updateLastChatFocusTimesNow: vi.fn(),
		listMessagesBefore: vi.fn(),
		createChat: vi.fn(),
		listDir: vi.fn(),
		createDir: vi.fn(),
		root: vi.fn().mockReturnValue({ uuid: "root-uuid" })
	}

	return {
		mockSdkClient,
		mockGetSdkClients: vi.fn().mockResolvedValue({ authedSdkClient: mockSdkClient }),
		mockChatsQueryUpdate: vi.fn(),
		mockChatsQueryGet: vi.fn().mockReturnValue([]),
		mockChatsQueryFetch: vi.fn().mockResolvedValue([]),
		mockChatMessagesQueryFetch: vi.fn().mockResolvedValue([]),
		mockChatMessagesQueryUpdate: vi.fn()
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/features/chats/queries/useChats.query", () => ({
	chatsQueryUpdate: mockChatsQueryUpdate,
	chatsQueryGet: mockChatsQueryGet,
	fetchData: mockChatsQueryFetch
}))

vi.mock("@/features/chats/queries/useChatMessages.query", () => ({
	chatMessagesQueryUpdate: mockChatMessagesQueryUpdate,
	fetchData: mockChatMessagesQueryFetch
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

// chats.ts now pulls in the upload-and-link helper deps. They're only exercised by the
// uploadAssetsAndGenerateLinks path (not covered here) — mock them so the module loads.
vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("@/features/transfers/transfers", () => ({ default: { upload: vi.fn() } }))
vi.mock("@/features/drive/drive", () => ({ default: { enablePublicLink: vi.fn() } }))
vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapFileMeta: vi.fn(),
	unwrappedFileIntoDriveItem: vi.fn(),
	makeDriveItemPublicLink: vi.fn()
}))

import chats from "@/features/chats/chats"
import type { Chat } from "@/types"
import type { ChatParticipant, Contact } from "@filen/sdk-rs"
import type { ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"

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

function makeMessage(messageText: string | undefined, overrides: Partial<ChatMessageWithInflightId> = {}): ChatMessageWithInflightId {
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
		inflightId: "",
		...overrides
	} as unknown as ChatMessageWithInflightId
}

function makeParticipant(userId: bigint, email: string): ChatParticipant {
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

// Extract the updater function from mockChatsQueryUpdate's last call
function getLastChatsUpdater(): (prev: Chat[]) => Chat[] {
	const calls = mockChatsQueryUpdate.mock.calls
	const lastCall = calls[calls.length - 1]

	return lastCall![0].updater
}

// Extract the updater function from mockChatMessagesQueryUpdate's last call
function getLastMessagesUpdater(): (prev: ChatMessageWithInflightId[]) => ChatMessageWithInflightId[] {
	const calls = mockChatMessagesQueryUpdate.mock.calls
	const lastCall = calls[calls.length - 1]

	return lastCall![0].updater
}

describe("chats.editMessage", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
		mockChatMessagesQueryUpdate.mockClear()
		mockSdkClient.editMessage.mockClear()
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

	it("calls SDK editMessage and returns the wrapped result when content changed", async () => {
		const chat = makeChat()
		const message = makeMessage("hello")
		const sdkResult = {
			chat: "chat-1",
			inner: { uuid: "msg-1", message: "world", senderId: 1n, senderEmail: "test@test.com", senderNickName: undefined },
			embedDisabled: false,
			edited: true,
			editedTimestamp: 100n,
			sentTimestamp: 0n,
			replyTo: undefined
		}

		mockSdkClient.editMessage.mockResolvedValueOnce(sdkResult)

		const result = await chats.editMessage({ chat, message, newMessage: "world" })

		expect(mockSdkClient.editMessage).toHaveBeenCalledWith(chat, message, "world", undefined)
		// wrapMessage sets undecryptable based on inner.message presence
		expect(result.undecryptable).toBe(false)
		expect(result.inner.message).toBe("world")
	})

	it("invokes chatsQueryUpdate and chatMessagesQueryUpdate after a successful edit", async () => {
		const chat = makeChat()
		const message = makeMessage("hello")
		const sdkResult = {
			chat: "chat-1",
			inner: { uuid: "msg-1", message: "world", senderId: 1n, senderEmail: "test@test.com", senderNickName: undefined },
			embedDisabled: false,
			edited: true,
			editedTimestamp: 100n,
			sentTimestamp: 0n,
			replyTo: undefined
		}

		mockSdkClient.editMessage.mockResolvedValueOnce(sdkResult)

		await chats.editMessage({ chat, message, newMessage: "world" })

		expect(mockChatsQueryUpdate).toHaveBeenCalledTimes(1)
		expect(mockChatMessagesQueryUpdate).toHaveBeenCalledTimes(1)
	})

	it("chatMessagesQueryUpdate updater maps matching message uuid to updated message with empty inflightId", async () => {
		const chat = makeChat()
		const originalMessage = makeMessage("hello", { inner: { uuid: "msg-xyz" } } as Partial<ChatMessageWithInflightId>)
		const sdkResult = {
			chat: "chat-1",
			inner: { uuid: "msg-xyz", message: "updated", senderId: 1n, senderEmail: "test@test.com", senderNickName: undefined },
			embedDisabled: false,
			edited: true,
			editedTimestamp: 200n,
			sentTimestamp: 0n,
			replyTo: undefined
		}

		mockSdkClient.editMessage.mockResolvedValueOnce(sdkResult)

		await chats.editMessage({ chat, message: originalMessage, newMessage: "updated" })

		// Simulate what the updater does against a messages list
		const otherMessage = makeMessage("other", { inner: { uuid: "msg-other" } } as Partial<ChatMessageWithInflightId>)
		const updater = getLastMessagesUpdater()
		const updated = updater([originalMessage, otherMessage])

		const editedMsg = updated.find(m => m.inner.uuid === "msg-xyz")

		expect(editedMsg).toBeDefined()
		expect(editedMsg?.inflightId).toBe("")
		expect(editedMsg?.inner.message).toBe("updated")
		// Other message should be unchanged
		expect(updated.find(m => m.inner.uuid === "msg-other")).toBeDefined()
	})

	it("chatsQueryUpdate skips lastMessage replacement when lastMessage uuid does not match edited message uuid", async () => {
		const lastMessage = makeMessage("last msg", { inner: { uuid: "last-msg-uuid" } } as Partial<ChatMessageWithInflightId>)
		const chat = makeChat({ lastMessage: lastMessage as any })
		const message = makeMessage("edit me", { inner: { uuid: "edit-uuid" } } as Partial<ChatMessageWithInflightId>)
		const sdkResult = {
			chat: "chat-1",
			inner: { uuid: "edit-uuid", message: "edited", senderId: 1n, senderEmail: "test@test.com", senderNickName: undefined },
			embedDisabled: false,
			edited: true,
			editedTimestamp: 100n,
			sentTimestamp: 0n,
			replyTo: undefined
		}

		mockSdkClient.editMessage.mockResolvedValueOnce(sdkResult)

		await chats.editMessage({ chat, message, newMessage: "edited" })

		const updater = getLastChatsUpdater()
		const updated = updater([chat])

		// lastMessage uuid does not match edited message uuid, so lastMessage should remain original
		expect((updated[0] as any).lastMessage?.inner.uuid).toBe("last-msg-uuid")
	})

	it("chatsQueryUpdate replaces lastMessage when its uuid matches edited message uuid", async () => {
		const originalLast = makeMessage("original last", { inner: { uuid: "shared-uuid" } } as Partial<ChatMessageWithInflightId>)
		const chat = makeChat({ lastMessage: originalLast as any })
		const message = makeMessage("to edit", { inner: { uuid: "shared-uuid" } } as Partial<ChatMessageWithInflightId>)
		const sdkResult = {
			chat: "chat-1",
			inner: { uuid: "shared-uuid", message: "edited last", senderId: 1n, senderEmail: "test@test.com", senderNickName: undefined },
			embedDisabled: false,
			edited: true,
			editedTimestamp: 300n,
			sentTimestamp: 0n,
			replyTo: undefined
		}

		mockSdkClient.editMessage.mockResolvedValueOnce(sdkResult)

		await chats.editMessage({ chat, message, newMessage: "edited last" })

		const updater = getLastChatsUpdater()
		const updated = updater([chat])

		expect((updated[0] as any).lastMessage?.inner.message).toBe("edited last")
	})

	it("chatsQueryUpdate uses live cache entry fields, not stale snapshot (concurrent update preserved)", async () => {
		// Stale snapshot passed in as `chat` — simulates caller capturing chat before a concurrent write
		const staleChat = makeChat({ uuid: "chat-live", lastFocus: 100n, muted: false })
		const message = makeMessage("to edit", { inner: { uuid: "edit-live-uuid" } } as Partial<ChatMessageWithInflightId>)
		const sdkResult = {
			chat: "chat-live",
			inner: { uuid: "edit-live-uuid", message: "edited", senderId: 1n, senderEmail: "test@test.com", senderNickName: undefined },
			embedDisabled: false,
			edited: true,
			editedTimestamp: 500n,
			sentTimestamp: 0n,
			replyTo: undefined
		}

		mockSdkClient.editMessage.mockResolvedValueOnce(sdkResult)

		await chats.editMessage({ chat: staleChat, message, newMessage: "edited" })

		const updater = getLastChatsUpdater()

		// liveEntry represents the cache state AFTER a concurrent write — its lastFocus differs from stale snapshot
		const liveEntry = makeChat({ uuid: "chat-live", lastFocus: 999n, muted: true })
		const updated = updater([liveEntry])

		// The updater must spread `c` (liveEntry), not `chat` (staleChat).
		// Concurrent lastFocus bump (999n) must be preserved.
		expect((updated[0] as any).lastFocus).toBe(999n)
		// Concurrent mute toggle must be preserved.
		expect(updated[0]!.muted).toBe(true)
	})

	it("wrapMessage marks message as undecryptable when SDK returns undefined inner.message", async () => {
		const chat = makeChat()
		const message = makeMessage("some text")
		const sdkResult = {
			chat: "chat-1",
			inner: { uuid: "msg-1", message: undefined, senderId: 1n, senderEmail: "test@test.com", senderNickName: undefined },
			embedDisabled: false,
			edited: true,
			editedTimestamp: 0n,
			sentTimestamp: 0n,
			replyTo: undefined
		}

		mockSdkClient.editMessage.mockResolvedValueOnce(sdkResult)

		const result = await chats.editMessage({ chat, message, newMessage: "something" })

		expect(result.undecryptable).toBe(true)
	})
})

describe("chats.mute", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
		mockSdkClient.muteChat.mockClear()
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

	it("calls SDK muteChat and returns wrapped result when muting a non-muted chat", async () => {
		const chat = makeChat({ muted: false, uuid: "chat-mute-1" })
		const sdkResult = { ...chat, muted: true, key: "some-key", undecryptable: false }

		mockSdkClient.muteChat.mockResolvedValueOnce(sdkResult)

		const result = await chats.mute({ chat, mute: true })

		expect(mockSdkClient.muteChat).toHaveBeenCalledWith(chat, true, undefined)
		expect(result.muted).toBe(true)
		expect(result.undecryptable).toBe(false)
	})

	it("calls SDK muteChat and returns wrapped result when unmuting a muted chat", async () => {
		const chat = makeChat({ muted: true, uuid: "chat-mute-2" })
		const sdkResult = { ...chat, muted: false, key: "some-key" }

		mockSdkClient.muteChat.mockResolvedValueOnce(sdkResult)

		const result = await chats.mute({ chat, mute: false })

		expect(mockSdkClient.muteChat).toHaveBeenCalledWith(chat, false, undefined)
		expect(result.muted).toBe(false)
	})

	it("invokes chatsQueryUpdate after muting", async () => {
		const chat = makeChat({ muted: false, uuid: "chat-mute-3" })
		const sdkResult = { ...chat, muted: true, key: "some-key" }

		mockSdkClient.muteChat.mockResolvedValueOnce(sdkResult)

		await chats.mute({ chat, mute: true })

		expect(mockChatsQueryUpdate).toHaveBeenCalledTimes(1)
	})

	it("chatsQueryUpdate updater replaces the matching chat by uuid", async () => {
		const chat = makeChat({ muted: false, uuid: "chat-mute-4" })
		const other = makeChat({ uuid: "other-chat" })
		const sdkResult = { ...chat, muted: true, key: "some-key" }

		mockSdkClient.muteChat.mockResolvedValueOnce(sdkResult)

		await chats.mute({ chat, mute: true })

		const updater = getLastChatsUpdater()
		const updated = updater([other, chat])

		expect(updated.find(c => c.uuid === "chat-mute-4")?.muted).toBe(true)
		expect(updated.find(c => c.uuid === "other-chat")?.muted).toBe(false)
	})

	it("wrapChat marks chat as undecryptable when SDK returns undefined key", async () => {
		const chat = makeChat({ muted: false })
		const sdkResult = { ...chat, muted: true, key: undefined }

		mockSdkClient.muteChat.mockResolvedValueOnce(sdkResult)

		const result = await chats.mute({ chat, mute: true })

		expect(result.undecryptable).toBe(true)
	})
})

describe("chats.disableMessageEmbed", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatMessagesQueryUpdate.mockClear()
		mockSdkClient.disableMessageEmbed.mockClear()
	})

	it("returns the original message without calling SDK when embed is already disabled", async () => {
		const message = makeMessage("hello", { embedDisabled: true })

		const result = await chats.disableMessageEmbed({ message })

		expect(result).toBe(message)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
		expect(mockChatMessagesQueryUpdate).not.toHaveBeenCalled()
	})

	it("calls SDK disableMessageEmbed and returns wrapped result when embed is enabled", async () => {
		const message = makeMessage("hello", { embedDisabled: false, inner: { uuid: "msg-embed-1" } } as Partial<ChatMessageWithInflightId>)
		const sdkResult = {
			chat: "chat-1",
			inner: { uuid: "msg-embed-1", message: "hello", senderId: 1n, senderEmail: "test@test.com", senderNickName: undefined },
			embedDisabled: true,
			edited: false,
			editedTimestamp: 0n,
			sentTimestamp: 0n,
			replyTo: undefined
		}

		mockSdkClient.disableMessageEmbed.mockResolvedValueOnce(sdkResult)

		const result = await chats.disableMessageEmbed({ message })

		expect(mockSdkClient.disableMessageEmbed).toHaveBeenCalledWith(message, undefined)
		expect(result.embedDisabled).toBe(true)
		expect(result.undecryptable).toBe(false)
	})

	it("invokes chatMessagesQueryUpdate after disabling embed", async () => {
		const message = makeMessage("hello", { embedDisabled: false })
		const sdkResult = {
			chat: "chat-1",
			inner: { uuid: "msg-1", message: "hello", senderId: 1n, senderEmail: "test@test.com", senderNickName: undefined },
			embedDisabled: true,
			edited: false,
			editedTimestamp: 0n,
			sentTimestamp: 0n,
			replyTo: undefined
		}

		mockSdkClient.disableMessageEmbed.mockResolvedValueOnce(sdkResult)

		await chats.disableMessageEmbed({ message })

		expect(mockChatMessagesQueryUpdate).toHaveBeenCalledTimes(1)
		// Params should use the message.chat uuid
		expect(mockChatMessagesQueryUpdate).toHaveBeenCalledWith(expect.objectContaining({ params: { uuid: "chat-1" } }))
	})

	it("chatMessagesQueryUpdate updater sets inflightId to empty string on the updated message", async () => {
		const message = makeMessage("hello", { embedDisabled: false, inner: { uuid: "msg-embed-2" } } as Partial<ChatMessageWithInflightId>)
		const sdkResult = {
			chat: "chat-1",
			inner: { uuid: "msg-embed-2", message: "hello", senderId: 1n, senderEmail: "test@test.com", senderNickName: undefined },
			embedDisabled: true,
			edited: false,
			editedTimestamp: 0n,
			sentTimestamp: 0n,
			replyTo: undefined
		}

		mockSdkClient.disableMessageEmbed.mockResolvedValueOnce(sdkResult)

		await chats.disableMessageEmbed({ message })

		const other = makeMessage("other", { inner: { uuid: "other-msg" } } as Partial<ChatMessageWithInflightId>)
		const updater = getLastMessagesUpdater()
		const updated = updater([message, other])

		const disabledMsg = updated.find(m => m.inner.uuid === "msg-embed-2")

		expect(disabledMsg).toBeDefined()
		expect(disabledMsg?.inflightId).toBe("")
		expect(disabledMsg?.embedDisabled).toBe(true)
		// Other message should remain unchanged
		expect(updated.find(m => m.inner.uuid === "other-msg")).toBeDefined()
	})
})

describe("chats.addParticipant", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
		mockSdkClient.addChatParticipant.mockClear()
	})

	it("returns the original chat without calling SDK when participant already exists", async () => {
		const existingParticipant = makeParticipant(42n, "existing@test.com")
		const chat = makeChat({ participants: [existingParticipant] })
		const contact = { userId: 42n, email: "existing@test.com" } as unknown as Contact

		const result = await chats.addParticipant({ chat, contact })

		expect(result).toBe(chat)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
		expect(mockChatsQueryUpdate).not.toHaveBeenCalled()
	})

	it("calls SDK addChatParticipant and returns wrapped result when participant is new", async () => {
		const chat = makeChat({ participants: [] })
		const contact = { userId: 99n, email: "new@test.com" } as unknown as Contact
		const sdkResult = { ...chat, key: "some-key", participants: [makeParticipant(99n, "new@test.com")] }

		mockSdkClient.addChatParticipant.mockResolvedValueOnce(sdkResult)

		const result = await chats.addParticipant({ chat, contact })

		expect(mockSdkClient.addChatParticipant).toHaveBeenCalledWith(chat, contact, undefined)
		expect(result.participants).toHaveLength(1)
		expect(result.undecryptable).toBe(false)
	})

	it("invokes chatsQueryUpdate after adding participant", async () => {
		const chat = makeChat({ participants: [], uuid: "chat-add-p" })
		const contact = { userId: 77n, email: "add@test.com" } as unknown as Contact
		const sdkResult = { ...chat, key: "some-key" }

		mockSdkClient.addChatParticipant.mockResolvedValueOnce(sdkResult)

		await chats.addParticipant({ chat, contact })

		expect(mockChatsQueryUpdate).toHaveBeenCalledTimes(1)
	})

	it("chatsQueryUpdate updater replaces the matching chat by uuid", async () => {
		const chat = makeChat({ participants: [], uuid: "chat-add-p2" })
		const other = makeChat({ uuid: "other-chat" })
		const contact = { userId: 55n, email: "p@test.com" } as unknown as Contact
		const newParticipant = makeParticipant(55n, "p@test.com")
		const sdkResult = { ...chat, key: "some-key", participants: [newParticipant] }

		mockSdkClient.addChatParticipant.mockResolvedValueOnce(sdkResult)

		await chats.addParticipant({ chat, contact })

		const updater = getLastChatsUpdater()
		const updated = updater([other, chat])

		expect(updated.find(c => c.uuid === "chat-add-p2")?.participants).toHaveLength(1)
		expect(updated.find(c => c.uuid === "other-chat")?.participants).toHaveLength(0)
	})
})

describe("chats.removeParticipant", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
		mockSdkClient.removeChatParticipant.mockClear()
	})

	it("returns the original chat without calling SDK when participant does not exist", async () => {
		const chat = makeChat({ participants: [] })
		const participant = makeParticipant(10n, "nothere@test.com")

		const result = await chats.removeParticipant({ chat, participant })

		expect(result).toBe(chat)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
		expect(mockChatsQueryUpdate).not.toHaveBeenCalled()
	})

	it("calls SDK removeChatParticipant and returns wrapped result when participant exists", async () => {
		const participant = makeParticipant(10n, "p@test.com")
		const chat = makeChat({ participants: [participant], uuid: "chat-remove-p" })
		const sdkResult = { ...chat, key: "some-key", participants: [] }

		mockSdkClient.removeChatParticipant.mockResolvedValueOnce(sdkResult)

		const result = await chats.removeParticipant({ chat, participant })

		expect(mockSdkClient.removeChatParticipant).toHaveBeenCalledWith(chat, participant.userId, undefined)
		expect(result.participants).toHaveLength(0)
		expect(result.undecryptable).toBe(false)
	})

	it("invokes chatsQueryUpdate after removing participant", async () => {
		const participant = makeParticipant(22n, "r@test.com")
		const chat = makeChat({ participants: [participant], uuid: "chat-remove-p2" })
		const sdkResult = { ...chat, key: "some-key", participants: [] }

		mockSdkClient.removeChatParticipant.mockResolvedValueOnce(sdkResult)

		await chats.removeParticipant({ chat, participant })

		expect(mockChatsQueryUpdate).toHaveBeenCalledTimes(1)
	})
})

describe("chats.deleteMessage", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
		mockChatMessagesQueryUpdate.mockClear()
		mockSdkClient.deleteMessage.mockClear()
	})

	it("calls SDK deleteMessage and returns wrapped chat", async () => {
		const chat = makeChat({ uuid: "chat-del-msg" })
		const message = makeMessage("to delete", { inner: { uuid: "del-msg-1" } } as Partial<ChatMessageWithInflightId>)
		const sdkResult = { ...chat, key: "some-key" }

		mockSdkClient.deleteMessage.mockResolvedValueOnce(sdkResult)

		const result = await chats.deleteMessage({ chat, message })

		expect(mockSdkClient.deleteMessage).toHaveBeenCalledWith(chat, message, undefined)
		expect(result.uuid).toBe("chat-del-msg")
		expect(result.undecryptable).toBe(false)
	})

	it("invokes both chatsQueryUpdate and chatMessagesQueryUpdate after deleting", async () => {
		const chat = makeChat({ uuid: "chat-del-msg2" })
		const message = makeMessage("bye", { inner: { uuid: "del-msg-2" } } as Partial<ChatMessageWithInflightId>)
		const sdkResult = { ...chat, key: "some-key" }

		mockSdkClient.deleteMessage.mockResolvedValueOnce(sdkResult)

		await chats.deleteMessage({ chat, message })

		expect(mockChatsQueryUpdate).toHaveBeenCalledTimes(1)
		expect(mockChatMessagesQueryUpdate).toHaveBeenCalledTimes(1)
	})

	it("chatMessagesQueryUpdate updater filters out the deleted message by uuid", async () => {
		const chat = makeChat({ uuid: "chat-del-msg3" })
		const messageToDelete = makeMessage("delete me", { inner: { uuid: "del-msg-3" } } as Partial<ChatMessageWithInflightId>)
		const keeper = makeMessage("keep me", { inner: { uuid: "keep-msg" } } as Partial<ChatMessageWithInflightId>)
		const sdkResult = { ...chat, key: "some-key" }

		mockSdkClient.deleteMessage.mockResolvedValueOnce(sdkResult)

		await chats.deleteMessage({ chat, message: messageToDelete })

		const updater = getLastMessagesUpdater()
		const updated = updater([messageToDelete, keeper])

		expect(updated).toHaveLength(1)
		expect(updated[0]!.inner.uuid).toBe("keep-msg")
	})
})

describe("chats.rename", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
		mockSdkClient.renameChat.mockClear()
	})

	it("returns original chat when name is unchanged", async () => {
		const chat = makeChat({ name: "My Chat" } as Partial<Chat>)

		const result = await chats.rename({ chat, newName: "My Chat" })

		expect(result).toBe(chat)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("returns original chat when newName trims to empty string", async () => {
		const chat = makeChat()

		const result = await chats.rename({ chat, newName: "   " })

		expect(result).toBe(chat)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK renameChat and returns wrapped result when name changes", async () => {
		const chat = makeChat({ uuid: "chat-rename" })
		const sdkResult = { ...chat, name: "New Name", key: "some-key" }

		mockSdkClient.renameChat.mockResolvedValueOnce(sdkResult)

		const result = await chats.rename({ chat, newName: "New Name" })

		expect(mockSdkClient.renameChat).toHaveBeenCalledWith(chat, "New Name", undefined)
		expect((result as any).name).toBe("New Name")
	})

	it("invokes chatsQueryUpdate after renaming", async () => {
		const chat = makeChat({ uuid: "chat-rename2" })
		const sdkResult = { ...chat, name: "Renamed", key: "some-key" }

		mockSdkClient.renameChat.mockResolvedValueOnce(sdkResult)

		await chats.rename({ chat, newName: "Renamed" })

		expect(mockChatsQueryUpdate).toHaveBeenCalledTimes(1)
	})
})

describe("chats.leave", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
		mockChatMessagesQueryUpdate.mockClear()
		mockSdkClient.leaveChat.mockClear()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("calls SDK leaveChat", async () => {
		const chat = makeChat({ uuid: "chat-leave" })

		mockSdkClient.leaveChat.mockResolvedValueOnce(undefined)

		await chats.leave({ chat })

		expect(mockSdkClient.leaveChat).toHaveBeenCalledWith(chat, undefined)
	})

	it("does not invoke query updaters immediately after leaveChat returns", async () => {
		const chat = makeChat({ uuid: "chat-leave2" })

		mockSdkClient.leaveChat.mockResolvedValueOnce(undefined)

		await chats.leave({ chat })

		// Query updates are deferred via setTimeout(3000), not immediate
		expect(mockChatsQueryUpdate).not.toHaveBeenCalled()
		expect(mockChatMessagesQueryUpdate).not.toHaveBeenCalled()
	})

	it("invokes chatsQueryUpdate and chatMessagesQueryUpdate after 3-second timeout", async () => {
		const chat = makeChat({ uuid: "chat-leave3" })

		mockSdkClient.leaveChat.mockResolvedValueOnce(undefined)

		await chats.leave({ chat })

		vi.advanceTimersByTime(3000)

		expect(mockChatsQueryUpdate).toHaveBeenCalledTimes(1)
		expect(mockChatMessagesQueryUpdate).toHaveBeenCalledTimes(1)
	})

	it("chatsQueryUpdate updater filters out the left chat by uuid", async () => {
		const chat = makeChat({ uuid: "chat-leave4" })
		const other = makeChat({ uuid: "other" })

		mockSdkClient.leaveChat.mockResolvedValueOnce(undefined)

		await chats.leave({ chat })

		vi.advanceTimersByTime(3000)

		const updater = getLastChatsUpdater()
		const updated = updater([chat, other])

		expect(updated).toHaveLength(1)
		expect(updated[0]!.uuid).toBe("other")
	})
})

describe("chats.delete", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
		mockChatMessagesQueryUpdate.mockClear()
		mockSdkClient.deleteChat.mockClear()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("calls SDK deleteChat", async () => {
		const chat = makeChat({ uuid: "chat-del" })

		mockSdkClient.deleteChat.mockResolvedValueOnce(undefined)

		await chats.delete({ chat })

		expect(mockSdkClient.deleteChat).toHaveBeenCalledWith(chat, undefined)
	})

	it("does not invoke query updaters immediately after deleteChat returns", async () => {
		const chat = makeChat({ uuid: "chat-del2" })

		mockSdkClient.deleteChat.mockResolvedValueOnce(undefined)

		await chats.delete({ chat })

		expect(mockChatsQueryUpdate).not.toHaveBeenCalled()
		expect(mockChatMessagesQueryUpdate).not.toHaveBeenCalled()
	})

	it("invokes both query updaters after 3-second timeout", async () => {
		const chat = makeChat({ uuid: "chat-del3" })

		mockSdkClient.deleteChat.mockResolvedValueOnce(undefined)

		await chats.delete({ chat })

		vi.advanceTimersByTime(3000)

		expect(mockChatsQueryUpdate).toHaveBeenCalledTimes(1)
		expect(mockChatMessagesQueryUpdate).toHaveBeenCalledTimes(1)
	})

	it("chatMessagesQueryUpdate updater returns empty array after delete", async () => {
		const chat = makeChat({ uuid: "chat-del4" })
		const msg = makeMessage("a message")

		mockSdkClient.deleteChat.mockResolvedValueOnce(undefined)

		await chats.delete({ chat })

		vi.advanceTimersByTime(3000)

		const msgUpdater = getLastMessagesUpdater()
		const updated = msgUpdater([msg])

		expect(updated).toHaveLength(0)
	})
})

describe("chats.sendMessage", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
		mockChatMessagesQueryUpdate.mockClear()
		mockSdkClient.sendChatMessage.mockClear()
		mockSdkClient.sendTypingSignal.mockClear()
		mockSdkClient.markChatRead.mockClear()
		mockSdkClient.updateLastChatFocusTimesNow.mockClear()
	})

	it("calls sendTypingSignal and sendChatMessage during sendMessage (typing is best-effort, not awaited)", async () => {
		const chat = makeChat({ uuid: "chat-send" })
		const sdkLastMessage = {
			chat: "chat-send",
			inner: { uuid: "new-msg", message: "hi", senderId: 1n, senderEmail: "test@test.com", senderNickName: undefined },
			embedDisabled: false,
			edited: false,
			editedTimestamp: 0n,
			sentTimestamp: 0n,
			replyTo: undefined
		}
		const updatedChat = { ...chat, key: "some-key", lastMessage: sdkLastMessage }

		mockSdkClient.sendTypingSignal.mockResolvedValueOnce(undefined)
		mockSdkClient.sendChatMessage.mockResolvedValueOnce(updatedChat)
		mockSdkClient.updateLastChatFocusTimesNow.mockResolvedValueOnce([updatedChat])
		mockSdkClient.markChatRead.mockResolvedValueOnce(undefined)

		await chats.sendMessage({ chat, message: "hi", inflightId: "inflight-1" })

		// Both are invoked — typing is fire-and-forget, message delivery is not gated on it
		expect(mockSdkClient.sendTypingSignal).toHaveBeenCalledTimes(1)
		expect(mockSdkClient.sendChatMessage).toHaveBeenCalledTimes(1)
	})

	it("calls sendChatMessage with the correct args and returns chat + message", async () => {
		const chat = makeChat({ uuid: "chat-send2" })
		const sdkLastMessage = {
			chat: "chat-send2",
			inner: { uuid: "msg-send-1", message: "hello world", senderId: 1n, senderEmail: "test@test.com", senderNickName: undefined },
			embedDisabled: false,
			edited: false,
			editedTimestamp: 0n,
			sentTimestamp: 0n,
			replyTo: undefined
		}
		const sdkChat = { ...chat, key: "some-key", lastMessage: sdkLastMessage }

		mockSdkClient.sendTypingSignal.mockResolvedValueOnce(undefined)
		mockSdkClient.sendChatMessage.mockResolvedValueOnce(sdkChat)
		mockSdkClient.updateLastChatFocusTimesNow.mockResolvedValueOnce([sdkChat])
		mockSdkClient.markChatRead.mockResolvedValueOnce(undefined)

		const result = await chats.sendMessage({ chat, message: "hello world", inflightId: "inflight-2" })

		expect(mockSdkClient.sendChatMessage).toHaveBeenCalledWith(chat, "hello world", undefined, undefined)
		expect(result.message.inner.message).toBe("hello world")
		expect(result.message.undecryptable).toBe(false)
	})

	it("throws when updateLastFocusTimesNow returns no chat", async () => {
		const chat = makeChat({ uuid: "chat-send3" })
		const sdkChat = { ...chat, key: "some-key", lastMessage: undefined }

		mockSdkClient.sendTypingSignal.mockResolvedValueOnce(undefined)
		mockSdkClient.sendChatMessage.mockResolvedValueOnce(sdkChat)
		// updateLastChatFocusTimesNow returns empty array → updatedChat is undefined
		mockSdkClient.updateLastChatFocusTimesNow.mockResolvedValueOnce([])
		mockSdkClient.markChatRead.mockResolvedValueOnce(undefined)

		await expect(chats.sendMessage({ chat, message: "test", inflightId: "inf-3" })).rejects.toThrow(
			"Failed to update chat after sending message"
		)
	})

	it("throws when chat has no lastMessage after sending", async () => {
		const chat = makeChat({ uuid: "chat-send4" })
		const sdkChat = { ...chat, key: "some-key", lastMessage: undefined }

		mockSdkClient.sendTypingSignal.mockResolvedValueOnce(undefined)
		mockSdkClient.sendChatMessage.mockResolvedValueOnce(sdkChat)
		mockSdkClient.updateLastChatFocusTimesNow.mockResolvedValueOnce([sdkChat])
		mockSdkClient.markChatRead.mockResolvedValueOnce(undefined)

		await expect(chats.sendMessage({ chat, message: "test", inflightId: "inf-4" })).rejects.toThrow(
			"No last message after sending message"
		)
	})

	it("sendMessage succeeds even when sendTypingSignal rejects (typing failure must not gate delivery)", async () => {
		const chat = makeChat({ uuid: "chat-send-typing-fail" })
		const sdkLastMessage = {
			chat: "chat-send-typing-fail",
			inner: { uuid: "msg-tf", message: "hi", senderId: 1n, senderEmail: "test@test.com", senderNickName: undefined },
			embedDisabled: false,
			edited: false,
			editedTimestamp: 0n,
			sentTimestamp: 0n,
			replyTo: undefined
		}
		const sdkChat = { ...chat, key: "some-key", lastMessage: sdkLastMessage }

		// Typing signal rejects with a transient network error
		mockSdkClient.sendTypingSignal.mockRejectedValueOnce(new Error("network timeout"))
		mockSdkClient.sendChatMessage.mockResolvedValueOnce(sdkChat)
		mockSdkClient.updateLastChatFocusTimesNow.mockResolvedValueOnce([sdkChat])
		mockSdkClient.markChatRead.mockResolvedValueOnce(undefined)

		// Must resolve successfully, not throw
		const result = await chats.sendMessage({ chat, message: "hi", inflightId: "inf-tf" })

		expect(mockSdkClient.sendChatMessage).toHaveBeenCalledTimes(1)
		expect(result.message.inner.message).toBe("hi")
	})

	it("chatMessagesQueryUpdate deduplicates by uuid and inflightId", async () => {
		const chat = makeChat({ uuid: "chat-send5" })
		const inflightId = "inflight-dedup"
		const sdkLastMessage = {
			chat: "chat-send5",
			inner: { uuid: "final-uuid", message: "text", senderId: 1n, senderEmail: "test@test.com", senderNickName: undefined },
			embedDisabled: false,
			edited: false,
			editedTimestamp: 0n,
			sentTimestamp: 0n,
			replyTo: undefined
		}
		const sdkChat = { ...chat, key: "some-key", lastMessage: sdkLastMessage }

		mockSdkClient.sendTypingSignal.mockResolvedValueOnce(undefined)
		mockSdkClient.sendChatMessage.mockResolvedValueOnce(sdkChat)
		mockSdkClient.updateLastChatFocusTimesNow.mockResolvedValueOnce([sdkChat])
		mockSdkClient.markChatRead.mockResolvedValueOnce(undefined)

		await chats.sendMessage({ chat, message: "text", inflightId })

		// The chatMessagesQueryUpdate call includes a dedup updater
		const allMsgUpdaterCalls = mockChatMessagesQueryUpdate.mock.calls
		const lastMsgCall = allMsgUpdaterCalls[allMsgUpdaterCalls.length - 1]

		expect(lastMsgCall).toBeDefined()
		expect(lastMsgCall![0].params.uuid).toBe("chat-send5")

		// The updater should filter out duplicates by uuid AND inflightId and add the final message
		const inflight = makeMessage("in-flight", { inner: { uuid: "other-uuid" }, inflightId } as Partial<ChatMessageWithInflightId>)
		const duplicate = makeMessage("dupe", { inner: { uuid: "final-uuid" } } as Partial<ChatMessageWithInflightId>)

		const updater = lastMsgCall![0].updater
		const updated = updater([inflight, duplicate])

		// inflight with matching inflightId should be removed
		// duplicate with matching uuid should be removed
		// final message added at end
		expect(updated.some((m: ChatMessageWithInflightId) => m.inflightId === inflightId && m.inner.uuid !== "final-uuid")).toBe(false)
		expect(updated.some((m: ChatMessageWithInflightId) => m.inner.uuid === "final-uuid")).toBe(true)
	})
})

describe("chats.sendTyping", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockSdkClient.sendTypingSignal.mockClear()
	})

	it("calls SDK sendTypingSignal with the correct args", async () => {
		const chat = makeChat({ uuid: "chat-typing" })

		mockSdkClient.sendTypingSignal.mockResolvedValueOnce(undefined)

		await chats.sendTyping({ chat, type: 0 as any })

		expect(mockSdkClient.sendTypingSignal).toHaveBeenCalledWith(chat, 0, undefined)
	})
})

describe("chats.markRead", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockSdkClient.markChatRead.mockClear()
	})

	it("calls SDK markChatRead with the correct chat", async () => {
		const chat = makeChat({ uuid: "chat-markread" })

		mockSdkClient.markChatRead.mockResolvedValueOnce(undefined)

		await chats.markRead({ chat })

		expect(mockSdkClient.markChatRead).toHaveBeenCalledWith(chat, undefined)
	})
})

describe("chats.updateOnlineStatus", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
		mockSdkClient.updateChatOnlineStatus.mockClear()
	})

	it("calls SDK updateChatOnlineStatus and returns wrapped result", async () => {
		const chat = makeChat({ uuid: "chat-online" })
		const sdkResult = { ...chat, key: "some-key" }

		mockSdkClient.updateChatOnlineStatus.mockResolvedValueOnce(sdkResult)

		const result = await chats.updateOnlineStatus({ chat })

		expect(mockSdkClient.updateChatOnlineStatus).toHaveBeenCalledWith(chat, undefined)
		expect(result.uuid).toBe("chat-online")
		expect(result.undecryptable).toBe(false)
	})

	it("invokes chatsQueryUpdate after updating online status", async () => {
		const chat = makeChat({ uuid: "chat-online2" })

		mockSdkClient.updateChatOnlineStatus.mockResolvedValueOnce({ ...chat, key: "some-key" })

		await chats.updateOnlineStatus({ chat })

		expect(mockChatsQueryUpdate).toHaveBeenCalledTimes(1)
	})
})

describe("chats.updateLastFocusTimesNow", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
		mockSdkClient.updateLastChatFocusTimesNow.mockClear()
	})

	it("calls SDK updateLastChatFocusTimesNow and returns wrapped chats", async () => {
		const chat1 = makeChat({ uuid: "focus-1" })
		const chat2 = makeChat({ uuid: "focus-2" })
		const sdkResult = [
			{ ...chat1, key: "some-key" },
			{ ...chat2, key: "some-key" }
		]

		mockSdkClient.updateLastChatFocusTimesNow.mockResolvedValueOnce(sdkResult)

		const result = await chats.updateLastFocusTimesNow({ chats: [chat1, chat2] })

		expect(result).toHaveLength(2)
		expect(result[0]!.uuid).toBe("focus-1")
		expect(result[1]!.uuid).toBe("focus-2")
		result.forEach(c => expect(c.undecryptable).toBe(false))
	})

	it("invokes chatsQueryUpdate once per chat returned", async () => {
		const chat1 = makeChat({ uuid: "focus-3" })
		const chat2 = makeChat({ uuid: "focus-4" })
		const sdkResult = [
			{ ...chat1, key: "some-key" },
			{ ...chat2, key: "some-key" }
		]

		mockSdkClient.updateLastChatFocusTimesNow.mockResolvedValueOnce(sdkResult)

		await chats.updateLastFocusTimesNow({ chats: [chat1, chat2] })

		expect(mockChatsQueryUpdate).toHaveBeenCalledTimes(2)
	})
})

describe("chats.listBefore", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockSdkClient.listMessagesBefore.mockClear()
	})

	it("calls SDK listMessagesBefore and returns wrapped messages", async () => {
		const chat = makeChat({ uuid: "chat-list" })
		const sdkMessages = [
			{
				chat: "chat-list",
				inner: { uuid: "m1", message: "a", senderId: 1n, senderEmail: "e@e.com", senderNickName: undefined },
				embedDisabled: false,
				edited: false,
				editedTimestamp: 0n,
				sentTimestamp: 0n,
				replyTo: undefined
			},
			{
				chat: "chat-list",
				inner: { uuid: "m2", message: undefined, senderId: 2n, senderEmail: "f@f.com", senderNickName: undefined },
				embedDisabled: false,
				edited: false,
				editedTimestamp: 0n,
				sentTimestamp: 0n,
				replyTo: undefined
			}
		]

		mockSdkClient.listMessagesBefore.mockResolvedValueOnce(sdkMessages)

		const result = await chats.listBefore({ chat, before: 999n })

		expect(mockSdkClient.listMessagesBefore).toHaveBeenCalledWith(chat, 999n, undefined)
		expect(result).toHaveLength(2)
		// wrapMessage sets undecryptable based on inner.message
		expect(result[0]!.undecryptable).toBe(false)
		expect(result[1]!.undecryptable).toBe(true)
	})
})

describe("chats.create", () => {
	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
		mockSdkClient.createChat.mockClear()
	})

	it("calls SDK createChat and returns wrapped chat", async () => {
		const contact = { userId: 1n, email: "c@test.com" } as unknown as Contact
		const sdkResult = makeChat({ uuid: "new-chat", key: "some-key" })

		mockSdkClient.createChat.mockResolvedValueOnce(sdkResult)

		const result = await chats.create({ contacts: [contact] })

		expect(mockSdkClient.createChat).toHaveBeenCalledWith([contact], undefined)
		expect(result.uuid).toBe("new-chat")
		expect(result.undecryptable).toBe(false)
	})

	it("invokes chatsQueryUpdate after creating chat, prepending it if not duplicate", async () => {
		const contact = { userId: 2n, email: "d@test.com" } as unknown as Contact
		const newChat = makeChat({ uuid: "created-chat", key: "some-key" })
		const existing = makeChat({ uuid: "existing-chat" })

		mockSdkClient.createChat.mockResolvedValueOnce(newChat)

		await chats.create({ contacts: [contact] })

		const updater = getLastChatsUpdater()
		const updated = updater([existing])

		// Created chat appended (deduped), existing preserved
		expect(updated.some(c => c.uuid === "created-chat")).toBe(true)
		expect(updated.some(c => c.uuid === "existing-chat")).toBe(true)
	})

	it("chatsQueryUpdate deduplicates if chat uuid already exists", async () => {
		const contact = { userId: 3n, email: "e@test.com" } as unknown as Contact
		const newChat = makeChat({ uuid: "dup-chat", key: "some-key" })
		const duplicate = makeChat({ uuid: "dup-chat" })

		mockSdkClient.createChat.mockResolvedValueOnce(newChat)

		await chats.create({ contacts: [contact] })

		const updater = getLastChatsUpdater()
		const updated = updater([duplicate])

		// filter(c.uuid !== chat.uuid) removes duplicate, then appends new
		expect(updated.filter(c => c.uuid === "dup-chat")).toHaveLength(1)
	})
})

describe("chats.refetchChatsAndMessages", () => {
	beforeEach(() => {
		mockChatsQueryFetch.mockClear()
		mockChatMessagesQueryFetch.mockClear()
		mockChatsQueryUpdate.mockClear()
		mockChatMessagesQueryUpdate.mockClear()
	})

	it("does nothing when chatsQueryFetch returns empty array", async () => {
		mockChatsQueryFetch.mockResolvedValueOnce([])

		await chats.refetchChatsAndMessages()

		expect(mockChatMessagesQueryFetch).not.toHaveBeenCalled()
		expect(mockChatsQueryUpdate).not.toHaveBeenCalled()
		expect(mockChatMessagesQueryUpdate).not.toHaveBeenCalled()
	})

	it("does nothing when chatsQueryFetch returns null", async () => {
		mockChatsQueryFetch.mockResolvedValueOnce(null)

		await chats.refetchChatsAndMessages()

		expect(mockChatMessagesQueryFetch).not.toHaveBeenCalled()
		expect(mockChatsQueryUpdate).not.toHaveBeenCalled()
	})

	it("fetches messages for each chat and updates both caches when chats are returned", async () => {
		const chat1 = makeChat({ uuid: "rf-1" })
		const chat2 = makeChat({ uuid: "rf-2" })
		const msgs1 = [makeMessage("a")]
		const msgs2 = [makeMessage("b"), makeMessage("c")]

		mockChatsQueryFetch.mockResolvedValueOnce([chat1, chat2])
		mockChatMessagesQueryFetch.mockImplementation(async ({ uuid }: { uuid: string }) => {
			if (uuid === "rf-1") return msgs1

			return msgs2
		})

		await chats.refetchChatsAndMessages()

		expect(mockChatMessagesQueryFetch).toHaveBeenCalledTimes(2)
		// chatMessagesQueryUpdate called once per chat
		expect(mockChatMessagesQueryUpdate).toHaveBeenCalledTimes(2)
		// chatsQueryUpdate called once at the end
		expect(mockChatsQueryUpdate).toHaveBeenCalledTimes(1)
	})

	it("chatMessagesQueryUpdate updater replaces messages for each chat", async () => {
		const chat1 = makeChat({ uuid: "rf-3" })
		const msgs1 = [makeMessage("msg a")]

		mockChatsQueryFetch.mockResolvedValueOnce([chat1])
		mockChatMessagesQueryFetch.mockResolvedValueOnce(msgs1)

		await chats.refetchChatsAndMessages()

		// Find the call for chat1's messages
		const msgCall = mockChatMessagesQueryUpdate.mock.calls.find(c => c[0]?.params?.uuid === "rf-3")

		expect(msgCall).toBeDefined()

		const updater = msgCall![0].updater
		const result = updater([makeMessage("old")])

		expect(result).toHaveLength(1)
		expect(result[0]!.inner.message).toBe("msg a")
	})
})

describe("wrapChat / wrapMessage (undecryptable derivation)", () => {
	// These are exercised indirectly through the public methods above.
	// This describe block focuses specifically on edge cases.

	beforeEach(() => {
		mockGetSdkClients.mockClear()
		mockChatsQueryUpdate.mockClear()
		mockSdkClient.muteChat.mockClear()
		mockSdkClient.disableMessageEmbed.mockClear()
	})

	it("wrapChat: undecryptable is false when key is a string", async () => {
		const chat = makeChat({ muted: false })
		const sdkResult = { ...chat, key: "real-key", muted: true }

		mockSdkClient.muteChat.mockResolvedValueOnce(sdkResult)

		const result = await chats.mute({ chat, mute: true })

		expect(result.undecryptable).toBe(false)
	})

	it("wrapChat: undecryptable is true when key is undefined", async () => {
		const chat = makeChat({ muted: false })
		const sdkResult = { ...chat, key: undefined, muted: true }

		mockSdkClient.muteChat.mockResolvedValueOnce(sdkResult)

		const result = await chats.mute({ chat, mute: true })

		expect(result.undecryptable).toBe(true)
	})

	it("wrapMessage: undecryptable is false when inner.message is a string", async () => {
		const message = makeMessage("original")
		const sdkResult = {
			chat: "chat-1",
			inner: { uuid: "msg-1", message: "new text", senderId: 1n, senderEmail: "a@a.com", senderNickName: undefined },
			embedDisabled: true,
			edited: false,
			editedTimestamp: 0n,
			sentTimestamp: 0n,
			replyTo: undefined
		}

		mockSdkClient.disableMessageEmbed.mockResolvedValueOnce(sdkResult)

		const result = await chats.disableMessageEmbed({ message })

		expect(result.undecryptable).toBe(false)
	})

	it("wrapMessage: undecryptable is true when inner.message is undefined", async () => {
		const message = makeMessage("original")
		const sdkResult = {
			chat: "chat-1",
			inner: { uuid: "msg-1", message: undefined, senderId: 1n, senderEmail: "a@a.com", senderNickName: undefined },
			embedDisabled: true,
			edited: false,
			editedTimestamp: 0n,
			sentTimestamp: 0n,
			replyTo: undefined
		}

		mockSdkClient.disableMessageEmbed.mockResolvedValueOnce(sdkResult)

		const result = await chats.disableMessageEmbed({ message })

		expect(result.undecryptable).toBe(true)
	})
})
