import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { buildZip } from "../helpers/archiveFixtures"
import { appDatabase, walDatabase } from "./richSqlite"
import { RICH_GEO_JSON, RICH_GEO_KML, placesKmz, rideGpx } from "./richGeo"
import { scenarioModule } from "./scenarios"

// The rich viewers' files (preview-rich.spec.ts): fonts from the office package's own assets, SQLite databases written
// by node:sqlite (fixtures/richSqlite.ts).

const FONTS = fileURLToPath(new URL("../../../filen-office/assets/fonts/arimo/", import.meta.url))

export const RICH_FONT_FAMILY = "Arimo"

// The database inside rich-databases.zip.
export const RICH_SQLITE_ENTRY = "inner-app.sqlite"

export const RICH_SCENARIOS = scenarioModule(
	{
		"rich-fonts": ["rich-font.ttf", "rich-webfont.woff2"],
		"rich-sqlite": ["rich-app.sqlite", "rich-wal.sqlite", "rich-not-db.db"],
		// The same database as an archive's entry: read whole into sqlite's memory.
		"rich-sqlite-archive": ["rich-databases.zip"],
		"rich-geo": ["rich-ride.gpx", "rich-places.kml", "rich-places.kmz", "rich-area.geojson"]
	},
	() => ({
		"rich-font.ttf": { generate: () => gunzipSync(readFileSync(`${FONTS}Arimo-Regular.ttf.gz`)) },
		// A variable face: its weight axis gets a slider.
		"rich-webfont.woff2": { buffer: readFileSync(`${FONTS}Arimo-VF.woff2`), mimeType: "font/woff2" },
		"rich-app.sqlite": { generate: appDatabase },
		"rich-wal.sqlite": { generate: walDatabase },
		// A .db that is no database: its head read finds no SQLite header.
		"rich-not-db.db": {
			buffer: Buffer.from("not a database, just a program's data\n".repeat(64), "utf8"),
			mimeType: "application/octet-stream"
		},
		"rich-ride.gpx": { generate: rideGpx },
		// One payload kind per scenario (setInputFiles takes paths or buffers, never both): every geo file is generated.
		"rich-places.kml": { generate: () => Buffer.from(RICH_GEO_KML, "utf8") },
		"rich-places.kmz": { generate: placesKmz },
		"rich-area.geojson": { generate: () => Buffer.from(RICH_GEO_JSON, "utf8") },
		"rich-databases.zip": { generate: () => buildZip([{ name: RICH_SQLITE_ENTRY, data: appDatabase() }]) }
	})
)
