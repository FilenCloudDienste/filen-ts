// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import type { Playlist } from "@filen/shared"
import type { PlaylistEntry } from "@/features/audio/queries/playlists"

// The page's rename and delete keys act on a playlist: from a sidebar row or the page itself, never from a track row,
// where Delete means the track.

const { usePlaylistsQuery } = vi.hoisted(() => ({ usePlaylistsQuery: vi.fn() }))

vi.mock("@/features/audio/queries/playlists", () => ({ usePlaylistsQuery }))
vi.mock("@/features/shell/lib/lastOpened", () => ({ useLastOpened: () => null, rememberLastOpened: vi.fn() }))
vi.mock("@/features/audio/lib/playlistPlayback", () => ({ startPlaylist: vi.fn(), startShuffledPlaylist: vi.fn() }))
vi.mock("@/features/audio/components/playlistDialogsHost", () => ({ PlaylistDialogsHost: () => null }))
// The pane stands in as one track row with a focusable title, the markup playlistPane.tsx gives it.
vi.mock("@/features/audio/components/playlistPane", () => ({
	PlaylistPane: () =>
		createElement(
			"table",
			null,
			createElement(
				"tbody",
				null,
				createElement(
					"tr",
					{ "data-track-uuid": "t1" },
					createElement("td", null, createElement("button", { type: "button" }, "Track"))
				)
			)
		)
}))

const { PlaylistsScreen } = await import("@/features/audio/screens/playlists")
const { PLAYLISTS_ACTIONS } = await import("@/features/audio/lib/playlistKeymap")
const { registerAction } = await import("@/lib/keymap/registry")
const { usePlaylistDialogStore } = await import("@/features/audio/store/usePlaylistDialogStore")

function playlist(uuid: string): Playlist {
	return { uuid, name: uuid, created: 0, updated: 0, files: [] }
}

const shown = playlist("shown")
const other = playlist("other")
const ENTRIES: PlaylistEntry[] = [
	{ status: "ok", playlist: shown },
	{ status: "ok", playlist: other }
]

function renderScreen(): void {
	render(createElement(PlaylistsScreen, { selectedUuid: "shown" }))
}

function sidebarRow(uuid: string): HTMLElement {
	const row = document.createElement("li")
	const link = document.createElement("a")

	link.href = "#"
	row.setAttribute("data-playlist-uuid", uuid)
	row.append(link)
	document.body.append(row)

	return link
}

function press(target: Element, key: string): void {
	act(() => {
		fireEvent.keyDown(target, { key, code: key })
		fireEvent.keyUp(target, { key, code: key })
	})
}

function trackTitle(): HTMLElement {
	const button = document.querySelector<HTMLElement>("[data-track-uuid] button")

	if (button === null) {
		throw new Error("no track row")
	}

	return button
}

beforeAll(() => {
	for (const def of PLAYLISTS_ACTIONS) {
		registerAction(def)
	}
})

beforeEach(() => {
	usePlaylistsQuery.mockReturnValue({ status: "success", data: ENTRIES })
	usePlaylistDialogStore.setState({ dialog: null })
})

afterEach(() => {
	cleanup()
	document.body.replaceChildren()
})

describe("playlist rename and delete keys", () => {
	it.each(["Delete", "Backspace", "F2"])("open no dialog when %s comes from a track row", key => {
		renderScreen()
		press(trackTitle(), key)

		expect(usePlaylistDialogStore.getState().dialog).toBeNull()
	})

	it.each([
		["Delete", "delete"],
		["Backspace", "delete"],
		["F2", "rename"]
	])("act on the sidebar row holding focus for %s", (key, kind) => {
		renderScreen()
		press(sidebarRow("other"), key)

		expect(usePlaylistDialogStore.getState().dialog).toEqual({ kind, playlist: other })
	})

	it.each([
		["Delete", "delete"],
		["F2", "rename"]
	])("act on the playlist on screen for %s from the page", (key, kind) => {
		renderScreen()
		press(document.body, key)

		expect(usePlaylistDialogStore.getState().dialog).toEqual({ kind, playlist: shown })
	})
})
