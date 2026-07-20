import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// useNoteContent.query / useNoteHistory.query fetchData resolution:
//   the notes list query is the sole substrate for note identity — the screens gate on it before
//   these queries run — so fetchData resolves the note via notesQueryGet. On a miss content returns
//   undefined and history returns [], after logging a warn.

const { mockGetSdkClients, mockSdkClient, mockNotesQueryGet } = vi.hoisted(() => {
	const mockSdkClient = {
		getNoteContent: vi.fn(),
		getNoteHistory: vi.fn()
	}

	return {
		mockSdkClient,
		mockGetSdkClients: vi.fn().mockResolvedValue({ authedSdkClient: mockSdkClient }),
		mockNotesQueryGet: vi.fn().mockReturnValue(undefined)
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
	mockGetSdkClients.mockClear()
	mockSdkClient.getNoteContent.mockReset()
	mockSdkClient.getNoteHistory.mockReset()
	mockNotesQueryGet.mockReset().mockReturnValue(undefined)
	vi.mocked(logger.warn).mockClear()
})

describe("useNoteContent.query fetchData (notes-list resolution)", () => {
	it("resolves the note from notesQueryGet and fetches its content", async () => {
		const note = { uuid: "note-2" }

		mockNotesQueryGet.mockReturnValue([{ uuid: "other" }, note])
		mockSdkClient.getNoteContent.mockResolvedValueOnce({ content: "from-list-query" })

		const result = await fetchNoteContent({ uuid: "note-2" })

		expect(mockNotesQueryGet).toHaveBeenCalled()
		expect(mockSdkClient.getNoteContent).toHaveBeenCalledWith(note, undefined)
		expect(result).toEqual({ content: "from-list-query" })
	})

	it("returns undefined and warns when notesQueryGet has no entry for the uuid", async () => {
		mockNotesQueryGet.mockReturnValue([{ uuid: "someone-else" }])

		const result = await fetchNoteContent({ uuid: "missing" })

		expect(result).toBeUndefined()
		expect(mockSdkClient.getNoteContent).not.toHaveBeenCalled()
		expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1)
	})

	it("returns undefined and warns when the list query was never restored", async () => {
		mockNotesQueryGet.mockReturnValue(undefined)

		const result = await fetchNoteContent({ uuid: "missing" })

		expect(result).toBeUndefined()
		expect(mockSdkClient.getNoteContent).not.toHaveBeenCalled()
		expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1)
	})
})

describe("useNoteHistory.query fetchData (notes-list resolution)", () => {
	it("resolves the note from notesQueryGet and fetches its history", async () => {
		const note = { uuid: "note-2" }
		const history = [{ id: 3n }]

		mockNotesQueryGet.mockReturnValue([{ uuid: "other" }, note])
		mockSdkClient.getNoteHistory.mockResolvedValueOnce(history)

		const result = await fetchNoteHistory({ uuid: "note-2" })

		expect(mockNotesQueryGet).toHaveBeenCalled()
		expect(mockSdkClient.getNoteHistory).toHaveBeenCalledWith(note, undefined)
		expect(result).toBe(history)
	})

	it("returns [] and warns when notesQueryGet has no entry for the uuid", async () => {
		mockNotesQueryGet.mockReturnValue([{ uuid: "someone-else" }])

		const result = await fetchNoteHistory({ uuid: "missing" })

		expect(result).toEqual([])
		expect(mockSdkClient.getNoteHistory).not.toHaveBeenCalled()
		expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1)
	})

	it("returns [] and warns when the list query was never restored", async () => {
		mockNotesQueryGet.mockReturnValue(undefined)

		const result = await fetchNoteHistory({ uuid: "missing" })

		expect(result).toEqual([])
		expect(mockSdkClient.getNoteHistory).not.toHaveBeenCalled()
		expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1)
	})
})
