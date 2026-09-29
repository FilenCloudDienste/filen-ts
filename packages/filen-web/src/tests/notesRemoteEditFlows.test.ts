import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, onlineManager } from "@tanstack/react-query"
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

import { buildInflightEntries, hashNoteContent } from "@filen/shared"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { NOTES_QUERY_KEY } from "@/features/notes/queries/notes"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { sync } from "@/features/notes/lib/sync"
import useNotesInflightStore, { beginEditingSession } from "@/features/notes/store/useNotesInflight"
import { useNotesRemoteEditStore } from "@/features/notes/store/useNoteRemoteEdit"
import { handleNoteEvent, keepMineOverRemoteEdit, reloadRemoteEdit } from "@/features/notes/lib/socketHandlers"
import { heldNotes, releaseAllNoteHolds } from "@/features/notes/lib/remoteEditHolds"
import {
	seedTabEditor,
	tabEditorBaseHash,
	tabEditorBuffer,
	tabEditorChanged,
	tabEditorDirty,
	tabEditorSynced
} from "@/features/notes/lib/tabEditors"
import { rememberNotePush } from "@/features/notes/lib/pushEchoes"
import {
	deriveEditorSeed,
	deriveSessionBaseHash,
	latestInflightContent,
	latestShowableContent
} from "@/features/notes/hooks/useNoteEditor.logic"

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

// Another tab of this browser, alive until the returned function is called (it holds its tab lock).
function liveTab(origin: string): () => void {
	let release = (): void => undefined

	void navigator.locks.request(
		`filen-web-notes-tab:${origin}`,
		() =>
			new Promise<void>(resolve => {
				release = resolve
			})
	)

	return () => {
		release()
	}
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
	useNotesInflightStore.setState({ inflightContent: {}, editingSessions: {}, editorReseeds: {} })
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

		// The live row, which the echo moved on to the pushed version.
		expect(setNoteContent).toHaveBeenLastCalledWith(
			expect.objectContaining({ uuid: note.uuid, preview: "v1" }),
			"v6",
			expect.any(String)
		)
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
		const closeB = liveTab("tab-B")

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
		closeB()
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

		const entry = useNotesInflightStore.getState().inflightContent[note.uuid]?.[0]
		const origin = entry?.origin

		expect(tabEditorDirty(note.uuid)).toBe(true)

		sync.heardPush(note.uuid, hashNoteContent("mine"), { origin: origin ?? "", stamp: entry?.timestamp ?? 0 })
		// Still in flight.
		expect(tabEditorDirty(note.uuid)).toBe(true)

		sync.heardLanded(note.uuid, hashNoteContent("mine"), { origin: origin ?? "", stamp: entry?.timestamp ?? 0, landed: true })

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

describe("notes — versions this tab builds on, and versions it does not", () => {
	it("another tab's history restore to the text this tab was seeded with asks this tab, which has typed on", async () => {
		queryClient.setQueryData(noteContentQueryKey(note.uuid), "S", { updatedAt: 1 })
		useNotesRemoteEditStore.getState().setOpenNote(note.uuid)
		seedTabEditor(note.uuid, "a:1", "S", "S")

		const cloud = cloudOf("S")

		type("S+A")
		sync.executeNow()
		await tick()
		handleNoteEvent(contentEdited("S+A", ME))
		type("S+A+B")

		// Another tab restores "S" from history: its write is this browser's, and it empties the queue.
		rememberNotePush(note.uuid, hashNoteContent("S"))
		cloud.set("S")
		sync.dropEntry(note.uuid)
		handleNoteEvent(contentEdited("S", ME))

		expect(question()).toEqual({ theirs: "S" })
		expect(tabEditorDirty(note.uuid)).toBe(true)
	})

	it("a question follows another device's revert to the version the typing builds on: retired, not left on the older save", async () => {
		openNote()
		cloudOf("old")
		type("old + mine")
		await tick()

		handleNoteEvent(contentEdited("X", ME))

		expect(question()).toEqual({ theirs: "X" })

		handleNoteEvent(contentEdited("old", ME))

		expect(question()).toBeUndefined()
	})
})

// This outbox plays the leader; the socket handler and tab editor play follower F.
describe("notes — a follower's keystroke typed before it heard its push land", () => {
	async function followerTypesAcrossALandedPush(): Promise<{ get: () => string; set: (content: string) => void }> {
		openNote()

		const cloud = cloudOf("old")
		const response = deferred<Note>()

		setNoteContent.mockImplementationOnce((_n, content) => {
			cloud.set(content)

			return response.promise
		})
		tabEditorChanged(note.uuid, "old+A")

		const before = buildInflightEntries({
			previous: undefined,
			note,
			content: "old+A",
			now: 1000,
			sessionBaseHash: hashNoteContent("old")
		})

		sync.ingestRemoteEnqueue({ note, content: "old+A", timestamp: 1000, baseContentHash: hashNoteContent("old"), origin: "tab-F" })
		sync.executeNow()
		await tick()
		response.resolve(note)
		await tick()

		// F's store still holds the pushed entry: the keystroke carries its base.
		const next = buildInflightEntries({
			previous: before,
			note,
			content: "old+AB",
			now: 2000,
			sessionBaseHash: hashNoteContent("old+A")
		})

		expect(next[0]?.baseContentHash).toBe(hashNoteContent("old"))

		sync.ingestRemoteEnqueue({
			note,
			content: "old+AB",
			timestamp: 2000,
			baseContentHash: hashNoteContent("old"),
			origin: "tab-F",
			carriedFrom: "tab-F"
		})
		tabEditorChanged(note.uuid, "old+AB")
		tabEditorSynced(note.uuid, "old+A", hashNoteContent("old+A"))

		return cloud
	}

	it("is rebased onto the landed push by the leader: its next push warns of nothing", async () => {
		const cloud = await followerTypesAcrossALandedPush()

		expect(queuedContents()).toEqual(["old+AB"])
		expect(useNotesInflightStore.getState().inflightContent[note.uuid]?.[0]?.baseContentHash).toBe(hashNoteContent("old+A"))

		sync.executeNow()
		await tick()

		expect(cloud.get()).toBe("old+AB")
		expect(toast).not.toHaveBeenCalled()
	})

	it("another device's revert to the pre-push version is then asked about, and the push warns of it", async () => {
		const cloud = await followerTypesAcrossALandedPush()

		cloud.set("old")
		handleNoteEvent(contentEdited("old", ME))

		expect(question()).toEqual({ theirs: "old" })

		releaseAllNoteHolds()
		sync.executeNow()
		await tick()

		expect(toast).toHaveBeenCalledWith("notes:noteOverwroteNewerRemoteChanges")
	})

	it("another tab's keystroke on the pre-push version is not rebased: it never saw the push", async () => {
		await followerTypesAcrossALandedPush()
		sync.ingestRemoteEnqueue({ note, content: "old+G", timestamp: 3000, baseContentHash: hashNoteContent("old"), origin: "tab-G" })

		expect(useNotesInflightStore.getState().inflightContent[note.uuid]?.[0]?.baseContentHash).toBe(hashNoteContent("old"))
	})

	it("the follower rebases its own entries when it hears its push landed", () => {
		openNote()
		sync.startAsFollower()
		type("mine")

		const pushed = useNotesInflightStore.getState().inflightContent[note.uuid]?.[0]

		type("mine, more")
		sync.heardLanded(note.uuid, hashNoteContent("mine"), { origin: pushed?.origin ?? "", stamp: pushed?.timestamp ?? 0, landed: true })

		expect(useNotesInflightStore.getState().inflightContent[note.uuid]?.[0]?.baseContentHash).toBe(hashNoteContent("mine"))
	})
})

describe("notes — how the question was answered in another tab", () => {
	function askedBecauseAnotherTabTyped(): void {
		openNote()
		useNotesInflightStore.setState({
			inflightContent: { a: [{ timestamp: 1, content: "B text", note, baseContentHash: hashNoteContent("old"), origin: "tab-B" }] }
		})
		handleNoteEvent(contentEdited("theirs", ELSEWHERE))
		toast.mockClear()
	}

	it("Keep mine: a clean tab waits for mine's push, without taking theirs or a toast", () => {
		askedBecauseAnotherTabTyped()
		useNotesRemoteEditStore.getState().dropRemoteEdited(note.uuid, "mine")

		expect(question()).toBeUndefined()
		expect(queryClient.getQueryData(noteContentQueryKey(note.uuid))).toBe("old")
		expect(remountKey()).toBe(1)
		expect(toast).not.toHaveBeenCalled()

		// Mine's push, heard back: taken without a toast.
		rememberNotePush(note.uuid, hashNoteContent("B text"))
		handleNoteEvent(contentEdited("B text", ME))

		expect(queryClient.getQueryData(noteContentQueryKey(note.uuid))).toBe("B text")
		expect(toast).not.toHaveBeenCalled()
	})

	it("Save mine as a copy: a clean tab takes theirs", () => {
		askedBecauseAnotherTabTyped()
		useNotesRemoteEditStore.getState().dropRemoteEdited(note.uuid, "copy")

		expect(queryClient.getQueryData(noteContentQueryKey(note.uuid))).toBe("theirs")
	})

	it("an answer from a tab that does not tell its choice is read off the queue: another version queued over theirs is mine kept", () => {
		askedBecauseAnotherTabTyped()
		useNotesInflightStore.setState({
			inflightContent: { a: [{ timestamp: 2, content: "B text", note, baseContentHash: hashNoteContent("theirs"), origin: "tab-B" }] }
		})
		useNotesRemoteEditStore.getState().dropRemoteEdited(note.uuid)

		expect(queryClient.getQueryData(noteContentQueryKey(note.uuid))).toBe("old")
	})
})

describe("notes — a push's base, and who hears of an overwrite", () => {
	it("a fresh session on text older than this tab's landed push is not rebased onto it: its push warns", async () => {
		const cloud = cloudOf("B0")

		sync.ingestRemoteEnqueue({ note, content: "A", timestamp: 1000, baseContentHash: hashNoteContent("B0"), origin: "tab-F" })
		sync.executeNow()
		await tick()

		expect(cloud.get()).toBe("A")

		// F came back to the note on a stale seed and typed at once: a fresh session, based on B0.
		sync.ingestRemoteEnqueue({ note, content: "B0 + c", timestamp: 9000, baseContentHash: hashNoteContent("B0"), origin: "tab-F" })

		expect(useNotesInflightStore.getState().inflightContent[note.uuid]?.[0]?.baseContentHash).toBe(hashNoteContent("B0"))

		sync.executeNow()
		await tick()

		expect(toast).toHaveBeenCalledWith("notes:noteOverwroteNewerRemoteChanges")
	})

	it("a fresh session on a history restore of the landed push's base warns of nothing", async () => {
		const cloud = cloudOf("B0")

		sync.ingestRemoteEnqueue({ note, content: "A", timestamp: 1000, baseContentHash: hashNoteContent("B0"), origin: "tab-F" })
		sync.executeNow()
		await tick()
		cloud.set("B0")
		sync.ingestRemoteEnqueue({ note, content: "B0+c", timestamp: 5000, baseContentHash: hashNoteContent("B0"), origin: "tab-F" })
		sync.executeNow()
		await tick()

		expect(cloud.get()).toBe("B0+c")
		expect(toast).not.toHaveBeenCalled()
	})

	it("the prune rebases only the pushing tab's own continuation: another tab's entry still warns", async () => {
		openNote()
		seedTabEditor(note.uuid, "a:1", "B0", "B0")

		const cloud = cloudOf("B0")
		const response = deferred<Note>()

		setNoteContent.mockImplementationOnce((_n, content) => {
			cloud.set(content)

			return response.promise
		})
		type("A")
		sync.executeNow()
		await tick()
		// Another tab, since closed, typed on B0 while the push was out.
		sync.ingestRemoteEnqueue({
			note,
			content: "B0+z",
			timestamp: Date.now() + 1000,
			baseContentHash: hashNoteContent("B0"),
			origin: "tab-F2"
		})
		response.resolve(note)
		await tick()

		expect(useNotesInflightStore.getState().inflightContent[note.uuid]?.[0]?.baseContentHash).toBe(hashNoteContent("B0"))

		sync.executeNow()
		await tick()

		// Its tab is gone: the leader tells.
		expect(cloud.get()).toBe("B0+z")
		expect(toast).toHaveBeenCalledWith("notes:noteOverwroteNewerRemoteChanges")
	})

	it("a follower's history restore drops its queued typing in the leader too", async () => {
		const cloud = cloudOf("B")

		sync.ingestRemoteEnqueue({ note, content: "B+x", timestamp: 1000, baseContentHash: hashNoteContent("B"), origin: "tab-T2" })
		// The restore in the follower: its dropEntry reaches the leader.
		sync.ingestDrop(note.uuid)
		cloud.set("R")
		sync.executeNow()
		await tick()

		expect(queuedContents()).toBeUndefined()
		expect(setNoteContent).not.toHaveBeenCalled()
		expect(cloud.get()).toBe("R")
	})

	it("an echo of a restored draft arriving after this tab's own later push landed is stale: no reseed, no question", async () => {
		queryClient.setQueryData(noteContentQueryKey(note.uuid), "B0", { updatedAt: 1 })
		useNotesRemoteEditStore.getState().setOpenNote(note.uuid)
		useNotesInflightStore.setState({
			inflightContent: { a: [{ timestamp: 1, content: "D", note, baseContentHash: hashNoteContent("B0"), origin: "old-page" }] }
		})
		seedTabEditor(note.uuid, "a:1", "D", "B0")

		const cloud = cloudOf("B0")
		const response = deferred<Note>()

		setNoteContent.mockImplementationOnce((_n, content) => {
			cloud.set(content)

			return response.promise
		})
		sync.executeNow()
		await tick()
		beginEditingSession(note.uuid)
		tabEditorChanged(note.uuid, "D+x")
		await sync.enqueue(note, "D+x", tabEditorBaseHash(note.uuid) ?? hashNoteContent("D"))
		sync.executeNow()
		response.resolve(note)
		await tick()
		await tick()

		expect(cloud.get()).toBe("D+x")

		const key = remountKey()

		handleNoteEvent(contentEdited("D", ME))

		expect(remountKey()).toBe(key)
		expect(question()).toBeUndefined()
		expect(tabEditorDirty(note.uuid)).toBe(false)

		// D+x's own echo still counts as this tab's.
		handleNoteEvent(contentEdited("D+x", ME))

		expect(remountKey()).toBe(key)
		expect(question()).toBeUndefined()
	})

	it("a follower with no editor on screen follows its own landed text into its content cache", () => {
		queryClient.setQueryData(noteContentQueryKey(note.uuid), "B0", { updatedAt: 1 })
		sync.startAsFollower()
		void sync.enqueue(note, "A", hashNoteContent("B0"))

		const entry = useNotesInflightStore.getState().inflightContent[note.uuid]?.[0]

		sync.heardLanded(note.uuid, hashNoteContent("A"), { origin: entry?.origin ?? "", stamp: entry?.timestamp ?? 0, landed: true })

		expect(queryClient.getQueryData(noteContentQueryKey(note.uuid))).toBe("A")
		expect(remountKey()).toBe(1)
	})
})

describe("notes — what a tab's editor shows, and which echoes are its own", () => {
	function showsWhatAnEditorWould(key: string): void {
		const cache = queryClient.getQueryData<string>(noteContentQueryKey(note.uuid))
		const seed = deriveEditorSeed({
			inflightLatest: latestShowableContent(useNotesInflightStore.getState().inflightContent[note.uuid]),
			queryContent: cache
		})

		seedTabEditor(note.uuid, key, seed, cache)
	}

	it("an editor never shows another live tab's queued draft; one it was shown anyway still warns when typed on", () => {
		openNote()
		sync.startAsFollower()
		sync.applyLeaderState({ a: [{ timestamp: 1000, content: "X", note, baseContentHash: hashNoteContent("B0"), origin: "tab-T2" }] })
		handleNoteEvent(contentEdited("C", ELSEWHERE))
		// T2 answered Load theirs; its drop reaches the leader after the answer reaches this tab.
		useNotesRemoteEditStore.getState().dropRemoteEdited(note.uuid, "theirs")
		showsWhatAnEditorWould("a:2")

		expect(tabEditorBuffer(note.uuid)).toBe("C")

		// Shown T2's draft regardless: typing on it keeps the draft's base, so its push warns.
		seedTabEditor(note.uuid, "a:3", "X", "C")

		expect(tabEditorBaseHash(note.uuid)).toBe(hashNoteContent("B0"))
	})

	it("an editor shows an orphan draft (a closed tab's, an earlier page load's) and its own", () => {
		expect(
			latestShowableContent([
				{ timestamp: 1, content: "orphan", note, origin: "gone", orphan: true },
				{ timestamp: 2, content: "live", note, origin: "tab-T2" }
			])
		).toBe("orphan")
		expect(latestShowableContent([{ timestamp: 1, content: "older build", note }])).toBe("older build")
		expect(latestShowableContent([{ timestamp: 1, content: "live", note, origin: "tab-T2" }])).toBeNull()
	})

	it("a restore's echo reaching this tab before the restoring tab's drop does not show its draft", () => {
		openNote()
		cloudOf("B0")
		sync.ingestRemoteEnqueue({ note, content: "X", timestamp: Date.now(), baseContentHash: hashNoteContent("B0"), origin: "tab-T2" })
		rememberNotePush(note.uuid, hashNoteContent("R"))
		handleNoteEvent(contentEdited("R", ME))
		showsWhatAnEditorWould("a:2")

		expect(tabEditorBuffer(note.uuid)).toBe("R")
	})

	it("a restore's entry marks a closed tab's queued typing an orphan, and keeps a live tab's as it is", async () => {
		sync.cancel()
		persisted.value = {
			a: [{ timestamp: 1, content: "closed", note, origin: "a closed tab" }],
			b: [{ timestamp: 1, content: "live", note: makeNote("b"), origin: "tab-live" }]
		}

		listNotes.mockResolvedValue([note, makeNote("b")])
		getNoteContent.mockResolvedValue("cloud")

		let release = (): void => undefined

		void navigator.locks.request(
			"filen-web-notes-tab:tab-live",
			() =>
				new Promise<void>(resolve => {
					release = resolve
				})
		)
		// The pushes stay out, so the queue can be looked at.
		const pushes = deferred<Note>()

		setNoteContent.mockImplementation(() => pushes.promise)
		sync.start()
		await tick()
		await tick()

		expect(useNotesInflightStore.getState().inflightContent["a"]?.[0]?.orphan).toBe(true)
		expect(useNotesInflightStore.getState().inflightContent["b"]?.[0]?.orphan).toBeUndefined()
		release()
		pushes.resolve(note)
		await tick()
	})

	it("typing on a restored draft during its push is rebased onto it: no false overwrite", async () => {
		queryClient.setQueryData(noteContentQueryKey(note.uuid), "B0", { updatedAt: 1 })
		useNotesRemoteEditStore.getState().setOpenNote(note.uuid)
		useNotesInflightStore.setState({
			inflightContent: {
				a: [{ timestamp: 1, content: "D", note, baseContentHash: hashNoteContent("B0"), origin: "old-page", orphan: true }]
			}
		})
		seedTabEditor(note.uuid, "a:1", "D", "B0")

		const cloud = cloudOf("B0")
		const response = deferred<Note>()

		setNoteContent.mockImplementationOnce((_n, content) => {
			cloud.set(content)

			return response.promise
		})
		sync.executeNow()
		await tick()
		beginEditingSession(note.uuid)
		tabEditorChanged(note.uuid, "D+x")
		await sync.enqueue(note, "D+x", tabEditorBaseHash(note.uuid) ?? hashNoteContent("D"))

		expect(useNotesInflightStore.getState().inflightContent[note.uuid]?.[0]?.carriedFrom).toBe("old-page")

		response.resolve(note)
		await tick()
		handleNoteEvent(contentEdited("D", ME))
		sync.executeNow()
		await tick()

		expect(cloud.get()).toBe("D+x")
		expect(toast).not.toHaveBeenCalled()
	})

	async function pushOwnThenAnotherTabs(failFirst: boolean, loseEcho: boolean): Promise<void> {
		openNote()
		seedTabEditor(note.uuid, "a:1", "B0", "B0")

		const cloud = cloudOf("B0")
		const response = deferred<Note>()

		if (failFirst) {
			setNoteContent.mockImplementationOnce(() => Promise.reject(new Error("fetch failed")))
		}

		setNoteContent.mockImplementationOnce((_n, content) => {
			cloud.set(content)

			return response.promise
		})
		type("A")
		sync.executeNow()
		await tick()

		if (failFirst) {
			sync.executeNow()
			await tick()
		}

		response.resolve(note)
		await tick()

		expect(cloud.get()).toBe("A")

		if (!loseEcho) {
			handleNoteEvent(contentEdited("A", ME))
		}

		// Another tab of this browser types on A; this leader pushes it.
		sync.ingestRemoteEnqueue({
			note,
			content: "Q",
			timestamp: Date.now() + 5000,
			baseContentHash: hashNoteContent("A"),
			origin: "tab-T2"
		})
		sync.executeNow()
		await tick()

		expect(cloud.get()).toBe("Q")
	}

	it("a retried push is one record: its one echo leaves nothing to hold back another tab's later write", async () => {
		await pushOwnThenAnotherTabs(true, false)

		const key = remountKey()

		handleNoteEvent(contentEdited("Q", ME))

		expect(remountKey()).not.toBe(key)
		expect(queryClient.getQueryData(noteContentQueryKey(note.uuid))).toBe("Q")
	})

	it("a lost echo never holds back a write this tab did not make", async () => {
		await pushOwnThenAnotherTabs(false, true)

		const key = remountKey()

		handleNoteEvent(contentEdited("Q", ME))

		expect(remountKey()).not.toBe(key)
	})

	it("a follower promoted right after its push landed pushes its continuation without a false overwrite", async () => {
		openNote()
		sync.startAsFollower()
		type("A")

		const first = useNotesInflightStore.getState().inflightContent[note.uuid]?.[0]

		sync.heardLanded(note.uuid, hashNoteContent("A"), { origin: first?.origin ?? "", stamp: first?.timestamp ?? 0, landed: true })
		type("A+x")

		expect(useNotesInflightStore.getState().inflightContent[note.uuid]?.[0]?.baseContentHash).toBe(hashNoteContent("A"))

		const cloud = cloudOf("A")

		sync.promoteToLeader()
		await tick()
		await tick()

		expect(cloud.get()).toBe("A+x")
		expect(toast).not.toHaveBeenCalled()
	})
})

describe("notes — another tab's draft whose tab is gone", () => {
	async function pendingWaits(): Promise<string[]> {
		const snapshot = await navigator.locks.query()

		return (snapshot.pending ?? []).flatMap(lock => (lock.name?.startsWith("filen-web-notes-tab:") === true ? [lock.name] : []))
	}

	it("becomes an orphan once its tab closes, and the leader stops waiting once it drains", async () => {
		const closeF1 = liveTab("tab-F1")

		await tick()
		sync.ingestRemoteEnqueue({
			note,
			content: "old+mine",
			timestamp: Date.now(),
			baseContentHash: hashNoteContent("old"),
			origin: "tab-F1"
		})
		await tick()

		expect(useNotesInflightStore.getState().inflightContent[note.uuid]?.[0]?.orphan).toBeUndefined()
		expect(await pendingWaits()).toEqual(["filen-web-notes-tab:tab-F1"])

		closeF1()
		await tick()

		expect(useNotesInflightStore.getState().inflightContent[note.uuid]?.[0]?.orphan).toBe(true)
		expect(latestShowableContent(useNotesInflightStore.getState().inflightContent[note.uuid])).toBe("old+mine")
		expect(await pendingWaits()).toEqual([])
	})

	it("a live tab's wait is withdrawn when its entries drain", async () => {
		const closeF1 = liveTab("tab-F1")
		const withdrawn = vi.spyOn(AbortController.prototype, "abort")

		cloudOf("old")
		await tick()
		sync.ingestRemoteEnqueue({
			note,
			content: "old+mine",
			timestamp: Date.now(),
			baseContentHash: hashNoteContent("old"),
			origin: "tab-F1"
		})
		await tick()

		expect(await pendingWaits()).toEqual(["filen-web-notes-tab:tab-F1"])
		expect(withdrawn).not.toHaveBeenCalled()

		sync.executeNow()
		await tick()

		expect(queuedContents()).toBeUndefined()
		expect(withdrawn).toHaveBeenCalledTimes(1)
		closeF1()
	})

	it("typing over another tab's draft this tab never showed is based on that draft: its push warns", async () => {
		const closeF1 = liveTab("tab-F1")

		await tick()
		onlineManager.setOnline(false)
		sync.ingestRemoteEnqueue({
			note,
			content: "old+mine",
			timestamp: Date.now(),
			baseContentHash: hashNoteContent("old"),
			origin: "tab-F1"
		})
		openNote()
		type("old!")

		expect(useNotesInflightStore.getState().inflightContent[note.uuid]?.[0]?.baseContentHash).toBe(hashNoteContent("old+mine"))

		const cloud = cloudOf("old")

		onlineManager.setOnline(true)
		sync.executeNow()
		await tick()

		expect(cloud.get()).toBe("old!")
		expect(toast).toHaveBeenCalledWith("notes:noteOverwroteNewerRemoteChanges")
		closeF1()
	})

	it("an orphan under an editor on screen with nothing typed is taken: the editor seeds again, and says so", () => {
		openNote()
		sync.startAsFollower()
		sync.applyLeaderState({
			a: [{ timestamp: 1000, content: "old+L", note, baseContentHash: hashNoteContent("old"), origin: "tab-L" }]
		})

		expect(remountKey()).toBe(1)

		sync.applyLeaderState({
			a: [{ timestamp: 1000, content: "old+L", note, baseContentHash: hashNoteContent("old"), origin: "tab-L", orphan: true }]
		})

		// Seeded again, the content cache (what the cloud holds) untouched.
		expect(useNotesInflightStore.getState().editorReseeds[note.uuid]).toBe(1)
		expect(remountKey()).toBe(1)
		expect(queryClient.getQueryData(noteContentQueryKey(note.uuid))).toBe("old")
		expect(toast).toHaveBeenCalledExactlyOnceWith("notes:noteUpdatedElsewhere")
		expect(latestShowableContent(useNotesInflightStore.getState().inflightContent[note.uuid])).toBe("old+L")
	})

	it("an orphan under an editor with typing of its own asks", () => {
		openNote()
		sync.startAsFollower()
		sync.applyLeaderState({
			a: [{ timestamp: 1000, content: "old+L", note, baseContentHash: hashNoteContent("old"), origin: "tab-L" }]
		})
		beginEditingSession(note.uuid)
		tabEditorChanged(note.uuid, "old!")
		sync.applyLeaderState({
			a: [{ timestamp: 1000, content: "old+L", note, baseContentHash: hashNoteContent("old"), origin: "tab-L", orphan: true }]
		})

		// Asked with what the orphan was typed on: it never reached the cloud.
		expect(question()).toEqual({ theirs: "old+L", base: hashNoteContent("old") })
		expect(remountKey()).toBe(1)
	})
})

describe("notes — answering about an orphan draft", () => {
	async function askedAboutAnOrphan(): Promise<{ get: () => string; set: (content: string) => void }> {
		openNote()

		const cloud = cloudOf("old")

		onlineManager.setOnline(false)
		type("old!")

		const closeF = liveTab("tab-F")

		await tick()
		sync.ingestRemoteEnqueue({
			note,
			content: "old+f",
			timestamp: Date.now() + 5,
			baseContentHash: hashNoteContent("old"),
			origin: "tab-F"
		})
		await tick()
		closeF()
		await tick()

		expect(question()).toEqual({ theirs: "old+f", base: hashNoteContent("old") })

		onlineManager.setOnline(true)

		return cloud
	}

	it("Keep mine over it warns of no overwrite: the cloud never held it", async () => {
		const cloud = await askedAboutAnOrphan()

		await keepMineOverRemoteEdit(note)
		await tick()
		await tick()

		expect(cloud.get()).toBe("old!")
		expect(toast).not.toHaveBeenCalledWith("notes:noteOverwroteNewerRemoteChanges")
	})

	it("Load theirs of it warns of no overwrite", async () => {
		const cloud = await askedAboutAnOrphan()

		await reloadRemoteEdit(note)
		sync.executeNow()
		await tick()
		await tick()

		expect(cloud.get()).toBe("old+f")
		expect(toast).not.toHaveBeenCalledWith("notes:noteOverwroteNewerRemoteChanges")
	})

	it("a clean editor on a note never read is seeded again with a newer orphan, and says so", () => {
		useNotesRemoteEditStore.getState().setOpenNote(note.uuid)
		sync.startAsFollower()
		sync.applyLeaderState({
			a: [{ timestamp: 1000, content: "O1", note, baseContentHash: hashNoteContent(""), origin: "tab-X", orphan: true }]
		})
		seedTabEditor(note.uuid, "a:0", "O1", undefined)
		sync.applyLeaderState({
			a: [{ timestamp: 2000, content: "O1+y", note, baseContentHash: hashNoteContent(""), origin: "tab-Y", orphan: true }]
		})

		expect(queryClient.getQueryData(noteContentQueryKey(note.uuid))).toBeUndefined()
		expect(useNotesInflightStore.getState().editorReseeds[note.uuid]).toBe(1)
		expect(toast).toHaveBeenCalledExactlyOnceWith("notes:noteUpdatedElsewhere")
	})
})
