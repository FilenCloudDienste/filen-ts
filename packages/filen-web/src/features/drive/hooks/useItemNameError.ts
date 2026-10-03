import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query"
import type { EntryNameErrorKindJS } from "@filen/sdk-rs"
import { noDiskPersister } from "@/queries/persist"
import { cachedItemNameError, itemNameError } from "@/features/drive/lib/archiveHelpers"

// How long typing in a name field pauses before the SDK is asked about the name.
export const NAME_CHECK_DEBOUNCE_MS = 250

// Why the SDK would refuse a name typed into a form (null: it takes it), for a field error before
// submit. Pass a debounced name: each distinct one is a worker round trip, kept for the page by the
// helper. The last answer stays shown while the next one is asked.
export function useItemNameError(name: string, enabled = true): UseQueryResult<EntryNameErrorKindJS | null> {
	return useQuery({
		queryKey: ["archive", "itemNameError", name],
		queryFn: () => itemNameError(name),
		initialData: enabled ? cachedItemNameError(name) : undefined,
		placeholderData: keepPreviousData,
		enabled,
		staleTime: Infinity,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		persister: noDiskPersister
	})
}
