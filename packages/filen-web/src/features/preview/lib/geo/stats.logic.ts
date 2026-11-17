import type { GeoPoints, PointSink } from "@/features/preview/lib/geo/extract.logic"

// A track's figures, summed point by point (so a file too large to plot still gets them from a streaming pass):
// haversine distance, elevation gain and loss past a 3 m hysteresis, total and moving time, top speed, bounds.

const EARTH_RADIUS_M = 6_371_008.8
// Elevation changes smaller than this are noise, not climbing.
export const GEO_ELEVATION_HYSTERESIS_M = 3
// Slower than this is standing still.
export const GEO_MOVING_SPEED_MS = 0.5
// Speeds over steps shorter than this are GPS jitter.
const MIN_SPEED_STEP_MS = 1000

export interface GeoBounds {
	readonly minLon: number
	readonly minLat: number
	readonly maxLon: number
	readonly maxLat: number
}

export interface GeoStats {
	readonly points: number
	readonly distance: number
	readonly gain: number
	readonly loss: number
	// Milliseconds; null without timestamps.
	readonly duration: number | null
	readonly moving: number | null
	// Metres per second; null without timestamps.
	readonly maxSpeed: number | null
	readonly minElevation: number | null
	readonly maxElevation: number | null
	readonly bounds: GeoBounds | null
}

function radians(degrees: number): number {
	return (degrees * Math.PI) / 180
}

export function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
	const dLat = radians(lat2 - lat1)
	const dLon = radians(lon2 - lon1)
	const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2

	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

// A PointSink that sums the stats; `cumulative`, when given, receives each point's distance from the start.
export class GeoStatsSink implements PointSink {
	private count = 0
	private distance = 0
	private gain = 0
	private loss = 0
	private moving = 0
	private maxSpeed = 0
	private firstTime = Number.POSITIVE_INFINITY
	private lastTime = Number.NEGATIVE_INFINITY
	private minEle = Number.POSITIVE_INFINITY
	private maxEle = Number.NEGATIVE_INFINITY
	private minLon = Number.POSITIVE_INFINITY
	private minLat = Number.POSITIVE_INFINITY
	private maxLon = Number.NEGATIVE_INFINITY
	private maxLat = Number.NEGATIVE_INFINITY
	private previous: { lon: number; lat: number; time: number } | null = null
	private reference = Number.NaN
	private timed = false
	private readonly cumulative: Float64Array | null

	constructor(cumulative: Float64Array | null = null) {
		this.cumulative = cumulative
	}

	segment(): void {
		this.previous = null
		this.reference = Number.NaN
	}

	point(lon: number, lat: number, ele: number, time: number): void {
		const previous = this.previous

		if (previous !== null) {
			const step = haversine(previous.lon, previous.lat, lon, lat)
			const elapsed = time - previous.time

			this.distance += step

			if (Number.isFinite(elapsed) && elapsed > 0) {
				const speed = step / (elapsed / 1000)

				if (speed > GEO_MOVING_SPEED_MS) this.moving += elapsed
				if (elapsed >= MIN_SPEED_STEP_MS) this.maxSpeed = Math.max(this.maxSpeed, speed)
			}
		}

		if (this.cumulative !== null && this.count < this.cumulative.length) this.cumulative[this.count] = this.distance

		if (Number.isFinite(ele)) {
			this.minEle = Math.min(this.minEle, ele)
			this.maxEle = Math.max(this.maxEle, ele)

			if (Number.isNaN(this.reference)) {
				this.reference = ele
			} else if (ele - this.reference >= GEO_ELEVATION_HYSTERESIS_M) {
				this.gain += ele - this.reference
				this.reference = ele
			} else if (this.reference - ele >= GEO_ELEVATION_HYSTERESIS_M) {
				this.loss += this.reference - ele
				this.reference = ele
			}
		}

		if (Number.isFinite(time)) {
			this.timed = true
			this.firstTime = Math.min(this.firstTime, time)
			this.lastTime = Math.max(this.lastTime, time)
		}

		this.minLon = Math.min(this.minLon, lon)
		this.minLat = Math.min(this.minLat, lat)
		this.maxLon = Math.max(this.maxLon, lon)
		this.maxLat = Math.max(this.maxLat, lat)
		this.previous = { lon, lat, time }
		this.count++
	}

	// Waypoints widen the bounds too.
	include(lon: number, lat: number): void {
		this.minLon = Math.min(this.minLon, lon)
		this.minLat = Math.min(this.minLat, lat)
		this.maxLon = Math.max(this.maxLon, lon)
		this.maxLat = Math.max(this.maxLat, lat)
	}

	stats(): GeoStats {
		const hasEle = this.minEle <= this.maxEle

		return {
			points: this.count,
			distance: this.distance,
			gain: this.gain,
			loss: this.loss,
			duration: this.timed ? this.lastTime - this.firstTime : null,
			moving: this.timed ? this.moving : null,
			maxSpeed: this.timed ? this.maxSpeed : null,
			minElevation: hasEle ? this.minEle : null,
			maxElevation: hasEle ? this.maxEle : null,
			bounds:
				this.minLon <= this.maxLon ? { minLon: this.minLon, minLat: this.minLat, maxLon: this.maxLon, maxLat: this.maxLat } : null
		}
	}
}

// The stats of packed points and each point's distance from the start.
export function pointStats(points: GeoPoints): { stats: GeoStatsSink; cumulative: Float64Array } {
	const cumulative = new Float64Array(points.lon.length)
	const sink = new GeoStatsSink(cumulative)

	for (let s = 0; s + 1 < points.segments.length; s++) {
		sink.segment()

		for (let i = points.segments[s] ?? 0; i < (points.segments[s + 1] ?? 0); i++) {
			sink.point(points.lon[i] ?? 0, points.lat[i] ?? 0, points.ele[i] ?? Number.NaN, points.time[i] ?? Number.NaN)
		}
	}

	return { stats: sink, cumulative }
}

// The point at `distance` along the track (binary search over the cumulative distances); -1 for none.
export function pointAtDistance(cumulative: Float64Array, distance: number): number {
	if (cumulative.length === 0) return -1

	let low = 0
	let high = cumulative.length - 1

	while (low < high) {
		const middle = (low + high) >>> 1

		if ((cumulative[middle] ?? 0) < distance) low = middle + 1
		else high = middle
	}

	// The nearer of the two points around it.
	if (low > 0 && distance - (cumulative[low - 1] ?? 0) < (cumulative[low] ?? 0) - distance) return low - 1

	return low
}

// The elevation profile drawn under the plot: at most `samples` (distance, elevation) pairs, evenly spaced along the
// track, from the points that have an elevation.
export function elevationProfile(
	points: GeoPoints,
	cumulative: Float64Array,
	samples: number
): { distance: Float64Array; elevation: Float64Array } {
	const total = cumulative.at(-1) ?? 0
	const distance = new Float64Array(samples)
	const elevation = new Float64Array(samples)
	let filled = 0

	if (total <= 0) return { distance: distance.subarray(0, 0), elevation: elevation.subarray(0, 0) }

	for (let k = 0; k < samples; k++) {
		const at = pointAtDistance(cumulative, (total * k) / Math.max(1, samples - 1))
		const ele = points.ele[at] ?? Number.NaN

		if (!Number.isFinite(ele)) continue

		distance[filled] = cumulative[at] ?? 0
		elevation[filled] = ele
		filled++
	}

	return { distance: distance.slice(0, filled), elevation: elevation.slice(0, filled) }
}
