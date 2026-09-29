import { type DriveViewMode } from "@/features/drive/lib/preferences"

// The listing's row/tile geometry, shared between useDriveVirtualizer (react-virtual's estimateSize)
// and the thumbnail bounded cache's capacity math (thumbnailUrlCache.ts) — one source so the two can
// never drift apart. TILE_WIDTH is DriveTile's own fixed w-44 pin (justify-self-center rather than
// stretching), and TILE_ROW_HEIGHT is derived from the square face + label lines built on top of it.
export const ROW_HEIGHT = 40
export const TILE_WIDTH = 176
export const TILE_ROW_HEIGHT = 244
// Grid view's padding on the listbox, keeping the full-bleed listing's tiles off the pane edges.
export const GRID_INSET = 12

// Responsive auto-fill column count for a given container width and tile size — CSS Grid's own
// `repeat(auto-fill, minmax(tile, 1fr))` semantics expressed as plain arithmetic so the virtualizer's
// row-count math (photos' photoGrid and the drive grid) can compute it without measuring the DOM
// grid itself. Never less than 1 (a container narrower than one tile still shows a single column).
// `gap` is the grid's own inter-column gap: n columns occupy n*tile + (n-1)*gap, so ignoring it
// over-counts at exact-fit widths and leaves each 1fr cell narrower than the fixed-width tile inside
// it. Defaulted to 0, which reduces the expression exactly to the gapless form.
export function columnsForWidth(containerWidth: number, tileSize: number, gap = 0): number {
	if (tileSize <= 0) {
		return 1
	}

	return Math.max(1, Math.floor((containerWidth + gap) / (tileSize + gap)))
}

// How many item slots can be simultaneously on screen for a viewport of this size, before any
// headroom multiplier — a list row is one slot per ROW_HEIGHT of vertical space, a grid tile is one
// slot per TILE_WIDTH-by-TILE_ROW_HEIGHT cell. The "+1" on each axis accounts for a partially-visible
// row/tile row at the viewport's trailing edge, mirroring how a virtualizer always mounts one more
// item than strictly fits.
export function estimateVisibleSlots(viewportWidth: number, viewportHeight: number, viewMode: DriveViewMode): number {
	if (viewMode === "list") {
		return Math.max(0, Math.ceil(viewportHeight / ROW_HEIGHT)) + 1
	}

	const columns = columnsForWidth(viewportWidth, TILE_WIDTH)
	const rows = Math.max(0, Math.ceil(viewportHeight / TILE_ROW_HEIGHT)) + 1

	return columns * rows
}
