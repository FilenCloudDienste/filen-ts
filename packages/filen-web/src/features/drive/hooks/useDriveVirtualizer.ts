import { useCallback, useEffect, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useElementSize } from "@/lib/useElementSize"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveViewMode } from "@/features/drive/lib/preferences"
import { GRID_INSET, ROW_HEIGHT, TILE_WIDTH, TILE_ROW_HEIGHT, columnsForWidth } from "@/features/drive/lib/gridLayout"
import { setThumbnailViewport } from "@/features/drive/lib/thumbnails"
import { rowRank } from "@/features/drive/lib/thumbnails.logic"
import { driveRowKey } from "@/features/drive/lib/rowKey"
import { useRovingItemRefs } from "@/features/drive/hooks/useRovingItemRefs"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { pendingBlockHeight } from "@/features/drive/lib/pendingUploads.logic"

const LIST_OVERSCAN = 8
const GRID_OVERSCAN = 3

// The listbox's layout/scroll layer: the list + grid virtualizers, the scroll container ref, the
// responsive column math, and the per-index DOM ref map the keyboard nav focuses into. Kept separate
// from the roving-cursor navigation (useDriveListboxNav) that sits on top of it. `pendingRows` pending
// transfer rows sit above the items in the scrolled layer, so the items start below them.
export function useDriveVirtualizer(items: DriveItem[], viewMode: DriveViewMode, pendingRows = 0) {
	// State (not `useRef`) so it's settable from a callback ref below — the pending/error/empty
	// branches render a ref-less div, so a cold mount whose first render is "pending" would, with a
	// `useRef` + `[]`-dep effect, never attach an observer for the component's whole lifetime, and a
	// later pending<->success swap would leave one observing a detached node. A callback ref instead
	// fires on every mount/unmount of the actual DOM node regardless of which branch renders it first.
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const itemRefs = useRovingItemRefs()
	const { width: containerWidth, height: containerHeight } = useElementSize(scrollElement)

	// Keeps the thumbnail service's bounded objectURL cache sized to what this listing can actually
	// show — the size observer already fires on every layout change that matters (OS window resize,
	// sidebar collapse, and the width/height jump a view-mode toggle causes), so there is no separate
	// window-resize listener anywhere in the thumbnail service itself.
	useEffect(() => {
		setThumbnailViewport(containerWidth, containerHeight, viewMode)
	}, [containerWidth, containerHeight, viewMode])

	const columns = columnsForWidth(containerWidth, TILE_WIDTH)
	const rowCount = Math.ceil(items.length / columns)
	const pendingHeight = pendingBlockHeight(pendingRows, viewMode, columns)

	// By row, not uuid: the Shared by me root lists one item once per receiver. Memoized by hand
	// (useVirtualizer opts this hook out of the React Compiler): the virtualizer re-lays every row when its
	// key function changes, so it must change with the items and nothing else.
	const getListItemKey = useCallback(
		(index: number) => {
			const item = items[index]

			return item ? driveRowKey(item) : index
		},
		[items]
	)

	// Only the active virtualizer listens to the shared scroll element: an enabled inactive one would still
	// re-render the whole listing on every change of its own visible range. The listbox element persists
	// across a view toggle but a re-enabled instance does not read its offset on attach, so it starts from
	// the element's current scrollTop.
	const initialOffset = () => scrollElement?.scrollTop ?? 0

	const listVirtualizer = useVirtualizer({
		count: items.length,
		enabled: viewMode === "list",
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		initialOffset,
		estimateSize: () => ROW_HEIGHT,
		paddingStart: pendingHeight,
		overscan: LIST_OVERSCAN,
		getItemKey: getListItemKey
	})

	// Keyed by index through the library's default key function, which unlike an inline one is stable.
	const gridVirtualizer = useVirtualizer({
		count: rowCount,
		enabled: viewMode === "grid",
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		initialOffset,
		estimateSize: () => TILE_ROW_HEIGHT,
		paddingStart: pendingHeight,
		overscan: GRID_OVERSCAN,
		// The listbox's CSS padding shifts every row down by GRID_INSET, which the virtualizer's offsets
		// do not know about: scrolling a row into view at the bottom has to clear that shift plus the
		// bottom inset, or the row lands half-hidden.
		scrollPaddingEnd: GRID_INSET * 2
	})

	const activeVirtualizer = viewMode === "list" ? listVirtualizer : gridVirtualizer

	// For ThumbnailRankContext. The instances are stable and `range` is read when a generation slot frees,
	// so scrolling never changes this function's identity.
	const rankThumbnail = useCallback(
		(index: number) =>
			viewMode === "list" ? rowRank(index, listVirtualizer.range) : rowRank(Math.floor(index / columns), gridVirtualizer.range),
		[viewMode, columns, listVirtualizer, gridVirtualizer]
	)

	return {
		setScrollElement,
		scrollElement,
		columns,
		pendingHeight,
		listVirtualizer,
		gridVirtualizer,
		activeVirtualizer,
		rankThumbnail,
		registerRef: itemRefs.registerRef,
		itemRefs
	}
}

export type DriveVirtualizer = ReturnType<typeof useDriveVirtualizer>
