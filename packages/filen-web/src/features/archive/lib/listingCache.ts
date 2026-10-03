import { createContext } from "react"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import type { ListSummary } from "@/features/archive/lib/listingSession"

// Completed listings of the archives one host (a preview overlay) opened, by file uuid, so stepping back
// to an archive (a tar read in full, say) shows it at once. Each host owns its own cache and closes it
// when it goes; a browser disposed later (React unmounts the host's effects before its children's)
// finds it closed and caches nothing. Their password is held here in memory only, like any job's
// (jobSecrets.ts).
export interface CachedListing {
	store: EntryStore
	summary: ListSummary
	password: string | undefined
	// Where the browser was, "" the archive's root.
	lastDirPath: string
	// What the listing counts toward the budget.
	entries: number
}

export interface ListingCache {
	get: (uuid: string) => CachedListing | undefined
	put: (uuid: string, listing: CachedListing) => void
	// Empties it and refuses every put until opened again.
	close: () => void
	// Its host mounted (again, under StrictMode): from then on sign-out reaches it.
	open: () => void
}

const MAX_LISTINGS = 3
const MAX_ENTRIES = 300_000

// The caches of every host mounted now: sign-out closes them all. A cache joins once its host's effect
// opens it, so one made for a render React threw away is never held here.
const openCaches = new Set<ListingCache>()

export function createListingCache(): ListingCache {
	// In use order, the most recent last.
	const listings = new Map<string, CachedListing>()
	let entries = 0
	let closed = false

	const drop = (uuid: string): void => {
		const listing = listings.get(uuid)

		if (listing !== undefined) {
			listings.delete(uuid)
			entries -= listing.entries
		}
	}

	const cache: ListingCache = {
		get: uuid => {
			const listing = listings.get(uuid)

			if (listing !== undefined) {
				listings.delete(uuid)
				listings.set(uuid, listing)
			}

			return listing
		},
		put: (uuid, listing) => {
			if (closed) {
				return
			}

			drop(uuid)

			if (listing.entries > MAX_ENTRIES) {
				return
			}

			listings.set(uuid, listing)
			entries += listing.entries

			// The one just put fits on its own, so it is never the oldest left.
			while (listings.size > MAX_LISTINGS || entries > MAX_ENTRIES) {
				const oldest = listings.keys().next()

				if (oldest.done === true) {
					break
				}

				drop(oldest.value)
			}
		},
		close: () => {
			closed = true
			listings.clear()
			entries = 0
			openCaches.delete(cache)
		},
		open: () => {
			closed = false
			openCaches.add(cache)
		}
	}

	return cache
}

// Sign-out: no host's cache keeps this account's entry names or passwords.
export function clearArchiveListings(): void {
	for (const cache of [...openCaches]) {
		cache.close()
	}
}

// The cache of the host the browser is in; null caches nothing (a host that mounted no scope).
export const ListingCacheContext = createContext<ListingCache | null>(null)
