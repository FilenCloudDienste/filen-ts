import { NodeKind, type XmlDocument } from "@filen/office/core/xml"
import { type } from "arktype"

// GPX, KML and GeoJSON read into packed arrays: one pass that only counts (no allocation), then one that fills
// pre-sized typed arrays. Elements are matched by local name (GPX and KML are default-namespace; extensions are not
// read). Network references (KML hrefs, network links, overlays) are counted, never fetched.

// Above this many points the file is described (stats from a streaming pass) but not plotted.
export const GEO_MAX_POINTS = 5_000_000
export const GEO_MAX_WAYPOINTS = 10_000
// GeoJSON nesting a reader follows (GeometryCollection in GeometryCollection...).
const GEO_MAX_DEPTH = 32

// Where extracted points go: counted, filled into arrays, or summed into stats. `segment` starts a new line.
export interface PointSink {
	segment(): void
	point(lon: number, lat: number, ele: number, time: number): void
}

// Only placed, never labelled: names and descriptions are not read.
export interface GeoWaypoint {
	readonly lon: number
	readonly lat: number
}

export interface WaypointSink {
	waypoint(waypoint: GeoWaypoint): void
	// Counted, not read: the waypoints only a count pass sees.
	count(): void
}

export type GeoFormat = "gpx" | "kml" | "geojson"

// Points on lines (GPX track and route points, KML line and track coordinates, GeoJSON line and polygon positions) and
// waypoints (GPX wpt, KML Point placemarks, GeoJSON points), and the network references a KML names.
export interface GeoCount {
	readonly points: number
	readonly waypoints: number
	// Lines at most (an empty one is dropped when filling).
	readonly segments: number
}

export interface GeoSource {
	readonly format: GeoFormat
	emit(points: PointSink, waypoints: WaypointSink | null): void
	// What emit would produce, counted without decoding a coordinate or allocating.
	count(): GeoCount
	readonly references: number
}

function localNames(doc: XmlDocument): string[] {
	return doc.names.map(name => {
		const colon = name.indexOf(":")

		return colon === -1 ? name : name.slice(colon + 1)
	})
}

function childText(doc: XmlDocument, node: number, local: readonly string[], name: string): string | undefined {
	for (let child = doc.firstChild(node); child >= 0; child = doc.nextSibling(child)) {
		if (doc.kind(child) === NodeKind.Element && local[doc.nameId(child)] === name) return doc.textContent(child).trim()
	}

	return undefined
}

function number(text: string | undefined): number {
	if (text === undefined || text === "") return Number.NaN

	return Number(text)
}

function time(text: string | undefined): number {
	return text === undefined ? Number.NaN : Date.parse(text)
}

function validLonLat(lon: number, lat: number): boolean {
	return Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90
}

// A GPX document: tracks (one line per trkseg), routes (one per rte) and waypoints.
export function gpxSource(doc: XmlDocument): GeoSource {
	const local = localNames(doc)

	const ids = (name: string): number => local.indexOf(name)
	const counted = (): GeoCount => {
		const want = { trkseg: ids("trkseg"), rte: ids("rte"), trkpt: ids("trkpt"), rtept: ids("rtept"), wpt: ids("wpt") }
		let points = 0
		let waypoints = 0
		let segments = 0

		for (let node = 1; node < doc.count; node++) {
			const id = doc.nameIds[node] ?? -1

			if (id < 0 || doc.kinds[node] !== NodeKind.Element) continue
			if (id === want.trkpt || id === want.rtept) points++
			else if (id === want.wpt) waypoints++
			else if (id === want.trkseg || id === want.rte) segments++
		}

		return { points, waypoints, segments }
	}

	return {
		format: "gpx",
		references: 0,
		count: counted,
		emit: (points, waypoints) => {
			for (let node = 1; node < doc.count; node++) {
				if (doc.kind(node) !== NodeKind.Element) continue

				switch (local[doc.nameId(node)]) {
					case "trkseg":
					case "rte":
						points.segment()

						break
					case "trkpt":
					case "rtept": {
						const lon = number(doc.attribute(node, "lon"))
						const lat = number(doc.attribute(node, "lat"))

						if (validLonLat(lon, lat))
							points.point(lon, lat, number(childText(doc, node, local, "ele")), time(childText(doc, node, local, "time")))

						break
					}
					case "wpt": {
						if (waypoints === null) break

						const lon = number(doc.attribute(node, "lon"))
						const lat = number(doc.attribute(node, "lat"))

						if (validLonLat(lon, lat)) waypoints.waypoint({ lon, lat })

						break
					}
				}
			}
		}
	}
}

function isSpaceByte(byte: number): boolean {
	return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

// Each whitespace-separated "lon,lat[,alt]" tuple of a KML <coordinates>; whitespace around a comma (written by some
// exporters) does not split a tuple.
function eachTuple(doc: XmlDocument, node: number, visit: (lon: number, lat: number, ele: number) => void): void {
	for (const tuple of doc
		.textContent(node)
		.replace(/\s*,\s*/g, ",")
		.split(/\s+/)) {
		if (tuple === "") continue

		const parts = tuple.split(",")

		visit(number(parts[0]), number(parts[1]), number(parts[2]))
	}
}

// At least as many as the tuples of a <coordinates>, counted over its raw bytes without decoding them: every run of
// non-space bytes, and every character reference (which may decode to a space and split a run). Comments and CDATA
// markers only add to it; the fill pass keeps what it really finds.
function countTuples(doc: XmlDocument, node: number): number {
	const bytes = doc.bytes
	const end = doc.contentEnd(node)
	let count = 0
	let inToken = false

	for (let at = doc.contentStart(node); at < end; at++) {
		const byte = bytes[at] ?? 0
		const space = isSpaceByte(byte)

		if ((!space && !inToken) || byte === 0x26) count++

		inToken = !space
	}

	return count
}

function ancestorName(doc: XmlDocument, node: number, local: readonly string[]): string | undefined {
	const parent = doc.parent(node)

	return parent <= 0 ? undefined : local[doc.nameId(parent)]
}

// A KML document: LineString and LinearRing coordinates (a line each), gx:Track (coord and when in order), Point
// placemarks as waypoints. hrefs (network links, overlays, icons) are counted.
export function kmlSource(doc: XmlDocument): GeoSource {
	const local = localNames(doc)
	let references = 0

	for (let node = 1; node < doc.count; node++) {
		if (doc.kind(node) === NodeKind.Element && local[doc.nameId(node)] === "href") references++
	}

	return {
		format: "kml",
		references,
		count: () => countKml(doc),
		emit: (points, waypoints) => {
			for (let node = 1; node < doc.count; node++) {
				if (doc.kind(node) !== NodeKind.Element) continue

				const name = local[doc.nameId(node)]

				if (name === "coordinates") {
					const owner = ancestorName(doc, node, local)

					if (owner === "Point") {
						if (waypoints === null) continue

						eachTuple(doc, node, (lon, lat) => {
							if (validLonLat(lon, lat)) waypoints.waypoint({ lon, lat })
						})
					} else if (owner === "LineString" || owner === "LinearRing") {
						points.segment()
						eachTuple(doc, node, (lon, lat, ele) => {
							if (validLonLat(lon, lat)) points.point(lon, lat, ele, Number.NaN)
						})
					}
				} else if (name === "Track") {
					points.segment()

					const times: number[] = []

					for (let child = doc.firstChild(node); child >= 0; child = doc.nextSibling(child)) {
						if (doc.kind(child) === NodeKind.Element && local[doc.nameId(child)] === "when")
							times.push(time(doc.textContent(child).trim()))
					}

					let index = 0

					for (let child = doc.firstChild(node); child >= 0; child = doc.nextSibling(child)) {
						if (doc.kind(child) !== NodeKind.Element || local[doc.nameId(child)] !== "coord") continue

						const [lon, lat, ele] = doc.textContent(child).trim().split(/\s+/).map(Number)

						if (lon !== undefined && lat !== undefined && validLonLat(lon, lat)) {
							points.point(lon, lat, ele ?? Number.NaN, times[index] ?? Number.NaN)
						}

						index++
					}
				}
			}
		}
	}
}

// The KML count pass without decoding any coordinate: what kmlSource would emit, counted.
function countKml(doc: XmlDocument): GeoCount {
	const local = localNames(doc)
	let points = 0
	let waypoints = 0
	let segments = 0

	for (let node = 1; node < doc.count; node++) {
		if (doc.kind(node) !== NodeKind.Element) continue

		const name = local[doc.nameId(node)]

		if (name === "coordinates") {
			const owner = ancestorName(doc, node, local)
			const count = countTuples(doc, node)

			if (owner === "Point") waypoints += count
			else if (owner === "LineString" || owner === "LinearRing") {
				points += count
				segments++
			}
		} else if (name === "coord" && ancestorName(doc, node, local) === "Track") {
			points++
		} else if (name === "Track") {
			segments++
		}
	}

	return { points, waypoints, segments }
}

// The envelope arktype checks; positions are checked number by number as they are read.
const geometry = type({ type: "string", "coordinates?": "unknown", "geometries?": "unknown[]" })
const feature = type({ type: "'Feature'", geometry: geometry.or("null") })
const envelope = type({ type: "string", "features?": feature.array(), "geometry?": geometry.or("null") })

export class GeoFormatError extends Error {
	constructor(message: string) {
		super(message)

		this.name = "GeoFormatError"
	}
}

function position(value: unknown): [number, number, number] | null {
	if (!Array.isArray(value) || value.length < 2) return null

	const [lon, lat, ele] = value as unknown[]

	if (typeof lon !== "number" || typeof lat !== "number" || !validLonLat(lon, lat)) return null

	return [lon, lat, typeof ele === "number" ? ele : Number.NaN]
}

function line(value: unknown, points: PointSink): void {
	if (!Array.isArray(value)) return

	points.segment()

	for (const entry of value) {
		const at = position(entry)

		if (at !== null) points.point(at[0], at[1], at[2], Number.NaN)
	}
}

function emitGeometry(value: unknown, points: PointSink, waypoints: WaypointSink | null, depth: number): void {
	if (depth > GEO_MAX_DEPTH || typeof value !== "object" || value === null) return

	const { type: kind, coordinates, geometries } = value as { type?: unknown; coordinates?: unknown; geometries?: unknown }
	const list = Array.isArray(coordinates) ? (coordinates as unknown[]) : []

	switch (kind) {
		case "Point": {
			const at = position(coordinates)

			if (at !== null) waypoints?.waypoint({ lon: at[0], lat: at[1] })

			break
		}
		case "MultiPoint":
			for (const entry of list) {
				const at = position(entry)

				if (at !== null) waypoints?.waypoint({ lon: at[0], lat: at[1] })
			}

			break
		case "LineString":
			line(coordinates, points)

			break
		case "MultiLineString":
		case "Polygon":
			for (const ring of list) line(ring, points)

			break
		case "MultiPolygon":
			for (const polygon of list) {
				if (Array.isArray(polygon)) for (const ring of polygon as unknown[]) line(ring, points)
			}

			break
		case "GeometryCollection":
			if (Array.isArray(geometries)) for (const child of geometries as unknown[]) emitGeometry(child, points, waypoints, depth + 1)

			break
	}
}

// A parsed GeoJSON value: a FeatureCollection, a Feature or a bare geometry. Throws GeoFormatError for anything else.
export function geoJsonSource(value: unknown): GeoSource {
	const checked = envelope(value)

	if (checked instanceof type.errors) throw new GeoFormatError(checked.summary)

	const features =
		checked.type === "FeatureCollection"
			? (checked.features ?? [])
			: checked.type === "Feature"
				? [{ type: "Feature" as const, geometry: checked.geometry ?? null }]
				: [{ type: "Feature" as const, geometry: value }]

	const emit = (points: PointSink, waypoints: WaypointSink | null): void => {
		for (const entry of features) emitGeometry(entry.geometry, points, waypoints, 0)
	}

	return {
		format: "geojson",
		references: 0,
		// The values are already parsed: counting walks them, allocating nothing.
		count: () => countEmitted(emit),
		emit
	}
}

// Counts what `emit` produces.
function countEmitted(emit: GeoSource["emit"]): GeoCount {
	let points = 0
	let waypoints = 0
	let segments = 0

	emit(
		{
			segment: () => {
				segments++
			},
			point: () => {
				points++
			}
		},
		{
			waypoint: () => {
				waypoints++
			},
			count: () => {
				waypoints++
			}
		}
	)

	return { points, waypoints, segments }
}

// The packed points: one entry per point; `segments` holds each line's first index, then the point count.
export interface GeoPoints {
	readonly lon: Float64Array
	readonly lat: Float64Array
	// NaN where unknown.
	readonly ele: Float64Array
	// Milliseconds since the epoch; NaN where unknown.
	readonly time: Float64Array
	readonly segments: Uint32Array
}

// Fills arrays sized by a count pass, which may count more than the points that turn out valid: the arrays returned are
// views of the points filled. Empty lines are dropped; points before any line starts (a GPX trkpt outside a trkseg)
// open a line of their own.
export function fillSource(
	source: GeoSource,
	{ points: count, segments: segmentCount }: GeoCount
): { points: GeoPoints; waypoints: GeoWaypoint[] } {
	const lon = new Float64Array(count)
	const lat = new Float64Array(count)
	const ele = new Float64Array(count)
	const times = new Float64Array(count)
	// Each counted line, the one points before any line may open, and the end.
	const starts = new Uint32Array(segmentCount + 2)
	const waypoints: GeoWaypoint[] = []
	let at = 0
	let segments = 0
	let open = false

	source.emit(
		{
			segment: () => {
				open = false
			},
			point: (x, y, z, t) => {
				if (at >= count) return

				if (!open) {
					if (segments > segmentCount) return

					// A new line: the previous one, if empty, is overwritten.
					if (segments === 0 || (starts[segments - 1] ?? 0) !== at) segments++

					starts[segments - 1] = at
					open = true
				}

				lon[at] = x
				lat[at] = y
				ele[at] = z
				times[at] = t
				at++
			}
		},
		{
			waypoint: waypoint => {
				if (waypoints.length < GEO_MAX_WAYPOINTS) waypoints.push(waypoint)
			},
			count: () => undefined
		}
	)

	starts[segments] = at

	return {
		points: {
			lon: lon.subarray(0, at),
			lat: lat.subarray(0, at),
			ele: ele.subarray(0, at),
			time: times.subarray(0, at),
			segments: starts.slice(0, segments + 1)
		},
		waypoints
	}
}
