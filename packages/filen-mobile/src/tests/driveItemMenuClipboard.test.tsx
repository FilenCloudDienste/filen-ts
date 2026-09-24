// @vitest-environment happy-dom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { act, cleanup, render } from "@testing-library/react"

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("@filen/shared", async () => await import("@/tests/mocks/filenShared"))
vi.mock("@filen/sdk-rs", () => ({ AnyNormalDir_Tags: { Dir: "Dir", Root: "Root" } }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/components/ui/menu", () => ({ default: ({ children }: { children: unknown }) => children }))
vi.mock("@/features/drive/components/item/menuActions", () => ({ createMenuButtons: vi.fn(() => []) }))
vi.mock("@/features/drive/hooks/useLinkSaveable", () => ({ default: () => false }))
vi.mock("@/features/drive/linkedSave", () => ({ linkSaveTarget: () => null }))
vi.mock("@/lib/sdkUnwrap", () => ({ unwrapParentUuid: (parent: string | null) => parent }))
vi.mock("@/lib/cache", () => ({ default: { rootUuid: "root", uuidToAnyDriveItem: new Map(), directoryUuidToAnyNormalDir: new Map() } }))
vi.mock("@/lib/alerts", () => ({ default: { error: vi.fn() } }))
vi.mock("@/components/ui/fullScreenLoadingModal", () => ({ runWithLoading: vi.fn() }))
vi.mock("@/features/drive/drive", () => ({ default: { move: vi.fn() } }))
vi.mock("@/features/copy/copyRunner", () => ({ default: { start: vi.fn() } }))

import Menu from "@/features/drive/components/item/menu"
import { createMenuButtons } from "@/features/drive/components/item/menuActions"
import useDriveClipboardStore from "@/features/drive/store/useDriveClipboard.store"
import type { DrivePath, DrivePathType } from "@/hooks/useDrivePath"
import type { DriveItem } from "@/types"

function directory(uuid: string): DriveItem {
	return { type: "directory", data: { uuid, parent: "root", decryptedMeta: { name: uuid } } } as unknown as DriveItem
}

function renderRows(pathType: DrivePathType): void {
	const drivePath = { type: pathType, uuid: null } as DrivePath

	render(
		<>
			{["d1", "d2", "d3"].map(uuid => (
				<Menu
					key={uuid}
					type="context"
					item={directory(uuid)}
					drivePath={drivePath}
					isStoredOffline={false}
				>
					{uuid}
				</Menu>
			))}
		</>
	)
}

function copySomething(): void {
	act(() => {
		useDriveClipboardStore.getState().set({ mode: "copy", items: [directory("x")] })
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	useDriveClipboardStore.getState().clear()
})

afterEach(() => {
	cleanup()
})

describe("directory row menus and the clipboard", () => {
	it("re-render on a clipboard change where Paste into is offered", () => {
		renderRows("drive")

		expect(createMenuButtons).toHaveBeenCalledTimes(3)

		copySomething()

		expect(createMenuButtons).toHaveBeenCalledTimes(6)
	})

	it("ignore the clipboard in views that never offer Paste into", () => {
		for (const pathType of ["sharedIn", "offline", "trash", "photos"] as const) {
			cleanup()
			vi.mocked(createMenuButtons).mockClear()
			useDriveClipboardStore.getState().clear()

			renderRows(pathType)
			copySomething()

			expect(createMenuButtons).toHaveBeenCalledTimes(3)
		}
	})
})
