// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"

const {
	kvStore,
	notesState,
	mockNotesSetContent,
	mockNotesGetContent,
	mockFetchNotesWithContent,
	mockCreateExecutableTimeout,
	mockNotesWithContentQueryGet,
	mockNoteContentQueryUpdate,
	mockNoteContentQueryDataUpdatedAt,
	ErrorKindMock,
	sdkErrorState
} = vi.hoisted(() => ({
	mockNoteContentQueryUpdate: vi.fn(),
	mockNoteContentQueryDataUpdatedAt: vi.fn().mockReturnValue(undefined),
	kvStore: new Map<string, unknown>(),
	notesState: {
		inflightContent: {} as Record<
			string,
			{ timestamp: number; content: string; note: { uuid: string }; baseContentHash?: string }[]
		>
	},
	mockNotesSetContent: vi.fn().mockResolvedValue({
		editedTimestamp: BigInt(0)
	}),
	mockNotesGetContent: vi.fn().mockResolvedValue(""),
	mockFetchNotesWithContent: vi.fn().mockResolvedValue([]),
	mockCreateExecutableTimeout: vi.fn(),
	mockNotesWithContentQueryGet: vi.fn().mockReturnValue(null),
	// Faithful-enough ErrorKind enum (member names mirror @filen/sdk-rs). Numeric values are
	// irrelevant — the same mock object backs both the call site (kind()) and the real classifier
	// switch in src/lib/sdkErrors.ts.
	ErrorKindMock: {
		Server: "Server",
		Unauthenticated: "Unauthenticated",
		Reqwest: "Reqwest",
		RetryFailed: "RetryFailed",
		Response: "Response"
	} as const,
	// T2: instead of stubbing the classifier verdict, the REAL src/lib/sdkErrors.ts runs against a
	// mocked @filen/sdk-rs. These cells let each test mark a thrown value as a FilenSdkError of a
	// chosen kind. By default no value is an SDK error (hasInner → false), so a plain Error follows
	// the keep-for-retry path.
	sdkErrorState: {
		innerOf: new Map<unknown, { kind: () => string; message: () => string }>()
	}
}))

vi.mock("react-native", async () => {
	const listeners = new Map<string, Set<(state: string) => void>>()

	return {
		AppState: {
			addEventListener: vi.fn((type: string, handler: (state: string) => void) => {
				if (!listeners.has(type)) {
					listeners.set(type, new Set())
				}

				listeners.get(type)!.add(handler)

				return {
					remove: () => {
						listeners.get(type)?.delete(handler)
					}
				}
			}),
			_emit: (type: string, nextState: string) => {
				for (const handler of listeners.get(type) ?? []) {
					handler(nextState)
				}
			},
			_reset: () => {
				listeners.clear()
			}
		},
		Platform: {
			OS: "ios",
			select<T>(specifics: { ios?: T; android?: T; default?: T }): T | undefined {
				return specifics["ios"] ?? specifics["default"]
			}
		}
	}
})

vi.mock("@filen/utils", async () => ({
	...(await import("@/tests/mocks/filenUtils")),
	createExecutableTimeout: (...args: unknown[]) => mockCreateExecutableTimeout(...args)
}))

vi.mock("@/lib/sqlite", async () => (await import("@/tests/mocks/sqliteKv")).createSqliteKvMock(kvStore))

vi.mock("@/features/notes/store/useNotesInflight.store", () => {
	const mockSetInflightContent = vi.fn((fn: unknown) => {
		if (typeof fn === "function") {
			notesState.inflightContent = fn(notesState.inflightContent)
		} else {
			notesState.inflightContent = fn as typeof notesState.inflightContent
		}
	})

	return {
		default: {
			getState: () => ({
				inflightContent: notesState.inflightContent,
				setInflightContent: mockSetInflightContent
			})
		}
	}
})

vi.mock("@/features/notes/notes", () => ({
	default: {
		setContent: mockNotesSetContent,
		getContent: mockNotesGetContent
	}
}))

vi.mock("@/features/notes/queries/useNotesWithContent.query", () => ({
	fetchData: mockFetchNotesWithContent,
	notesWithContentQueryGet: mockNotesWithContentQueryGet
}))

vi.mock("@/features/notes/queries/useNoteContent.query", () => ({
	noteContentQueryUpdate: mockNoteContentQueryUpdate,
	noteContentQueryDataUpdatedAt: mockNoteContentQueryDataUpdatedAt
}))

vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))

// T2: DO NOT mock @/lib/sdkErrors — the real classifier (unwrapSdkError / isNetworkClassError /
// isRetryableAuthError) runs against this faithful @filen/sdk-rs mock so the VC3 narrowing is
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

import { Sync, SyncHost, mergeInflight, hashNoteContent, MAX_NON_RETRYABLE_REJECTIONS } from "@/features/notes/components/sync"
import sqlite from "@/lib/sqlite"
import alerts from "@/lib/alerts"
import { AppState } from "react-native"
import { render } from "@testing-library/react"
import React from "react"
import type { InflightContent } from "@/features/notes/store/useNotes.store"

const KV_KEY = "inflightNoteContent"

function mockNote(uuid: string) {
	return { uuid } as InflightContent[string][number]["note"]
}

async function createSync(): Promise<Sync> {
	const sync = new Sync()

	sync.start()

	await (sync as unknown as { initPromise: Promise<void> }).initPromise

	return sync
}

describe("Sync (Notes)", () => {
	beforeEach(() => {
		kvStore.clear()
		notesState.inflightContent = {}
		mockNotesSetContent.mockClear()
		mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(0) })
		mockNotesGetContent.mockReset()
		mockNotesGetContent.mockResolvedValue("")
		mockFetchNotesWithContent.mockClear()
		mockFetchNotesWithContent.mockResolvedValue([])
		mockCreateExecutableTimeout.mockClear()
		mockNotesWithContentQueryGet.mockReturnValue(null)
		mockNoteContentQueryUpdate.mockClear()
		mockNoteContentQueryDataUpdatedAt.mockClear()
		mockNoteContentQueryDataUpdatedAt.mockReturnValue(undefined)
		sdkErrorState.innerOf.clear()
		vi.mocked(alerts.error).mockClear()
		vi.mocked(alerts.normal).mockClear()
		vi.mocked(sqlite.kvAsync.get).mockClear()
		vi.mocked(sqlite.kvAsync.set).mockClear()
		vi.mocked(sqlite.kvAsync.remove).mockClear()
		;(AppState as unknown as { _reset: () => void })._reset()
	})

	describe("restoreFromDisk", () => {
		it("loads inflight content from disk and sets store", async () => {
			const note = mockNote("note-1")

			kvStore.set(KV_KEY, {
				"note-1": [{ timestamp: 5000, content: "hello", note }]
			})

			// Cloud still has the OLD content, so the inflight edit must survive
			// reconciliation (content differs).
			mockFetchNotesWithContent.mockResolvedValue([{ uuid: "note-1", editedTimestamp: BigInt(1000), content: "old-cloud" }])

			await createSync()

			expect(notesState.inflightContent["note-1"]).toHaveLength(1)
			expect(notesState.inflightContent["note-1"]![0]!.content).toBe("hello")
		})

		it("prunes entries for notes that no longer exist in cloud", async () => {
			kvStore.set(KV_KEY, {
				"deleted-note": [{ timestamp: 5000, content: "gone", note: mockNote("deleted-note") }]
			})

			mockFetchNotesWithContent.mockResolvedValue([])

			await createSync()

			expect(notesState.inflightContent["deleted-note"]).toBeUndefined()
		})

		it("#4: prunes a disk entry whose content already equals the cloud content", async () => {
			// #4 principle on the restore path: a disk-seeded inflight entry is
			// dropped ONLY when its content matches the freshly-fetched cloud
			// content (already synced) — never via a cross-clock timestamp compare.
			kvStore.set(KV_KEY, {
				"note-1": [{ timestamp: 5000, content: "already-synced", note: mockNote("note-1") }]
			})

			mockFetchNotesWithContent.mockResolvedValue([{ uuid: "note-1", editedTimestamp: BigInt(9999), content: "already-synced" }])

			await createSync()

			expect(notesState.inflightContent["note-1"]).toBeUndefined()
		})

		it("#4: keeps a disk entry whose content differs from the cloud even when the cloud edited-timestamp is newer", async () => {
			// The previous timestamp-based prune dropped this entry (cloud
			// editedTimestamp > local timestamp). Content differs, so it must
			// survive — it is a genuine unsynced edit.
			kvStore.set(KV_KEY, {
				"note-1": [{ timestamp: 1000, content: "unsynced-local", note: mockNote("note-1") }]
			})

			mockFetchNotesWithContent.mockResolvedValue([{ uuid: "note-1", editedTimestamp: BigInt(999999), content: "different-cloud" }])

			await createSync()

			expect(notesState.inflightContent["note-1"]).toHaveLength(1)
			expect(notesState.inflightContent["note-1"]![0]!.content).toBe("unsynced-local")
		})

		it("#41: hydrates the store from disk WITHOUT a network call when offline", async () => {
			const { onlineManager } = await import("@tanstack/react-query")
			const spy = vi.spyOn(onlineManager, "isOnline").mockReturnValue(false)

			// beforeEach resets the resolved value but not the call count / a leaked
			// implementation; this assertion is about THIS restore's network calls.
			mockFetchNotesWithContent.mockReset()
			mockFetchNotesWithContent.mockResolvedValue([])

			try {
				kvStore.set(KV_KEY, {
					"note-1": [{ timestamp: 5000, content: "offline-pending", note: mockNote("note-1") }]
				})

				await createSync()

				// Store hydrated purely from disk, no cloud fetch attempted.
				expect(mockFetchNotesWithContent).not.toHaveBeenCalled()
				expect(notesState.inflightContent["note-1"]).toHaveLength(1)
				expect(notesState.inflightContent["note-1"]![0]!.content).toBe("offline-pending")
			} finally {
				spy.mockRestore()
			}
		})

		it("#41: functional merge keeps an edit typed during the fetch window", async () => {
			// Simulate an edit landing in the store WHILE the cloud fetch is in
			// flight: the blind-replace structure would obliterate it; the
			// functional merge must keep the fresher store edit.
			kvStore.set(KV_KEY, {
				"note-1": [{ timestamp: 1000, content: "from-disk", note: mockNote("note-1") }]
			})

			mockFetchNotesWithContent.mockImplementation(async () => {
				// An edit is typed (newer local timestamp) during the fetch window.
				notesState.inflightContent = {
					"note-1": [{ timestamp: 5000, content: "typed-during-fetch", note: mockNote("note-1") }]
				}

				return [{ uuid: "note-1", editedTimestamp: BigInt(2000), content: "from-disk" }]
			})

			await createSync()

			// The fresher store edit survives both the merge and the
			// content-equality reconcile (its content differs from cloud).
			expect(notesState.inflightContent["note-1"]).toHaveLength(1)
			expect(notesState.inflightContent["note-1"]![0]!.content).toBe("typed-during-fetch")
		})

		it("#41: an offline reconcile failure does not undo the disk hydration", async () => {
			kvStore.set(KV_KEY, {
				"note-1": [{ timestamp: 5000, content: "pending", note: mockNote("note-1") }]
			})

			// Online, but the cloud fetch throws — hydration must already be done
			// and must NOT be rolled back. setContent also fails (the kicked sync
			// can't reach the server either), so the hydrated entry stays put.
			mockFetchNotesWithContent.mockRejectedValue(new Error("network down"))
			mockNotesSetContent.mockRejectedValue(new Error("network down"))

			await createSync()

			// sync() is kicked after restore — let it settle (it fails, keeping the entry).
			await new Promise(resolve => setTimeout(resolve, 0))

			expect(notesState.inflightContent["note-1"]).toHaveLength(1)
			expect(notesState.inflightContent["note-1"]![0]!.content).toBe("pending")
		})

		it("handles empty disk gracefully", async () => {
			await createSync()

			expect(notesState.inflightContent).toEqual({})
		})

		it("triggers sync when restored data exists", async () => {
			kvStore.set(KV_KEY, {
				"note-1": [{ timestamp: 5000, content: "pending", note: mockNote("note-1") }]
			})

			mockFetchNotesWithContent.mockResolvedValue([{ uuid: "note-1", editedTimestamp: BigInt(1000), content: "old-cloud" }])
			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(6000) })

			await createSync()

			// sync() is fire-and-forget after restore — wait for it to settle
			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNotesSetContent).toHaveBeenCalled()
		})

		it("removes note entirely when all entries match cloud content after reconcile", async () => {
			kvStore.set(KV_KEY, {
				"note-1": [
					{ timestamp: 500, content: "synced", note: mockNote("note-1") },
					{ timestamp: 800, content: "synced", note: mockNote("note-1") }
				]
			})

			mockFetchNotesWithContent.mockResolvedValue([{ uuid: "note-1", editedTimestamp: BigInt(1000), content: "synced" }])

			await createSync()

			expect(notesState.inflightContent["note-1"]).toBeUndefined()
			expect(Object.keys(notesState.inflightContent)).toHaveLength(0)
		})

		it("handles mixed data: some notes valid, some pruned", async () => {
			kvStore.set(KV_KEY, {
				"note-valid": [{ timestamp: 5000, content: "keep", note: mockNote("note-valid") }],
				"note-deleted": [{ timestamp: 5000, content: "remove", note: mockNote("note-deleted") }],
				"note-synced": [{ timestamp: 500, content: "synced", note: mockNote("note-synced") }]
			})

			mockFetchNotesWithContent.mockResolvedValue([
				{ uuid: "note-valid", editedTimestamp: BigInt(1000), content: "old-cloud" },
				{ uuid: "note-synced", editedTimestamp: BigInt(1000), content: "synced" }
			])

			await createSync()

			expect(notesState.inflightContent["note-valid"]).toHaveLength(1)
			expect(notesState.inflightContent["note-deleted"]).toBeUndefined()
			expect(notesState.inflightContent["note-synced"]).toBeUndefined()
		})

		it("resolves init even on failure", async () => {
			vi.mocked(sqlite.kvAsync.get).mockRejectedValueOnce(new Error("disk error"))

			const sync = await createSync()

			// flushToDisk awaits initPromise — if init didn't resolve, this would hang
			await sync.flushToDisk({})
		})
	})

	describe("flushToDisk", () => {
		it("writes inflight content to sqlite and reports success (M3)", async () => {
			const sync = await createSync()
			const data = {
				"note-1": [{ timestamp: 1000, content: "hello", note: mockNote("note-1") }]
			}

			const flushed = await sync.flushToDisk(data)

			expect(flushed).toBe(true)
			expect(kvStore.get(KV_KEY)).toEqual(data)
		})

		it("waits for init before flushing", async () => {
			// flushToDisk awaits initPromise — start() must be called first
			const sync = new Sync()

			sync.start()

			const data = {
				"note-1": [{ timestamp: 1000, content: "hello", note: mockNote("note-1") }]
			}

			await sync.flushToDisk(data)

			expect(kvStore.get(KV_KEY)).toEqual(data)
		})

		it("removes sqlite key when content is empty", async () => {
			kvStore.set(KV_KEY, { "note-1": [] })

			const sync = await createSync()

			await sync.flushToDisk({})

			expect(kvStore.has(KV_KEY)).toBe(false)
		})

		it("M3: catches write errors and reports them as `false` — does not throw", async () => {
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

			try {
				const sync = await createSync()

				vi.mocked(sqlite.kvAsync.set).mockRejectedValueOnce(new Error("write failed"))

				const flushed = await sync.flushToDisk({
					"note-1": [{ timestamp: 1000, content: "hello", note: mockNote("note-1") }]
				})

				// flushToDisk must not propagate the error — it reports failure as `false`
				// so component call sites can alert (sync-internal callers ignore it).
				expect(flushed).toBe(false)
				expect(consoleSpy).toHaveBeenCalledWith("Error flushing note sync to disk:", expect.any(Error))
			} finally {
				consoleSpy.mockRestore()
			}
		})

		it("writes only the remaining entries after a partial sync failure", async () => {
			const sync = await createSync()

			// Prime inflight with two notes; note-1 will fail, note-2 will succeed.
			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "will-fail", note: mockNote("note-1") }],
				"note-2": [{ timestamp: 1000, content: "will-succeed", note: mockNote("note-2") }]
			}

			mockNotesSetContent.mockRejectedValueOnce(new Error("upload failed")).mockResolvedValueOnce({ editedTimestamp: BigInt(2000) })

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			vi.mocked(sqlite.kvAsync.set).mockClear()
			vi.mocked(sqlite.kvAsync.remove).mockClear()

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// note-1 failed and must still be on disk; note-2 was cleaned and not written back.
			const written = kvStore.get(KV_KEY) as InflightContent | undefined

			expect(written).toBeDefined()
			expect(written!["note-1"]).toHaveLength(1)
			expect(written!["note-2"]).toBeUndefined()
		})
	})

	describe("sync", () => {
		it("uploads most recent content per note", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [
					{ timestamp: 1000, content: "old", note: mockNote("note-1") },
					{ timestamp: 2000, content: "latest", note: mockNote("note-1") }
				]
			}

			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(3000) })

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			sync.syncDebounced()
			sync.executeNow()

			// Wait for async sync to complete
			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNotesSetContent).toHaveBeenCalledWith({
				note: mockNote("note-1"),
				content: "latest",
				signal: expect.any(AbortSignal)
			})
		})

		it("writes the pushed content into the note content query cache with dataUpdatedAt PRESERVED (editor reseed after drain paints the typed text, no remount)", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "typed text", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(2000) })
			mockNoteContentQueryDataUpdatedAt.mockReturnValue(424242)

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNoteContentQueryUpdate).toHaveBeenCalledTimes(1)
			expect(mockNoteContentQueryUpdate).toHaveBeenCalledWith({
				params: {
					uuid: "note-1"
				},
				updater: "typed text",
				dataUpdatedAt: 424242
			})
		})

		it("does NOT touch the note content query cache when the push fails", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "typed text", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockRejectedValue(new Error("network down"))

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNoteContentQueryUpdate).not.toHaveBeenCalled()
		})

		it("removes synced entries from store", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "hello", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(2000) })

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(notesState.inflightContent["note-1"]).toBeUndefined()
		})

		it("#4: an edit typed DURING the in-flight setContent survives the prune (even when editedTimestamp >= it)", async () => {
			// Regression for #4. The prune must remove only the entry actually
			// pushed (by its LOCAL timestamp = syncedUpTo), never everything at or
			// below the SERVER editedTimestamp. We push V1 (timestamp 1000) and,
			// while setContent is in flight, inject V2 (timestamp 1500). The server
			// responds with editedTimestamp 2000 (>= V2). Under the old
			// server-clock prune V2 (1500 <= 2000) was discarded; with the
			// local-clock prune (> 1000) V2 must survive.
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "V1", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockImplementation(async () => {
				// V2 is typed during the round trip (newer local timestamp, but still
				// below the server editedTimestamp).
				notesState.inflightContent = {
					"note-1": [
						{ timestamp: 1500, content: "V2", note: mockNote("note-1") },
						{ timestamp: 1000, content: "V1", note: mockNote("note-1") }
					]
				}

				return { editedTimestamp: BigInt(2000) }
			})

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// V1 (== syncedUpTo) was pruned; V2 (typed during the round trip) survives.
			expect(notesState.inflightContent["note-1"]).toHaveLength(1)
			expect(notesState.inflightContent["note-1"]![0]!.content).toBe("V2")
		})

		it("handles partial upload failures via Promise.allSettled", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "will-fail", note: mockNote("note-1") }],
				"note-2": [{ timestamp: 1000, content: "will-succeed", note: mockNote("note-2") }]
			}

			mockNotesSetContent.mockRejectedValueOnce(new Error("upload failed")).mockResolvedValueOnce({ editedTimestamp: BigInt(2000) })

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// note-2 was synced successfully and removed
			expect(notesState.inflightContent["note-2"]).toBeUndefined()

			// note-1 failed but remains in store for retry
			expect(notesState.inflightContent["note-1"]).toHaveLength(1)
		})

		const timeoutImpl = (cb: () => void) => ({
			id: null,
			execute: vi.fn(() => cb()),
			cancel: vi.fn()
		})

		it("VC3/#40: KEEPS the inflight entry on the FIRST non-network SDK error (bounded retry — no first-failure data loss)", async () => {
			// A transient `ErrorKind.Server` (the catch-all for non-internal_error API errors)
			// on a WRITABLE note must NOT lose the edit on the first failure. The real classifier
			// runs: unwrap → truthy, network-class → false, auth → false → bounded retry path.
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "writable-edit", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockRejectedValue(asSdkError(new Error("transient server error"), ErrorKindMock.Server))
			mockCreateExecutableTimeout.mockImplementation(timeoutImpl)

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// Kept for retry after a single Server rejection (1/3).
			expect(notesState.inflightContent["note-1"]).toHaveLength(1)
			expect(notesState.inflightContent["note-1"]![0]!.content).toBe("writable-edit")
		})

		it("VC3/#40: drops the inflight entry only after MAX_NON_RETRYABLE_REJECTIONS consecutive non-network SDK errors (un-wedges a genuine permission rejection)", async () => {
			// A genuine read-only / permission rejection keeps surfacing the catch-all Server
			// error. After N consecutive attempts the entry is DROPPED so the content query
			// re-enables (enabled: !hasInflightContent) instead of wedging forever.
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "read-only-edit", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockRejectedValue(asSdkError(new Error("forbidden"), ErrorKindMock.Server))
			mockCreateExecutableTimeout.mockImplementation(timeoutImpl)

			// Fire sync MAX times; on each of the first N-1 the entry survives, on the Nth it drops.
			for (let attempt = 1; attempt <= MAX_NON_RETRYABLE_REJECTIONS; attempt++) {
				sync.executeNow()

				await new Promise(resolve => setTimeout(resolve, 0))

				if (attempt < MAX_NON_RETRYABLE_REJECTIONS) {
					expect(notesState.inflightContent["note-1"]).toHaveLength(1)
				}
			}

			// Dropped after N consecutive non-retryable rejections — query can re-enable.
			expect(notesState.inflightContent["note-1"]).toBeUndefined()
		})

		it("T2/VC3: KEEPS the inflight entry on an Unauthenticated SDK error (re-auth-recoverable — never counted toward the drop bound)", async () => {
			// Feeds a REAL Unauthenticated-kind error through the actual sdkErrors classifier.
			// api_key_not_found → ErrorKind.Unauthenticated; a writable edit must survive (it will
			// succeed once the session refreshes) and must NOT be dropped even after many attempts.
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "edit-during-reauth", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockRejectedValue(asSdkError(new Error("api_key_not_found"), ErrorKindMock.Unauthenticated))
			mockCreateExecutableTimeout.mockImplementation(timeoutImpl)

			// Far more than MAX rejections — the auth error must never advance the drop bound.
			for (let attempt = 0; attempt < MAX_NON_RETRYABLE_REJECTIONS + 2; attempt++) {
				sync.executeNow()

				await new Promise(resolve => setTimeout(resolve, 0))
			}

			expect(notesState.inflightContent["note-1"]).toHaveLength(1)
			expect(notesState.inflightContent["note-1"]![0]!.content).toBe("edit-during-reauth")
		})

		it("VC3/#40: keeps the inflight entry indefinitely on a network-class SDK error (still retryable)", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "transient", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockRejectedValue(asSdkError(new Error("network down"), ErrorKindMock.Reqwest))
			mockCreateExecutableTimeout.mockImplementation(timeoutImpl)

			// Even past the bound, a network-class error must never be counted toward the drop.
			for (let attempt = 0; attempt < MAX_NON_RETRYABLE_REJECTIONS + 1; attempt++) {
				sync.executeNow()

				await new Promise(resolve => setTimeout(resolve, 0))
			}

			expect(notesState.inflightContent["note-1"]).toHaveLength(1)
		})

		it("VC3/#40: a successful sync between failures RESETS the rejection counter (no premature drop)", async () => {
			// One Server failure (count 1), then a success drains the note. A subsequent fresh edit
			// that fails again must start a fresh count — never inherit the earlier failure.
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "v1", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockRejectedValueOnce(asSdkError(new Error("server"), ErrorKindMock.Server))
			mockCreateExecutableTimeout.mockImplementation(timeoutImpl)

			sync.executeNow()
			await new Promise(resolve => setTimeout(resolve, 0))

			expect(notesState.inflightContent["note-1"]).toHaveLength(1) // 1/3, kept

			// Now succeed — drains the note and clears its counter.
			mockNotesSetContent.mockResolvedValueOnce({ editedTimestamp: BigInt(2000) })
			sync.executeNow()
			await new Promise(resolve => setTimeout(resolve, 0))

			expect(notesState.inflightContent["note-1"]).toBeUndefined()

			// A fresh edit fails once more — must be KEPT (fresh count 1/3, not inheriting the prior 1).
			notesState.inflightContent = {
				"note-1": [{ timestamp: 3000, content: "v2", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockRejectedValueOnce(asSdkError(new Error("server again"), ErrorKindMock.Server))
			sync.executeNow()
			await new Promise(resolve => setTimeout(resolve, 0))

			expect(notesState.inflightContent["note-1"]).toHaveLength(1)
		})

		it("VC3/#40: keeps the inflight entry when setContent rejects with a non-SDK error (e.g. abort)", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "keep-me", note: mockNote("note-1") }]
			}

			// Not an SDK error at all (innerOf has no entry → hasInner false) → keep for retry.
			mockNotesSetContent.mockRejectedValue(new Error("not an sdk error"))
			mockCreateExecutableTimeout.mockImplementation(timeoutImpl)

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(notesState.inflightContent["note-1"]).toHaveLength(1)
		})

		it("skips when store is empty", async () => {
			const sync = await createSync()

			notesState.inflightContent = {}

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNotesSetContent).not.toHaveBeenCalled()
		})

		it("skips notes with empty contents array", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": []
			}

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNotesSetContent).not.toHaveBeenCalled()
		})

		it("uses the live note from query cache when available (#34 fix)", async () => {
			// If the note's metadata changed (e.g. type change via socket) between
			// the render-time snapshot stored in inflightContent and the debounce
			// flush, sync() must use the live cache entry, not the stale snapshot.
			const staleNote = { uuid: "note-1", noteType: "text" }
			const liveNote = { uuid: "note-1", noteType: "richtext" }

			mockNotesWithContentQueryGet.mockReturnValue([liveNote])

			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "hello", note: staleNote as unknown as ReturnType<typeof mockNote> }]
			}

			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(2000) })

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// setContent must have been called with the live note, not the stale snapshot
			expect(mockNotesSetContent).toHaveBeenCalledWith(
				expect.objectContaining({ note: liveNote })
			)
		})

		it("falls back to the inflight snapshot when note is absent from cache (#34 fix)", async () => {
			// If the note was concurrently deleted (cache returns null / note not found),
			// sync() must fall back to the inflight snapshot rather than dropping the entry.
			const snapshotNote = { uuid: "note-1" }

			mockNotesWithContentQueryGet.mockReturnValue([]) // note not in cache

			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "content", note: snapshotNote as ReturnType<typeof mockNote> }]
			}

			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(2000) })

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNotesSetContent).toHaveBeenCalledWith(
				expect.objectContaining({ note: snapshotNote })
			)
		})

		it("falls back to the inflight snapshot when notesWithContentQueryGet returns null (#34 fix)", async () => {
			const snapshotNote = { uuid: "note-1" }

			mockNotesWithContentQueryGet.mockReturnValue(null) // cache not yet populated

			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "cold-start", note: snapshotNote as ReturnType<typeof mockNote> }]
			}

			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(2000) })

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNotesSetContent).toHaveBeenCalledWith(
				expect.objectContaining({ note: snapshotNote })
			)
		})

		it("skips uploading when device is offline", async () => {
			const { onlineManager } = await import("@tanstack/react-query")
			const spy = vi.spyOn(onlineManager, "isOnline").mockReturnValue(false)

			try {
				const sync = await createSync()

				notesState.inflightContent = {
					"note-1": [{ timestamp: 1000, content: "hello", note: mockNote("note-1") }]
				}

				mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
					id: null,
					execute: vi.fn(() => cb()),
					cancel: vi.fn()
				}))

				sync.syncDebounced()
				sync.executeNow()

				await new Promise(resolve => setTimeout(resolve, 0))

				expect(mockNotesSetContent).not.toHaveBeenCalled()
			} finally {
				spy.mockRestore()
			}
		})

		it("syncs multiple notes in parallel", async () => {
			const sync = await createSync()
			const uploadedNotes: string[] = []

			mockNotesSetContent.mockImplementation(async ({ note }: { note: { uuid: string } }) => {
				uploadedNotes.push(note.uuid)

				return { editedTimestamp: BigInt(5000) }
			})

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "content-1", note: mockNote("note-1") }],
				"note-2": [{ timestamp: 1000, content: "content-2", note: mockNote("note-2") }],
				"note-3": [{ timestamp: 1000, content: "content-3", note: mockNote("note-3") }]
			}

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(uploadedNotes.sort()).toEqual(["note-1", "note-2", "note-3"])
			expect(Object.keys(notesState.inflightContent)).toHaveLength(0)
		})

		it("flushes final state to disk after sync", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "hello", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(2000) })
			vi.mocked(sqlite.kvAsync.set).mockClear()
			vi.mocked(sqlite.kvAsync.remove).mockClear()

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// After syncing, the empty state is flushed (key removed)
			expect(sqlite.kvAsync.remove).toHaveBeenCalledWith(KV_KEY)
		})

		// D2: an aborted pass must NEVER write the queue back to disk. Logout aborts in-flight
		// sync (Phase 2) and later wipes SQLite (Phase 6) — a late flush would resurrect the
		// previous account's plaintext queue after the wipe. Mirrors the chats sync fix.
		it("D2: does NOT flush to disk when the pass was aborted", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "hello", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockImplementation(async () => {
				// Abort mid-flight (e.g. logout) — the push itself fails with the abort.
				sync.cancel()

				throw new Error("aborted mid-flight")
			})

			vi.mocked(sqlite.kvAsync.set).mockClear()
			vi.mocked(sqlite.kvAsync.remove).mockClear()

			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(sqlite.kvAsync.set).not.toHaveBeenCalled()
			expect(sqlite.kvAsync.remove).not.toHaveBeenCalled()
		})

		it("skips upload of subsequent entries when signal is already aborted before sync starts", async () => {
			// This exercises the per-entry `if (signal.aborted) { return }` guard inside sync().
			// We pre-abort by calling cancel() before sync() has a chance to iterate entries.
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "first", note: mockNote("note-1") }],
				"note-2": [{ timestamp: 1000, content: "second", note: mockNote("note-2") }],
				"note-3": [{ timestamp: 1000, content: "third", note: mockNote("note-3") }]
			}

			// Make the first setContent call abort the controller so that
			// subsequent entries see signal.aborted === true before their guard.
			let callCount = 0

			mockNotesSetContent.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
				callCount++

				if (callCount === 1) {
					// Abort immediately so remaining entries in the allSettled loop
					// see signal.aborted === true before their individual checks.
					sync.cancel()

					// Returning a valid response so the first entry itself is handled.
					return { editedTimestamp: BigInt(5000) }
				}

				if (signal.aborted) {
					throw new DOMException("Aborted", "AbortError")
				}

				return { editedTimestamp: BigInt(5000) }
			})

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// Because abort is checked per-entry before calling setContent,
			// at most 1 call (the one that triggered cancel) must have reached setContent.
			// Entries guarded by signal.aborted===true return early without calling setContent.
			expect(mockNotesSetContent).toHaveBeenCalledTimes(1)
		})
	})

	// D3 (binding user decision): local edits ALWAYS win — the push is unconditional, the
	// conflict machinery only DETECTS that a push buried newer remote work and toasts once,
	// so the overwrite is never silent ("users won't know history has it" is the failure
	// being prevented).
	describe("D3 overwrite-conflict detection", () => {
		it("pushes anyway (local wins) and toasts ONCE per pass when the cloud moved past the session base", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [
					{
						timestamp: 1000,
						content: "local-wins",
						note: mockNote("note-1"),
						baseContentHash: hashNoteContent("base-content")
					}
				]
			}

			// Cloud moved past the base AND differs from what we push → conflict.
			mockNotesGetContent.mockResolvedValue("newer-remote-content")
			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(2000) })

			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// The push still happened with the local content (local wins, never blocked)…
			expect(mockNotesSetContent).toHaveBeenCalledWith(expect.objectContaining({ content: "local-wins" }))
			// …the queue drained…
			expect(notesState.inflightContent["note-1"]).toBeUndefined()
			// …and exactly ONE toast fired (deduped per note per pass), pointing at history.
			expect(alerts.normal).toHaveBeenCalledTimes(1)
			expect(alerts.normal).toHaveBeenCalledWith("note_overwrote_newer_remote_changes")
		})

		it("does not toast when the cloud still equals the session base (no conflict)", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [
					{
						timestamp: 1000,
						content: "local-edit",
						note: mockNote("note-1"),
						baseContentHash: hashNoteContent("base-content")
					}
				]
			}

			mockNotesGetContent.mockResolvedValue("base-content")
			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(2000) })

			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNotesSetContent).toHaveBeenCalledWith(expect.objectContaining({ content: "local-edit" }))
			expect(alerts.normal).not.toHaveBeenCalled()
		})

		it("does not toast when the cloud already equals the content being pushed", async () => {
			// E.g. our own previous push landed but the prune was interrupted — re-pushing
			// identical content overwrites nothing.
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [
					{
						timestamp: 1000,
						content: "same-as-cloud",
						note: mockNote("note-1"),
						baseContentHash: hashNoteContent("older-base")
					}
				]
			}

			mockNotesGetContent.mockResolvedValue("same-as-cloud")
			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(2000) })

			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNotesSetContent).toHaveBeenCalled()
			expect(alerts.normal).not.toHaveBeenCalled()
		})

		it("legacy entries without a base hash push WITHOUT the conflict check (one-time grace)", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "restored-from-old-version", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(2000) })

			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// No cloud peek, no toast — the push itself still went out.
			expect(mockNotesGetContent).not.toHaveBeenCalled()
			expect(alerts.normal).not.toHaveBeenCalled()
			expect(mockNotesSetContent).toHaveBeenCalledWith(expect.objectContaining({ content: "restored-from-old-version" }))
			expect(notesState.inflightContent["note-1"]).toBeUndefined()
		})

		it("a failed cloud peek still pushes and stays silent (availability beats the toast)", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [
					{
						timestamp: 1000,
						content: "push-me-regardless",
						note: mockNote("note-1"),
						baseContentHash: hashNoteContent("base-content")
					}
				]
			}

			mockNotesGetContent.mockRejectedValue(new Error("peek failed"))
			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(2000) })

			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNotesSetContent).toHaveBeenCalledWith(expect.objectContaining({ content: "push-me-regardless" }))
			expect(notesState.inflightContent["note-1"]).toBeUndefined()
			expect(alerts.normal).not.toHaveBeenCalled()
			expect(alerts.error).not.toHaveBeenCalled()
		})

		it("entries typed during the round trip inherit the pushed content's hash as their new base", async () => {
			// Otherwise the NEXT pass would fetch our own push as "cloud", compare it against
			// the stale session base and toast a false conflict on every pause-resume cycle.
			const sync = await createSync()

			const staleBase = hashNoteContent("base-content")

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "V1", note: mockNote("note-1"), baseContentHash: staleBase }]
			}

			mockNotesGetContent.mockResolvedValue("base-content")

			mockNotesSetContent.mockImplementation(async () => {
				// V2 is typed during the setContent round trip.
				notesState.inflightContent = {
					"note-1": [
						{ timestamp: 1500, content: "V2", note: mockNote("note-1"), baseContentHash: staleBase },
						{ timestamp: 1000, content: "V1", note: mockNote("note-1"), baseContentHash: staleBase }
					]
				}

				return { editedTimestamp: BigInt(2000) }
			})

			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// V1 pruned; V2 survives with the pushed content's hash as its refreshed base.
			expect(notesState.inflightContent["note-1"]).toHaveLength(1)
			expect(notesState.inflightContent["note-1"]![0]!.content).toBe("V2")
			expect(notesState.inflightContent["note-1"]![0]!.baseContentHash).toBe(hashNoteContent("V1"))
		})

		it("an aborted pass never toasts", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [
					{
						timestamp: 1000,
						content: "local-wins",
						note: mockNote("note-1"),
						baseContentHash: hashNoteContent("base-content")
					}
				]
			}

			mockNotesGetContent.mockResolvedValue("newer-remote-content")

			mockNotesSetContent.mockImplementation(async () => {
				// The push itself lands, but the pass is aborted (e.g. logout) before the toast.
				sync.cancel()

				return { editedTimestamp: BigInt(2000) }
			})

			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNotesSetContent).toHaveBeenCalled()
			expect(alerts.normal).not.toHaveBeenCalled()
		})
	})

	describe("syncDebounced / executeNow", () => {
		it("cancels previous timeout on new call", async () => {
			const cancelFn = vi.fn()

			mockCreateExecutableTimeout.mockReturnValue({
				id: null,
				execute: vi.fn(),
				cancel: cancelFn
			})

			const sync = await createSync()

			sync.syncDebounced()
			sync.syncDebounced()

			expect(cancelFn).toHaveBeenCalledTimes(1)
			expect(mockCreateExecutableTimeout).toHaveBeenCalledTimes(2)
		})

		it("executeNow fires the pending sync callback", async () => {
			const executeFn = vi.fn()

			mockCreateExecutableTimeout.mockReturnValue({
				id: null,
				execute: executeFn,
				cancel: vi.fn()
			})

			const sync = await createSync()

			sync.syncDebounced()
			sync.executeNow()

			expect(executeFn).toHaveBeenCalledTimes(1)
		})

		it("executeNow falls through to a direct sync() call when no debounce is queued (reconnect path)", async () => {
			// Source comment: "Fall through to a direct sync() when no debounce is queued.
			// This catches the cold-start + offline + reconnect case."
			// When syncTimeout is null, executeNow must invoke sync() directly.
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "reconnect-content", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(2000) })

			// No syncDebounced() called — syncTimeout is null.
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			// The direct sync() path must have uploaded the inflight note.
			expect(mockNotesSetContent).toHaveBeenCalledWith({
				note: mockNote("note-1"),
				content: "reconnect-content",
				signal: expect.any(AbortSignal)
			})
			// And cleaned it from the store after success.
			expect(notesState.inflightContent["note-1"]).toBeUndefined()
		})

		it("cancel() aborts the signal that is already threaded into setContent", async () => {
			const sync = await createSync()
			let observedSignal: AbortSignal | undefined

			mockNotesSetContent.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
				observedSignal = signal
				sync.cancel()

				return { editedTimestamp: BigInt(2000) }
			})

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "hello", note: mockNote("note-1") }]
			}

			mockCreateExecutableTimeout.mockImplementation((cb: () => void) => ({
				id: null,
				execute: vi.fn(() => cb()),
				cancel: vi.fn()
			}))

			sync.syncDebounced()
			sync.executeNow()

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(observedSignal).toBeDefined()
			expect(observedSignal?.aborted).toBe(true)
		})
	})

	describe("SyncHost component", () => {
		it("registers an AppState change listener on mount", () => {
			// SyncHost's useEffect wires AppState.addEventListener("change", ...)
			const addEventListenerSpy = vi.spyOn(AppState, "addEventListener")

			const { unmount } = render(React.createElement(SyncHost))

			expect(addEventListenerSpy).toHaveBeenCalledWith("change", expect.any(Function))

			unmount()
			addEventListenerSpy.mockRestore()
		})

		it("calls executeNow when AppState transitions to active", async () => {
			const appStateEmitter = AppState as unknown as { _emit: (type: string, state: string) => void }

			// Mount SyncHost so its useEffect registers the listener.
			const { unmount } = render(React.createElement(SyncHost))

			// Prime inflight content so we can observe whether sync fired.
			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "bg-content", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(2000) })

			// Simulate foreground transition.
			appStateEmitter._emit("change", "active")

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNotesSetContent).toHaveBeenCalled()

			unmount()
		})

		it("calls executeNow when AppState transitions to background", async () => {
			// sync.tsx:221 fires executeNow for BOTH 'background' and 'active'.
			// A regression that narrows the condition to === 'active' only would
			// be undetected without this branch.
			const appStateEmitter = AppState as unknown as { _emit: (type: string, state: string) => void }

			const { unmount } = render(React.createElement(SyncHost))

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "bg-content", note: mockNote("note-1") }]
			}

			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(2000) })

			// Simulate the app moving to the background (e.g. user pressing home).
			appStateEmitter._emit("change", "background")

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNotesSetContent).toHaveBeenCalled()

			unmount()
		})

		it("does not call executeNow for unhandled AppState transitions (e.g. inactive)", async () => {
			// Only 'active' and 'background' are handled; other states (e.g. 'inactive')
			// must not trigger a sync.
			const appStateEmitter = AppState as unknown as { _emit: (type: string, state: string) => void }

			const { unmount } = render(React.createElement(SyncHost))

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "inactive-content", note: mockNote("note-1") }]
			}

			appStateEmitter._emit("change", "inactive")

			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNotesSetContent).not.toHaveBeenCalled()

			unmount()
		})

		it("removes AppState listener on unmount", () => {
			const removeListenerSpy = vi.fn()

			vi.mocked(AppState.addEventListener).mockReturnValueOnce({ remove: removeListenerSpy })

			const { unmount } = render(React.createElement(SyncHost))

			unmount()

			expect(removeListenerSpy).toHaveBeenCalledTimes(1)
		})
	})

	describe("mergeInflight (#41)", () => {
		it("seeds uuids the current store does not have", () => {
			const current = {}
			const fromDisk = {
				"note-1": [{ timestamp: 1000, content: "disk", note: mockNote("note-1") }]
			}

			const merged = mergeInflight(current, fromDisk)

			expect(merged["note-1"]).toHaveLength(1)
			expect(merged["note-1"]![0]!.content).toBe("disk")
		})

		it("keeps the fresher current store edit over a staler disk entry", () => {
			const current = {
				"note-1": [{ timestamp: 5000, content: "current-newer", note: mockNote("note-1") }]
			}
			const fromDisk = {
				"note-1": [{ timestamp: 1000, content: "disk-older", note: mockNote("note-1") }]
			}

			const merged = mergeInflight(current, fromDisk)

			expect(merged["note-1"]).toHaveLength(1)
			expect(merged["note-1"]![0]!.content).toBe("current-newer")
		})

		it("takes the disk entry when it is newer than the current store entry", () => {
			const current = {
				"note-1": [{ timestamp: 1000, content: "current-older", note: mockNote("note-1") }]
			}
			const fromDisk = {
				"note-1": [{ timestamp: 5000, content: "disk-newer", note: mockNote("note-1") }]
			}

			const merged = mergeInflight(current, fromDisk)

			expect(merged["note-1"]).toHaveLength(1)
			expect(merged["note-1"]![0]!.content).toBe("disk-newer")
		})

		it("preserves current-only uuids untouched", () => {
			const current = {
				"note-other": [{ timestamp: 2000, content: "stays", note: mockNote("note-other") }]
			}
			const fromDisk = {
				"note-1": [{ timestamp: 1000, content: "disk", note: mockNote("note-1") }]
			}

			const merged = mergeInflight(current, fromDisk)

			expect(merged["note-other"]![0]!.content).toBe("stays")
			expect(merged["note-1"]![0]!.content).toBe("disk")
		})
	})
})
