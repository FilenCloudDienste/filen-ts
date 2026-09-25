import { droppedIds, driveItemName, isBlocked, filterHiddenItems, type BlockedUsers } from "@filen/shared"
import { getSharerIdentity, type DriveItem } from "@/features/drive/lib/item"
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
	return droppedIds(
		selectedItems,
		item => isVisibleSharedInItem(item, blocked),
		item => item.data.uuid
	)
}

// Uuids of currently-selected items no longer present in a live item set — directoryListing.tsx's
// search-result purge uses this to drop a selection ghost the instant a push drops a hit the user
// had selected. Generic over its second argument (not search-specific) so a future caller could
// reuse it for the normal listing's own, rarer refetch-drop case.
export function staleSelectionUuids(selectedItems: readonly DriveItem[], liveItems: readonly DriveItem[]): string[] {
	const liveUuids = new Set(liveItems.map(item => item.data.uuid))

	return droppedIds(
		selectedItems,
		item => liveUuids.has(item.data.uuid),
		item => item.data.uuid
	)
}

// A background refetch failure must never blank a listing that still has cached items on screen —
// query-core leaves `state.data` untouched on a refetch failure and separately tracks `isRefetchError`
// for exactly this case (an error with retained data from an earlier successful fetch). Only a query
// with NO retained data (the very first fetch failing, or a refetch after the cache entry was evicted)
// should fall through to the blocking error empty-state; directoryListing.tsx's error branch checks
// this before rendering it.
export function isBlockingListingError(isRefetchError: boolean, hasData: boolean): boolean {
	return !(isRefetchError && hasData)
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

export interface ListingDisplayResult {
	// Post-hide, in render order — what the virtualizer, keyboard nav, preview pager and the bulk
	// surfaces all read.
	items: DriveItem[]
	// PRE-hide count. The search footer's "Showing N of M" compares DELIVERED matches against
	// search.total; comparing the post-hide count instead would make that notice permanent the moment
	// one hit is hidden.
	resolvedCount: number
	hiddenCount: number
	// The uuids the hide filter removed — the listing purges these from the selection (see
	// hiddenSelectionUuids), so a row nobody can see can never sit in the bulk bar's scope.
	hiddenUuids: string[]
}

// Two ordered stages: (1) resolve ORDER — the search arm's convergence gate + sort, or the plain
// sort; (2) hide. Never the reverse. resolveSearchDisplayItems only sorts once `total <=
// results.length` (the whole match set is in hand); handing it a pre-hidden array while `total` still
// counts the hidden hits flips that gate false, so search results would silently stop being sorted
// the instant anything is hidden. Filtering an already-resolved array can only remove rows, never
// reorder them, so this order is both correct and free. `search.total` is deliberately never adjusted
// — subtracting the hidden count can only ever account for hits that already landed, so it would
// misreport a truncated result set.
export function resolveListingDisplayItems(input: {
	items: DriveItem[]
	sortBy: DriveSortBy
	directorySizes: ReadonlyMap<string, number>
	hide: boolean
	search?: { total: bigint; parentPaths: ReadonlyMap<string, string> }
}): ListingDisplayResult {
	const resolved =
		input.search === undefined
			? sortDriveItems(input.items, input.sortBy, input.directorySizes)
			: resolveSearchDisplayItems(input.items, input.search.total, input.sortBy, input.directorySizes)
	const items = filterHiddenItems({
		items: resolved,
		hide: input.hide,
		...(input.search !== undefined ? { searchParentPaths: input.search.parentPaths } : {})
	})
	const shown = new Set(items.map(item => item.data.uuid))
	const hiddenUuids = resolved.filter(item => !shown.has(item.data.uuid)).map(item => item.data.uuid)

	return { items, resolvedCount: resolved.length, hiddenCount: hiddenUuids.length, hiddenUuids }
}

// Uuids of currently-selected items the hide filter just removed from the display — directoryListing
// .tsx purges exactly these from useDriveStore. Both ways a selected row becomes hidden are covered
// by feeding it the display pipeline's own output: switching the preference on, and renaming a
// selected row to a dot-name (the store still holds the pre-rename snapshot, so judging the selection
// by its own names would miss it). The bulk bar and its count-only confirms would otherwise act on
// rows the user cannot see or verify.
export function hiddenSelectionUuids(selectedItems: readonly DriveItem[], hiddenUuids: readonly string[]): string[] {
	if (hiddenUuids.length === 0) {
		return []
	}

	const hidden = new Set(hiddenUuids)

	return droppedIds(
		selectedItems,
		item => !hidden.has(item.data.uuid),
		item => item.data.uuid
	)
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

	return items.filter(item => driveItemName(item).toLowerCase().includes(normalized))
}

// A row's identity: the Shared by me root lists an item once per receiver, and each row unshares only its
// own receiver, so a shared root row is told apart by its counterpart too.
function rowKey(item: DriveItem): string {
	if (item.type !== "sharedRootDirectory" && item.type !== "sharedRootFile") {
		return item.data.uuid
	}

	const role = item.data.sharingRole

	return `${item.data.uuid}:${String("Receiver" in role ? role.Receiver.id : role.Sharer.id)}`
}

// Reconciles the store's possibly-stale selected-item snapshots against the freshest metadata in
// the listing's live rows or search results before the bulk toolbar, a bulk dialog action, a menu or the
// clipboard reads them — a rename/favorite/move/undecryptable-flip that landed after the item was selected
// is picked up here instead of the object captured at click time (mirrors mobile's own rule that bulk
// actions always operate against the freshest metadata). An item no longer present in `liveItems` is
// passed through unchanged rather than dropped — dropping it is staleSelectionUuids' own job (the
// ghost-selection purge effect), not this function's; this only ever refreshes fields, never prunes. The
// same array when no selected item changed, so a change to another row re-renders nothing it feeds; one
// pass over the live rows, indexing only the selection, each selected row taking its first live match.
export function reconcileSelectedItems<T extends DriveItem>(selectedItems: T[], liveItems: readonly T[]): T[] {
	if (selectedItems.length === 0) {
		return selectedItems
	}

	// Left to match.
	const positions = new Map<string, number>()

	for (const [index, item] of selectedItems.entries()) {
		positions.set(rowKey(item), index)
	}

	let reconciled: T[] | null = null

	for (const live of liveItems) {
		const key = rowKey(live)
		const index = positions.get(key)

		if (index === undefined) {
			continue
		}

		if (selectedItems[index] !== live) {
			reconciled ??= selectedItems.slice()
			reconciled[index] = live
		}

		positions.delete(key)

		if (positions.size === 0) {
			break
		}
	}

	return reconciled ?? selectedItems
}
