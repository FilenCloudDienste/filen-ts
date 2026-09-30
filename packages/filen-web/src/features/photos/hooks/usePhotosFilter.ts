import { useDeferredValue } from "react"
import { type PhotosListing } from "@/features/photos/queries/photos"
import { filterPhotos, monthNameTable, photoKindsPresent, type PhotosFilter, type PhotosKindFilter } from "@/features/photos/lib/search"

// A hook so its results reach PhotoGrid frozen: the compiler assumes any call may mutate its arguments,
// so filtering inline would share one memo scope with the selection and the timeline, and a selection
// change or resize would re-filter the whole library.
export function usePhotosFilter(listing: PhotosListing, filter: PhotosFilter, language: string) {
	// Typing stays responsive over a large library: the grid re-filters at lower priority than the input.
	const query = useDeferredValue(filter.query)
	const favoritesOnly = filter.favoritesOnly
	const kinds = photoKindsPresent(listing.photos, listing.folders)
	// Kind chips only show while the listing holds two kinds or more; a kind that has since vanished (its
	// last video trashed) must not leave the grid filtered by a chip no longer on screen.
	const kind: PhotosKindFilter = kinds.size > 1 && filter.kind !== "all" && kinds.has(filter.kind) ? filter.kind : "all"
	const filtered = filterPhotos(listing.photos, listing.folders, { query, kind, favoritesOnly }, monthNameTable(language))

	return { query, favoritesOnly, kinds, kind, filtered }
}
