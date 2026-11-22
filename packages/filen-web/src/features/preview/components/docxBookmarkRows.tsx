import { useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@filen/shared"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

// A row's line (20px) in its py-1, the 2px gap between rows and the list's p-1.
const BOOKMARK_ROW_HEIGHT = 28
const BOOKMARK_ROW_GAP = 2
const BOOKMARK_LIST_PADDING = 4

// A long document's bookmarks run to thousands (every cross-reference and table of contents entry has one): a window
// over fixed-height rows. Its own file, as useVirtualizer opts it out of the React Compiler (the dialogs stay compiled).
export function DocxBookmarkRows({
	names,
	label,
	selected,
	onSelect
}: {
	names: readonly string[]
	label: string
	selected: string | null
	onSelect: (name: string) => void
}) {
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const virtualizer = useVirtualizer({
		count: names.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => BOOKMARK_ROW_HEIGHT,
		gap: BOOKMARK_ROW_GAP,
		paddingStart: BOOKMARK_LIST_PADDING,
		paddingEnd: BOOKMARK_LIST_PADDING,
		overscan: 8,
		getItemKey: index => names[index] ?? index
	})

	return (
		<div
			ref={setScrollElement}
			className="max-h-56 overflow-y-auto rounded-xl border px-1"
		>
			<ul
				aria-label={label}
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(row => {
					const name = names[row.index]

					return name === undefined ? null : (
						<li
							key={row.key}
							aria-posinset={row.index + 1}
							aria-setsize={names.length}
							className="absolute top-0 left-0 w-full"
							style={{ height: BOOKMARK_ROW_HEIGHT, transform: `translateY(${String(row.start)}px)` }}
						>
							<button
								type="button"
								aria-pressed={selected === name}
								className={cn(
									"w-full truncate rounded-lg px-2 py-1 text-left text-sm hover:bg-accent",
									selected === name && "bg-accent text-accent-foreground"
								)}
								onClick={() => {
									onSelect(name)
								}}
							>
								{name}
							</button>
						</li>
					)
				})}
			</ul>
		</div>
	)
}
