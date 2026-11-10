import { useCallback, useState, type ReactNode } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@filen/shared"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

export interface VirtualRow {
	key: string
	kind: "group" | "action"
}

const GROUP_HEIGHT = 44
const ACTION_HEIGHT = 52
const OVERSCAN = 8

// The shortcuts list as a window over its rows: hundreds of actions once every editor registers its keys, each row a
// handful of buttons. Rows vary in height (a hint, wrapped keys, a conflict panel), so each is measured as it renders.
// Its own file, as useVirtualizer opts its host out of the React Compiler (the list itself stays compiled); memoized
// by hand.
export function ShortcutsRows<R extends VirtualRow>({
	rows,
	className,
	label,
	renderRow
}: {
	rows: readonly R[]
	className?: string
	label: string
	renderRow: (row: R) => ReactNode
}) {
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	// The virtualizer re-lays every row when these change, so they change with the rows only.
	const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows])
	const estimateSize = useCallback((index: number) => (rows[index]?.kind === "group" ? GROUP_HEIGHT : ACTION_HEIGHT), [rows])
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize,
		overscan: OVERSCAN,
		getItemKey
	})

	return (
		<div
			ref={setScrollElement}
			className={cn("min-h-0 overflow-y-auto", className)}
		>
			<ul
				aria-label={label}
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(item => {
					const row = rows[item.index]

					if (row === undefined) {
						return null
					}

					return (
						<li
							key={item.key}
							ref={virtualizer.measureElement}
							data-index={item.index}
							data-action-id={row.kind === "action" ? row.key : undefined}
							className="absolute top-0 left-0 w-full"
							style={{ transform: `translateY(${String(item.start)}px)` }}
						>
							{renderRow(row)}
						</li>
					)
				})}
			</ul>
		</div>
	)
}
