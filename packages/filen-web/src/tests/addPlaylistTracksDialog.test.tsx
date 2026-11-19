// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { File as SdkFile, UuidStr } from "@filen/sdk-rs"
import type { Playlist } from "@filen/shared"
import "@/lib/i18n"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { mockViewportHeight } from "@/tests/support/viewport"

// "Add tracks" over a large music directory: the list is a window over its rows, and picking and filtering work on it.

const picker = vi.hoisted(() => ({ items: [] as DriveItem[] }))
const addTracks = vi.hoisted(() => vi.fn((_playlist: unknown, _files: DriveItem[]) => Promise.resolve(1)))

vi.mock("@/features/drive/hooks/useDirectoryPicker", async () => {
	const { useState } = await import("react")

	return {
		useDirectoryPicker: () => ({
			pathStack: [],
			targetUuid: null,
			listingQuery: { status: "success", data: picker.items },
			items: picker.items,
			namesQuery: { data: undefined },
			descend: vi.fn(),
			goRoot: vi.fn(),
			goTo: vi.fn()
		}),
		useDirectoryPickerFilter: () => useState("")
	}
})
vi.mock("@/features/audio/lib/playlists", () => ({ addTracksToPlaylistAction: addTracks }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { AddPlaylistTracksDialog } = await import("@/features/audio/components/addPlaylistTracksDialog")
const { registerAllActions } = await import("@/lib/keymap/actions")

registerAllActions()

function track(index: number): DriveItem {
	const name = `track${String(index).padStart(5, "0")}.mp3`

	return narrowItem({
		uuid: `${String(index).padStart(8, "0")}-0000-0000-0000-000000000000` as UuidStr,
		stableUUID: undefined,
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		size: 1000n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "audio/mpeg", modified: 0n, size: 1000n, key: "key", version: 2 } }
	} satisfies SdkFile)
}

const PLAYLIST = { uuid: "playlist", name: "Mix", files: [] } as unknown as Playlist

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("AddPlaylistTracksDialog", () => {
	it("mounts a window of a directory of thousands of tracks; selecting and filtering still work", async () => {
		mockViewportHeight(element => element.classList.contains("overflow-y-auto"), 400)
		picker.items = Array.from({ length: 5000 }, (_, index) => track(index))

		render(
			<AddPlaylistTracksDialog
				playlist={PLAYLIST}
				onClose={vi.fn()}
			/>
		)

		const rows = screen.getAllByRole("listitem")

		expect(rows.length).toBeGreaterThan(0)
		expect(rows.length).toBeLessThan(50)
		expect(screen.queryByRole("button", { name: "track04999.mp3" })).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "track00002.mp3" }))
		expect(screen.getByRole("button", { name: "track00002.mp3" }).getAttribute("aria-pressed")).toBe("true")

		// A filter brings a row from far down the listing into the window.
		fireEvent.change(screen.getByRole("searchbox", { name: "Filter" }), { target: { value: "track04999" } })
		expect(screen.getAllByRole("listitem")).toHaveLength(1)
		fireEvent.click(screen.getByRole("button", { name: "track04999.mp3" }))

		fireEvent.click(screen.getByRole("button", { name: "Add 2 tracks" }))
		await vi.waitFor(() => {
			expect(addTracks).toHaveBeenCalledTimes(1)
		})
		expect(addTracks.mock.calls[0]?.[1].map(item => item.data.uuid)).toEqual([
			picker.items[2]?.data.uuid,
			picker.items[4999]?.data.uuid
		])
	})
})
