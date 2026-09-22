import type { DriveItemLike } from "./driveItem"

// Collision rule for splicing an incoming item into a cached listing: an existing row is dropped
// when it IS the incoming item (uuid match) or is a same-name duplicate the incoming item
// supersedes (case-insensitive, trimmed) — a kept row returns true. Authored against primitives
// rather than DriveItemLike so a caller holding only the incoming item's uuid/name (no built item
// yet) can still run the check; upsertItem below is the everyday item-in-item-out entry point
// built on top of it.
//
// The name arm only fires when BOTH names are present: an undecryptable item's name is
// `undefined`, and `undefined === undefined` would wrongly collapse every undecryptable row into
// one "match", evicting every undecryptable sibling whenever any undecryptable item arrived.
export function keepAgainstIncoming(
	existingUuid: string,
	existingName: string | undefined,
	incomingUuid: string,
	incomingName: string | undefined
): boolean {
	if (existingUuid === incomingUuid) {
		return false
	}

	const normalizedExistingName = existingName?.toLowerCase().trim()
	const normalizedIncomingName = incomingName?.toLowerCase().trim()

	if (normalizedExistingName !== undefined && normalizedIncomingName !== undefined && normalizedExistingName === normalizedIncomingName) {
		return false
	}

	return true
}

// Insert an incoming item into a cached listing, replacing (never duplicating) whatever row it
// collides with — see keepAgainstIncoming.
export function upsertItem<T extends DriveItemLike>(items: T[], incoming: T): T[] {
	return [
		...items.filter(existing =>
			keepAgainstIncoming(existing.data.uuid, existing.data.decryptedMeta?.name, incoming.data.uuid, incoming.data.decryptedMeta?.name)
		),
		incoming
	]
}

// Drop a row by uuid.
export function removeByUuid<T extends DriveItemLike>(items: T[], uuid: string): T[] {
	return items.filter(item => item.data.uuid !== uuid)
}

// Membership-list splice: a membership listing (favorites, trash) can gain a row a normal
// map-only row-patch updater could never ADD — this is what lets a membership change do that.
// Dedups on uuid ALONE, not name: membership aggregates across every directory, so two members
// may legitimately share a name.
export function applyMembershipPatch<T extends DriveItemLike>(list: T[], item: T, isMember: boolean): T[] {
	const withoutItem = removeByUuid(list, item.data.uuid)

	return isMember ? [...withoutItem, item] : withoutItem
}
