// "preview" namespace, rich viewers — the GPS track viewer (gpx, kml, kmz, geojson). Spread into preview.ts; same catalog
// rules.
export const previewRichGeo = {
	/** Track viewer — accessible name of the plot of the track */
	previewGeoMapLabel: "Track plot",
	/** Track viewer — a distance in kilometres */
	previewGeoKilometres: "{{value}} km",
	/** Track viewer — a distance or height in metres */
	previewGeoMetres: "{{value}} m",
	/** Track viewer — a speed in kilometres per hour */
	previewGeoSpeed: "{{value}} km/h",
	/** Track viewer — the summary line's climb: total ascent and descent */
	previewGeoClimb: "↑ {{gain}} ↓ {{loss}}",
	/** Track viewer — the summary line's time: total, and the part spent moving */
	previewGeoTime: "{{duration}} ({{moving}} moving)",
	/** Track viewer — the summary line's top speed */
	previewGeoTopSpeed: "top {{speed}}",
	/** Track viewer — the summary line's point count */
	previewGeoPoints_one: "{{count, number}} point",
	previewGeoPoints_other: "{{count, number}} points",
	/** Track viewer — the summary line's waypoint count */
	previewGeoWaypoints_one: "{{count, number}} waypoint",
	previewGeoWaypoints_other: "{{count, number}} waypoints",
	/** Track viewer — a KML names files on the network (linked documents, overlay images); none is loaded */
	previewGeoReferences_one: "{{count, number}} network reference not loaded",
	previewGeoReferences_other: "{{count, number}} network references not loaded",
	/** Track viewer — the file holds more points than the plot draws; its figures are still shown */
	previewGeoTooMany: "Too many points to plot.",
	/** Track viewer — a KMZ whose KML unpacks past what the viewer reads */
	previewGeoTooLarge: "This file is too large to preview.",
	/** Track viewer — the file has no track, route or place to plot */
	previewGeoEmpty: "There are no points to plot in this file.",
	/** Track viewer — the file is not a readable GPX, KML or GeoJSON; shown with Download and Show source */
	previewGeoUnreadable: "This file couldn't be read as a track.",
	/** Track viewer — button showing the file's text */
	previewGeoShowSource: "Source",
	/** Track viewer — button going back from the file's text to the plot */
	previewGeoShowMap: "Plot",
	/** Track viewer — button fitting the whole track into view */
	previewGeoFit: "Fit",
	/** Track viewer — accessible name of the elevation profile */
	previewGeoProfile: "Elevation profile",
	/** Track viewer — the profile's hover readout: distance from the start and elevation there */
	previewGeoProfileAt: "{{distance}} · {{elevation}}"
} as const
