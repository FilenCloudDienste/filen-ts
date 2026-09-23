import { cn } from "@filen/shared"
import { type ResizableSidebarHandle } from "@/features/shell/hooks/useResizableSidebar"
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "@/features/shell/lib/sidebarWidth"

interface SidebarResizeHandleProps {
	ariaLabel: string
	// The whole handle rather than its individual callbacks: the hook owns the width, so every new
	// interaction it grows lands here without touching the three sidebars that render this.
	handle: ResizableSidebarHandle
	className?: string
}

// Trailing-edge drag handle shared by every resizable contextual sidebar — same idiom as the notes
// markdown split-pane's own divider (markdownSplitPane.tsx), just rendered as a sibling of the
// `<aside>` instead of nested inside a percentage-split container. Absolutely positioned against the
// shell's sidebar wrapper (appShell.tsx) so it fills the row's gap-2 between panel and content instead
// of adding its own width to it: `w-2` IS that gap, and the visible line is centered in it. Desktop-only
// affordance: the `md:block` below is what keeps it out of the narrow-viewport drawer, where the panel
// fills the popup and there is no adjacent content column to resize against. Arrow/Home/End resize it
// from the keyboard.
export function SidebarResizeHandle({ ariaLabel, handle, className }: SidebarResizeHandleProps) {
	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={ariaLabel}
			aria-valuenow={handle.width}
			aria-valuemin={SIDEBAR_WIDTH_MIN}
			aria-valuemax={SIDEBAR_WIDTH_MAX}
			tabIndex={0}
			onPointerDown={handle.onPointerDown}
			onPointerMove={handle.onPointerMove}
			onPointerUp={handle.onPointerUp}
			onKeyDown={handle.onKeyDown}
			onKeyUp={handle.onKeyUp}
			onBlur={handle.onBlur}
			className={cn(
				"absolute inset-y-0 left-full hidden w-2 cursor-col-resize outline-none md:block",
				"after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 after:rounded-full after:transition-colors hover:after:bg-border focus-visible:after:bg-ring/50",
				className
			)}
		/>
	)
}
