import { vi, describe, it, expect, beforeEach } from "vitest"

const { kvStore, notesState, mockNotesSetContent, mockFetchNotesWithContent, mockCreateExecutableTimeout } = vi.hoisted(() => ({
	kvStore: new Map<string, unknown>(),
	notesState: {
		inflightContent: {} as Record<string, { timestamp: number; content: string; note: { uuid: string } }[]>
	},
	mockNotesSetContent: vi.fn().mockResolvedValue({
		editedTimestamp: BigInt(0)
	}),
	mockFetchNotesWithContent: vi.fn().mockResolvedValue([]),
	mockCreateExecutableTimeout: vi.fn()
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
	},
	createExecutableTimeout: (...args: unknown[]) => mockCreateExecutableTimeout(...args)
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

vi.mock("@/stores/useNotes.store", () => {
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

vi.mock("@/lib/notes", () => ({
	default: {
		setContent: mockNotesSetContent
	}
}))

vi.mock("@/queries/useNotesWithContent.query", () => ({
	fetchData: mockFetchNotesWithContent
}))

vi.mock("@/lib/alerts", () => ({
	default: {
		error: vi.fn()
	}
}))

import { Sync } from "@/components/notes/sync"
import sqlite from "@/lib/sqlite"
import type { InflightContent } from "@/stores/useNotes.store"

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
		mockFetchNotesWithContent.mockResolvedValue([])
		mockCreateExecutableTimeout.mockClear()
		vi.mocked(sqlite.kvAsync.get).mockClear()
		vi.mocked(sqlite.kvAsync.set).mockClear()
		vi.mocked(sqlite.kvAsync.remove).mockClear()
	})

	describe("restoreFromDisk", () => {
		it("loads inflight content from disk and sets store", async () => {
			const note = mockNote("note-1")

			kvStore.set(KV_KEY, {
				"note-1": [{ timestamp: 5000, content: "hello", note }]
			})

			mockFetchNotesWithContent.mockResolvedValue([{ uuid: "note-1", editedTimestamp: BigInt(1000) }])

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

		it("prunes entries older than cloud editedTimestamp", async () => {
			kvStore.set(KV_KEY, {
				"note-1": [
					{ timestamp: 500, content: "old", note: mockNote("note-1") },
					{ timestamp: 2000, content: "new", note: mockNote("note-1") }
				]
			})

			mockFetchNotesWithContent.mockResolvedValue([{ uuid: "note-1", editedTimestamp: BigInt(1000) }])

			await createSync()

			expect(notesState.inflightContent["note-1"]).toHaveLength(1)
			expect(notesState.inflightContent["note-1"]![0]!.content).toBe("new")
		})

		it("handles empty disk gracefully", async () => {
			await createSync()

			expect(notesState.inflightContent).toEqual({})
		})

		it("triggers sync when restored data exists", async () => {
			kvStore.set(KV_KEY, {
				"note-1": [{ timestamp: 5000, content: "pending", note: mockNote("note-1") }]
			})

			mockFetchNotesWithContent.mockResolvedValue([{ uuid: "note-1", editedTimestamp: BigInt(1000) }])
			mockNotesSetContent.mockResolvedValue({ editedTimestamp: BigInt(6000) })

			await createSync()

			// sync() is fire-and-forget after restore — wait for it to settle
			await new Promise(resolve => setTimeout(resolve, 0))

			expect(mockNotesSetContent).toHaveBeenCalled()
		})

		it("removes note entirely when all entries are stale after filter", async () => {
			kvStore.set(KV_KEY, {
				"note-1": [
					{ timestamp: 500, content: "stale-1", note: mockNote("note-1") },
					{ timestamp: 800, content: "stale-2", note: mockNote("note-1") }
				]
			})

			mockFetchNotesWithContent.mockResolvedValue([{ uuid: "note-1", editedTimestamp: BigInt(1000) }])

			await createSync()

			expect(notesState.inflightContent["note-1"]).toBeUndefined()
			expect(Object.keys(notesState.inflightContent)).toHaveLength(0)
		})

		it("handles mixed data: some notes valid, some pruned", async () => {
			kvStore.set(KV_KEY, {
				"note-valid": [{ timestamp: 5000, content: "keep", note: mockNote("note-valid") }],
				"note-deleted": [{ timestamp: 5000, content: "remove", note: mockNote("note-deleted") }],
				"note-stale": [{ timestamp: 500, content: "old", note: mockNote("note-stale") }]
			})

			mockFetchNotesWithContent.mockResolvedValue([
				{ uuid: "note-valid", editedTimestamp: BigInt(1000) },
				{ uuid: "note-stale", editedTimestamp: BigInt(1000) }
			])

			await createSync()

			expect(notesState.inflightContent["note-valid"]).toHaveLength(1)
			expect(notesState.inflightContent["note-deleted"]).toBeUndefined()
			expect(notesState.inflightContent["note-stale"]).toBeUndefined()
		})

		it("resolves init even on failure", async () => {
			vi.mocked(sqlite.kvAsync.get).mockRejectedValueOnce(new Error("disk error"))

			const sync = await createSync()

			// flushToDisk awaits initPromise — if init didn't resolve, this would hang
			await sync.flushToDisk({})
		})
	})

	describe("flushToDisk", () => {
		it("writes inflight content to sqlite", async () => {
			const sync = await createSync()
			const data = {
				"note-1": [{ timestamp: 1000, content: "hello", note: mockNote("note-1") }]
			}

			await sync.flushToDisk(data)

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
				content: "latest"
			})
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

		it("handles partial upload failures via Promise.allSettled", async () => {
			const sync = await createSync()

			notesState.inflightContent = {
				"note-1": [{ timestamp: 1000, content: "will-fail", note: mockNote("note-1") }],
				"note-2": [{ timestamp: 1000, content: "will-succeed", note: mockNote("note-2") }]
			}

			mockNotesSetContent
				.mockRejectedValueOnce(new Error("upload failed"))
				.mockResolvedValueOnce({ editedTimestamp: BigInt(2000) })

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

		it("executeNow is a no-op when no pending sync", async () => {
			const sync = await createSync()

			// Should not throw
			sync.executeNow()
		})
	})
})
