import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { getRailOrder, setRailOrder } from "@/features/shell/lib/railOrder"
import { normalizeRailOrder, type RailEntryId } from "@/features/shell/lib/railOrder.logic"
import { queryClient } from "@/queries/client"

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
// the write is the source of truth, so nothing is read back.
export function saveRailOrder(next: RailEntryId[]): void {
	queryClient.setQueryData(RAIL_ORDER_QUERY_KEY, next)
	void setRailOrder(next)
}
