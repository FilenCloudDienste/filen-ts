import { parseXml } from "@filen/office/core/xml"
import { ZipArchive, ZipError, bytesSource } from "@filen/office/core/opc"
import { entryFits } from "@/features/preview/lib/zipBudget.logic"
import { GEO_MAX_BYTES, type GeoFileFormat } from "@/features/preview/lib/geo/formats.logic"
import {
	GEO_MAX_POINTS,
	GeoFormatError,
	fillSource,
	geoJsonSource,
	gpxSource,
	kmlSource,
	type GeoPoints,
	type GeoSource,
	type GeoWaypoint
} from "@/features/preview/lib/geo/extract.logic"
import { GeoStatsSink, pointStats, type GeoStats } from "@/features/preview/lib/geo/stats.logic"

// A geo file read in the geo worker: its source by format (a KMZ's first root .kml), counted, then filled into packed
// arrays, or, past GEO_MAX_POINTS, only summed.

export type { GeoFileFormat }

export interface GeoLoaded {
	readonly stats: GeoStats
	readonly waypoints: readonly GeoWaypoint[]
	readonly references: number
	// Null past GEO_MAX_POINTS: the file is described, not plotted.
	readonly points: GeoPoints | null
	readonly cumulative: Float64Array | null
}

// A KMZ whose KML unpacks past the geo cap, or past the zip ratio.
export class GeoTooLargeError extends Error {
	constructor() {
		super("the document unpacks past the geo cap")

		this.name = "GeoTooLarge"
	}
}

// A KMZ's document: the first .kml at its root, else the first anywhere, within the geo cap. No entry may declare more,
// so nothing inflates past it.
async function kmzDocument(bytes: Uint8Array): Promise<Uint8Array> {
	let archive: ZipArchive

	try {
		archive = await ZipArchive.open(bytesSource(bytes), { limits: { maxEntryUncompressed: GEO_MAX_BYTES } })
	} catch (error) {
		if (error instanceof ZipError && error.code === "tooLarge") throw new GeoTooLargeError()

		throw error
	}

	const kml = archive.entries.filter(entry => entry.name.toLowerCase().endsWith(".kml"))
	const entry = kml.find(candidate => !candidate.name.includes("/")) ?? kml[0]

	if (entry === undefined) throw new GeoFormatError("the KMZ holds no KML document")
	if (!entryFits({ compressed: entry.compressedSize, uncompressed: entry.uncompressedSize }, GEO_MAX_BYTES)) {
		throw new GeoTooLargeError()
	}

	return await archive.read(entry)
}

function xml(bytes: Uint8Array) {
	try {
		return parseXml(bytes)
	} catch (error) {
		throw new GeoFormatError(error instanceof Error ? error.message : "not XML")
	}
}

export async function geoSource(bytes: Uint8Array, format: GeoFileFormat): Promise<GeoSource> {
	switch (format) {
		case "gpx":
			return gpxSource(xml(bytes))
		case "kml":
			return kmlSource(xml(bytes))
		case "kmz":
			return kmlSource(xml(await kmzDocument(bytes)))
		case "geojson": {
			let value: unknown

			try {
				value = JSON.parse(new TextDecoder().decode(bytes))
			} catch {
				throw new GeoFormatError("not JSON")
			}

			return geoJsonSource(value)
		}
	}
}

export function loadSource(source: GeoSource): GeoLoaded {
	const count = source.count()

	if (count.points > GEO_MAX_POINTS) {
		const sink = new GeoStatsSink()

		source.emit(sink, null)

		return { stats: sink.stats(), waypoints: [], references: source.references, points: null, cumulative: null }
	}

	const { points, waypoints } = fillSource(source, count)
	const { stats, cumulative } = pointStats(points)

	for (const waypoint of waypoints) stats.include(waypoint.lon, waypoint.lat)

	return { stats: stats.stats(), waypoints, references: source.references, points, cumulative }
}

export async function loadGeo(bytes: Uint8Array, format: GeoFileFormat): Promise<GeoLoaded> {
	return loadSource(await geoSource(bytes, format))
}
