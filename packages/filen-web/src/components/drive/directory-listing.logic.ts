import { getSharerIdentity, type DriveItem } from "@/lib/drive/item"
import { isBlocked, type BlockedUsers } from "@/lib/contacts/blocking"

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

// The sharedIn listing filter — directory-listing.tsx only ever calls this for the sharedIn
// variant; every other variant's listing data passes straight through untouched.
export function filterSharedInByBlocked(items: readonly DriveItem[], blocked: BlockedUsers): DriveItem[] {
	return items.filter(item => isVisibleSharedInItem(item, blocked))
}

// Uuids of currently-selected items that just became blocked (e.g. the user blocked a contact
// while viewing that contact's shared items) — directory-listing.tsx's stale-selection purge prunes
// exactly these from useDriveStore so the bulk bar can never target a now-hidden item. An item whose
// identity is unresolved is never included here (fail-open — mirrors isVisibleSharedInItem).
export function staleBlockedSelectionUuids(selectedItems: readonly DriveItem[], blocked: BlockedUsers): string[] {
	return selectedItems.filter(item => !isVisibleSharedInItem(item, blocked)).map(item => item.data.uuid)
}
