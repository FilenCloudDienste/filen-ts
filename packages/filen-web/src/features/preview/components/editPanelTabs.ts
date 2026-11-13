import { cn } from "@filen/shared"

// The image and video editors' tool panel tabs (their parts are editPanelParts.tsx).

// The ids a tab and its panel share.
export function editTabIds(base: string, tab: string): { tab: string; panel: string } {
	return { tab: `${base}-tab-${tab}`, panel: `${base}-panel-${tab}` }
}

// A tab button's classes (the tablist is a grid of these), 44 px high under a coarse pointer; `dense` for a row of six
// in the inspector.
export function editTabClass(selected: boolean, dense: boolean): string {
	return cn(
		"flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-full text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30 motion-reduce:transition-none sm:h-auto sm:flex-col sm:gap-0.5 sm:rounded-xl sm:py-1.5 pointer-coarse:h-11 [&_svg]:size-4 [&_svg]:shrink-0",
		dense ? "px-1 sm:text-[10px]" : "px-2 sm:text-[11px]",
		selected ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground"
	)
}
