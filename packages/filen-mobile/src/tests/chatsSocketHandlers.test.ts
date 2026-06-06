import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

// ---------------------------------------------------------------------------
// Hoisted state
// ---------------------------------------------------------------------------

const {
	capturedChatsUpdaters,
	capturedMessagesUpdaters,
	mockChatsQueryUpdate,
	mockChatMessagesQueryUpdate,
	mockChatsQueryGet,
	mockChatMessagesQueryGet,
	mockEventsEmit,
	mockSetTyping
} = vi.hoisted(() => {
	const capturedChatsUpdaters: Array<(prev: unknown[]) => unknown[]> = []
	const capturedMessagesUpdaters: Array<(prev: unknown[]) => unknown[]> = []

	const mockChatsQueryUpdate = vi.fn(({ updater }: { updater: (prev: unknown[]) => unknown[] }) => {
		capturedChatsUpdaters.push(updater)
	})

	const mockChatMessagesQueryUpdate = vi.fn(({ updater }: { updater: (prev: unknown[]) => unknown[] }) => {
		capturedMessagesUpdaters.push(updater)
	})

	return {
		capturedChatsUpdaters,
		capturedMessagesUpdaters,
		mockChatsQueryUpdate,
		mockChatMessagesQueryUpdate,
		mockChatsQueryGet: vi.fn().mockReturnValue([]),
		mockChatMessagesQueryGet: vi.fn().mockReturnValue([]),
		mockEventsEmit: vi.fn(),
		mockSetTyping: vi.fn()
	}
})

// ---------------------------------------------------------------------------
// Module mocks — must be before any imports that load the mocked modules
// ---------------------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@/features/chats/queries/useChats.query", () => ({
	chatsQueryUpdate: mockChatsQueryUpdate,
	chatsQueryGet: mockChatsQueryGet
}))

vi.mock("@/features/chats/queries/useChatMessages.query", () => ({
	chatMessagesQueryUpdate: mockChatMessagesQueryUpdate,
	chatMessagesQueryGet: mockChatMessagesQueryGet
}))

vi.mock("@/features/chats/store/useChats.store", () => ({
	default: {
		getState: vi.fn().mockReturnValue({
			setTyping: mockSetTyping
		})
	}
}))

vi.mock("@/features/chats/chatsWrap", () => ({
	wrapMessage: vi.fn((msg: unknown) => ({ ...(msg as Record<string, unknown>), undecryptable: false })),
	wrapChat: vi.fn((chat: unknown) => ({ ...(chat as Record<string, unknown>), undecryptable: false }))
}))

vi.mock("@/lib/events", () => ({
	default: {
		emit: mockEventsEmit,
		subscribe: vi.fn()
	}
}))

vi.mock("@filen/sdk-rs", () => ({
	ChatEvent_Tags: {
		MessageNew: "MessageNew",
		Typing: "Typing",
		ConversationsNew: "ConversationsNew",
		MessageDelete: "MessageDelete",
		MessageEmbedDisabled: "MessageEmbedDisabled",
		ConversationParticipantLeft: "ConversationParticipantLeft",
		ConversationDeleted: "ConversationDeleted",
		MessageEdited: "MessageEdited",
		ConversationNameEdited: "ConversationNameEdited",
		ConversationParticipantNew: "ConversationParticipantNew"
	},
	ChatTypingType: {
		Up: "Up",
		Down: "Down"
	},
	MaybeEncryptedUniffi_Tags: {
		Decrypted: "Decrypted",
		Encrypted: "Encrypted"
	},
	SocketEvent_Tags: {
		Chat: "Chat",
		Drive: "Drive",
		Note: "Note"
	}
}))

// ---------------------------------------------------------------------------
// Import the unit under test AFTER all vi.mock declarations
// ---------------------------------------------------------------------------

import { handleChatEvent, chatTypingTimeoutsRef, type ChatSocketEvent } from "@/features/chats/socketHandlers"
import { ChatEvent_Tags, ChatTypingType, MaybeEncryptedUniffi_Tags, SocketEvent_Tags } from "@filen/sdk-rs"

// ---------------------------------------------------------------------------
// Helpers — build minimal socket-event shapes matching the handler's destructure:
//   const [eventInner] = event.inner
//   eventInner.inner.tag  → ChatEvent_Tags.*
//   const [inner] = eventInner.inner.inner
// ---------------------------------------------------------------------------

function makeEvent(tag: string, inner: unknown): ChatSocketEvent {
	return {
		tag: SocketEvent_Tags.Chat,
		inner: [{ inner: { tag, inner: [inner] } }]
	} as unknown as ChatSocketEvent
}

function makeTypingEvent(typingType: ChatTypingType, chatUuid: string, senderId: bigint): ChatSocketEvent {
	return makeEvent(ChatEvent_Tags.Typing, {
		typingType,
		chat: chatUuid,
		senderId
	})
}

function makeMessageNewEvent(chatUuid: string, msgUuid: string, senderId: bigint): ChatSocketEvent {
	return makeEvent(ChatEvent_Tags.MessageNew, {
		msg: {
			chat: chatUuid,
			inner: {
				uuid: msgUuid,
				senderId,
				message: "hello"
			}
		}
	})
}

function makeConversationNameEditedEvent(chatUuid: string, newName: { tag: string; inner: string[] }): ChatSocketEvent {
	return makeEvent(ChatEvent_Tags.ConversationNameEdited, {
		chat: chatUuid,
		newName
	})
}

function makeMessageEditedEvent(chatUuid: string, msgUuid: string, newContent: { tag: string; inner: string[] }): ChatSocketEvent {
	return makeEvent(ChatEvent_Tags.MessageEdited, {
		chat: chatUuid,
		uuid: msgUuid,
		newContent
	})
}

function makeMessageDeleteEvent(msgUuid: string): ChatSocketEvent {
	return makeEvent(ChatEvent_Tags.MessageDelete, { uuid: msgUuid })
}

function makeMessageEmbedDisabledEvent(msgUuid: string): ChatSocketEvent {
	return makeEvent(ChatEvent_Tags.MessageEmbedDisabled, { uuid: msgUuid })
}

function makeConversationsNewEvent(chatObj: Record<string, unknown>): ChatSocketEvent {
	return makeEvent(ChatEvent_Tags.ConversationsNew, { chat: chatObj })
}

function makeConversationDeletedEvent(chatUuid: string): ChatSocketEvent {
	return makeEvent(ChatEvent_Tags.ConversationDeleted, { uuid: chatUuid })
}

function makeConversationParticipantLeftEvent(chatUuid: string, userId: bigint): ChatSocketEvent {
	return makeEvent(ChatEvent_Tags.ConversationParticipantLeft, { uuid: chatUuid, userId })
}

function makeConversationParticipantNewEvent(chatUuid: string, participant: Record<string, unknown>): ChatSocketEvent {
	return makeEvent(ChatEvent_Tags.ConversationParticipantNew, {
		chat: chatUuid,
		participant
	})
}

function makeUnknownTagEvent(): ChatSocketEvent {
	return {
		tag: SocketEvent_Tags.Chat,
		inner: [{ inner: { tag: "UnknownTagThatDoesNotExist_xyz", inner: [{}] } }]
	} as unknown as ChatSocketEvent
}

const USER_ID = 100n
const OTHER_USER_ID = 200n

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleChatEvent — chats socket handler (#51)", () => {
	beforeEach(() => {
		capturedChatsUpdaters.length = 0
		capturedMessagesUpdaters.length = 0
		mockChatsQueryUpdate.mockClear()
		mockChatMessagesQueryUpdate.mockClear()
		mockChatsQueryGet.mockReset()
		mockChatMessagesQueryGet.mockReset()
		mockEventsEmit.mockClear()
		mockSetTyping.mockClear()
		// Clear any pending timeouts
		for (const key of Object.keys(chatTypingTimeoutsRef)) {
			clearTimeout(chatTypingTimeoutsRef[Number(key)])
			delete chatTypingTimeoutsRef[Number(key)]
		}
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	// ---------------------------------------------------------------------------
	// Typing.Down and Typing.Up
	// ---------------------------------------------------------------------------

	describe("ChatEvent_Tags.Typing — Down", () => {
		it("adds typing indicator for the sender in the chat", async () => {
			const typingInner = { typingType: ChatTypingType.Down, chat: "chat-1", senderId: OTHER_USER_ID }
			const event = makeTypingEvent(ChatTypingType.Down, "chat-1", OTHER_USER_ID)

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockSetTyping).toHaveBeenCalledOnce()

			const updater = mockSetTyping.mock.calls[0]?.[0] as (prev: Record<string, unknown[]>) => Record<string, unknown[]>
			const prev = { "chat-1": [] }
			const result = updater(prev)

			expect(result["chat-1"]).toHaveLength(1)
			expect((result["chat-1"]![0] as typeof typingInner).senderId).toBe(OTHER_USER_ID)
		})

		it("deduplicates — existing indicator from same sender is replaced", async () => {
			const event = makeTypingEvent(ChatTypingType.Down, "chat-1", OTHER_USER_ID)

			await handleChatEvent({ event, userId: USER_ID })

			const updater = mockSetTyping.mock.calls[0]?.[0] as (prev: Record<string, unknown[]>) => Record<string, unknown[]>
			const existingIndicator = { senderId: OTHER_USER_ID, chat: "chat-1" }
			const prev = { "chat-1": [existingIndicator, { senderId: 999n, chat: "chat-1" }] }
			const result = updater(prev)

			// The existing entry for OTHER_USER_ID is replaced; the other sender remains
			const senderIds = (result["chat-1"] as Array<{ senderId: bigint }>).map(t => t.senderId)
			const matchingCount = senderIds.filter(id => id === OTHER_USER_ID).length
			expect(matchingCount).toBe(1)
		})

		it("sets a 10-second timeout that auto-removes the typing indicator", async () => {
			// Make setTyping actually invoke the updater so the inner setTimeout fires
			mockSetTyping.mockImplementation((fn: (prev: Record<string, unknown[]>) => Record<string, unknown[]>) => {
				if (typeof fn === "function") fn({})
			})

			const event = makeTypingEvent(ChatTypingType.Down, "chat-1", OTHER_USER_ID)

			await handleChatEvent({ event, userId: USER_ID })

			// The first call is the outer setTyping — the updater runs and sets the 10s timeout
			expect(mockSetTyping).toHaveBeenCalledOnce()

			// Advance past the 10s auto-removal timeout
			vi.advanceTimersByTime(10000)

			// The timeout callback fires, calling setTyping a second time to clear the indicator
			expect(mockSetTyping.mock.calls.length).toBeGreaterThanOrEqual(2)
		})
	})

	describe("ChatEvent_Tags.Typing — Up", () => {
		it("removes typing indicator for the sender in the chat", async () => {
			const event = makeTypingEvent(ChatTypingType.Up, "chat-1", OTHER_USER_ID)

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockSetTyping).toHaveBeenCalledOnce()

			const updater = mockSetTyping.mock.calls[0]?.[0] as (prev: Record<string, unknown[]>) => Record<string, unknown[]>
			const prev = {
				"chat-1": [
					{ senderId: OTHER_USER_ID, chat: "chat-1" },
					{ senderId: 999n, chat: "chat-1" }
				]
			}
			const result = updater(prev)

			expect((result["chat-1"] as Array<{ senderId: bigint }>).some(t => t.senderId === OTHER_USER_ID)).toBe(false)
			expect((result["chat-1"] as Array<{ senderId: bigint }>).some(t => t.senderId === 999n)).toBe(true)
		})
	})

	// ---------------------------------------------------------------------------
	// MessageNew — other user (1ms delay) and self (3000ms delay)
	// ---------------------------------------------------------------------------

	describe("ChatEvent_Tags.MessageNew — from other user (1ms delay)", () => {
		it("calls chatMessagesQueryUpdate after the 1ms delay", async () => {
			const event = makeMessageNewEvent("chat-1", "msg-1", OTHER_USER_ID)

			await handleChatEvent({ event, userId: USER_ID })

			// Before the timeout fires — not yet called
			expect(mockChatMessagesQueryUpdate).not.toHaveBeenCalled()

			vi.advanceTimersByTime(1)

			expect(mockChatMessagesQueryUpdate).toHaveBeenCalledOnce()
		})

		it("the updater adds the new message and deduplicates by uuid", async () => {
			const event = makeMessageNewEvent("chat-1", "msg-1", OTHER_USER_ID)

			await handleChatEvent({ event, userId: USER_ID })
			vi.advanceTimersByTime(1)

			const { updater } = mockChatMessagesQueryUpdate.mock.calls[0]![0] as {
				updater: (prev: Array<{ inner: { uuid: string } }>) => Array<{ inner: { uuid: string } }>
			}

			// Existing message with same uuid should be replaced (dedup)
			const prev = [{ inner: { uuid: "msg-1" }, undecryptable: false }]
			const result = updater(prev)

			expect(result).toHaveLength(1)
			expect(result[0]!.inner.uuid).toBe("msg-1")
		})

		it("clears the typing indicator for the sender immediately", async () => {
			const event = makeMessageNewEvent("chat-1", "msg-1", OTHER_USER_ID)

			await handleChatEvent({ event, userId: USER_ID })

			// setTyping is called immediately (not delayed) to clear the indicator
			expect(mockSetTyping).toHaveBeenCalledOnce()
			const updater = mockSetTyping.mock.calls[0]?.[0] as (prev: Record<string, unknown[]>) => Record<string, unknown[]>
			const prev = { "chat-1": [{ senderId: OTHER_USER_ID }] }
			const result = updater(prev)
			expect((result["chat-1"] as Array<{ senderId: bigint }>).some(t => t.senderId === OTHER_USER_ID)).toBe(false)
		})

		it("calls chatsQueryUpdate after an additional 1ms to update lastMessage", async () => {
			const event = makeMessageNewEvent("chat-1", "msg-1", OTHER_USER_ID)

			await handleChatEvent({ event, userId: USER_ID })

			// Advance past both timeouts (1ms outer + 1ms inner)
			vi.advanceTimersByTime(2)

			expect(mockChatsQueryUpdate).toHaveBeenCalledOnce()
		})
	})

	describe("ChatEvent_Tags.MessageNew — from self (3000ms delay)", () => {
		it("does NOT call chatMessagesQueryUpdate before 3 seconds", async () => {
			const event = makeMessageNewEvent("chat-1", "msg-1", USER_ID)

			await handleChatEvent({ event, userId: USER_ID })

			vi.advanceTimersByTime(2999)

			expect(mockChatMessagesQueryUpdate).not.toHaveBeenCalled()
		})

		it("calls chatMessagesQueryUpdate after 3 seconds have passed", async () => {
			const event = makeMessageNewEvent("chat-1", "msg-1", USER_ID)

			await handleChatEvent({ event, userId: USER_ID })

			vi.advanceTimersByTime(3000)

			expect(mockChatMessagesQueryUpdate).toHaveBeenCalledOnce()
		})
	})

	// ---------------------------------------------------------------------------
	// ConversationNameEdited
	// ---------------------------------------------------------------------------

	describe("ChatEvent_Tags.ConversationNameEdited", () => {
		it("Decrypted: renames the matching chat", async () => {
			const event = makeConversationNameEditedEvent("chat-1", {
				tag: MaybeEncryptedUniffi_Tags.Decrypted,
				inner: ["New Chat Name"]
			})

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockChatsQueryUpdate).toHaveBeenCalledOnce()

			const updater = capturedChatsUpdaters[0]!
			const prev = [
				{ uuid: "chat-1", name: "Old Name" },
				{ uuid: "chat-2", name: "Other Chat" }
			]
			const result = updater(prev) as Array<Record<string, unknown>>

			expect(result[0]).toMatchObject({ uuid: "chat-1", name: "New Chat Name" })
			expect(result[1]).toMatchObject({ uuid: "chat-2", name: "Other Chat" })
		})

		it("Encrypted: does NOT call chatsQueryUpdate (skip path)", async () => {
			const event = makeConversationNameEditedEvent("chat-1", {
				tag: MaybeEncryptedUniffi_Tags.Encrypted,
				inner: ["encryptedBlob"]
			})

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockChatsQueryUpdate).not.toHaveBeenCalled()
		})
	})

	// ---------------------------------------------------------------------------
	// MessageEdited
	// ---------------------------------------------------------------------------

	describe("ChatEvent_Tags.MessageEdited", () => {
		it("Decrypted: updates message content for matching uuid", async () => {
			const event = makeMessageEditedEvent("chat-1", "msg-1", {
				tag: MaybeEncryptedUniffi_Tags.Decrypted,
				inner: ["Updated content"]
			})

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockChatMessagesQueryUpdate).toHaveBeenCalledOnce()

			const updater = capturedMessagesUpdaters[0]!
			const prev = [
				{ inner: { uuid: "msg-1", message: "Original", senderId: OTHER_USER_ID }, undecryptable: false },
				{ inner: { uuid: "msg-2", message: "Keep me", senderId: OTHER_USER_ID }, undecryptable: false }
			]
			const result = updater(prev) as Array<Record<string, unknown>>

			expect((result[0]!["inner"] as Record<string, unknown>)["message"]).toBe("Updated content")
			expect((result[1]!["inner"] as Record<string, unknown>)["message"]).toBe("Keep me")
		})

		it("Encrypted: does NOT call chatMessagesQueryUpdate (skip path)", async () => {
			const event = makeMessageEditedEvent("chat-1", "msg-1", {
				tag: MaybeEncryptedUniffi_Tags.Encrypted,
				inner: ["encryptedBlob"]
			})

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockChatMessagesQueryUpdate).not.toHaveBeenCalled()
		})
	})

	// ---------------------------------------------------------------------------
	// MessageDelete
	// ---------------------------------------------------------------------------

	describe("ChatEvent_Tags.MessageDelete", () => {
		it("removes the message from the chat that contains it", async () => {
			// chatsQueryGet returns a list of chats; chatMessagesQueryGet returns messages per chat
			mockChatsQueryGet.mockReturnValue([{ uuid: "chat-1" }, { uuid: "chat-2" }])
			// chat-1 has the message, chat-2 does not
			mockChatMessagesQueryGet.mockImplementation(({ uuid }: { uuid: string }) => {
				if (uuid === "chat-1") return [{ inner: { uuid: "msg-del" } }]
				return []
			})

			const event = makeMessageDeleteEvent("msg-del")

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockChatMessagesQueryUpdate).toHaveBeenCalledOnce()

			const { params, updater } = mockChatMessagesQueryUpdate.mock.calls[0]![0] as {
				params: { uuid: string }
				updater: (prev: Array<{ inner: { uuid: string } }>) => Array<{ inner: { uuid: string } }>
			}

			expect(params.uuid).toBe("chat-1")

			const prev = [{ inner: { uuid: "msg-del" } }, { inner: { uuid: "msg-keep" } }]
			const result = updater(prev)

			expect(result).toHaveLength(1)
			expect(result[0]!.inner.uuid).toBe("msg-keep")
		})

		it("no-op when the message is not found in any chat", async () => {
			mockChatsQueryGet.mockReturnValue([{ uuid: "chat-1" }])
			mockChatMessagesQueryGet.mockReturnValue([{ inner: { uuid: "msg-other" } }])

			const event = makeMessageDeleteEvent("msg-not-found")

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockChatMessagesQueryUpdate).not.toHaveBeenCalled()
		})

		it("no-op when chatsQueryGet returns null/undefined", async () => {
			mockChatsQueryGet.mockReturnValue(undefined)

			const event = makeMessageDeleteEvent("msg-1")

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockChatMessagesQueryUpdate).not.toHaveBeenCalled()
		})
	})

	// ---------------------------------------------------------------------------
	// MessageEmbedDisabled
	// ---------------------------------------------------------------------------

	describe("ChatEvent_Tags.MessageEmbedDisabled", () => {
		it("sets embedsDisabled=true on the matching message", async () => {
			mockChatsQueryGet.mockReturnValue([{ uuid: "chat-1" }])
			mockChatMessagesQueryGet.mockImplementation(({ uuid }: { uuid: string }) => {
				if (uuid === "chat-1") return [{ inner: { uuid: "msg-embed" } }]
				return []
			})

			const event = makeMessageEmbedDisabledEvent("msg-embed")

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockChatMessagesQueryUpdate).toHaveBeenCalledOnce()

			const updater = capturedMessagesUpdaters[0]!
			const prev = [{ inner: { uuid: "msg-embed", embedsDisabled: false } }, { inner: { uuid: "msg-other", embedsDisabled: false } }]
			const result = updater(prev) as Array<Record<string, unknown>>

			expect((result[0]!["inner"] as Record<string, unknown>)["embedsDisabled"]).toBe(true)
			expect((result[1]!["inner"] as Record<string, unknown>)["embedsDisabled"]).toBe(false)
		})

		it("no-op when the message is not found in any chat", async () => {
			mockChatsQueryGet.mockReturnValue([{ uuid: "chat-1" }])
			mockChatMessagesQueryGet.mockReturnValue([])

			const event = makeMessageEmbedDisabledEvent("msg-not-found")

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockChatMessagesQueryUpdate).not.toHaveBeenCalled()
		})
	})

	// ---------------------------------------------------------------------------
	// ConversationsNew
	// ---------------------------------------------------------------------------

	describe("ChatEvent_Tags.ConversationsNew", () => {
		it("adds the new chat (deduplicates by uuid)", async () => {
			const newChat = { uuid: "chat-new", name: "New Chat" }
			const event = makeConversationsNewEvent(newChat)

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockChatsQueryUpdate).toHaveBeenCalledOnce()

			const updater = capturedChatsUpdaters[0]!
			const prev = [
				{ uuid: "chat-old", name: "Existing" },
				{ uuid: "chat-new", name: "Stale Duplicate" } // should be replaced
			]
			const result = updater(prev) as Array<Record<string, unknown>>

			const chatNew = result.find(c => c["uuid"] === "chat-new")
			expect(chatNew).toBeDefined()
			// Only one entry for chat-new (dedup removes the stale one)
			expect(result.filter(c => c["uuid"] === "chat-new")).toHaveLength(1)
		})
	})

	// ---------------------------------------------------------------------------
	// ConversationDeleted
	// ---------------------------------------------------------------------------

	describe("ChatEvent_Tags.ConversationDeleted", () => {
		it("emits chatConversationDeleted immediately when the chat is found", async () => {
			mockChatsQueryGet.mockReturnValue([{ uuid: "chat-gone" }])

			const event = makeConversationDeletedEvent("chat-gone")

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockEventsEmit).toHaveBeenCalledOnce()
			expect(mockEventsEmit).toHaveBeenCalledWith("chatConversationDeleted", { uuid: "chat-gone" })
		})

		it("does NOT emit when the chat is not found", async () => {
			mockChatsQueryGet.mockReturnValue([{ uuid: "chat-other" }])

			const event = makeConversationDeletedEvent("chat-gone")

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockEventsEmit).not.toHaveBeenCalled()
		})

		it("clears messages query and filters out deleted chat after 3s timeout", async () => {
			mockChatsQueryGet.mockReturnValue([{ uuid: "chat-gone" }])

			const event = makeConversationDeletedEvent("chat-gone")

			await handleChatEvent({ event, userId: USER_ID })

			// Neither messages nor chats update should fire immediately
			expect(mockChatMessagesQueryUpdate).not.toHaveBeenCalled()
			// chatsQueryUpdate deferred (not yet called)
			// Note: only the emit fires immediately, updates are deferred by 3s

			vi.advanceTimersByTime(3000)

			// After 3s: messages cleared + chat removed
			expect(mockChatMessagesQueryUpdate).toHaveBeenCalledOnce()
			expect(mockChatsQueryUpdate).toHaveBeenCalledOnce()

			// Messages updater returns empty array
			const messagesUpdater = capturedMessagesUpdaters[0]!
			expect(messagesUpdater(["anything" as unknown])).toEqual([])

			// Chats updater filters out the deleted chat
			const chatsUpdater = capturedChatsUpdaters[0]!
			const prev = [{ uuid: "chat-gone" }, { uuid: "chat-keep" }]
			const result = chatsUpdater(prev) as Array<{ uuid: string }>
			expect(result).toHaveLength(1)
			expect(result[0]!.uuid).toBe("chat-keep")
		})
	})

	// ---------------------------------------------------------------------------
	// ConversationParticipantLeft
	// ---------------------------------------------------------------------------

	describe("ChatEvent_Tags.ConversationParticipantLeft", () => {
		it("removes the participant with the matching userId", async () => {
			mockChatsQueryGet.mockReturnValue([
				{
					uuid: "chat-1",
					participants: [{ userId: OTHER_USER_ID }, { userId: 999n }]
				}
			])

			const event = makeConversationParticipantLeftEvent("chat-1", OTHER_USER_ID)

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockChatsQueryUpdate).toHaveBeenCalledOnce()

			const updater = capturedChatsUpdaters[0]!
			const prev = [
				{
					uuid: "chat-1",
					participants: [{ userId: OTHER_USER_ID }, { userId: 999n }]
				}
			]
			const result = updater(prev) as Array<Record<string, unknown>>
			const participants = result[0]?.["participants"] as Array<{ userId: bigint }>

			expect(participants.some(p => p.userId === OTHER_USER_ID)).toBe(false)
			expect(participants.some(p => p.userId === 999n)).toBe(true)
		})

		it("no-op when the chat is not found", async () => {
			mockChatsQueryGet.mockReturnValue([{ uuid: "chat-other" }])

			const event = makeConversationParticipantLeftEvent("chat-1", OTHER_USER_ID)

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockChatsQueryUpdate).not.toHaveBeenCalled()
		})
	})

	// ---------------------------------------------------------------------------
	// ConversationParticipantNew
	// ---------------------------------------------------------------------------

	describe("ChatEvent_Tags.ConversationParticipantNew", () => {
		it("appends a new participant to the matching chat", async () => {
			const newParticipant = { userId: 500n, email: "new@example.com" }
			mockChatsQueryGet.mockReturnValue([{ uuid: "chat-1", participants: [{ userId: OTHER_USER_ID }] }])

			const event = makeConversationParticipantNewEvent("chat-1", newParticipant)

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockChatsQueryUpdate).toHaveBeenCalledOnce()

			const updater = capturedChatsUpdaters[0]!
			const prev = [{ uuid: "chat-1", participants: [{ userId: OTHER_USER_ID }] }]
			const result = updater(prev) as Array<Record<string, unknown>>
			const participants = result[0]?.["participants"] as Array<{ userId: bigint }>

			expect(participants).toHaveLength(2)
			expect(participants.some(p => p.userId === 500n)).toBe(true)
		})

		it("upserts — replaces existing participant with same userId", async () => {
			const updatedParticipant = { userId: OTHER_USER_ID, email: "updated@example.com" }
			mockChatsQueryGet.mockReturnValue([{ uuid: "chat-1", participants: [{ userId: OTHER_USER_ID, email: "old@example.com" }] }])

			const event = makeConversationParticipantNewEvent("chat-1", updatedParticipant)

			await handleChatEvent({ event, userId: USER_ID })

			const updater = capturedChatsUpdaters[0]!
			const prev = [{ uuid: "chat-1", participants: [{ userId: OTHER_USER_ID, email: "old@example.com" }] }]
			const result = updater(prev) as Array<Record<string, unknown>>
			const participants = result[0]?.["participants"] as Array<{ userId: bigint; email: string }>

			expect(participants).toHaveLength(1)
			expect(participants[0]!.email).toBe("updated@example.com")
		})

		it("no-op when the chat is not found", async () => {
			mockChatsQueryGet.mockReturnValue([{ uuid: "chat-other" }])

			const event = makeConversationParticipantNewEvent("chat-1", { userId: 500n })

			await handleChatEvent({ event, userId: USER_ID })

			expect(mockChatsQueryUpdate).not.toHaveBeenCalled()
		})
	})

	// ---------------------------------------------------------------------------
	// Default — unhandled event tag
	// ---------------------------------------------------------------------------

	describe("default case — unhandled event tag", () => {
		it("throws 'Unhandled chat event' for an unknown event tag", async () => {
			await expect(handleChatEvent({ event: makeUnknownTagEvent(), userId: USER_ID })).rejects.toThrow("Unhandled chat event")
		})
	})
})
