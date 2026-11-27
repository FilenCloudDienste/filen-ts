// @vitest-environment jsdom

// The notes sidebar's search fallback: "No results" only once every candidate body was searched; a body
// still being read shows a searching notice, and one that could not be read says it was not searched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"

const { searchCounts } = vi.hoisted(() => ({ searchCounts: { pending: 0, failed: 0 } }))

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }) }))
vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	return { queryClient: new QueryClient() }
})
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(() => Promise.resolve()),
	useRouter: () => ({ state: { location: { pathname: "/notes" } } }),
	useRouterState: () => "/notes"
}))
vi.mock("@/features/notes/queries/notes", async () => {
	const { mockNote } = await import("@/tests/fixtures/notes")
	const { testUuid } = await import("@/tests/support/uuid")
	const data = [mockNote({ uuid: testUuid("a"), title: "Groceries", preview: "milk" })]

	return { useNotes: () => ({ isPending: false, isError: false, data }) }
})
vi.mock("@/features/notes/queries/noteTags", () => ({ useNoteTags: () => ({ isPending: false, isError: false, data: [] }) }))
vi.mock("@/features/notes/queries/preferences", () => ({
	useNotesViewModeQuery: () => ({ data: "notes" }),
	useNoteTagsSortByQuery: () => ({ data: undefined })
}))
vi.mock("@/queries/account", () => ({ useAccountQuery: () => ({ data: { id: 1n } }) }))
vi.mock("@/features/notes/hooks/useNoteDialogHost", () => ({
	useNoteDialogHost: () => ({
		openNoteDialog: vi.fn(),
		openTagDialog: vi.fn(),
		openBulkDialog: vi.fn(),
		openCreateTagDialog: vi.fn(),
		renderActiveDialog: () => null
	})
}))
vi.mock("@/features/notes/hooks/useNoteSearch", () => ({
	useNoteSearch: () => ({ hits: { body: new Map(), indexed: new Set() }, pending: searchCounts.pending, failed: searchCounts.failed })
}))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	storage: () => new Promise(() => undefined),
	isMissingStorageMethod: () => false
}))

const { NotesSidebar } = await import("@/features/notes/components/notesSidebar")
const { queryClient } = await import("@/queries/client")
const { QueryClientProvider } = await import("@tanstack/react-query")
const { registerAllActions } = await import("@/lib/keymap/actions")

registerAllActions()

function renderSearching(term: string): void {
	render(
		<QueryClientProvider client={queryClient}>
			<NotesSidebar />
		</QueryClientProvider>
	)
	fireEvent.change(screen.getByPlaceholderText("Search notes"), { target: { value: term } })
}

beforeEach(() => {
	searchCounts.pending = 0
	searchCounts.failed = 0
})

afterEach(() => {
	cleanup()
})

describe("notes sidebar search fallback", () => {
	it("shows the searching notice, not No results, while a candidate body is being read", () => {
		searchCounts.pending = 1
		renderSearching("zzz")

		expect(screen.getByText("Searching notes…")).toBeDefined()
		expect(screen.queryByText("No results")).toBeNull()
	})

	it("says how many notes could not be searched when a body read failed or is paused", () => {
		searchCounts.failed = 2
		renderSearching("zzz")

		expect(screen.getByText("No results")).toBeDefined()
		expect(screen.getByText("2 notes couldn't be searched.")).toBeDefined()
		expect(screen.queryByText("No matches for your search.")).toBeNull()
	})

	it("shows the plain empty state only when every candidate body was searched", () => {
		renderSearching("zzz")

		expect(screen.getByText("No results")).toBeDefined()
		expect(screen.getByText("No matches for your search.")).toBeDefined()
		expect(screen.queryByText("Searching notes…")).toBeNull()
	})

	// The row itself is virtualized (no layout under jsdom); a title match leaves no fallback at all.
	it("shows no fallback for a title match even while other bodies are still being read", () => {
		searchCounts.pending = 1
		renderSearching("groc")

		expect(screen.queryByText("Searching notes…")).toBeNull()
		expect(screen.queryByText("No results")).toBeNull()
	})
})
