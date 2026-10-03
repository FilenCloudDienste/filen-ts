import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query"
import { noDiskPersister } from "@/queries/persist"
import { archiveNameInfo, cachedArchiveNameInfo } from "@/features/drive/lib/archiveHelpers"
import type { ArchiveNameInfo } from "@/workers/sdk.worker"

// What the SDK makes of an archive's name: its format (a single compressed file extracts as one file)
// and the directory name an extract creates. Asked only by a mounted consumer (an open Extract submenu,
// the extract dialog, the compress dialog's single-file name); the helper batches a tick's names into
// one worker call and remembers the answers, so a menu opened again starts resolved. The SDK answers
// from the name alone, in memory, so a disk row per name would only cost writes and a boot-time
// restore. A name typed into a form keeps the last answer shown while the next one is asked.
export function useArchiveNameInfo(name: string, enabled = true): UseQueryResult<ArchiveNameInfo> {
	return useQuery({
		queryKey: ["archive", "nameInfo", name],
		queryFn: () => archiveNameInfo(name),
		initialData: enabled ? cachedArchiveNameInfo(name) : undefined,
		placeholderData: keepPreviousData,
		enabled,
		staleTime: Infinity,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		persister: noDiskPersister
	})
}
