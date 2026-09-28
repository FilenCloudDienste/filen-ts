import type { UseQueryResult } from "@tanstack/react-query"

// The error a view should replace itself with: only while the query has nothing to show. A failed
// background refresh keeps the data query-core already holds, and the view stays up on it (the
// query cache's onError has logged the failure).
export function blockingQueryError(query: Pick<UseQueryResult, "status" | "error" | "data">): Error | null {
	return query.status === "error" && query.data === undefined ? query.error : null
}
