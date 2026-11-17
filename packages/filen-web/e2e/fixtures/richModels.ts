import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { crc32, deflateSync } from "node:zlib"
import { buildZip, ZIPCRYPTO_PASSWORD } from "../helpers/archiveFixtures"

// The 3D viewer's files, built here byte for byte, except rich-model.glb: Draco needs its encoder, so that one is
// committed. It was written by @gltf-transform/core, extensions and functions 4.5.1 with draco3dgltf 1.5.7 (Node): a
// cube of 24 vertices and 12 triangles with normals and uvs, a material whose base colour is an embedded 4×4 PNG, then
// `draco()` and KHR_draco_mesh_compression required, written with NodeIO.writeBinary.

const MODELS = fileURLToPath(new URL("./models/", import.meta.url))

// A cube's 12 triangles.
export const RICH_CUBE_TRIANGLES = 12

// The model inside rich-models.zip and rich-models-locked.zip.
export const RICH_MODEL_ENTRY = "inner-mesh.obj"

// The encrypted archive's password.
export const RICH_MODELS_PASSWORD = ZIPCRYPTO_PASSWORD

function chunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8)
	const tail = Buffer.alloc(4)

	head.writeUInt32BE(data.length, 0)
	head.write(type, 4, "latin1")
	tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])) >>> 0, 0)

	return Buffer.concat([head, data, tail])
}

// A 4×4 RGBA checkerboard.
export function checkerPng(): Buffer {
	const header = Buffer.alloc(13)

	header.writeUInt32BE(4, 0)
	header.writeUInt32BE(4, 4)
	header[8] = 8
	header[9] = 6

	const rows = Array.from({ length: 4 }, (_, y) =>
		Buffer.from([0, ...Array.from({ length: 4 }, (__, x) => ((x + y) % 2 === 0 ? [230, 120, 40, 255] : [40, 120, 230, 255])).flat()])
	)

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.concat(rows))),
		chunk("IEND", Buffer.alloc(0))
	])
}

const CUBE_CORNERS: readonly (readonly [number, number, number])[] = [
	[0, 0, 0],
	[1, 0, 0],
	[1, 1, 0],
	[0, 1, 0],
	[0, 0, 1],
	[1, 0, 1],
	[1, 1, 1],
	[0, 1, 1]
]

// Corner indices, counter-clockwise seen from outside.
const CUBE_TRIANGLES: readonly (readonly [number, number, number])[] = [
	[0, 2, 1],
	[0, 3, 2],
	[4, 5, 6],
	[4, 6, 7],
	[0, 1, 5],
	[0, 5, 4],
	[2, 3, 7],
	[2, 7, 6],
	[1, 2, 6],
	[1, 6, 5],
	[0, 4, 7],
	[0, 7, 3]
]

// A binary STL: an 80-byte header, the count, then each triangle's normal, corners and attribute word.
export function cubeStl(): Buffer {
	const bytes = Buffer.alloc(84 + CUBE_TRIANGLES.length * 50)

	bytes.write("rich-cube", 0, "latin1")
	bytes.writeUInt32LE(CUBE_TRIANGLES.length, 80)
	CUBE_TRIANGLES.forEach((triangle, index) => {
		let offset = 84 + index * 50 + 12

		for (const corner of triangle) {
			for (const value of CUBE_CORNERS[corner] ?? [0, 0, 0]) {
				bytes.writeFloatLE(value, offset)
				offset += 4
			}
		}
	})

	return bytes
}

// A textured quad naming its material library.
export function meshObj(library: string): string {
	return [
		"# rich-mesh",
		`mtllib ${library}`,
		"v 0 0 0",
		"v 1 0 0",
		"v 1 1 0",
		"v 0 1 0",
		"vt 0 0",
		"vt 1 0",
		"vt 1 1",
		"vt 0 1",
		"vn 0 0 1",
		"usemtl checker",
		"f 1/1/1 2/2/1 3/3/1",
		"f 1/1/1 3/3/1 4/4/1",
		""
	].join("\n")
}

export function meshMtl(texture: string): string {
	return ["newmtl checker", "Kd 1 1 1", `map_Kd ${texture}`, ""].join("\n")
}

// A 3MF: the package's content types and relationship, and a model holding the cube.
export function print3mf(): Buffer {
	const vertices = CUBE_CORNERS.map(([x, y, z]) => `<vertex x="${String(x * 10)}" y="${String(y * 10)}" z="${String(z * 10)}"/>`).join("")
	const triangles = CUBE_TRIANGLES.map(([a, b, c]) => `<triangle v1="${String(a)}" v2="${String(b)}" v3="${String(c)}"/>`).join("")

	return buildZip([
		{
			name: "[Content_Types].xml",
			data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'
		},
		{
			name: "_rels/.rels",
			data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
		},
		{
			name: "3D/3dmodel.model",
			data: `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`
		}
	])
}

// A USDZ (an uncompressed zip whose first entry is the layer): a textured quad through a UsdPreviewSurface.
export function sceneUsdz(): Buffer {
	const layer = `#usda 1.0
(
	defaultPrim = "Root"
	upAxis = "Y"
)

def Xform "Root"
{
	def Mesh "Quad" (
		prepend apiSchemas = ["MaterialBindingAPI"]
	)
	{
		int[] faceVertexCounts = [4]
		int[] faceVertexIndices = [0, 1, 2, 3]
		point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
		texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 1)] (
			interpolation = "vertex"
		)
		rel material:binding = </Root/Checker>
	}

	def Material "Checker"
	{
		token outputs:surface.connect = </Root/Checker/Surface.outputs:surface>

		def Shader "Surface"
		{
			uniform token info:id = "UsdPreviewSurface"
			color3f inputs:diffuseColor.connect = </Root/Checker/Texture.outputs:rgb>
			token outputs:surface
		}

		def Shader "Reader"
		{
			uniform token info:id = "UsdPrimvarReader_float2"
			token inputs:varname = "st"
			float2 outputs:result
		}

		def Shader "Texture"
		{
			uniform token info:id = "UsdUVTexture"
			asset inputs:file = @textures/checker.png@
			float2 inputs:st.connect = </Root/Checker/Reader.outputs:result>
			float3 outputs:rgb
		}
	}
}
`

	return buildZip([
		{ name: "scene.usda", data: layer, method: "stored" },
		{ name: "textures/checker.png", data: checkerPng(), method: "stored" }
	])
}

export function modelGlb(): Buffer {
	return readFileSync(`${MODELS}rich-model.glb`)
}

// An OBJ, its MTL and its texture in a subdirectory, inside an archive; `password` encrypts every entry.
export function modelsZip(password?: string): Buffer {
	const crypto = password === undefined ? {} : { zipCrypto: password }

	return buildZip([
		{ name: RICH_MODEL_ENTRY, data: meshObj("inner-mesh.mtl"), ...crypto },
		{ name: "inner-mesh.mtl", data: meshMtl("textures/checker.png"), ...crypto },
		{ name: "textures/", kind: "dir" },
		{ name: "textures/checker.png", data: checkerPng(), ...crypto }
	])
}
