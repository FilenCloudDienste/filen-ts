import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Playlist } from "@filen/shared"
import "@/lib/i18n"

const { toastSuccess, toastError, toastInfo, addAction } = vi.hoisted(() => ({
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastInfo: vi.fn(),
	addAction: vi.fn()
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError, info: toastInfo } }))
vi.mock("@/features/audio/lib/playlists", () => ({ addTracksToPlaylistAction: addAction }))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { driveSelectionActions } from "@/features/drive/lib/selectionActions"
import { aggregateDriveSelectionFlags } from "@/features/drive/lib/selectionFlags"
import { addSelectionToPlaylist } from "@/features/audio/lib/addTracks"
import { mockDirItem, mockFile, ownedFileItem } from "@/tests/fixtures/sdk"
import { testUuid } from "@/tests/support/uuid"

function song(name: string): DriveItem {
	return ownedFileItem(name, "audio/mpeg", { uuid: testUuid(name) })
}

const DOC = ownedFileItem("report.pdf", "application/pdf", { uuid: testUuid("report") })
const DIR = mockDirItem({ uuid: testUuid("dir") })
const UNDECRYPTABLE = narrowItem({ ...mockFile({ uuid: testUuid("enc") }), meta: { type: "encrypted", data: "ciphertext" } })
const PLAYLIST = { uuid: testUuid("playlist"), name: "Mix" } as Playlist

function bulkOffers(variant: DriveVariant, items: DriveItem[]): boolean {
	return driveSelectionActions(items, variant, { isOnline: true }).some(descriptor => descriptor.id === "addToPlaylist")
}

function itemOffers(variant: DriveVariant, item: DriveItem): boolean {
	return driveSelectionActions([item], variant, { isOnline: true, open: true }).some(descriptor => descriptor.id === "addToPlaylist")
}

describe("Add to playlist visibility", () => {
	it("is offered on a single song in every non-trash listing", () => {
		for (const variant of ["drive", "recents", "favorites", "links", "sharedIn", "sharedOut"] as const) {
			expect(itemOffers(variant, song("a.mp3"))).toBe(true)
		}
	})

	it("is absent from a non-song, a directory, an undecryptable file and the trash", () => {
		expect(itemOffers("drive", DOC)).toBe(false)
		expect(itemOffers("drive", DIR)).toBe(false)
		expect(itemOffers("drive", UNDECRYPTABLE)).toBe(false)
		expect(itemOffers("trash", song("a.mp3"))).toBe(false)
	})

	it("gates the bulk entry on at least one song", () => {
		expect(bulkOffers("drive", [DOC, DIR])).toBe(false)
		expect(bulkOffers("drive", [DOC, DIR, song("a.mp3")])).toBe(true)
		expect(bulkOffers("drive", [song("a.mp3"), song("b.flac")])).toBe(true)
		// An undecryptable item in the selection is skipped, not a reason to hide the entry.
		expect(bulkOffers("drive", [UNDECRYPTABLE, song("a.mp3")])).toBe(true)
		expect(bulkOffers("drive", [UNDECRYPTABLE])).toBe(false)
		expect(bulkOffers("trash", [song("a.mp3"), song("b.mp3")])).toBe(false)
	})

	it("sets the flag only for a decryptable song", () => {
		expect(aggregateDriveSelectionFlags([DOC, UNDECRYPTABLE, DIR]).includesPlaylistSong).toBe(false)
		expect(aggregateDriveSelectionFlags([DOC, song("a.ogg")]).includesPlaylistSong).toBe(true)
	})
})

describe("addSelectionToPlaylist", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("adds only the songs in one call and reports the rest as skipped", async () => {
		const a = song("a.mp3")
		const b = song("b.mp3")

		addAction.mockResolvedValue(2)

		const outcome = await addSelectionToPlaylist(PLAYLIST, [a, DOC, b, DIR, UNDECRYPTABLE])

		expect(addAction).toHaveBeenCalledTimes(1)
		expect(addAction).toHaveBeenCalledWith(PLAYLIST, [a, b])
		expect(outcome).toEqual({ status: "success", added: 2, skipped: 3 })
		expect(toastSuccess).toHaveBeenCalledWith("Added 2 tracks, 3 skipped")
	})

	it("counts songs already in the playlist as skipped", async () => {
		addAction.mockResolvedValue(1)

		const outcome = await addSelectionToPlaylist(PLAYLIST, [song("a.mp3"), song("b.mp3")])

		expect(outcome).toEqual({ status: "success", added: 1, skipped: 1 })
		expect(toastSuccess).toHaveBeenCalledWith("Added 1 track, 1 skipped")
	})

	it("keeps the plain toast when everything went in", async () => {
		addAction.mockResolvedValue(2)

		await addSelectionToPlaylist(PLAYLIST, [song("a.mp3"), song("b.mp3")])

		expect(toastSuccess).toHaveBeenCalledWith("Added 2 tracks")
	})

	it("says so when nothing new was added", async () => {
		addAction.mockResolvedValue(0)

		const outcome = await addSelectionToPlaylist(PLAYLIST, [song("a.mp3"), DOC])

		expect(outcome).toEqual({ status: "success", added: 0, skipped: 2 })
		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastInfo).toHaveBeenCalledWith("Nothing new to add")
	})

	it("reports a failed write", async () => {
		const error = new Error("boom")

		addAction.mockRejectedValue(error)

		const outcome = await addSelectionToPlaylist(PLAYLIST, [song("a.mp3")])

		expect(outcome).toEqual({ status: "error", error })
		expect(toastError).toHaveBeenCalledTimes(1)
	})
})
