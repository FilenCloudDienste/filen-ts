// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import type { PlaylistEntry } from "@/features/audio/queries/playlists"
import type { Playlist } from "@/features/audio/lib/playlistSchema"

// Mock boundary: usePlaylistsQuery normally goes through react-query + the real sdk client (a Vite
// `?worker`, unresolvable under this node/jsdom vitest run) — same rationale as playlists.test.ts's own
// mock, but at the hook boundary rather than the sdk client, since this test renders the CONSUMER
// component, not the data layer itself.
const { usePlaylistsQuery } = vi.hoisted(() => ({ usePlaylistsQuery: vi.fn() }))

vi.mock("@/features/audio/queries/playlists", () => ({ usePlaylistsQuery }))

// PlaylistDetailDialog (always imported by PlaylistsPanel, even though only conditionally rendered)
// pulls in AddPlaylistTracksDialog's drive queries, which reach the same real sdk client transitively —
// same mock boundary as transfersScreen.test.ts's own.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

// createPlaylist/deletePlaylistAction/renamePlaylistAction transitively reach the same sdk client —
// mocked here purely as a side-effect-free stub; no test below exercises the create/rename/delete flow
// itself (that's playlists.test.ts's job), only that the screen renders the CRUD affordances.
vi.mock("@/features/audio/lib/playlists", () => ({
	createPlaylist: vi.fn(),
	deletePlaylistAction: vi.fn(),
	renamePlaylistAction: vi.fn()
}))

// playPlaylistFrom/shufflePlayPlaylist import the real audioEngine singleton (real DOM/media-session
// wiring) transitively — mocked at this boundary like nowPlayingPanel.test.ts's own audioEngine mock.
vi.mock("@/features/audio/lib/playlistPlayback", () => ({
	playPlaylistFrom: vi.fn().mockResolvedValue(undefined),
	shufflePlayPlaylist: vi.fn().mockResolvedValue(undefined)
}))

const { PlaylistsScreen } = await import("@/features/audio/screens/playlists")

function playlist(overrides: Partial<Playlist> = {}): Playlist {
	return { uuid: "p1", name: "Road trip", created: 0, updated: Date.now(), files: [], ...overrides }
}

function pending() {
	return { status: "pending" as const, data: undefined }
}

function success(entries: PlaylistEntry[]) {
	return { status: "success" as const, data: entries }
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

// The rail's /playlists entry routes straight to this screen (no route-level test exists in this repo —
// route files are thin `createFileRoute` wrappers with no logic of their own, see transfers.tsx's own
// precedent — so the screen component itself is the unit under test here, same as transfersScreen.test.ts
// covers TransfersScreen rather than routes/_app/transfers.tsx).
describe("PlaylistsScreen", () => {
	it("renders the screen heading and an empty state when no playlists exist", () => {
		usePlaylistsQuery.mockReturnValue(success([]))

		render(createElement(PlaylistsScreen))

		expect(screen.getByRole("heading", { name: "Playlists" })).toBeTruthy()
		expect(screen.getByText("No playlists yet")).toBeTruthy()
	})

	it("renders a row per playlist with its name and track count", () => {
		usePlaylistsQuery.mockReturnValue(
			success([
				{ status: "ok", playlist: playlist({ uuid: "p1", name: "Road trip" }) },
				{ status: "ok", playlist: playlist({ uuid: "p2", name: "Focus", files: [{} as never] }) }
			])
		)

		render(createElement(PlaylistsScreen))

		// A row's accessible name folds in its track-count/updated subtext (e.g. "Road trip0 tracks · Just
		// now") — matched by prefix since the exact subtext isn't under test here.
		expect(screen.getByRole("button", { name: /^Road trip/ })).toBeTruthy()
		expect(screen.getByRole("button", { name: /^Focus/ })).toBeTruthy()
		expect(screen.getByText(/1 track\b/)).toBeTruthy()
	})

	it("shows a loading spinner while the query is pending, not the empty state", () => {
		usePlaylistsQuery.mockReturnValue(pending())

		render(createElement(PlaylistsScreen))

		expect(screen.getByRole("heading", { name: "Playlists" })).toBeTruthy()
		expect(screen.queryByText("No playlists yet")).toBeNull()
	})
})
