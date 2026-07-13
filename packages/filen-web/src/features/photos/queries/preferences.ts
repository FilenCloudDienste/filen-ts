import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { getPhotosGridDensity } from "@/features/photos/lib/gridDensity"

// Plain query, same shape as shell's own sidebarWidth/startScreen kv-backed queries: the density
// control awaits setPhotosGridDensity then calls this query's own `.refetch()` — no invalidate
// indirection needed for a single-consumer preference like this.
export function usePhotosGridDensityQuery(): UseQueryResult<number> {
	return useQuery({
		queryKey: ["photos", "gridDensity"] as const,
		queryFn: getPhotosGridDensity
	})
}
