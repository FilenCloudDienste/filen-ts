import { useEffect, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveViewMode } from "@/features/drive/lib/preferences"
import { ROW_HEIGHT, TILE_WIDTH, TILE_ROW_HEIGHT } from "@/features/drive/lib/gridLayout"
import { setThumbnailViewport } from "@/features/drive/lib/thumbnails"

const LIST_OVERSCAN = 8
const GRID_OVERSCAN = 3

// The listbox's layout/scroll layer: the list + grid virtualizers, the scroll container ref, the
// responsive column math, and the per-index DOM ref map the keyboard nav focuses into. Kept separate
// from the roving-cursor navigation (useDriveListboxNav) that sits on top of it.
export function useDriveVirtualizer(items: DriveItem[], viewMode: DriveViewMode) {
	// State (not `useRef`) so it's settable from a callback ref below — the pending/error/empty
	// branches render a ref-less div, so a cold mount whose first render is "pending" would, with a
	// `useRef` + `[]`-dep effect, never attach an observer for the component's whole lifetime, and a
	// later pending<->success swap would leave one observing a detached node. A callback ref instead
	// fires on every mount/unmount of the actual DOM node regardless of which branch renders it first.
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const itemRefs = useRef(new Map<number, HTMLDivElement>())
	const [containerWidth, setContainerWidth] = useState(0)
	const [containerHeight, setContainerHeight] = useState(0)

	useEffect(() => {
		if (!scrollElement) {
			return
		}

		const observer = new ResizeObserver(entries => {
			const entry = entries[0]

			if (entry) {
				setContainerWidth(entry.contentRect.width)
				setContainerHeight(entry.contentRect.height)
			}
		})

		observer.observe(scrollElement)

		return () => {
			observer.disconnect()
		}
	}, [scrollElement])

	// Keeps the thumbnail service's bounded objectURL cache sized to what this listing can actually
	// show — this ResizeObserver already fires on every layout change that matters (OS window resize,
	// sidebar collapse, and the width/height jump a view-mode toggle causes), so there is no separate
	// window-resize listener anywhere in the thumbnail service itself.
	useEffect(() => {
		setThumbnailViewport(containerWidth, containerHeight, viewMode)
	}, [containerWidth, containerHeight, viewMode])

	const columns = Math.max(1, Math.floor(containerWidth / TILE_WIDTH))
	const rowCount = Math.ceil(items.length / columns)

	const listVirtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => scrollElement,
		estimateSize: () => ROW_HEIGHT,
		overscan: LIST_OVERSCAN,
		getItemKey: index => items[index]?.data.uuid ?? index
	})

	const gridVirtualizer = useVirtualizer({
		count: rowCount,
		getScrollElement: () => scrollElement,
		estimateSize: () => TILE_ROW_HEIGHT,
		overscan: GRID_OVERSCAN,
		getItemKey: index => index
	})

	const activeVirtualizer = viewMode === "list" ? listVirtualizer : gridVirtualizer

	function registerRef(index: number, el: HTMLDivElement | null) {
		if (el) {
			itemRefs.current.set(index, el)
		} else {
			itemRefs.current.delete(index)
		}
	}

	return { setScrollElement, columns, listVirtualizer, gridVirtualizer, activeVirtualizer, registerRef, itemRefs }
}

export type DriveVirtualizer = ReturnType<typeof useDriveVirtualizer>
