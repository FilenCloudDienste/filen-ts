// Save to Cloud Drive on a link view reads session caches while it renders: a public file link needs its raw
// LinkedFile, a directory link its root. These pin that every entry point fills them before the view opens.
import { vi, describe, it, expect, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
	open: vi.fn(),
	push: vi.fn(),
	sdk: {
		getDirPublicLinkInfo: vi.fn(),
		listLinkedDir: vi.fn()
	},
	refetchFailedLinkedListing: vi.fn()
}))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("@filen/shared", async () => ({
	...(await import("@/tests/mocks/filenShared")),
	cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
	formatBytes: (bytes: number) => `${bytes} B`
}))
// Tagged stand-ins for the uniffi enums, so a test can see which variant wraps which value.
vi.mock("@filen/sdk-rs", () => {
	const variant = (tag: string) =>
		class {
			public readonly tag = tag
			public readonly inner: unknown[]

			public constructor(value: unknown) {
				this.inner = [value]
			}
		}

	return {
		AnyItemWithContext: { File: variant("AnyItemWithContext.File"), Dir: variant("AnyItemWithContext.Dir") },
		AnyFile: { File: variant("AnyFile.File"), Linked: variant("AnyFile.Linked") },
		AnyDirWithContext: { Linked: variant("AnyDirWithContext.Linked") },
		AnyNormalDir: { Dir: variant("AnyNormalDir.Dir"), Root: variant("AnyNormalDir.Root") },
		AnyLinkedDir: { Dir: variant("AnyLinkedDir.Dir"), Root: variant("AnyLinkedDir.Root") },
		AnySharedDir: {},
		AnySharedDirWithContext: {},
		PasswordState: { Known: variant("PasswordState.Known") },
		ErrorKind: { WrongPassword: "WrongPassword" },
		DirMeta_Tags: { Decoded: "Decoded" },
		MaybeEncryptedUniffi_Tags: { Decrypted: "Decrypted", Encrypted: "Encrypted" },
		DirColor: { Default: variant("DirColor.Default") },
		FileMeta: {},
		ParentUuid: {}
	}
})
// A public file link becomes a drive item under the LinkedFile's own uuid (see linkedFileIntoDriveItem).
vi.mock("@/lib/sdkUnwrap", () => ({
	linkedFileIntoDriveItem: (file: { uuid: string }) => ({
		type: "file",
		data: { uuid: file.uuid, undecryptable: false, decryptedMeta: { name: `name-${file.uuid}` } }
	}),
	unwrapFileMeta: vi.fn(),
	unwrappedFileIntoDriveItem: vi.fn(),
	unwrapDirMeta: (dir: unknown) => dir,
	unwrappedDirIntoDriveItem: (dir: { uuid: string }) => ({ type: "directory", data: { uuid: dir.uuid } })
}))
vi.mock("@/stores/useDrivePreview.store", () => ({ default: { getState: () => ({ open: h.open }) } }))
vi.mock("@/lib/alerts", () => ({ default: { normal: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key }, t: (key: string) => key }))
vi.mock("@/lib/decryption", () => ({
	driveItemDisplayName: (item: { data: { uuid: string } }) => `name-${item.data.uuid}`,
	cannotDecryptPlaceholder: (uuid: string) => uuid
}))
vi.mock("@/lib/time", () => ({ simpleDate: () => "" }))
vi.mock("@/lib/router", () => ({ router: { push: h.push } }))
vi.mock("@/lib/auth", () => ({ default: { getSdkClients: async () => ({ authedSdkClient: h.sdk }) } }))
vi.mock("@/lib/prompts", () => ({ default: { input: vi.fn() } }))
vi.mock("@/lib/sdkErrors", () => ({ unwrapSdkError: () => null }))
vi.mock("@/lib/serializer", () => ({ serialize: (value: unknown) => JSON.stringify(value) }))
vi.mock("@/components/ui/fullScreenLoadingModal", async () => {
	const { run } = await import("@/tests/mocks/filenShared")

	return { runWithLoading: run }
})
vi.mock("@/components/ui/view", () => ({ default: () => null }))
vi.mock("@/components/ui/text", () => ({ default: () => null }))
vi.mock("@/components/ui/pressables", () => ({ PressableScale: () => null }))
vi.mock("@/components/itemIcons", () => ({ FileIcon: () => null, DirectoryIcon: () => null }))
vi.mock("@/features/drive/drivePublicLink", () => ({
	enablePublicLink: vi.fn(),
	disablePublicLink: vi.fn(),
	updatePublicLink: vi.fn(),
	removeDirLink: vi.fn(),
	removeFileLink: vi.fn()
}))
vi.mock("@/features/drive/driveTrash", () => ({
	deletePermanently: vi.fn(),
	trash: vi.fn(),
	restore: vi.fn(),
	emptyTrash: vi.fn(),
	restoreFileVersion: vi.fn(),
	deleteVersion: vi.fn()
}))
vi.mock("@/features/drive/driveDirectory", () => ({ createDirectory: vi.fn(), move: vi.fn() }))
vi.mock("@/features/drive/driveMetadata", () => ({ favorite: vi.fn(), rename: vi.fn(), setDirColor: vi.fn(), updateTimestamps: vi.fn() }))
vi.mock("@/features/drive/driveShare", () => ({ shareWithFilenUser: vi.fn(), removeShare: vi.fn() }))
vi.mock("@/features/drive/driveSelectSession", () => ({ selectCopyDestination: vi.fn() }))
vi.mock("@/features/copy/copyRunner", () => ({ default: { startCopyItems: vi.fn() } }))
vi.mock("@/features/drive/queries/useDriveItems.query", () => ({ driveItemsQueryRefetchFailedLinkedListing: h.refetchFailedLinkedListing }))

import { openLinkedFilePreview } from "@/features/drive/linkedFilePreview"
import { openAttachmentPreview, type InternalLinkData } from "@/features/chats/utils"
import { InternalAttachment } from "@/features/chats/components/chat/message/internalAttachment"
import drive from "@/features/drive/drive"
import { linkSaveTarget, linkedDirectoryCopySource, linkedItemToCopyItem } from "@/features/drive/linkedSave"
import cache from "@/lib/cache"
import type { DrivePath } from "@/hooks/useDrivePath"
import type { DriveItem } from "@/types"
import type { LinkedFile, LinkedRootDir } from "@filen/sdk-rs"

const LINK_VIEW: DrivePath = { type: "linked", uuid: null }

function linkedFile(uuid: string): LinkedFile {
	return { uuid, name: { tag: "Decrypted", inner: [`${uuid}.jpg`] }, size: 1n, downloadable: true } as unknown as LinkedFile
}

function fileLink(uuid: string): InternalLinkData {
	return { type: "file", previewType: "image", linkUuid: "link-1", fileKey: "key", file: linkedFile(uuid) } as unknown as InternalLinkData
}

// The item the gallery was opened on, as the header's link menu receives it.
function openedItem(): DriveItem {
	const params = h.open.mock.calls.at(-1)?.[0] as { initialItem: { data: { item: DriveItem; drivePath: DrivePath } } } | undefined

	if (!params) {
		throw new Error("the gallery was not opened")
	}

	expect(params.initialItem.data.drivePath).toEqual(LINK_VIEW)

	return params.initialItem.data.item
}

function expectSaveableFromLink(item: DriveItem, uuid: string): void {
	expect(linkSaveTarget(LINK_VIEW, item)).toEqual({ kind: "file", uuid })

	const source = linkedItemToCopyItem(item) as unknown as { tag: string; inner: [{ tag: string; inner: [LinkedFile] }] }

	expect([source.tag, source.inner[0].tag, source.inner[0].inner[0].uuid]).toEqual(["AnyItemWithContext.File", "AnyFile.Linked", uuid])
}

beforeEach(() => {
	vi.clearAllMocks()
	cache.clear()
})

describe("public file links opened in the gallery", () => {
	it("openLinkedFilePreview keeps the LinkedFile, so the link view offers Save from the link itself", () => {
		openLinkedFilePreview(linkedFile("lf-1"))

		expect(cache.linkedFileByUuid.get("lf-1")).toEqual(linkedFile("lf-1"))
		expectSaveableFromLink(openedItem(), "lf-1")
	})

	it("a chat's inline image or video preview goes through it", () => {
		openAttachmentPreview({ linked: fileLink("lf-2"), url: "http://127.0.0.1/lf-2", name: "lf-2.jpg" })

		expectSaveableFromLink(openedItem(), "lf-2")
	})

	it("a chat's file bubble for a previewable file goes through it", async () => {
		const element = InternalAttachment({ data: fileLink("lf-3"), layout: { width: 400, height: 800 }, fromSelf: false }) as unknown as {
			props: { onPress: () => Promise<void> }
		}

		await element.props.onPress()

		expectSaveableFromLink(openedItem(), "lf-3")
	})
})

describe("directory links", () => {
	it("openLinkedDirectory caches the link's root before the link screen is pushed", async () => {
		const link = { linkUuid: "link-9", enableDownload: true, password: "none" }

		h.sdk.getDirPublicLinkInfo.mockResolvedValue({ root: { inner: { uuid: "root-9" } }, link })
		h.sdk.listLinkedDir.mockResolvedValue({ dirs: [], files: [] })

		let rootAtPush: unknown = undefined

		h.push.mockImplementation(() => {
			rootAtPush = cache.linkedRootByLinkUuid.get("link-9")
		})

		await drive.openLinkedDirectory({
			linkUuid: "link-9",
			linkKey: "key-9",
			root: { inner: { uuid: "root-9", meta: { tag: "Decoded", inner: [{ name: "Holiday" }] } } } as unknown as LinkedRootDir
		})

		expect(h.push).toHaveBeenCalledTimes(1)
		expect(rootAtPush).toMatchObject({ rootUuid: "root-9", meta: { enableDownload: true } })
		// Listed and cached from the same root, so the link is fetched once.
		expect(h.sdk.getDirPublicLinkInfo).toHaveBeenCalledTimes(1)
		expect(h.sdk.listLinkedDir.mock.calls[0]?.[0]).toBe(cache.linkedRootByLinkUuid.get("link-9")?.dir)
		expect(linkSaveTarget({ type: "linked", uuid: null, linked: { uuid: "link-9", key: "key-9", rootName: "Holiday" } })).toEqual({
			kind: "directory",
			uuid: "root-9"
		})
	})

	// A subdirectory lists from the link context its parent's read cached, and the link screen can show a restored
	// listing before its own read lands: one tapped there first could otherwise not be listed or saved.
	it("openLinkedDirectory caches the root's subdirectories from the listing it already read", async () => {
		const sub = { inner: { uuid: "sub-1" }, linkedTag: true }

		h.sdk.getDirPublicLinkInfo.mockResolvedValue({
			root: { inner: { uuid: "root-9" } },
			link: { enableDownload: true, password: "none" }
		})
		h.sdk.listLinkedDir.mockResolvedValue({ dirs: [sub], files: [] })

		let subAtPush: unknown = undefined
		let cachedWhenRelisted = false

		h.push.mockImplementation(() => {
			subAtPush = cache.directoryUuidToAnyLinkedDirWithMeta.get("sub-1")
		})
		h.refetchFailedLinkedListing.mockImplementationOnce((uuid: string) => {
			cachedWhenRelisted = cache.directoryUuidToAnyLinkedDirWithMeta.has(uuid)
		})

		await drive.openLinkedDirectory({
			linkUuid: "link-9",
			linkKey: "key-9",
			root: { inner: { uuid: "root-9", meta: { tag: "Decoded", inner: [{ name: "Holiday" }] } } } as unknown as LinkedRootDir
		})

		// Once its context is cached, a listing of it that failed without one reads again.
		expect(h.refetchFailedLinkedListing).toHaveBeenCalledExactlyOnceWith("sub-1")
		expect(cachedWhenRelisted).toBe(true)
		expect(subAtPush).toEqual({
			dir: { tag: "AnyLinkedDir.Dir", inner: [sub] },
			meta: cache.linkedRootByLinkUuid.get("link-9")?.meta
		})
		expect(cache.uuidToAnyDriveItem.get("sub-1")).toEqual({ type: "directory", data: { uuid: "sub-1" } })
		expect(
			linkedDirectoryCopySource({ type: "linked", uuid: "sub-1", linked: { uuid: "link-9", key: "key-9", rootName: "Holiday" } })
		).not.toBeNull()
		expect(h.sdk.listLinkedDir).toHaveBeenCalledTimes(1)
	})

	it("a link that fails to open caches nothing", async () => {
		h.sdk.getDirPublicLinkInfo.mockResolvedValue({ root: { inner: { uuid: "root-9" } }, link: { enableDownload: true } })
		h.sdk.listLinkedDir.mockRejectedValue(new Error("gone"))

		await drive.openLinkedDirectory({
			linkUuid: "link-9",
			linkKey: "key-9",
			root: { inner: { uuid: "root-9", meta: { tag: "Decoded", inner: [{ name: "Holiday" }] } } } as unknown as LinkedRootDir
		})

		expect(h.push).not.toHaveBeenCalled()
		expect(cache.linkedRootByLinkUuid.size).toBe(0)
	})
})
