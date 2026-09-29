import { useSidebarWidthQuery } from "@/features/shell/queries/sidebarWidth"
import { setSidebarWidth, widthFromDrag, widthFromKey, DEFAULT_SIDEBAR_WIDTH, type SidebarModule } from "@/features/shell/lib/sidebarWidth"
import { useSeparatorValue, type SeparatorValue } from "@/lib/useSeparatorValue"

export type ResizableSidebarHandle = Omit<SeparatorValue, "value"> & { width: number }

// Drive/Notes/Chats each call this with their own SidebarModule so the three widths persist
// independently under features/shell/lib/sidebarWidth.ts's per-module kv keys.
export function useResizableSidebar(module: SidebarModule): ResizableSidebarHandle {
	const widthQuery = useSidebarWidthQuery(module)
	const { value, ...handlers } = useSeparatorValue({
		persisted: widthQuery.data ?? DEFAULT_SIDEBAR_WIDTH,
		fromPointer: widthFromDrag,
		fromKey: widthFromKey,
		commit: width => setSidebarWidth(module, width),
		refetch: () => widthQuery.refetch()
	})

	return { width: value, ...handlers }
}
