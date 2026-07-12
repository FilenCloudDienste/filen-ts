import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { getStartScreen, type StartScreen } from "@/features/shell/lib/startScreen"

// Same plain-fn-then-refetch shape as the sidebar-width query: the Appearance page's select awaits
// setStartScreen then calls this query's `.refetch()`.
export function useStartScreenQuery(): UseQueryResult<StartScreen> {
	return useQuery({
		queryKey: ["shell", "startScreen"] as const,
		queryFn: getStartScreen
	})
}
