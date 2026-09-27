import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Note, SocketEvent } from "@filen/sdk-rs"

// End to end over the real outbox (sync.ts), socket handlers and tab editor record: a note edited here
// while another device or tab saves it. Only the SDK, the disk and the toasts are mocked.
const { setNoteContent, getNoteContent, listNotes } = vi.hoisted(() => ({
	setNoteContent: vi.fn<(note: Note, content: string, preview: string) => Promise<Note>>(),
	getNoteContent: vi.fn<(note: Note) => Promise<string | undefined>>(),
	listNotes: vi.fn<() => Promise<Note[]>>(() => Promise.resolve([]))
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { setNoteContent, getNoteContent, listNotes } }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }))

vi.mock("sonner", () => ({ toast }))
vi.mock("@/lib/i18n", () => ({ i18n: { t: (key: string) => key } }))

import { hashNoteContent } from "@filen/shared"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { NOTES_QUERY_KEY } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { sync } from "@/features/notes/lib/sync"
import useNotesInflightStore, { beginEditingSession } from "@/features/notes/store/useNotesInflight"
import { useNotesRemoteEditStore } from "@/features/notes/store/useNoteRemoteEdit"
import { handleNoteEvent, keepMineOverRemoteEdit, reloadRemoteEdit } from "@/features/notes/lib/socketHandlers"
import { heldNotes, releaseAllNoteHolds } from "@/features/notes/lib/remoteEditHolds"
import { seedTabEditor, tabEditorBaseHash, tabEditorBuffer, tabEditorChanged } from "@/features/notes/lib/tabEditors"

const ME = 7
const ELSEWHERE = 99

function makeNote(uuid: string): Note {
	return {
		uuid: uuid as Note["uuid"],
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: [],
		title: `note-${uuid}`
	}
}

const note = makeNote("a")

function contentEdited(content: string, editorId: number): Extract<SocketEvent, { type: "note" }> {
	return {
		type: "note",
		noteMessageId: 0n,
		inner: {
			type: "contentEdited",
			note: note.uuid,
			content: { Decrypted: content },
			noteType: "text",
			editorId,
			editedTimestamp: 999n
		}
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

async function tick(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 15))
}

// What the editor's onChange does.
function type(value: string): void {
	beginEditingSession(note.uuid)
	tabEditorChanged(note.uuid, value)
	void sync.enqueue(note, value, tabEditorBaseHash(note.uuid) ?? hashNoteContent("old"))
}

function question(): { theirs: string | undefined } | undefined {
	return useNotesRemoteEditStore.getState().remoteEdited[note.uuid]
}

function queuedContents(): string[] | undefined {
	return useNotesInflightStore.getState().inflightContent[note.uuid]?.map(entry => entry.content)
}

function remountKey(): number | undefined {
	return queryClient.getQueryState(noteContentQueryKey(note.uuid))?.dataUpdatedAt
}

// The note open on screen with "old", in the cloud too, unless a test says otherwise.
function openNote(): void {
	queryClient.setQueryData(noteContentQueryKey(note.uuid), "old", { updatedAt: 1 })
	useNotesRemoteEditStore.getState().setOpenNote(note.uuid)
	seedTabEditor(note.uuid, "a:1", "old", "old")
}

// A cloud the pushes write and the peeks read.
function cloudOf(initial: string): { get: () => string; set: (content: string) => void } {
	let cloud = initial

	getNoteContent.mockImplementation(() => Promise.resolve(cloud))
	setNoteContent.mockImplementation((n, content) => {
		cloud = content

		return Promise.resolve(n)
	})

	return {
		get: () => cloud,
		set: content => {
			cloud = content
		}
	}
}

beforeEach(async () => {
	// A clean outbox (cancel forgets pushes, tab editors and holds) re-armed as the only tab.
	sync.cancel()
	queryClient.clear()
	useNotesInflightStore.setState({ inflightContent: {}, editingSessions: {} })
	useNotesRemoteEditStore.setState({ remoteEdited: {}, openNote: null })
	releaseAllNoteHolds()
	vi.clearAllMocks()
	queryClient.setQueryData(ACCOUNT_QUERY_KEY, { id: BigInt(ME) })
	queryClient.setQueryData(NOTES_QUERY_KEY, [note])
	sync.start()
	await tick()
})

describe("notes — this tab's own push", () => {
	it("is known for its own however much the user types during the peek: no question, the typing stays queued", async () => {
		openNote()
		type("v1")

		const peek = deferred<string | undefined>()

		getNoteContent.mockReturnValueOnce(peek.promise)
		setNoteContent.mockImplementation(n => Promise.resolve(n))
		sync.executeNow()
		await tick()

		for (const value of ["v2", "v3", "v4", "v5", "v6"]) {
			type(value)
		}

		peek.resolve("old")
		await tick()

		expect(setNoteContent).toHaveBeenCalledWith(note, "v1", expect.any(String))

		handleNoteEvent(contentEdited("v1", ME))

		expect(question()).toBeUndefined()
		expect(queuedContents()).toEqual(["v6"])
		expect((await heldNotes()).has(note.uuid)).toBe(false)

		getNoteContent.mockResolvedValue("v1")
		sync.executeNow()
		await tick()

		expect(setNoteContent).toHaveBeenLastCalledWith(note, "v6", expect.any(String))
		expect(toast).not.toHaveBeenCalled()
	})

	it("an edit dropped after the last rejection is still unsaved on screen: another device's save asks", async () => {
		openNote()
		type("unsaved work")
		getNoteContent.mockResolvedValue("old")
		setNoteContent.mockRejectedValue({ species: "sdk", kind: "Server", label: "Server", message: "Server" })

		for (let i = 0; i < 3; i++) {
			sync.executeNow()
			await tick()
		}

		expect(queuedContents()).toBeUndefined()

		handleNoteEvent(contentEdited("theirs", ELSEWHERE))

		expect(question()).toEqual({ theirs: "theirs" })
		expect(remountKey()).toBe(1)
	})
})

describe("notes — answering the question", () => {
	it("Keep mine keeps mine when their save landed after this tab's push, whose response came after their event", async () => {
		openNote()
		type("mine")

		const cloud = cloudOf("old")
		const response = deferred<Note>()

		setNoteContent.mockImplementationOnce((_n, content) => {
			cloud.set(content)

			return response.promise
		})
		sync.executeNow()
		await tick()

		expect(cloud.get()).toBe("mine")

		// Server order: the echo of this tab's push, then another device's save on top of it.
		handleNoteEvent(contentEdited("mine", ME))
		cloud.set("theirs")
		handleNoteEvent(contentEdited("theirs", ELSEWHERE))

		expect(question()).toEqual({ theirs: "theirs" })

		response.resolve(note)
		await tick()
		await keepMineOverRemoteEdit(note)
		await tick()

		expect(cloud.get()).toBe("mine")
		expect(question()).toBeUndefined()
	})

	it("Keep mine is pushed at once in a single tab", async () => {
		openNote()
		type("mine")

		const cloud = cloudOf("theirs")

		handleNoteEvent(contentEdited("theirs", ELSEWHERE))

		expect((await heldNotes()).has(note.uuid)).toBe(true)

		await keepMineOverRemoteEdit(note)
		await tick()

		expect(cloud.get()).toBe("mine")
	})

	it("a question left on a note not on screen follows later saves: retired once the note is clean", async () => {
		useNotesRemoteEditStore.getState().setOpenNote("b")

		const cloud = cloudOf("old")

		await sync.enqueue(note, "mine", hashNoteContent("old"))
		cloud.set("theirs1")
		handleNoteEvent(contentEdited("theirs1", ELSEWHERE))

		expect(question()).toEqual({ theirs: "theirs1" })

		sync.executeNow()
		await tick()
		handleNoteEvent(contentEdited("mine", ME))
		cloud.set("theirs2")
		handleNoteEvent(contentEdited("theirs2", ELSEWHERE))

		expect(question()).toBeUndefined()

		useNotesRemoteEditStore.getState().setOpenNote(note.uuid)
		await reloadRemoteEdit(note)
		sync.executeNow()
		await tick()

		expect(cloud.get()).toBe("theirs2")
	})

	it("a newer save elsewhere replaces the version a question on a note with unsynced edits asks about", () => {
		useNotesInflightStore.setState({ inflightContent: { a: [{ timestamp: 1, content: "mine", note }] } })

		handleNoteEvent(contentEdited("theirs1", ELSEWHERE))
		handleNoteEvent(contentEdited("theirs2", ELSEWHERE))

		expect(question()).toEqual({ theirs: "theirs2" })

		handleNoteEvent(contentEdited("mine", ELSEWHERE))

		expect(question()).toBeUndefined()
	})

	it("an answer in another tab leaves the question where this tab's own typing is unsaved, and closes it where not", () => {
		openNote()
		beginEditingSession(note.uuid)
		tabEditorChanged(note.uuid, "Y text")
		useNotesInflightStore.setState({
			inflightContent: { a: [{ timestamp: 1, content: "Y text", note, baseContentHash: hashNoteContent("old") }] }
		})
		handleNoteEvent(contentEdited("theirs", ELSEWHERE))

		// Another tab answered "Load theirs", already in the cloud: the queue drained, nothing was pushed.
		useNotesInflightStore.setState({ inflightContent: {} })
		useNotesRemoteEditStore.getState().dropRemoteEdited(note.uuid)

		expect(question()).toEqual({ theirs: "theirs" })

		seedTabEditor(note.uuid, "a:2", "theirs", "theirs")
		useNotesRemoteEditStore.getState().dropRemoteEdited(note.uuid)

		expect(question()).toBeUndefined()
	})
})

describe("notes — a clean editor and a save elsewhere", () => {
	it("a save identical to what it shows changes nothing on screen", () => {
		queryClient.setQueryData(noteContentQueryKey(note.uuid), "same", { updatedAt: 1 })
		useNotesRemoteEditStore.getState().setOpenNote(note.uuid)
		seedTabEditor(note.uuid, "a:1", "same", "same")

		handleNoteEvent(contentEdited("same", ELSEWHERE))

		expect(remountKey()).toBe(1)
		expect(toast).not.toHaveBeenCalled()
		expect(tabEditorBuffer(note.uuid)).toBe("same")
	})
})
