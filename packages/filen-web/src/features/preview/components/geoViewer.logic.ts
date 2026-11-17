import type { GeoFileFormat } from "@/features/preview/lib/geo/load"

// The track viewer's pure parts: the file's format by its type extension, and how figures read.

export function geoFormat(extension: string): GeoFileFormat | null {
	switch (extension) {
		case "gpx":
		case "kml":
		case "kmz":
		case "geojson":
			return extension
		default:
			return null
	}
}

const ONE_DECIMAL = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 })
const WHOLE = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

// A distance: kilometres with one decimal from 1 km, whole metres below.
export function distanceParts(metres: number): { unit: "km" | "m"; value: string } {
	return metres >= 1000 ? { unit: "km", value: ONE_DECIMAL.format(metres / 1000) } : { unit: "m", value: WHOLE.format(metres) }
}

export function wholeMetres(metres: number): string {
	return WHOLE.format(metres)
}

export function kilometresPerHour(metresPerSecond: number): string {
	return ONE_DECIMAL.format(metresPerSecond * 3.6)
}

// "2:11:04", or "11:04" under an hour.
export function duration(milliseconds: number): string {
	const total = Math.max(0, Math.round(milliseconds / 1000))
	const hours = Math.floor(total / 3600)
	const minutes = Math.floor((total % 3600) / 60)
	const seconds = total % 60
	const pad = (value: number): string => String(value).padStart(2, "0")

	return hours > 0 ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}` : `${String(minutes)}:${pad(seconds)}`
}

// The profile's path in a `width` × `height` box: elevation scaled to the box, distance along it.
export function profilePath(distance: Float64Array, elevation: Float64Array, width: number, height: number): string {
	if (distance.length < 2) return ""

	let low = Number.POSITIVE_INFINITY
	let high = Number.NEGATIVE_INFINITY

	for (const value of elevation) {
		low = Math.min(low, value)
		high = Math.max(high, value)
	}

	const span = Math.max(1, high - low)
	const total = Math.max(1, distance.at(-1) ?? 1)
	const parts: string[] = []

	for (let i = 0; i < distance.length; i++) {
		const x = ((distance[i] ?? 0) / total) * width
		const y = height - (((elevation[i] ?? low) - low) / span) * height

		parts.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
	}

	return parts.join(" ")
}

// The profile sample nearest `distance` (binary search); -1 when there is none.
export function nearestSample(distance: Float64Array, at: number): number {
	if (distance.length === 0) return -1

	let low = 0
	let high = distance.length - 1

	while (low < high) {
		const middle = (low + high) >>> 1

		if ((distance[middle] ?? 0) < at) low = middle + 1
		else high = middle
	}

	return low > 0 && at - (distance[low - 1] ?? 0) < (distance[low] ?? 0) - at ? low - 1 : low
}
