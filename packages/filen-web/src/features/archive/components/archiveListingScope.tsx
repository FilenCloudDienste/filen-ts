import { useEffect, useState, type ReactNode } from "react"
import { createListingCache, ListingCacheContext } from "@/features/archive/lib/listingCache"

// The archive listings a host keeps while it is mounted: the browsers inside it reopen a listing from
// here, and whatever they cached goes with the host.
export function ArchiveListingScope({ children }: { children: ReactNode }) {
	const [cache] = useState(createListingCache)

	useEffect(() => {
		cache.open()

		return () => {
			cache.close()
		}
	}, [cache])

	return <ListingCacheContext value={cache}>{children}</ListingCacheContext>
}
