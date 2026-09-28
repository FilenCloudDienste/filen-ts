// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, within } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import "@/lib/i18n"
import type { PlaylistEntry } from "@/features/audio/queries/playlists"
import type { Playlist, PlaylistFile } from "@filen/shared"

// Mock boundary: usePlaylistsQuery normally goes through react-query + the real sdk client (a Vite
// `?worker`, unresolvable under this node/jsdom vitest run) — same rationale as playlists.test.ts's own
// mock, but at the hook boundary rather than the sdk client, since this test renders the CONSUMER
// components, not the data layer itself.
const { usePlaylistsQuery } = vi.hoisted(() => ({ usePlaylistsQuery: vi.fn() }))

vi.mock("@/features/audio/queries/playlists", () => ({ usePlaylistsQuery }))

// The pane's AddPlaylistTracksDialog import pulls in drive queries that reach the same real sdk client
// transitively — same mock boundary as transfersScreen.test.ts's own.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

// The dialog host's create/rename/delete and the pane's remove/reorder transitively reach the same sdk
// client — side-effect-free stubs; the flows themselves are playlists.test.ts's job.
vi.mock("@/features/audio/lib/playlists", () => ({
	createPlaylist: vi.fn(),
	deletePlaylistAction: vi.fn(),
	renamePlaylistAction: vi.fn(),
	removeTracksFromPlaylistAction: vi.fn(),
	reorderPlaylistFileAction: vi.fn()
}))

// startPlaylist/startShuffledPlaylist import the real audioEngine singleton (real DOM/media-session
// wiring) transitively — mocked at this boundary like nowPlayingPanel.test.ts's own audioEngine mock.
vi.mock("@/features/audio/lib/playlistPlayback", () => ({
	startPlaylist: vi.fn(),
	startShuffledPlaylist: vi.fn()
}))

// Router boundary, same shape as notesSidebarRows.test.ts's: Link renders a plain anchor carrying its
// target's search param, and the sidebar's loose useSearch reads `router.searchParam`.
const router = vi.hoisted(() => ({ searchParam: undefined as string | undefined }))

vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, search, children, ...rest }: { to: string; search?: { playlist?: string }; children?: ReactNode }) =>
		createElement("a", { ...rest, href: search?.playlist === undefined ? to : `${to}?playlist=${search.playlist}` }, children),
	useNavigate: () => () => undefined,
	useSearch: ({ select }: { select: (search: { playlist?: string }) => unknown }) =>
		select(router.searchParam === undefined ? {} : { playlist: router.searchParam })
}))

const { PlaylistsScreen } = await import("@/features/audio/screens/playlists")
const { PlaylistsSidebar } = await import("@/features/audio/components/playlistsSidebar")
const { useAudioStore } = await import("@/features/audio/store/useAudioStore")

function playlist(overrides: Partial<Playlist> = {}): Playlist {
	return { uuid: "p1", name: "Road trip", created: 0, updated: Date.now(), files: [], ...overrides }
}

function file(uuid: string, name: string, size: number): PlaylistFile {
	return { uuid, name, mime: "audio/mpeg", size, bucket: "", key: "", version: 2, chunks: 1, region: "", playlist: "p1" }
}

function pending() {
	return { status: "pending" as const, data: undefined }
}

function success(entries: PlaylistEntry[]) {
	return { status: "success" as const, data: entries }
}

function renderSplitView(selectedUuid?: string) {
	router.searchParam = selectedUuid

	return render(createElement("div", null, createElement(PlaylistsSidebar), createElement(PlaylistsScreen, { selectedUuid })))
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
	useAudioStore.setState({ queue: [], currentIndex: 0 })
})

const TWO: PlaylistEntry[] = [
	{ status: "ok", playlist: playlist({ uuid: "p1", name: "Road trip", files: [file("f1", "Intro.mp3", 4_000_000)] }) },
	{
		status: "ok",
		playlist: playlist({ uuid: "p2", name: "Focus", files: [file("f2", "Highway.flac", 1_000), file("f3", "Outro.mp3", 2_000)] })
	}
]

// The rail's /playlists entry routes straight to this split view: the shell's PlaylistsSidebar beside
// the route's PlaylistsScreen (route files are thin wrappers, so the two components are the units here).
describe("playlists split view", () => {
	it("titles the sidebar and shows a create action when no playlists exist", () => {
		usePlaylistsQuery.mockReturnValue(success([]))

		renderSplitView()

		expect(screen.getByRole("heading", { name: "Playlists" })).toBeTruthy()
		expect(screen.getByText("No playlists yet")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Create playlist" })).toBeTruthy()
		expect(screen.getByRole("button", { name: "New playlist" })).toBeTruthy()
	})

	it("links a sidebar row per playlist with its track count", () => {
		usePlaylistsQuery.mockReturnValue(success(TWO))

		renderSplitView()

		// A row's accessible name folds in its meta line ("Road trip1 track · Just now") — prefix-matched.
		expect(screen.getByRole("link", { name: /^Road trip/ }).getAttribute("href")).toBe("/playlists?playlist=p1")
		expect(screen.getByRole("link", { name: /^Focus/ }).textContent).toContain("2 tracks")
	})

	it("selects the first playlist when no param is given", () => {
		usePlaylistsQuery.mockReturnValue(success(TWO))

		renderSplitView()

		expect(screen.getByRole("heading", { level: 1, name: "Road trip" })).toBeTruthy()
		expect(screen.getByRole("link", { name: /^Road trip/ }).getAttribute("aria-current")).toBe("page")
		expect(screen.getByRole("link", { name: /^Focus/ }).getAttribute("aria-current")).toBeNull()
	})

	it("shows the playlist the param names, with its tracks and total size", () => {
		usePlaylistsQuery.mockReturnValue(success(TWO))

		renderSplitView("p2")

		const pane = screen.getByRole("region", { name: "Focus" })

		expect(within(pane).getByRole("heading", { level: 1, name: "Focus" })).toBeTruthy()
		expect(within(pane).getByText(/2 tracks · 2\.93 KiB/)).toBeTruthy()
		expect(within(pane).getByRole("button", { name: "Highway.flac" })).toBeTruthy()
		expect(within(pane).getByRole("button", { name: "Outro.mp3" })).toBeTruthy()
		expect(screen.getByRole("link", { name: /^Focus/ }).getAttribute("aria-current")).toBe("page")
	})

	it("falls back to the first playlist for a stale param", () => {
		usePlaylistsQuery.mockReturnValue(success(TWO))

		renderSplitView("gone")

		expect(screen.getByRole("heading", { level: 1, name: "Road trip" })).toBeTruthy()
	})

	it("renders a degraded entry muted and not as a link, and never selects it", () => {
		usePlaylistsQuery.mockReturnValue(success([{ status: "degraded", fileUuid: "d1", name: "Broken" }, ...TWO]))

		renderSplitView()

		expect(screen.getByText("Broken")).toBeTruthy()
		expect(screen.getByText("Couldn't load")).toBeTruthy()
		expect(screen.queryByRole("link", { name: /^Broken/ })).toBeNull()
		expect(screen.getByRole("heading", { level: 1, name: "Road trip" })).toBeTruthy()
	})

	it("marks the playing track's row", () => {
		usePlaylistsQuery.mockReturnValue(success(TWO))
		useAudioStore.setState({
			queue: [{ uuid: "f3", name: "Outro.mp3", mime: "audio/mpeg", contentType: "audio/mpeg", file: {} as never }],
			currentIndex: 0
		})

		renderSplitView("p2")

		// [0] is the header row.
		const [, first, second] = within(screen.getByRole("region", { name: "Focus" })).getAllByRole("row")

		expect(first && within(first).queryByText("Now playing")).toBeNull()
		expect(second && within(second).getByText("Now playing")).toBeTruthy()
	})

	it("shows loading spinners in both panes while the query is pending, not the empty state", () => {
		usePlaylistsQuery.mockReturnValue(pending())

		const { container } = renderSplitView()

		expect(screen.getByRole("heading", { name: "Playlists" })).toBeTruthy()
		expect(container.querySelectorAll('[data-slot="spinner"]').length).toBe(2)
		expect(screen.queryByText("No playlists yet")).toBeNull()
	})
})
