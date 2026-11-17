import { describe, expect, it, vi } from "vitest"
import { zipSync } from "fflate"
import { GEO_MAX_POINTS, type GeoSource } from "@/features/preview/lib/geo/extract.logic"
import { geoSource, loadGeo, loadSource } from "@/features/preview/lib/geo/load"

// GPX, KML, KMZ and GeoJSON read into packed arrays: counted first, filled to size, and above the point cap only summed.

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

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
		expect(loaded.waypoints).toEqual([{ lon: 8, lat: 47, name: "Hut", description: "Water here" }])
		expect(loaded.stats.points).toBe(4)
	})

	it("reads KML lines, gx:Track coordinates with their times and Point placemarks, and counts the hrefs it never fetches", async () => {
		const fetch = vi.spyOn(globalThis, "fetch")
		const loaded = await loadGeo(encode(KML), "kml")

		expect([...(loaded.points?.segments ?? [])]).toEqual([0, 3, 5])
		expect(loaded.points?.time[4]).toBe(Date.parse("2024-01-01T00:01:00Z"))
		expect(loaded.waypoints).toEqual([{ lon: 8.5, lat: 47.5, name: "Summit", description: "" }])
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
		expect(loaded.waypoints[0]?.name).toBe("Gate")
		await expect(
			loadGeo(encode(JSON.stringify({ type: "FeatureCollection", features: [{ type: "Nope" }] })), "geojson")
		).rejects.toThrow()
		await expect(loadGeo(encode("{"), "geojson")).rejects.toThrow()
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
