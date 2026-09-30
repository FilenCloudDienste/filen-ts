import type { DriveItem } from "@/features/drive/lib/item"
import { DRIVE_LISTING_KEY_PREFIX, type DriveListingParams } from "@/features/drive/queries/drive"
import { type ParentLookup } from "@filen/shared"
import { ownDirectoryUuids } from "@/features/drive/components/moveTargetDialog.logic"
import { cachedQueriesWithPrefix } from "@/queries/patch"

// The user's own directory tree as the cached listings record it: a directory's parent is the listing
// that holds it. My Drive's listings count, and so do nested Shared by me listings (the user's own
// directories below a shared one). The Shared by me root doesn't: its rows aren't the root's children.
// Neither do other people's shares or the flat views, whose rows sit anywhere.
interface OwnListing {
	parent: string | null
	directories: ReadonlySet<string>
}

function ownListings(): OwnListing[] {
	const listings: OwnListing[] = []

	for (const query of cachedQueriesWithPrefix(DRIVE_LISTING_KEY_PREFIX)) {
		const { variant, uuid } = query.queryKey[2] as DriveListingParams
		const data = query.state.data as readonly DriveItem[] | undefined

		if (data !== undefined && (variant === "drive" || (variant === "sharedOut" && uuid !== null))) {
			listings.push({ parent: uuid, directories: ownDirectoryUuids(data) })
		}
	}

	return listings
}

// Parents as the listings cached right now record them: null for a directory in My Drive's root
// listing, undefined when no listing holds it or two disagree (a row a move left behind).
export function cachedOwnParents(): ParentLookup {
	const listings = ownListings()

	return uuid => {
		let parent: string | null | undefined = undefined

		for (const listing of listings) {
			if (!listing.directories.has(uuid)) {
				continue
			}

			if (parent !== undefined && parent !== listing.parent) {
				return undefined
			}

			parent = listing.parent
		}

		return parent
	}
}

// A drop target's parents, for walking its real chain up to the account root: its own parent where the
// caller knows it (a listing row's), then the cached listings. undefined past what they hold.
export function targetOwnParents({ uuid, parent, rootUuid }: { uuid: string; parent: string | undefined; rootUuid: string }): ParentLookup {
	const cached = cachedOwnParents()

	return current => {
		const next = current === uuid && parent !== undefined ? parent : cached(current)

		return next === rootUuid ? null : next
	}
}
