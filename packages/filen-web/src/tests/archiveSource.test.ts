import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { File, LinkedFile, ParentUuid, SharedFile } from "@filen/sdk-rs"

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { linkedFileIntoDriveItem, narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { archiveSourceOf, linkedArchiveSource } from "@/features/archive/lib/archiveSource"
import { testUuid } from "@/tests/support/uuid"

// Which archives offer "next to the archive": only an own one in a directory of the user's own. Shared
// with the user, a public link's or a chat's archive has none, whatever listing it shows up in.

const ROOT = testUuid("root")
const PARENT = testUuid("parent")
const ROLE = { type: "receiver", email: "a@example.com", id: 1 } as const

function rawFile(name: string, parent: ParentUuid): File {
	return {
		uuid: testUuid(name),
		stableUUID: undefined,
		parent,
		size: 2048n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/zip", modified: 0n, size: 2048n, key: "k", version: 2 } }
	}
}

function file(name: string, parent: ParentUuid = PARENT): DriveItem {
	return narrowItem(rawFile(name, parent))
}

// Below a directory shared with the user: a plain File the listing spread the share's role onto.
function nestedSharedFile(name: string): DriveItem {
	return narrowItem({ ...rawFile(name, PARENT), sharingRole: ROLE })
}

function sharedRootFile(name: string): DriveItem {
	const raw: SharedFile = {
		uuid: testUuid(name),
		size: 2048n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 1n,
		timestamp: 0n,
		meta: { type: "decoded", data: { name, mime: "application/zip", modified: 0n, size: 2048n, key: "k", version: 2 } },
		sharingRole: ROLE,
		sharedTag: true,
		canMakeThumbnail: false
	}

	return narrowItem(raw)
}

const LINKED: LinkedFile = {
	uuid: testUuid("linked"),
	name: { Decrypted: "photos.zip" },
	mime: { Decrypted: "application/zip" },
	size: 4096n,
	chunks: 1n,
	region: "de-1",
	bucket: "filen-1",
	version: 2,
	timestamp: 0n,
	fileKey: "k",
	downloadable: true,
	linkedTag: true,
	canMakeThumbnail: false
}

describe("archiveSourceOf", () => {
	it("offers an own archive's directory, null at the drive's root", () => {
		expect(archiveSourceOf(file("a.zip"), "drive", ROOT)).toMatchObject({ name: "a.zip", size: 2048, ownParent: PARENT })
		expect(archiveSourceOf(file("a.zip", ROOT), "drive", ROOT).ownParent).toBeNull()
		expect(archiveSourceOf(file("a.zip"), "recents", ROOT).ownParent).toBe(PARENT)
	})

	it("offers none in Shared with me, for a nested shared file or a shared root file", () => {
		const nested = nestedSharedFile("a.zip")

		expect(nested.type).toBe("sharedFile")
		expect(archiveSourceOf(nested, "sharedIn", ROOT).ownParent).toBeUndefined()
		expect(archiveSourceOf(sharedRootFile("b.zip"), "sharedIn", ROOT).ownParent).toBeUndefined()
		// Its own parent even outside Shared with me.
		expect(archiveSourceOf(sharedRootFile("b.zip"), "favorites", ROOT).ownParent).toBeUndefined()
	})

	it("offers none in the trash or behind a flat listing's marker", () => {
		expect(archiveSourceOf(file("a.zip"), "trash", ROOT).ownParent).toBeUndefined()
		expect(archiveSourceOf(file("a.zip", "links"), "links", ROOT).ownParent).toBeUndefined()
	})

	it("offers none for a chat's or public link's stand-in, which is its own parent", () => {
		const item = linkedFileIntoDriveItem(LINKED)

		expect(archiveSourceOf(item, "links", ROOT).ownParent).toBeUndefined()
		expect(archiveSourceOf(item, "drive", ROOT).ownParent).toBeUndefined()
	})

	it("refuses a directory", () => {
		const dir = narrowItem({
			uuid: testUuid("d"),
			parent: PARENT,
			color: "default",
			timestamp: 0n,
			favorited: false,
			meta: { type: "decoded", data: { name: "d" } }
		})

		expect(() => archiveSourceOf(dir, "drive", ROOT)).toThrow("an archive is a file")
	})
})

describe("linkedArchiveSource", () => {
	it("reads the SDK's own linked file and offers no directory", () => {
		const item = linkedFileIntoDriveItem(LINKED)

		expect(linkedArchiveSource(item, LINKED)).toEqual({
			file: LINKED,
			uuid: LINKED.uuid,
			name: "photos.zip",
			size: 4096,
			ownParent: undefined
		})
	})

	it("falls back to the stand-in's own data", () => {
		const item = linkedFileIntoDriveItem(LINKED)

		expect(linkedArchiveSource(item).file).toBe(item.data)
	})
})
