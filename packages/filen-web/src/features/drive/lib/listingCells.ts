// The listing's row and tile layout as classes, one source for the item rows and tiles, the list's column
// header and the pending rows above the items, so a column never drifts out from under its header. The
// heights match gridLayout.ts's ROW_HEIGHT and TILE_ROW_HEIGHT.
export const LIST_ROW_CLASS = "flex h-10 items-center gap-3 px-3 text-sm"
export const LIST_NAME_CLASS = "min-w-0 flex-1 truncate"
// Size steps in at sm and Modified at lg. Modified waits for lg, not md: md is where the shell puts the
// sidebar back into the row, so the card is at its narrowest just above that breakpoint.
export const LIST_SIZE_COLUMN_CLASS = "hidden w-20 shrink-0 sm:block"
export const LIST_MODIFIED_COLUMN_CLASS = "hidden w-28 shrink-0 lg:block"
// The trailing slot the row's ⋯ trigger takes.
export const LIST_TRAILING_SLOT_CLASS = "size-6 shrink-0 pointer-coarse:size-8"

// Fixed width + justify-self-center: the tile stays at TILE_WIDTH whatever its grid column, so its face
// stays the square TILE_ROW_HEIGHT assumes.
export const TILE_CLASS = "relative flex w-44 shrink-0 flex-col gap-2 justify-self-center rounded-2xl p-2 text-center text-sm"
export const TILE_FACE_CLASS = "relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl bg-muted/40"
export const TILE_NAME_CLASS = "line-clamp-2 w-full text-xs break-words"
export const TILE_SUBLINE_CLASS = "w-full truncate text-[0.7rem]"
