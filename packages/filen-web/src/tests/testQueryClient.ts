import { createElement, type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { QUERY_DEFAULTS } from "@/queries/clientDefaults"

// The production defaults minus the persister (sqlite, unavailable under vitest). gcTime is Infinity so
// no cache entry is collected mid-test.
export function createTestQueryClient(): QueryClient {
	return new QueryClient({ defaultOptions: { queries: { ...QUERY_DEFAULTS, gcTime: Infinity } } })
}

export function queryClientWrapper(client: QueryClient) {
	return function QueryClientWrapper({ children }: { children: ReactNode }) {
		return createElement(QueryClientProvider, { client, children })
	}
}
