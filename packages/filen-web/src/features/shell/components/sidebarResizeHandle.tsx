import { cn } from "@/lib/utils"
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
// `<aside>` instead of nested inside a percentage-split container. Desktop-only affordance: the `md:block`
// below is what keeps it out of the narrow-viewport drawer, where the panel fills the popup and there is
// no adjacent content column to resize against. Arrow/Home/End resize it from the keyboard.
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
				"hidden w-1 shrink-0 cursor-col-resize rounded-full bg-transparent transition-colors outline-none hover:bg-border focus-visible:bg-ring/50 md:block",
				className
			)}
		/>
	)
}
