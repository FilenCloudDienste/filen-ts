import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { queryClient } from "@/queries/client"
import { getPhotosRoot } from "@/features/photos/lib/root"

// Same plain-fn-then-invalidate shape as startScreen.ts/sidebarWidth.ts's own kv-backed queries.
export function photosRootQueryKey() {
	return ["photos", "root"] as const
}

export function usePhotosRootQuery(): UseQueryResult<string | null> {
	return useQuery({
		queryKey: photosRootQueryKey(),
		queryFn: getPhotosRoot
	})
}

// Called after every write to the kv key (a fresh choice, or a root-gone reset) so every mounted
// consumer of usePhotosRootQuery picks up the new value on its own next render.
export function invalidatePhotosRoot(): void {
	void queryClient.invalidateQueries({ queryKey: photosRootQueryKey() })
}
