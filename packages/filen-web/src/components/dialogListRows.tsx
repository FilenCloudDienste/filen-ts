import { useCallback, useState, type ReactNode } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { LIST_DIALOG_BODY_CLASS } from "@/components/dialogs/listDialog"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

export interface DialogListRowsProps<T> {
	items: readonly T[]
	// A stable key for the item (its uuid or id).
	itemKey: (item: T) => string
	// A row's height, gap excluded; each row is measured, this only places the ones not yet measured.
	estimateSize: number
	renderItem: (item: T) => ReactNode
}

// The 2px gap between a list dialog's rows.
const ROW_GAP = 2
const OVERSCAN = 8

// A LIST_DIALOG_CLASS dialog's scrolling list of rows as a window over its items: a history of hundreds mounts what is
// in view. Its own component, as useVirtualizer opts its host out of the React Compiler; a scroll step re-renders only
// this.
export function DialogListRows<T>({ items, itemKey, estimateSize, renderItem }: DialogListRowsProps<T>) {
	"use no memo"

	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	// Memoized by hand: the virtualizer re-lays every row when its key function changes, so it changes with the items.
	const getItemKey = useCallback(
		(index: number) => {
			const item = items[index]

			return item === undefined ? index : itemKey(item)
		},
		[items, itemKey]
	)
	const virtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => estimateSize,
		gap: ROW_GAP,
		overscan: OVERSCAN,
		getItemKey
	})

	return (
		<div
			ref={setScrollElement}
			className={`overflow-y-auto ${LIST_DIALOG_BODY_CLASS}`}
		>
			<ul
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(row => {
					const item = items[row.index]

					return item === undefined ? null : (
						<li
							key={row.key}
							ref={virtualizer.measureElement}
							data-index={row.index}
							aria-posinset={row.index + 1}
							aria-setsize={items.length}
							className="absolute top-0 left-0 w-full"
							style={{ transform: `translateY(${String(row.start)}px)` }}
						>
							{renderItem(item)}
						</li>
					)
				})}
			</ul>
		</div>
	)
}
