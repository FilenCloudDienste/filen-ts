// @vitest-environment happy-dom

// Request counts for a note's content against a REAL QueryClient, with the SDK boundary
// (getNoteContent) spied: the note editor's content query mounted the way components/content mounts it
// (staleTime Infinity), closed and reopened across remote edits, list changes, socket gaps and local
// writes.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const sdk = vi.hoisted(() => ({
	getNoteContent: vi.fn()
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: async () => ({ authedSdkClient: sdk })
	}
}))

// The real TanStack client with the app's refetch defaults, minus the SQLite persister. queryUpdater
// honours an explicit dataUpdatedAt and otherwise restamps, like the real one.
vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	const DEFAULT_QUERY_OPTIONS = {
		refetchOnMount: "always",
		refetchOnReconnect: "always",
		staleTime: 0,
		retry: false,
		networkMode: "offlineFirst"
	} as const

	const queryClient = new QueryClient({
		defaultOptions: {
			queries: DEFAULT_QUERY_OPTIONS
		}
	})

	return {
		default: queryClient,
		DEFAULT_QUERY_OPTIONS,
		queryUpdater: {
			get: (queryKey: unknown[]) => queryClient.getQueryData(queryKey),
			set: (queryKey: unknown[], updater: unknown, dataUpdatedAt?: number) =>
				queryClient.setQueryData(
					queryKey,
					(prev: unknown) => (typeof updater === "function" ? (updater as (p: unknown) => unknown)(prev) : updater),
					{ updatedAt: typeof dataUpdatedAt === "number" ? dataUpdatedAt : Date.now() }
				)
		}
	}
})

import { renderHook, waitFor, cleanup } from "@testing-library/react"
import { QueryClientProvider } from "@tanstack/react-query"
import { createElement, type ReactNode } from "react"
import queryClient from "@/queries/client"
import useSocketStore from "@/stores/useSocket.store"
import { notesQueryUpdate } from "@/features/notes/queries/useNotesQuery"
import useNoteContentQuery, {
	noteContentQueryKey,
	noteContentQueryUpdate,
	noteContentRemoteEditSeen,
	noteContentReadIsCurrent
} from "@/features/notes/queries/useNoteContent.query"
import type { Note } from "@/types"

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient }, children)
}

// components/content's call, minus the offline/inflight gates (both true here).
function openNote(uuid: string) {
	return renderHook(() => useNoteContentQuery({ uuid }, { enabled: true, staleTime: Infinity }), { wrapper })
}

async function openAndClose(uuid: string, undecryptable = false): Promise<void> {
	const screen = openNote(uuid)

	await waitFor(() => expect(screen.result.current.isFetching).toBe(false))
	expect(screen.result.current.data).toBe(undecryptable ? undefined : "body")

	screen.unmount()
}

// Lets a mount-triggered fetch (async getSdkClients hop included) reach the SDK before asserting none did.
async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 20))
}

function note(uuid: string, editedTimestamp: bigint): Note {
	return { uuid, editedTimestamp, undecryptable: false } as unknown as Note
}

// Every test gets its own uuid: the read memory is module state, as it is per app session.
let uuidCounter = 0
let uuid = ""
let now = 1_000_000_000_000

function connectSocket(): void {
	useSocketStore.getState().setState("disconnected")
	useSocketStore.getState().setState("connected")
}

beforeEach(() => {
	queryClient.clear()
	uuid = `note-${++uuidCounter}`
	now += 60 * 60 * 1000
	vi.useFakeTimers({ toFake: ["Date"] })
	vi.setSystemTime(now)
	connectSocket()
	vi.setSystemTime(now + 1000)
	notesQueryUpdate({ updater: [note(uuid, 100n)] })
	sdk.getNoteContent.mockReset()
	sdk.getNoteContent.mockResolvedValue("body")
})

// No vitest globals, so testing-library's auto-cleanup never runs: unmount observers explicitly.
afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe("note content reopen request counts", () => {
	it("open, close and reopen with nothing changed: 1 read (was 1 per open)", async () => {
		await openAndClose(uuid)
		await openAndClose(uuid)
		await openAndClose(uuid)

		expect(sdk.getNoteContent).toHaveBeenCalledTimes(1)
	})

	it("the listed edit stamp moved: re-reads", async () => {
		await openAndClose(uuid)

		notesQueryUpdate({ updater: [note(uuid, 200n)] })

		await openAndClose(uuid)

		expect(sdk.getNoteContent).toHaveBeenCalledTimes(2)
	})

	it("a remote edit announced while open (reload prompt dismissed) or closed: re-reads", async () => {
		await openAndClose(uuid)

		noteContentRemoteEditSeen(uuid)

		await openAndClose(uuid)
		await openAndClose(uuid)

		expect(sdk.getNoteContent).toHaveBeenCalledTimes(2)
	})

	it("a remote edit announced during the read itself: the next open re-reads", async () => {
		let resolve: (value: string) => void = () => {}

		sdk.getNoteContent.mockImplementationOnce(() => new Promise<string>(r => (resolve = r)))

		const screen = openNote(uuid)

		await waitFor(() => expect(sdk.getNoteContent).toHaveBeenCalledTimes(1))

		noteContentRemoteEditSeen(uuid)
		resolve("body")

		await waitFor(() => expect(screen.result.current.data).toBe("body"))

		screen.unmount()

		await openAndClose(uuid)

		expect(sdk.getNoteContent).toHaveBeenCalledTimes(2)
	})

	it("a background/foreground cycle (socket torn down and reconnected): re-reads", async () => {
		await openAndClose(uuid)

		vi.setSystemTime(now + 5000)
		connectSocket()

		await openAndClose(uuid)

		expect(sdk.getNoteContent).toHaveBeenCalledTimes(2)
	})

	it("socket not connected at reopen: re-reads", async () => {
		await openAndClose(uuid)

		useSocketStore.getState().setState("reconnecting")

		await openAndClose(uuid)

		expect(sdk.getNoteContent).toHaveBeenCalledTimes(2)
	})

	it("a body restored from disk (no read this session): the first open reads, the next does not", async () => {
		queryClient.setQueryData(noteContentQueryKey({ uuid }), "persisted", { updatedAt: now - 1000 })

		await openAndClose(uuid)
		await openAndClose(uuid)

		expect(sdk.getNoteContent).toHaveBeenCalledTimes(1)
	})

	it("a local write restamps dataUpdatedAt; the trust rule ignores that stamp and the reopen shows the written body", async () => {
		await openAndClose(uuid)

		// components/sync's post-push truth write.
		noteContentQueryUpdate({ params: { uuid }, updater: "typed locally" })

		const screen = openNote(uuid)

		await settle()

		expect(screen.result.current.data).toBe("typed locally")
		expect(sdk.getNoteContent).toHaveBeenCalledTimes(1)
	})

	it("an undecryptable body (undefined) is never trusted: every open reads", async () => {
		sdk.getNoteContent.mockResolvedValue(undefined)

		await openAndClose(uuid, true)
		await openAndClose(uuid, true)

		expect(sdk.getNoteContent).toHaveBeenCalledTimes(2)
	})

	it("an invalidation still wins over a current read", async () => {
		await openAndClose(uuid)

		await queryClient.invalidateQueries({ queryKey: noteContentQueryKey({ uuid }), refetchType: "none" })

		await openAndClose(uuid)

		expect(sdk.getNoteContent).toHaveBeenCalledTimes(2)
	})
})

describe("noteContentReadIsCurrent", () => {
	it("is false for a uuid never read this session", () => {
		expect(noteContentReadIsCurrent("never-read", { data: "x", status: "success" })).toBe(false)
	})

	it("is false after a failed refetch even with a body in hand", async () => {
		await openAndClose(uuid)

		expect(noteContentReadIsCurrent(uuid, { data: "body", status: "success" })).toBe(true)
		expect(noteContentReadIsCurrent(uuid, { data: "body", status: "error" })).toBe(false)
	})

	it("is false once the note left the list", async () => {
		await openAndClose(uuid)

		notesQueryUpdate({ updater: [] })

		expect(noteContentReadIsCurrent(uuid, { data: "body", status: "success" })).toBe(false)
	})
})
