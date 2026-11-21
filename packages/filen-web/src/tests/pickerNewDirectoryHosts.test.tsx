// @vitest-environment happy-dom

// Every directory picker offers New directory in its footer: a directory created there is created in the one open
// and opened, so the picker's confirm picks it. Photos and Videos offer it only where a pick could land.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

const { enter, createDirectory } = vi.hoisted(() => ({ enter: vi.fn(), createDirectory: vi.fn() }))

const DOCS = "docs-0000-0000-0000-000000000000"
const NEW = "new0-0000-0000-0000-000000000000"

function pickerState() {
	return {
		pathStack: [DOCS],
		targetUuid: DOCS,
		listingQuery: { status: "success", data: [], refetch: () => Promise.resolve() },
		items: [],
		namesQuery: { data: { [DOCS]: "Docs" } },
		descend: vi.fn(),
		enter,
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
vi.mock("@/features/drive/lib/actions", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/actions")>()),
	createDirectory
}))
vi.mock("@/features/drive/lib/archiveHelpers", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/archiveHelpers")>()),
	itemNameError: () => Promise.resolve(null)
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
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
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard: vi.fn() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { MoveTargetDialog } = await import("@/features/drive/components/moveTargetDialog")
const { DirectoryChooserDialog } = await import("@/features/photos/components/directoryChooserDialog")
const { AddDirectoryDialog } = await import("@/features/videos/components/addDirectoryDialog")

function created(): DriveItem {
	return narrowItem({
		uuid: NEW as UuidStr,
		parent: DOCS as UuidStr,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Reports" } }
	} satisfies Dir)
}

const HOSTS = [
	{
		name: "the move dialog",
		render: () => (
			<MoveTargetDialog
				items={[]}
				onClose={vi.fn()}
			/>
		)
	},
	{
		name: "the copy dialog",
		render: () => (
			<MoveTargetDialog
				mode="copy"
				items={[]}
				onClose={vi.fn()}
			/>
		)
	},
	{
		name: "the Photos chooser",
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
		render: () => <AddDirectoryDialog replacing={[]} />
	}
]

beforeEach(() => {
	createDirectory.mockResolvedValue({ status: "success", item: created() })
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe.each(HOSTS)("$name", ({ render: element }) => {
	it("creates a directory in the open one from its footer, then opens it", async () => {
		render(element())

		const button = screen.getByRole("button", { name: "New directory" })

		expect(button.closest("[data-slot='dialog-footer']")).not.toBeNull()

		fireEvent.click(button)
		fireEvent.change(screen.getByRole("textbox", { name: "Name of the new directory" }), { target: { value: "Reports" } })

		await act(async () => {
			fireEvent.keyDown(screen.getByRole("textbox", { name: "Name of the new directory" }), { key: "Enter" })
			await Promise.resolve()
		})

		expect(createDirectory).toHaveBeenCalledExactlyOnceWith(DOCS, "Reports")
		expect(enter).toHaveBeenCalledExactlyOnceWith(DOCS, NEW)
	})
})

describe("the Photos chooser", () => {
	it("offers no new directory in a read-only library", () => {
		render(
			<DirectoryChooserDialog
				roots={[]}
				readOnly
				onClose={vi.fn()}
			/>
		)

		expect(screen.queryByRole("button", { name: "New directory" })).toBeNull()
	})

	it("offers none inside a photos directory, where nothing could be picked", () => {
		render(
			<DirectoryChooserDialog
				roots={[{ uuid: DOCS, name: "Docs" }]}
				readOnly={false}
				onClose={vi.fn()}
			/>
		)

		expect(screen.queryByRole("button", { name: "New directory" })).toBeNull()
	})
})
