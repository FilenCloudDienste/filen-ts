import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { getSidebarWidth, type SidebarModule } from "@/features/shell/lib/sidebarWidth"

// Plain query per module — writes stay the same plain-fn-then-refetch shape as the notes md
// split-pane's own useMdSplitRatioQuery: the resize handle awaits setSidebarWidth then calls this
// query's `.refetch()`.
export function useSidebarWidthQuery(module: SidebarModule): UseQueryResult<number> {
	return useQuery({
		queryKey: ["shell", "sidebarWidth", module] as const,
		queryFn: () => getSidebarWidth(module)
	})
}
