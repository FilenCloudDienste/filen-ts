import { describe, expect, it } from "vitest"
import type { Dir, File, SharedDir, SharedFile, SharedRootDir, SharingRole, UuidStr } from "@filen/sdk-rs"
import { narrowItem } from "@/lib/drive/item"
import { deriveBlockedUsers, type BlockedUsers } from "@/lib/contacts/blocking"
import {
	filterSharedInByBlocked,
	isVisibleSharedInItem,
	resolveSearchDisplayItems,
	staleBlockedSelectionUuids
} from "@/components/drive/directory-listing.logic"

// UuidStr is a template-literal brand requiring at least 3 dashes (see @filen/sdk-rs) — mirrors
// queries/drive.test.ts's own testUuid helper.
function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function sharerRole(id: number, email: string): SharingRole {
	return { Sharer: { email, id } }
}

function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: testUuid("dir"),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: testUuid("file"),
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

function mockSharedRootDir(uuid: UuidStr, role: SharingRole): SharedRootDir {
	return {
		inner: { uuid, color: "default", timestamp: 1_700_000_000_000n, meta: { type: "decoded", data: { name: "SharedRoot" } } },
		sharingRole: role,
		writeAccess: true
	}
}

function mockSharedFile(uuid: UuidStr, role: SharingRole): SharedFile {
	return {
		uuid,
		size: 2_048n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 2n,
		timestamp: 1_700_000_000_000n,
		meta: {
			type: "decoded",
			data: { name: "shared.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 2_048n, key: "k", version: 2 }
		},
		sharingRole: role,
		sharedTag: true
	}
}

// A nested SharedDir carries no role of its own — fetchSharedListing spreads the parent role onto
// it before narrowing (see item.ts's SharedDirectoryData comment). This mirrors that exact shape:
// mockSharedDir alone has no sharingRole; a test that needs a resolvable nested item spreads one in,
// same as the fetcher does.
function mockSharedDir(uuid: UuidStr): SharedDir {
	return { inner: mockDir({ uuid }), sharedTag: true }
}

const BLOCKED_ROLE = sharerRole(10, "blocked@x.com")
const OK_ROLE = sharerRole(20, "ok@x.com")

function blockedUsersFixture(): BlockedUsers {
	return deriveBlockedUsers([
		{ uuid: testUuid("blocked-contact"), userId: 10n, email: "blocked@x.com", nickName: "Blocked", timestamp: 1n }
	])
}

describe("isVisibleSharedInItem", () => {
	it("keeps a plain (non-shared) item — its sharer identity is always unresolved", () => {
		const item = narrowItem(mockDir())

		expect(isVisibleSharedInItem(item, blockedUsersFixture())).toBe(true)
	})

	it("hides a ROOT shared directory whose sharer is blocked", () => {
		const item = narrowItem(mockSharedRootDir(testUuid("root-dir"), BLOCKED_ROLE))

		expect(item.type).toBe("sharedRootDirectory")
		expect(isVisibleSharedInItem(item, blockedUsersFixture())).toBe(false)
	})

	it("hides a ROOT shared file whose sharer is blocked", () => {
		const item = narrowItem(mockSharedFile(testUuid("root-file"), BLOCKED_ROLE))

		expect(item.type).toBe("sharedRootFile")
		expect(isVisibleSharedInItem(item, blockedUsersFixture())).toBe(false)
	})

	it("keeps a ROOT shared item whose sharer is not blocked", () => {
		const item = narrowItem(mockSharedRootDir(testUuid("root-dir-ok"), OK_ROLE))

		expect(isVisibleSharedInItem(item, blockedUsersFixture())).toBe(true)
	})

	// Proves the dual-surface population for a NESTED item: it only carries a sharer identity
	// because fetchSharedListing spreads the parent role onto it before narrowing. This builds that
	// exact context-tagged shape (mockSharedDir + a spread sharingRole, same as the fetcher) and
	// confirms getSharerIdentity still resolves it and the filter still catches it.
	it("hides a NESTED (context-tagged) shared directory whose sharer is blocked", () => {
		const item = narrowItem({ ...mockSharedDir(testUuid("nested-dir")), sharingRole: BLOCKED_ROLE })

		expect(item.type).toBe("sharedDirectory")
		expect(isVisibleSharedInItem(item, blockedUsersFixture())).toBe(false)
	})

	it("hides a NESTED (context-tagged) shared file whose sharer is blocked", () => {
		const item = narrowItem({ ...mockFile({ uuid: testUuid("nested-file") }), sharingRole: BLOCKED_ROLE })

		expect(item.type).toBe("sharedFile")
		expect(isVisibleSharedInItem(item, blockedUsersFixture())).toBe(false)
	})

	it("keeps a NESTED shared item whose sharer is not blocked", () => {
		const item = narrowItem({ ...mockSharedDir(testUuid("nested-dir-ok")), sharingRole: OK_ROLE })

		expect(isVisibleSharedInItem(item, blockedUsersFixture())).toBe(true)
	})

	it("matches by email fallback when userId doesn't match", () => {
		const emailOnlyBlocked = deriveBlockedUsers([
			{ uuid: testUuid("email-only"), userId: 999n, email: "onlyemail@x.com", nickName: "X", timestamp: 1n }
		])
		const item = narrowItem(mockSharedRootDir(testUuid("root-dir-email"), sharerRole(1, "ONLYEMAIL@X.com")))

		expect(isVisibleSharedInItem(item, emailOnlyBlocked)).toBe(false)
	})
})

describe("filterSharedInByBlocked", () => {
	it("drops only items whose resolved sharer is blocked — root and nested — keeping unresolved and non-blocked items", () => {
		const rootBlocked = narrowItem(mockSharedRootDir(testUuid("root-blocked"), BLOCKED_ROLE))
		const rootOk = narrowItem(mockSharedRootDir(testUuid("root-ok"), OK_ROLE))
		const nestedBlocked = narrowItem({ ...mockSharedDir(testUuid("nested-blocked")), sharingRole: BLOCKED_ROLE })
		const nestedFileBlocked = narrowItem({ ...mockFile({ uuid: testUuid("nested-file-blocked") }), sharingRole: BLOCKED_ROLE })
		const plain = narrowItem(mockDir({ uuid: testUuid("plain") }))

		const result = filterSharedInByBlocked([rootBlocked, rootOk, nestedBlocked, nestedFileBlocked, plain], blockedUsersFixture())

		expect(result.map(item => item.data.uuid)).toEqual([rootOk.data.uuid, plain.data.uuid])
	})

	it("returns every item unchanged when nothing is blocked", () => {
		const items = [narrowItem(mockSharedRootDir(testUuid("a"), OK_ROLE)), narrowItem(mockDir({ uuid: testUuid("b") }))]

		expect(filterSharedInByBlocked(items, blockedUsersFixture())).toEqual(items)
	})

	it("returns an empty array unchanged for an empty input", () => {
		expect(filterSharedInByBlocked([], blockedUsersFixture())).toEqual([])
	})
})

describe("staleBlockedSelectionUuids", () => {
	it("returns the uuids of now-blocked selected items, root and nested", () => {
		const rootBlocked = narrowItem(mockSharedRootDir(testUuid("sel-root-blocked"), BLOCKED_ROLE))
		const nestedBlocked = narrowItem({ ...mockSharedDir(testUuid("sel-nested-blocked")), sharingRole: BLOCKED_ROLE })
		const rootOk = narrowItem(mockSharedRootDir(testUuid("sel-root-ok"), OK_ROLE))

		const result = staleBlockedSelectionUuids([rootBlocked, nestedBlocked, rootOk], blockedUsersFixture())

		expect(result).toEqual([rootBlocked.data.uuid, nestedBlocked.data.uuid])
	})

	it("never purges an item with unresolved identity, even against a non-empty blocked set", () => {
		const plain = narrowItem(mockDir({ uuid: testUuid("sel-plain") }))

		expect(staleBlockedSelectionUuids([plain], blockedUsersFixture())).toEqual([])
	})

	it("returns an empty array when nothing in the selection is blocked", () => {
		const rootOk = narrowItem(mockSharedRootDir(testUuid("sel-ok"), OK_ROLE))

		expect(staleBlockedSelectionUuids([rootOk], blockedUsersFixture())).toEqual([])
	})

	it("returns an empty array for an empty selection", () => {
		expect(staleBlockedSelectionUuids([], blockedUsersFixture())).toEqual([])
	})
})

describe("resolveSearchDisplayItems", () => {
	it("re-sorts once the whole match set is in hand (total equals what's already landed)", () => {
		const b = narrowItem(mockDir({ uuid: testUuid("b"), meta: { type: "decoded", data: { name: "b" } } }))
		const a = narrowItem(mockDir({ uuid: testUuid("a"), meta: { type: "decoded", data: { name: "a" } } }))

		const result = resolveSearchDisplayItems([b, a], 2n, "nameAsc")

		expect(result.map(item => item.data.uuid)).toEqual([a.data.uuid, b.data.uuid])
	})

	it("re-sorts when total is below what's landed too (a stale/overcounted total is never worse than sorting)", () => {
		const b = narrowItem(mockDir({ uuid: testUuid("b2"), meta: { type: "decoded", data: { name: "b" } } }))
		const a = narrowItem(mockDir({ uuid: testUuid("a2"), meta: { type: "decoded", data: { name: "a" } } }))

		const result = resolveSearchDisplayItems([b, a], 1n, "nameAsc")

		expect(result.map(item => item.data.uuid)).toEqual([a.data.uuid, b.data.uuid])
	})

	it("keeps the SDK-delivered order while truncated (more matches exist than currently landed)", () => {
		const b = narrowItem(mockDir({ uuid: testUuid("b3"), meta: { type: "decoded", data: { name: "b" } } }))
		const a = narrowItem(mockDir({ uuid: testUuid("a3"), meta: { type: "decoded", data: { name: "a" } } }))

		const result = resolveSearchDisplayItems([b, a], 5n, "nameAsc")

		expect(result.map(item => item.data.uuid)).toEqual([b.data.uuid, a.data.uuid])
	})

	it("returns an empty array unchanged regardless of total", () => {
		expect(resolveSearchDisplayItems([], 0n, "nameAsc")).toEqual([])
	})
})
