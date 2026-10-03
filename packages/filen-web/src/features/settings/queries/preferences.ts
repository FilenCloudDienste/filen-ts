import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { getTransferPreferences, type TransferPreferences } from "@/features/settings/lib/transferConfig"
import { getArchivePreferences, type ArchivePreferences } from "@/features/settings/lib/archiveConfig"

// Same plain-fn-then-refetch shape as the shell's sidebar-width/start-screen queries: the Advanced
// page's controls await their setter then call their query's `.refetch()`.
export function useTransferPreferencesQuery(): UseQueryResult<TransferPreferences> {
	return useQuery({
		queryKey: ["settings", "transferPreferences"] as const,
		queryFn: getTransferPreferences
	})
}

export function useArchivePreferencesQuery(): UseQueryResult<ArchivePreferences> {
	return useQuery({
		queryKey: ["settings", "archivePreferences"] as const,
		queryFn: getArchivePreferences
	})
}
