import { useEffect } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { readLastOpened, useLastOpened } from "@/features/shell/lib/lastOpened"
import { useSyncPairIds } from "@/features/sync/lib/syncStore"
import { syncIndexRedirectTarget } from "@/features/sync/lib/indexRedirect.logic"
import { SyncPlaceholder } from "@/features/sync/components/syncPlaceholder"

// The bare /sync index, under the sync layout's desktop guard. Like Notes and Chats it reopens the last opened pair
// (the rail links here) while the overview still holds it; otherwise the select prompt beside the pair list, which
// carries the empty state when there are no pairs. The loader warms the stored value so the decision needs no extra
// render.
export const Route = createFileRoute("/_app/sync/")({
	loader: async () => {
		await readLastOpened("sync")
	},
	component: SyncIndexPage
})

function SyncIndexPage() {
	const navigate = useNavigate()
	const storedId = useLastOpened("sync")
	const pairIds = useSyncPairIds()
	const target = syncIndexRedirectTarget({ storedId, pairIds })

	useEffect(() => {
		if (typeof target === "string") {
			void navigate({ to: "/sync/$pairId", params: { pairId: target }, replace: true })
		}
	}, [target, navigate])

	return <SyncPlaceholder loading={target !== null} />
}
