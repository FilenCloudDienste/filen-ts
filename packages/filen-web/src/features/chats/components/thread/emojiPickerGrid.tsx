import { useState, type RefObject } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@filen/shared"
import type { EmojiSuggestion } from "@/features/chats/lib/emoji"
import { emojiCellId, emojiLabel, moveGridIndex } from "@/features/chats/lib/emojiPicker.logic"
import { withSkinTone } from "@/features/chats/lib/emojiData"
import type { SkinTone } from "@/features/chats/lib/skinTone"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

const EMOJI_GRID_COLUMNS = 8
const CELL_SIZE = 36
const OVERSCAN = 3
// The scroller's fixed height (h-64), so the first paint has rows before the scroller is measured.
const VIEWPORT_HEIGHT = 256

// The picker's emoji as a virtualized grid of fixed rows: only the rows in view are in the DOM, so a custom image loads
// only once its row scrolls in. The grid is one Tab stop driving its cells through aria-activedescendant: arrow keys,
// Home and End move the active cell, Enter or Space picks it. Its own file, as useVirtualizer opts its host out of the
// React Compiler.
export function EmojiPickerGrid({
	gridId,
	gridRef,
	label,
	items,
	activeIndex,
	skinTone,
	onActiveIndexChange,
	onPick
}: {
	gridId: string
	gridRef: RefObject<HTMLDivElement | null>
	label: string
	items: readonly EmojiSuggestion[]
	activeIndex: number
	skinTone: SkinTone
	onActiveIndexChange: (index: number) => void
	onPick: (item: EmojiSuggestion) => void
}) {
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const rowCount = Math.ceil(items.length / EMOJI_GRID_COLUMNS)
	const virtualizer = useVirtualizer({
		count: rowCount,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => CELL_SIZE,
		overscan: OVERSCAN,
		initialRect: { width: 0, height: VIEWPORT_HEIGHT }
	})
	const active = items.length > 0 ? Math.min(activeIndex, items.length - 1) : -1

	function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
		if (active === -1) {
			return
		}

		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault()

			const item = items[active]

			if (item !== undefined) {
				onPick(item)
			}

			return
		}

		const next = moveGridIndex(active, event.key, items.length, EMOJI_GRID_COLUMNS)

		if (next === null) {
			return
		}

		event.preventDefault()
		onActiveIndexChange(next)
		virtualizer.scrollToIndex(Math.floor(next / EMOJI_GRID_COLUMNS))
	}

	return (
		<div
			ref={setScrollElement}
			// The focus ring sits on the scroller: on the full-height grid its top and bottom edges would be clipped.
			className="h-64 overflow-y-auto rounded-xl has-focus-visible:ring-3 has-focus-visible:ring-ring/30"
		>
			<div
				ref={gridRef}
				id={gridId}
				role="grid"
				aria-label={label}
				aria-rowcount={rowCount}
				aria-colcount={EMOJI_GRID_COLUMNS}
				aria-activedescendant={active !== -1 ? emojiCellId(gridId, active) : undefined}
				tabIndex={0}
				onKeyDown={onKeyDown}
				className="relative w-full outline-none"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(row => (
					<div
						key={row.key}
						role="row"
						aria-rowindex={row.index + 1}
						className="absolute top-0 left-0 flex w-full"
						style={{ height: CELL_SIZE, transform: `translateY(${String(row.start)}px)` }}
					>
						{Array.from({ length: EMOJI_GRID_COLUMNS }, (_, column) => {
							const index = row.index * EMOJI_GRID_COLUMNS + column
							const item = items[index]

							if (item === undefined) {
								return null
							}

							const name = emojiLabel(item)

							return (
								<div
									key={item.kind === "standard" ? item.char : `custom-${item.name}`}
									id={emojiCellId(gridId, index)}
									role="gridcell"
									aria-selected={index === active}
									aria-label={name}
									title={name}
									className={cn(
										"flex shrink-0 cursor-default items-center justify-center rounded-lg",
										index === active ? "bg-accent" : "hover:bg-accent/50"
									)}
									style={{ width: CELL_SIZE, height: CELL_SIZE }}
									onMouseDown={event => {
										// The grid keeps focus; the pick closes the picker and hands focus back to the composer.
										event.preventDefault()
									}}
									onClick={() => {
										onPick(item)
									}}
								>
									{item.kind === "custom" ? (
										<img
											src={item.imageUrl}
											alt=""
											loading="lazy"
											// require-corp COEP needs a CORS-mode request for the cross-origin CDN image (see
											// messageContent.tsx).
											crossOrigin="anonymous"
											className="size-6 object-contain"
										/>
									) : (
										<span
											aria-hidden="true"
											className="text-2xl leading-none"
										>
											{withSkinTone(item, skinTone)}
										</span>
									)}
								</div>
							)
						})}
					</div>
				))}
			</div>
		</div>
	)
}
