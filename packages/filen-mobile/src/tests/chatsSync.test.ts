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

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("@/lib/sqlite", async () => (await import("@/tests/mocks/sqliteKv")).createSqliteKvMock(kvStore))

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

vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))

vi.mock("@filen/sdk-rs", () => ({
	FilenSdkError: {
		hasInner: vi.fn().mockReturnValue(false),
		getInner: vi.fn().mockReturnValue(new Error("sdk error"))
	}
}))

import { onlineManager } from "@tanstack/react-query"
import { Sync } from "@/components/chats/sync"
import sqlite from "@/lib/sqlite"
import { FilenSdkError } from "@filen/sdk-rs"
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
		vi.mocked(FilenSdkError.hasInner).mockReturnValue(false)
		vi.mocked(FilenSdkError.getInner).mockReturnValue(new Error("sdk error") as unknown as FilenSdkError)
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

		it("resolves init even on failure — store is left empty and flushToDisk completes without throwing", async () => {
			vi.mocked(sqlite.kvAsync.get).mockRejectedValueOnce(new Error("disk error"))

			const sync = await createSync()

			// Store should remain empty since restore failed
			expect(chatsState.inflightMessages).toEqual({})

			// flushToDisk must not throw and should call remove (empty data → delete key)
			vi.mocked(sqlite.kvAsync.remove).mockClear()

			await sync.flushToDisk({})

			expect(sqlite.kvAsync.remove).toHaveBeenCalledWith(KV_KEY)
		})

		it("mutates the fromDisk object in-place when pruning deleted chats", async () => {
			// The source does `delete fromDisk[chatUuid]` on the object returned by sqlite.kvAsync.get.
			// This test confirms the pruned chat UUID is absent from the store state, which is the
			// observable consequence of that in-place mutation path.
			const storedData = {
				"chat-exists": {
					chat: mockChat("chat-exists"),
					messages: [mockMessage("msg-1", "keep", 1000)]
				},
				"chat-gone": {
					chat: mockChat("chat-gone"),
					messages: [mockMessage("msg-2", "pruned", 1000)]
				}
			}

			kvStore.set(KV_KEY, storedData)

			// Only chat-exists is in the live list
			mockFetchChats.mockResolvedValue([{ uuid: "chat-exists" }])

			await createSync()

			// "chat-gone" must be absent after pruning
			expect(chatsState.inflightMessages["chat-gone"]).toBeUndefined()
			// "chat-exists" must be present
			expect(chatsState.inflightMessages["chat-exists"]).toBeDefined()
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

		it("writes only the non-empty entries — empty-messages entry is absent from sqlite", async () => {
			// Replaces the tautological "does not mutate input parameter" test.
			// The implementation builds a new filtered object via Object.fromEntries, so
			// the observable claim is that the stored value excludes the empty-messages entry.
			const sync = await createSync()

			await sync.flushToDisk({
				"chat-1": { chat: mockChat("chat-1"), messages: [mockMessage("msg-1", "hello", 1000)] },
				"chat-2": { chat: mockChat("chat-2"), messages: [] }
			} as any)

			const stored = kvStore.get(KV_KEY) as Record<string, unknown>

			expect(Object.keys(stored)).toEqual(["chat-1"])
		})

		it("catches write errors — console.error is called and the promise resolves", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			const sync = await createSync()

			vi.mocked(sqlite.kvAsync.set).mockRejectedValueOnce(new Error("write failed"))

			await sync.flushToDisk({
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "hello", 1000)]
				}
			})

			expect(consoleErrorSpy).toHaveBeenCalled()

			consoleErrorSpy.mockRestore()
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

		it("skips sync when offline", async () => {
			const sync = await createSync()

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "hello", 1000)]
				}
			}

			onlineManager.setOnline(false)

			try {
				sync.syncNow()

				await new Promise(resolve => setTimeout(resolve, 0))

				expect(mockSendMessage).not.toHaveBeenCalled()
			} finally {
				onlineManager.setOnline(true)
			}
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

		it("skips messages with null content and leaves them in store", async () => {
			const sync = await createSync()

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [{ inflightId: "msg-null", inner: { message: null }, sentTimestamp: BigInt(1000) }]
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockSendMessage).not.toHaveBeenCalled()
			// Skipped message is NOT cleaned up from the store (the continue skips the success cleanup block)
			expect(chatsState.inflightMessages["chat-1"]!.messages.some((m: { inflightId: string }) => m.inflightId === "msg-null")).toBe(true)
		})

		it("skips messages with empty-string content and leaves them in store", async () => {
			// The source checks `!message.inner.message` which is falsy for "" as well as null.
			const sync = await createSync()

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [{ inflightId: "msg-empty", inner: { message: "" }, sentTimestamp: BigInt(1000) }]
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockSendMessage).not.toHaveBeenCalled()
			expect(chatsState.inflightMessages["chat-1"]!.messages.some((m: { inflightId: string }) => m.inflightId === "msg-empty")).toBe(true)
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

		it("threads an AbortSignal into chats.sendMessage", async () => {
			const sync = await createSync()

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "hello", 1000)]
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockSendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					signal: expect.any(AbortSignal)
				})
			)
		})

		it("cancel() aborts the signal that's already been threaded into sendMessage", async () => {
			const sync = await createSync()

			let observedSignal: AbortSignal | undefined

			mockSendMessage.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
				observedSignal = signal

				sync.cancel()

				return { chat: mockChat("chat-1"), message: { inner: { uuid: "x" } } }
			})

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "hello", 1000)]
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(observedSignal).toBeDefined()
			expect(observedSignal?.aborted).toBe(true)
		})

		it("cancel() resets abortController so the next syncNow() runs unaborted", async () => {
			const sync = await createSync()

			// Cancel before any sync — this replaces the internal AbortController
			sync.cancel()

			// Now run a fresh sync — the new controller is NOT aborted
			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "hello", 1000)]
				}
			}

			let signalAfterCancel: AbortSignal | undefined

			mockSendMessage.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
				signalAfterCancel = signal

				return { chat: mockChat("chat-1"), message: { inner: { uuid: "x" } } }
			})

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockSendMessage).toHaveBeenCalledTimes(1)
			expect(signalAfterCancel).toBeDefined()
			expect(signalAfterCancel?.aborted).toBe(false)
		})

		it("aborted signal during message loop causes early return, leaving remaining messages in store", async () => {
			const sync = await createSync()

			// First message triggers abort; second message should NOT be sent
			mockSendMessage.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
				sync.cancel()

				// The abortController was just replaced; but `signal` (captured before cancel) is now aborted
				expect(signal.aborted).toBe(true)

				return { chat: mockChat("chat-1"), message: { inner: { uuid: "x" } } }
			})

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [
						mockMessage("msg-1", "first", 1000),
						mockMessage("msg-2", "second", 2000)
					]
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// sendMessage was only called once (the loop returned after the abort check)
			expect(mockSendMessage).toHaveBeenCalledTimes(1)

			// msg-2 was not processed — it remains in the store
			const remaining = chatsState.inflightMessages["chat-1"]?.messages ?? []

			expect(remaining.some((m: { inflightId: string }) => m.inflightId === "msg-2")).toBe(true)
		})

		it("stores a FilenSdkError-wrapped error in inflightErrors when SDK error is thrown", async () => {
			const sync = await createSync()

			const sdkInnerError = new Error("sdk inner message")

			vi.mocked(FilenSdkError.hasInner).mockReturnValue(true)
			vi.mocked(FilenSdkError.getInner).mockReturnValue(sdkInnerError as unknown as FilenSdkError)

			const fakeSdkError = { _tag: "FilenSdkError" }

			mockSendMessage.mockRejectedValueOnce(fakeSdkError)

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-sdk", "sdk-fail", 1000)]
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// The FilenSdkError branch extracts the inner error via getInner()
			expect(chatsState.inflightErrors["msg-sdk"]).toBe(sdkInnerError)
		})

		it("stores a stringified Error when a non-Error, non-SDK value is thrown", async () => {
			const sync = await createSync()

			vi.mocked(FilenSdkError.hasInner).mockReturnValue(false)

			// Throw a plain string — the source wraps it in new Error(String(e))
			mockSendMessage.mockRejectedValueOnce("plain string error")

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-unknown", "unknown-fail", 1000)]
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			const storedError = chatsState.inflightErrors["msg-unknown"]

			expect(storedError).toBeInstanceOf(Error)

			if (!(storedError instanceof Error)) {
				throw new Error("expected storedError to be an Error instance")
			}

			expect(storedError.message).toBe("plain string error")
		})

		it("skips chat entry with empty messages array without calling sendMessage", async () => {
			// Covers the `if (messages.length === 0) return` guard inside the Promise.allSettled map.
			const sync = await createSync()

			chatsState.inflightMessages = {
				"chat-empty": {
					chat: mockChat("chat-empty"),
					messages: []
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockSendMessage).not.toHaveBeenCalled()
		})
	})
})
