import { createFileRoute } from "@tanstack/react-router"
import { syncTab, type SyncTab } from "@/features/sync/lib/syncTabs"
import { useSyncPair } from "@/features/sync/lib/syncStore"
import { SyncPairDetail } from "@/features/sync/components/syncPairDetail"
import { SyncPlaceholder } from "@/features/sync/components/syncPlaceholder"

// One sync pair's detail; `pairId` is the pair's decimal id. An unknown `tab` falls back to the default tab.
interface SyncPairSearch {
	tab?: SyncTab
}

function validateSearch(search: Record<string, unknown>): SyncPairSearch {
	const raw = search["tab"]

	return syncTab.allows(raw) ? { tab: raw } : {}
}

export const Route = createFileRoute("/_app/sync/$pairId")({ validateSearch, component: SyncPairPage })

// Resolved from the one overview the shell pushes, never a per-pair read. An id it does not hold (a removed
// pair, a stale notification) shows the placeholder.
function SyncPairPage() {
	const { pairId } = Route.useParams()
	const { tab } = Route.useSearch()
	const pair = useSyncPair(pairId)

	if (pair === undefined) {
		return <SyncPlaceholder missing />
	}

	return (
		// Keyed: nothing one pair's page holds (its activity, resolved rows, drafts) carries over to the next.
		<SyncPairDetail
			key={pair.id}
			pair={pair}
			tab={tab ?? "activity"}
		/>
	)
}
