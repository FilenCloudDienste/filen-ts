import { vi, describe, it, expect, beforeEach } from "vitest"
import { type TFunction } from "i18next"

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import of the module under test
// ---------------------------------------------------------------------------

vi.mock("expo-router", () => ({
	router: { push: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false) }
}))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("@/lib/alerts", () => ({
	default: { error: vi.fn(), normal: vi.fn() }
}))

vi.mock("@/lib/prompts", () => ({
	default: { alert: vi.fn(), input: vi.fn() }
}))

vi.mock("@/components/ui/fullScreenLoadingModal", () => ({
	runWithLoading: vi.fn(async (fn: () => Promise<unknown>) => {
		try {
			const data = await fn()

			return { success: true, data }
		} catch (error) {
			return { success: false, error }
		}
	})
}))

// audio singleton — only needs to expose the shapes the builder passes callbacks to
vi.mock("@/features/audio/audio", () => ({
	default: {
		clearQueue: vi.fn(),
		replaceQueue: vi.fn(),
		play: vi.fn(),
		addToQueue: vi.fn(),
		getQueue: vi.fn(() => []),
		renamePlaylist: vi.fn(),
		deletePlaylist: vi.fn(),
		addFilesToPlaylist: vi.fn(),
		savePlaylist: vi.fn()
	}
}))

vi.mock("@/features/drive/screens/driveSelect", () => ({
	selectDriveItems: vi.fn()
}))

vi.mock("@/features/audio/playlistsSelect", () => ({
	selectPlaylists: vi.fn()
}))

vi.mock("@/lib/bulkOps", () => ({
	runBulk: vi.fn()
}))

// The store is imported at the module level; provide a minimal stub so the
// module resolves without pulling in zustand internals.
vi.mock("@/features/audio/store/usePlaylistTracks.store", () => ({
	default: {
		getState: vi.fn(() => ({
			clearSelectedTracks: vi.fn(),
			selectAllTracks: vi.fn(),
			selectedTracks: []
		}))
	}
}))

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { buildSelectionMenuButtons, buildPlaylistMenuButtons } from "@/features/audio/components/playlistMenuButtons"
import type { PlaylistWithItems } from "@/features/audio/audio"
import type { PlaylistTrack } from "@/features/audio/store/usePlaylistTracks.store"
import type { MenuButton } from "@/components/ui/menu"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Minimal t() that returns the key — mirrors the pattern used throughout the suite
const t = ((key: string) => key) as unknown as TFunction

function makeTrack(uuid: string): PlaylistTrack {
	return {
		uuid,
		name: `track-${uuid}.mp3`,
		mime: "audio/mpeg",
		size: 1000,
		bucket: "b",
		key: "k",
		version: 1,
		chunks: 1,
		region: "de-1",
		playlist: "playlist-uuid",
		item: {} as PlaylistTrack["item"]
	}
}

function makePlaylist(files: PlaylistTrack[] = []): PlaylistWithItems {
	return {
		uuid: "playlist-uuid",
		name: "My Playlist",
		created: 1000,
		updated: 2000,
		files
	}
}

// ---------------------------------------------------------------------------
// #64 — buildSelectionMenuButtons
// ---------------------------------------------------------------------------

describe("buildSelectionMenuButtons", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("always returns exactly 4 buttons", () => {
		const playlist = makePlaylist([makeTrack("a"), makeTrack("b")])
		const selectedTracks = [makeTrack("a")]
		const buttons = buildSelectionMenuButtons({ t, playlist, selectedTracks })

		expect(buttons).toHaveLength(4)
	})

	it("returns buttons with the correct ids in order", () => {
		const playlist = makePlaylist([makeTrack("a")])
		const selectedTracks: PlaylistTrack[] = []
		const buttons = buildSelectionMenuButtons({ t, playlist, selectedTracks })
		const ids = buttons.map((b: MenuButton) => b.id)

		expect(ids).toEqual(["selectAllTracks", "bulkAddToQueue", "bulkAddToPlaylist", "bulkRemoveTracks"])
	})

	it("selectAllTracks title is 'deselect_all' when all tracks are selected", () => {
		const tracks = [makeTrack("a"), makeTrack("b")]
		const playlist = makePlaylist(tracks)
		const buttons = buildSelectionMenuButtons({ t, playlist, selectedTracks: tracks })
		const selectAllBtn = buttons.find((b: MenuButton) => b.id === "selectAllTracks")

		expect(selectAllBtn?.title).toBe("deselect_all")
	})

	it("selectAllTracks title is 'select_all' when fewer than all tracks are selected", () => {
		const tracks = [makeTrack("a"), makeTrack("b"), makeTrack("c")]
		const playlist = makePlaylist(tracks)
		const selectedTracks = [makeTrack("a")]
		const buttons = buildSelectionMenuButtons({ t, playlist, selectedTracks })
		const selectAllBtn = buttons.find((b: MenuButton) => b.id === "selectAllTracks")

		expect(selectAllBtn?.title).toBe("select_all")
	})

	it("selectAllTracks title is 'select_all' when nothing is selected", () => {
		const tracks = [makeTrack("a"), makeTrack("b")]
		const playlist = makePlaylist(tracks)
		const buttons = buildSelectionMenuButtons({ t, playlist, selectedTracks: [] })
		const selectAllBtn = buttons.find((b: MenuButton) => b.id === "selectAllTracks")

		expect(selectAllBtn?.title).toBe("select_all")
	})

	it("bulkRemoveTracks has destructive:true", () => {
		const playlist = makePlaylist([makeTrack("a")])
		const buttons = buildSelectionMenuButtons({ t, playlist, selectedTracks: [] })
		const bulkRemoveBtn = buttons.find((b: MenuButton) => b.id === "bulkRemoveTracks")

		expect(bulkRemoveBtn?.destructive).toBe(true)
	})

	it("bulkRemoveTracks has requiresOnline:true", () => {
		const playlist = makePlaylist([makeTrack("a")])
		const buttons = buildSelectionMenuButtons({ t, playlist, selectedTracks: [] })
		const bulkRemoveBtn = buttons.find((b: MenuButton) => b.id === "bulkRemoveTracks")

		expect(bulkRemoveBtn?.requiresOnline).toBe(true)
	})

	it("bulkAddToPlaylist has requiresOnline:true", () => {
		const playlist = makePlaylist([makeTrack("a")])
		const buttons = buildSelectionMenuButtons({ t, playlist, selectedTracks: [] })
		const bulkAddBtn = buttons.find((b: MenuButton) => b.id === "bulkAddToPlaylist")

		expect(bulkAddBtn?.requiresOnline).toBe(true)
	})

	it("selectAllTracks title toggles correctly on the boundary (one track selected out of one)", () => {
		// exactly 1 selected, playlist has exactly 1 track → deselect_all
		const track = makeTrack("x")
		const playlist = makePlaylist([track])
		const buttons = buildSelectionMenuButtons({ t, playlist, selectedTracks: [track] })
		const selectAllBtn = buttons.find((b: MenuButton) => b.id === "selectAllTracks")

		expect(selectAllBtn?.title).toBe("deselect_all")
	})
})

// ---------------------------------------------------------------------------
// #65 — buildPlaylistMenuButtons
// ---------------------------------------------------------------------------

describe("buildPlaylistMenuButtons", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns 3 buttons when playlist has no files", () => {
		const playlist = makePlaylist([])
		const buttons = buildPlaylistMenuButtons({ t, playlist })

		expect(buttons).toHaveLength(3)
	})

	it("returns 5 buttons when playlist has files", () => {
		const playlist = makePlaylist([makeTrack("a"), makeTrack("b")])
		const buttons = buildPlaylistMenuButtons({ t, playlist })

		expect(buttons).toHaveLength(5)
	})

	it("first button is 'play' when playlist has files", () => {
		const playlist = makePlaylist([makeTrack("a")])
		const buttons = buildPlaylistMenuButtons({ t, playlist })

		expect(buttons[0]?.id).toBe("play")
	})

	it("second button is 'addToQueue' when playlist has files", () => {
		const playlist = makePlaylist([makeTrack("a")])
		const buttons = buildPlaylistMenuButtons({ t, playlist })

		expect(buttons[1]?.id).toBe("addToQueue")
	})

	it("button ids without files are ['rename', 'add', 'delete']", () => {
		const playlist = makePlaylist([])
		const buttons = buildPlaylistMenuButtons({ t, playlist })
		const ids = buttons.map((b: MenuButton) => b.id)

		expect(ids).toEqual(["rename", "add", "delete"])
	})

	it("button ids with files are ['play', 'addToQueue', 'rename', 'add', 'delete']", () => {
		const playlist = makePlaylist([makeTrack("a")])
		const buttons = buildPlaylistMenuButtons({ t, playlist })
		const ids = buttons.map((b: MenuButton) => b.id)

		expect(ids).toEqual(["play", "addToQueue", "rename", "add", "delete"])
	})

	it("delete button has destructive:true", () => {
		const playlist = makePlaylist([])
		const buttons = buildPlaylistMenuButtons({ t, playlist })
		const deleteBtn = buttons.find((b: MenuButton) => b.id === "delete")

		expect(deleteBtn?.destructive).toBe(true)
	})

	it("rename button id is 'rename'", () => {
		const playlist = makePlaylist([])
		const buttons = buildPlaylistMenuButtons({ t, playlist })

		expect(buttons.some((b: MenuButton) => b.id === "rename")).toBe(true)
	})

	it("add button id is 'add'", () => {
		const playlist = makePlaylist([])
		const buttons = buildPlaylistMenuButtons({ t, playlist })

		expect(buttons.some((b: MenuButton) => b.id === "add")).toBe(true)
	})

	it("play button is absent when playlist has no files", () => {
		const playlist = makePlaylist([])
		const buttons = buildPlaylistMenuButtons({ t, playlist })

		expect(buttons.some((b: MenuButton) => b.id === "play")).toBe(false)
	})

	it("addToQueue button is absent when playlist has no files", () => {
		const playlist = makePlaylist([])
		const buttons = buildPlaylistMenuButtons({ t, playlist })

		expect(buttons.some((b: MenuButton) => b.id === "addToQueue")).toBe(false)
	})

	it("single-file playlist still yields 5 buttons", () => {
		const playlist = makePlaylist([makeTrack("only")])
		const buttons = buildPlaylistMenuButtons({ t, playlist })

		expect(buttons).toHaveLength(5)
	})
})
