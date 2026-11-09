import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { toast } from "sonner"
import { getRailOrder, setRailOrder } from "@/features/shell/lib/railOrder"
import { normalizeRailOrder, type RailEntryId } from "@/features/shell/lib/railOrder.logic"
import { queryClient } from "@/queries/client"
import { i18n } from "@/lib/i18n"
import { log } from "@/lib/log"

const RAIL_ORDER_QUERY_KEY = ["shell", "railOrder"] as const

export function useRailOrderQuery(): UseQueryResult<RailEntryId[]> {
	return useQuery({
		queryKey: RAIL_ORDER_QUERY_KEY,
		queryFn: getRailOrder,
		// The persisted query cache can hand back an order an older build stored, before the read below normalized it.
		select: normalizeRailOrder
	})
}

// Shows the new order at once and stores it: the rail and the Appearance reset share this query, and
// the write is the source of truth, so nothing is read back. A failed write puts the shown order back,
// or the persisted query cache would bring the unsaved order back on the next boot and then flip.
// Resolves false on that failure, after its error toast, so a caller can confirm only a stored order.
export async function storeRailOrder(next: RailEntryId[]): Promise<boolean> {
	const previous = queryClient.getQueryData<RailEntryId[]>(RAIL_ORDER_QUERY_KEY)

	queryClient.setQueryData(RAIL_ORDER_QUERY_KEY, next)

	// As the cache holds it (structural sharing may keep parts of the previous array).
	const shown = queryClient.getQueryData<RailEntryId[]>(RAIL_ORDER_QUERY_KEY)

	const saved = await setRailOrder(next).then(
		() => true,
		(e: unknown) => {
			log.warn("shell", "rail order write failed", e instanceof Error ? e.message : e)

			return false
		}
	)

	if (saved) {
		return true
	}

	// Only while nothing newer was shown meanwhile.
	if (queryClient.getQueryData(RAIL_ORDER_QUERY_KEY) === shown) {
		queryClient.setQueryData(RAIL_ORDER_QUERY_KEY, previous)
	}

	toast.error(i18n.t("settings:settingsDocumentsSaveFailed"))

	return false
}

// For callers with nothing to confirm (a drag on the rail): the failure path above still runs.
export function saveRailOrder(next: RailEntryId[]): void {
	void storeRailOrder(next)
}
