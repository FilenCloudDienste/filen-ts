import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"
import { useSidebarWidthQuery } from "@/features/shell/queries/sidebarWidth"
import { setSidebarWidth, widthFromDrag, widthFromKey, DEFAULT_SIDEBAR_WIDTH, type SidebarModule } from "@/features/shell/lib/sidebarWidth"

export interface ResizableSidebarHandle {
	width: number
	onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
	onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
	onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
	onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
	onKeyUp: () => void
	onBlur: () => void
}

// Shared resizable-sidebar primitive, adapted from the notes markdown split-pane's own live-drag-
// override + pointer-capture + commit-on-pointerup pattern (markdownSplitPane.tsx) — the only resize
// prior art in this app. Drive/Notes/Chats each call this with their own SidebarModule so the three
// widths persist independently under features/shell/lib/sidebarWidth.ts's per-module kv keys.
export function useResizableSidebar(module: SidebarModule): ResizableSidebarHandle {
	const widthQuery = useSidebarWidthQuery(module)
	const persistedWidth = widthQuery.data ?? DEFAULT_SIDEBAR_WIDTH
	// Local override backing both the drag and the keyboard adjustment — the persisted query value only
	// ever refreshes after a commit, so neither round-trips through the kv write per pointermove/keydown.
	const [pendingWidth, setPendingWidth] = useState<number | null>(null)
	const width = pendingWidth ?? persistedWidth
	// Doubles as the "currently dragging" flag (non-null while a drag is in progress) and the drag's
	// start values — one ref instead of markdownSplitPane's separate dragging-flag + rect lookup,
	// since this drag needs no container measurement at all.
	const startRef = useRef<{ width: number; clientX: number } | null>(null)
	// "There is an uncommitted adjustment". pendingWidth cannot serve as this test: it is never cleared,
	// so it stays non-null forever after the first adjustment and every later blur would rewrite it.
	const pendingCommitRef = useRef(false)

	// Deliberately does NOT clear pendingWidth. useSidebarWidthQuery is a plain useQuery with no
	// optimistic write, so dropping the local override here would snap the sidebar back to the stale
	// persisted value until the refetch lands, and the next arrow key would compute its step off that
	// stale base. The refetch converges the two onto the same number.
	function commitWidth(): void {
		if (!pendingCommitRef.current || pendingWidth === null) {
			return
		}

		pendingCommitRef.current = false

		void setSidebarWidth(module, pendingWidth).then(() => widthQuery.refetch())
	}

	function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
		event.preventDefault()
		// Seeded from the EFFECTIVE width, not the persisted one: a drag started after a keyboard
		// adjustment would otherwise rewind to the last persisted value on the first pointermove.
		startRef.current = { width, clientX: event.clientX }
		event.currentTarget.setPointerCapture(event.pointerId)
	}

	function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
		const start = startRef.current

		if (start === null) {
			return
		}

		setPendingWidth(widthFromDrag(start.width, start.clientX, event.clientX))
		pendingCommitRef.current = true
	}

	function onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
		if (startRef.current === null) {
			return
		}

		startRef.current = null
		event.currentTarget.releasePointerCapture(event.pointerId)

		commitWidth()
	}

	function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
		const next = widthFromKey(event.key, width)

		if (next === null) {
			return
		}

		// Arrows/Home/End would otherwise scroll the shell behind the focused separator.
		event.preventDefault()
		setPendingWidth(next)
		pendingCommitRef.current = true
	}

	// Commit on release, not on keydown: OS autorepeat fires keydown ~30x/s and each commit is a kv
	// write plus a refetch, so a held key collapses into one write exactly like the pointer path's
	// commit-on-pointerup. Also wired to blur, so focus leaving mid-press never loses an adjustment; a
	// live drag owns its own commit, hence the startRef guard.
	function handleRelease(): void {
		if (startRef.current !== null) {
			return
		}

		commitWidth()
	}

	return { width, onPointerDown, onPointerMove, onPointerUp, onKeyDown, onKeyUp: handleRelease, onBlur: handleRelease }
}
