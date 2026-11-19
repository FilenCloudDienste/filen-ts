// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"

// A failed read on a Videos screen shows the error and a retry: a title page whose title or detail read rejected never
// says "not in your library", and a library view whose configuration read rejected shows the same block as Home.

interface FakeQuery {
	data: unknown
	status: string
	isPending: boolean
	isError: boolean
	error: unknown
	refetch: () => Promise<unknown>
}

function query(state: "success" | "error" | "pending", data?: unknown): FakeQuery {
	return {
		data,
		status: state,
		isPending: state === "pending",
		isError: state === "error",
		error: state === "error" ? new Error("worker gone") : null,
		refetch: vi.fn(() => Promise.resolve())
	}
}

const { state } = vi.hoisted(() => ({
	state: {
		title: null as unknown as FakeQuery,
		detail: null as unknown as FakeQuery,
		config: null as unknown as FakeQuery
	}
}))

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
	useRouter: () => ({ history: { canGoBack: () => false, back: vi.fn() } }),
	useRouterState: ({ select }: { select: (s: unknown) => unknown }) => select({ location: { pathname: "/videos/movies" } })
}))
vi.mock("@/features/videos/lib/index", () => ({
	videoLibrary: { subscribe: () => () => undefined, getSnapshot: () => ({}), open: () => Promise.resolve(), rescan: vi.fn() }
}))
vi.mock("@/features/videos/queries/library", () => ({
	useVideoLibrary: () => ({ loaded: true, roots: [{ uuid: "root", walking: true, state: "loading" }] }),
	useVideoTitleDetailQuery: () => state.detail
}))
vi.mock("@/features/videos/queries/catalog", () => ({
	useCatalogTitleQuery: () => state.title,
	useCatalogSeriesQuery: () => query("pending")
}))
vi.mock("@/features/videos/queries/detail", () => ({ useStoredProbesQuery: () => query("success", new Map()) }))
vi.mock("@/features/videos/hooks/useFollowMovedTitle", () => ({ useFollowMovedTitle: () => vi.fn() }))
vi.mock("@/features/videos/hooks/useHistoryEntryKey", () => ({ useHistoryEntryKey: () => "entry" }))
vi.mock("@/features/videos/hooks/useVideoLibraryView", () => ({
	useVideoLibraryView: () => ({ configQuery: state.config, snapshot: { summary: { titleCount: 0 } }, roots: [] }),
	useVideoRootNames: () => new Map<string, string>(),
	useVideoRootName: () => ""
}))
vi.mock("@/features/videos/components/videoGrid", () => ({ VideoGrid: () => <div data-testid="video-grid" /> }))
vi.mock("@/features/videos/components/homeRows", () => ({ VideosHomeRows: () => null }))
vi.mock("@/features/videos/components/detail/movieDetail", () => ({ MovieDetail: () => <div data-testid="movie-detail" /> }))
vi.mock("@/features/videos/components/detail/seriesDetail", () => ({ SeriesDetail: () => null }))
vi.mock("@/features/videos/components/detail/correctionsDialog", () => ({ CorrectionsDialog: () => null }))

import { VideoTitleScreen } from "@/features/videos/screens/videoTitle"
import { VideosSectionScreen } from "@/features/videos/screens/videosSection"
import { VideosHomeScreen } from "@/features/videos/screens/videosHome"

const movie = { id: "movie", kind: "movie", primary: null, backdrop: null, container: "mp4" }

afterEach(() => {
	cleanup()
})

describe("title page read failures", () => {
	it("shows the error with a retry when the title read rejects, even while roots scan", () => {
		state.title = query("error")
		state.detail = query("success", null)

		render(<VideoTitleScreen titleId="movie" />)

		expect(screen.getByTestId("listing-error")).toBeTruthy()
		expect(screen.queryByText("Not in your library")).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Try again" }))

		expect(state.title.refetch).toHaveBeenCalledTimes(1)
		expect(state.detail.refetch).not.toHaveBeenCalled()
	})

	it("shows the error with a retry when the detail read rejects", () => {
		state.title = query("success", movie)
		state.detail = query("error")

		render(<VideoTitleScreen titleId="movie" />)

		expect(screen.getByTestId("listing-error")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Try again" }))

		expect(state.detail.refetch).toHaveBeenCalledTimes(1)
		expect(state.title.refetch).not.toHaveBeenCalled()
	})

	it("keeps the content when a refetch fails over data already shown", () => {
		state.title = { ...query("error"), data: movie }
		state.detail = query("success", { kind: "movie", title: { id: "movie" } })

		render(<VideoTitleScreen titleId="movie" />)

		expect(screen.getByTestId("movie-detail")).toBeTruthy()
		expect(screen.queryByTestId("listing-error")).toBeNull()
	})
})

describe("library view configuration failure", () => {
	it("shows the same error block as Home, with a retry", () => {
		state.config = query("error")

		const home = render(<VideosHomeScreen />)
		const homeMarkup = home.container.innerHTML

		home.unmount()

		const section = render(<VideosSectionScreen />)

		expect(screen.queryByTestId("video-grid")).toBeNull()
		expect(screen.getByTestId("listing-error")).toBeTruthy()
		expect(section.container.innerHTML).toBe(homeMarkup)

		fireEvent.click(screen.getByRole("button", { name: "Try again" }))

		expect(state.config.refetch).toHaveBeenCalledTimes(1)
	})
})
