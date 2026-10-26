import { createFileRoute } from "@tanstack/react-router"
import { syncTab, type SyncTab } from "@/features/sync/lib/syncTabs"

// One sync pair's detail; `pairId` is the pair's decimal id. An unknown `tab` falls back to the default tab.
interface SyncPairSearch {
	tab?: SyncTab
}

function validateSearch(search: Record<string, unknown>): SyncPairSearch {
	const raw = search["tab"]

	return syncTab.allows(raw) ? { tab: raw } : {}
}

export const Route = createFileRoute("/_app/sync/$pairId")({ validateSearch })
