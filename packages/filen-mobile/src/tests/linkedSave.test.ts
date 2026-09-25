import { vi, describe, it, expect, beforeEach } from "vitest"
import { type TFunction } from "i18next"

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("@filen/shared", async () => await import("@/tests/mocks/filenShared"))
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
		AnySharedDirWithContext: {}
	}
})
vi.mock("@/lib/alerts", () => ({ default: { error: vi.fn() } }))
vi.mock("@/lib/decryption", () => ({ driveItemDisplayName: (item: { data: { uuid: string } }) => `name-${item.data.uuid}` }))
vi.mock("@/features/drive/driveSelectSession", () => ({ selectCopyDestination: vi.fn() }))
vi.mock("@/features/copy/copyRunner", () => ({ default: { startCopyItems: vi.fn(() => "job-1") } }))

import {
	buildSaveLinkedDirectoryButton,
	buildSaveToCloudDriveButton,
	linkedDirectoryCopySource,
	linkAllowsDownload,
	linkedItemToCopyItem,
	linkSaveTarget,
	saveLinkedToDrive
} from "@/features/drive/linkedSave"
import cache from "@/lib/cache"
import alerts from "@/lib/alerts"
import copyRunner from "@/features/copy/copyRunner"
import { selectCopyDestination } from "@/features/drive/driveSelectSession"
import type { DrivePath } from "@/hooks/useDrivePath"
import type { DriveItem } from "@/types"
import type { AnyItemWithContext, AnyLinkedDir, DirPublicLink, LinkedFile } from "@filen/sdk-rs"

const t = ((key: string) => key) as unknown as TFunction

const LINK = { uuid: "link-1", key: "k", rootName: "Holiday" }
const linkPath = (uuid: string | null = null): DrivePath => ({ type: "linked", uuid, linked: LINK }) as DrivePath

function meta(enableDownload: boolean): DirPublicLink {
	return { linkUuid: "link-1", enableDownload } as unknown as DirPublicLink
}

function linkedFile(uuid: string, downloadable: boolean): LinkedFile {
	return { uuid, downloadable } as unknown as LinkedFile
}

function item(type: DriveItem["type"], uuid: string): DriveItem {
	return { type, data: { uuid, undecryptable: false } } as unknown as DriveItem
}

const rootDir = { tag: "AnyLinkedDir.Root" } as unknown as AnyLinkedDir
const subDir = { tag: "AnyLinkedDir.Dir" } as unknown as AnyLinkedDir
const picked = { destinationDir: { tag: "Dir" }, destination: { uuid: "dest", name: "Dest" } }

function describeCopyItem(copyItem: AnyItemWithContext | null): unknown {
	const outer = copyItem as unknown as { tag: string; inner: [{ tag: string; inner: [unknown] }] } | null

	return outer ? [outer.tag, outer.inner[0].tag, outer.inner[0].inner[0]] : null
}

beforeEach(() => {
	vi.clearAllMocks()
	cache.clear()
})

describe("linkSaveTarget", () => {
	it("asks about a directory link's root, only while downloads are allowed", () => {
		expect(linkSaveTarget(linkPath())).toBeNull()

		cache.linkedRootByLinkUuid.set("link-1", { dir: rootDir, meta: meta(true), rootUuid: "root-1" })

		expect(linkSaveTarget(linkPath())).toEqual({ kind: "directory", uuid: "root-1" })
		expect(linkSaveTarget(linkPath("sub-1"))).toEqual({ kind: "directory", uuid: "root-1" })

		cache.linkedRootByLinkUuid.set("link-1", { dir: rootDir, meta: meta(false), rootUuid: "root-1" })

		expect(linkSaveTarget(linkPath())).toBeNull()
	})

	it("asks about a standalone file link's file, only while its link allows downloads, and nothing outside link views", () => {
		const standalone: DrivePath = { type: "linked", uuid: null }
		const file = item("file", "lf-1")

		expect(linkSaveTarget(standalone, file)).toBeNull()

		cache.linkedFileByUuid.set("lf-1", linkedFile("lf-1", true))

		expect(linkSaveTarget(standalone, file)).toEqual({ kind: "file", uuid: "lf-1" })
		expect(linkSaveTarget({ type: "drive", uuid: null }, file)).toBeNull()

		cache.linkedFileByUuid.set("lf-1", linkedFile("lf-1", false))

		expect(linkSaveTarget(standalone, file)).toBeNull()
	})
})

describe("linkAllowsDownload", () => {
	it("a standalone file link follows its own downloadable, and allows nothing while its source isn't held", () => {
		const standalone: DrivePath = { type: "linked", uuid: null }
		const file = item("file", "lf-1")

		expect(linkAllowsDownload(standalone, file)).toBe(false)
		expect(linkAllowsDownload(standalone)).toBe(false)

		cache.linkedFileByUuid.set("lf-1", linkedFile("lf-1", true))

		expect(linkAllowsDownload(standalone, file)).toBe(true)

		cache.linkedFileByUuid.set("lf-1", linkedFile("lf-1", false))

		expect(linkAllowsDownload(standalone, file)).toBe(false)
	})

	it("a directory link's enableDownload covers its root, its subdirectories and the files in them", () => {
		const listedFile = item("file", "f-1")

		expect(linkAllowsDownload(linkPath(), listedFile)).toBe(false)

		cache.linkedRootByLinkUuid.set("link-1", { dir: rootDir, meta: meta(true), rootUuid: "root-1" })

		expect(linkAllowsDownload(linkPath(), listedFile)).toBe(true)
		expect(linkAllowsDownload(linkPath("sub-1"), listedFile)).toBe(true)

		cache.linkedRootByLinkUuid.set("link-1", { dir: rootDir, meta: meta(false), rootUuid: "root-1" })

		expect(linkAllowsDownload(linkPath(), listedFile)).toBe(false)
		expect(linkAllowsDownload(linkPath("sub-1"), listedFile)).toBe(false)
	})

	it("never gates outside link views", () => {
		expect(linkAllowsDownload({ type: "drive", uuid: null }, item("file", "f-1"))).toBe(true)
		expect(linkAllowsDownload({ type: "sharedIn", uuid: null }, item("file", "f-1"))).toBe(true)
	})
})

describe("SDK copy sources", () => {
	it("maps a linked subdirectory, a file inside a link, and a standalone linked file", () => {
		cache.directoryUuidToAnyLinkedDirWithMeta.set("d-1", { dir: subDir, meta: meta(true) })
		cache.linkedFileByUuid.set("lf-1", { uuid: "lf-1" } as unknown as LinkedFile)

		const dir = item("directory", "d-1")
		const listedFile = item("file", "f-1")

		expect(describeCopyItem(linkedItemToCopyItem(dir))).toEqual([
			"AnyItemWithContext.Dir",
			"AnyDirWithContext.Linked",
			{ dir: subDir, link: meta(true) }
		])
		expect(describeCopyItem(linkedItemToCopyItem(listedFile))).toEqual(["AnyItemWithContext.File", "AnyFile.File", listedFile.data])
		expect(describeCopyItem(linkedItemToCopyItem(item("file", "lf-1")))).toEqual(["AnyItemWithContext.File", "AnyFile.Linked", { uuid: "lf-1" }])
		expect(linkedItemToCopyItem(item("directory", "unknown"))).toBeNull()
	})

	it("maps the directory on screen, root or subdirectory", () => {
		expect(linkedDirectoryCopySource(linkPath())).toBeNull()

		cache.linkedRootByLinkUuid.set("link-1", { dir: rootDir, meta: meta(true), rootUuid: "root-1" })
		cache.directoryUuidToAnyLinkedDirWithMeta.set("d-1", { dir: subDir, meta: meta(true) })
		cache.uuidToAnyDriveItem.set("d-1", item("directory", "d-1"))

		const root = linkedDirectoryCopySource(linkPath())
		const sub = linkedDirectoryCopySource(linkPath("d-1"))

		expect([describeCopyItem(root?.item ?? null), root?.name]).toEqual([
			["AnyItemWithContext.Dir", "AnyDirWithContext.Linked", { dir: rootDir, link: meta(true) }],
			"Holiday"
		])
		expect([describeCopyItem(sub?.item ?? null), sub?.name]).toEqual([
			["AnyItemWithContext.Dir", "AnyDirWithContext.Linked", { dir: subDir, link: meta(true) }],
			"name-d-1"
		])
	})
})

describe("saving", () => {
	it("copies every item as ONE job into the picked directory", async () => {
		const items = [{ tag: "a" }, { tag: "b" }] as unknown as AnyItemWithContext[]

		vi.mocked(selectCopyDestination).mockResolvedValueOnce(picked as never)

		await saveLinkedToDrive({ items, name: "Holiday", t })

		// A link's sources aren't drive items; the picker gets none to exclude.
		expect(selectCopyDestination).toHaveBeenCalledWith([], "drive")
		expect(copyRunner.startCopyItems).toHaveBeenCalledTimes(1)
		expect(copyRunner.startCopyItems).toHaveBeenCalledWith({ items, name: "Holiday", ...picked })
	})

	it("starts nothing when the picker is dismissed, and alerts when the job can't start", async () => {
		vi.mocked(selectCopyDestination).mockResolvedValueOnce(null)

		await saveLinkedToDrive({ items: [{}] as AnyItemWithContext[], name: "x", t })

		expect(copyRunner.startCopyItems).not.toHaveBeenCalled()

		const error = new Error("boom")

		vi.mocked(selectCopyDestination).mockResolvedValueOnce(picked as never)
		vi.mocked(copyRunner.startCopyItems).mockImplementationOnce(() => {
			throw error
		})

		await saveLinkedToDrive({ items: [{}] as AnyItemWithContext[], name: "x", t })

		expect(alerts.error).toHaveBeenCalledWith(error)
	})

	it("offers the row/bulk button only when every source is held, and saves the whole selection", async () => {
		const dir = item("directory", "d-1")
		const file = item("file", "f-1")

		expect(buildSaveToCloudDriveButton({ id: "save", title: "save", items: [dir, file], t })).toBeNull()

		cache.directoryUuidToAnyLinkedDirWithMeta.set("d-1", { dir: subDir, meta: meta(true) })

		const onDone = vi.fn()
		const button = buildSaveToCloudDriveButton({ id: "save", title: "save", items: [dir, file], onDone, t })

		expect(button?.requiresOnline).toBe(true)

		vi.mocked(selectCopyDestination).mockResolvedValueOnce(picked as never)

		await button?.onPress?.()

		expect(onDone).toHaveBeenCalledTimes(1)
		expect(copyRunner.startCopyItems).toHaveBeenCalledTimes(1)
		expect(vi.mocked(copyRunner.startCopyItems).mock.calls[0]?.[0].items.map(describeCopyItem)).toEqual([
			["AnyItemWithContext.Dir", "AnyDirWithContext.Linked", { dir: subDir, link: meta(true) }],
			["AnyItemWithContext.File", "AnyFile.File", file.data]
		])
		expect(vi.mocked(copyRunner.startCopyItems).mock.calls[0]?.[0].name).toBe("name-d-1")
	})

	it("offers the header button only for a held directory", () => {
		const saveButtonId = (drivePath: DrivePath) => buildSaveLinkedDirectoryButton({ drivePath, listingFetchStatus: "idle", t })?.id

		expect(saveButtonId(linkPath())).toBeUndefined()

		cache.linkedRootByLinkUuid.set("link-1", { dir: rootDir, meta: meta(true), rootUuid: "root-1" })

		expect(saveButtonId(linkPath())).toBe("saveDirectoryToCloudDrive")
		expect(saveButtonId({ type: "drive", uuid: null })).toBeUndefined()
		// A subdirectory is held once its parent's listing caches it.
		expect(saveButtonId(linkPath("d-1"))).toBeUndefined()

		cache.directoryUuidToAnyLinkedDirWithMeta.set("d-1", { dir: subDir, meta: meta(true) })

		expect(saveButtonId(linkPath("d-1"))).toBe("saveDirectoryToCloudDrive")
	})

	it("forgets link sources on logout", () => {
		cache.linkedRootByLinkUuid.set("link-1", { dir: rootDir, meta: meta(true), rootUuid: "root-1" })
		cache.linkedFileByUuid.set("lf-1", { uuid: "lf-1" } as unknown as LinkedFile)
		cache.clear()

		expect([cache.linkedRootByLinkUuid.size, cache.linkedFileByUuid.size]).toEqual([0, 0])
	})
})
