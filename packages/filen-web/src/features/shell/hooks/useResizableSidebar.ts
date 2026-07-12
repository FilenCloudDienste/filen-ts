import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { useSidebarWidthQuery } from "@/features/shell/queries/sidebarWidth"
import { setSidebarWidth, widthFromDrag, DEFAULT_SIDEBAR_WIDTH, type SidebarModule } from "@/features/shell/lib/sidebarWidth"

export interface ResizableSidebarHandle {
	width: number
	onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
	onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
	onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
}

// Shared resizable-sidebar primitive, adapted from the notes markdown split-pane's own live-drag-
// override + pointer-capture + commit-on-pointerup pattern (markdownSplitPane.tsx) — the only resize
// prior art in this app. Drive/Notes/Chats each call this with their own SidebarModule so the three
// widths persist independently under features/shell/lib/sidebarWidth.ts's per-module kv keys.
export function useResizableSidebar(module: SidebarModule): ResizableSidebarHandle {
	const widthQuery = useSidebarWidthQuery(module)
	const persistedWidth = widthQuery.data ?? DEFAULT_SIDEBAR_WIDTH
	// Local drag override — the persisted query value only ever refreshes at pointerup, so a live
	// drag never round-trips through the kv write on every pointermove.
	const [dragWidth, setDragWidth] = useState<number | null>(null)
	const width = dragWidth ?? persistedWidth
	// Doubles as the "currently dragging" flag (non-null while a drag is in progress) and the drag's
	// start values — one ref instead of markdownSplitPane's separate dragging-flag + rect lookup,
	// since this drag needs no container measurement at all.
	const startRef = useRef<{ width: number; clientX: number } | null>(null)

	function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
		event.preventDefault()
		startRef.current = { width: persistedWidth, clientX: event.clientX }
		event.currentTarget.setPointerCapture(event.pointerId)
	}

	function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
		const start = startRef.current

		if (start === null) {
			return
		}

		setDragWidth(widthFromDrag(start.width, start.clientX, event.clientX))
	}

	function onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
		if (startRef.current === null) {
			return
		}

		startRef.current = null
		event.currentTarget.releasePointerCapture(event.pointerId)

		const finalWidth = dragWidth

		setDragWidth(null)

		if (finalWidth !== null) {
			void setSidebarWidth(module, finalWidth).then(() => widthQuery.refetch())
		}
	}

	return { width, onPointerDown, onPointerMove, onPointerUp }
}
