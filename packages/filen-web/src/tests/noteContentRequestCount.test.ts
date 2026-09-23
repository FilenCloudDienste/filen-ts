// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Note, SocketEvent, UuidStr } from "@filen/sdk-rs"

const { getNoteContent } = vi.hoisted(() => ({ getNoteContent: vi.fn<(note: Note) => Promise<string | undefined>>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getNoteContent } }))

// The production defaults minus the persister (sqlite, unavailable under vitest).
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({
		defaultOptions: {
			queries: { staleTime: 0, gcTime: Infinity, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true }
		}
	})
}))

// The outbox singleton only matters to the reload action, which these tests never take.
vi.mock("@/features/notes/lib/sync", () => ({ sync: {} }))

vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { NOTES_QUERY_KEY } from "@/features/notes/queries/notes"
import { noteContentQueryKey, useNoteContentQuery } from "@/features/notes/queries/noteContent"
import { handleNoteEvent } from "@/features/notes/lib/socketHandlers"
import { socketAuthenticated, socketDropped } from "@/lib/sdk/socketSession"

const USER_ID = 7n

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockNote(label: string): Note {
	return {
		uuid: testUuid(label),
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		title: label,
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: []
	}
}

const NOTES = [mockNote("a"), mockNote("b"), mockNote("c")]
const [NOTE_A] = NOTES as [Note, Note, Note]

function contentEdited(note: Note, editorId: number): Extract<SocketEvent, { type: "note" }> {
	return {
		type: "note",
		inner: {
			type: "contentEdited",
			note: note.uuid,
			content: { Decrypted: "remote" },
			noteType: "text",
			editorId,
			editedTimestamp: 1n
		},
		noteMessageId: 0n
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient, children })
}

async function drain(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 10; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
	await waitFor(() => {
		expect(queryClient.isFetching()).toBe(0)
	})
}

// The editor pane keys its content body on the note uuid, so every switch is a fresh mount.
async function visit(note: Note): Promise<void> {
	const { unmount } = renderHook(() => useNoteContentQuery(note), { wrapper })
	await drain()
	unmount()
}

beforeEach(() => {
	queryClient.clear()
	// A fresh epoch retires every read an earlier test recorded.
	socketAuthenticated()
	queryClient.setQueryData(ACCOUNT_QUERY_KEY, { id: USER_ID })
	queryClient.setQueryData(NOTES_QUERY_KEY, NOTES)
	getNoteContent.mockReset()
	getNoteContent.mockImplementation(note => Promise.resolve(`body ${note.uuid}`))
})

describe("note content request counts", () => {
	it("the first open after boot reads, even over content restored from disk", async () => {
		queryClient.setQueryData(noteContentQueryKey(NOTE_A.uuid), "persisted")

		await visit(NOTE_A)

		expect(getNoteContent).toHaveBeenCalledTimes(1)
		expect(queryClient.getQueryData(noteContentQueryKey(NOTE_A.uuid))).toBe(`body ${NOTE_A.uuid}`)
	})

	it("reopening an unedited note reuses its content", async () => {
		for (let i = 0; i < 4; i++) {
			await visit(NOTE_A)
		}

		expect(getNoteContent).toHaveBeenCalledTimes(1)
	})

	it("flipping between three notes reads each once", async () => {
		for (let round = 0; round < 5; round++) {
			for (const note of NOTES) {
				await visit(note)
			}
		}

		expect(getNoteContent).toHaveBeenCalledTimes(NOTES.length)
	})

	it("reopening after another user's content edit reads again", async () => {
		await visit(NOTE_A)

		act(() => {
			handleNoteEvent(contentEdited(NOTE_A, 99))
		})
		await visit(NOTE_A)
		await visit(NOTE_A)

		expect(getNoteContent).toHaveBeenCalledTimes(2)
	})

	it("an edit on the user's own other device (an echo by userId) still makes the reopen read", async () => {
		await visit(NOTE_A)

		act(() => {
			handleNoteEvent(contentEdited(NOTE_A, Number(USER_ID)))
		})
		await visit(NOTE_A)

		expect(getNoteContent).toHaveBeenCalledTimes(2)
	})

	it("a content edit for another note leaves this one cached", async () => {
		await visit(NOTE_A)

		act(() => {
			handleNoteEvent(contentEdited(mockNote("b"), 99))
		})
		await visit(NOTE_A)

		expect(getNoteContent).toHaveBeenCalledTimes(1)
	})

	it("reopening after a socket drop reads again, with or without the reconnect", async () => {
		await visit(NOTE_A)

		socketDropped()
		await visit(NOTE_A)

		socketAuthenticated()
		await visit(NOTE_A)
		await visit(NOTE_A)

		expect(getNoteContent).toHaveBeenCalledTimes(3)
	})

	it("a read taken before the socket authenticates doesn't count", async () => {
		socketDropped()
		await visit(NOTE_A)

		socketAuthenticated()
		await visit(NOTE_A)
		await visit(NOTE_A)

		expect(getNoteContent).toHaveBeenCalledTimes(2)
	})

	it("a read a content edit raced doesn't count", async () => {
		const read = deferred<string>()
		getNoteContent.mockImplementationOnce(() => read.promise)

		const { unmount } = renderHook(() => useNoteContentQuery(NOTE_A), { wrapper })
		await act(async () => {
			await Promise.resolve()
		})

		// The echo branch: nothing invalidates, so only the race check keeps this read from counting.
		act(() => {
			handleNoteEvent(contentEdited(NOTE_A, Number(USER_ID)))
		})
		read.resolve("pre-edit")
		await drain()
		unmount()

		await visit(NOTE_A)

		expect(getNoteContent).toHaveBeenCalledTimes(2)
	})

	it("a cancelled read doesn't count", async () => {
		queryClient.setQueryData(noteContentQueryKey(NOTE_A.uuid), "persisted")
		const read = deferred<string>()
		getNoteContent.mockImplementationOnce(() => read.promise)

		const { unmount } = renderHook(() => useNoteContentQuery(NOTE_A), { wrapper })
		await act(async () => {
			await Promise.resolve()
		})

		await act(async () => {
			await queryClient.cancelQueries({ queryKey: noteContentQueryKey(NOTE_A.uuid), exact: true })
		})
		read.resolve("fresh")
		await drain()
		unmount()

		expect(queryClient.getQueryData(noteContentQueryKey(NOTE_A.uuid))).toBe("persisted")

		await visit(NOTE_A)

		expect(getNoteContent).toHaveBeenCalledTimes(2)
	})
})
