import { type, type Type } from "arktype"
import { kvPreference } from "@/lib/storage/preference"

// Density is a TILE-SIZE target, not a literal column count (mobile's own 1-5 "columns per row" is
// phone geometry — a fixed viewport a fixed count carves evenly; a desktop window has no such fixed
// width, so the grid instead auto-fills as many DENSITY_STEPS[n]-sized columns as the container is
// wide, sharing the drive grid's responsive column math, gridLayout.ts's columnsForWidth). Five
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

const densityIndexSchema: Type<number> = type("number.integer >= 0")

export const { get: getPhotosGridDensity, set: setPhotosGridDensity } = kvPreference({
	key: "photos.gridDensity.v1",
	schema: densityIndexSchema,
	fallback: DEFAULT_DENSITY_INDEX,
	normalize: clampDensityIndex
})
