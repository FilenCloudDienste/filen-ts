import { cn } from "@filen/shared"

// The contextual sidebars' flat nav row. TanStack stamps `data-status="active"` on the matching Link.
// app-region-no-drag: every row is a real click target inside the panel's drag region.
export const SIDEBAR_NAV_ITEM_CLASS = cn(
	"group flex h-8 w-full items-center gap-2.5 rounded-xl px-2.5 text-sm focus-ring transition-colors outline-none app-region-no-drag [&_svg]:size-4 [&_svg]:shrink-0",
	"text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
	"data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium data-[status=active]:text-sidebar-accent-foreground"
)
