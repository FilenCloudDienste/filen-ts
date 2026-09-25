// The drive clipboard against later changes to its items: a copy or a cut follows each item (a paste acts on
// the item as it is now), and drops what was trashed or deleted. Local changes arrive as driveItemUpdated /
// driveItemRemoved, remote ones through the real drive socket handler.

import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

type RawFile = { uuid: string; parent: string; stableUuid?: string; meta: { name: string } }
type RawDir = { uuid: string; parent: string; color: string; meta: { name: string } }

const h = vi.hoisted(() => ({
	files: new Map<string, unknown>(),
	dirs: new Map<string, unknown>()
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir_Tags: { Dir: "Dir", Root: "Root" },
	NonRootItem_Tags: { File: "File", NormalDir: "NormalDir" },
	SocketEvent_Tags: { Drive: "Drive" },
	DriveEvent_Tags: {
		FileNew: "FileNew",
		FileArchiveRestored: "FileArchiveRestored",
		FileRestore: "FileRestore",
		FileArchived: "FileArchived",
		FileDeletedPermanent: "FileDeletedPermanent",
		FolderDeletedPermanent: "FolderDeletedPermanent",
		FileMetadataChanged: "FileMetadataChanged",
		FileMove: "FileMove",
		FolderMove: "FolderMove",
		FolderMetadataChanged: "FolderMetadataChanged",
		FileTrash: "FileTrash",
		FolderTrash: "FolderTrash",
		FolderColorChanged: "FolderColorChanged",
		FolderRestore: "FolderRestore",
		FolderSubCreated: "FolderSubCreated",
		ItemFavorite: "ItemFavorite",
		TrashEmpty: "TrashEmpty",
		DeleteAll: "DeleteAll",
		DeleteVersioned: "DeleteVersioned"
	}
}))
vi.mock("@/lib/cache", () => ({
	default: {
		rootUuid: "root",
		fileUuidToNormalFile: h.files,
		directoryUuidToAnyNormalDir: h.dirs,
		cacheNewFile: (file: RawFile) => h.files.set(file.uuid, file),
		cacheNewNormalDir: (dir: RawDir) => h.dirs.set(dir.uuid, { tag: "Dir", inner: [dir] }),
		forgetItem: (uuid: string) => {
			h.files.delete(uuid)
			h.dirs.delete(uuid)
		}
	}
}))
// Raw payloads here are already item-shaped; the row keeps what the clipboard is checked for.
vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapParentUuid: (parent: unknown) => (typeof parent === "string" ? parent : null),
	unwrapFileMeta: (file: unknown) => file,
	unwrapDirMeta: (dir: unknown) => dir,
	unwrappedFileIntoDriveItem: (file: RawFile) => ({
		type: "file",
		data: { uuid: file.uuid, parent: file.parent, stableUuid: file.stableUuid, decryptedMeta: { name: file.meta.name } }
	}),
	unwrappedDirIntoDriveItem: (dir: RawDir) => ({
		type: "directory",
		data: { uuid: dir.uuid, parent: dir.parent, color: dir.color, decryptedMeta: { name: dir.meta.name } }
	})
}))
vi.mock("@/features/drive/queries/useDriveItems.query", () => ({
	driveItemsQueryUpdateGlobal: vi.fn(),
	driveItemsQueryUpdate: vi.fn(),
	driveItemsQueryUpdateForNormalParent: vi.fn(),
	driveItemsQueryUpdateForPhotos: vi.fn(),
	driveItemsQueryRemoveDirectoryFromPhotos: vi.fn(),
	driveItemsQueryInvalidateAfterDeleteAll: vi.fn(),
	driveItemsQueryMarkAllStale: vi.fn()
}))
vi.mock("@/features/drive/queries/useDirectorySize.query", () => ({ markDirectorySizesStale: vi.fn() }))
vi.mock("@/features/drive/socketCreateBatcher", () => ({ default: { enqueue: vi.fn(), flushNow: vi.fn() } }))
vi.mock("@/features/drive/driveMetadata", () => ({ favoritesListingUpdater: vi.fn() }))
vi.mock("@/features/drive/store/useDrive.store", () => ({ default: { getState: () => ({ removeFromSelection: vi.fn() }) } }))

import events from "@/lib/events"
import useDriveClipboardStore from "@/features/drive/store/useDriveClipboard.store"
import { restoreFailedCut, takeCutForPaste } from "@/features/drive/clipboardFollow"
import { handleDriveEvent, type DriveSocketEvent } from "@/features/drive/socketHandlers"
import type { DriveItem } from "@/types"

function rawFile(uuid: string, name = `${uuid}.txt`, parent = "p", stableUuid = `s-${uuid}`): RawFile {
	return { uuid, parent, stableUuid, meta: { name } }
}

function rawDir(uuid: string, color = "default", parent = "p"): RawDir {
	return { uuid, parent, color, meta: { name: uuid } }
}

function fileRow(raw: RawFile): DriveItem {
	return {
		type: "file",
		data: { uuid: raw.uuid, parent: raw.parent, stableUuid: raw.stableUuid, decryptedMeta: { name: raw.meta.name } }
	} as unknown as DriveItem
}

function dirRow(raw: RawDir): DriveItem {
	return {
		type: "directory",
		data: { uuid: raw.uuid, parent: raw.parent, color: raw.color, decryptedMeta: { name: raw.meta.name } }
	} as unknown as DriveItem
}

// A listed own file or directory: cached, as a listing leaves it.
function listedFile(uuid: string): DriveItem {
	const raw = rawFile(uuid)

	h.files.set(uuid, raw)

	return fileRow(raw)
}

function listedDir(uuid: string): DriveItem {
	const raw = rawDir(uuid)

	h.dirs.set(uuid, { tag: "Dir", inner: [raw] })

	return dirRow(raw)
}

function event(tag: string, inner: unknown): DriveSocketEvent {
	return { tag: "Drive", inner: [{ inner: { tag, inner: [inner] } }] } as unknown as DriveSocketEvent
}

function clipboard() {
	return useDriveClipboardStore.getState()
}

function uuids(): string[] | undefined {
	return clipboard().entry?.items.map(item => item.data.uuid)
}

beforeEach(() => {
	h.files.clear()
	h.dirs.clear()
	clipboard().clear()
	restoreFailedCut([])
})

describe("local changes (driveItemUpdated / driveItemRemoved)", () => {
	it("a cut follows a content save to the new uuid, and dims that row", () => {
		const before = listedFile("u1")
		const saved = fileRow(rawFile("u2", "u1.txt", "p", "s-u1"))

		clipboard().set({ mode: "cut", items: [before] })
		events.emit("driveItemUpdated", { previousUuid: "u1", item: saved })

		expect(clipboard().entry).toEqual({ mode: "cut", items: [saved] })
		expect(clipboard().cutUuids).toEqual(new Set(["u2"]))
	})

	it("a copy follows a rename, and still dims no row", () => {
		const renamed = fileRow(rawFile("u1", "renamed.txt"))

		clipboard().set({ mode: "copy", items: [listedFile("u1"), listedFile("u9")] })

		const { cutUuids } = clipboard()

		events.emit("driveItemUpdated", { previousUuid: "u1", item: renamed })

		expect(clipboard().entry?.items[0]).toBe(renamed)
		expect(uuids()).toEqual(["u1", "u9"])
		expect(clipboard().cutUuids).toBe(cutUuids)
	})

	it("a copy follows a move", () => {
		const moved = dirRow(rawDir("d1", "default", "elsewhere"))

		clipboard().set({ mode: "copy", items: [listedDir("d1")] })
		events.emit("driveItemUpdated", { previousUuid: "d1", item: moved })

		expect(clipboard().entry).toEqual({ mode: "copy", items: [moved] })
	})

	it("a copy follows a content save to the new uuid, and its socket echo changes nothing", async () => {
		const saved = fileRow(rawFile("u2", "u1.txt", "p", "s-u1"))

		clipboard().set({ mode: "copy", items: [listedFile("u1")] })
		events.emit("driveItemUpdated", { previousUuid: "u1", item: saved })

		expect(clipboard().entry).toEqual({ mode: "copy", items: [saved] })

		const state = clipboard()

		await handleDriveEvent({ event: event("FileNew", { file: rawFile("u2", "u1.txt", "p", "s-u1") }) })

		expect(clipboard()).toBe(state)
	})

	it("leaves a copy's state identical for updates to items it doesn't hold", async () => {
		clipboard().set({ mode: "copy", items: [listedFile("a"), listedDir("d")] })

		const state = clipboard()

		events.emit("driveItemUpdated", { previousUuid: "other", item: listedFile("other") })
		events.emit("driveItemRemoved", { uuid: "gone" })
		await handleDriveEvent({ event: event("FileNew", { file: rawFile("n2", "n.txt", "p", "s-n1") }) })
		await handleDriveEvent({ event: event("FileMove", { file: rawFile("x", "x.txt", "elsewhere") }) })

		expect(clipboard()).toBe(state)
	})

	it("never swaps an item for a row of another type", () => {
		const cut = listedDir("d1")
		const entry = { mode: "cut" as const, items: [cut] }
		const sharedVariant = { type: "sharedDirectory", data: { uuid: "d1" } } as unknown as DriveItem

		clipboard().set(entry)
		events.emit("driveItemUpdated", { previousUuid: "d1", item: sharedVariant })

		expect(clipboard().entry).toBe(entry)
	})

	it("a trash or delete drops the item from a copy or a cut; an entry left empty clears", () => {
		clipboard().set({ mode: "copy", items: [listedFile("a"), listedFile("b")] })
		events.emit("driveItemRemoved", { uuid: "a" })

		expect(uuids()).toEqual(["b"])

		events.emit("driveItemRemoved", { uuid: "b" })

		expect(clipboard().entry).toBeNull()

		clipboard().set({ mode: "cut", items: [listedFile("c")] })
		events.emit("driveItemRemoved", { uuid: "c" })

		expect(clipboard().entry).toBeNull()
		expect(clipboard().cutUuids.size).toBe(0)
	})

	it("keeps the same entry for an item it doesn't hold, so no row re-renders", () => {
		const entry = { mode: "cut" as const, items: [listedFile("a")] }

		clipboard().set(entry)
		events.emit("driveItemUpdated", { previousUuid: "other", item: listedFile("other") })
		events.emit("driveItemRemoved", { uuid: "other" })

		expect(clipboard().entry).toBe(entry)
	})
})

describe("a cut being pasted", () => {
	it("puts back what failed as it is by then, and not what was trashed meanwhile", () => {
		const [a, b, c] = [listedFile("a"), listedFile("b"), listedFile("c")]
		const renamed = fileRow(rawFile("a", "renamed.txt"))

		clipboard().set({ mode: "cut", items: [a, b, c] as DriveItem[] })
		takeCutForPaste({ mode: "cut", items: [a, b, c] as DriveItem[] })

		expect(clipboard().entry).toBeNull()

		events.emit("driveItemUpdated", { previousUuid: "a", item: renamed })
		events.emit("driveItemRemoved", { uuid: "b" })
		restoreFailedCut([0, 1, 2])

		expect(clipboard().entry).toEqual({ mode: "cut", items: [renamed, c] })
	})

	it("puts nothing back after a logout", () => {
		const a = listedFile("a")

		takeCutForPaste({ mode: "cut", items: [a] })
		events.emit("logout")
		restoreFailedCut([0])

		expect(clipboard().entry).toBeNull()
	})
})

describe("remote changes (socket events)", () => {
	it.each(["cut", "copy"] as const)("a %s follows a rename", async mode => {
		clipboard().set({ mode, items: [listedFile("a")] })
		await handleDriveEvent({ event: event("FileMetadataChanged", { uuid: "a", metadata: { name: "b.txt" } }) })

		expect(clipboard().entry?.items[0]?.data.decryptedMeta?.name).toBe("b.txt")
	})

	it.each(["cut", "copy"] as const)("a %s follows a move and a directory's rename and colour", async mode => {
		clipboard().set({ mode, items: [listedFile("f"), listedDir("d")] })

		await handleDriveEvent({ event: event("FileMove", { file: rawFile("f", "f.txt", "elsewhere") }) })
		await handleDriveEvent({ event: event("FolderMetadataChanged", { uuid: "d", meta: { name: "Renamed" } }) })
		await handleDriveEvent({ event: event("FolderColorChanged", { uuid: "d", color: "blue" }) })

		const [file, dir] = clipboard().entry?.items ?? []

		expect(file?.data).toMatchObject({ uuid: "f", parent: "elsewhere" })
		expect(dir?.data).toMatchObject({ uuid: "d", color: "blue", decryptedMeta: { name: "Renamed" } })
	})

	it.each([
		["cut", "FileArchived first", ["FileArchived", "FileNew"]],
		["cut", "FileNew first", ["FileNew", "FileArchived"]],
		["copy", "FileArchived first", ["FileArchived", "FileNew"]],
		["copy", "FileNew first", ["FileNew", "FileArchived"]]
	] as const)("a %s follows a content edit made elsewhere (%s)", async (mode, _order, tags) => {
		clipboard().set({ mode, items: [listedFile("u1")] })

		for (const tag of tags) {
			await handleDriveEvent({
				event:
					tag === "FileNew"
						? event("FileNew", { file: rawFile("u2", "u1.txt", "p", "s-u1") })
						: event("FileArchived", { uuid: "u1", stableUuid: "s-u1", newUuid: "u2" })
			})
		}

		expect(uuids()).toEqual(["u2"])
		expect(clipboard().cutUuids).toEqual(mode === "cut" ? new Set(["u2"]) : new Set())
	})

	it.each(["cut", "copy"] as const)("a %s follows an edit on a versioning-disabled account", async mode => {
		clipboard().set({ mode, items: [listedFile("u1")] })
		await handleDriveEvent({ event: event("FileTrash", { uuid: "u1", stableUuid: "fresh", newUuid: "u2" }) })
		await handleDriveEvent({ event: event("FileNew", { file: rawFile("u2", "u1.txt", "p", "s-u1") }) })

		expect(uuids()).toEqual(["u2"])
	})

	it("a cut follows a version restore", async () => {
		clipboard().set({ mode: "cut", items: [listedFile("u1")] })
		await handleDriveEvent({ event: event("FileArchiveRestored", { currentUuid: "u1", file: rawFile("u0", "u1.txt", "p", "s-u1") }) })

		expect(uuids()).toEqual(["u0"])
	})

	it("a trash drops the item, and a file whose lineage ended leaves a copy or a cut", async () => {
		clipboard().set({ mode: "copy", items: [listedFile("a"), listedDir("d"), listedFile("b")] })
		await handleDriveEvent({ event: event("FileTrash", { uuid: "a", stableUuid: "s-a" }) })
		await handleDriveEvent({ event: event("FolderTrash", { uuid: "d", parent: "p" }) })

		expect(uuids()).toEqual(["b"])

		await handleDriveEvent({ event: event("FileArchived", { uuid: "b", stableUuid: "s-b" }) })

		expect(clipboard().entry).toBeNull()

		clipboard().set({ mode: "cut", items: [listedFile("c")] })
		await handleDriveEvent({ event: event("FileArchived", { uuid: "c", stableUuid: "s-c" }) })

		expect(clipboard().entry).toBeNull()
	})

	it("a permanent delete drops the item, but a deleted old version doesn't", async () => {
		clipboard().set({ mode: "cut", items: [listedFile("a"), listedDir("d")] })
		await handleDriveEvent({ event: event("FileDeletedPermanent", { uuid: "a" }) })

		expect(uuids()).toEqual(["a", "d"])

		await handleDriveEvent({ event: event("FileDeletedPermanent", { uuid: "a", stableUuid: "s-a" }) })
		await handleDriveEvent({ event: event("FolderDeletedPermanent", { uuid: "d" }) })

		expect(clipboard().entry).toBeNull()
	})
})

// Copied or cut from search results: no listing read this session holds these, so the session caches don't either.
describe("remote changes to items no listing holds", () => {
	it.each(["cut", "copy"] as const)("a %s follows a rename, a directory's rename and a colour change", async mode => {
		clipboard().set({ mode, items: [fileRow(rawFile("f")), dirRow(rawDir("d"))] })

		await handleDriveEvent({ event: event("FileMetadataChanged", { uuid: "f", metadata: { name: "renamed.txt" } }) })
		await handleDriveEvent({ event: event("FolderMetadataChanged", { uuid: "d", meta: { name: "Renamed" } }) })
		await handleDriveEvent({ event: event("FolderColorChanged", { uuid: "d", color: "blue" }) })

		const [file, dir] = clipboard().entry?.items ?? []

		expect(file?.data).toMatchObject({ uuid: "f", parent: "p", stableUuid: "s-f", decryptedMeta: { name: "renamed.txt" } })
		expect(dir?.data).toMatchObject({ uuid: "d", parent: "p", color: "blue", decryptedMeta: { name: "Renamed" } })
		expect(clipboard().cutUuids).toEqual(mode === "cut" ? new Set(["f", "d"]) : new Set())
	})

	it("a cut being pasted puts back what failed to move as a rename left it", async () => {
		const cut = fileRow(rawFile("f"))

		clipboard().set({ mode: "cut", items: [cut] })
		takeCutForPaste({ mode: "cut", items: [cut] })
		await handleDriveEvent({ event: event("FileMetadataChanged", { uuid: "f", metadata: { name: "renamed.txt" } }) })
		restoreFailedCut([0])

		expect(clipboard().entry?.items[0]?.data.decryptedMeta?.name).toBe("renamed.txt")
	})

	it("keeps the same entry for changes to items it doesn't hold, and never rebuilds a shared variant", async () => {
		const shared = { type: "sharedDirectory", data: { uuid: "s", decryptedMeta: { name: "s" } } } as unknown as DriveItem
		const entry = { mode: "copy" as const, items: [fileRow(rawFile("f")), shared] }

		clipboard().set(entry)

		await handleDriveEvent({ event: event("FileMetadataChanged", { uuid: "other", metadata: { name: "other.txt" } }) })
		await handleDriveEvent({ event: event("FolderMetadataChanged", { uuid: "s", meta: { name: "Renamed" } }) })
		await handleDriveEvent({ event: event("FolderColorChanged", { uuid: "s", color: "blue" }) })

		expect(clipboard().entry).toBe(entry)
	})
})

describe("a delete-all", () => {
	it.each(["cut", "copy"] as const)("clears a %s", async mode => {
		clipboard().set({ mode, items: [listedFile("a"), fileRow(rawFile("b")), listedDir("d")] })
		await handleDriveEvent({ event: event("DeleteAll", undefined) })

		expect(clipboard().entry).toBeNull()
		expect(clipboard().cutUuids.size).toBe(0)
	})

	it("puts nothing back from a cut being pasted", async () => {
		const cut = listedFile("a")

		clipboard().set({ mode: "cut", items: [cut] })
		takeCutForPaste({ mode: "cut", items: [cut] })
		await handleDriveEvent({ event: event("DeleteAll", undefined) })
		restoreFailedCut([0])

		expect(clipboard().entry).toBeNull()
	})
})
