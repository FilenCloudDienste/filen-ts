import { describe, expect, it } from "vitest"
import type { Dir, File, SharedDir, SharedFile, SharedRootDir, SharingRole, UuidStr } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import { deriveBlockedUsers, type BlockedUsers } from "@/features/contacts/lib/blocking"
import {
	filterDriveItemsByLocalSearch,
	filterSharedInByBlocked,
	hiddenSelectionUuids,
	isBlockingListingError,
	isEmptyTrashTriggerVisible,
	isVisibleSharedInItem,
	reconcileSelectedItems,
	resolveListingDisplayItems,
	resolveSearchDisplayItems,
	staleBlockedSelectionUuids,
	staleSelectionUuids
} from "@/features/drive/components/directoryListing.logic"

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

describe("staleSelectionUuids", () => {
	it("returns the uuids of selected items no longer present in the live set", () => {
		const a = narrowItem(mockDir({ uuid: testUuid("live-a") }))
		const b = narrowItem(mockDir({ uuid: testUuid("live-b") }))
		const dropped = narrowItem(mockFile({ uuid: testUuid("dropped") }))

		const result = staleSelectionUuids([a, dropped, b], [a, b])

		expect(result).toEqual([dropped.data.uuid])
	})

	// Pins the case a push-fed effect must get right: an unchanged live set (e.g. a heartbeat) never
	// drops a still-present selection.
	it("returns an empty array when every selected item is still live", () => {
		const a = narrowItem(mockDir({ uuid: testUuid("still-a") }))
		const b = narrowItem(mockFile({ uuid: testUuid("still-b") }))

		expect(staleSelectionUuids([a, b], [a, b])).toEqual([])
	})

	it("returns an empty array for an empty selection", () => {
		const a = narrowItem(mockDir({ uuid: testUuid("live-only") }))

		expect(staleSelectionUuids([], [a])).toEqual([])
	})

	it("drops every selected uuid when the live set is empty", () => {
		const a = narrowItem(mockDir({ uuid: testUuid("now-gone-a") }))
		const b = narrowItem(mockFile({ uuid: testUuid("now-gone-b") }))

		expect(staleSelectionUuids([a, b], [])).toEqual([a.data.uuid, b.data.uuid])
	})
})

describe("hiddenSelectionUuids", () => {
	it("returns the selected uuids the hide filter removed from the display", () => {
		const kept = narrowItem(mockDir({ uuid: testUuid("hid-kept") }))
		const gone = narrowItem(mockFile({ uuid: testUuid("hid-gone") }))

		expect(hiddenSelectionUuids([kept, gone], [gone.data.uuid])).toEqual([gone.data.uuid])
	})

	// The rename case: the store still holds the PRE-rename snapshot, so the purge has to be driven by
	// the display pipeline's own output rather than by the selected items' own names.
	it("purges by uuid, never by the selected item's own (possibly stale) name", () => {
		const renamed = narrowItem(mockDir({ uuid: testUuid("hid-renamed"), meta: { type: "decoded", data: { name: "notes" } } }))

		expect(hiddenSelectionUuids([renamed], [renamed.data.uuid])).toEqual([renamed.data.uuid])
	})

	it("returns an empty array when nothing selected is hidden", () => {
		const kept = narrowItem(mockDir({ uuid: testUuid("hid-none") }))

		expect(hiddenSelectionUuids([kept], [])).toEqual([])
		expect(hiddenSelectionUuids([], [testUuid("hid-other")])).toEqual([])
	})
})

describe("isBlockingListingError", () => {
	// A background refetch failure with cached items retained must never blank the listing.
	it("is false (non-blocking) for a refetch error with retained data", () => {
		expect(isBlockingListingError(true, true)).toBe(false)
	})

	it("is true (blocking) for a first-load failure — no data to fall back on", () => {
		expect(isBlockingListingError(false, false)).toBe(true)
	})

	it("is true (blocking) for a refetch error that somehow has no retained data (defensive)", () => {
		expect(isBlockingListingError(true, false)).toBe(true)
	})

	it('is true (blocking) for a non-refetch error even with data present (defensive — status:"error" implies no success data in practice)', () => {
		expect(isBlockingListingError(false, true)).toBe(true)
	})
})

describe("isEmptyTrashTriggerVisible", () => {
	it("shows the trigger for a non-empty trash listing", () => {
		expect(isEmptyTrashTriggerVisible("trash", 3)).toBe(true)
	})

	it("hides the trigger for an empty trash listing — nothing for the confirm to act on", () => {
		expect(isEmptyTrashTriggerVisible("trash", 0)).toBe(false)
	})

	it("hides the trigger outside the trash variant regardless of item count", () => {
		expect(isEmptyTrashTriggerVisible("drive", 3)).toBe(false)
		expect(isEmptyTrashTriggerVisible("favorites", 3)).toBe(false)
		expect(isEmptyTrashTriggerVisible("recents", 0)).toBe(false)
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

describe("resolveListingDisplayItems", () => {
	const NO_SIZES: ReadonlyMap<string, number> = new Map()

	function named(label: string, name: string) {
		return narrowItem(mockDir({ uuid: testUuid(label), meta: { type: "decoded", data: { name } } }))
	}

	it("non-search arm sorts, then hides", () => {
		const b = named("disp-b", "b")
		const a = named("disp-a", "a")
		const hidden = named("disp-hidden", ".hidden")

		const result = resolveListingDisplayItems({ items: [b, hidden, a], sortBy: "nameAsc", directorySizes: NO_SIZES, hide: true })

		expect(result.items.map(item => item.data.uuid)).toEqual([a.data.uuid, b.data.uuid])
	})

	it("hidden filtering does not disable search sorting — hiding a row never changes the surviving order", () => {
		const b = named("gate-b", "b")
		const a = named("gate-a", "a")
		const hidden = named("gate-hidden", ".hidden")
		const input = {
			items: [b, hidden, a],
			sortBy: "nameAsc" as const,
			directorySizes: NO_SIZES,
			search: { total: 3n, parentPaths: new Map<string, string>() }
		}

		const shown = resolveListingDisplayItems({ ...input, hide: false })
		const filtered = resolveListingDisplayItems({ ...input, hide: true })

		// A filter-before-resolve implementation would drop `total` below the delivered count, flipping
		// the convergence gate and leaving the survivors in SDK order instead of sorted.
		expect(shown.items.map(item => item.data.uuid)).toEqual([hidden.data.uuid, a.data.uuid, b.data.uuid])
		expect(filtered.items.map(item => item.data.uuid)).toEqual([a.data.uuid, b.data.uuid])
	})

	it("search arm keeps the SDK's delivered order while truncated (total > results.length)", () => {
		const b = named("trunc-b", "b")
		const a = named("trunc-a", "a")

		const result = resolveListingDisplayItems({
			items: [b, a],
			sortBy: "nameAsc",
			directorySizes: NO_SIZES,
			hide: false,
			search: { total: 5n, parentPaths: new Map() }
		})

		expect(result.items.map(item => item.data.uuid)).toEqual([b.data.uuid, a.data.uuid])
	})

	it("resolvedCount is the PRE-hide count and hiddenCount the difference", () => {
		const result = resolveListingDisplayItems({
			items: [named("count-a", "a"), named("count-hidden", ".hidden"), named("count-b", "b")],
			sortBy: "nameAsc",
			directorySizes: NO_SIZES,
			hide: true
		})

		expect(result.resolvedCount).toBe(3)
		expect(result.hiddenCount).toBe(1)
		expect(result.items.length).toBe(2)
	})

	it("reports WHICH uuids were hidden, so the listing can purge them from the selection", () => {
		const hidden = named("uuids-hidden", ".env")
		const shown = named("uuids-shown", "readme")

		const result = resolveListingDisplayItems({ items: [shown, hidden], sortBy: "nameAsc", directorySizes: NO_SIZES, hide: true })

		expect(result.hiddenUuids).toEqual([hidden.data.uuid])
		expect(
			resolveListingDisplayItems({ items: [shown, hidden], sortBy: "nameAsc", directorySizes: NO_SIZES, hide: false }).hiddenUuids
		).toEqual([])
	})

	it("hides a search hit by its ancestor chain, not just its own name", () => {
		const buried = named("path-buried", "notes")
		const sibling = named("path-sibling", "readme")

		const result = resolveListingDisplayItems({
			items: [buried, sibling],
			sortBy: "nameAsc",
			directorySizes: NO_SIZES,
			hide: true,
			search: {
				total: 2n,
				parentPaths: new Map([
					[buried.data.uuid, "docs/.cache"],
					[sibling.data.uuid, "docs"]
				])
			}
		})

		expect(result.items.map(item => item.data.uuid)).toEqual([sibling.data.uuid])
		expect(result.hiddenCount).toBe(1)
	})

	it("hide: false is an identity pass-through in both arms", () => {
		const a = named("id-a", "a")
		const hidden = named("id-hidden", ".hidden")

		const plain = resolveListingDisplayItems({ items: [hidden, a], sortBy: "nameAsc", directorySizes: NO_SIZES, hide: false })
		const searched = resolveListingDisplayItems({
			items: [hidden, a],
			sortBy: "nameAsc",
			directorySizes: NO_SIZES,
			hide: false,
			search: { total: 2n, parentPaths: new Map() }
		})

		expect(plain.hiddenCount).toBe(0)
		expect(plain.items.length).toBe(2)
		expect(searched.hiddenCount).toBe(0)
		expect(searched.items.length).toBe(2)
	})
})

describe("filterDriveItemsByLocalSearch", () => {
	it("returns every item unchanged for a blank query", () => {
		const a = narrowItem(mockDir({ uuid: testUuid("local-a"), meta: { type: "decoded", data: { name: "Reports" } } }))
		const b = narrowItem(mockFile({ uuid: testUuid("local-b") }))

		expect(filterDriveItemsByLocalSearch([a, b], "   ")).toEqual([a, b])
	})

	it("matches a case-insensitive substring of the display name", () => {
		const match = narrowItem(mockDir({ uuid: testUuid("local-match"), meta: { type: "decoded", data: { name: "Vacation Photos" } } }))
		const skip = narrowItem(mockDir({ uuid: testUuid("local-skip"), meta: { type: "decoded", data: { name: "Taxes" } } }))

		expect(filterDriveItemsByLocalSearch([match, skip], "VACATION")).toEqual([match])
	})

	it("falls back to matching the uuid text for an undecryptable item (no name to match against)", () => {
		const undecryptable = narrowItem(
			mockDir({ uuid: testUuid("local-undecryptable"), meta: { type: "encrypted", data: "ciphertext" } })
		)

		expect(filterDriveItemsByLocalSearch([undecryptable], "local-undecryptable")).toEqual([undecryptable])
	})

	it("excludes items whose name doesn't contain the query anywhere", () => {
		const item = narrowItem(mockDir({ uuid: testUuid("local-none"), meta: { type: "decoded", data: { name: "Documents" } } }))

		expect(filterDriveItemsByLocalSearch([item], "zzz")).toEqual([])
	})
})

describe("reconcileSelectedItems", () => {
	it("swaps a selected item for its freshest live counterpart by uuid", () => {
		const stale = narrowItem(mockDir({ uuid: testUuid("reconcile-a"), favorited: false }))
		const fresh = narrowItem(mockDir({ uuid: testUuid("reconcile-a"), favorited: true }))

		const result = reconcileSelectedItems([stale], [fresh])

		expect(result).toEqual([fresh])
	})

	it("passes a selected item through unchanged when it has dropped out of the live set", () => {
		const stale = narrowItem(mockDir({ uuid: testUuid("reconcile-gone") }))

		const result = reconcileSelectedItems([stale], [])

		expect(result).toEqual([stale])
	})

	it("preserves selection order and length regardless of the live set's own order", () => {
		const a = narrowItem(mockDir({ uuid: testUuid("reconcile-order-a") }))
		const b = narrowItem(mockDir({ uuid: testUuid("reconcile-order-b") }))
		const freshA = narrowItem(mockDir({ uuid: testUuid("reconcile-order-a"), favorited: true }))
		const freshB = narrowItem(mockDir({ uuid: testUuid("reconcile-order-b"), favorited: true }))

		const result = reconcileSelectedItems([a, b], [freshB, freshA])

		expect(result.map(item => item.data.uuid)).toEqual([a.data.uuid, b.data.uuid])
		expect(result.every(item => item.data.favorited)).toBe(true)
	})
})
