import { vi, describe, it, expect, beforeEach } from "vitest"
import { type TFunction } from "i18next"

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("@filen/shared", async () => await import("@/tests/mocks/filenShared"))
vi.mock("expo-crypto", () => ({ randomUUID: vi.fn(() => "mock-uuid") }))
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }))
vi.mock("@/lib/router", () => ({ router: { push: vi.fn() } }))
vi.mock("@/lib/alerts", () => ({ default: { error: vi.fn() } }))
vi.mock("@/lib/prompts", () => ({ default: { alert: vi.fn(), input: vi.fn() } }))
vi.mock("@/lib/auth", () => ({ default: { getSdkClients: vi.fn() } }))
vi.mock("@/lib/serializer", () => ({ serialize: vi.fn((x: unknown) => JSON.stringify(x)) }))
vi.mock("@/lib/previewType", () => ({ getPreviewType: vi.fn(() => "other") }))
vi.mock("@/lib/cache", () => ({ default: { rootUuid: null, cacheNewFile: vi.fn(), cacheNewNormalDir: vi.fn() } }))
vi.mock("@/lib/sdkUnwrap", () => ({
	getRealDriveItemParent: vi.fn(() => null),
	makeDriveItemPublicLink: vi.fn(),
	unwrapParentUuid: vi.fn(() => null)
}))
vi.mock("@/components/ui/fullScreenLoadingModal", () => ({ runWithLoading: vi.fn() }))
vi.mock("@/features/drive/drive", () => ({ default: { getRootUuid: vi.fn() } }))
vi.mock("@/features/offline/offline", () => ({ default: { isItemTopLevelStoredSync: vi.fn(() => false) } }))
vi.mock("@/features/drive/driveSelectSession", () => ({ openDriveSelect: vi.fn() }))
vi.mock("@/features/contacts/contactsSelect", () => ({ selectContacts: vi.fn() }))
vi.mock("@/features/drive/store/useDrive.store", () => ({
	default: { getState: () => ({ selectedItems: [], toggleSelectedItem: vi.fn() }) }
}))
vi.mock("@/features/drive/driveSelectors", () => ({
	hiddenFilterAppliesTo: vi.fn(() => false),
	isFileItem: (item: { type: string }) => item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile",
	resolveDriveContainingDirectoryTarget: vi.fn(() => null),
	resolveDriveNavigationTarget: vi.fn(() => null)
}))
vi.mock("@/features/drive/components/item/menuActionsShared", () => ({ confirmedDriveAction: vi.fn(() => async () => {}) }))
vi.mock("@/features/drive/components/hiddenNameNotice", () => ({ notifyIfNameIsHidden: vi.fn() }))
vi.mock("@/features/drive/components/item/menuActionsUndecryptable", () => ({
	buildUndecryptableMenuButtons: vi.fn(() => [{ id: "undecryptableOnly" }])
}))
vi.mock("@/features/drive/components/item/menuActionsDownload", () => ({
	buildDownloadSubButtons: vi.fn(() => []),
	buildExportButton: vi.fn(() => null),
	buildOpenWithButton: vi.fn(() => null)
}))
vi.mock("@/features/drive/screens/driveSelect", () => ({ selectCopyDestination: vi.fn() }))
vi.mock("@/features/copy/copyRunner", () => ({ default: { start: vi.fn(() => "job-1") } }))

import { createMenuButtons } from "@/features/drive/components/item/menuActions"
import { buildCopyMenuButton, offersCopy } from "@/features/drive/components/item/menuActionsCopy"
import { selectCopyDestination } from "@/features/drive/screens/driveSelect"
import copyRunner from "@/features/copy/copyRunner"
import useDriveClipboardStore from "@/features/drive/store/useDriveClipboard.store"
import alerts from "@/lib/alerts"
import type { DrivePath, DrivePathType } from "@/hooks/useDrivePath"
import type { MenuButton } from "@/components/ui/menu"
import type { DriveItem } from "@/types"

const t = ((key: string) => key) as unknown as TFunction

// A Record so a new drive variant fails the typecheck until it is classified here. The hook module
// itself pulls expo-router and camera upload into the node test env.
const PATH_TYPE_KEYS: Record<DrivePathType, true> = {
	drive: true,
	sharedIn: true,
	recents: true,
	favorites: true,
	trash: true,
	sharedOut: true,
	offline: true,
	links: true,
	photos: true,
	linked: true
}
const DRIVE_PATH_TYPES = Object.keys(PATH_TYPE_KEYS) as DrivePathType[]

const ITEM_TYPES = ["file", "directory", "sharedFile", "sharedRootFile", "sharedDirectory", "sharedRootDirectory"] as const

function makeItem(type: DriveItem["type"], uuid = `${type}-1`, undecryptable = false): DriveItem {
	return {
		type,
		data: {
			uuid,
			undecryptable,
			favorited: false,
			decryptedMeta: { name: `${uuid}.bin`, size: 1n }
		}
	} as unknown as DriveItem
}

function makeDrivePath(type: DrivePathType): DrivePath {
	return { type, uuid: null } as DrivePath
}

function flatIds(buttons: MenuButton[]): string[] {
	return buttons.flatMap(button => [button.id, ...(button.subButtons ? flatIds(button.subButtons) : [])])
}

function find(buttons: MenuButton[], id: string): MenuButton | undefined {
	for (const button of buttons) {
		if (button.id === id) {
			return button
		}

		const nested = button.subButtons ? find(button.subButtons, id) : undefined

		if (nested) {
			return nested
		}
	}

	return undefined
}

const COPY_VIEWS: ReadonlySet<DrivePathType> = new Set(["drive", "favorites", "recents", "sharedIn", "sharedOut", "links", "photos", "offline"])
const MOVE_VIEWS: ReadonlySet<DrivePathType> = new Set(["drive", "favorites", "recents", "sharedOut", "links"])

beforeEach(() => {
	vi.clearAllMocks()
	useDriveClipboardStore.getState().clear()
})

describe("item menu Copy submenu gating", () => {
	for (const pathType of DRIVE_PATH_TYPES) {
		for (const itemType of ITEM_TYPES) {
			it(`${pathType} × ${itemType}`, () => {
				const buttons = createMenuButtons({
					item: makeItem(itemType),
					drivePath: makeDrivePath(pathType),
					isStoredOffline: false,
					showSelectToggle: false,
					t
				})
				const ids = flatIds(buttons)
				const own = itemType === "file" || itemType === "directory"

				// Duplicate ids blank the native menu.
				expect(new Set(ids).size).toBe(ids.length)

				if (!COPY_VIEWS.has(pathType)) {
					expect(ids).not.toContain("copyMenu")

					return
				}

				const copyMenu = find(buttons, "copyMenu")

				expect(copyMenu?.subButtons?.map(button => button.id)).toEqual(
					own && MOVE_VIEWS.has(pathType) ? ["copyToClipboard", "cutToClipboard", "copyTo"] : ["copyToClipboard", "copyTo"]
				)

				// Cut exactly where Move is, and the submenu right after it.
				expect(ids.includes("cutToClipboard")).toBe(ids.includes("move"))

				if (ids.includes("move")) {
					const topIds = buttons.map(button => button.id)

					expect(topIds.indexOf("copyMenu")).toBe(topIds.indexOf("move") + 1)
				}
			})
		}
	}

	it("offers no Copy for an undecryptable item", () => {
		const buttons = createMenuButtons({
			item: makeItem("file", "u1", true),
			drivePath: makeDrivePath("drive"),
			isStoredOffline: false,
			t
		})

		expect(flatIds(buttons)).not.toContain("copyMenu")
	})

	it("gates only 'Copy to…' on the network", () => {
		const button = buildCopyMenuButton({ items: [makeItem("file")], withCut: true, bulk: false, t })

		expect(button.requiresOnline).toBeFalsy()
		expect(button.subButtons?.map(sub => [sub.id, sub.requiresOnline === true])).toEqual([
			["copyToClipboard", false],
			["cutToClipboard", false],
			["copyTo", true]
		])
	})

	it("offersCopy matches every view but the trash and link views", () => {
		for (const pathType of DRIVE_PATH_TYPES) {
			expect(offersCopy(makeDrivePath(pathType))).toBe(COPY_VIEWS.has(pathType))
		}
	})
})

describe("Copy submenu actions", () => {
	const items = [makeItem("file", "a"), makeItem("directory", "b")]

	function sub(id: string, onDone?: () => void): MenuButton {
		const button = find([buildCopyMenuButton({ items, withCut: true, bulk: false, onDone, t })], id)

		if (!button?.onPress) {
			throw new Error(`no ${id}`)
		}

		return button
	}

	it("Copy and Cut put the items on the clipboard with their mode", () => {
		const onDone = vi.fn()

		sub("copyToClipboard", onDone).onPress?.()

		expect(useDriveClipboardStore.getState().entry).toEqual({ mode: "copy", items })

		sub("cutToClipboard", onDone).onPress?.()

		expect(useDriveClipboardStore.getState().entry).toEqual({ mode: "cut", items })
		expect(onDone).toHaveBeenCalledTimes(2)
	})

	it("'Copy to…' starts ONE job for every item into the picked directory", async () => {
		const picked = { destinationDir: { tag: "Dir" }, destination: { uuid: "dest", name: "Dest" } }
		const onDone = vi.fn()

		vi.mocked(selectCopyDestination).mockResolvedValueOnce(picked as never)

		await sub("copyTo", onDone).onPress?.()

		expect(selectCopyDestination).toHaveBeenCalledWith(items, "drive")
		expect(copyRunner.start).toHaveBeenCalledTimes(1)
		expect(copyRunner.start).toHaveBeenCalledWith({ items, ...picked })
		expect(onDone).toHaveBeenCalledTimes(1)
		expect(useDriveClipboardStore.getState().entry).toBeNull()
	})

	it("'Copy to…' starts nothing when the picker is dismissed", async () => {
		const onDone = vi.fn()

		vi.mocked(selectCopyDestination).mockResolvedValueOnce(null)

		await sub("copyTo", onDone).onPress?.()

		expect(copyRunner.start).not.toHaveBeenCalled()
		expect(onDone).not.toHaveBeenCalled()
	})

	it("'Copy to…' alerts when the job can't start", async () => {
		const onDone = vi.fn()
		const error = new Error("Invalid item type")

		vi.mocked(selectCopyDestination).mockResolvedValueOnce({ destinationDir: {}, destination: { uuid: null, name: "drive" } } as never)
		vi.mocked(copyRunner.start).mockImplementationOnce(() => {
			throw error
		})

		await sub("copyTo", onDone).onPress?.()

		expect(alerts.error).toHaveBeenCalledWith(error)
		expect(onDone).not.toHaveBeenCalled()
	})
})
