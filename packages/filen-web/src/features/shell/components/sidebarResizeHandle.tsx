import type { PointerEvent as ReactPointerEvent } from "react"
import { cn } from "@/lib/utils"

interface SidebarResizeHandleProps {
	ariaLabel: string
	onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
	onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
	onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
	// Mirrors the sidebar's own "hidden … md:flex" visibility — a lone divider must never render
	// while the aside beside it is display:none below the md breakpoint.
	className?: string
}

// Trailing-edge drag handle shared by every resizable contextual sidebar — same idiom as the notes
// markdown split-pane's own divider (markdownSplitPane.tsx), just rendered as a sibling of the
// `<aside>` instead of nested inside a percentage-split container.
export function SidebarResizeHandle({ ariaLabel, onPointerDown, onPointerMove, onPointerUp, className }: SidebarResizeHandleProps) {
	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={ariaLabel}
			tabIndex={0}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			className={cn(
				"hidden w-1 shrink-0 cursor-col-resize rounded-full bg-transparent transition-colors outline-none hover:bg-border focus-visible:bg-ring/50 md:block",
				className
			)}
		/>
	)
}
