// The geo viewer's formats by extension, and its size cap: the one list the category table and the viewer read.

export const GEO_FORMATS = ["gpx", "kml", "kmz", "geojson"] as const

export type GeoFileFormat = (typeof GEO_FORMATS)[number]

// A geo file, or a KMZ's KML once unpacked, is read up to this size (the text cap, so View source reuses the bytes).
export const GEO_MAX_BYTES = 33_554_432

export function geoFileFormat(extension: string): GeoFileFormat | null {
	return (GEO_FORMATS as readonly string[]).includes(extension) ? (extension as GeoFileFormat) : null
}
