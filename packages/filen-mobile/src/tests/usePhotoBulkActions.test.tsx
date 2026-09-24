// @vitest-environment happy-dom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("@filen/shared", async () => await import("@/tests/mocks/filenShared"))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("expo-file-system", () => ({}))
vi.mock("expo-media-library/legacy", () => ({ saveToLibraryAsync: vi.fn() }))
vi.mock("@/lib/bulkOps", () => ({ runBulk: vi.fn() }))
vi.mock("@/lib/tmp", () => ({ newTmpDir: vi.fn() }))
vi.mock("@/lib/sdkUnwrap", () => ({ getRealDriveItemParent: vi.fn() }))
vi.mock("@/lib/alerts", () => ({ default: { error: vi.fn() } }))
vi.mock("@/hooks/useMediaPermissions", () => ({ hasAllNeededMediaPermissions: vi.fn() }))
vi.mock("@/features/drive/driveDownload", () => ({ downloadDriveItemToDevice: vi.fn() }))
vi.mock("@/features/drive/drive", () => ({ default: { favorite: vi.fn(), trash: vi.fn() } }))
vi.mock("@/features/offline/offline", () => ({ default: { storeFile: vi.fn() } }))
vi.mock("@/features/transfers/transfers", () => ({ default: { download: vi.fn() } }))
vi.mock("@/features/drive/driveSelectors", () => ({
	aggregateDriveSelectionFlags: (items: { data: { undecryptable: boolean } }[]) => ({
		includesFavorited: false,
		everyImageOrVideoFile: true,
		includesUndecryptable: items.some(item => item.data.undecryptable)
	})
}))
vi.mock("@/features/drive/driveSelectSession", () => ({ selectCopyDestination: vi.fn() }))
vi.mock("@/features/copy/copyRunner", () => ({ default: { start: vi.fn(() => "job-1") } }))

import usePhotoBulkActions from "@/features/photos/hooks/usePhotoBulkActions"
import useDriveStore from "@/features/drive/store/useDrive.store"
import useDriveClipboardStore from "@/features/drive/store/useDriveClipboard.store"
import { selectCopyDestination } from "@/features/drive/driveSelectSession"
import copyRunner from "@/features/copy/copyRunner"
import type { DriveItem, DriveItemFileExtracted } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"
import type { MenuButton } from "@/components/ui/menu"

const drivePath = { type: "photos", uuid: null } as DrivePath

function photo(uuid: string, undecryptable = false): DriveItemFileExtracted {
	return { type: "file", data: { uuid, undecryptable, decryptedMeta: { name: `${uuid}.jpg` } } } as unknown as DriveItemFileExtracted
}

function menu(items: DriveItemFileExtracted[]): MenuButton[] {
	return renderHook(() => usePhotoBulkActions({ items, drivePath })).result.current
}

function copySub(buttons: MenuButton[], id: string): MenuButton | undefined {
	return buttons.find(button => button.id === "bulkCopyMenu")?.subButtons?.find(button => button.id === id)
}

beforeEach(() => {
	vi.clearAllMocks()
	useDriveClipboardStore.getState().clear()
})

afterEach(() => {
	cleanup()
	act(() => {
		useDriveStore.getState().clearSelectedItems()
	})
})

describe("usePhotoBulkActions Copy", () => {
	it("offers Copy and 'Copy to…', never Cut, right after Favorite", () => {
		const items = [photo("a"), photo("b")]

		act(() => {
			useDriveStore.getState().selectAllItems(items)
		})

		const buttons = menu(items)

		expect(buttons.map(button => button.id).slice(0, 3)).toEqual(["selectAll", "bulkFavorite", "bulkCopyMenu"])
		expect(buttons.find(button => button.id === "bulkCopyMenu")?.subButtons?.map(button => button.id)).toEqual([
			"bulkCopyToClipboard",
			"bulkCopyTo"
		])
	})

	it("offers no Copy with an undecryptable photo selected", () => {
		const items = [photo("a"), photo("b", true)]

		act(() => {
			useDriveStore.getState().selectAllItems(items)
		})

		expect(menu(items).map(button => button.id)).not.toContain("bulkCopyMenu")
	})

	it("Copy puts the selection on the clipboard and ends selection mode", () => {
		const items = [photo("a"), photo("b")]

		act(() => {
			useDriveStore.getState().selectAllItems(items)
		})

		const copy = copySub(menu(items), "bulkCopyToClipboard")

		act(() => {
			copy?.onPress?.()
		})

		expect(useDriveClipboardStore.getState().entry).toEqual({ mode: "copy", items: items as DriveItem[] })
		expect(useDriveStore.getState().selectedItems).toEqual([])
	})

	it("'Copy to…' starts ONE job for the whole selection", async () => {
		const items = [photo("a"), photo("b"), photo("c")]
		const picked = { destinationDir: { tag: "Dir" }, destination: { uuid: "dest", name: "Dest" } }

		vi.mocked(selectCopyDestination).mockResolvedValueOnce(picked as never)

		act(() => {
			useDriveStore.getState().selectAllItems(items)
		})

		const copyTo = copySub(menu(items), "bulkCopyTo")

		expect(copyTo?.requiresOnline).toBe(true)

		await act(async () => {
			await copyTo?.onPress?.()
		})

		expect(copyRunner.start).toHaveBeenCalledTimes(1)
		expect(copyRunner.start).toHaveBeenCalledWith({ items, ...picked })
	})
})
