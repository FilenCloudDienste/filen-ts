import { useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@filen/shared"
import type { LogEntry } from "@/lib/log"
import { formatLogEntry } from "@/features/settings/lib/logs"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

// text-xs's line height: every entry is one truncated line.
const ROW_HEIGHT = 16
// The panel's vertical p-3, kept in the virtualizer's coordinates so the window lines up with what is drawn.
const PANEL_PADDING = 12
const OVERSCAN = 20

const LEVEL_CLASS: Record<string, string> = {
	debug: "text-muted-foreground",
	info: "text-foreground",
	warn: "text-yellow-500",
	error: "text-destructive"
}

// Every realm's ring merged runs to a few thousand lines, drawn as a window over fixed-height rows. Its own file, as
// useVirtualizer opts it out of the React Compiler (the block stays compiled).
export function LogsList({ entries }: { entries: readonly LogEntry[] }) {
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const virtualizer = useVirtualizer({
		count: entries.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => ROW_HEIGHT,
		paddingStart: PANEL_PADDING,
		paddingEnd: PANEL_PADDING,
		overscan: OVERSCAN
	})

	return (
		<div
			ref={setScrollElement}
			className="max-h-72 overflow-y-auto rounded-2xl bg-muted/40 px-3 font-mono text-xs"
		>
			<div
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(row => {
					const entry = entries[row.index]

					if (entry === undefined) {
						return null
					}

					return (
						<p
							key={row.key}
							className={cn("absolute top-0 left-0 w-full truncate", LEVEL_CLASS[entry.level] ?? "text-foreground")}
							style={{ height: ROW_HEIGHT, transform: `translateY(${String(row.start)}px)` }}
						>
							{formatLogEntry(entry)}
						</p>
					)
				})}
			</div>
		</div>
	)
}
