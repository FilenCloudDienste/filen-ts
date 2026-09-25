// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { Dir, UuidStr } from "@filen/sdk-rs"

const { pasteClipboard } = vi.hoisted(() => ({ pasteClipboard: vi.fn(() => Promise.resolve()) }))

vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	return { queryClient: new QueryClient() }
})
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard: vi.fn() }))
vi.mock("@/features/drive/lib/dnd", () => ({ performMove: vi.fn() }))
vi.mock("@/features/drive/lib/clipboard", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/clipboard")>()),
	pasteClipboard
}))
vi.mock("@/features/drive/lib/clipboardRecheck", () => ({ recheckClipboard: () => Promise.resolve(true) }))
vi.mock("@/features/drive/queries/drive", () => ({
	cachedDirectoryName: () => "inner",
	destinationDirectoryName: () => Promise.resolve("inner"),
	directoryNameScope: () => "drive"
}))
vi.mock("@/lib/storage/adapter", () => ({ kvGetJson: () => Promise.resolve(null), kvSetJson: () => Promise.resolve() }))

import "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { registerAction } from "@/lib/keymap/registry"
import { DRIVE_ACTIONS } from "@/features/drive/lib/keymap"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveClipboard } from "@/features/drive/hooks/useDriveClipboard"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function dirItem(label: string, parent: string): DriveItem {
	return narrowItem({
		uuid: testUuid(label),
		parent: testUuid(parent),
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } }
	} satisfies Dir)
}

function seed(uuid: string | null, items: DriveItem[]): void {
	queryClient.setQueryData(["drive", "listing", { variant: "drive", uuid }], items)
}

beforeAll(() => {
	for (const def of DRIVE_ACTIONS.filter(action => ["drive.copy", "drive.cut", "drive.paste"].includes(action.id))) {
		registerAction(def)
	}
})

beforeEach(() => {
	queryClient.clear()
	useDriveClipboardStore.getState().clear()
})

describe("useDriveClipboard paste guard", () => {
	// A directory opened from search: its route chain is just itself.
	function renderOpenedFromSearch() {
		return renderHook(() =>
			useDriveClipboard({
				variant: "drive",
				uuid: testUuid("inner"),
				ancestry: [testUuid("inner")],
				listing: [],
				selectedItems: [],
				isOnline: true,
				isDialogOpen: false
			})
		)
	}

	it("refuses to paste a directory into its own subtree reached from search", () => {
		seed(null, [dirItem("docs", "root")])
		seed(testUuid("docs"), [dirItem("inner", "docs")])
		useDriveClipboardStore.getState().set({ mode: "cut", items: [dirItem("docs", "root")] })

		expect(renderOpenedFromSearch().result.current.enabled).toBe(false)
	})

	// Nothing re-renders the listing when a move elsewhere changes where it sits.
	it("asks again on use, after the tree changed under an unchanged render", async () => {
		seed(null, [dirItem("docs", "root"), dirItem("work", "root")])
		seed(testUuid("work"), [dirItem("inner", "work")])
		useDriveClipboardStore.getState().set({ mode: "cut", items: [dirItem("docs", "root")] })

		const { result } = renderOpenedFromSearch()

		expect(result.current.enabled).toBe(true)

		// "work" moved into "docs" meanwhile.
		seed(null, [dirItem("docs", "root")])
		seed(testUuid("docs"), [dirItem("work", "docs")])

		await act(async () => {
			result.current.run()
			await new Promise(resolve => setTimeout(resolve, 0))
		})

		expect(pasteClipboard).not.toHaveBeenCalled()
	})
})
