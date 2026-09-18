// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Note } from "@filen/sdk-rs"

// The editing session is what keeps the content query — and so the editor's remount key — frozen while
// the user types. Two halves are only assertable through a real render: the first keystroke OPENS the
// session (and cancels the fetch that `enabled: false` alone would leave running, which would otherwise
// land, advance dataUpdatedAt and remount the editor mid-word), and the unmount CLOSES it.

const { getNoteContent } = vi.hoisted(() => ({ getNoteContent: vi.fn<() => Promise<string | undefined>>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getNoteContent } }))
// The outbox is a disk-backed loop; onChange only needs its enqueue to resolve.
vi.mock("@/features/notes/lib/sync", () => ({ sync: { enqueue: vi.fn(() => Promise.resolve(true)), cancel: vi.fn() } }))

// The app's singleton IS the client behind <QueryClientProvider> (routes/__root.tsx), so the hook's
// cancel and its own query must run against ONE client here too — the bare client below stands in for
// it, keeping the real singleton's OPFS persistence pipeline out of the test.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }))

import "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { useNotesInflightStore } from "@/features/notes/store/useNotesInflight"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { useNoteEditor } from "@/features/notes/hooks/useNoteEditor"

const NOTE: Note = {
	uuid: "22222222-2222-2222-2222-222222222222",
	ownerId: 1n,
	trash: false,
	archive: false,
	favorite: false,
	pinned: false,
	tags: [],
	type: "text",
	participants: [],
	title: { Decrypted: "Recipe" },
	preview: { Decrypted: "" },
	editedTimestamp: 1_700_000_000_000n,
	createdTimestamp: 1_700_000_000_000n
} as unknown as Note

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient, children })
}

// A content read that never settles, so the mount refetch (refetchOnMount: "always") is STILL RUNNING
// when the first keystroke lands — exactly the state the cancel on the session's opening edge exists for,
// and the one `enabled: false` alone cannot end.
function neverSettles(): Promise<string> {
	return new Promise<string>(() => undefined)
}

beforeEach(() => {
	vi.clearAllMocks()
	getNoteContent.mockReturnValue(neverSettles())
	useNotesInflightStore.setState({ inflightContent: {}, editingSessions: {}, outboxHydrated: true })
})

describe("useNoteEditor — editing session lifecycle", () => {
	it("opens the session on the first change and cancels the in-flight content read on that edge", () => {
		const cancelQueries = vi.spyOn(queryClient, "cancelQueries")
		const { result, unmount } = renderHook(() => useNoteEditor(NOTE, 1n), { wrapper })

		act(() => {
			result.current.onChange("x")
		})

		expect(useNotesInflightStore.getState().editingSessions[NOTE.uuid]).toBe(true)
		expect(cancelQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: noteContentQueryKey(NOTE.uuid), exact: true })

		// Every later keystroke is inside the same session: no second cancel, no store churn.
		act(() => {
			result.current.onChange("xy")
		})

		expect(cancelQueries).toHaveBeenCalledTimes(1)

		unmount()
	})

	it("ends the session when the editor unmounts (switching notes, leaving the route)", () => {
		const { result, unmount } = renderHook(() => useNoteEditor(NOTE, 1n), { wrapper })

		act(() => {
			result.current.onChange("x")
		})

		expect(useNotesInflightStore.getState().editingSessions[NOTE.uuid]).toBe(true)

		unmount()

		expect(useNotesInflightStore.getState().editingSessions[NOTE.uuid]).toBeUndefined()
	})
})
