import { describe, expect, it, vi } from "vitest"
import { zipSync } from "fflate"
import { eachCoordinateTuple, GEO_MAX_POINTS, type GeoSource } from "@/features/preview/lib/geo/extract.logic"
import { GeoTooLargeError, geoSource, loadGeo, loadSource } from "@/features/preview/lib/geo/load"
import { pointAtDistance } from "@/features/preview/lib/geo/stats.logic"

// GPX, KML, KMZ and GeoJSON read into packed arrays: counted first, filled to size, and above the point cap only summed.

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

const tuplesOf = (text: string): number[][] => {
	const tuples: number[][] = []

	eachCoordinateTuple(text, (lon, lat, ele) => tuples.push([lon, lat, ele]))

	return tuples
}

// The regular-expression split the scanner replaced, kept as the reference for its semantics.
const referenceTuplesOf = (text: string): number[][] =>
	text
		.replace(/\s*,\s*/g, ",")
		.split(/\s+/)
		.filter(tuple => tuple !== "")
		.map(tuple => {
			const parts = tuple.split(",")

			return [0, 1, 2].map(index => {
				const part = parts[index]

				return part === undefined || part === "" ? Number.NaN : Number(part)
			})
		})

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
	<wpt lat="47.0" lon="8.0"><name>Hut</name><desc>Water here</desc></wpt>
	<trk><name>Ride</name>
		<trkseg>
			<trkpt lat="47.0000" lon="8.0000"><ele>500</ele><time>2024-05-01T08:00:00Z</time>
				<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
			<trkpt lat="47.0010" lon="8.0000"><ele>501</ele><time>2024-05-01T08:00:20Z</time></trkpt>
			<trkpt lat="47.0020" lon="8.0000"><ele>510</ele><time>2024-05-01T08:00:40Z</time></trkpt>
		</trkseg>
		<trkseg></trkseg>
		<trkseg><trkpt lat="47.0030" lon="8.0000"><ele>505</ele><time>2024-05-01T08:10:40Z</time></trkpt></trkseg>
	</trk>
</gpx>`

const KML = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>
	<Placemark><name>Summit</name><Point><coordinates>8.5,47.5,1200</coordinates></Point></Placemark>
	<Placemark><LineString><coordinates>8.0,47.0,0 8.1,47.1,0
		8.2,47.2,0</coordinates></LineString></Placemark>
	<Placemark><gx:Track><when>2024-01-01T00:00:00Z</when><when>2024-01-01T00:01:00Z</when>
		<gx:coord>8.3 47.3 10</gx:coord><gx:coord>8.31 47.31 12</gx:coord></gx:Track></Placemark>
	<NetworkLink><Link><href>https://example.com/more.kml</href></Link></NetworkLink>
	<GroundOverlay><Icon><href>https://example.com/overlay.png</href></Icon></GroundOverlay>
</Document></kml>`

describe("geo extraction", () => {
	it("reads a GPX's track segments (dropping empty ones), times, elevations and waypoints, ignoring extensions", async () => {
		const loaded = await loadGeo(encode(GPX), "gpx")

		expect(loaded.points?.lon).toHaveLength(4)
		expect([...(loaded.points?.segments ?? [])]).toEqual([0, 3, 4])
		expect(loaded.points?.ele[2]).toBe(510)
		expect(loaded.points?.time[1]).toBe(Date.parse("2024-05-01T08:00:20Z"))
		expect(loaded.waypoints).toEqual([{ lon: 8, lat: 47 }])
		expect(loaded.stats.points).toBe(4)
	})

	it("reads KML lines, gx:Track coordinates with their times and Point placemarks, and counts the hrefs it never fetches", async () => {
		const fetch = vi.spyOn(globalThis, "fetch")
		const loaded = await loadGeo(encode(KML), "kml")

		expect([...(loaded.points?.segments ?? [])]).toEqual([0, 3, 5])
		expect(loaded.points?.time[4]).toBe(Date.parse("2024-01-01T00:01:00Z"))
		expect(loaded.waypoints).toEqual([{ lon: 8.5, lat: 47.5 }])
		expect(loaded.references).toBe(2)
		expect(fetch).not.toHaveBeenCalled()
		fetch.mockRestore()
	})

	it("counts KML without decoding a coordinate, the same as it fills", async () => {
		const source = await geoSource(encode(KML), "kml")

		expect(source.count()).toEqual({ points: 5, waypoints: 1, segments: 2 })
	})

	it("reads a KMZ's root KML", async () => {
		const kmz = zipSync({ "files/ignored.kml": encode("<kml/>"), "doc.kml": encode(KML) })
		const loaded = await loadGeo(kmz, "kmz")

		expect(loaded.points?.lon).toHaveLength(5)
	})

	it("reads GeoJSON features, collections and polygons, skipping bad positions, and refuses a bad envelope", async () => {
		const value = {
			type: "FeatureCollection",
			features: [
				{ type: "Feature", properties: { name: "Gate" }, geometry: { type: "Point", coordinates: [8, 47] } },
				{
					type: "Feature",
					properties: {},
					geometry: {
						type: "LineString",
						coordinates: [
							[8, 47, 400],
							[8.1, 47.1],
							["x", 1],
							[999, 1]
						]
					}
				},
				{
					type: "Feature",
					properties: null,
					geometry: {
						type: "GeometryCollection",
						geometries: [
							{
								type: "Polygon",
								coordinates: [
									[
										[0, 0],
										[1, 0],
										[1, 1]
									]
								]
							}
						]
					}
				},
				{ type: "Feature", properties: {}, geometry: null }
			]
		}
		const loaded = await loadGeo(encode(JSON.stringify(value)), "geojson")

		expect([...(loaded.points?.segments ?? [])]).toEqual([0, 2, 5])
		expect(loaded.points?.ele[0]).toBe(400)
		expect(loaded.waypoints).toEqual([{ lon: 8, lat: 47 }])
		await expect(
			loadGeo(encode(JSON.stringify({ type: "FeatureCollection", features: [{ type: "Nope" }] })), "geojson")
		).rejects.toThrow()
		await expect(loadGeo(encode("{"), "geojson")).rejects.toThrow()
	})

	it("keeps only the valid points, so the last one, the distances and the profile stay right", async () => {
		const gpx = `<gpx><trk><trkseg>
			<trkpt lat="47.000" lon="8"><ele>500</ele></trkpt>
			<trkpt lat="" lon="8"><ele>900</ele></trkpt>
			<trkpt lat="95" lon="8"/>
			<trkpt lat="47.010" lon="8"><ele>510</ele></trkpt>
		</trkseg></trk></gpx>`
		const loaded = await loadGeo(encode(gpx), "gpx")
		const lat = loaded.points?.lat ?? new Float64Array(0)

		expect(lat).toHaveLength(2)
		expect(lat.at(-1)).toBe(47.01)
		expect(loaded.cumulative?.at(-1)).toBeGreaterThan(1000)
		expect(pointAtDistance(loaded.cumulative ?? new Float64Array(0), 2000)).toBe(1)
	})

	it("reads KML tuples written with spaces after the comma, character references and comments", async () => {
		const kml = `<kml><Placemark><LineString><coordinates>8.0, 47.0 <!-- a note --> 8.1,47.1&#10;8.2,47.2</coordinates></LineString></Placemark></kml>`
		const source = await geoSource(encode(kml), "kml")
		const loaded = loadSource(source)

		// The count may only exceed what the fill keeps.
		expect(source.count().points).toBeGreaterThanOrEqual(3)
		expect([...(loaded.points?.lon ?? [])]).toEqual([8, 8.1, 8.2])
	})

	it("splits KML coordinate text into tuples exactly as the regular-expression split did", () => {
		const cases = [
			"8.5,47.5,1200",
			"8.0,47.0,0 8.1,47.1,0\n\t\t8.2,47.2,0",
			"  8,47  ",
			"8 , 47 , 3",
			"8,\n47",
			"8, ,47",
			"8,47,",
			"8,47,1,2,3",
			",",
			", 1",
			"8",
			"x,y",
			"8,47\u00a0 9,48\u2003\u3000 10,49\ufeff",
			"1e1,0x10,Infinity -0,+1,.5",
			"",
			"   \n "
		]

		for (const text of cases) expect(tuplesOf(text), JSON.stringify(text)).toEqual(referenceTuplesOf(text))
	})

	it('reads "lon, lat, alt" with spaces after the commas as one tuple', () => {
		expect(tuplesOf("8.1, 47.2, 300")).toEqual([[8.1, 47.2, 300]])
	})

	it("scans a 200,000-blank run in linear time", () => {
		const blanks = " ".repeat(200_000)
		const started = performance.now()

		// Blanks not followed by a comma (the backtracking case), and blanks on both sides of one.
		expect(tuplesOf(`8,47${blanks}9,48`)).toEqual([
			[8, 47, Number.NaN],
			[9, 48, Number.NaN]
		])
		expect(tuplesOf(`8${blanks},${blanks}47`)).toEqual([[8, 47, Number.NaN]])
		// A quadratic scan of 200,000 blanks takes tens of seconds.
		expect(performance.now() - started).toBeLessThan(1000)
	})

	it("plots GPX points outside any trkseg as a line of their own", async () => {
		const gpx = `<gpx><trk><trkpt lat="47" lon="8"/><trkpt lat="47.001" lon="8"/></trk><trk><trkseg><trkpt lat="47.002" lon="8"/></trkseg></trk></gpx>`
		const loaded = await loadGeo(encode(gpx), "gpx")

		expect([...(loaded.points?.segments ?? [])]).toEqual([0, 2, 3])
		expect(loaded.stats.points).toBe(3)
	})

	it("refuses a KMZ whose KML unpacks past the geo cap or too far for its size", async () => {
		const big = zipSync({ "doc.kml": new Uint8Array(33 * 1024 * 1024).fill(0x20) })
		const bomb = zipSync({ "doc.kml": new Uint8Array(4 * 1024 * 1024).fill(0x20) })

		await expect(loadGeo(big, "kmz")).rejects.toBeInstanceOf(GeoTooLargeError)
		await expect(loadGeo(bomb, "kmz")).rejects.toBeInstanceOf(GeoTooLargeError)
	})

	it("judges only a KMZ's KML: a large photo overlay beside a small one does not refuse it", async () => {
		// 40 MiB of incompressible bytes, stored: past the geo cap, never read.
		const photo = new Uint8Array(40 * 1024 * 1024)

		for (let i = 0; i < photo.length; i += 4096) photo[i] = i % 251

		const kmz = zipSync({ "doc.kml": encode(KML), "files/photo.jpg": [photo, { level: 0 }] })

		expect((await loadGeo(kmz, "kmz")).points?.lon).toHaveLength(5)
	})

	it("only sums a file past the point cap, allocating no arrays", () => {
		const emit = vi.fn((points: Parameters<GeoSource["emit"]>[0], _waypoints: Parameters<GeoSource["emit"]>[1]) => {
			points.segment()
			points.point(8, 47, 100, Number.NaN)
			points.point(8, 47.001, 110, Number.NaN)
		})
		const source: GeoSource = {
			format: "gpx",
			references: 0,
			count: () => ({ points: GEO_MAX_POINTS + 1, waypoints: 0, segments: 1 }),
			emit
		}
		const loaded = loadSource(source)

		expect(loaded.points).toBeNull()
		expect(loaded.stats.points).toBe(2)
		expect(loaded.stats.gain).toBe(10)
		// One streaming pass, with no waypoint sink.
		expect(emit).toHaveBeenCalledOnce()
		expect(emit.mock.calls[0]?.[1]).toBeNull()
	})
})
