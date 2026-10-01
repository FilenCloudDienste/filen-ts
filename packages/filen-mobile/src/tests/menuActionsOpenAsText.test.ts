import { vi, describe, it, expect, beforeEach } from "vitest"
import { type TFunction } from "i18next"

const h = vi.hoisted(() => ({
	open: vi.fn()
}))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("@filen/shared", async () => await import("@/tests/mocks/filenShared"))
vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))
vi.mock("@/components/textEditor/constants", () => ({ MAX_TEXT_BYTES: 1024 }))
vi.mock("@/stores/useDrivePreview.store", () => ({ default: { getState: () => ({ open: h.open }) } }))
vi.mock("expo-crypto", () => ({ randomUUID: vi.fn(() => "mock-uuid") }))
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }))
vi.mock("@/lib/router", () => ({ router: { push: vi.fn() } }))
vi.mock("@/lib/alerts", () => ({ default: { error: vi.fn() } }))
vi.mock("@/lib/i18n", async () => await import("@/tests/mocks/i18n"))
vi.mock("@/lib/prompts", () => ({ default: { alert: vi.fn(), input: vi.fn() } }))
vi.mock("@/features/drive/queries/useDriveItemPublicLinkStatus.query", () => ({
	fetchData: vi.fn(),
	publicLinkUrlFromStatus: vi.fn()
}))
vi.mock("@/lib/serializer", () => ({ serialize: vi.fn((x: unknown) => JSON.stringify(x)) }))
vi.mock("@filen/sdk-rs", () => ({ AnyNormalDir_Tags: { Dir: "Dir", Root: "Root" } }))
vi.mock("@/lib/cache", () => ({
	default: {
		rootUuid: "root",
		cacheNewFile: vi.fn(),
		cacheNewNormalDir: vi.fn(),
		uuidToAnyDriveItem: new Map(),
		directoryUuidToAnyNormalDir: new Map()
	}
}))
vi.mock("@/lib/sdkUnwrap", () => ({
	getRealDriveItemParent: vi.fn(() => null),
	makeDriveItemPublicLink: vi.fn(),
	unwrapParentUuid: vi.fn(() => null),
	normalParentUuidOf: vi.fn(() => null)
}))
vi.mock("@/components/ui/fullScreenLoadingModal", () => ({ runWithLoading: vi.fn() }))
vi.mock("@/features/drive/drive", () => ({ default: { getRootUuid: vi.fn() } }))
vi.mock("@/features/offline/offline", () => ({ default: { isItemTopLevelStoredSync: vi.fn(() => false) } }))
vi.mock("@/features/contacts/contactsSelect", () => ({ selectContacts: vi.fn() }))
vi.mock("@/features/drive/store/useDrive.store", () => ({
	default: { getState: () => ({ toggleSelectedItem: vi.fn() }) }
}))
vi.mock("@/features/drive/driveSelectors", async () => {
	const actual = await vi.importActual<typeof import("@/features/drive/driveSelectors")>("@/features/drive/driveSelectors")

	return {
		isOwnEditableView: actual.isOwnEditableView,
		isOwnItemView: actual.isOwnItemView,
		offersItemInfo: actual.offersItemInfo,
		canNavigateIntoDirectory: vi.fn(() => false),
		hiddenFilterAppliesTo: vi.fn(() => false),
		isFileItem: (item: { type: string }) => item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile",
		isDirectoryItem: (item: { type: string }) =>
			item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory",
		resolveDriveContainingDirectoryTarget: vi.fn(() => null),
		resolveDriveNavigationTarget: vi.fn(() => null),
		everyItemAlreadyIn: vi.fn(() => false)
	}
})
vi.mock("@/lib/confirmedAction", () => ({ confirmedAction: vi.fn(() => async () => {}) }))
vi.mock("@/features/drive/components/hiddenNameNotice", () => ({ notifyIfNameIsHidden: vi.fn() }))
vi.mock("@/features/drive/components/item/menuActionsUndecryptable", () => ({
	buildUndecryptableMenuButtons: vi.fn(() => [{ id: "undecryptableOnly" }])
}))
vi.mock("@/features/drive/components/item/menuActionsDownload", () => ({
	buildDownloadSubButtons: vi.fn(() => []),
	buildExportButton: vi.fn(() => null),
	buildOpenWithButton: vi.fn(() => null)
}))
vi.mock("@/features/drive/driveSelectSession", () => ({ openDriveSelect: vi.fn(), selectCopyDestination: vi.fn() }))
vi.mock("@/features/copy/copyRunner", () => ({ default: { start: vi.fn(() => "job-1") } }))
vi.mock("@/features/drive/linkedSave", () => ({
	buildSaveToCloudDriveButton: vi.fn(() => null),
	linkAllowsDownload: vi.fn(() => true)
}))

import { createMenuButtons } from "@/features/drive/components/item/menuActions"
import { buildDownloadSubButtons } from "@/features/drive/components/item/menuActionsDownload"
import type { DrivePath, DrivePathType } from "@/hooks/useDrivePath"
import type { MenuButton } from "@/components/ui/menu"
import type { DriveItem } from "@/types"

const t = ((key: string) => key) as unknown as TFunction

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

function makeItem(
	type: DriveItem["type"],
	{ name, mime = "application/octet-stream", size = 10n }: { name: string; mime?: string; size?: bigint }
): DriveItem {
	return {
		type,
		data: {
			uuid: `${type}-1`,
			undecryptable: false,
			favorited: false,
			size,
			decryptedMeta: { name, mime, size }
		}
	} as unknown as DriveItem
}

function makeDrivePath(type: DrivePathType): DrivePath {
	return { type, uuid: null } as DrivePath
}

function ids(buttons: MenuButton[]): string[] {
	return buttons.flatMap(button => [button.id, ...(button.subButtons ? ids(button.subButtons) : [])])
}

function menuFor(item: DriveItem, opts: { pathType?: DrivePathType; isPreview?: boolean } = {}): MenuButton[] {
	return createMenuButtons({
		item,
		drivePath: makeDrivePath(opts.pathType ?? "drive"),
		isStoredOffline: false,
		isPreview: opts.isPreview,
		t
	})
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("item menu Open as text", () => {
	for (const pathType of DRIVE_PATH_TYPES) {
		it(`is offered for an unrecognised file in the ${pathType} view`, () => {
			expect(ids(menuFor(makeItem("file", { name: "data.bin" }), { pathType }))).toContain("openAsText")
		})
	}

	it("is offered for shared file variants", () => {
		expect(ids(menuFor(makeItem("sharedFile", { name: "data.bin" }), { pathType: "sharedIn" }))).toContain("openAsText")
		expect(ids(menuFor(makeItem("sharedRootFile", { name: "data.bin" }), { pathType: "sharedIn" }))).toContain("openAsText")
	})

	it("is not offered for a file something recognises — by extension, well-known name or mime", () => {
		expect(ids(menuFor(makeItem("file", { name: "photo.jpg" })))).not.toContain("openAsText")
		expect(ids(menuFor(makeItem("file", { name: "notes.txt" })))).not.toContain("openAsText")
		expect(ids(menuFor(makeItem("file", { name: "main.rs" })))).not.toContain("openAsText")
		expect(ids(menuFor(makeItem("file", { name: "LICENSE" })))).not.toContain("openAsText")
		expect(ids(menuFor(makeItem("file", { name: "clip", mime: "video/mp4" })))).not.toContain("openAsText")
	})

	it("is not offered for a directory", () => {
		expect(ids(menuFor(makeItem("directory", { name: "data.bin" })))).not.toContain("openAsText")
	})

	it("is offered up to the text viewer's size cap and not past it", () => {
		expect(ids(menuFor(makeItem("file", { name: "data.bin", size: 1024n })))).toContain("openAsText")
		expect(ids(menuFor(makeItem("file", { name: "data.bin", size: 1025n })))).not.toContain("openAsText")
	})

	it("is not offered inside the preview", () => {
		expect(ids(menuFor(makeItem("file", { name: "data.bin" }), { isPreview: true }))).not.toContain("openAsText")
	})

	it("is not offered for an undecryptable file", () => {
		const item = { ...makeItem("file", { name: "data.bin" }) } as DriveItem

		item.data = { ...item.data, undecryptable: true, decryptedMeta: null } as DriveItem["data"]

		expect(ids(menuFor(item))).not.toContain("openAsText")
	})

	it("opens just that file in the text viewer, as text", () => {
		const item = makeItem("file", { name: "data.bin" })
		const drivePath = makeDrivePath("drive")
		const button = createMenuButtons({ item, drivePath, isStoredOffline: false, t }).find(b => b.id === "openAsText")

		button?.onPress?.()

		expect(h.open).toHaveBeenCalledTimes(1)
		expect(h.open).toHaveBeenCalledWith({
			initialItem: {
				type: "drive",
				data: {
					item,
					drivePath,
					asText: true
				}
			},
			items: []
		})
	})

	// The OS photo library reads a file's type from its extension: save-to-photos is decided by name alone.
	it("hands the download submenu the name-only preview type", () => {
		menuFor(makeItem("file", { name: "clip", mime: "video/mp4" }))

		expect(vi.mocked(buildDownloadSubButtons).mock.calls[0]?.[0].previewType).toBe("unknown")

		menuFor(makeItem("file", { name: "clip.mp4", mime: "video/mp4" }))

		expect(vi.mocked(buildDownloadSubButtons).mock.calls[1]?.[0].previewType).toBe("video")
	})
})
