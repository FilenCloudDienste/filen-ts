import { getSharerIdentity, type DriveItem } from "@/features/drive/lib/item"
import { isBlocked, type BlockedUsers } from "@/features/contacts/lib/blocking"
import { sortDriveItems, type DriveSortBy } from "@/features/drive/lib/sort"
import { type DriveVariant } from "@/features/drive/lib/preferences"

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

// Trash toolbar's own Empty trash trigger — present only in the trash variant, and only once the
// listing actually holds something to empty. An already-empty trash has nothing for the confirm
// dialog to act on, so hiding the trigger avoids a guaranteed no-op (mirrors
// bulkActionBar.logic.ts's isBulkDownloadEnabled non-empty rationale, applied to a whole-listing
// action instead of a selection).
export function isEmptyTrashTriggerVisible(variant: DriveVariant, itemCount: number): boolean {
	return variant === "trash" && itemCount > 0
}

// Search results only get re-sorted once the whole match set is actually in hand (total <=
// results.length) — the search engine's own window is a fixed 1,000-item ceiling (mirrors mobile), so
// while more matches exist than currently landed, re-sorting the PARTIAL set every time a new one
// streams in would visibly reshuffle rows the user is looking at. Truncated results instead keep the
// SDK's own delivered (name) order, which is stable across a growing result set. `directorySizes`
// passes straight through to sortDriveItems so a size-sorted search re-positions directories as their
// sizes land, same as the normal listing.
export function resolveSearchDisplayItems(
	results: DriveItem[],
	total: bigint,
	sortBy: DriveSortBy,
	directorySizes?: ReadonlyMap<string, number>
): DriveItem[] {
	return total <= BigInt(results.length) ? sortDriveItems(results, sortBy, directorySizes) : results
}

// Local-substring fallback for every non-"drive" variant (favorites/recents/trash/sharedIn/
// sharedOut/links have no navigable subtree of their own for the cache-backed engine to search — see
// directoryListing.tsx's own useDriveSearch(uuid, variant === "drive") gate) and for the move/import
// picker's directory browser (moveTargetDialog.tsx passes its own already-type-filtered `directories`
// list straight through here). Name-substring only, case-insensitive, over whatever's already loaded —
// mirrors mobile's own non-cache-backed variants, which do an instant local substring filter with no
// content and no recursion beyond what's already listed. Same display-name fallback every other
// per-item name read in this codebase uses (decryptedMeta?.name ?? uuid), so an undecryptable item
// still stays findable by its own uuid text.
// Generic over T (not the bare DriveItem union) so a caller that already narrowed its input array —
// moveTargetDialog.tsx's own `directories` is TS-inferred down to the directory arm via its own
// `.filter(item => item.type === "directory")` — gets that same narrowing back out, instead of this
// widening it back to the full six-arm union.
export function filterDriveItemsByLocalSearch<T extends DriveItem>(items: readonly T[], search: string): T[] {
	const normalized = search.trim().toLowerCase()

	if (normalized.length === 0) {
		return [...items]
	}

	return items.filter(item => (item.data.decryptedMeta?.name ?? item.data.uuid).toLowerCase().includes(normalized))
}

// Reconciles the store's possibly-stale selected-item snapshots against the freshest metadata in
// the current live/search result set before either the bulk toolbar or a bulk dialog action reads them
// — a remote favorite/rename/undecryptable-flip that landed after the item was selected is picked up
// here instead of the object captured at click time (mirrors mobile's own rule that bulk actions always
// operate against the freshest metadata). An item no longer present in `liveItems` is passed through
// unchanged rather than dropped — dropping it is staleSelectionUuids' own job (the ghost-selection purge
// effect), not this function's; this only ever refreshes fields, never prunes.
export function reconcileSelectedItems(selectedItems: readonly DriveItem[], liveItems: readonly DriveItem[]): DriveItem[] {
	const liveByUuid = new Map(liveItems.map(item => [item.data.uuid, item]))

	return selectedItems.map(item => liveByUuid.get(item.data.uuid) ?? item)
}
