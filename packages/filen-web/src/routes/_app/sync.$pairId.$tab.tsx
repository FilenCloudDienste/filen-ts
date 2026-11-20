import { createFileRoute, redirect } from "@tanstack/react-router"
import { syncTab } from "@/features/sync/lib/syncTabs"

// One tab of a pair's detail, rendered by the layout (sync.$pairId.tsx). A tab this app does not have opens the
// pair's default tab.
export const Route = createFileRoute("/_app/sync/$pairId/$tab")({
	beforeLoad: ({ params }) => {
		if (!syncTab.allows(params.tab)) {
			throw redirect({ to: "/sync/$pairId", params: { pairId: params.pairId }, replace: true })
		}
	}
})
