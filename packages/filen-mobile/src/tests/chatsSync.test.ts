import { vi, describe, it, expect, beforeEach } from "vitest"
import logger from "@/lib/logger"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const { kvStore, chatsState, mockSendMessage, mockFetchChats, mockSetInflightMessages, mockSetInflightErrors, ErrorKindMock, sdkErrorState } =
	vi.hoisted(() => {
		const chatsState = {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			inflightMessages: {} as Record<string, any>,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			inflightErrors: {} as Record<string, any>
		}

		return {
			kvStore: new Map<string, unknown>(),
			chatsState,
			mockSendMessage: vi.fn().mockResolvedValue({
				chat: { uuid: "chat-1" },
				message: { inner: { uuid: "msg-1" } }
			}),
			mockFetchChats: vi.fn().mockResolvedValue([]),
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
			// Faithful-enough ErrorKind enum (member names mirror @filen/sdk-rs). Numeric values are
			// irrelevant — the same mock object backs both the call site and the real classifier
			// switch in src/lib/sdkErrors.ts.
			ErrorKindMock: {
				Server: "Server",
				Unauthenticated: "Unauthenticated",
				Reqwest: "Reqwest",
				RetryFailed: "RetryFailed",
				Response: "Response"
			} as const,
			// Instead of stubbing the classifier verdict, the REAL src/lib/sdkErrors.ts runs against a
			// mocked @filen/sdk-rs. These cells let each test mark a thrown value as a FilenSdkError of
			// a chosen kind. By default no value is an SDK error (hasInner → false), so a plain Error
			// follows the keep-for-retry path.
			sdkErrorState: {
				innerOf: new Map<unknown, { kind: () => string; message: () => string }>()
			}
		}
	})

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("@/lib/sqlite", async () => (await import("@/tests/mocks/sqliteKv")).createSqliteKvMock(kvStore))

vi.mock("@/features/chats/store/useChats.store", () => {
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

vi.mock("@/features/chats/chats", () => ({
	default: {
		sendMessage: mockSendMessage
	}
}))

vi.mock("@/features/chats/queries/useChats.query", () => ({
	fetchData: mockFetchChats
}))

vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))

// DO NOT mock @/lib/sdkErrors — the real classifier (unwrapSdkError / isNetworkClassError /
// isRetryableAuthError) runs against this faithful @filen/sdk-rs mock so the D4a narrowing is
// exercised end-to-end through the actual sdkErrors.ts code, not a stubbed verdict.
vi.mock("@filen/sdk-rs", () => {
	class FilenSdkErrorMock {
		public static hasInner(error: unknown): boolean {
			return sdkErrorState.innerOf.has(error)
		}

		public static getInner(error: unknown): unknown {
			return sdkErrorState.innerOf.get(error)
		}
	}

	return {
		ErrorKind: ErrorKindMock,
		FilenSdkError: FilenSdkErrorMock
	}
})

// sdkErrors.ts imports @/lib/i18n at module load (used only by the human-readable formatter, not
// the classifiers under test) — provide a trivial stand-in so the module evaluates.
vi.mock("@/lib/i18n", () => ({
	default: {
		t: (key: string) => key
	}
}))

// Mark a thrown value as a FilenSdkError of a given kind for the duration of a test.
function asSdkError<E>(error: E, kind: string): E {
	sdkErrorState.innerOf.set(error, {
		kind: () => kind,
		message: () => `mock ${kind}`
	})

	return error
}

import { onlineManager } from "@tanstack/react-query"
import { Sync, mergeInflight, MAX_NON_RETRYABLE_REJECTIONS } from "@/features/chats/components/sync"
import sqlite from "@/lib/sqlite"
import type { InflightChatMessages } from "@/features/chats/store/useChats.store"

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
		mockSendMessage.mockResolvedValue({
			chat: { uuid: "chat-1" },
			message: { inner: { uuid: "msg-1" } }
		})
		mockFetchChats.mockReset()
		mockFetchChats.mockResolvedValue([])
		mockSetInflightMessages.mockClear()
		mockSetInflightErrors.mockClear()
		sdkErrorState.innerOf.clear()
		vi.mocked(sqlite.kvAsync.get).mockClear()
		vi.mocked(sqlite.kvAsync.set).mockClear()
		vi.mocked(sqlite.kvAsync.remove).mockClear()
	})

	describe("restoreFromDisk", () => {
		it("loads inflight messages from disk and merges them into the (empty) store", async () => {
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

		// D1: the restore must MERGE the disk snapshot into the live store, never replace it.
		it("merges the disk snapshot into a live store entry — live messages win by inflightId", async () => {
			const liveMessage = mockMessage("shared-id", "live copy (newer)", 5000)

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [liveMessage]
				}
			}

			kvStore.set(KV_KEY, {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("shared-id", "stale disk copy", 1000), mockMessage("disk-only", "from disk", 2000)]
				}
			})

			mockFetchChats.mockResolvedValue([{ uuid: "chat-1" }])

			await createSync()

			const messages = chatsState.inflightMessages["chat-1"]!.messages as { inflightId: string; inner: { message: string } }[]

			// The live copy of shared-id survives untouched; the disk-only message is seeded.
			expect(messages).toHaveLength(2)
			expect(messages.find(m => m.inflightId === "shared-id")!.inner.message).toBe("live copy (newer)")
			expect(messages.some(m => m.inflightId === "disk-only")).toBe(true)
		})

		// D1 race regression: a message sent DURING the restore (between the disk read and the
		// chats-list fetch resolving) was previously wiped by the second full REPLACE of the
		// store — silently losing it from queue and disk. It must survive and be delivered.
		it("a message sent during the restore fetch window survives the merge + prune and is delivered by the kicked sync", async () => {
			kvStore.set(KV_KEY, {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("disk-msg", "from disk", 1000)]
				}
			})

			mockFetchChats.mockImplementation(async () => {
				// The user sends a message to a different chat while the restore's listChats is in
				// flight (input's send() writes the store directly, without the sync mutex). The
				// chat is brand-new: not in the disk snapshot and not in the listing yet.
				chatsState.inflightMessages = {
					...chatsState.inflightMessages,
					"chat-live": {
						chat: mockChat("chat-live"),
						messages: [mockMessage("live-msg", "sent mid-restore", 2000)]
					}
				}

				return [{ uuid: "chat-1" }]
			})

			await createSync()

			// Both the disk-restored and the mid-restore message survive the restore.
			expect(chatsState.inflightMessages["chat-1"]).toBeDefined()
			expect(chatsState.inflightMessages["chat-live"]).toBeDefined()

			// And the kicked sync delivers BOTH.
			await new Promise(resolve => setTimeout(resolve, 0))

			const sentMessages = mockSendMessage.mock.calls.map(([args]) => (args as { message: string }).message)

			expect(sentMessages).toContain("from disk")
			expect(sentMessages).toContain("sent mid-restore")
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

		// D1: the prune may only ever touch chats seeded purely from THIS disk snapshot. A chat
		// that already had live entries before the restore is never pruned here, even when it is
		// absent from the listing (its removal is owned by the explicit purge paths).
		it("does NOT prune a chat that had live entries before the restore, even when absent from the chats listing", async () => {
			chatsState.inflightMessages = {
				"chat-live-before": {
					chat: mockChat("chat-live-before"),
					messages: [mockMessage("live-1", "queued before restore", 5000)]
				}
			}

			kvStore.set(KV_KEY, {
				"chat-live-before": {
					chat: mockChat("chat-live-before"),
					messages: [mockMessage("disk-1", "from disk", 1000)]
				},
				"chat-disk-only": {
					chat: mockChat("chat-disk-only"),
					messages: [mockMessage("disk-2", "from disk", 1000)]
				}
			})

			// Neither chat is in the listing.
			mockFetchChats.mockResolvedValue([])

			await createSync()

			// The disk-only chat is pruned; the chat with pre-restore live entries survives whole.
			expect(chatsState.inflightMessages["chat-disk-only"]).toBeUndefined()
			expect(chatsState.inflightMessages["chat-live-before"]).toBeDefined()

			const messages = chatsState.inflightMessages["chat-live-before"]!.messages as { inflightId: string }[]

			expect(messages.some(m => m.inflightId === "live-1")).toBe(true)
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

		// #17 — offline launch must still hydrate the persisted queue. The hydration happens BEFORE
		// the network prune, and the prune is best-effort: a chatsQueryFetch rejection (offline) must
		// not abort hydration or drop the queue.
		it("hydrates the store even when the chats-list fetch rejects (offline launch)", async () => {
			kvStore.set(KV_KEY, {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "queued offline", 1000)]
				}
			})

			// Simulate offline: the network listChats throws.
			mockFetchChats.mockRejectedValue(new Error("offline"))

			await createSync()

			// The persisted queue is still hydrated despite the fetch failure.
			expect(chatsState.inflightMessages["chat-1"]).toBeDefined()
			expect(chatsState.inflightMessages["chat-1"]!.messages).toHaveLength(1)
		})

		it("does NOT prune (and does not drop the queue) when the chats-list fetch rejects", async () => {
			kvStore.set(KV_KEY, {
				"chat-a": {
					chat: mockChat("chat-a"),
					messages: [mockMessage("msg-a", "keep-a", 1000)]
				},
				"chat-b": {
					chat: mockChat("chat-b"),
					messages: [mockMessage("msg-b", "keep-b", 1000)]
				}
			})

			mockFetchChats.mockRejectedValue(new Error("offline"))

			await createSync()

			// Both chats survive — no chat is pruned because the prune step failed and was swallowed.
			expect(chatsState.inflightMessages["chat-a"]).toBeDefined()
			expect(chatsState.inflightMessages["chat-b"]).toBeDefined()
		})

		it("hydrates the store BEFORE the network fetch resolves (visible/deliverable immediately)", async () => {
			kvStore.set(KV_KEY, {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "pending", 1000)]
				}
			})

			let storeHydratedBeforeFetch = false

			// When the network fetch is consulted, the store must already be hydrated.
			mockFetchChats.mockImplementation(async () => {
				storeHydratedBeforeFetch = chatsState.inflightMessages["chat-1"] !== undefined

				return [{ uuid: "chat-1" }]
			})

			await createSync()

			expect(storeHydratedBeforeFetch).toBe(true)
		})

		// M4: the restore must apply purely FUNCTIONAL store updates. The old code set the store
		// to the disk-snapshot object and then `delete`d keys on that SAME reference — mutating
		// state in place and suppressing zustand subscriber notifications for the prune.
		it("prunes via purely functional updates — the disk snapshot is never mutated and the store gets a fresh object", async () => {
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

			// Observable contract: "chat-gone" pruned from the store, "chat-exists" kept.
			expect(chatsState.inflightMessages["chat-gone"]).toBeUndefined()
			expect(chatsState.inflightMessages["chat-exists"]).toBeDefined()

			// The disk snapshot object (returned by reference from the kv mock) was NOT mutated
			// in place — the old implementation did `delete fromDisk[chatUuid]` on it.
			expect(storedData["chat-gone"]).toBeDefined()

			// The store ends up with a NEW object (never the snapshot reference), so zustand can
			// notify subscribers of the prune (Object.is-equal set calls are no-ops for them).
			expect(chatsState.inflightMessages).not.toBe(storedData)

			// And every restore-path store update was a functional updater, never a raw object.
			expect(mockSetInflightMessages).toHaveBeenCalled()

			for (const [arg] of mockSetInflightMessages.mock.calls) {
				expect(typeof arg).toBe("function")
			}
		})
	})

	describe("flushToDisk", () => {
		it("writes filtered messages to sqlite and reports success (M3)", async () => {
			const sync = await createSync()
			const data = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "hello", 1000)]
				}
			}

			const flushed = await sync.flushToDisk(data)

			expect(flushed).toBe(true)
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

		it("M3: catches write errors — console.error is called, the promise resolves with `false`", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			const sync = await createSync()

			vi.mocked(sqlite.kvAsync.set).mockRejectedValueOnce(new Error("write failed"))

			vi.mocked(logger.error).mockClear()

			const flushed = await sync.flushToDisk({
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "hello", 1000)]
				}
			})

			// Failure is reported as `false` so component call sites can alert
			// (sync-internal callers ignore it).
			expect(flushed).toBe(false)
			expect(logger.error).toHaveBeenCalled()

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

		it("continues on message failure and stores the error entry (with the message snapshot)", async () => {
			const sync = await createSync()

			mockSendMessage
				.mockRejectedValueOnce(new Error("network error"))
				.mockResolvedValueOnce({ chat: mockChat("chat-1"), message: { inner: { uuid: "x" } } })

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "will-fail", 1000), mockMessage("msg-2", "will-succeed", 2000)]
				}
			}

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// Failed message stays in store
			expect(chatsState.inflightMessages["chat-1"]!.messages.some((m: { inflightId: string }) => m.inflightId === "msg-1")).toBe(true)

			// Succeeded message was removed
			expect(chatsState.inflightMessages["chat-1"]!.messages.some((m: { inflightId: string }) => m.inflightId === "msg-2")).toBe(
				false
			)

			// Error entry was stored: the error itself, a zero strike count (plain Error — not an
			// SDK rejection) and the message snapshot for the failed-bubble overlay.
			expect(chatsState.inflightErrors["msg-1"]).toBeDefined()
			expect(chatsState.inflightErrors["msg-1"]!.error).toBeInstanceOf(Error)
			expect(chatsState.inflightErrors["msg-1"]!.permanentRejections).toBe(0)
			expect(chatsState.inflightErrors["msg-1"]!.message.inflightId).toBe("msg-1")
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

			chatsState.inflightErrors = {
				"msg-1": {
					error: new Error("previous failure"),
					permanentRejections: 1,
					message: mockMessage("msg-1", "retry", 1000)
				}
			}
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
			expect(chatsState.inflightMessages["chat-1"]!.messages.some((m: { inflightId: string }) => m.inflightId === "msg-null")).toBe(
				true
			)
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
			expect(chatsState.inflightMessages["chat-1"]!.messages.some((m: { inflightId: string }) => m.inflightId === "msg-empty")).toBe(
				true
			)
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

		// D2: an aborted pass must NEVER write the queue back to disk. Logout aborts in-flight
		// sync (Phase 2) and later wipes SQLite (Phase 6) — a late flush would resurrect the
		// previous account's plaintext queue after the wipe.
		it("does NOT flush to disk when the pass was aborted", async () => {
			const sync = await createSync()

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "hello", 1000)]
				}
			}

			mockSendMessage.mockImplementation(async () => {
				// Abort mid-flight (e.g. logout) — the send itself fails with the abort.
				sync.cancel()

				throw new Error("aborted mid-flight")
			})

			vi.mocked(sqlite.kvAsync.set).mockClear()
			vi.mocked(sqlite.kvAsync.remove).mockClear()

			sync.syncNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(sqlite.kvAsync.set).not.toHaveBeenCalled()
			expect(sqlite.kvAsync.remove).not.toHaveBeenCalled()
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
					messages: [mockMessage("msg-1", "first", 1000), mockMessage("msg-2", "second", 2000)]
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

		it("stores the FilenSdkError inner error in the entry when a non-Error SDK value is thrown", async () => {
			const sync = await createSync()

			// A non-Error thrown value marked as an SDK error: the source extracts getInner(e).
			const fakeSdkError = { _tag: "FilenSdkError" }

			asSdkError(fakeSdkError, ErrorKindMock.Server)

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
			expect(chatsState.inflightErrors["msg-sdk"]!.error).toBe(sdkErrorState.innerOf.get(fakeSdkError))
			// And a Server-kind SDK rejection counts as a permanent one (1/MAX).
			expect(chatsState.inflightErrors["msg-sdk"]!.permanentRejections).toBe(1)
		})

		it("stores a stringified Error when a non-Error, non-SDK value is thrown", async () => {
			const sync = await createSync()

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

			const storedError = chatsState.inflightErrors["msg-unknown"]!.error

			expect(storedError).toBeInstanceOf(Error)

			if (!(storedError instanceof Error)) {
				throw new Error("expected storedError to be an Error instance")
			}

			expect(storedError.message).toBe("plain string error")

			// Not an SDK rejection — never advances the drop bound.
			expect(chatsState.inflightErrors["msg-unknown"]!.permanentRejections).toBe(0)
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

	// D4a — the 3-strike drop for permanently rejected sends, classified through the REAL
	// src/lib/sdkErrors helpers (the same ones the notes sync uses).
	describe("non-retryable rejection bound (D4a)", () => {
		it("drops the message from the queue after MAX consecutive permanent SDK rejections, keeping the error entry visible", async () => {
			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			try {
				const sync = await createSync()

				chatsState.inflightMessages = {
					"chat-1": {
						chat: mockChat("chat-1"),
						messages: [mockMessage("msg-doomed", "rejected forever", 1000)]
					}
				}

				mockSendMessage.mockRejectedValue(asSdkError(new Error("forbidden"), ErrorKindMock.Server))

				for (let attempt = 1; attempt <= MAX_NON_RETRYABLE_REJECTIONS; attempt++) {
					sync.syncNow()

					await new Promise(resolve => setTimeout(resolve, 0))

					if (attempt < MAX_NON_RETRYABLE_REJECTIONS) {
						// Still queued for retry, strike count advancing.
						expect(
							chatsState.inflightMessages["chat-1"]!.messages.some(
								(m: { inflightId: string }) => m.inflightId === "msg-doomed"
							)
						).toBe(true)
						expect(chatsState.inflightErrors["msg-doomed"]!.permanentRejections).toBe(attempt)
					}
				}

				// Dropped from the queue after MAX consecutive permanent rejections...
				expect(chatsState.inflightMessages["chat-1"]).toBeUndefined()

				// ...but the error entry STAYS (with the snapshot) so the failure remains visible
				// and actionable until the user retries or removes it.
				expect(chatsState.inflightErrors["msg-doomed"]).toBeDefined()
				expect(chatsState.inflightErrors["msg-doomed"]!.permanentRejections).toBe(MAX_NON_RETRYABLE_REJECTIONS)
				expect(chatsState.inflightErrors["msg-doomed"]!.message.inflightId).toBe("msg-doomed")
			} finally {
				consoleErrorSpy.mockRestore()
			}
		})

		it("network-class SDK errors do NOT count toward the drop bound — the message is retried indefinitely", async () => {
			const sync = await createSync()

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-net", "flaky network", 1000)]
				}
			}

			mockSendMessage.mockRejectedValue(asSdkError(new Error("network down"), ErrorKindMock.Reqwest))

			for (let attempt = 0; attempt < MAX_NON_RETRYABLE_REJECTIONS + 2; attempt++) {
				sync.syncNow()

				await new Promise(resolve => setTimeout(resolve, 0))
			}

			// Never dropped, never counted.
			expect(chatsState.inflightMessages["chat-1"]!.messages.some((m: { inflightId: string }) => m.inflightId === "msg-net")).toBe(
				true
			)
			expect(chatsState.inflightErrors["msg-net"]!.permanentRejections).toBe(0)
		})

		it("Unauthenticated SDK errors do NOT count toward the drop bound (re-auth-recoverable)", async () => {
			const sync = await createSync()

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-auth", "during reauth", 1000)]
				}
			}

			mockSendMessage.mockRejectedValue(asSdkError(new Error("api_key_not_found"), ErrorKindMock.Unauthenticated))

			for (let attempt = 0; attempt < MAX_NON_RETRYABLE_REJECTIONS + 2; attempt++) {
				sync.syncNow()

				await new Promise(resolve => setTimeout(resolve, 0))
			}

			expect(chatsState.inflightMessages["chat-1"]!.messages.some((m: { inflightId: string }) => m.inflightId === "msg-auth")).toBe(
				true
			)
			expect(chatsState.inflightErrors["msg-auth"]!.permanentRejections).toBe(0)
		})

		it("non-SDK errors do NOT count toward the drop bound", async () => {
			const sync = await createSync()

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-plain", "plain failure", 1000)]
				}
			}

			// Plain Error — hasInner false → keep-for-retry, no strikes.
			mockSendMessage.mockRejectedValue(new Error("not an sdk error"))

			for (let attempt = 0; attempt < MAX_NON_RETRYABLE_REJECTIONS + 2; attempt++) {
				sync.syncNow()

				await new Promise(resolve => setTimeout(resolve, 0))
			}

			expect(chatsState.inflightMessages["chat-1"]!.messages.some((m: { inflightId: string }) => m.inflightId === "msg-plain")).toBe(
				true
			)
			expect(chatsState.inflightErrors["msg-plain"]!.permanentRejections).toBe(0)
		})

		it("a successful send clears the error entry — a later failure starts a fresh strike count", async () => {
			const sync = await createSync()

			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "v1", 1000)]
				}
			}

			// Two permanent rejections (2/3)...
			mockSendMessage.mockRejectedValueOnce(asSdkError(new Error("server"), ErrorKindMock.Server))
			sync.syncNow()
			await new Promise(resolve => setTimeout(resolve, 0))

			mockSendMessage.mockRejectedValueOnce(asSdkError(new Error("server again"), ErrorKindMock.Server))
			sync.syncNow()
			await new Promise(resolve => setTimeout(resolve, 0))

			expect(chatsState.inflightErrors["msg-1"]!.permanentRejections).toBe(2)

			// ...then a success drains the message and clears the entry (and its strikes).
			mockSendMessage.mockResolvedValueOnce({ chat: mockChat("chat-1"), message: { inner: { uuid: "x" } } })
			sync.syncNow()
			await new Promise(resolve => setTimeout(resolve, 0))

			expect(chatsState.inflightMessages["chat-1"]).toBeUndefined()
			expect(chatsState.inflightErrors["msg-1"]).toBeUndefined()

			// A fresh failure for the same id starts over at 1 — it never inherits the prior 2.
			chatsState.inflightMessages = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "v2", 2000)]
				}
			}

			mockSendMessage.mockRejectedValueOnce(asSdkError(new Error("server once more"), ErrorKindMock.Server))
			sync.syncNow()
			await new Promise(resolve => setTimeout(resolve, 0))

			expect(chatsState.inflightErrors["msg-1"]!.permanentRejections).toBe(1)
			expect(chatsState.inflightMessages["chat-1"]!.messages).toHaveLength(1)
		})
	})

	// D1 — the pure merge used by the restore hydration.
	describe("mergeInflight", () => {
		it("seeds chats the current store does not have", () => {
			const current = {}
			const fromDisk = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("msg-1", "disk", 1000)]
				}
			}

			const merged = mergeInflight(current, fromDisk as InflightChatMessages)

			expect(merged["chat-1"]!.messages).toHaveLength(1)
		})

		it("keeps the live copy when both sides carry the same inflightId", () => {
			const current = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("shared", "live", 5000)]
				}
			}
			const fromDisk = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("shared", "disk", 1000)]
				}
			}

			const merged = mergeInflight(current as InflightChatMessages, fromDisk as InflightChatMessages)

			expect(merged["chat-1"]!.messages).toHaveLength(1)
			expect(merged["chat-1"]!.messages[0]!.inner.message).toBe("live")
		})

		it("unions disjoint messages of the same chat (live + disk)", () => {
			const current = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("live-only", "live", 5000)]
				}
			}
			const fromDisk = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("disk-only", "disk", 1000)]
				}
			}

			const merged = mergeInflight(current as InflightChatMessages, fromDisk as InflightChatMessages)
			const ids = merged["chat-1"]!.messages.map(m => m.inflightId)

			expect(ids).toHaveLength(2)
			expect(ids).toContain("live-only")
			expect(ids).toContain("disk-only")
		})

		it("preserves live-only chats untouched", () => {
			const liveEntry = {
				chat: mockChat("chat-live"),
				messages: [mockMessage("live-1", "stays", 5000)]
			}
			const current = {
				"chat-live": liveEntry
			}
			const fromDisk = {
				"chat-disk": {
					chat: mockChat("chat-disk"),
					messages: [mockMessage("disk-1", "disk", 1000)]
				}
			}

			const merged = mergeInflight(current as InflightChatMessages, fromDisk as InflightChatMessages)

			expect(merged["chat-live"]).toBe(liveEntry)
			expect(merged["chat-disk"]).toBeDefined()
		})

		it("does not mutate either input", () => {
			const current = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("live-only", "live", 5000)]
				}
			}
			const fromDisk = {
				"chat-1": {
					chat: mockChat("chat-1"),
					messages: [mockMessage("disk-only", "disk", 1000)]
				}
			}

			const merged = mergeInflight(current as InflightChatMessages, fromDisk as InflightChatMessages)

			expect(merged).not.toBe(current)
			expect(current["chat-1"]!.messages).toHaveLength(1)
			expect(fromDisk["chat-1"]!.messages).toHaveLength(1)
		})
	})
})
