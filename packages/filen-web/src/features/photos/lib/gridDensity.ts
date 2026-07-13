import { type, type Type } from "arktype"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"

// Density is a TILE-SIZE target, not a literal column count (mobile's own 1-5 "columns per row" is
// phone geometry — a fixed viewport a fixed count carves evenly; a desktop window has no such fixed
// width, so the grid instead auto-fills as many DENSITY_STEPS[n]-sized columns as the container is
// wide, mirroring the drive grid's own responsive column math, see gridLayout.ts's TILE_WIDTH). Five
// steps, smallest-to-largest, spanning mobile's own dense-to-sparse range (~120px) up to a large single
// preview-ish tile (~320px). Index 1 (176px) is deliberately the exact TILE_WIDTH the drive grid itself
// ships, so the default density lands at the drive grid's own established "feel".
export const DENSITY_STEPS: readonly number[] = [120, 176, 220, 270, 320]
export const DEFAULT_DENSITY_INDEX = 1

export function clampDensityIndex(index: number): number {
	return Math.min(Math.max(Math.trunc(index), 0), DENSITY_STEPS.length - 1)
}

// Falls back to the default for an out-of-range value rather than throwing — a future build shrinking
// DENSITY_STEPS must not brick a persisted index from a build that had more steps.
export function tileSizeForDensity(index: number): number {
	const clamped = clampDensityIndex(index)
	const size = DENSITY_STEPS[clamped]

	return size ?? DENSITY_STEPS[DEFAULT_DENSITY_INDEX] ?? 176
}

// Responsive auto-fill column count for a given container width and tile size — CSS Grid's own
// `repeat(auto-fill, minmax(tile, 1fr))` semantics expressed as plain arithmetic so the virtualizer's
// row-count math (features/photos/components/photoGrid.tsx) can compute it without measuring the DOM
// grid itself. Never less than 1 (a container narrower than one tile still shows a single column).
export function columnsForWidth(containerWidth: number, tileSize: number): number {
	if (tileSize <= 0) {
		return 1
	}

	return Math.max(1, Math.floor(containerWidth / tileSize))
}

const GRID_DENSITY_KV_KEY = "photos.gridDensity.v1"

const densityIndexSchema: Type<number> = type("number.integer >= 0")

export async function getPhotosGridDensity(): Promise<number> {
	const stored = await kvGetJson(GRID_DENSITY_KV_KEY, densityIndexSchema)

	return stored === null ? DEFAULT_DENSITY_INDEX : clampDensityIndex(stored)
}

export async function setPhotosGridDensity(index: number): Promise<void> {
	await kvSetJson(GRID_DENSITY_KV_KEY, clampDensityIndex(index))
}
