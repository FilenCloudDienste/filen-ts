import { createContext } from "react"
import type { ParentLookup } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { FLAT_LISTING_KINDS } from "@/features/drive/lib/flatListing"
import { cachedOwnParents, ownChain } from "@/features/drive/lib/ownAncestry"
import { cachedDirectoryNames } from "@/features/drive/queries/drive"

// The flat listings whose rows come from anywhere in the drive, so each row names where it sits.
export function showsItemLocation(variant: DriveVariant): boolean {
	return variant === "recents" || variant === "favorites" || variant === "trash"
}

const FLAT_PARENTS: ReadonlySet<string> = new Set(FLAT_LISTING_KINDS)

// The directory an item sits in, or for a trashed one the directory Restore puts it back into.
export function locationParentUuid(item: DriveItem): string | undefined {
	if (item.type !== "directory" && item.type !== "file") {
		return undefined
	}

	const { parent, trashedFrom } = item.data

	if (parent === "trash") {
		return trashedFrom
	}

	return FLAT_PARENTS.has(parent) ? undefined : parent
}

export const LOCATION_PATH_SEPARATOR = " / "

// A listing's row locations, resolved from what the cache already holds: never a request (getItemPath
// takes a write lock on the backend). The parent's name is looked up once per row; the full path walks
// the cached listings and is only built when a row asks for it (hover, keyboard focus).
export interface ItemLocations {
	name: (item: DriveItem) => string | undefined
	path: (item: DriveItem) => string | undefined
}

export interface ItemLocationsParams {
	items: readonly DriveItem[]
	names: ReadonlyMap<string, string>
	// Built on the first path read: it scans every cached listing.
	parents: () => ParentLookup
	rootUuid: string
	rootLabel: string
}

export function createItemLocations({ items, names, parents, rootUuid, rootLabel }: ItemLocationsParams): ItemLocations {
	const parentNames = new Map<string, string>()

	for (const item of items) {
		const parent = locationParentUuid(item)
		const name = parent === undefined ? undefined : parent === rootUuid ? rootLabel : names.get(parent)

		if (name !== undefined) {
			parentNames.set(item.data.uuid, name)
		}
	}

	let parentOf: ParentLookup | undefined = undefined

	function path(item: DriveItem): string | undefined {
		const parent = locationParentUuid(item)

		if (parent === undefined || !parentNames.has(item.data.uuid)) {
			return undefined
		}

		if (parent === rootUuid) {
			return rootLabel
		}

		parentOf ??= parents()

		const segments = [rootLabel]

		// An empty chain: a link above the parent is not cached.
		for (const uuid of ownChain(parent, parentOf)) {
			const name = names.get(uuid)

			if (name === undefined) {
				return undefined
			}

			segments.push(name)
		}

		return segments.length > 1 ? segments.join(LOCATION_PATH_SEPARATOR) : undefined
	}

	return {
		name: item => parentNames.get(item.data.uuid),
		path
	}
}

export function cachedItemLocations({
	items,
	rootUuid,
	rootLabel
}: Pick<ItemLocationsParams, "items" | "rootUuid" | "rootLabel">): ItemLocations {
	return createItemLocations({ items, names: cachedDirectoryNames(), parents: cachedOwnParents, rootUuid, rootLabel })
}

// Null outside the listings that show locations. The value keeps its identity while the listing's rows
// do, so scrolling never re-renders a cell through it.
export const ItemLocationContext = createContext<ItemLocations | null>(null)
