import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { ArchiveFormat, Dir, File, SharedDir, SharedFile, UserInfo, UuidStr } from "@filen/sdk-rs"

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import "@/lib/i18n"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	archiveParentName,
	canDisposeArchive,
	canDisposeSources,
	canExtractItem,
	composeArchiveName,
	defaultArchiveBaseName,
	defaultJobDestination,
	extractHereDestination,
	extractRequest,
	namingEntries
} from "@/features/drive/lib/archiveTargets"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { testUuid } from "@/tests/support/uuid"

const ROOT = testUuid("root")
const PHOTOS = testUuid("photos")
const WORK = testUuid("work")
const NAMES: Record<string, string> = { [PHOTOS]: "Photos", [WORK]: "Work" }

function nameOf(uuid: string): string | undefined {
	return NAMES[uuid]
}

function file(name: string, parent: string = PHOTOS, label: string = name): DriveItem {
	const raw: File = {
		uuid: testUuid(label),
		stableUUID: undefined,
		parent: parent as UuidStr,
		size: 100n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/octet-stream", modified: 0n, size: 100n, key: "k", version: 2 } }
	}

	return narrowItem(raw)
}

function dir(name: string, parent: string = PHOTOS): DriveItem {
	const raw: Dir = {
		uuid: testUuid(name),
		parent: parent as UuidStr,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	}

	return narrowItem(raw)
}

function undecryptable(): DriveItem {
	const item = file("x.zip")

	return { ...item, data: { ...item.data, undecryptable: true, decryptedMeta: null } } as DriveItem
}

function sharedRootFile(name: string): DriveItem {
	const raw: SharedFile = {
		uuid: testUuid(name),
		size: 100n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 1n,
		timestamp: 0n,
		meta: { type: "decoded", data: { name, mime: "application/zip", modified: 0n, size: 100n, key: "k", version: 2 } },
		sharingRole: { type: "receiver", email: "a@example.com", id: 1 },
		sharedTag: true,
		canMakeThumbnail: false
	}

	return narrowItem(raw)
}

function sharedDir(name: string): DriveItem {
	const raw: SharedDir = {
		inner: {
			uuid: testUuid(name),
			parent: PHOTOS,
			color: "default",
			timestamp: 0n,
			favorited: false,
			meta: { type: "decoded", data: { name } }
		},
		sharedTag: true
	}

	return narrowItem(raw)
}

function nameInfo(format: ArchiveFormat | null, defaultName: string) {
	return { format, defaultName }
}

beforeEach(() => {
	queryClient.setQueryData<Partial<UserInfo>>(ACCOUNT_QUERY_KEY, { rootDirUuid: ROOT })
})

describe("canDisposeSources / canDisposeArchive", () => {
	it("removes originals only where they are the user's own", () => {
		expect(canDisposeSources("drive", [file("a.txt"), dir("b")])).toBe(true)
		expect(canDisposeSources("links", [file("a.txt")])).toBe(true)
		expect(canDisposeSources("sharedIn", [file("a.txt")])).toBe(false)
		expect(canDisposeSources("sharedOut", [file("a.txt")])).toBe(false)
		expect(canDisposeSources("trash", [file("a.txt")])).toBe(false)
		expect(canDisposeArchive("drive", file("a.zip"), "all")).toBe(true)
		expect(canDisposeArchive("drive", file("a.zip"), "entries")).toBe(false)
		expect(canDisposeArchive("sharedIn", file("a.zip"), "all")).toBe(false)
	})

	it("never removes a shared arm, which the SDK refuses to", () => {
		expect(canDisposeSources("drive", [file("a.txt"), sharedRootFile("s.zip")])).toBe(false)
		expect(canDisposeSources("favorites", [sharedDir("s")])).toBe(false)
		expect(canDisposeArchive("recents", sharedRootFile("s.zip"), "all")).toBe(false)
	})
})

describe("defaultJobDestination", () => {
	it("is the items' own directory", () => {
		expect(defaultJobDestination([file("a.txt"), dir("b")], "drive", "My Drive", nameOf)).toEqual({ uuid: PHOTOS, name: "Photos" })
		expect(defaultJobDestination([file("a.txt", WORK)], "recents", "My Drive", nameOf)).toEqual({ uuid: WORK, name: "Work" })
	})

	it("is My Drive's root for items there, for differing parents and in Shared with me", () => {
		const root = { uuid: null, name: "My Drive" }

		expect(defaultJobDestination([file("a.txt", ROOT)], "drive", "My Drive", nameOf)).toEqual(root)
		expect(defaultJobDestination([file("a.txt"), file("b.txt", WORK)], "favorites", "My Drive", nameOf)).toEqual(root)
		expect(defaultJobDestination([file("a.txt")], "sharedIn", "My Drive", nameOf)).toEqual(root)
		expect(defaultJobDestination([sharedRootFile("s.zip")], "sharedIn", "My Drive", nameOf)).toEqual(root)
	})

	it("names a directory no listing holds with a stand-in", () => {
		const other = testUuid("other")

		expect(defaultJobDestination([file("a.txt", other)], "drive", "My Drive", nameOf)).toEqual({
			uuid: other,
			name: "another directory"
		})
	})
})

describe("defaultArchiveBaseName", () => {
	it("takes one file's name without its extension, a dot-file's whole name", () => {
		expect(defaultArchiveBaseName(namingEntries([file("report.final.pdf")]), "zip", "Photos", "Archive")).toBe("report.final")
		expect(defaultArchiveBaseName(namingEntries([file("README")]), "zip", "Photos", "Archive")).toBe("README")
		expect(defaultArchiveBaseName(namingEntries([file(".bashrc")]), "7z", "Photos", "Archive")).toBe(".bashrc")
	})

	it("keeps a file's whole name for a single compressed file", () => {
		expect(defaultArchiveBaseName(namingEntries([file("photo.jpg")]), "gz", "Photos", "Archive")).toBe("photo.jpg")
	})

	it("takes a directory's name", () => {
		expect(defaultArchiveBaseName(namingEntries([dir("Holiday.2024")]), "tar.gz", "Photos", "Archive")).toBe("Holiday.2024")
	})

	it("names entries without a drive shape by their own flags", () => {
		expect(defaultArchiveBaseName([{ name: "Shared.stuff", directory: true }], "zip", null, "Archive")).toBe("Shared.stuff")
		expect(defaultArchiveBaseName([{ name: "notes.txt", directory: false }], "zip", null, "Archive")).toBe("notes")
	})

	it("names several items after their directory, or the fallback", () => {
		const entries = namingEntries([file("a.txt"), dir("b")])

		expect(defaultArchiveBaseName(entries, "zip", "Photos", "Archive")).toBe("Photos")
		expect(defaultArchiveBaseName(entries, "zip", null, "Archive")).toBe("Archive")
	})

	it("finds the directory's name only for a shared, known, non-root parent", () => {
		expect(archiveParentName([file("a.txt"), dir("b")], nameOf)).toBe("Photos")
		expect(archiveParentName([file("a.txt", ROOT), dir("b", ROOT)], nameOf)).toBeNull()
		expect(archiveParentName([file("a.txt"), file("b.txt", WORK)], nameOf)).toBeNull()
		expect(archiveParentName([file("a.txt", testUuid("unknown"))], nameOf)).toBeNull()
		expect(archiveParentName([file("a.txt", "recents")], nameOf)).toBeNull()
	})

	it("names items from different directories after the mixed fallback only when one is given", () => {
		expect(archiveParentName([file("a.txt"), file("b.txt", WORK)], nameOf, "Pictures")).toBe("Pictures")
		// One directory and the root keep the drive's own rules.
		expect(archiveParentName([file("a.txt"), dir("b")], nameOf, "Pictures")).toBe("Photos")
		expect(archiveParentName([file("a.txt", ROOT), dir("b", ROOT)], nameOf, "Pictures")).toBeNull()
	})
})

describe("namingEntries", () => {
	it("carries each item's name and whether it is a directory", () => {
		expect(namingEntries([file("a.txt"), dir("b"), sharedRootFile("s.zip"), sharedDir("s")])).toEqual([
			{ name: "a.txt", directory: false },
			{ name: "b", directory: true },
			{ name: "s.zip", directory: false },
			{ name: "s", directory: true }
		])
	})
})

describe("composeArchiveName", () => {
	it("adds the extension once", () => {
		expect(composeArchiveName("photos", ".zip")).toBe("photos.zip")
		expect(composeArchiveName("photos.zip", ".zip")).toBe("photos.zip")
		expect(composeArchiveName("photos.TAR.GZ", ".tar.gz")).toBe("photos.TAR.GZ")
		expect(composeArchiveName("photos.tar", ".tar.gz")).toBe("photos.tar.tar.gz")
		expect(composeArchiveName("  photos ", ".7z")).toBe("photos.7z")
	})
})

describe("canExtractItem / extractHereDestination", () => {
	it("offers decryptable archive files outside the trash", () => {
		expect(canExtractItem("drive", file("a.tar.gz"))).toBe(true)
		expect(canExtractItem("sharedIn", sharedRootFile("s.ZIP"))).toBe(true)
		expect(canExtractItem("drive", file("a.txt"))).toBe(false)
		expect(canExtractItem("drive", dir("b.zip"))).toBe(false)
		expect(canExtractItem("trash", file("a.zip"))).toBe(false)
		expect(canExtractItem("drive", undecryptable())).toBe(false)
	})

	it("is the archive's own directory, never in Shared with me", () => {
		expect(extractHereDestination("drive", file("a.zip"), "My Drive", nameOf)).toEqual({ uuid: PHOTOS, name: "Photos" })
		expect(extractHereDestination("drive", file("a.zip", ROOT), "My Drive", nameOf)).toEqual({ uuid: null, name: "My Drive" })
		expect(extractHereDestination("sharedIn", file("a.zip"), "My Drive", nameOf)).toBeNull()
		expect(extractHereDestination("links", file("a.zip", "links"), "My Drive", nameOf)).toBeNull()
	})
})

describe("extractRequest", () => {
	const destination = { uuid: PHOTOS, name: "Photos" }
	const zip = file("photos.zip")

	it("extracts into a new directory named by the SDK", () => {
		const request = extractRequest(zip, nameInfo({ type: "zip" }, "photos"), destination, { root: "newFolder" })

		expect(request).toEqual({
			archive: { file: zip.data, uuid: zip.data.uuid, name: "photos.zip" },
			destination,
			root: { type: "newFolder" },
			rowName: "photos",
			glyph: "directory",
			calls: [{ type: "all" }],
			skipMacMetadata: true,
			dispose: null,
			basis: { type: "archiveRead" },
			formatHint: "zip"
		})
		expect("name" in request.root).toBe(false)
	})

	it("names the new directory as asked", () => {
		const request = extractRequest(zip, nameInfo({ type: "zip" }, "photos"), destination, {
			root: "newFolder",
			folderName: "Holiday",
			skipMacMetadata: false,
			dispose: "trash"
		})

		expect(request.root).toEqual({ type: "newFolder", name: "Holiday" })
		expect(request.rowName).toBe("Holiday")
		expect(request.skipMacMetadata).toBe(false)
		expect(request.dispose).toBe("trash")
	})

	it("extracts straight into the destination under the archive's name", () => {
		const request = extractRequest(zip, nameInfo({ type: "zip" }, "photos"), destination, {
			root: "destination",
			folderName: "ignored"
		})

		expect(request.root).toEqual({ type: "destination" })
		expect(request.rowName).toBe("photos.zip")
		expect(request.glyph).toBe("items")
	})

	it("asks for the chosen root for a single compressed file by its name, its row reading as the file", () => {
		const gz = file("notes.txt.gz")
		const info = nameInfo({ type: "single", codec: "gzip" }, "notes.txt")
		// The SDK writes a real one into the destination whatever the root; a tarball named .gz gets the directory.
		const request = extractRequest(gz, info, destination, { root: "newFolder", folderName: "Notes" })

		expect(request.root).toEqual({ type: "newFolder", name: "Notes" })
		expect(request.rowName).toBe("notes.txt")
		expect(request.glyph).toBe("file")
		expect(request.formatHint).toBe("single")
		expect(extractRequest(gz, info, destination, { root: "newFolder" }).root).toEqual({ type: "newFolder" })

		const beside = extractRequest(gz, info, destination, { root: "destination" })

		expect(beside.root).toEqual({ type: "destination" })
		expect(beside.rowName).toBe("notes.txt")
		expect(beside.glyph).toBe("file")
	})

	it("leaves the format to the archive's bytes when the name tells none", () => {
		expect(extractRequest(zip, nameInfo(null, "photos"), destination, { root: "newFolder" }).formatHint).toBeNull()
	})
})
