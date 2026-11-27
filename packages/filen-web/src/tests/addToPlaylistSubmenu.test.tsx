// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { Playlist } from "@filen/shared"
import "@/lib/i18n"

const { addSelection, queryResult } = vi.hoisted(() => {
	const current: { status: string; data: unknown } = { status: "pending", data: undefined }

	return { addSelection: vi.fn(), queryResult: { current } }
})

vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client() }
})
vi.mock("@/features/audio/lib/addTracks", () => ({ addSelectionToPlaylist: addSelection }))
vi.mock("@/features/audio/queries/playlists", () => ({ usePlaylistsQuery: () => queryResult.current }))

import { AddToPlaylistEntries } from "@/features/drive/components/addToPlaylistSubmenu"
import { DROPDOWN_TREE_MENU_FAMILY } from "@/features/drive/components/directoryTreeSubmenu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ownedFileItem } from "@/tests/fixtures/sdk"

const SONG = ownedFileItem("a.mp3", "audio/mpeg")
const MIX = { uuid: "p1", name: "Mix" } as Playlist

function renderEntries(onNewPlaylist = vi.fn()) {
	render(
		createElement(
			DropdownMenu,
			{ defaultOpen: true },
			createElement(DropdownMenuTrigger, null, "menu"),
			createElement(
				DropdownMenuContent,
				null,
				createElement(AddToPlaylistEntries, { family: DROPDOWN_TREE_MENU_FAMILY, items: [SONG], onNewPlaylist })
			)
		)
	)

	return onNewPlaylist
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("Add to playlist entries", () => {
	it("lists the held playlists, skipping degraded rows, and adds to the one picked", () => {
		queryResult.current = {
			status: "success",
			data: [
				{ status: "ok", playlist: MIX },
				{ status: "degraded", fileUuid: "f", name: "Broken" }
			]
		}

		renderEntries()

		expect(screen.queryByText("Broken")).toBeNull()
		fireEvent.click(screen.getByText("Mix"))
		expect(addSelection).toHaveBeenCalledWith(MIX, [SONG])
	})

	it("always offers New playlist…, which hands off to the dialog", () => {
		queryResult.current = { status: "success", data: [] }

		const onNewPlaylist = renderEntries()

		fireEvent.click(screen.getByText("New playlist…"))
		expect(onNewPlaylist).toHaveBeenCalledTimes(1)
		expect(addSelection).not.toHaveBeenCalled()
	})

	it("shows the load error in place of the list", () => {
		queryResult.current = { status: "error", data: undefined }

		renderEntries()

		expect(screen.getByText("Couldn't load playlists")).toBeTruthy()
		expect(screen.getByText("New playlist…")).toBeTruthy()
	})
})
