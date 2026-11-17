// The plot's level-of-detail pyramid, built once at load: level k keeps, of every bucket of 4^k consecutive points of a
// line, its first and last points and the ones at its extremes (min and max x and y), so a zoomed-out frame draws about
// as many points as it has pixels while keeping every corner a pixel would show. Level 0 is every point.

export const LOD_LEVELS = 4
const BUCKET_BASE = 4

export interface LodLevel {
	// Kept point indices, ascending; a line's points stay contiguous.
	readonly indices: Uint32Array
	// Each line's first position in `indices`, then indices.length.
	readonly segments: Uint32Array
}

export function bucketSize(level: number): number {
	return BUCKET_BASE ** level
}

// Levels 1..LOD_LEVELS over projected x/y and the line starts (a GeoPoints' `segments`).
export function buildLod(x: Float64Array, y: Float64Array, segments: Uint32Array): LodLevel[] {
	const levels: LodLevel[] = []
	// A bucket's six kept candidates, sorted in place (a typed array sorts numerically).
	const scratch = new Uint32Array(6)

	for (let level = 1; level <= LOD_LEVELS; level++) {
		const size = bucketSize(level)
		const kept: number[] = []
		const starts: number[] = []

		for (let s = 0; s + 1 < segments.length; s++) {
			const first = segments[s] ?? 0
			const end = segments[s + 1] ?? 0

			starts.push(kept.length)

			for (let start = first; start < end; start += size) {
				const stop = Math.min(end, start + size)
				let minX = start
				let maxX = start
				let minY = start
				let maxY = start

				for (let i = start + 1; i < stop; i++) {
					if ((x[i] ?? 0) < (x[minX] ?? 0)) minX = i
					if ((x[i] ?? 0) > (x[maxX] ?? 0)) maxX = i
					if ((y[i] ?? 0) < (y[minY] ?? 0)) minY = i
					if ((y[i] ?? 0) > (y[maxY] ?? 0)) maxY = i
				}

				scratch[0] = start
				scratch[1] = minX
				scratch[2] = maxX
				scratch[3] = minY
				scratch[4] = maxY
				scratch[5] = stop - 1
				scratch.sort()

				for (let k = 0; k < scratch.length; k++) {
					if (k === 0 || scratch[k] !== scratch[k - 1]) kept.push(scratch[k] ?? 0)
				}
			}
		}

		starts.push(kept.length)
		levels.push({ indices: Uint32Array.from(kept), segments: Uint32Array.from(starts) })
	}

	return levels
}

// The level to draw: the coarsest whose buckets still span at most `maxPixels` on screen, given the average distance
// between consecutive points in canvas pixels. 0 (every point) when points are already far apart.
export function lodLevel(pointSpacingPixels: number, maxPixels = 2): number {
	let level = 0

	for (let candidate = 1; candidate <= LOD_LEVELS; candidate++) {
		if (bucketSize(candidate) * pointSpacingPixels <= maxPixels) level = candidate
	}

	return level
}
