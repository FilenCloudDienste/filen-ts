import { vi, describe, it, expect, beforeEach } from "vitest"

const { chatsState, mockSetInflightMessages, mockSetInflightErrors, mockFlushToDisk, mockSyncNow, mockSecureStoreRemove, mockChatMessagesQueryUpdate } =
	vi.hoisted(() => {
		const chatsState = {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			inflightMessages: {} as Record<string, any>,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			inflightErrors: {} as Record<string, any>
		}

		return {
			chatsState,
			mockSetInflightMessages: vi.fn((fn: unknown) => {
				if (typeof fn === "function") {
					chatsState.inflightMessages = fn(chatsState.inflightMessages)
				} else {
					chatsState.inflightMessages = fn as typeof chatsState.inflightMessages
				}
			}),
			mockSetInflightErrors: vi.fn((fn: unknown) => {
				if (typeof fn === "function") {
					chatsState.inflightErrors = fn(chatsState.inflightErrors)
				} else {
					chatsState.inflightErrors = fn as typeof chatsState.inflightErrors
				}
			}),
			mockFlushToDisk: vi.fn().mockResolvedValue(undefined),
			mockSyncNow: vi.fn(),
			mockSecureStoreRemove: vi.fn().mockResolvedValue(undefined),
			mockChatMessagesQueryUpdate: vi.fn()
		}
	})

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("@/features/chats/store/useChats.store", () => ({
	default: {
		getState: () => ({
			inflightMessages: chatsState.inflightMessages,
			setInflightMessages: mockSetInflightMessages,
			inflightErrors: chatsState.inflightErrors,
			setInflightErrors: mockSetInflightErrors
		})
	}
}))

vi.mock("@/features/chats/components/sync", () => ({
	sync: {
		flushToDisk: mockFlushToDisk,
		syncNow: mockSyncNow
	}
}))

vi.mock("@/lib/secureStore", () => ({
	default: {
		remove: mockSecureStoreRemove
	}
}))

vi.mock("@/features/chats/queries/useChatMessages.query", () => ({
	chatMessagesQueryUpdate: mockChatMessagesQueryUpdate
}))

import {
	purgeChatInflightState,
	retryInflightMessage,
	removeInflightMessage,
	chatDraftSecureStoreKeys
} from "@/features/chats/chatsInflight"
import type { Chat } from "@/types"
import type { ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"

function mockChat(uuid: string): Chat {
	return { uuid } as Chat
}

function mockMessage(inflightId: string, chatUuid: string, message = "hello"): ChatMessageWithInflightId {
	return {
		inflightId,
		chat: chatUuid,
		inner: { uuid: inflightId, message },
		sentTimestamp: BigInt(1000)
	} as unknown as ChatMessageWithInflightId
}

function mockErrorEntry(inflightId: string, chatUuid: string) {
	return {
		error: new Error("send failed"),
		permanentRejections: 3,
		message: mockMessage(inflightId, chatUuid)
	}
}

describe("chatsInflight", () => {
	beforeEach(() => {
		chatsState.inflightMessages = {}
		chatsState.inflightErrors = {}
		mockSetInflightMessages.mockClear()
		mockSetInflightErrors.mockClear()
		mockFlushToDisk.mockClear()
		mockFlushToDisk.mockResolvedValue(undefined)
		mockSyncNow.mockClear()
		mockSecureStoreRemove.mockClear()
		mockSecureStoreRemove.mockResolvedValue(undefined)
		mockChatMessagesQueryUpdate.mockClear()
	})

	describe("chatDraftSecureStoreKeys", () => {
		it("returns the three per-chat draft keys used by the chat input", () => {
			expect(chatDraftSecureStoreKeys("chat-1")).toEqual(["chatInputValue:chat-1", "chatReplyTo:chat-1", "chatEditMessage:chat-1"])
		})
	})

	describe("purgeChatInflightState (D4b + M5)", () => {
		it("removes the chat's queued messages and leaves other chats' queues untouched", async () => {
			chatsState.inflightMessages = {
				"chat-1": { chat: mockChat("chat-1"), messages: [mockMessage("msg-1", "chat-1")] },
				"chat-2": { chat: mockChat("chat-2"), messages: [mockMessage("msg-2", "chat-2")] }
			}

			await purgeChatInflightState("chat-1")

			expect(chatsState.inflightMessages["chat-1"]).toBeUndefined()
			expect(chatsState.inflightMessages["chat-2"]).toBeDefined()
		})

		it("removes only the chat's error entries (matched by the snapshot's chat uuid)", async () => {
			chatsState.inflightErrors = {
				"msg-1": mockErrorEntry("msg-1", "chat-1"),
				"msg-2": mockErrorEntry("msg-2", "chat-1"),
				"msg-other": mockErrorEntry("msg-other", "chat-2")
			}

			await purgeChatInflightState("chat-1")

			expect(chatsState.inflightErrors["msg-1"]).toBeUndefined()
			expect(chatsState.inflightErrors["msg-2"]).toBeUndefined()
			expect(chatsState.inflightErrors["msg-other"]).toBeDefined()
		})

		it("flushes the post-purge queue to disk", async () => {
			chatsState.inflightMessages = {
				"chat-1": { chat: mockChat("chat-1"), messages: [mockMessage("msg-1", "chat-1")] },
				"chat-2": { chat: mockChat("chat-2"), messages: [mockMessage("msg-2", "chat-2")] }
			}

			await purgeChatInflightState("chat-1")

			expect(mockFlushToDisk).toHaveBeenCalledTimes(1)

			const flushed = mockFlushToDisk.mock.calls[0]![0] as Record<string, unknown>

			expect(flushed["chat-1"]).toBeUndefined()
			expect(flushed["chat-2"]).toBeDefined()
		})

		it("removes the three per-chat draft keys (M5)", async () => {
			await purgeChatInflightState("chat-1")

			expect(mockSecureStoreRemove).toHaveBeenCalledTimes(3)
			expect(mockSecureStoreRemove).toHaveBeenCalledWith("chatInputValue:chat-1")
			expect(mockSecureStoreRemove).toHaveBeenCalledWith("chatReplyTo:chat-1")
			expect(mockSecureStoreRemove).toHaveBeenCalledWith("chatEditMessage:chat-1")
		})

		it("never throws when secureStore.remove rejects — the store purge still completed", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			try {
				chatsState.inflightMessages = {
					"chat-1": { chat: mockChat("chat-1"), messages: [mockMessage("msg-1", "chat-1")] }
				}

				mockSecureStoreRemove.mockRejectedValue(new Error("keychain unavailable"))

				await expect(purgeChatInflightState("chat-1")).resolves.toBeUndefined()

				expect(chatsState.inflightMessages["chat-1"]).toBeUndefined()
				expect(consoleErrorSpy).toHaveBeenCalled()
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})

		it("never throws when the flush rejects — draft keys are still removed", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			try {
				mockFlushToDisk.mockRejectedValue(new Error("disk full"))

				await expect(purgeChatInflightState("chat-1")).resolves.toBeUndefined()

				expect(mockSecureStoreRemove).toHaveBeenCalledTimes(3)
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})

		it("leaves the store references unchanged when there is nothing to purge", async () => {
			const messagesBefore = {
				"chat-2": { chat: mockChat("chat-2"), messages: [mockMessage("msg-2", "chat-2")] }
			}
			const errorsBefore = {
				"msg-other": mockErrorEntry("msg-other", "chat-2")
			}

			chatsState.inflightMessages = messagesBefore
			chatsState.inflightErrors = errorsBefore

			await purgeChatInflightState("chat-1")

			// Functional updaters bail with the same reference — no spurious subscriber churn.
			expect(chatsState.inflightMessages).toBe(messagesBefore)
			expect(chatsState.inflightErrors).toBe(errorsBefore)
		})
	})

	describe("retryInflightMessage (D4c)", () => {
		it("re-enqueues a dropped message from the error snapshot, clears the error, flushes and kicks a sync", async () => {
			const chat = mockChat("chat-1")
			const snapshot = mockMessage("msg-1", "chat-1", "snapshot copy")

			// The 3-strike drop removed it from the queue; only the error entry remains.
			chatsState.inflightMessages = {}
			chatsState.inflightErrors = {
				"msg-1": {
					error: new Error("forbidden"),
					permanentRejections: 3,
					message: snapshot
				}
			}

			await retryInflightMessage({
				chat,
				message: mockMessage("msg-1", "chat-1", "rendered copy")
			})

			// Re-enqueued from the error snapshot (authoritative for dropped messages).
			expect(chatsState.inflightMessages["chat-1"]).toBeDefined()
			expect(chatsState.inflightMessages["chat-1"]!.messages).toHaveLength(1)
			expect(chatsState.inflightMessages["chat-1"]!.messages[0]).toBe(snapshot)

			// Error/strike state cleared so the bubble returns to pending with a fresh budget.
			expect(chatsState.inflightErrors["msg-1"]).toBeUndefined()

			// Queue persisted and a sync pass kicked.
			expect(mockFlushToDisk).toHaveBeenCalledTimes(1)
			expect(mockSyncNow).toHaveBeenCalledTimes(1)
		})

		it("does not enqueue a duplicate when the message is still queued — still clears the error and kicks a sync", async () => {
			const chat = mockChat("chat-1")
			const queued = mockMessage("msg-1", "chat-1")

			chatsState.inflightMessages = {
				"chat-1": { chat, messages: [queued] }
			}
			chatsState.inflightErrors = {
				"msg-1": {
					error: new Error("server error"),
					permanentRejections: 1,
					message: queued
				}
			}

			await retryInflightMessage({ chat, message: queued })

			expect(chatsState.inflightMessages["chat-1"]!.messages).toHaveLength(1)
			expect(chatsState.inflightErrors["msg-1"]).toBeUndefined()
			expect(mockSyncNow).toHaveBeenCalledTimes(1)
		})

		it("appends to an existing chat queue without touching its other messages", async () => {
			const chat = mockChat("chat-1")
			const otherQueued = mockMessage("msg-other", "chat-1")

			chatsState.inflightMessages = {
				"chat-1": { chat, messages: [otherQueued] }
			}
			chatsState.inflightErrors = {
				"msg-1": mockErrorEntry("msg-1", "chat-1")
			}

			await retryInflightMessage({ chat, message: mockMessage("msg-1", "chat-1") })

			const ids = (chatsState.inflightMessages["chat-1"]!.messages as { inflightId: string }[]).map(m => m.inflightId)

			expect(ids).toHaveLength(2)
			expect(ids).toContain("msg-other")
			expect(ids).toContain("msg-1")
		})

		it("falls back to the rendered message when no error snapshot exists", async () => {
			const chat = mockChat("chat-1")
			const rendered = mockMessage("msg-1", "chat-1", "rendered copy")

			await retryInflightMessage({ chat, message: rendered })

			expect(chatsState.inflightMessages["chat-1"]!.messages[0]).toBe(rendered)
		})
	})

	describe("removeInflightMessage (D4c)", () => {
		it("drops the message from the queue, its error entry and the query-cache copy, then flushes", async () => {
			const chat = mockChat("chat-1")
			const queued = mockMessage("msg-1", "chat-1")
			const otherQueued = mockMessage("msg-other", "chat-1")

			chatsState.inflightMessages = {
				"chat-1": { chat, messages: [queued, otherQueued] }
			}
			chatsState.inflightErrors = {
				"msg-1": mockErrorEntry("msg-1", "chat-1")
			}

			await removeInflightMessage({ chat, message: queued })

			// Queue: only the other message remains.
			const ids = (chatsState.inflightMessages["chat-1"]!.messages as { inflightId: string }[]).map(m => m.inflightId)

			expect(ids).toEqual(["msg-other"])

			// Error entry gone.
			expect(chatsState.inflightErrors["msg-1"]).toBeUndefined()

			// The optimistic query-cache copy is dropped immediately (no lingering bubble).
			expect(mockChatMessagesQueryUpdate).toHaveBeenCalledTimes(1)
			expect(mockChatMessagesQueryUpdate.mock.calls[0]![0].params).toEqual({ uuid: "chat-1" })

			const updater = mockChatMessagesQueryUpdate.mock.calls[0]![0].updater as (
				prev: ChatMessageWithInflightId[]
			) => ChatMessageWithInflightId[]
			const cacheAfter = updater([queued, mockMessage("msg-committed", "chat-1")])

			expect(cacheAfter.map(m => m.inflightId)).toEqual(["msg-committed"])

			// Queue persisted.
			expect(mockFlushToDisk).toHaveBeenCalledTimes(1)
		})

		it("removes the chat's queue entry entirely when the removed message was the last one", async () => {
			const chat = mockChat("chat-1")
			const queued = mockMessage("msg-1", "chat-1")

			chatsState.inflightMessages = {
				"chat-1": { chat, messages: [queued] }
			}

			await removeInflightMessage({ chat, message: queued })

			expect(chatsState.inflightMessages["chat-1"]).toBeUndefined()
		})

		it("handles a message already dropped from the queue (3-strike) — clears the error, cache copy and flushes", async () => {
			const chat = mockChat("chat-1")
			const dropped = mockMessage("msg-1", "chat-1")

			chatsState.inflightMessages = {}
			chatsState.inflightErrors = {
				"msg-1": mockErrorEntry("msg-1", "chat-1")
			}

			await removeInflightMessage({ chat, message: dropped })

			expect(chatsState.inflightErrors["msg-1"]).toBeUndefined()
			expect(mockChatMessagesQueryUpdate).toHaveBeenCalledTimes(1)
			expect(mockFlushToDisk).toHaveBeenCalledTimes(1)
		})
	})
})
