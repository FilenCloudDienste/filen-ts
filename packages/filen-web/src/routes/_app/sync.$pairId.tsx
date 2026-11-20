import { useEffect } from "react"
import { createFileRoute, useParams } from "@tanstack/react-router"
import { rememberLastOpened } from "@/features/shell/lib/lastOpened"
import { syncTab } from "@/features/sync/lib/syncTabs"
import { useSyncPair } from "@/features/sync/lib/syncStore"
import { SyncPairDetail } from "@/features/sync/components/syncPairDetail"
import { SyncPlaceholder } from "@/features/sync/components/syncPlaceholder"

// One sync pair's detail; `pairId` is the pair's decimal id. A layout: sync.$pairId.index (/sync/$pairId, the
// activity tab) and sync.$pairId.$tab (/sync/$pairId/$tab) only select the tab, this renders the detail for both, so
// switching tabs keeps the page's state.
export const Route = createFileRoute("/_app/sync/$pairId")({ component: SyncPairPage })

// Resolved from the one overview the shell pushes, never a per-pair read. An id it does not hold (a removed
// pair, a stale notification) shows the placeholder. A resolved pair becomes the one bare /sync reopens.
function SyncPairPage() {
	const { pairId } = Route.useParams()
	const tab = useParams({ from: "/_app/sync/$pairId/$tab", shouldThrow: false, select: params => params.tab })
	const pair = useSyncPair(pairId)
	const resolvedId = pair?.id

	useEffect(() => {
		if (resolvedId !== undefined) {
			rememberLastOpened("sync", resolvedId)
		}
	}, [resolvedId])

	if (pair === undefined) {
		return <SyncPlaceholder missing />
	}

	return (
		// Keyed: nothing one pair's page holds (its activity, resolved rows, drafts) carries over to the next.
		<SyncPairDetail
			key={pair.id}
			pair={pair}
			tab={syncTab.allows(tab) ? tab : "activity"}
		/>
	)
}
