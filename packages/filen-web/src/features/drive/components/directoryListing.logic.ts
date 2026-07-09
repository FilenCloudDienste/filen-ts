import { getSharerIdentity, type DriveItem } from "@/features/drive/lib/item"
import { isBlocked, type BlockedUsers } from "@/features/contacts/lib/blocking"
import { sortDriveItems, type DriveSortBy } from "@/features/drive/lib/sort"

// Fail-open visibility check for a sharedIn item: an unresolved sharer identity (getSharerIdentity
// returns null — the item isn't shared, or its role couldn't be read) always KEEPS the item; only a
// RESOLVED identity that matches the blocked set hides it. Inverting this (treating "unresolved" as
// blocked) would over-hide legitimate shares every time identity fails to resolve — a worse failure
// than the rare miss. The actual privacy guarantee comes from identity being populated in the first
// place (fetchSharedListing spreads the parent role onto every nested item before narrowing, and
// root shared arms carry their role natively — see item.ts's getSharerIdentity), not from inverting
// this predicate.
export function isVisibleSharedInItem(item: DriveItem, blocked: BlockedUsers): boolean {
	const sharer = getSharerIdentity(item)

	return !sharer || !isBlocked(sharer, blocked)
}

// The sharedIn listing filter — directoryListing.tsx only ever calls this for the sharedIn
// variant; every other variant's listing data passes straight through untouched.
export function filterSharedInByBlocked(items: readonly DriveItem[], blocked: BlockedUsers): DriveItem[] {
	return items.filter(item => isVisibleSharedInItem(item, blocked))
}

// Uuids of currently-selected items that just became blocked (e.g. the user blocked a contact
// while viewing that contact's shared items) — directoryListing.tsx's stale-selection purge prunes
// exactly these from useDriveStore so the bulk bar can never target a now-hidden item. An item whose
// identity is unresolved is never included here (fail-open — mirrors isVisibleSharedInItem).
export function staleBlockedSelectionUuids(selectedItems: readonly DriveItem[], blocked: BlockedUsers): string[] {
	return selectedItems.filter(item => !isVisibleSharedInItem(item, blocked)).map(item => item.data.uuid)
}

// Uuids of currently-selected items no longer present in a live item set — directoryListing.tsx's
// search-result purge uses this to drop a selection ghost the instant a push drops a hit the user
// had selected. Generic over its second argument (not search-specific) so a future caller could
// reuse it for the normal listing's own, rarer refetch-drop case.
export function staleSelectionUuids(selectedItems: readonly DriveItem[], liveItems: readonly DriveItem[]): string[] {
	const liveUuids = new Set(liveItems.map(item => item.data.uuid))

	return selectedItems.filter(item => !liveUuids.has(item.data.uuid)).map(item => item.data.uuid)
}

// Search results only get re-sorted once the whole match set is actually in hand (total <=
// results.length) — the search engine's own window is a fixed 1,000-item ceiling (mirrors mobile), so
// while more matches exist than currently landed, re-sorting the PARTIAL set every time a new one
// streams in would visibly reshuffle rows the user is looking at. Truncated results instead keep the
// SDK's own delivered (name) order, which is stable across a growing result set.
export function resolveSearchDisplayItems(results: DriveItem[], total: bigint, sortBy: DriveSortBy): DriveItem[] {
	return total <= BigInt(results.length) ? sortDriveItems(results, sortBy) : results
}
