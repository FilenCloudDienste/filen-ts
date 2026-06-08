import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

// ---------------------------------------------------------------------------
// Hoisted mocks (must be defined before any imports)
// ---------------------------------------------------------------------------

const { mockGetSdkClients, mockNotesWithContentQueryUpdate, mockFlushToDisk } = vi.hoisted(() => ({
	mockGetSdkClients: vi.fn(),
	mockNotesWithContentQueryUpdate: vi.fn(),
	mockFlushToDisk: vi.fn().mockResolvedValue(undefined)
}))

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/features/notes/queries/useNotesWithContent.query", () => ({
	notesWithContentQueryUpdate: mockNotesWithContentQueryUpdate
}))

vi.mock("@/features/notes/queries/useNoteContent.query", () => ({
	noteContentQueryUpdate: vi.fn()
}))

vi.mock("@/features/notes/components/sync", () => ({
	sync: {
		flushToDisk: mockFlushToDisk
	}
}))

vi.mock("@filen/sdk-rs", () => ({
	NoteType: {
		Text: "text",
		Md: "md",
		Code: "code",
		Rich: "rich",
		Checklist: "checklist"
	}
}))

vi.mock("@/lib/i18n", () => ({
	default: {
		t: (key: string) => key
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		noteUuidToNote: { get: vi.fn(), set: vi.fn() },
		dirUuidToDir: { get: vi.fn(), set: vi.fn() },
		fileUuidToFile: { get: vi.fn(), set: vi.fn() }
	}
}))

vi.mock("react-native-mmkv", async () => await import("@/tests/mocks/reactNativeMMKV"))

vi.mock("expo-secure-store", async () => await import("@/tests/mocks/expoSecureStore"))

vi.mock("@op-engineering/op-sqlite", async () => await import("@/tests/mocks/opSqlite"))

vi.mock("expo-localization", () => ({
	getLocales: vi.fn(() => [{ languageTag: "en-US", regionCode: "US" }]),
	locale: "en-US",
	locales: [{ languageTag: "en-US" }],
	timezone: "UTC"
}))

vi.mock("@filen/utils", async () => ({
	...(await import("@/tests/mocks/filenUtils")),
	createNotePreviewFromContentText: vi.fn().mockReturnValue("preview-text"),
	sortParams: vi.fn(x => x)
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { restoreFromHistory, deleteNote } from "@/features/notes/notesLifecycle"
import { leave } from "@/features/notes/notesParticipants"
import { type Note, type NoteHistory } from "@/types"
import useNotesInflightStore from "@/features/notes/store/useNotesInflight.store"
import useNotesStore from "@/features/notes/store/useNotes.store"

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: "note-uuid-1",
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		encryptionKey: "some-key",
		title: "Test Note",
		preview: "preview",
		trash: false,
		archive: false,
		createdTimestamp: 1000n,
		editedTimestamp: 2000n,
		participants: [],
		undecryptable: false,
		...overrides
	} as Note
}

function makeHistory(overrides: Partial<NoteHistory> = {}): NoteHistory {
	return {
		id: 42n,
		noteUuid: "note-uuid-1",
		preview: "preview-text",
		editedTimestamp: 3000n,
		...overrides
	} as unknown as NoteHistory
}

function makeSdkNote(uuid: string, overrides: Partial<Note> = {}) {
	return {
		uuid,
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		encryptionKey: "some-key",
		title: "Test Note",
		trash: false,
		archive: false,
		createdTimestamp: 1000n,
		editedTimestamp: 2000n,
		participants: [],
		...overrides
	}
}

function makeMockSdkClient(overrides: Record<string, unknown> = {}) {
	return {
		restoreNoteFromHistory: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1", { title: "Restored Title" })),
		...overrides
	}
}

// ---------------------------------------------------------------------------
// Tests: restoreFromHistory (#47)
// ---------------------------------------------------------------------------

describe("restoreFromHistory", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
		mockFlushToDisk.mockClear()
		mockFlushToDisk.mockResolvedValue(undefined)
		useNotesInflightStore.getState().setInflightContent({})
	})

	it("calls authedSdkClient.restoreNoteFromHistory with the note and history args", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote()
		const history = makeHistory()

		await restoreFromHistory({ note, history })

		expect(sdkClient.restoreNoteFromHistory).toHaveBeenCalledWith(note, history, undefined)
	})

	it("calls authedSdkClient.restoreNoteFromHistory with signal when provided", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote()
		const history = makeHistory()
		const controller = new AbortController()

		await restoreFromHistory({ note, history, signal: controller.signal })

		expect(sdkClient.restoreNoteFromHistory).toHaveBeenCalledWith(note, history, { signal: controller.signal })
	})

	it("calls notesWithContentQueryUpdate exactly once", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote()
		const history = makeHistory()

		await restoreFromHistory({ note, history })

		expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledTimes(1)
	})

	it("updater preserves n.content from the live cache entry for the matching uuid", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1" })
		const history = makeHistory()
		const cacheEntry = { ...note, content: "cached-content" }

		await restoreFromHistory({ note, history })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([cacheEntry])

		expect(result).toHaveLength(1)
		expect(result[0].content).toBe("cached-content")
	})

	it("updater spreads the updated note (returned by SDK) onto the matching cache entry", async () => {
		const sdkClient = makeMockSdkClient({
			restoreNoteFromHistory: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1", { title: "Restored From History" }))
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1", title: "Old Title" })
		const history = makeHistory()
		const cacheEntry = { ...note, content: "live-content" }

		await restoreFromHistory({ note, history })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([cacheEntry])

		expect(result[0].title).toBe("Restored From History")
		expect(result[0].content).toBe("live-content")
	})

	it("updater leaves entries with non-matching uuids unchanged", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1" })
		const history = makeHistory()
		const otherEntry = { ...makeNote({ uuid: "other-uuid" }), content: "other-content" }

		await restoreFromHistory({ note, history })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([otherEntry])

		expect(result).toHaveLength(1)
		expect(result[0].uuid).toBe("other-uuid")
		expect(result[0].content).toBe("other-content")
	})

	it("returns the updated note from the SDK (wrapped with undecryptable flag)", async () => {
		const sdkClient = makeMockSdkClient({
			restoreNoteFromHistory: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1", { encryptionKey: "new-key", title: "Restored" }))
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote()
		const history = makeHistory()

		const result = await restoreFromHistory({ note, history })

		expect(result.uuid).toBe("note-uuid-1")
		expect(result.title).toBe("Restored")
		expect(result.undecryptable).toBe(false)
	})

	it("sets undecryptable:true when SDK returns a note without encryptionKey", async () => {
		const sdkClient = makeMockSdkClient({
			restoreNoteFromHistory: vi.fn().mockResolvedValue({ ...makeSdkNote("note-uuid-1"), encryptionKey: undefined })
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote()
		const history = makeHistory()

		const result = await restoreFromHistory({ note, history })

		expect(result.undecryptable).toBe(true)
	})

	it("removes the restored note's inflight content so a stale pre-restore edit cannot overwrite it", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1" })
		const history = makeHistory()

		// Simulate a still-queued pre-restore edit for this note plus an unrelated one.
		useNotesInflightStore.getState().setInflightContent({
			"note-uuid-1": [{ timestamp: 1234, content: "stale pre-restore edit", note }],
			"other-uuid": [{ timestamp: 5678, content: "untouched", note: makeNote({ uuid: "other-uuid" }) }]
		})

		await restoreFromHistory({ note, history })

		const inflight = useNotesInflightStore.getState().inflightContent

		expect(inflight["note-uuid-1"]).toBeUndefined()
		// Inflight for unrelated notes must be left intact.
		expect(inflight["other-uuid"]).toBeDefined()
	})

	it("flushes the cleared inflight content to disk after restore", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1" })
		const history = makeHistory()

		useNotesInflightStore.getState().setInflightContent({
			"note-uuid-1": [{ timestamp: 1234, content: "stale pre-restore edit", note }]
		})

		await restoreFromHistory({ note, history })

		expect(mockFlushToDisk).toHaveBeenCalledTimes(1)

		// The flushed snapshot must already exclude the restored note's inflight entry.
		const flushedArg = mockFlushToDisk.mock.calls[0]?.[0]

		expect(flushedArg).toBeDefined()
		expect(flushedArg["note-uuid-1"]).toBeUndefined()
	})

	it("does not break when there is no inflight content for the restored note", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1" })
		const history = makeHistory()

		await restoreFromHistory({ note, history })

		expect(useNotesInflightStore.getState().inflightContent["note-uuid-1"]).toBeUndefined()
		expect(mockFlushToDisk).toHaveBeenCalledTimes(1)
	})
})

// ---------------------------------------------------------------------------
// Tests: deleteNote selection purge (#14 — selection ghost)
// ---------------------------------------------------------------------------

describe("deleteNote selection purge", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
		useNotesStore.getState().setSelectedNotes([])
	})

	afterEach(() => {
		vi.clearAllTimers()
		vi.useRealTimers()
	})

	it("removes the deleted note from selectedNotes immediately, leaving others intact", async () => {
		const sdkClient = { deleteNote: vi.fn().mockResolvedValue(undefined) }
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const deleted = makeNote({ uuid: "note-uuid-1", trash: true })
		const other = makeNote({ uuid: "other-uuid", trash: true })

		useNotesStore.getState().setSelectedNotes([deleted, other])

		await deleteNote({ note: deleted })

		const selected = useNotesStore.getState().selectedNotes

		expect(selected).toHaveLength(1)
		expect(selected[0]?.uuid).toBe("other-uuid")
	})

	it("does not touch selectedNotes when the note is not trashed (early return)", async () => {
		const sdkClient = { deleteNote: vi.fn().mockResolvedValue(undefined) }
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1", trash: false })

		useNotesStore.getState().setSelectedNotes([note])

		await deleteNote({ note })

		expect(sdkClient.deleteNote).not.toHaveBeenCalled()
		expect(useNotesStore.getState().selectedNotes).toHaveLength(1)
	})

	it("purges the selection before the 3s query-cache timeout fires", async () => {
		const sdkClient = { deleteNote: vi.fn().mockResolvedValue(undefined) }
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const deleted = makeNote({ uuid: "note-uuid-1", trash: true })

		useNotesStore.getState().setSelectedNotes([deleted])

		await deleteNote({ note: deleted })

		// Selection is cleared synchronously after the await, before any timer runs.
		expect(useNotesStore.getState().selectedNotes).toHaveLength(0)
		// The query-cache filter is still deferred to the timeout.
		expect(mockNotesWithContentQueryUpdate).not.toHaveBeenCalled()

		vi.advanceTimersByTime(3000)

		expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledTimes(1)
	})
})

// ---------------------------------------------------------------------------
// Tests: leave() selection purge (#14 — selection ghost)
// ---------------------------------------------------------------------------

describe("leave selection purge", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
		useNotesStore.getState().setSelectedNotes([])
	})

	afterEach(() => {
		vi.clearAllTimers()
		vi.useRealTimers()
	})

	it("removes the left note from selectedNotes immediately, leaving others intact", async () => {
		const sdkClient = {
			removeNoteParticipant: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1")),
			toStringified: vi.fn().mockResolvedValue({ userId: 1n })
		}
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const left = makeNote({ uuid: "note-uuid-1" })
		const other = makeNote({ uuid: "other-uuid" })

		useNotesStore.getState().setSelectedNotes([left, other])

		await leave({ note: left })

		const selected = useNotesStore.getState().selectedNotes

		expect(selected).toHaveLength(1)
		expect(selected[0]?.uuid).toBe("other-uuid")
	})

	it("purges the selection before the 3s query-cache timeout fires", async () => {
		const sdkClient = {
			removeNoteParticipant: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1")),
			toStringified: vi.fn().mockResolvedValue({ userId: 1n })
		}
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const left = makeNote({ uuid: "note-uuid-1" })

		useNotesStore.getState().setSelectedNotes([left])

		await leave({ note: left })

		expect(useNotesStore.getState().selectedNotes).toHaveLength(0)
		expect(mockNotesWithContentQueryUpdate).not.toHaveBeenCalled()

		vi.advanceTimersByTime(3000)

		expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledTimes(1)
	})
})
