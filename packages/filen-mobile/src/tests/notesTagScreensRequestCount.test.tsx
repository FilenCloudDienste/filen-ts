// @vitest-environment happy-dom

// Request counts for the notes and tags listings against a REAL QueryClient, with the SDK boundary
// (listNotes / listNoteTags) spied: the root notes tab, a tag drill-down pushed over it, and the Manage
// Tags screen, each mounted the way its component mounts the hooks.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const sdk = vi.hoisted(() => ({
	listNotes: vi.fn(),
	listNoteTags: vi.fn()
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: async () => ({ authedSdkClient: sdk })
	}
}))

// The real TanStack client with the app's refetch defaults and server-read tracking, minus the SQLite
// persister.
vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")
	const { trackServerReads } = await import("@/queries/socketSession")

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

	trackServerReads(queryClient.getQueryCache())

	return {
		default: queryClient,
		DEFAULT_QUERY_OPTIONS,
		queryUpdater: {
			get: (queryKey: unknown[]) => queryClient.getQueryData(queryKey),
			set: (queryKey: unknown[], updater: unknown) =>
				queryClient.setQueryData(queryKey, (prev: unknown) =>
					typeof updater === "function" ? (updater as (p: unknown) => unknown)(prev) : updater
				)
		}
	}
})

import { renderHook, waitFor, cleanup } from "@testing-library/react"
import { QueryClientProvider } from "@tanstack/react-query"
import { createElement, type ReactNode } from "react"
import queryClient from "@/queries/client"
import useNotesQuery, {
	reuseRecentNotesRead,
	notesQueryUpdate,
	fetchData as notesQueryFetch,
	NOTES_REUSE_WINDOW_MS
} from "@/features/notes/queries/useNotesQuery"
import useNotesTagsQuery, { reuseRecentNotesTagsRead } from "@/features/notes/queries/useNotesTags.query"
import useSocketStore from "@/stores/useSocket.store"

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient }, children)
}

// <Notes/> as the root tab (no tagUuid) and as the /notesTags drill-down (tagUuid set).
function mountNotesScreen(tagUuid?: string) {
	return renderHook(
		() => ({
			notes: useNotesQuery(tagUuid ? reuseRecentNotesRead : undefined),
			tags: useNotesTagsQuery(tagUuid ? reuseRecentNotesTagsRead : undefined)
		}),
		{ wrapper }
	)
}

function mountManageTags() {
	return renderHook(() => useNotesTagsQuery(reuseRecentNotesTagsRead), { wrapper })
}

// Lets a mount-triggered fetch (async getSdkClients hop included) reach the SDK before asserting none did.
async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 20))
}

let now = 1_000_000_000_000

// A socket (re)connect at the current time: reads from before it may have missed events.
function reconnectSocket(): void {
	useSocketStore.getState().setState("disconnected")
	useSocketStore.getState().setState("connected")
}

beforeEach(() => {
	queryClient.clear()
	now += 10 * NOTES_REUSE_WINDOW_MS
	vi.useFakeTimers({ toFake: ["Date"] })
	vi.setSystemTime(now)
	reconnectSocket()
	sdk.listNotes.mockReset()
	sdk.listNoteTags.mockReset()
	sdk.listNotes.mockResolvedValue([{ uuid: "n1", encryptionKey: "k" }])
	sdk.listNoteTags.mockResolvedValue([{ uuid: "t1", name: "work" }])
})

// No vitest globals, so testing-library's auto-cleanup never runs: unmount observers explicitly.
afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

async function mountRootTab() {
	const root = mountNotesScreen()

	await waitFor(() => expect(root.result.current.tags.data).toHaveLength(1))
	await waitFor(() => expect(root.result.current.notes.data).toHaveLength(1))

	return root
}

describe("notes tag screens request counts", () => {
	it("tag chips tapped within the window over the root tab read nothing (was 2 per tap)", async () => {
		await mountRootTab()

		for (const tag of ["t1", "t2", "t1"]) {
			const drill = mountNotesScreen(tag)

			await settle()

			expect(drill.result.current.notes.data).toHaveLength(1)
			drill.unmount()
		}

		expect(sdk.listNotes).toHaveBeenCalledTimes(1)
		expect(sdk.listNoteTags).toHaveBeenCalledTimes(1)
	})

	it("a tag chip tapped after the window re-reads both, as before", async () => {
		await mountRootTab()

		vi.setSystemTime(now + NOTES_REUSE_WINDOW_MS + 1)

		mountNotesScreen("t1")

		await waitFor(() => expect(sdk.listNotes).toHaveBeenCalledTimes(2))
		await waitFor(() => expect(sdk.listNoteTags).toHaveBeenCalledTimes(2))
	})

	it("local and socket patches do not count as a server read", async () => {
		await mountRootTab()

		vi.setSystemTime(now + NOTES_REUSE_WINDOW_MS + 1)

		// Restamps dataUpdatedAt, yet pins/tags from other devices are still as old as the last read.
		notesQueryUpdate({ updater: prev => prev })

		mountNotesScreen("t1")

		await waitFor(() => expect(sdk.listNotes).toHaveBeenCalledTimes(2))
	})

	it("a listing read that never reaches the cache (the offline pass, the boot reconcile) does not count", async () => {
		await mountRootTab()

		vi.setSystemTime(now + NOTES_REUSE_WINDOW_MS + 1)

		await notesQueryFetch()

		mountNotesScreen("t1")

		await waitFor(() => expect(sdk.listNotes).toHaveBeenCalledTimes(3))
	})

	it("a read from before a socket reconnect (a background drops events) is not reused, even inside the window", async () => {
		await mountRootTab()

		vi.setSystemTime(now + 1000)
		reconnectSocket()

		mountNotesScreen("t1")

		await waitFor(() => expect(sdk.listNotes).toHaveBeenCalledTimes(2))
	})

	it("a drill-down with nothing cached reads each listing once", async () => {
		const drill = mountNotesScreen("t1")

		await waitFor(() => expect(drill.result.current.notes.data).toHaveLength(1))
		await waitFor(() => expect(drill.result.current.tags.data).toHaveLength(1))

		expect(sdk.listNotes).toHaveBeenCalledTimes(1)
		expect(sdk.listNoteTags).toHaveBeenCalledTimes(1)
	})

	it("the root tab keeps reading on every mount", async () => {
		const root = await mountRootTab()

		root.unmount()

		await mountRootTab()

		expect(sdk.listNotes).toHaveBeenCalledTimes(2)
		expect(sdk.listNoteTags).toHaveBeenCalledTimes(2)
	})

	it("pull-to-refresh on a drill-down still reads inside the window", async () => {
		await mountRootTab()

		const drill = mountNotesScreen("t1")

		await Promise.all([drill.result.current.notes.refetch(), drill.result.current.tags.refetch()])

		expect(sdk.listNotes).toHaveBeenCalledTimes(2)
		expect(sdk.listNoteTags).toHaveBeenCalledTimes(2)
	})
})

describe("Manage Tags request counts", () => {
	it("opened within the window over the list reads nothing (was 1 per open)", async () => {
		await mountRootTab()

		mountManageTags().unmount()
		mountManageTags()

		await settle()

		expect(sdk.listNoteTags).toHaveBeenCalledTimes(1)
	})

	it("opened after the window re-reads the tags, as before", async () => {
		await mountRootTab()

		vi.setSystemTime(now + NOTES_REUSE_WINDOW_MS + 1)

		mountManageTags()

		await waitFor(() => expect(sdk.listNoteTags).toHaveBeenCalledTimes(2))
	})

	it("opened with nothing cached reads the tags once", async () => {
		const screen = mountManageTags()

		await waitFor(() => expect(screen.result.current.data).toHaveLength(1))

		expect(sdk.listNoteTags).toHaveBeenCalledTimes(1)
		expect(sdk.listNotes).not.toHaveBeenCalled()
	})
})
