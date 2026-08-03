// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Note } from "@filen/sdk-rs"

// The sentinel (notesQueries.test.ts) and the state machine's "undecryptable" arm (notesEditorLogic.test.ts)
// are both pinned; the ONE line that connects them is not. Without it the editor shows a raw fetch error
// for a note whose ciphertext simply never decrypted for this account, and the explainer arm is dead code.

const { getNoteContent } = vi.hoisted(() => ({ getNoteContent: vi.fn<() => Promise<string | undefined>>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getNoteContent } }))
// The outbox is a disk-backed loop; the editor only reads its hydration/inflight view here.
vi.mock("@/features/notes/lib/sync", () => ({ sync: { enqueue: vi.fn(() => Promise.resolve(true)), cancel: vi.fn() } }))

import "@/lib/i18n"
import { useNotesInflightStore } from "@/features/notes/store/useNotesInflight"
import { useNoteEditor } from "@/features/notes/hooks/useNoteEditor"

const NOTE: Note = {
	uuid: "11111111-1111-1111-1111-111111111111",
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
	// retry off: an error state is the subject here, and the default 3 retries would only slow it down.
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

	return createElement(QueryClientProvider, { client, children })
}

beforeEach(() => {
	vi.clearAllMocks()
	useNotesInflightStore.setState({ inflightContent: {}, outboxHydrated: true })
})

describe("useNoteEditor — undecryptable content", () => {
	// getNoteContent resolves undefined for exactly one reason: the content ciphertext did not decrypt.
	it("routes an undecryptable note to the explainer state, not the generic error", async () => {
		getNoteContent.mockResolvedValue(undefined)

		const { result } = renderHook(() => useNoteEditor(NOTE, 1n), { wrapper })

		await waitFor(() => {
			expect(result.current.status).toBe("undecryptable")
		})
	})

	it("keeps a genuine fetch failure on the error state, with its DTO", async () => {
		getNoteContent.mockRejectedValue(new Error("network down"))

		const { result } = renderHook(() => useNoteEditor(NOTE, 1n), { wrapper })

		await waitFor(() => {
			expect(result.current.status).toBe("error")
		})

		expect(result.current.errorDto?.message).toContain("network down")
	})

	it("a note that decrypts is ready, with its content as the mount seed", async () => {
		getNoteContent.mockResolvedValue("soup")

		const { result } = renderHook(() => useNoteEditor(NOTE, 1n), { wrapper })

		await waitFor(() => {
			expect(result.current.status).toBe("ready")
		})

		expect(result.current.seed).toBe("soup")
	})
})
