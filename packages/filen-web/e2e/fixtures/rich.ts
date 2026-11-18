import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { buildZip } from "../helpers/archiveFixtures"
import { appDatabase, walDatabase } from "./richSqlite"
import { RICH_GEO_JSON, RICH_GEO_KML, placesKmz, rideGpx } from "./richGeo"
import { RICH_MODELS_PASSWORD, checkerPng, cubeStl, meshMtl, meshObj, modelGlb, modelsZip, print3mf } from "./richModels"
import { planDxf } from "./richCad"
import {
	richBigEndian,
	richCine,
	richColor,
	richCt,
	richDeflate,
	richHtj2k,
	richJ2k,
	richJls,
	richLossless,
	richPalette
} from "./richDicom"
import { scenarioModule } from "./scenarios"

// The rich viewers' files (preview-rich.spec.ts): fonts from the office package's own assets, SQLite databases written
// by node:sqlite (fixtures/richSqlite.ts), tracks (fixtures/richGeo.ts), 3D models (fixtures/richModels.ts), a CAD
// drawing (fixtures/richCad.ts) and DICOM images (fixtures/richDicom.ts).

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
		"rich-geo": ["rich-ride.gpx", "rich-places.kml", "rich-places.kmz", "rich-area.geojson"],
		// The OBJ's MTL and texture beside it.
		"rich-models": ["rich-cube.stl", "rich-mesh.obj", "rich-mesh.mtl", "rich-mesh-tex.png", "rich-model.glb", "rich-print.3mf"],
		// An OBJ whose MTL is nowhere.
		"rich-models-lone": ["rich-lone.obj"],
		// The OBJ trio as archive entries, its texture in a subdirectory; the second archive encrypted.
		"rich-models-archive": ["rich-models.zip", "rich-models-locked.zip"],
		"rich-cad": ["rich-plan.dxf"],
		// A CT (native, signed 12 in 16), an RLE cine, JPEG-LS, JPEG 2000, a colour baseline JPEG, a deflated CT, HTJ2K,
		// lossless JPEG, PALETTE COLOR and a big-endian CT.
		"rich-dicom": [
			"rich-ct.dcm",
			"rich-cine.dcm",
			"rich-jls.dcm",
			"rich-j2k.dcm",
			"rich-color.dcm",
			"rich-deflate.dcm",
			"rich-htj2k.dcm",
			"rich-lossless.dcm",
			"rich-palette.dcm",
			"rich-big-endian.dcm"
		]
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
		"rich-databases.zip": { generate: () => buildZip([{ name: RICH_SQLITE_ENTRY, data: appDatabase() }]) },
		// Every model file is generated, as every scenario's files take one payload kind.
		"rich-cube.stl": { generate: cubeStl },
		"rich-mesh.obj": { generate: () => Buffer.from(meshObj("rich-mesh.mtl"), "utf8") },
		"rich-mesh.mtl": { generate: () => Buffer.from(meshMtl("rich-mesh-tex.png"), "utf8") },
		"rich-mesh-tex.png": { generate: checkerPng },
		"rich-model.glb": { generate: modelGlb },
		"rich-print.3mf": { generate: print3mf },
		"rich-lone.obj": { generate: () => Buffer.from(meshObj("rich-lone.mtl"), "utf8") },
		"rich-models.zip": { generate: () => modelsZip() },
		"rich-models-locked.zip": { generate: () => modelsZip(RICH_MODELS_PASSWORD) },
		"rich-plan.dxf": { generate: planDxf },
		"rich-ct.dcm": { generate: richCt },
		"rich-cine.dcm": { generate: richCine },
		"rich-jls.dcm": { generate: richJls },
		"rich-j2k.dcm": { generate: richJ2k },
		"rich-color.dcm": { generate: richColor },
		"rich-deflate.dcm": { generate: richDeflate },
		"rich-htj2k.dcm": { generate: richHtj2k },
		"rich-lossless.dcm": { generate: richLossless },
		"rich-palette.dcm": { generate: richPalette },
		"rich-big-endian.dcm": { generate: richBigEndian }
	})
)
