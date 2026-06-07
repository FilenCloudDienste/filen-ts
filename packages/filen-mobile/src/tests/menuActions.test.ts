import { vi, describe, it, expect, beforeEach } from "vitest"
import { type TFunction } from "i18next"

// ---------------------------------------------------------------------------
// Hoisted mocks (must be hoisted before imports so vi.mock factories can use them)
// ---------------------------------------------------------------------------

const { mockConfirmedAction } = vi.hoisted(() => ({
	mockConfirmedAction: vi.fn((_opts: unknown) => async () => {})
}))

vi.mock("@/lib/confirmedAction", () => ({
	confirmedAction: mockConfirmedAction
}))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("@/lib/i18n", () => ({
	t: (key: string) => key,
	default: { t: (key: string) => key }
}))

vi.mock("@/lib/auth", () => ({
	default: { getSdkClients: vi.fn() }
}))

vi.mock("@/lib/alerts", () => ({
	default: { error: vi.fn() }
}))

vi.mock("@/lib/prompts", () => ({
	default: { alert: vi.fn(), input: vi.fn() }
}))

vi.mock("expo-router", () => ({
	router: { push: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false) }
}))

vi.mock("@/components/ui/fullScreenLoadingModal", () => ({
	runWithLoading: vi.fn(async (fn: (defer?: (cleanup: () => void) => void) => Promise<unknown>) => {
		try {
			const data = await fn()

			return { success: true, data }
		} catch (error) {
			return { success: false, error }
		}
	})
}))

vi.mock("@/features/drive/drive", () => ({
	default: {
		restore: vi.fn(),
		deletePermanently: vi.fn(),
		trash: vi.fn()
	}
}))

vi.mock("@/features/offline/offline", () => ({
	default: { storeFile: vi.fn(), storeDirectory: vi.fn() }
}))

vi.mock("@/features/transfers/transfers", () => ({
	default: { download: vi.fn(), upload: vi.fn() }
}))

vi.mock("@/lib/tmp", () => ({
	newTmpDir: vi.fn(() => ({ uri: "file:///tmp/filen-test/" }))
}))

vi.mock("expo-file-system", () => ({
	File: class MockFile {
		uri: string
		name: string
		exists: boolean
		parentDirectory: { exists: boolean; create: () => void; delete: () => void }

		constructor(uri: string) {
			this.uri = uri
			this.name = uri.split("/").pop() ?? "file"
			this.exists = false
			this.parentDirectory = {
				exists: false,
				create: vi.fn(),
				delete: vi.fn()
			}

			this.delete = vi.fn()
		}

		delete = vi.fn()
	},
	Directory: class MockDirectory {
		uri: string
		exists: boolean
		parentDirectory: { exists: boolean; create: () => void; delete: () => void }

		constructor(uri: string) {
			this.uri = uri
			this.exists = false
			this.parentDirectory = {
				exists: false,
				create: vi.fn(),
				delete: vi.fn()
			}

			this.delete = vi.fn()
		}

		delete = vi.fn()
	},
	Paths: {
		join: (...parts: string[]) => parts.join("/"),
		extname: (name: string) => {
			const dot = name.lastIndexOf(".")

			return dot >= 0 ? name.slice(dot) : ""
		}
	}
}))

vi.mock("expo-media-library/legacy", () => ({
	saveToLibraryAsync: vi.fn()
}))

vi.mock("@/hooks/useMediaPermissions", () => ({
	hasAllNeededMediaPermissions: vi.fn().mockResolvedValue(true)
}))

vi.mock("@/lib/share", () => ({
	shareTmpFile: vi.fn().mockResolvedValue({ success: true })
}))

vi.mock("@/lib/utils", () => ({
	resolveMimeType: vi.fn(() => "application/octet-stream"),
	unwrapSdkError: vi.fn(() => null)
}))

vi.mock("@/lib/cache", () => ({
	default: { directoryUuidToAnyNormalDir: new Map() }
}))

vi.mock("@/features/drive/screens/driveSelect", () => ({
	selectDriveItems: vi.fn()
}))

vi.mock("@/features/drive/driveDownload", () => ({
	downloadDriveItemToDevice: vi.fn()
}))

// @/features/drive/driveSelectors imports @/constants (Platform.select) — stub it.
vi.mock("@/constants", () => ({
	EXPO_IMAGE_SUPPORTED_EXTENSIONS: new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]),
	EXPO_VIDEO_SUPPORTED_EXTENSIONS: new Set([".mp4", ".mov"])
}))

// @/lib/serializer is pulled in transitively.
vi.mock("@/lib/serializer", () => ({
	serialize: (x: unknown) => JSON.stringify(x),
	deserialize: (x: string) => JSON.parse(x)
}))

// ---------------------------------------------------------------------------
// Imports (after vi.mock calls)
// ---------------------------------------------------------------------------

import { buildUndecryptableMenuButtons } from "@/features/drive/components/item/menuActionsUndecryptable"
import { confirmedDriveAction } from "@/features/drive/components/item/menuActionsShared"
import { buildDownloadSubButtons } from "@/features/drive/components/item/menuActionsDownload"
import type { DriveItem } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"
import type { PreviewType } from "@/lib/previewType"
import type { OfflineParent } from "@/features/offline/offlineHelpers"

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

const t = ((key: string) => key) as unknown as TFunction

function makeFile(decryptedMeta: Record<string, unknown> | null = { name: "file.txt" }): DriveItem {
	return {
		type: "file",
		data: {
			uuid: "f1",
			undecryptable: false,
			decryptedMeta
		} as DriveItem["data"]
	} as DriveItem
}

function makeDirectory(decryptedMeta: Record<string, unknown> | null = { name: "dir" }): DriveItem {
	return {
		type: "directory",
		data: {
			uuid: "d1",
			undecryptable: false,
			decryptedMeta
		} as DriveItem["data"]
	} as DriveItem
}

function makeSharedRootDirectory(): DriveItem {
	return {
		type: "sharedRootDirectory",
		data: {
			uuid: "srd1",
			undecryptable: false,
			decryptedMeta: null
		} as DriveItem["data"]
	} as DriveItem
}

function makeSharedFile(decryptedMeta: Record<string, unknown> | null = { name: "shared.txt" }): DriveItem {
	return {
		type: "sharedFile",
		data: {
			uuid: "sf1",
			undecryptable: false,
			decryptedMeta
		} as DriveItem["data"]
	} as DriveItem
}

function makeDrivePath(type: DrivePath["type"]): DrivePath {
	return { type, uuid: null } as DrivePath
}

function makeOfflineParent(): OfflineParent {
	return { uuid: "parent-1", name: "parent" } as unknown as OfflineParent
}

// ---------------------------------------------------------------------------
// #33 — buildUndecryptableMenuButtons
// ---------------------------------------------------------------------------

describe("buildUndecryptableMenuButtons (#33)", () => {
	describe("drivePath.type='trash' + file", () => {
		it("returns [restore, deletePermanently] for a file", () => {
			const buttons = buildUndecryptableMenuButtons({
				item: makeFile(),
				drivePath: makeDrivePath("trash"),
				t
			})
			const ids = buttons.map(b => b.id)

			expect(ids).toEqual(["restore", "deletePermanently"])
		})

		it("returns [restore, deletePermanently] for a directory", () => {
			const buttons = buildUndecryptableMenuButtons({
				item: makeDirectory(),
				drivePath: makeDrivePath("trash"),
				t
			})
			const ids = buttons.map(b => b.id)

			expect(ids).toEqual(["restore", "deletePermanently"])
		})
	})

	describe("drivePath.type='trash' + non-file/dir type", () => {
		it("returns [] for sharedRootDirectory in trash", () => {
			const buttons = buildUndecryptableMenuButtons({
				item: makeSharedRootDirectory(),
				drivePath: makeDrivePath("trash"),
				t
			})

			expect(buttons).toHaveLength(0)
		})
	})

	describe("drivePath.type='drive' (non-restricted)", () => {
		it("returns [trash] for drive type", () => {
			const buttons = buildUndecryptableMenuButtons({
				item: makeFile(),
				drivePath: makeDrivePath("drive"),
				t
			})
			const ids = buttons.map(b => b.id)

			expect(ids).toEqual(["trash"])
		})

		it("returns [trash] for recents type", () => {
			const buttons = buildUndecryptableMenuButtons({
				item: makeFile(),
				drivePath: makeDrivePath("recents"),
				t
			})
			const ids = buttons.map(b => b.id)

			expect(ids).toEqual(["trash"])
		})

		it("returns [trash] for favorites type", () => {
			const buttons = buildUndecryptableMenuButtons({
				item: makeFile(),
				drivePath: makeDrivePath("favorites"),
				t
			})
			const ids = buttons.map(b => b.id)

			expect(ids).toEqual(["trash"])
		})
	})

	describe("drivePath.type='sharedIn' (restricted)", () => {
		it("returns [] for sharedIn type", () => {
			const buttons = buildUndecryptableMenuButtons({
				item: makeFile(),
				drivePath: makeDrivePath("sharedIn"),
				t
			})

			expect(buttons).toHaveLength(0)
		})
	})

	describe("drivePath.type='offline' (restricted)", () => {
		it("returns [] for offline type", () => {
			const buttons = buildUndecryptableMenuButtons({
				item: makeFile(),
				drivePath: makeDrivePath("offline"),
				t
			})

			expect(buttons).toHaveLength(0)
		})
	})

	describe("drivePath.type='linked' (restricted)", () => {
		it("returns [] for linked type", () => {
			const buttons = buildUndecryptableMenuButtons({
				item: makeFile(),
				drivePath: makeDrivePath("linked"),
				t
			})

			expect(buttons).toHaveLength(0)
		})
	})

	describe("button properties", () => {
		it("restore button has requiresOnline=true", () => {
			const buttons = buildUndecryptableMenuButtons({
				item: makeFile(),
				drivePath: makeDrivePath("trash"),
				t
			})
			const restore = buttons.find(b => b.id === "restore")

			expect(restore?.requiresOnline).toBe(true)
		})

		it("deletePermanently button has destructive=true", () => {
			const buttons = buildUndecryptableMenuButtons({
				item: makeFile(),
				drivePath: makeDrivePath("trash"),
				t
			})
			const del = buttons.find(b => b.id === "deletePermanently")

			expect(del?.destructive).toBe(true)
		})

		it("trash button has requiresOnline=true and destructive=true", () => {
			const buttons = buildUndecryptableMenuButtons({
				item: makeFile(),
				drivePath: makeDrivePath("drive"),
				t
			})
			const trash = buttons.find(b => b.id === "trash")

			expect(trash?.requiresOnline).toBe(true)
			expect(trash?.destructive).toBe(true)
		})
	})
})

// ---------------------------------------------------------------------------
// #34 — confirmedDriveAction dismiss predicate
// ---------------------------------------------------------------------------

describe("confirmedDriveAction (#34)", () => {
	beforeEach(() => {
		mockConfirmedAction.mockClear()
	})

	it("passes dismiss=undefined when dismissOnSuccess=false", () => {
		confirmedDriveAction({
			item: makeFile(),
			promptTitle: "title",
			promptMessage: "message",
			promptOkText: "ok",
			action: async () => {},
			dismissOnSuccess: false
		})

		expect(mockConfirmedAction).toHaveBeenCalledTimes(1)
		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: unknown }

		expect(callArgs.dismiss).toBeUndefined()
	})

	it("passes a dismiss function returning true when dismissOnSuccess=true and item is a file", () => {
		confirmedDriveAction({
			item: makeFile(),
			promptTitle: "title",
			promptMessage: "message",
			promptOkText: "ok",
			action: async () => {},
			dismissOnSuccess: true
		})

		expect(mockConfirmedAction).toHaveBeenCalledTimes(1)
		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: (() => boolean) | undefined }

		expect(typeof callArgs.dismiss).toBe("function")
		expect(callArgs.dismiss?.()).toBe(true)
	})

	it("passes a dismiss function returning false when dismissOnSuccess=true and item is a directory", () => {
		confirmedDriveAction({
			item: makeDirectory(),
			promptTitle: "title",
			promptMessage: "message",
			promptOkText: "ok",
			action: async () => {},
			dismissOnSuccess: true
		})

		expect(mockConfirmedAction).toHaveBeenCalledTimes(1)
		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: (() => boolean) | undefined }

		expect(typeof callArgs.dismiss).toBe("function")
		expect(callArgs.dismiss?.()).toBe(false)
	})

	it("dismiss function returns true for sharedFile (previewable file type)", () => {
		confirmedDriveAction({
			item: makeSharedFile(),
			promptTitle: "title",
			promptMessage: "message",
			promptOkText: "ok",
			action: async () => {},
			dismissOnSuccess: true
		})

		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: (() => boolean) | undefined }

		// sharedFile is a previewable file type, so dismiss returns true (closes the
		// sharedIn/sharedOut/links gallery preview after remove-share / disable-link).
		expect(callArgs.dismiss?.()).toBe(true)
	})

	it("dismiss function returns true for sharedRootFile (previewable file type)", () => {
		confirmedDriveAction({
			item: { type: "sharedRootFile", data: { uuid: "srf1", undecryptable: false, decryptedMeta: null } } as DriveItem,
			promptTitle: "title",
			promptMessage: "message",
			promptOkText: "ok",
			action: async () => {},
			dismissOnSuccess: true
		})

		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: (() => boolean) | undefined }

		expect(callArgs.dismiss?.()).toBe(true)
	})

	it("dismiss function returns false for sharedRootDirectory (directories aren't previewed)", () => {
		confirmedDriveAction({
			item: makeSharedRootDirectory(),
			promptTitle: "title",
			promptMessage: "message",
			promptOkText: "ok",
			action: async () => {},
			dismissOnSuccess: true
		})

		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: (() => boolean) | undefined }

		expect(callArgs.dismiss?.()).toBe(false)
	})

	it("forwards promptTitle, promptMessage, promptOkText to confirmedAction", () => {
		confirmedDriveAction({
			item: makeFile(),
			promptTitle: "Delete forever?",
			promptMessage: "Cannot be undone",
			promptOkText: "Delete",
			action: async () => {},
			dismissOnSuccess: false
		})

		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as {
			promptTitle: string
			promptMessage: string
			promptOkText: string
		}

		expect(callArgs.promptTitle).toBe("Delete forever?")
		expect(callArgs.promptMessage).toBe("Cannot be undone")
		expect(callArgs.promptOkText).toBe("Delete")
	})
})

// ---------------------------------------------------------------------------
// #40 — preview-context dismiss threading (buildUndecryptableMenuButtons)
// ---------------------------------------------------------------------------

describe("buildUndecryptableMenuButtons preview dismiss (#40)", () => {
	beforeEach(() => {
		mockConfirmedAction.mockClear()
	})

	it("threads isPreview=true into deletePermanently → dismiss fn returns true", () => {
		buildUndecryptableMenuButtons({
			item: makeFile(),
			drivePath: makeDrivePath("trash"),
			isPreview: true,
			t
		})

		// trash branch builds [restore (no confirmedAction), deletePermanently (call #0)]
		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: (() => boolean) | undefined }

		expect(typeof callArgs.dismiss).toBe("function")
		expect(callArgs.dismiss?.()).toBe(true)
	})

	it("omits dismiss for deletePermanently when not in preview (stays on the trash list)", () => {
		buildUndecryptableMenuButtons({
			item: makeFile(),
			drivePath: makeDrivePath("trash"),
			t
		})

		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: (() => boolean) | undefined }

		expect(callArgs.dismiss).toBeUndefined()
	})

	it("threads isPreview=true into the trash action (drive variant)", () => {
		buildUndecryptableMenuButtons({
			item: makeFile(),
			drivePath: makeDrivePath("drive"),
			isPreview: true,
			t
		})

		const callArgs = mockConfirmedAction.mock.calls[0]?.[0] as { dismiss: (() => boolean) | undefined }

		expect(callArgs.dismiss?.()).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// #35 — buildDownloadSubButtons
// ---------------------------------------------------------------------------

describe("buildDownloadSubButtons (#35)", () => {
	const baseDownloadArgs = {
		drivePath: makeDrivePath("drive"),
		isStoredOffline: false,
		parentForOfflineStorage: null as OfflineParent | null,
		previewType: null as PreviewType | null,
		isOwner: true,
		t
	}

	describe("downloadToDevice gating", () => {
		it("includes downloadToDevice when decryptedMeta is present (file)", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile({ name: "test.txt" })
			})
			const ids = buttons.map(b => b.id)

			expect(ids).toContain("downloadToDevice")
		})

		it("omits downloadToDevice when decryptedMeta is null", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile(null)
			})
			const ids = buttons.map(b => b.id)

			expect(ids).not.toContain("downloadToDevice")
		})

		it("includes downloadToDevice for directory with decryptedMeta", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeDirectory({ name: "mydir" })
			})
			const ids = buttons.map(b => b.id)

			expect(ids).toContain("downloadToDevice")
		})

		it("omits downloadToDevice for directory with null decryptedMeta", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeDirectory(null)
			})
			const ids = buttons.map(b => b.id)

			expect(ids).not.toContain("downloadToDevice")
		})

		it("includes downloadToDevice for sharedFile with decryptedMeta", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeSharedFile({ name: "shared.txt" })
			})
			const ids = buttons.map(b => b.id)

			expect(ids).toContain("downloadToDevice")
		})
	})

	describe("makeAvailableOffline gating", () => {
		it("includes makeAvailableOffline when parentForOfflineStorage is set and !isStoredOffline", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile(),
				parentForOfflineStorage: makeOfflineParent(),
				isStoredOffline: false
			})
			const ids = buttons.map(b => b.id)

			expect(ids).toContain("makeAvailableOffline")
		})

		it("omits makeAvailableOffline when parentForOfflineStorage is null", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile(),
				parentForOfflineStorage: null,
				isStoredOffline: false
			})
			const ids = buttons.map(b => b.id)

			expect(ids).not.toContain("makeAvailableOffline")
		})

		it("omits makeAvailableOffline when isStoredOffline=true", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile(),
				parentForOfflineStorage: makeOfflineParent(),
				isStoredOffline: true
			})
			const ids = buttons.map(b => b.id)

			expect(ids).not.toContain("makeAvailableOffline")
		})
	})

	describe("saveToPhotos gating", () => {
		it("includes saveToPhotos for file item + previewType=image + decryptedMeta", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile({ name: "photo.jpg" }),
				previewType: "image"
			})
			const ids = buttons.map(b => b.id)

			expect(ids).toContain("saveToPhotos")
		})

		it("includes saveToPhotos for file item + previewType=video + decryptedMeta", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile({ name: "video.mp4" }),
				previewType: "video"
			})
			const ids = buttons.map(b => b.id)

			expect(ids).toContain("saveToPhotos")
		})

		it("omits saveToPhotos when previewType='text'", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile({ name: "doc.txt" }),
				previewType: "text"
			})
			const ids = buttons.map(b => b.id)

			expect(ids).not.toContain("saveToPhotos")
		})

		it("omits saveToPhotos when previewType=null", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile({ name: "file.txt" }),
				previewType: null
			})
			const ids = buttons.map(b => b.id)

			expect(ids).not.toContain("saveToPhotos")
		})

		it("omits saveToPhotos when decryptedMeta is null even for image previewType", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile(null),
				previewType: "image"
			})
			const ids = buttons.map(b => b.id)

			expect(ids).not.toContain("saveToPhotos")
		})

		it("omits saveToPhotos for directory (not a file item)", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeDirectory({ name: "dir" }),
				previewType: "image"
			})
			const ids = buttons.map(b => b.id)

			expect(ids).not.toContain("saveToPhotos")
		})
	})

	describe("export gating", () => {
		it("includes export for file item with decryptedMeta", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile({ name: "file.txt" })
			})
			const ids = buttons.map(b => b.id)

			expect(ids).toContain("export")
		})

		it("omits export for directory item", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeDirectory({ name: "dir" })
			})
			const ids = buttons.map(b => b.id)

			expect(ids).not.toContain("export")
		})

		it("omits export when decryptedMeta is null", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile(null)
			})
			const ids = buttons.map(b => b.id)

			expect(ids).not.toContain("export")
		})
	})

	describe("import gating", () => {
		it("includes import when isOwner=false (non-owned item)", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile({ name: "file.txt" }),
				isOwner: false
			})
			const ids = buttons.map(b => b.id)

			expect(ids).toContain("import")
		})

		it("includes import when drivePath.type='linked' even when isOwner=true", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile({ name: "file.txt" }),
				drivePath: makeDrivePath("linked"),
				isOwner: true
			})
			const ids = buttons.map(b => b.id)

			expect(ids).toContain("import")
		})

		it("omits import when isOwner=true and drivePath.type='drive'", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile({ name: "file.txt" }),
				drivePath: makeDrivePath("drive"),
				isOwner: true
			})
			const ids = buttons.map(b => b.id)

			expect(ids).not.toContain("import")
		})

		it("omits import when decryptedMeta is null even for non-owner", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile(null),
				isOwner: false
			})
			const ids = buttons.map(b => b.id)

			expect(ids).not.toContain("import")
		})
	})

	describe("empty result", () => {
		it("returns [] when decryptedMeta=null and no offline parent and isOwner=true", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile(null),
				parentForOfflineStorage: null,
				previewType: null,
				isOwner: true
			})

			expect(buttons).toHaveLength(0)
		})
	})

	describe("button properties", () => {
		it("downloadToDevice has requiresOnline=true", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile()
			})
			const btn = buttons.find(b => b.id === "downloadToDevice")

			expect(btn?.requiresOnline).toBe(true)
		})

		it("makeAvailableOffline has requiresOnline=true", () => {
			const buttons = buildDownloadSubButtons({
				...baseDownloadArgs,
				item: makeFile(),
				parentForOfflineStorage: makeOfflineParent()
			})
			const btn = buttons.find(b => b.id === "makeAvailableOffline")

			expect(btn?.requiresOnline).toBe(true)
		})
	})
})
