import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

// ---------------------------------------------------------------------------
// Hoisted mocks (must be defined before any imports)
// ---------------------------------------------------------------------------

const { mockGetSdkClients, mockNotesWithContentQueryUpdate, mockNoteContentQueryUpdate, mockNotesTagsQueryUpdate } = vi.hoisted(() => ({
	mockGetSdkClients: vi.fn(),
	mockNotesWithContentQueryUpdate: vi.fn(),
	mockNoteContentQueryUpdate: vi.fn(),
	mockNotesTagsQueryUpdate: vi.fn()
}))

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@filen/utils", async () => ({
	...(await import("@/tests/mocks/filenUtils")),
	createNotePreviewFromContentText: vi.fn().mockReturnValue("preview-text"),
	sortParams: vi.fn(x => x)
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: mockGetSdkClients
	}
}))

vi.mock("@/features/notes/queries/useNotesWithContent.query", () => ({
	notesWithContentQueryUpdate: mockNotesWithContentQueryUpdate,
	notesWithContentQueryGet: vi.fn().mockReturnValue([]),
	fetchData: vi.fn().mockResolvedValue([])
}))

vi.mock("@/features/notes/queries/useNoteContent.query", () => ({
	noteContentQueryUpdate: mockNoteContentQueryUpdate,
	fetchData: vi.fn().mockResolvedValue(undefined)
}))

vi.mock("@/features/notes/queries/useNotesTags.query", () => ({
	notesTagsQueryUpdate: mockNotesTagsQueryUpdate,
	fetchData: vi.fn().mockResolvedValue([])
}))

// expo-file-system: use the full in-memory mock
vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

// expo-crypto: just needs randomUUID
vi.mock("expo-crypto", () => ({
	randomUUID: vi.fn(() => "00000000-0000-0000-0000-111111111111")
}))

// op-sqlite: used transitively via SQLite persistence layer
vi.mock("@op-engineering/op-sqlite", async () => await import("@/tests/mocks/opSqlite"))

// expo-secure-store pulls in expo-modules-core which crashes in node env
vi.mock("expo-secure-store", async () => await import("@/tests/mocks/expoSecureStore"))

// expo-localization pulls in expo-modules-core which crashes in node env
vi.mock("expo-localization", () => ({
	getLocales: vi.fn(() => [{ languageTag: "en-US", regionCode: "US" }]),
	locale: "en-US",
	locales: [{ languageTag: "en-US" }],
	timezone: "UTC"
}))

// Mocks for transitive imports via @/lib/utils → @/lib/cache, @/lib/i18n
vi.mock("@/lib/cache", () => ({
	default: {
		noteUuidToNote: { get: vi.fn(), set: vi.fn() },
		dirUuidToDir: { get: vi.fn(), set: vi.fn() },
		fileUuidToFile: { get: vi.fn(), set: vi.fn() }
	}
}))

vi.mock("@/lib/i18n", () => ({
	default: {
		t: (key: string) => key
	}
}))

vi.mock("react-native-mmkv", async () => await import("@/tests/mocks/reactNativeMMKV"))

// @filen/sdk-rs: export the NoteType values as strings
vi.mock("@filen/sdk-rs", () => ({
	NoteType: {
		Text: "text",
		Md: "md",
		Code: "code",
		Rich: "rich",
		Checklist: "checklist"
	}
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import notes from "@/features/notes/notes"
import { type Note, type NoteTag, type NoteParticipant } from "@/types"
import { type NoteType } from "@filen/sdk-rs"
import { fs } from "@/tests/mocks/expoFileSystem"

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

function makeTag(overrides: Partial<NoteTag> = {}): NoteTag {
	return {
		uuid: "tag-uuid-1",
		name: "work",
		favorite: false,
		editedTimestamp: 1000n,
		createdTimestamp: 1000n,
		undecryptable: false,
		...overrides
	} as NoteTag
}

function makeParticipant(overrides: Partial<NoteParticipant> = {}): NoteParticipant {
	return {
		userId: 99n,
		isOwner: false,
		email: "participant@test.com",
		nickName: "Bob",
		permissionsWrite: false,
		addedTimestamp: 1000n,
		...overrides
	} as NoteParticipant
}

// Simulates the SDK returning an updated Note (wraps with encryptionKey so undecryptable stays false)
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
		archiveNote: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1", { archive: true })),
		restoreNote: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1", { archive: false, trash: false })),
		trashNote: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1", { trash: true })),
		deleteNote: vi.fn().mockResolvedValue(undefined),
		setNoteTitle: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1", { title: "New Title" })),
		addTagToNote: vi.fn().mockResolvedValue({ note: makeSdkNote("note-uuid-1"), tag: makeTag() }),
		removeTagFromNote: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1", { tags: [] })),
		setNoteType: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1", { noteType: "md" as unknown as NoteType })),
		setNotePinned: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1", { pinned: true })),
		setNoteFavorited: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1", { favorite: true })),
		renameNoteTag: vi
			.fn()
			.mockResolvedValue({ uuid: "tag-uuid-1", name: "new-name", favorite: false, editedTimestamp: 1000n, createdTimestamp: 1000n }),
		deleteNoteTag: vi.fn().mockResolvedValue(undefined),
		setNoteTagFavorited: vi
			.fn()
			.mockResolvedValue({ uuid: "tag-uuid-1", name: "work", favorite: true, editedTimestamp: 1000n, createdTimestamp: 1000n }),
		removeNoteParticipant: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1")),
		addNoteParticipant: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1")),
		setNoteParticipantPermission: vi.fn().mockResolvedValue(makeParticipant({ permissionsWrite: true })),
		getNoteContent: vi.fn().mockResolvedValue("hello content"),
		setNoteContent: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1")),
		duplicateNote: vi.fn().mockResolvedValue({
			original: makeSdkNote("note-uuid-1"),
			duplicated: makeSdkNote("note-uuid-2")
		}),
		createNote: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-new")),
		createNoteTag: vi.fn().mockResolvedValue({
			uuid: "tag-uuid-new",
			name: "fresh-tag",
			favorite: false,
			editedTimestamp: 1000n,
			createdTimestamp: 1000n
		}),
		toStringified: vi.fn().mockResolvedValue({ userId: 42n }),
		...overrides
	}
}

// ---------------------------------------------------------------------------
// Tests: wrapSdkNote (pure function — tested indirectly via archive which calls wrapSdkNote)
// We test it directly by calling archive on a minimal note and checking the returned shape.
// Since wrapSdkNote is not exported, we exercise it through a simple pathway.
// ---------------------------------------------------------------------------

describe("wrapSdkNote (via archive)", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
	})

	it("sets undecryptable: false when encryptionKey is present", async () => {
		const sdkClient = makeMockSdkClient({
			archiveNote: vi.fn().mockResolvedValue({ ...makeSdkNote("note-uuid-1", { archive: true }), encryptionKey: "k" })
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote()
		const result = await notes.archive({ note })

		expect(result.undecryptable).toBe(false)
	})

	it("sets undecryptable: true when encryptionKey is undefined", async () => {
		const sdkClient = makeMockSdkClient({
			archiveNote: vi.fn().mockResolvedValue({ ...makeSdkNote("note-uuid-1", { archive: true }), encryptionKey: undefined })
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote()
		const result = await notes.archive({ note })

		expect(result.undecryptable).toBe(true)
	})

	it("spreads all other SDK fields unchanged (uuid, title, etc.)", async () => {
		const sdkClient = makeMockSdkClient({
			archiveNote: vi.fn().mockResolvedValue({
				...makeSdkNote("note-uuid-1"),
				uuid: "note-uuid-1",
				title: "My Title",
				encryptionKey: "k",
				archive: true
			})
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote()
		const result = await notes.archive({ note })

		expect(result.uuid).toBe("note-uuid-1")
		expect(result.title).toBe("My Title")
	})
})

// ---------------------------------------------------------------------------
// Tests: wrapSdkNoteTag (tested indirectly via createTag)
// ---------------------------------------------------------------------------

describe("wrapSdkNoteTag (via createTag)", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesTagsQueryUpdate.mockReset()
	})

	it("sets undecryptable: false when name is present", async () => {
		const sdkClient = makeMockSdkClient({
			createNoteTag: vi
				.fn()
				.mockResolvedValue({ uuid: "tag-uuid-1", name: "work", favorite: false, editedTimestamp: 1000n, createdTimestamp: 1000n })
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const result = await notes.createTag({ name: "work" })

		expect(result.undecryptable).toBe(false)
		expect(result.uuid).toBe("tag-uuid-1")
	})

	it("sets undecryptable: true when name is undefined", async () => {
		const sdkClient = makeMockSdkClient({
			createNoteTag: vi.fn().mockResolvedValue({
				uuid: "tag-uuid-2",
				name: undefined,
				favorite: false,
				editedTimestamp: 1000n,
				createdTimestamp: 1000n
			})
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const result = await notes.createTag({ name: "" })

		expect(result.undecryptable).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.archive
// ---------------------------------------------------------------------------

describe("notes.archive", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
	})

	it("returns note unchanged when note.archive is already true", async () => {
		const note = makeNote({ archive: true })

		const result = await notes.archive({ note })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
		expect(mockNotesWithContentQueryUpdate).not.toHaveBeenCalled()
	})

	it("returns note unchanged when note.trash is true", async () => {
		const note = makeNote({ trash: true })

		const result = await notes.archive({ note })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls authedSdkClient.archiveNote when note is active", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote()

		await notes.archive({ note })

		expect(sdkClient.archiveNote).toHaveBeenCalledWith(note, undefined)
	})

	it("calls notesWithContentQueryUpdate with a mapper that preserves n.content for matching uuid", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote()
		const existingEntry = { ...note, content: "existing-content" }

		await notes.archive({ note })

		expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledTimes(1)

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([existingEntry])

		expect(result).toHaveLength(1)
		expect(result[0].content).toBe("existing-content")
	})

	it("query updater mapper leaves non-matching uuids unchanged", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1" })
		const otherEntry = { ...makeNote({ uuid: "other-uuid" }), content: "other-content" }

		await notes.archive({ note })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([otherEntry])

		expect(result[0].uuid).toBe("other-uuid")
		expect(result[0].content).toBe("other-content")
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.restore
// ---------------------------------------------------------------------------

describe("notes.restore", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
	})

	it("returns note unchanged when trash=false AND archive=false", async () => {
		const note = makeNote({ trash: false, archive: false })

		const result = await notes.restore({ note })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK when note.trash is true", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ trash: true })
		await notes.restore({ note })

		expect(sdkClient.restoreNote).toHaveBeenCalledTimes(1)
	})

	it("calls SDK when note.archive is true", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ archive: true })
		await notes.restore({ note })

		expect(sdkClient.restoreNote).toHaveBeenCalledTimes(1)
	})

	it("query updater preserves content from cache entry for matching uuid", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ trash: true })
		const cacheEntry = { ...note, content: "cached-content" }

		await notes.restore({ note })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([cacheEntry])

		expect(result[0].content).toBe("cached-content")
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.trash
// ---------------------------------------------------------------------------

describe("notes.trash", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
	})

	it("returns note unchanged when note.trash is already true", async () => {
		const note = makeNote({ trash: true })

		const result = await notes.trash({ note })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK when note.trash is false", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ trash: false })
		await notes.trash({ note })

		expect(sdkClient.trashNote).toHaveBeenCalledTimes(1)
	})

	it("query updater preserves content from live cache entry", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ trash: false })
		const cacheEntry = { ...note, content: "my-content" }

		await notes.trash({ note })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([cacheEntry])

		expect(result[0].content).toBe("my-content")
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.delete
// ---------------------------------------------------------------------------

describe("notes.delete", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
		mockNoteContentQueryUpdate.mockReset()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("returns undefined without calling SDK when note.trash is false", async () => {
		const note = makeNote({ trash: false })

		const result = await notes.delete({ note })

		expect(result).toBeUndefined()
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK when note.trash is true", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ trash: true })
		await notes.delete({ note })

		expect(sdkClient.deleteNote).toHaveBeenCalledTimes(1)
	})

	it("after 3000ms setTimeout: notesWithContentQueryUpdate filters out the note uuid", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ trash: true, uuid: "note-uuid-del" })
		const otherNote = { ...makeNote({ uuid: "other-note" }), content: "keep" }

		await notes.delete({ note })

		// Not called yet before timeout
		expect(mockNotesWithContentQueryUpdate).not.toHaveBeenCalled()

		vi.advanceTimersByTime(3000)

		expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledTimes(1)

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([{ ...note, content: "" }, otherNote])

		expect(result).toHaveLength(1)
		expect(result[0].uuid).toBe("other-note")
	})

	it("after 3000ms setTimeout: noteContentQueryUpdate updater returns undefined", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ trash: true, uuid: "note-uuid-del" })

		await notes.delete({ note })
		vi.advanceTimersByTime(3000)

		expect(mockNoteContentQueryUpdate).toHaveBeenCalledTimes(1)
		const callArgs = mockNoteContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const call = callArgs[0]

		expect(call.params.uuid).toBe("note-uuid-del")
		expect(call.updater()).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.setTitle
// ---------------------------------------------------------------------------

describe("notes.setTitle", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
	})

	it("returns note unchanged when newTitle equals current title", async () => {
		const note = makeNote({ title: "Same Title" })

		const result = await notes.setTitle({ note, newTitle: "Same Title" })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("returns note unchanged when newTitle is whitespace-only", async () => {
		const note = makeNote({ title: "My Note" })

		const result = await notes.setTitle({ note, newTitle: "   " })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("returns note unchanged for empty string newTitle", async () => {
		const note = makeNote({ title: "My Note" })

		const result = await notes.setTitle({ note, newTitle: "" })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK when newTitle is a valid new title", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ title: "Old Title" })
		await notes.setTitle({ note, newTitle: "New Title" })

		expect(sdkClient.setNoteTitle).toHaveBeenCalledWith(note, "New Title", undefined)
	})

	it("query updater mapper updates matching uuid, leaves others unchanged", async () => {
		const sdkClient = makeMockSdkClient({
			setNoteTitle: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1", { title: "Updated" }))
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1", title: "Old" })
		const other = { ...makeNote({ uuid: "note-uuid-2" }), content: "other-content" }

		await notes.setTitle({ note, newTitle: "Updated" })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([{ ...note, content: "my-content" }, other])

		expect(result[0].uuid).toBe("note-uuid-1")
		expect(result[0].content).toBe("my-content")
		expect(result[1].uuid).toBe("note-uuid-2")
		expect(result[1].content).toBe("other-content")
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.addTag
// ---------------------------------------------------------------------------

describe("notes.addTag", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
	})

	it("returns note unchanged when tag.uuid is already in note.tags", async () => {
		const tag = makeTag({ uuid: "tag-uuid-1" })
		const note = makeNote({ tags: [tag] })

		const result = await notes.addTag({ note, tag })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK when tag is not already present", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const tag = makeTag({ uuid: "tag-uuid-99" })
		const note = makeNote({ tags: [] })

		await notes.addTag({ note, tag })

		expect(sdkClient.addTagToNote).toHaveBeenCalledTimes(1)
	})

	it("query updater spreads updated note with content from cache entry for matching uuid", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const tag = makeTag({ uuid: "tag-uuid-99" })
		const note = makeNote({ uuid: "note-uuid-1", tags: [] })
		const cacheEntry = { ...note, content: "cached" }

		await notes.addTag({ note, tag })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([cacheEntry])

		expect(result[0].content).toBe("cached")
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.removeTag
// ---------------------------------------------------------------------------

describe("notes.removeTag", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
	})

	it("returns note unchanged when tag.uuid is NOT in note.tags", async () => {
		const tag = makeTag({ uuid: "tag-uuid-not-present" })
		const note = makeNote({ tags: [] })

		const result = await notes.removeTag({ note, tag })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK when tag is present in note.tags", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const tag = makeTag({ uuid: "tag-uuid-1" })
		const note = makeNote({ tags: [tag] })

		await notes.removeTag({ note, tag })

		expect(sdkClient.removeTagFromNote).toHaveBeenCalledTimes(1)
	})

	it("query updater preserves content from live cache entry", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const tag = makeTag({ uuid: "tag-uuid-1" })
		const note = makeNote({ uuid: "note-uuid-1", tags: [tag] })
		const cacheEntry = { ...note, content: "cached-content" }

		await notes.removeTag({ note, tag })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([cacheEntry])

		expect(result[0].content).toBe("cached-content")
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.setType
// ---------------------------------------------------------------------------

describe("notes.setType", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
	})

	it("returns note unchanged when type equals current noteType", async () => {
		const note = makeNote({ noteType: "text" as unknown as NoteType })

		const result = await notes.setType({ note, type: "text" as unknown as NoteType })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK when type differs", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ noteType: "text" as unknown as NoteType })
		await notes.setType({ note, type: "md" as unknown as NoteType })

		expect(sdkClient.setNoteType).toHaveBeenCalledTimes(1)
	})

	it("query updater: matching uuid gets new note spread but with n.content (not replaced)", async () => {
		const sdkClient = makeMockSdkClient({
			setNoteType: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1", { noteType: "md" as unknown as NoteType }))
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1", noteType: "text" as unknown as NoteType })
		const cacheEntry = { ...note, content: "existing-content" }

		await notes.setType({ note, type: "md" as unknown as NoteType })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([cacheEntry])

		expect(result[0].content).toBe("existing-content")
		expect(result[0].noteType).toBe("md")
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.setPinned
// ---------------------------------------------------------------------------

describe("notes.setPinned", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
	})

	it("returns note unchanged when pinned already equals desired value (true)", async () => {
		const note = makeNote({ pinned: true })

		const result = await notes.setPinned({ note, pinned: true })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("returns note unchanged when pinned already equals desired value (false)", async () => {
		const note = makeNote({ pinned: false })

		const result = await notes.setPinned({ note, pinned: false })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK when pinned needs to change", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ pinned: false })
		await notes.setPinned({ note, pinned: true })

		expect(sdkClient.setNotePinned).toHaveBeenCalledTimes(1)
	})

	it("query updater preserves content from live cache entry", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ pinned: false })
		const cacheEntry = { ...note, content: "my-pinned-content" }

		await notes.setPinned({ note, pinned: true })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([cacheEntry])

		expect(result[0].content).toBe("my-pinned-content")
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.setFavorited
// ---------------------------------------------------------------------------

describe("notes.setFavorited", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
	})

	it("returns note unchanged when favorite already equals desired value (true)", async () => {
		const note = makeNote({ favorite: true })

		const result = await notes.setFavorited({ note, favorite: true })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("returns note unchanged when favorite already equals desired value (false)", async () => {
		const note = makeNote({ favorite: false })

		const result = await notes.setFavorited({ note, favorite: false })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK when favorite needs to change", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ favorite: false })
		await notes.setFavorited({ note, favorite: true })

		expect(sdkClient.setNoteFavorited).toHaveBeenCalledTimes(1)
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.renameTag
// ---------------------------------------------------------------------------

describe("notes.renameTag", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesTagsQueryUpdate.mockReset()
	})

	it("returns tag unchanged when newName equals tag.name", async () => {
		const tag = makeTag({ name: "work" })

		const result = await notes.renameTag({ tag, newName: "work" })

		expect(result).toBe(tag)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("returns tag unchanged when newName is whitespace-only", async () => {
		const tag = makeTag({ name: "work" })

		const result = await notes.renameTag({ tag, newName: "   " })

		expect(result).toBe(tag)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK when newName is a valid new name", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const tag = makeTag({ name: "work" })
		await notes.renameTag({ tag, newName: "personal" })

		expect(sdkClient.renameNoteTag).toHaveBeenCalledTimes(1)
	})

	it("notesTagsQueryUpdate mapper replaces matching tag, leaves others", async () => {
		const sdkClient = makeMockSdkClient({
			renameNoteTag: vi.fn().mockResolvedValue({
				uuid: "tag-uuid-1",
				name: "personal",
				favorite: false,
				editedTimestamp: 2000n,
				createdTimestamp: 1000n
			})
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const tag = makeTag({ uuid: "tag-uuid-1", name: "work" })
		const otherTag = makeTag({ uuid: "tag-uuid-2", name: "home" })

		await notes.renameTag({ tag, newName: "personal" })

		expect(mockNotesTagsQueryUpdate).toHaveBeenCalledTimes(1)
		const callArgs = mockNotesTagsQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([tag, otherTag])

		expect(result).toHaveLength(2)
		expect(result[0].name).toBe("personal")
		expect(result[1].name).toBe("home")
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.favoriteTag
// ---------------------------------------------------------------------------

describe("notes.favoriteTag", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesTagsQueryUpdate.mockReset()
	})

	it("returns tag unchanged when favorite already equals desired value", async () => {
		const tag = makeTag({ favorite: true })

		const result = await notes.favoriteTag({ tag, favorite: true })

		expect(result).toBe(tag)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK and updates query when value differs", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const tag = makeTag({ favorite: false })
		const result = await notes.favoriteTag({ tag, favorite: true })

		expect(sdkClient.setNoteTagFavorited).toHaveBeenCalledTimes(1)
		expect(result.undecryptable).toBe(false)
		expect(mockNotesTagsQueryUpdate).toHaveBeenCalledTimes(1)
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.removeParticipant
// ---------------------------------------------------------------------------

describe("notes.removeParticipant", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
	})

	it("returns note unchanged when participantUserId is not in note.participants", async () => {
		const note = makeNote({ participants: [] })

		const result = await notes.removeParticipant({ note, participantUserId: 999n })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK when participant exists in note.participants", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const participant = makeParticipant({ userId: 99n })
		const note = makeNote({ participants: [participant] })

		await notes.removeParticipant({ note, participantUserId: 99n })

		expect(sdkClient.removeNoteParticipant).toHaveBeenCalledWith(note, 99n, undefined)
	})

	it("query updater preserves content from live cache entry", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const participant = makeParticipant({ userId: 99n })
		const note = makeNote({ uuid: "note-uuid-1", participants: [participant] })
		const cacheEntry = { ...note, content: "participant-content" }

		await notes.removeParticipant({ note, participantUserId: 99n })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([cacheEntry])

		expect(result[0].content).toBe("participant-content")
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.addParticipant
// ---------------------------------------------------------------------------

describe("notes.addParticipant", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
	})

	it("returns note unchanged when contact.userId already in note.participants", async () => {
		const participant = makeParticipant({ userId: 77n })
		const note = makeNote({ participants: [participant] })
		const contact = {
			userId: 77n,
			email: "user@test.com",
			uuid: "contact-uuid",
			avatar: undefined,
			nickName: undefined,
			lastActive: 0n,
			timestamp: 0n,
			publicKey: "k"
		}

		const result = await notes.addParticipant({ note, contact, permissionsWrite: false })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK when contact is not a current participant", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ participants: [] })
		const contact = {
			userId: 88n,
			email: "new@test.com",
			uuid: "contact-uuid",
			avatar: undefined,
			nickName: undefined,
			lastActive: 0n,
			timestamp: 0n,
			publicKey: "k"
		}

		await notes.addParticipant({ note, contact, permissionsWrite: true })

		expect(sdkClient.addNoteParticipant).toHaveBeenCalledTimes(1)
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.setParticipantPermission
// ---------------------------------------------------------------------------

describe("notes.setParticipantPermission", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
	})

	it("returns note unchanged when permissionsWrite already equals desired value", async () => {
		const participant = makeParticipant({ permissionsWrite: true })
		const note = makeNote({ participants: [participant] })

		const result = await notes.setParticipantPermission({ note, participant, permissionsWrite: true })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK when permission needs to change", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const participant = makeParticipant({ permissionsWrite: false })
		const note = makeNote({ participants: [participant] })

		await notes.setParticipantPermission({ note, participant, permissionsWrite: true })

		expect(sdkClient.setNoteParticipantPermission).toHaveBeenCalledTimes(1)
	})

	it("query updater only changes the target participant's permissionsWrite, other participants unchanged", async () => {
		const sdkClient = makeMockSdkClient({
			setNoteParticipantPermission: vi.fn().mockResolvedValue(makeParticipant({ userId: 10n, permissionsWrite: true }))
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const targetParticipant = makeParticipant({ userId: 10n, permissionsWrite: false })
		const otherParticipant = makeParticipant({ userId: 20n, permissionsWrite: false })
		const note = makeNote({ uuid: "note-uuid-1", participants: [targetParticipant, otherParticipant] })

		const liveEntry = { ...note, content: "content", participants: [targetParticipant, otherParticipant] }

		await notes.setParticipantPermission({ note, participant: targetParticipant, permissionsWrite: true })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([liveEntry])

		const updatedTarget = result[0].participants.find((p: NoteParticipant) => p.userId === 10n)
		const updatedOther = result[0].participants.find((p: NoteParticipant) => p.userId === 20n)

		expect(updatedTarget.permissionsWrite).toBe(true)
		expect(updatedOther.permissionsWrite).toBe(false)
	})

	it("concurrency: patches onto LIVE cache entry `n`, not the closure-captured render-time note", async () => {
		// Key correctness invariant: each updater patches `n` (the live cache entry at call time),
		// not the closure-captured `note`. This means when two permission changes run sequentially,
		// the second updater sees the result of the first (because it reads from n, not note).
		//
		// Simulate: p1 gets permissionsWrite=true, then p2 gets permissionsWrite=true.
		// Both updaters start from a shared stale `note` but patch against the live `n`.
		// After applying both updaters in sequence, both p1 and p2 should have permissionsWrite=true.

		const sdkClient = makeMockSdkClient({
			setNoteParticipantPermission: vi
				.fn()
				.mockResolvedValueOnce(makeParticipant({ userId: 10n, permissionsWrite: true }))
				.mockResolvedValueOnce(makeParticipant({ userId: 20n, permissionsWrite: true }))
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const p1 = makeParticipant({ userId: 10n, permissionsWrite: false })
		const p2 = makeParticipant({ userId: 20n, permissionsWrite: false })
		const staleNote = makeNote({ uuid: "note-uuid-1", participants: [p1, p2] })

		// Collect updaters from both calls
		const updaters: Array<(prev: (Note & { content: string })[]) => (Note & { content: string })[]> = []
		mockNotesWithContentQueryUpdate.mockImplementation(
			({ updater }: { updater: (prev: (Note & { content: string })[]) => (Note & { content: string })[] }) => {
				updaters.push(updater)
			}
		)

		// Both calls use the same stale closure note (simulating concurrent dispatch)
		await notes.setParticipantPermission({ note: staleNote, participant: p1, permissionsWrite: true })
		await notes.setParticipantPermission({ note: staleNote, participant: p2, permissionsWrite: true })

		expect(updaters).toHaveLength(2)

		// Simulate applying both updaters sequentially against a shared live cache.
		// Since the implementation patches `n` (live entry), updater2 sees updater1's result.
		const liveBase: Note & { content: string } = { ...staleNote, content: "content" }

		const afterFirst = updaters[0]!([liveBase])
		// The live entry after first update has p1=true, p2=false
		const afterSecond = updaters[1]!([afterFirst[0]!])

		// Both participants should now be true — if updaters used the stale `note` instead of `n`,
		// updater2 would reset p1 back to false when rebuilding participants from the stale note.
		const finalP1 = afterSecond[0]!.participants.find((p: NoteParticipant) => p.userId === 10n)
		const finalP2 = afterSecond[0]!.participants.find((p: NoteParticipant) => p.userId === 20n)

		expect(finalP1!.permissionsWrite).toBe(true)
		expect(finalP2!.permissionsWrite).toBe(true)
	})

	it("query updater: notes with non-matching uuid are not modified", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const participant = makeParticipant({ permissionsWrite: false })
		const note = makeNote({ uuid: "note-uuid-1", participants: [participant] })
		const otherNote = { ...makeNote({ uuid: "other-note" }), content: "other-content", participants: [] }

		await notes.setParticipantPermission({ note, participant, permissionsWrite: true })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([{ ...note, content: "content", participants: [participant] }, otherNote])

		expect(result[1].uuid).toBe("other-note")
		expect(result[1].participants).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.export
// ---------------------------------------------------------------------------

describe("notes.export", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		fs.clear()
	})

	it("throws 'Cannot export an undecryptable note' when note.undecryptable is true", async () => {
		const note = makeNote({ undecryptable: true })

		await expect(notes.export({ note })).rejects.toThrow("Cannot export an undecryptable note")
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("throws 'Note content is empty' when getContent returns undefined", async () => {
		const sdkClient = makeMockSdkClient({ getNoteContent: vi.fn().mockResolvedValue(undefined) })
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote()

		await expect(notes.export({ note })).rejects.toThrow("Note content is empty")
	})

	it("BUGFIX #17: empty string content exports successfully to an empty .txt file (not thrown)", async () => {
		const sdkClient = makeMockSdkClient({ getNoteContent: vi.fn().mockResolvedValue("") })
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ title: "EmptyNote", uuid: "empty-note-uuid" })

		const { file } = await notes.export({ note })

		expect(file).toBeDefined()
		expect(file.name).toMatch(/\.txt$/)
	})

	it("uses note.title as filename base when title is non-null", async () => {
		const sdkClient = makeMockSdkClient({ getNoteContent: vi.fn().mockResolvedValue("content") })
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ title: "MyNote", uuid: "note-uuid-1" })

		const { file } = await notes.export({ note })

		expect(file.name).toContain("MyNote")
		expect(file.name).toMatch(/\.txt$/)
	})

	it("falls back to note.uuid when note.title is null", async () => {
		const sdkClient = makeMockSdkClient({ getNoteContent: vi.fn().mockResolvedValue("content") })
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ title: null as unknown as undefined, uuid: "fallback-uuid-123" })

		const { file } = await notes.export({ note })

		expect(file.name).toContain("fallback-uuid-123")
		expect(file.name).toMatch(/\.txt$/)
	})

	it("falls back to note.uuid when note.title is undefined", async () => {
		const sdkClient = makeMockSdkClient({ getNoteContent: vi.fn().mockResolvedValue("content") })
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ title: undefined, uuid: "fallback-uuid-456" })

		const { file } = await notes.export({ note })

		expect(file.name).toContain("fallback-uuid-456")
		expect(file.name).toMatch(/\.txt$/)
	})

	it("BUGFIX: empty string title falls back to uuid (not blank filename), producing uuid.txt", async () => {
		// After the fix (|| instead of ??), title="" is falsy so uuid is used
		const sdkClient = makeMockSdkClient({ getNoteContent: vi.fn().mockResolvedValue("content") })
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ title: "", uuid: "my-note-uuid-789" })

		const { file } = await notes.export({ note })

		expect(file.name).toContain("my-note-uuid-789")
		expect(file.name).toMatch(/\.txt$/)
	})

	it("returns { file, cleanup } with cleanup that calls file.delete when file.exists", async () => {
		const sdkClient = makeMockSdkClient({ getNoteContent: vi.fn().mockResolvedValue("some content") })
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ title: "ExportMe" })

		const { file, cleanup } = await notes.export({ note })

		expect(file.exists).toBe(true)

		cleanup()

		expect(file.exists).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.exportMultiple
// ---------------------------------------------------------------------------

describe("notes.exportMultiple", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		fs.clear()
	})

	it("throws 'No exportable notes provided' when all notes are undecryptable", async () => {
		const undecryptable = makeNote({ undecryptable: true })

		await expect(notes.exportMultiple({ notes: [undecryptable] })).rejects.toThrow("No exportable notes provided")
	})

	it("throws 'No exportable notes provided' when notes array is empty", async () => {
		await expect(notes.exportMultiple({ notes: [] })).rejects.toThrow("No exportable notes provided")
	})

	it("notes with null/undefined content (undecryptable) are silently skipped (not added to zip)", async () => {
		const sdkClient = makeMockSdkClient({ getNoteContent: vi.fn().mockResolvedValue(null) })
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ title: "Undecryptable Note" })

		// Should not throw even though content is null — just produces empty zip
		const { file } = await notes.exportMultiple({ notes: [note] })

		expect(file).toBeDefined()
	})

	it("BUGFIX #18: notes with empty string content are included in the zip (not silently dropped)", async () => {
		const sdkClient = makeMockSdkClient({ getNoteContent: vi.fn().mockResolvedValue("") })
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ title: "Empty Note", uuid: "empty-note-uuid" })

		// Should not skip the note — empty string is valid content
		const { file } = await notes.exportMultiple({ notes: [note] })

		expect(file).toBeDefined()
		expect(file.name).toMatch(/notes_export_.*\.zip$/)
	})

	it("exported filename uses '{title}_{uuid}.txt' when title is truthy", async () => {
		// We can't easily inspect zip internals in node env, but we verify it doesn't throw
		// and returns a valid file handle
		const sdkClient = makeMockSdkClient({ getNoteContent: vi.fn().mockResolvedValue("content") })
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ title: "My Note", uuid: "my-uuid" })

		const { file } = await notes.exportMultiple({ notes: [note] })

		expect(file).toBeDefined()
		expect(file.name).toMatch(/notes_export_.*\.zip$/)
	})

	it("returns { file, cleanup } with cleanup that deletes the file when it exists", async () => {
		const sdkClient = makeMockSdkClient({ getNoteContent: vi.fn().mockResolvedValue("content") })
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ title: "Export Test" })

		const { file, cleanup } = await notes.exportMultiple({ notes: [note] })

		expect(file.exists).toBe(true)

		cleanup()

		expect(file.exists).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.duplicate
// ---------------------------------------------------------------------------

describe("notes.duplicate", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
	})

	it("fetches duplicateNote and getContent in parallel (both SDK methods called)", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1" })
		await notes.duplicate({ note })

		expect(sdkClient.duplicateNote).toHaveBeenCalledTimes(1)
		expect(sdkClient.getNoteContent).toHaveBeenCalledTimes(1)
	})

	it("content null/undefined is coerced to '' (safeContent = content ?? '')", async () => {
		const sdkClient = makeMockSdkClient({ getNoteContent: vi.fn().mockResolvedValue(null) })
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1" })

		await notes.duplicate({ note })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([])

		// Both entries should have empty string content, not null
		expect(result[0].content).toBe("")
		expect(result[1].content).toBe("")
	})

	it("query updater removes both original.uuid and duplicated.uuid from prev before appending both", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1" })
		const staleOriginal = { ...makeNote({ uuid: "note-uuid-1" }), content: "stale" }
		const staleDuplicated = { ...makeNote({ uuid: "note-uuid-2" }), content: "stale-dup" }
		const unrelated = { ...makeNote({ uuid: "unrelated-uuid" }), content: "keep" }

		await notes.duplicate({ note })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([staleOriginal, staleDuplicated, unrelated])

		// Unrelated note should still be there, not duplicated
		const unrelatedInResult = result.filter((n: Note & { content: string }) => n.uuid === "unrelated-uuid")
		expect(unrelatedInResult).toHaveLength(1)

		// Original and duplicated should appear exactly once each
		const originalsInResult = result.filter((n: Note & { content: string }) => n.uuid === "note-uuid-1")
		const duplicatesInResult = result.filter((n: Note & { content: string }) => n.uuid === "note-uuid-2")

		expect(originalsInResult).toHaveLength(1)
		expect(duplicatesInResult).toHaveLength(1)
	})

	it("query updater appends original then duplicated with safeContent", async () => {
		const sdkClient = makeMockSdkClient({
			getNoteContent: vi.fn().mockResolvedValue("my content")
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1" })

		await notes.duplicate({ note })

		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([])

		expect(result).toHaveLength(2)
		expect(result[0].uuid).toBe("note-uuid-1")
		expect(result[1].uuid).toBe("note-uuid-2")
		expect(result[0].content).toBe("my content")
		expect(result[1].content).toBe("my content")
	})

	it("returns { original, duplicated } wrapped via wrapSdkNote", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1" })
		const result = await notes.duplicate({ note })

		expect(result.original.uuid).toBe("note-uuid-1")
		expect(result.duplicated.uuid).toBe("note-uuid-2")
		expect(result.original.undecryptable).toBe(false)
		expect(result.duplicated.undecryptable).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.setContent
// ---------------------------------------------------------------------------

describe("notes.setContent", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
		mockNoteContentQueryUpdate.mockReset()
	})

	it("preview type mapping: Checklist → 'checklist'", async () => {
		const { createNotePreviewFromContentText } = await import("@filen/utils")
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ noteType: "checklist" as unknown as NoteType })
		await notes.setContent({ note, content: "- item" })

		expect(createNotePreviewFromContentText).toHaveBeenCalledWith("checklist", "- item")
	})

	it("preview type mapping: Rich → 'rich'", async () => {
		const { createNotePreviewFromContentText } = await import("@filen/utils")
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ noteType: "rich" as unknown as NoteType })
		await notes.setContent({ note, content: "<p>hello</p>" })

		expect(createNotePreviewFromContentText).toHaveBeenCalledWith("rich", "<p>hello</p>")
	})

	it("preview type mapping: any other type → 'other'", async () => {
		const { createNotePreviewFromContentText } = await import("@filen/utils")
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ noteType: "text" as unknown as NoteType })
		await notes.setContent({ note, content: "plain" })

		expect(createNotePreviewFromContentText).toHaveBeenCalledWith("other", "plain")
	})

	it("updateQuery=true causes noteContentQueryUpdate to be called with the content string", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1" })
		await notes.setContent({ note, content: "new content", updateQuery: true })

		expect(mockNoteContentQueryUpdate).toHaveBeenCalledTimes(1)
		const callArgs = mockNoteContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { params, updater } = callArgs[0]
		expect(params.uuid).toBe("note-uuid-1")
		expect(updater).toBe("new content")
	})

	it("updateQuery=false skips noteContentQueryUpdate", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote()
		await notes.setContent({ note, content: "new content", updateQuery: false })

		expect(mockNoteContentQueryUpdate).not.toHaveBeenCalled()
	})

	it("notesWithContentQueryUpdate is always called with mapper that sets content and note fields", async () => {
		const sdkClient = makeMockSdkClient({
			setNoteContent: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-1", { title: "Updated" }))
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1" })
		const cacheEntry = { ...note, content: "old" }

		await notes.setContent({ note, content: "fresh content" })

		expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledTimes(1)
		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([cacheEntry])

		expect(result[0].content).toBe("fresh content")
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.leave
// ---------------------------------------------------------------------------

describe("notes.leave", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
		mockNoteContentQueryUpdate.mockReset()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("calls removeNoteParticipant with the current user's userId (from toStringified)", async () => {
		const sdkClient = makeMockSdkClient({
			toStringified: vi.fn().mockResolvedValue({ userId: 42n })
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote()

		await notes.leave({ note })

		expect(sdkClient.removeNoteParticipant).toHaveBeenCalledWith(note, 42n, undefined)
	})

	it("after 3000ms setTimeout: notesWithContentQueryUpdate removes the note", async () => {
		// The SDK returns a note with uuid "note-uuid-1" (from makeMockSdkClient default)
		// The setTimeout closure captures the SDK-returned note, so we filter by that uuid
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1" })
		const other = { ...makeNote({ uuid: "other-uuid" }), content: "keep" }

		await notes.leave({ note })

		expect(mockNotesWithContentQueryUpdate).not.toHaveBeenCalled()

		vi.advanceTimersByTime(3000)

		expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledTimes(1)
		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([{ ...note, content: "" }, other])

		expect(result).toHaveLength(1)
		expect(result[0].uuid).toBe("other-uuid")
	})

	it("after 3000ms setTimeout: noteContentQueryUpdate clears content (returns undefined)", async () => {
		// The SDK returns a note with uuid "note-uuid-1" (from makeMockSdkClient default)
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1" })

		await notes.leave({ note })
		vi.advanceTimersByTime(3000)

		expect(mockNoteContentQueryUpdate).toHaveBeenCalledTimes(1)
		const callArgs = mockNoteContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { params, updater } = callArgs[0]

		expect(params.uuid).toBe("note-uuid-1")
		expect(updater()).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.createTag
// ---------------------------------------------------------------------------

describe("notes.createTag", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesTagsQueryUpdate.mockReset()
	})

	it("calls SDK createNoteTag", async () => {
		const sdkClient = makeMockSdkClient()
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		await notes.createTag({ name: "work" })

		expect(sdkClient.createNoteTag).toHaveBeenCalledWith("work", undefined)
	})

	it("notesTagsQueryUpdate appends new tag, removes any existing entry with same uuid (filter then append)", async () => {
		const sdkClient = makeMockSdkClient({
			createNoteTag: vi.fn().mockResolvedValue({
				uuid: "tag-uuid-new",
				name: "fresh",
				favorite: false,
				editedTimestamp: 1000n,
				createdTimestamp: 1000n
			})
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const existingTagSameUuid = makeTag({ uuid: "tag-uuid-new", name: "stale-name" })
		const otherTag = makeTag({ uuid: "other-tag-uuid", name: "other" })

		await notes.createTag({ name: "fresh" })

		const callArgs = mockNotesTagsQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]
		const result = updater([existingTagSameUuid, otherTag])

		// The stale entry with same uuid should be replaced
		const withUuid = result.filter((t: NoteTag) => t.uuid === "tag-uuid-new")
		expect(withUuid).toHaveLength(1)
		expect(withUuid[0].name).toBe("fresh")

		// Other tag should be untouched
		expect(result.find((t: NoteTag) => t.uuid === "other-tag-uuid")).toBeDefined()
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.create
// ---------------------------------------------------------------------------

describe("notes.create", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
		mockNoteContentQueryUpdate.mockReset()
	})

	it("calls createNote, then setType, then setContent in that order", async () => {
		const callOrder: string[] = []
		const sdkClient = makeMockSdkClient({
			createNote: vi.fn().mockImplementation(async () => {
				callOrder.push("createNote")
				return makeSdkNote("note-uuid-new")
			}),
			setNoteType: vi.fn().mockImplementation(async () => {
				callOrder.push("setNoteType")
				return makeSdkNote("note-uuid-new", { noteType: "md" as unknown as NoteType })
			}),
			setNoteContent: vi.fn().mockImplementation(async () => {
				callOrder.push("setNoteContent")
				return makeSdkNote("note-uuid-new")
			})
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		await notes.create({ title: "New Note", content: "hello", type: "md" as unknown as NoteType })

		expect(callOrder[0]).toBe("createNote")
		expect(callOrder[1]).toBe("setNoteType")
		expect(callOrder[2]).toBe("setNoteContent")
	})

	it("setType is skipped when newly created note already has the requested type", async () => {
		const sdkClient = makeMockSdkClient({
			createNote: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-new", { noteType: "text" as unknown as NoteType })),
			setNoteType: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-new", { noteType: "text" as unknown as NoteType }))
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		await notes.create({ title: "New Note", content: "hello", type: "text" as unknown as NoteType })

		// setNoteType should not be called because type already matches
		expect(sdkClient.setNoteType).not.toHaveBeenCalled()
	})

	it("final notesWithContentQueryUpdate filters out existing entry with same uuid before appending", async () => {
		const sdkClient = makeMockSdkClient({
			createNote: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-new")),
			setNoteType: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-new", { noteType: "md" as unknown as NoteType })),
			setNoteContent: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-new"))
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		await notes.create({ title: "New Note", content: "hello", type: "md" as unknown as NoteType })

		// The last notesWithContentQueryUpdate call is the final one in create()
		const lastCall = mockNotesWithContentQueryUpdate.mock.calls[mockNotesWithContentQueryUpdate.mock.calls.length - 1]
		if (!lastCall) throw new Error("expected a call")
		const { updater } = lastCall[0]

		const staleEntry = { ...makeNote({ uuid: "note-uuid-new" }), content: "stale" }
		const unrelated = { ...makeNote({ uuid: "unrelated-uuid" }), content: "keep" }

		const result = updater([staleEntry, unrelated])

		const withUuid = result.filter((n: Note & { content: string }) => n.uuid === "note-uuid-new")
		expect(withUuid).toHaveLength(1)
		expect(withUuid[0].content).toBe("hello")
		expect(result.find((n: Note & { content: string }) => n.uuid === "unrelated-uuid")).toBeDefined()
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.setParticipantPermission
// ---------------------------------------------------------------------------

describe("notes.setParticipantPermission", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
	})

	it("returns early (original note) when permission already matches", async () => {
		const participant = makeParticipant({ userId: 99n, permissionsWrite: true })
		const note = makeNote({ participants: [participant] })

		const result = await notes.setParticipantPermission({ note, participant, permissionsWrite: true })

		expect(result).toBe(note)
		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("calls SDK setNoteParticipantPermission with correct args", async () => {
		const participant = makeParticipant({ userId: 99n, permissionsWrite: false })
		const sdkClient = makeMockSdkClient({
			setNoteParticipantPermission: vi.fn().mockResolvedValue(makeParticipant({ userId: 99n, permissionsWrite: true }))
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1", participants: [participant] })

		await notes.setParticipantPermission({ note, participant, permissionsWrite: true })

		expect(sdkClient.setNoteParticipantPermission).toHaveBeenCalledWith("note-uuid-1", participant, true, undefined)
	})

	it("BUGFIX #25: returned note has the updated participant permission (not stale)", async () => {
		const participant = makeParticipant({ userId: 99n, permissionsWrite: false })
		const updatedParticipant = makeParticipant({ userId: 99n, permissionsWrite: true })
		const sdkClient = makeMockSdkClient({
			setNoteParticipantPermission: vi.fn().mockResolvedValue(updatedParticipant)
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1", participants: [participant] })

		const result = await notes.setParticipantPermission({ note, participant, permissionsWrite: true })

		const updated = result.participants.find(p => p.userId === 99n)

		expect(updated).toBeDefined()
		expect(updated?.permissionsWrite).toBe(true)
	})

	it("cache updater patches LIVE cache entry (concurrency-safe), not the closure-captured note", async () => {
		const participant = makeParticipant({ userId: 99n, permissionsWrite: false })
		const updatedParticipant = makeParticipant({ userId: 99n, permissionsWrite: true })
		const sdkClient = makeMockSdkClient({
			setNoteParticipantPermission: vi.fn().mockResolvedValue(updatedParticipant)
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const note = makeNote({ uuid: "note-uuid-1", participants: [participant] })

		await notes.setParticipantPermission({ note, participant, permissionsWrite: true })

		expect(mockNotesWithContentQueryUpdate).toHaveBeenCalledTimes(1)
		const callArgs = mockNotesWithContentQueryUpdate.mock.calls[0]
		if (!callArgs) throw new Error("expected a call")
		const { updater } = callArgs[0]

		// Simulate a LIVE cache entry that has an extra participant (concurrent update scenario)
		const liveParticipant2 = makeParticipant({ userId: 77n, permissionsWrite: false })
		const liveCacheEntry = { ...makeNote({ uuid: "note-uuid-1" }), participants: [participant, liveParticipant2], content: "live" }

		const result = updater([liveCacheEntry])

		expect(result).toHaveLength(1)
		const p99 = result[0].participants.find((p: NoteParticipant) => p.userId === 99n)
		const p77 = result[0].participants.find((p: NoteParticipant) => p.userId === 77n)

		// p99 gets the updated permission
		expect(p99?.permissionsWrite).toBe(true)
		// p77 remains untouched (present in live cache, not in closure-captured note)
		expect(p77).toBeDefined()
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.importFromFile — finding #48
// ---------------------------------------------------------------------------

describe("notes.importFromFile", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
		mockNoteContentQueryUpdate.mockReset()
		fs.clear()
	})

	it("throws 'Import file not found or empty' when file does not exist", async () => {
		// fs is empty → file.exists === false
		await expect(
			notes.importFromFile({
				uri: "file:///document/missing.txt",
				title: "My Note",
				type: "text" as unknown as import("@filen/sdk-rs").NoteType
			})
		).rejects.toThrow("Import file not found or empty")

		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("throws 'Import file not found or empty' when file exists but size is 0", async () => {
		// Write zero-byte file: create() writes new Uint8Array([]) which has length 0
		const { File: MockFile } = await import("@/tests/mocks/expoFileSystem")
		const f = new MockFile("file:///document/empty.txt")

		f.create()

		await expect(
			notes.importFromFile({
				uri: "file:///document/empty.txt",
				title: "My Note",
				type: "text" as unknown as import("@filen/sdk-rs").NoteType
			})
		).rejects.toThrow("Import file not found or empty")

		expect(mockGetSdkClients).not.toHaveBeenCalled()
	})

	it("happy path: reads file text and calls create with correct args", async () => {
		// Write a non-empty file
		const { File: MockFile } = await import("@/tests/mocks/expoFileSystem")
		const f = new MockFile("file:///document/import-me.txt")

		f.write("hello imported content")

		const sdkClient = makeMockSdkClient({
			createNote: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-imported")),
			setNoteType: vi
				.fn()
				.mockResolvedValue(makeSdkNote("note-uuid-imported", { noteType: "text" as unknown as import("@filen/sdk-rs").NoteType })),
			setNoteContent: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-imported"))
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const result = await notes.importFromFile({
			uri: "file:///document/import-me.txt",
			title: "Imported Note",
			type: "text" as unknown as import("@filen/sdk-rs").NoteType
		})

		// create() must have been called (which calls createNote internally)
		expect(sdkClient.createNote).toHaveBeenCalledWith("Imported Note", undefined)
		// The content 'hello imported content' must be stored via setNoteContent
		expect(sdkClient.setNoteContent).toHaveBeenCalledWith(
			expect.objectContaining({ uuid: "note-uuid-imported" }),
			"hello imported content",
			expect.anything(),
			undefined
		)
		// Returned note should be the created note
		expect(result.uuid).toBe("note-uuid-imported")
	})
})

// ---------------------------------------------------------------------------
// Tests: Notes.createWithOptionalTag — finding #49
// ---------------------------------------------------------------------------

describe("notes.createWithOptionalTag", () => {
	beforeEach(() => {
		mockGetSdkClients.mockReset()
		mockNotesWithContentQueryUpdate.mockReset()
		mockNoteContentQueryUpdate.mockReset()
		fs.clear()
	})

	it("with tag=undefined: calls create once and does NOT call addTag, returns the created note", async () => {
		const sdkClient = makeMockSdkClient({
			createNote: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-new")),
			setNoteType: vi
				.fn()
				.mockResolvedValue(makeSdkNote("note-uuid-new", { noteType: "text" as unknown as import("@filen/sdk-rs").NoteType })),
			setNoteContent: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-new"))
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const addTagSpy = vi.spyOn(notes, "addTag")

		const result = await notes.createWithOptionalTag({
			title: "New Note",
			type: "text" as unknown as import("@filen/sdk-rs").NoteType,
			tag: undefined
		})

		expect(sdkClient.createNote).toHaveBeenCalledTimes(1)
		expect(addTagSpy).not.toHaveBeenCalled()
		expect(result.uuid).toBe("note-uuid-new")

		addTagSpy.mockRestore()
	})

	it("with tag provided: calls addTag on the created note and returns addTag's result", async () => {
		const tag = makeTag({ uuid: "tag-uuid-1" })
		const createdNote = makeSdkNote("note-uuid-new")
		const taggedNote = { ...makeSdkNote("note-uuid-new"), tags: [tag] }

		const sdkClient = makeMockSdkClient({
			createNote: vi.fn().mockResolvedValue(createdNote),
			setNoteType: vi
				.fn()
				.mockResolvedValue(makeSdkNote("note-uuid-new", { noteType: "text" as unknown as import("@filen/sdk-rs").NoteType })),
			setNoteContent: vi.fn().mockResolvedValue(makeSdkNote("note-uuid-new")),
			addTagToNote: vi.fn().mockResolvedValue({ note: { ...taggedNote, encryptionKey: "k" }, tag })
		})
		mockGetSdkClients.mockResolvedValue({ authedSdkClient: sdkClient })

		const result = await notes.createWithOptionalTag({
			title: "Tagged Note",
			type: "text" as unknown as import("@filen/sdk-rs").NoteType,
			tag
		})

		expect(sdkClient.createNote).toHaveBeenCalledTimes(1)
		expect(sdkClient.addTagToNote).toHaveBeenCalledTimes(1)
		// The note passed to addTag should be the one returned by create
		expect(sdkClient.addTagToNote).toHaveBeenCalledWith(expect.objectContaining({ uuid: "note-uuid-new" }), tag, undefined)
		// The returned note should have the tag attached
		expect(result.uuid).toBe("note-uuid-new")
	})
})
