// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import { plainErrorDTO } from "@/lib/sdk/errors"

// A failed playlists read says why and offers a retry, as the contacts list does.

const { usePlaylistsQuery } = vi.hoisted(() => ({ usePlaylistsQuery: vi.fn() }))

vi.mock("@/features/audio/queries/playlists", () => ({ usePlaylistsQuery }))
vi.mock("@/features/shell/lib/lastOpened", () => ({ useLastOpened: () => null, rememberLastOpened: vi.fn() }))
vi.mock("@/features/audio/lib/playlistPlayback", () => ({ startPlaylist: vi.fn(), startShuffledPlaylist: vi.fn() }))
vi.mock("@/features/audio/components/playlistDialogsHost", () => ({ PlaylistDialogsHost: () => null }))
vi.mock("@/features/audio/components/playlistPane", () => ({ PlaylistPane: () => null }))

const { PlaylistsScreen } = await import("@/features/audio/screens/playlists")
const { PLAYLISTS_ACTIONS } = await import("@/features/audio/lib/playlistKeymap")
const { registerAction } = await import("@/lib/keymap/registry")

beforeAll(() => {
	for (const def of PLAYLISTS_ACTIONS) {
		registerAction(def)
	}
})

afterEach(() => {
	cleanup()
})

describe("PlaylistsScreen load error", () => {
	it("shows the reason and a Try again button that reads the list again", () => {
		const refetch = vi.fn(() => Promise.resolve())

		usePlaylistsQuery.mockReturnValue({ status: "error", data: undefined, error: plainErrorDTO("Disk full"), refetch })

		render(createElement(PlaylistsScreen, { selectedUuid: undefined }))

		expect(screen.getByText("Disk full")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Try again" }))

		expect(refetch).toHaveBeenCalledOnce()
	})
})
