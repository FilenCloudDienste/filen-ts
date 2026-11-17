import { zipSync } from "fflate"

// Tracks and shapes for the track viewer's legs: a GPX ride with Garmin extensions, a KML with a line, a timed gx:Track,
// a place and two network references (never fetched), the same KML zipped as a KMZ, and a GeoJSON area.

export const RICH_GEO_RIDE_POINTS = 120

export function rideGpx(): Buffer {
	const points = Array.from({ length: RICH_GEO_RIDE_POINTS }, (_, i) => {
		const time = new Date(Date.UTC(2024, 4, 1, 8, 0, i * 10)).toISOString()

		return `<trkpt lat="${String(47 + i * 0.0005)}" lon="${String(8 + Math.sin(i / 10) * 0.002)}"><ele>${String(500 + (i % 30))}</ele><time>${time}</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${String(110 + i)}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>`
	}).join("\n")

	return Buffer.from(
		`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="filen-e2e" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
<wpt lat="47.01" lon="8.001"><name>Fountain</name></wpt>
<trk><name>Morning ride</name><trkseg>
${points}
</trkseg></trk></gpx>
`,
		"utf8"
	)
}

export const RICH_GEO_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>
<Placemark><name>Summit</name><Point><coordinates>8.5,47.5,1200</coordinates></Point></Placemark>
<Placemark><name>Ridge</name><LineString><coordinates>8.40,47.40,900 8.45,47.45,1000 8.50,47.50,1200</coordinates></LineString></Placemark>
<Placemark><gx:Track><when>2024-01-01T10:00:00Z</when><when>2024-01-01T10:05:00Z</when><gx:coord>8.50 47.50 1200</gx:coord><gx:coord>8.52 47.51 1150</gx:coord></gx:Track></Placemark>
<NetworkLink><Link><href>https://example.com/more.kml</href></Link></NetworkLink>
<GroundOverlay><Icon><href>https://example.com/overlay.png</href></Icon><LatLonBox><north>47.6</north><south>47.3</south><east>8.6</east><west>8.3</west></LatLonBox></GroundOverlay>
</Document></kml>
`

export function placesKmz(): Buffer {
	return Buffer.from(zipSync({ "doc.kml": new TextEncoder().encode(RICH_GEO_KML) }))
}

export const RICH_GEO_JSON = JSON.stringify({
	type: "FeatureCollection",
	features: [
		{ type: "Feature", properties: { name: "Gate" }, geometry: { type: "Point", coordinates: [8.2, 47.2] } },
		{
			type: "Feature",
			properties: { name: "Park" },
			geometry: {
				type: "Polygon",
				coordinates: [
					[
						[8.2, 47.2],
						[8.25, 47.2],
						[8.25, 47.25],
						[8.2, 47.25],
						[8.2, 47.2]
					]
				]
			}
		}
	]
})
