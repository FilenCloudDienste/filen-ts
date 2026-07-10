import { type DriveViewMode } from "@/features/drive/lib/preferences"

// The listing's row/tile geometry, shared between useDriveVirtualizer (react-virtual's estimateSize)
// and the thumbnail bounded cache's capacity math (thumbnailUrlCache.ts) — one source so the two can
// never drift apart. TILE_WIDTH is DriveTile's own fixed w-44 pin (justify-self-center rather than
// stretching), and TILE_ROW_HEIGHT is derived from the square face + label lines built on top of it.
export const ROW_HEIGHT = 40
export const TILE_WIDTH = 176
export const TILE_ROW_HEIGHT = 244

// How many item slots can be simultaneously on screen for a viewport of this size, before any
// headroom multiplier — a list row is one slot per ROW_HEIGHT of vertical space, a grid tile is one
// slot per TILE_WIDTH-by-TILE_ROW_HEIGHT cell. The "+1" on each axis accounts for a partially-visible
// row/tile row at the viewport's trailing edge, mirroring how a virtualizer always mounts one more
// item than strictly fits.
export function estimateVisibleSlots(viewportWidth: number, viewportHeight: number, viewMode: DriveViewMode): number {
	if (viewMode === "list") {
		return Math.max(0, Math.ceil(viewportHeight / ROW_HEIGHT)) + 1
	}

	const columns = Math.max(1, Math.floor(viewportWidth / TILE_WIDTH))
	const rows = Math.max(0, Math.ceil(viewportHeight / TILE_ROW_HEIGHT)) + 1

	return columns * rows
}
