import { useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useElementSize } from "@/lib/useElementSize"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { codePointAt, codePointLabel, type GlyphIndex } from "@/features/preview/components/fontViewer.logic"

const CELL_SIZE = 72
const OVERSCAN = 4

// Every code point the font maps, as a virtualized grid: only the rows in view are in the DOM (a CJK font maps tens of
// thousands).
export function GlyphGrid({ family, glyphs, settings }: { family: string; glyphs: GlyphIndex; settings: string }) {
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const { width } = useElementSize(scrollElement)
	const columns = Math.max(1, Math.floor(width / CELL_SIZE))
	const rows = Math.ceil(glyphs.count / columns)
	const virtualizer = useVirtualizer({
		count: rows,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => CELL_SIZE,
		overscan: OVERSCAN
	})

	return (
		<div
			ref={setScrollElement}
			className="min-h-0 flex-1 scrollbar-gutter-stable overflow-y-auto px-4"
		>
			<div
				role="list"
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(row => (
					<div
						key={row.key}
						className="absolute top-0 left-0 flex w-full"
						style={{ height: CELL_SIZE, transform: `translateY(${String(row.start)}px)` }}
					>
						{Array.from({ length: columns }, (_, column) => {
							const codePoint = codePointAt(glyphs, row.index * columns + column)

							if (codePoint === -1) {
								return null
							}

							const label = codePointLabel(codePoint)

							return (
								<div
									key={column}
									role="listitem"
									title={label}
									className="flex shrink-0 flex-col items-center justify-center gap-1 rounded-md hover:bg-muted"
									style={{ width: CELL_SIZE, height: CELL_SIZE }}
								>
									<span
										className="text-3xl leading-none"
										style={{ fontFamily: `"${family}"`, fontVariationSettings: settings }}
									>
										{String.fromCodePoint(codePoint)}
									</span>
									<span className="text-[10px] text-muted-foreground tabular-nums">{label}</span>
								</div>
							)
						})}
					</div>
				))}
			</div>
		</div>
	)
}
