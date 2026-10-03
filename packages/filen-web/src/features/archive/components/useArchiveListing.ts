import { useContext, useState, useSyncExternalStore } from "react"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import { createEntryStore } from "@/features/archive/lib/entryStore"
import { ListingCacheContext, type ListingCache } from "@/features/archive/lib/listingCache"
import { openListingSession, type ListingDeps, type ListingSession, type ListingSnapshot } from "@/features/archive/lib/listingSession"

// One archive's listing session for a browser. The session opens when the browser subscribes (after its
// first commit) and is disposed when it unsubscribes, so StrictMode's mount-unmount-mount and a step
// through the pager each end the run they started; a remount reopens from the host's listing cache.
// Re-renders only on the session's notifications: ≤ 5 a second while a listing streams.
interface ListingHolder {
	uuid: string
	subscribe: (listener: () => void) => () => void
	getSnapshot: () => ListingSnapshot
	// Null before the first subscription and after the last.
	session: () => ListingSession | null
	// Where a cached listing was left: the browser's starting directory.
	restoredDirPath: string
}

function listingHolder(source: ArchiveSource, deps: ListingDeps | undefined, cache: ListingCache | null): ListingHolder {
	const placeholder: ListingSnapshot = { phase: { type: "resolving" }, store: createEntryStore(), version: 0, info: null }
	let session: ListingSession | null = null

	return {
		uuid: source.uuid,
		subscribe: listener => {
			const opened = openListingSession(source, deps, cache)
			const unsubscribe = opened.subscribe(listener)

			session = opened

			return () => {
				unsubscribe()
				opened.dispose()

				if (session === opened) {
					session = null
				}
			}
		},
		getSnapshot: () => session?.getSnapshot() ?? placeholder,
		session: () => session,
		restoredDirPath: cache?.get(source.uuid)?.lastDirPath ?? ""
	}
}

export interface ArchiveListing {
	snapshot: ListingSnapshot
	// For event handlers only: null while unsubscribed.
	session: () => ListingSession | null
	restoredDirPath: string
}

export function useArchiveListing(source: ArchiveSource, deps?: ListingDeps): ArchiveListing {
	const cache = useContext(ListingCacheContext)
	const [holder, setHolder] = useState(() => listingHolder(source, deps, cache))

	if (holder.uuid !== source.uuid) {
		setHolder(listingHolder(source, deps, cache))
	}

	const snapshot = useSyncExternalStore(holder.subscribe, holder.getSnapshot)

	return { snapshot, session: holder.session, restoredDirPath: holder.restoredDirPath }
}
