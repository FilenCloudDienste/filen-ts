import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// useNoteContent.query / useNoteHistory.query fetchData cache-coherence fallback:
//   the uuid→note cache map is populated only by the notes list fetch, so a note present only in
//   the restored or optimistically-updated list query must still resolve via notesQueryGet before
//   fetchData gives up. On a DOUBLE miss content still returns undefined and history still returns [],
//   after logging a warn.

const { mockGetSdkClients, mockSdkClient, mockNotesQueryGet, cacheMap } = vi.hoisted(() => {
	const mockSdkClient = {
		getNoteContent: vi.fn(),
		getNoteHistory: vi.fn()
	}

	return {
		mockSdkClient,
		mockGetSdkClients: vi.fn().mockResolvedValue({ authedSdkClient: mockSdkClient }),
		mockNotesQueryGet: vi.fn().mockReturnValue(undefined),
		cacheMap: new Map<string, unknown>()
	}
})

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => ({
	...(await import("@/tests/mocks/filenUtils")),
	// sortParams is only used by the query hooks/updaters — identity is fine for the fetchData tests.
	sortParams: <T>(params: T): T => params
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		noteUuidToNote: cacheMap
	}
}))

vi.mock("@/features/notes/queries/useNotesQuery", () => ({
	notesQueryGet: mockNotesQueryGet
}))

vi.mock("@/queries/client", () => ({
	default: {
		getQueryState: vi.fn(),
		getQueryData: vi.fn()
	},
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: {
		get: vi.fn(),
		set: vi.fn()
	}
}))

import { fetchData as fetchNoteContent } from "@/features/notes/queries/useNoteContent.query"
import { fetchData as fetchNoteHistory } from "@/features/notes/queries/useNoteHistory.query"
import logger from "@/lib/logger"

beforeEach(() => {
	cacheMap.clear()
	mockGetSdkClients.mockClear()
	mockSdkClient.getNoteContent.mockReset()
	mockSdkClient.getNoteHistory.mockReset()
	mockNotesQueryGet.mockReset().mockReturnValue(undefined)
	vi.mocked(logger.warn).mockClear()
})

describe("useNoteContent.query fetchData (cache-coherence fallback)", () => {
	it("resolves the note from cache.noteUuidToNote and fetches its content", async () => {
		const note = { uuid: "note-1" }

		cacheMap.set("note-1", note)
		mockSdkClient.getNoteContent.mockResolvedValueOnce({ content: "hello" })

		const result = await fetchNoteContent({ uuid: "note-1" })

		// Map hit short-circuits the fallback (?? does not evaluate the right side).
		expect(mockNotesQueryGet).not.toHaveBeenCalled()
		expect(mockSdkClient.getNoteContent).toHaveBeenCalledTimes(1)
		expect(mockSdkClient.getNoteContent).toHaveBeenCalledWith(note, undefined)
		expect(result).toEqual({ content: "hello" })
	})

	it("falls back to notesQueryGet on a cache miss, then fetches content", async () => {
		const note = { uuid: "note-2" }

		mockNotesQueryGet.mockReturnValue([{ uuid: "other" }, note])
		mockSdkClient.getNoteContent.mockResolvedValueOnce({ content: "from-list-query" })

		const result = await fetchNoteContent({ uuid: "note-2" })

		expect(mockNotesQueryGet).toHaveBeenCalled()
		expect(mockSdkClient.getNoteContent).toHaveBeenCalledWith(note, undefined)
		expect(result).toEqual({ content: "from-list-query" })
	})

	it("returns undefined and warns on a double miss (in neither cache nor list query)", async () => {
		mockNotesQueryGet.mockReturnValue([{ uuid: "someone-else" }])

		const result = await fetchNoteContent({ uuid: "missing" })

		expect(result).toBeUndefined()
		expect(mockSdkClient.getNoteContent).not.toHaveBeenCalled()
		expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1)
	})

	it("returns undefined and warns on a double miss when the list query was never restored", async () => {
		mockNotesQueryGet.mockReturnValue(undefined)

		const result = await fetchNoteContent({ uuid: "missing" })

		expect(result).toBeUndefined()
		expect(mockSdkClient.getNoteContent).not.toHaveBeenCalled()
		expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1)
	})
})

describe("useNoteHistory.query fetchData (cache-coherence fallback)", () => {
	it("resolves the note from cache.noteUuidToNote and fetches its history", async () => {
		const note = { uuid: "note-1" }
		const history = [{ id: 1n }, { id: 2n }]

		cacheMap.set("note-1", note)
		mockSdkClient.getNoteHistory.mockResolvedValueOnce(history)

		const result = await fetchNoteHistory({ uuid: "note-1" })

		expect(mockNotesQueryGet).not.toHaveBeenCalled()
		expect(mockSdkClient.getNoteHistory).toHaveBeenCalledTimes(1)
		expect(mockSdkClient.getNoteHistory).toHaveBeenCalledWith(note, undefined)
		expect(result).toBe(history)
	})

	it("falls back to notesQueryGet on a cache miss, then fetches history", async () => {
		const note = { uuid: "note-2" }
		const history = [{ id: 3n }]

		mockNotesQueryGet.mockReturnValue([{ uuid: "other" }, note])
		mockSdkClient.getNoteHistory.mockResolvedValueOnce(history)

		const result = await fetchNoteHistory({ uuid: "note-2" })

		expect(mockNotesQueryGet).toHaveBeenCalled()
		expect(mockSdkClient.getNoteHistory).toHaveBeenCalledWith(note, undefined)
		expect(result).toBe(history)
	})

	it("returns [] and warns on a double miss (in neither cache nor list query)", async () => {
		mockNotesQueryGet.mockReturnValue([{ uuid: "someone-else" }])

		const result = await fetchNoteHistory({ uuid: "missing" })

		expect(result).toEqual([])
		expect(mockSdkClient.getNoteHistory).not.toHaveBeenCalled()
		expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1)
	})

	it("returns [] and warns on a double miss when the list query was never restored", async () => {
		mockNotesQueryGet.mockReturnValue(undefined)

		const result = await fetchNoteHistory({ uuid: "missing" })

		expect(result).toEqual([])
		expect(mockSdkClient.getNoteHistory).not.toHaveBeenCalled()
		expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1)
	})
})
