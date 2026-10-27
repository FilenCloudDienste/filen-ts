import { cn } from "@filen/shared"

// A rail slot's state: the active section rides a white chip (soft shadow); inactive glyphs are plain muted
// marks on the canvas that tint on hover. No borders — the chip and hover fills carry the state entirely.
export function railItemStateClass(active: boolean): string {
	return active ? "bg-rail-chip text-rail-chip-foreground shadow-sm" : "text-muted-foreground hover:bg-rail-hover hover:text-foreground"
}

// The slot box without icon sizing, for an entry that sizes its own glyphs.
// app-region-no-drag: every rail item is a real click target inside the rail's own drag region.
export const RAIL_ITEM_BOX_CLASS =
	"flex size-9 items-center justify-center rounded-lg focus-ring transition-colors outline-none app-region-no-drag"

// Shared by every rail entry so they stay visually identical.
export function railItemClass(active: boolean): string {
	return cn(RAIL_ITEM_BOX_CLASS, "[&_svg]:size-[22px] [&_svg]:shrink-0", railItemStateClass(active))
}
