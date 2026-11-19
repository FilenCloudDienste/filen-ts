// A coarse pointer cannot hover, so the reveal never fires there — show the trigger unconditionally and
// grow it (glyph included, or icon-xs would pin a 12px mark inside a 32px box). 32px is the ceiling: a
// drive row is ROW_HEIGHT tall.
const BASE_CLASS =
	"shrink-0 opacity-0 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:size-8 pointer-coarse:opacity-100 pointer-coarse:[&_svg:not([class*='size-'])]:size-4"

// Keyed by the hover group of the surrounding row or tile; a tile also pins the trigger to its corner.
export const REVEAL_CLASS = {
	row: `${BASE_CLASS} group-hover/row:opacity-100`,
	trow: `${BASE_CLASS} group-hover/trow:opacity-100`,
	tile: `${BASE_CLASS} absolute top-1 right-1 group-hover/tile:opacity-100`,
	plain: `${BASE_CLASS} group-hover:opacity-100`
} as const
