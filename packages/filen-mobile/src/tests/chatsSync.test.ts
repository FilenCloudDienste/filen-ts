import { vi, describe, it, expect, beforeEach } from "vitest"

const { kvStore, chatsState, mockSendMessage, mockFetchChats } = vi.hoisted(() => ({
	kvStore: new Map<string, unknown>(),
	chatsState: {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		inflightMessages: {} as Record<string, any>,
		inflightErrors: {} as Record<string, Error>
	},
	mockSendMessage: vi.fn().mockResolvedValue({
		chat: { uuid: "chat-1" },
		message: { inner: { uuid: "msg-1" } }
	}),
	mockFetchChats: vi.fn().mockResolvedValue([])
}))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", () => ({
	run: vi.fn(async (fn: Function) => {
		const defers: Function[] = []

		try {
			const data = await fn((cb: Function) => {
				defers.push(cb)
			})

			for (const d of defers.reverse()) {
				await d()
			}

			return { success: true, data }
		} catch (error) {
			for (const d of defers.reverse()) {
				try {
					await d()
				} catch {}
			}

			return { success: false, error }
		}
	}),
	Semaphore: class {
		acquire() {
			return Promise.resolve()
		}
		release() {}
	}
}))

vi.mock("@/lib/sqlite", () => ({
	default: {
		kvAsync: {
			get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
			set: vi.fn(async (key: string, value: unknown) => {
				kvStore.set(key, value)
			}),
			remove: vi.fn(async (key: string) => {
				kvStore.delete(key)
			})
		}
	}
}))

vi.mock("@/stores/useChats.store", () => {
	const mockSetInflightMessages = vi.fn((fn: unknown) => {
		if (typeof fn === "function") {
			chatsState.inflightMessages = fn(chatsState.inflightMessages)
		} else {
			chatsState.inflightMessages = fn as typeof chatsState.inflightMessages
		}
	})

	const mockSetInflightErrors = vi.fn((fn: unknown) => {
		if (typeof fn === "function") {
			chatsState.inflightErrors = fn(chatsState.inflightErrors)
		} else {
			chatsState.inflightErrors = fn as typeof chatsState.inflightErrors
		}
	})

	return {
		default: {
			getState: () => ({
				inflightMessages: chatsState.inflightMessages,
				setInflightMessages: mockSetInflightMessages,
				inflightErrors: chatsState.inflightErrors,
				setInflightErrors: mockSetInflightErrors
			})
		}
	}
})

vi.mock("@/lib/chats", () => ({
	default: {
		sendMessage: mockSendMessage
	}
}))

vi.mock("@/queries/useChats.query", () => ({
	fetchData: mockFetchChats
}))

vi.mock("@/lib/alerts", () => ({
	default: {
		error: vi.fn()
	}
}))

vi.mock("@filen/sdk-rs", () => ({
	FilenSdkError: {
		hasInner: () => false,
		getInner: () => new Error("sdk error")
	}
}))

import { Sync } from "@/components/chats/sync"
import sqlite from "@/lib/sqlite"
import type { InflightChatMessages } from "@/stores/useChats.store"

const KV_KEY = "inflightChatMessages"

function mockChat(uuid: string) {
	return { uuid } as InflightChatMessages[string]["chat"]
}

function mockMessage(inflightId: string, message: string, sentTimestamp: number) {
	return {
		inflightId,
		inner: { message },
		sentTimestamp: BigInt(sentTimestamp)
	} as InflightChatMessages[string]["messages"][number]
}

async function createSync(): Promise<Sync> {
	const sync = new Sync()

	sync.start()

	await (sync as unknown as { initPromise: Promise<void> }).initPromise

	return sync
}

describe("Sync (Chats)", () => {
	beforeEach(() => {
		kvStore.clear()
		chatsState.inflightMessages = {}
		chatsState.inflightErrors = {}
		mockSendMessage.mockClear()
		mockFetchChats.mockResolvedValue([])
		vi.mocked(sqlite.kvAsync.get).mockClear()
		vi.mocked(sqlite.kvAsync.set).mockClear()
		vi.mocked(sqlite.kvAsync.remove).mockClear()
	})

	describe("restoreFromDisk", () => {
		it("loads inflight messages from disk and sets store", async () => {
			kvStore.set(KV_KEY, {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "hello", 1000)]
				}
			})

			mockFetchChats.mockResolvedValue([{ uuid: "chat-1" }])

			await createSync()

			expect(chatsState.inflightMessages["chat-1"]).toBeDefined()
			expect(chatsState.inflightMessages["chat-1"]!.messages).toHaveLength(1)
		})

		it("prunes messages for chats that no longer exist", async () => {
			kvStore.set(KV_KEY, {
				"deleted-chat": {
					chat: mockChat("deleted-chat"),
					messages: [mockMessage("msg-1", "gone", 1000)]
				}
			})

			mockFetchChats.mockResolvedValue([])

			await createSync()

			expect(chatsState.inflightMessages["deleted-chat"]).toBeUndefined()
		})

		it("handles empty disk gracefully", async () => {
			await createSync()

			expect(chatsState.inflightMessages).toEqual({})
		})

		it("triggers sync when restored data exists", async () => {
			kvStore.set(KV_KEY, {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "pending", 1000)]
				}
			})

			mockFetchChats.mockResolvedValue([{ uuid: "chat-1" }])

			await createSync()

			// sync() is fire-and-forget after restore — wait for it to settle
			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockSendMessage).toHaveBeenCalled()
		})

		it("handles mixed data: some chats valid, some pruned", async () => {
			kvStore.set(KV_KEY, {
				"chat-valid": {
					chat: mockChat("chat-valid"),
					messages: [mockMessage("msg-1", "keep", 1000)]
				},
				"chat-deleted": {
					chat: mockChat("chat-deleted"),
					messages: [mockMessage("msg-2", "gone", 1000)]
				}
			})

			mockFetchChats.mockResolvedValue([{ uuid: "chat-valid" }])

			await createSync()

			expect(chatsState.inflightMessages["chat-valid"]).toBeDefined()
			expect(chatsState.inflightMessages["chat-deleted"]).toBeUndefined()
		})

		it("resolves init even on failure", async () => {
			vi.mocked(sqlite.kvAsync.get).mockRejectedValueOnce(new Error("disk error"))

			const sync = await createSync()

			await sync.flushToDisk({})
		})
	})

	describe("flushToDisk", () => {
		it("writes filtered messages to sqlite", async () => {
			const sync = await createSync()
			const data = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "hello", 1000)]
				}
			}

			await sync.flushToDisk(data)

			expect(kvStore.get(KV_KEY)).toEqual(data)
		})

		it("removes sqlite key when all messages are empty", async () => {
			kvStore.set(KV_KEY, { "chat-1": { chat: mockChat("chat-1"), messages: [] } })

			const sync = await createSync()

			await sync.flushToDisk({
				"chat-1": { chat: mockChat("chat-1"), messages: [] }
			} as any)

			expect(kvStore.has(KV_KEY)).toBe(false)
		})

		it("filters out entries with empty messages before writing", async () => {
			const sync = await createSync()

			await sync.flushToDisk({
				"chat-1": { chat: mockChat("chat-1"), messages: [mockMessage("msg-1", "hello", 1000)] },
				"chat-2": { chat: mockChat("chat-2"), messages: [] }
			} as any)

			const stored = kvStore.get(KV_KEY) as Record<string, unknown>

			expect(stored["chat-1"]).toBeDefined()
			expect(stored["chat-2"]).toBeUndefined()
		})

		it("waits for init before flushing", async () => {
			const sync = new Sync()

			sync.start()

			const data = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "hello", 1000)]
				}
			}

			await sync.flushToDisk(data as any)

			expect(kvStore.get(KV_KEY)).toEqual(data)
		})

		it("does not mutate input parameter", async () => {
			const sync = await createSync()
			const data = {
				"chat-1": { chat: mockChat("chat-1"), messages: [mockMessage("msg-1", "hello", 1000)] },
				"chat-2": { chat: mockChat("chat-2"), messages: [] }
			} as any

			const keysBefore = Object.keys(data)

			await sync.flushToDisk(data)

			expect(Object.keys(data)).toEqual(keysBefore)
		})
	})

	describe("sync", () => {
		it("sends messages in timestamp order", async () => {
			const sync = await createSync()
			const calls: string[] = []

			mockSendMessage.mockImplementation(async ({ message }: { message: string }) => {
				calls.push(message)

				return { chat: mockChat("chat-1"), message: { inner: { uuid: "x" } } }
			})

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [
						mockMessage("msg-2", "second", 2000),
						mockMessage("msg-1", "first", 1000),
						mockMessage("msg-3", "third", 3000)
					]
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(calls).toEqual(["first", "second", "third"])
		})

		it("removes sent messages from store", async () => {
			const sync = await createSync()

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "hello", 1000)]
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(chatsState.inflightMessages["chat-1"]).toBeUndefined()
		})

		it("continues on message failure and stores error", async () => {
			const sync = await createSync()

			mockSendMessage
				.mockRejectedValueOnce(new Error("network error"))
				.mockResolvedValueOnce({ chat: mockChat("chat-1"), message: { inner: { uuid: "x" } } })

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [
						mockMessage("msg-1", "will-fail", 1000),
						mockMessage("msg-2", "will-succeed", 2000)
					]
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// Failed message stays in store
			expect(chatsState.inflightMessages["chat-1"]!.messages.some((m: { inflightId: string }) => m.inflightId === "msg-1")).toBe(true)

			// Succeeded message was removed
			expect(chatsState.inflightMessages["chat-1"]!.messages.some((m: { inflightId: string }) => m.inflightId === "msg-2")).toBe(false)

			// Error was stored
			expect(chatsState.inflightErrors["msg-1"]).toBeInstanceOf(Error)
		})

		it("skips when store is empty", async () => {
			const sync = await createSync()

			chatsState.inflightMessages = {}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockSendMessage).not.toHaveBeenCalled()
		})

		it("clears error on successful send", async () => {
			const sync = await createSync()

			chatsState.inflightErrors = { "msg-1": new Error("previous failure") }
			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "retry", 1000)]
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(chatsState.inflightErrors["msg-1"]).toBeUndefined()
		})

		it("processes multiple chats independently — one fails, other succeeds", async () => {
			const sync = await createSync()

			mockSendMessage
				.mockRejectedValueOnce(new Error("chat-1 failed"))
				.mockResolvedValueOnce({ chat: mockChat("chat-2"), message: { inner: { uuid: "x" } } })

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "will-fail", 1000)]
				},
				"chat-2": {
					chat: mockChat("chat-2"),
					messages: [mockMessage("msg-2", "will-succeed", 1000)]
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// chat-1's message failed, stays in store
			expect(chatsState.inflightMessages["chat-1"]!.messages).toHaveLength(1)

			// chat-2's message succeeded, removed
			expect(chatsState.inflightMessages["chat-2"]).toBeUndefined()
		})

		it("skips messages with null content", async () => {
			const sync = await createSync()

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [{ inflightId: "msg-1", inner: { message: null }, sentTimestamp: BigInt(1000) }]
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockSendMessage).not.toHaveBeenCalled()
		})

		it("flushes final state to disk after sync", async () => {
			const sync = await createSync()

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "hello", 1000)]
				}
			}

			vi.mocked(sqlite.kvAsync.remove).mockClear()

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(sqlite.kvAsync.remove).toHaveBeenCalledWith(KV_KEY)
		})
	})

	describe("syncNow", () => {
		it("triggers sync immediately", async () => {
			const sync = await createSync()

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "hello", 1000)]
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockSendMessage).toHaveBeenCalledTimes(1)
		})
	})
})
