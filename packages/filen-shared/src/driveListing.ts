import type { DriveItemLike } from "./driveItem"

function collisionName(name: string | undefined): string | undefined {
	return name?.toLowerCase().trim()
}

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

	const normalizedExistingName = collisionName(existingName)
	const normalizedIncomingName = collisionName(incomingName)

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

// upsertItem over each incoming item in turn, in one pass: a row survives only if no incoming item
// collides with it, and an incoming item only if no later one does. Unchanged when nothing comes in.
export function upsertItems<T extends DriveItemLike>(items: T[], incoming: readonly T[]): T[] {
	if (incoming.length === 0) {
		return items
	}

	const incomingUuids = new Set<string>()
	const incomingNames = new Set<string>()
	const survivors: T[] = []

	for (let i = incoming.length - 1; i >= 0; i--) {
		const item = incoming[i]

		if (item === undefined) {
			continue
		}

		const name = collisionName(item.data.decryptedMeta?.name)

		if (!incomingUuids.has(item.data.uuid) && (name === undefined || !incomingNames.has(name))) {
			survivors.push(item)
		}

		incomingUuids.add(item.data.uuid)

		if (name !== undefined) {
			incomingNames.add(name)
		}
	}

	const result = items.filter(existing => {
		const name = collisionName(existing.data.decryptedMeta?.name)

		return !incomingUuids.has(existing.data.uuid) && (name === undefined || !incomingNames.has(name))
	})

	for (let i = survivors.length - 1; i >= 0; i--) {
		const item = survivors[i]

		if (item !== undefined) {
			result.push(item)
		}
	}

	return result
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
