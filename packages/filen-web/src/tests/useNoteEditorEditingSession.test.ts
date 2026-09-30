// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Note } from "@filen/sdk-rs"

// The editing session is what keeps the content query — and so the editor's remount key — frozen while
// the user types. Two halves are only assertable through a real render: the first keystroke OPENS the
// session (and cancels the fetch that `enabled: false` alone would leave running, which would otherwise
// land, advance dataUpdatedAt and remount the editor mid-word), and the unmount CLOSES it.

const { getNoteContent } = vi.hoisted(() => ({ getNoteContent: vi.fn<() => Promise<string | undefined>>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getNoteContent } }))
// The outbox is a disk-backed loop; onChange only needs its enqueue to resolve.
const { enqueue } = vi.hoisted(() => ({
	enqueue: vi.fn<(note: Note, content: string, sessionBaseHash?: string | null) => Promise<boolean>>(() => Promise.resolve(true))
}))

vi.mock("@/features/notes/lib/sync", () => ({ sync: { enqueue, cancel: vi.fn() } }))

// The app's singleton IS the client behind <QueryClientProvider> (routes/__root.tsx), so the hook's
// cancel and its own query must run against ONE client here too — the bare client below stands in for
// it, keeping the real singleton's OPFS persistence pipeline out of the test.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }))

import "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { TAB_ID, useNotesInflightStore } from "@/features/notes/store/useNotesInflight"
import { noteContentQueryKey } from "@/features/notes/queries/noteContent"
import { useNoteEditor } from "@/features/notes/hooks/useNoteEditor"
import { forgetTabEditors, tabEditorBuffer, tabEditorDirty, tabEditorLanded } from "@/features/notes/lib/tabEditors"
import { hashNoteContent } from "@filen/shared"

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
		const { result, unmount } = renderHook(() => useNoteEditor(NOTE, 1n), { wrapper })
		const query = queryClient.getQueryCache().find({ queryKey: noteContentQueryKey(NOTE.uuid), exact: true })

		if (query === undefined) {
			throw new Error("content query not mounted")
		}

		expect(query.state.fetchStatus).toBe("fetching")

		const cancel = vi.spyOn(query, "cancel")

		act(() => {
			result.current.onChange("x")
		})

		expect(useNotesInflightStore.getState().editingSessions[NOTE.uuid]).toBe(true)
		expect(cancel).toHaveBeenCalledExactlyOnceWith({ revert: true })
		expect(query.state.fetchStatus).toBe("idle")

		// Every later keystroke is inside the same session: no second cancel, no store churn.
		act(() => {
			result.current.onChange("xy")
		})

		expect(cancel).toHaveBeenCalledTimes(1)

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

// This tab's editor, told apart from other tabs' edits in the shared outbox (tabEditors.ts).
describe("useNoteEditor — what this tab's editor shows", () => {
	beforeEach(() => {
		forgetTabEditors()
		queryClient.clear()
	})

	it("records its seed once shown, its typing, and forgets it on unmount", async () => {
		getNoteContent.mockResolvedValue("seed")

		const { result, unmount } = renderHook(() => useNoteEditor(NOTE, 1n), { wrapper })

		await waitFor(() => {
			expect(result.current.status).toBe("ready")
		})

		expect(tabEditorBuffer(NOTE.uuid)).toBe("seed")
		expect(tabEditorDirty(NOTE.uuid)).toBe(false)

		act(() => {
			result.current.onChange("seed, typed")
		})

		expect(tabEditorDirty(NOTE.uuid)).toBe(true)

		unmount()

		expect(tabEditorBuffer(NOTE.uuid)).toBeUndefined()
	})

	it("bases a new session on this tab's own pushed text, which a follower's cache may not hold yet", async () => {
		getNoteContent.mockResolvedValue("seed")

		const { result, unmount } = renderHook(() => useNoteEditor(NOTE, 1n), { wrapper })

		await waitFor(() => {
			expect(result.current.status).toBe("ready")
		})

		act(() => {
			result.current.onChange("mine")
		})

		tabEditorLanded(NOTE.uuid, hashNoteContent("mine"), 1, undefined)

		act(() => {
			result.current.onChange("mine, more")
		})

		expect(enqueue).toHaveBeenLastCalledWith(NOTE, "mine, more", hashNoteContent("mine"))

		unmount()
	})
})

describe("useNoteEditor — which queued entries it shows", () => {
	beforeEach(() => {
		forgetTabEditors()
		queryClient.clear()
	})

	it("loads and shows the note, not another live tab's queued draft", async () => {
		getNoteContent.mockResolvedValue("cloud")
		useNotesInflightStore.setState({
			inflightContent: { [NOTE.uuid]: [{ timestamp: 1, content: "another tab's draft", note: NOTE, origin: "tab-T2" }] }
		})

		const { result, unmount } = renderHook(() => useNoteEditor(NOTE, 1n), { wrapper })

		await waitFor(() => {
			expect(result.current.status).toBe("ready")
		})

		expect(result.current.seed).toBe("cloud")
		unmount()
	})

	it("shows its own queued typing, and an orphan draft", () => {
		for (const origin of [TAB_ID, undefined]) {
			useNotesInflightStore.setState({
				inflightContent: {
					[NOTE.uuid]: [
						origin === undefined
							? { timestamp: 1, content: "draft", note: NOTE, origin: "closed", orphan: true }
							: { timestamp: 1, content: "draft", note: NOTE, origin }
					]
				}
			})

			const { result, unmount } = renderHook(() => useNoteEditor(NOTE, 1n), { wrapper })

			expect(result.current.status).toBe("ready")
			expect(result.current.seed).toBe("draft")
			unmount()
		}
	})
})
