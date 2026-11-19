// @vitest-environment happy-dom

// The directory pickers that offer one kind of row (directories for the Photos, Videos and sync choosers, audio
// files for Add tracks) over a directory whose rows are all of another kind: a directory with content, so they say
// nothing here fits rather than that the directory is empty.
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { File as SdkFile, UuidStr } from "@filen/sdk-rs"
import type { Playlist } from "@filen/shared"
import "@/lib/i18n"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

const picker = vi.hoisted(() => ({ items: [] as DriveItem[] }))

function pickerState() {
	return {
		pathStack: [DOCS],
		targetUuid: DOCS,
		listingQuery: { status: "success", data: picker.items, refetch: () => Promise.resolve() },
		items: picker.items,
		namesQuery: { data: { [DOCS]: "Docs" } },
		descend: vi.fn(),
		goRoot: vi.fn(),
		goTo: vi.fn()
	}
}

vi.mock("@/features/drive/hooks/useDirectoryPicker", async () => {
	const { useState } = await import("react")

	return {
		useDirectoryPicker: () => pickerState(),
		useDirectoryPickerFilter: () => useState("")
	}
})
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/queries/account", () => ({ useAccountQuery: () => ({ data: { rootDirUuid: "root" } }) }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/lib/directoryRoots", () => ({ checkDirectoryRoot: vi.fn() }))
vi.mock("@/features/photos/lib/library", () => ({ addPhotosRoot: vi.fn() }))
vi.mock("@/features/videos/lib/library", () => ({ checkLibraryRoot: vi.fn() }))
vi.mock("@/features/videos/queries/library", () => ({ editLibraryConfig: vi.fn() }))
vi.mock("@/features/videos/hooks/useVideoLibraryView", () => ({
	useVideoLibraryView: () => ({ roots: [] }),
	useVideoRootNames: () => new Map()
}))
vi.mock("@/features/videos/store/useVideosDialogStore", () => ({ closeVideosChooser: vi.fn() }))
vi.mock("@/features/audio/lib/playlists", () => ({ addTracksToPlaylistAction: vi.fn() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { DirectoryChooserDialog } = await import("@/features/photos/components/directoryChooserDialog")
const { AddDirectoryDialog } = await import("@/features/videos/components/addDirectoryDialog")
const { RemoteDirectoryChooser } = await import("@/features/sync/components/remoteDirectoryChooser")
const { AddPlaylistTracksDialog } = await import("@/features/audio/components/addPlaylistTracksDialog")
const { registerAllActions } = await import("@/lib/keymap/actions")

registerAllActions()

const DOCS = "docs-0000-0000-0000-000000000000"

function file(name: string, mime: string): DriveItem {
	return narrowItem({
		uuid: `${name}-0000-0000-0000-000000000000` as UuidStr,
		stableUUID: undefined,
		parent: DOCS as UuidStr,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime, modified: 0n, size: 1n, key: "key", version: 2 } }
	} satisfies SdkFile)
}

const TEXT_FILES = [file("a.txt", "text/plain"), file("b.txt", "text/plain")]

const PICKERS = [
	{
		name: "the Photos chooser",
		message: "No directories",
		render: () => (
			<DirectoryChooserDialog
				roots={[]}
				readOnly={false}
				onClose={vi.fn()}
			/>
		)
	},
	{
		name: "the Videos chooser",
		message: "No directories",
		render: () => <AddDirectoryDialog replacing={[]} />
	},
	{
		name: "the sync remote chooser",
		message: "No directories",
		render: () => (
			<RemoteDirectoryChooser
				picker={pickerState() as unknown as Parameters<typeof RemoteDirectoryChooser>[0]["picker"]}
				disabled={false}
			/>
		)
	},
	{
		name: "Add tracks",
		message: "No matching files",
		render: () => (
			<AddPlaylistTracksDialog
				playlist={{ uuid: "playlist", name: "Mix", files: [] } as unknown as Playlist}
				onClose={vi.fn()}
			/>
		)
	}
]

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe.each(PICKERS)("$name", ({ message, render: element }) => {
	it("says nothing fits over a directory of other files, not that it is empty", () => {
		picker.items = TEXT_FILES

		render(element())

		expect(screen.getByText(message)).toBeTruthy()
		expect(screen.queryByTestId("listing-empty")).toBeNull()
	})

	it("keeps the empty-directory state for a directory with nothing in it", () => {
		picker.items = []

		render(element())

		expect(screen.getByTestId("listing-empty")).toBeTruthy()
		expect(screen.queryByText(message)).toBeNull()
	})
})
