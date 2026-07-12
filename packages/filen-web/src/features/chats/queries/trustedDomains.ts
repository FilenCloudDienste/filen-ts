import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { getTrustedDomains } from "@/features/chats/lib/trustedDomains"

// Cached read of the persisted trust set — shared across every link/embed instance in the tree (one
// domain confirmed in one message trusts it everywhere else too). Same plain-query shape as
// useSidebarWidthQuery: a write (trustDomain, lib/trustedDomains.ts) is a plain async fn the caller
// awaits, then calls this query's own `.refetch()` — mirrors useResizableSidebar's identical
// write-then-refetch precedent, no dedicated mutation hook needed for a single-field kv set.
export function useTrustedDomainsQuery(): UseQueryResult<ReadonlySet<string>> {
	return useQuery({
		queryKey: ["chats", "trustedLinkDomains"] as const,
		queryFn: getTrustedDomains
	})
}
