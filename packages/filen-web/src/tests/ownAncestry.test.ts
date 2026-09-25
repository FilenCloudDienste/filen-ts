import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Dir, SharedDir, SharedRootDir, SharingRole, UuidStr } from "@filen/sdk-rs"

vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	return { queryClient: new QueryClient() }
})

import { queryClient } from "@/queries/client"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { cachedOwnParents, targetOwnParents } from "@/features/drive/lib/ownAncestry"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const ROOT = testUuid("root")
const RECEIVER: SharingRole = { Receiver: { email: "friend@filen.io", id: 7 } }

function dir(label: string, parent: string): Dir {
	return {
		uuid: testUuid(label),
		parent: testUuid(parent),
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } }
	}
}

function dirItem(label: string, parent: string): DriveItem {
	return narrowItem(dir(label, parent))
}

function sharedOutRoot(label: string): DriveItem {
	return narrowItem({
		inner: { uuid: testUuid(label), color: "default", timestamp: 0n, meta: { type: "decoded", data: { name: label } } },
		sharingRole: RECEIVER,
		writeAccess: true
	} satisfies SharedRootDir)
}

function sharedOutNested(label: string, parent: string): DriveItem {
	const shared: SharedDir & { sharingRole: SharingRole } = { inner: dir(label, parent), sharedTag: true, sharingRole: RECEIVER }

	return narrowItem(shared)
}

function seed(variant: DriveVariant, uuid: string | null, items: DriveItem[]): void {
	queryClient.setQueryData(["drive", "listing", { variant, uuid }], items)
}

beforeEach(() => {
	queryClient.clear()
})

describe("cachedOwnParents", () => {
	it("takes a directory's parent from the My Drive listing that holds it, null at the root", () => {
		seed("drive", null, [dirItem("a", "root")])
		seed("drive", testUuid("a"), [dirItem("b", "a")])

		const parentOf = cachedOwnParents()

		expect(parentOf(testUuid("a"))).toBeNull()
		expect(parentOf(testUuid("b"))).toBe(testUuid("a"))
		expect(parentOf(testUuid("unlisted"))).toBeUndefined()
	})

	it("counts nested Shared by me listings, but not its root or the listings whose rows sit anywhere", () => {
		seed("sharedOut", testUuid("share"), [sharedOutNested("inner", "share")])
		seed("sharedOut", null, [sharedOutRoot("share")])
		seed("favorites", null, [dirItem("fav", "somewhere")])
		seed("recents", null, [dirItem("recent", "somewhere")])
		seed("sharedIn", testUuid("theirs"), [dirItem("received", "theirs")])

		const parentOf = cachedOwnParents()

		expect(parentOf(testUuid("inner"))).toBe(testUuid("share"))
		// Listed at the Shared by me root, which is not the drive root.
		expect(parentOf(testUuid("share"))).toBeUndefined()
		expect(parentOf(testUuid("fav"))).toBeUndefined()
		expect(parentOf(testUuid("recent"))).toBeUndefined()
		expect(parentOf(testUuid("received"))).toBeUndefined()
	})

	it("doesn't trust a directory two listings disagree on", () => {
		seed("drive", testUuid("old"), [dirItem("moved", "old")])
		seed("drive", testUuid("new"), [dirItem("moved", "new")])

		expect(cachedOwnParents()(testUuid("moved"))).toBeUndefined()
	})

	it("reads the listings as they are when asked", () => {
		const before = cachedOwnParents()

		seed("drive", null, [dirItem("a", "root")])

		expect(before(testUuid("a"))).toBeUndefined()
		expect(cachedOwnParents()(testUuid("a"))).toBeNull()
	})
})

describe("targetOwnParents", () => {
	it("starts from the target's own parent, then walks the cached listings up to the account root", () => {
		seed("drive", null, [dirItem("top", "root")])
		seed("drive", testUuid("top"), [dirItem("mid", "top")])

		const parentOf = targetOwnParents({ uuid: testUuid("hit"), parent: testUuid("mid"), rootUuid: ROOT })

		expect(parentOf(testUuid("hit"))).toBe(testUuid("mid"))
		expect(parentOf(testUuid("mid"))).toBe(testUuid("top"))
		expect(parentOf(testUuid("top"))).toBeNull()
	})

	it("ends at the root for a target whose own parent is the account root, and knows nothing past the cache", () => {
		expect(targetOwnParents({ uuid: testUuid("hit"), parent: ROOT, rootUuid: ROOT })(testUuid("hit"))).toBeNull()
		expect(targetOwnParents({ uuid: testUuid("hit"), parent: undefined, rootUuid: ROOT })(testUuid("hit"))).toBeUndefined()
	})
})
