import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { getTransferPreferences, type TransferPreferences } from "@/features/settings/lib/transferConfig"

// Same plain-fn-then-refetch shape as the shell's sidebar-width/start-screen queries: the Advanced
// page's controls await setTransferPreferences then call this query's `.refetch()`.
export function useTransferPreferencesQuery(): UseQueryResult<TransferPreferences> {
	return useQuery({
		queryKey: ["settings", "transferPreferences"] as const,
		queryFn: getTransferPreferences
	})
}
