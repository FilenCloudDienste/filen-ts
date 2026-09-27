import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Note, SocketEvent } from "@filen/sdk-rs"

// End to end over the real outbox (sync.ts), socket handlers and tab editor record: a note edited here
// while another device or tab saves it. Only the SDK, the disk and the toasts are mocked.
const { setNoteContent, getNoteContent, listNotes, persisted } = vi.hoisted(() => {
	// The outbox an earlier page load left on disk.
	const disk: { value: unknown } = { value: null }

	return {
		setNoteContent: vi.fn<(note: Note, content: string, preview: string) => Promise<Note>>(),
		getNoteContent: vi.fn<(note: Note) => Promise<string | undefined>>(),
		listNotes: vi.fn<() => Promise<Note[]>>(() => Promise.resolve([])),
		persisted: disk
	}
})

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { setNoteContent, getNoteContent, listNotes } }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(persisted.value),
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
import { seedTabEditor, tabEditorBaseHash, tabEditorBuffer, tabEditorChanged, tabEditorDirty } from "@/features/notes/lib/tabEditors"
import { deriveEditorSeed, deriveSessionBaseHash, latestInflightContent } from "@/features/notes/hooks/useNoteEditor.logic"

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
	persisted.value = null
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

describe("notes — a clean tab when the question is answered in another tab", () => {
	it("the leader tab takes theirs when the answer sends nothing, so its next edit does not bury theirs unseen", async () => {
		openNote()

		const cloud = cloudOf("old")

		// A follower's typing reached the leader's queue; another device saves: this tab is asked too.
		sync.ingestRemoteEnqueue({ note, content: "B text", timestamp: 1, baseContentHash: hashNoteContent("old"), origin: "tab-B" })
		cloud.set("theirs")
		handleNoteEvent(contentEdited("theirs", ELSEWHERE))

		expect(question()).toBeDefined()

		// The follower answers Load theirs: already in the cloud, nothing is sent and nothing echoes.
		sync.ingestRemoteEnqueue({
			note,
			content: "theirs",
			timestamp: Date.now(),
			baseContentHash: hashNoteContent("theirs"),
			origin: "tab-B",
			answer: true
		})
		useNotesRemoteEditStore.getState().dropRemoteEdited(note.uuid)
		sync.executeNow()
		await tick()

		expect(setNoteContent).not.toHaveBeenCalled()
		expect(queuedContents()).toBeUndefined()
		expect(question()).toBeUndefined()
		// Reseeded from theirs, and said so.
		expect(queryClient.getQueryData(noteContentQueryKey(note.uuid))).toBe("theirs")
		expect(remountKey()).not.toBe(1)
		expect(toast).toHaveBeenCalledExactlyOnceWith("notes:noteUpdatedElsewhere")

		// The editor remounts on theirs; the next edit is typed on it.
		seedTabEditor(note.uuid, "a:2", "theirs", "theirs")

		const seed = deriveEditorSeed({
			inflightLatest: latestInflightContent(undefined),
			queryContent: queryClient.getQueryData<string>(noteContentQueryKey(note.uuid))
		})

		beginEditingSession(note.uuid)
		tabEditorChanged(note.uuid, "theirs + A")
		await sync.enqueue(
			note,
			"theirs + A",
			tabEditorBaseHash(note.uuid) ?? deriveSessionBaseHash({ seed, hasInflight: false, current: null })
		)
		sync.executeNow()
		await tick()

		expect(cloud.get()).toBe("theirs + A")
	})

	it("a clean follower, asked only because another tab's typing is queued, takes theirs", () => {
		openNote()
		useNotesInflightStore.setState({
			inflightContent: { a: [{ timestamp: 1, content: "B text", note, baseContentHash: hashNoteContent("old"), origin: "tab-B" }] }
		})
		handleNoteEvent(contentEdited("theirs", ELSEWHERE))

		expect(question()).toBeDefined()

		useNotesInflightStore.setState({ inflightContent: {} })
		useNotesRemoteEditStore.getState().dropRemoteEdited(note.uuid)

		expect(question()).toBeUndefined()
		expect(queryClient.getQueryData(noteContentQueryKey(note.uuid))).toBe("theirs")
		expect(remountKey()).not.toBe(1)
	})
})

describe("notes — this browser's own writes outside the typing", () => {
	it("a late echo of the new note's own create-time write after the first keystroke asks nothing and holds nothing", async () => {
		queryClient.setQueryData(noteContentQueryKey(note.uuid), "", { updatedAt: 1 })
		useNotesRemoteEditStore.getState().setOpenNote(note.uuid)
		seedTabEditor(note.uuid, "a:1", "", "")

		const cloud = cloudOf("")

		beginEditingSession(note.uuid)
		tabEditorChanged(note.uuid, "# Heading")
		await sync.enqueue(note, "# Heading", tabEditorBaseHash(note.uuid) ?? hashNoteContent(""))
		// Not recorded as this browser's (a write made past the notes feature): the version the typing is on.
		handleNoteEvent(contentEdited("", ME))
		sync.executeNow()
		await tick()

		expect(question()).toBeUndefined()
		expect(cloud.get()).toBe("# Heading")
	})

	it("an import's create-time echo leaves no standing question once the import's own push is heard back", async () => {
		const cloud = cloudOf("")

		await sync.enqueue(note, "# imported", null)
		sync.executeNow()
		queryClient.setQueryData(noteContentQueryKey(note.uuid), "# imported")
		handleNoteEvent(contentEdited("", ME))
		await tick()

		expect(cloud.get()).toBe("# imported")

		handleNoteEvent(contentEdited("# imported", ME))

		expect(question()).toBeUndefined()
	})

	it("a draft restored from this browser's outbox is its own: typing during its push raises no question", async () => {
		persisted.value = { a: [{ timestamp: 1, content: "A", note, baseContentHash: hashNoteContent("old") }] }
		sync.cancel()
		queryClient.setQueryData(noteContentQueryKey(note.uuid), "old", { updatedAt: 1 })
		listNotes.mockResolvedValue([note])
		getNoteContent.mockResolvedValue("old")

		const response = deferred<Note>()

		setNoteContent.mockImplementationOnce(() => response.promise)
		setNoteContent.mockImplementation(n => Promise.resolve(n))
		useNotesRemoteEditStore.getState().setOpenNote(note.uuid)
		// The page reloads: restore, reconcile, push the draft.
		sync.start()
		await tick()
		await tick()

		expect(setNoteContent).toHaveBeenCalledWith(note, "A", expect.any(String))

		// The editor mounted on the restored draft; the user types on.
		seedTabEditor(note.uuid, "a:1", "A", "old")
		type("AB")
		handleNoteEvent(contentEdited("A", ME))
		response.resolve(note)
		await tick()

		expect(question()).toBeUndefined()
		expect((await heldNotes()).has(note.uuid)).toBe(false)
	})
})

describe("notes — what the other tabs hear of a push", () => {
	it("a follower's own text is synced when the leader says it landed, without its echo", () => {
		openNote()
		sync.startAsFollower()
		type("mine")

		const origin = useNotesInflightStore.getState().inflightContent[note.uuid]?.[0]?.origin

		expect(tabEditorDirty(note.uuid)).toBe(true)

		sync.heardPush(note.uuid, hashNoteContent("mine"), origin)
		// Still in flight.
		expect(tabEditorDirty(note.uuid)).toBe(true)

		sync.heardLanded(note.uuid, hashNoteContent("mine"), origin)

		expect(tabEditorDirty(note.uuid)).toBe(false)
		expect(tabEditorBaseHash(note.uuid)).toBe(hashNoteContent("mine"))
	})

	it("a push the outbox gives up on leaves no base that never landed", async () => {
		openNote()
		type("unsaved work")
		getNoteContent.mockResolvedValue("old")
		setNoteContent.mockRejectedValue({ species: "sdk", kind: "Server", label: "Server", message: "Server" })

		for (let i = 0; i < 3; i++) {
			sync.executeNow()
			await tick()
		}

		expect(queuedContents()).toBeUndefined()
		expect(tabEditorBaseHash(note.uuid)).toBeUndefined()
		expect(tabEditorDirty(note.uuid)).toBe(true)
	})
})
