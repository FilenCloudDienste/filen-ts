import { useCallback, useContext, useLayoutEffect, useState, type KeyboardEvent, type ReactNode } from "react"
import { measureElement, useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/react-virtual"
import { isImeKeydown } from "@filen/shared/keymap"
import { cn } from "@filen/shared"
import { hasCommandModifier } from "@/lib/rowKeys"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { recallRowSize, rememberRowSize } from "@/features/videos/lib/scrollMemory"
import { TitleScrollContext } from "@/features/videos/lib/titleScroll"

// A row with a still (py-3 around a w-28 or w-40 16:9 image) and two lines; each row is measured, this only places
// the ones not yet measured or remembered.
const ROW_ESTIMATE = 100
const OVERSCAN = 4

export interface EpisodeRowsProps {
	count: number
	// A stable key for the row at `index` (its file's stable uuid).
	rowKey: (index: number) => string
	renderRow: (index: number) => ReactNode
}

// The focusable controls of a row, in order (its title link, its menu trigger).
function focusables(row: Element): HTMLElement[] {
	return [...row.querySelectorAll<HTMLElement>("a[href], button:not([tabindex='-1'])")]
}

// A season's episodes as a window over the title page's scroller: a long-running show mounts what is in view. Row
// heights are measured and remembered for the session, so a page come back to lays out as it was left and its scroll
// position lands on the same row. The arrow keys move between rows, keeping the control they are on; a row outside
// the window is scrolled in first, as Tab's focus scrolls the next row in. Its own file, as useVirtualizer opts it out
// of the React Compiler (the series page stays compiled).
export function EpisodeRows({ count, rowKey, renderRow }: EpisodeRowsProps) {
	const scrollElement = useContext(TitleScrollContext)
	const [listElement, setListElement] = useState<HTMLUListElement | null>(null)
	// Where the list starts within the page (below the header, the season picker, and the season list above the
	// specials), which the rows are offset from. Re-measured whenever anything in the page changes size.
	const [scrollMargin, setScrollMargin] = useState(0)

	useLayoutEffect(() => {
		if (scrollElement === null || listElement === null) {
			return
		}

		const scroller = scrollElement
		const list = listElement

		function measure(): void {
			setScrollMargin(list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop)
		}

		measure()

		if (typeof ResizeObserver === "undefined") {
			return
		}

		const observer = new ResizeObserver(measure)

		for (const child of scroller.children) {
			observer.observe(child)
		}

		return () => {
			observer.disconnect()
		}
	}, [scrollElement, listElement])

	// Memoized by hand: the virtualizer re-lays every row when these change, so they change with the rows only.
	const estimateSize = useCallback((index: number) => recallRowSize(rowKey(index)) ?? ROW_ESTIMATE, [rowKey])
	const measure = useCallback(
		(element: Element, entry: ResizeObserverEntry | undefined, instance: Virtualizer<HTMLElement, Element>) => {
			const size = measureElement(element, entry, instance)
			const index = instance.indexFromElement(element)

			if (size > 0 && index >= 0 && index < count) {
				rememberRowSize(rowKey(index), size)
			}

			return size
		},
		[rowKey, count]
	)

	const virtualizer = useVirtualizer({
		count,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize,
		measureElement: measure,
		scrollMargin,
		overscan: OVERSCAN,
		getItemKey: rowKey
	})

	// A row scrolled in from outside the window mounts on a later frame; a few are plenty.
	function focusIn(list: HTMLElement, index: number, slot: number, framesLeft: number): void {
		const row = list.querySelector(`li[data-index="${String(index)}"]`)
		const controls = row === null ? [] : focusables(row)
		const target = controls[Math.min(slot, controls.length - 1)]

		if (target !== undefined) {
			target.focus()
		} else if (framesLeft > 0) {
			requestAnimationFrame(() => {
				focusIn(list, index, slot, framesLeft - 1)
			})
		}
	}

	function handleKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
		const list = event.currentTarget

		// Only the rows' own controls: a row's menu is portalled, and its keys reach here through React.
		if (
			event.defaultPrevented ||
			event.shiftKey ||
			hasCommandModifier(event) ||
			isImeKeydown(event.nativeEvent) ||
			!(event.target instanceof HTMLElement) ||
			!list.contains(event.target)
		) {
			return
		}

		const row = event.target.closest<HTMLElement>("li[data-index]")
		const from = Number(row?.dataset["index"] ?? "-1")

		if (row === null || from < 0) {
			return
		}

		const to =
			event.key === "ArrowDown"
				? from + 1
				: event.key === "ArrowUp"
					? from - 1
					: event.key === "Home"
						? 0
						: event.key === "End"
							? count - 1
							: -1

		if (to < 0 || to >= count || to === from) {
			return
		}

		event.preventDefault()

		const slot = Math.max(0, focusables(row).indexOf(event.target))

		if (list.querySelector(`li[data-index="${String(to)}"]`) === null) {
			virtualizer.scrollToIndex(to)
		}

		focusIn(list, to, slot, 3)
	}

	const virtualItems = virtualizer.getVirtualItems()

	return (
		<ul
			ref={setListElement}
			className="relative w-full"
			style={{ height: virtualizer.getTotalSize() }}
			onKeyDown={handleKeyDown}
		>
			{virtualItems.map((virtualRow: VirtualItem) => (
				<li
					key={virtualRow.key}
					ref={virtualizer.measureElement}
					data-index={virtualRow.index}
					aria-posinset={virtualRow.index + 1}
					aria-setsize={count}
					className={cn("absolute top-0 left-0 w-full", virtualRow.index < count - 1 && "border-b border-border/60")}
					style={{ transform: `translateY(${String(virtualRow.start - scrollMargin)}px)` }}
				>
					{renderRow(virtualRow.index)}
				</li>
			))}
		</ul>
	)
}
