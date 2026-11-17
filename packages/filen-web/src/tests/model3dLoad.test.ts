import { beforeAll, describe, expect, it, vi } from "vitest"
import { zipSync, strToU8 } from "fflate"
import { ImageLoader } from "three"
import { installImageLoaderShim, type ImageLoaderLike, type ImageLoaderShim } from "@/features/preview/lib/model3d/imageLoaderShim"
import { installModelGlobals } from "@/features/preview/lib/model3d/workerGlobals"
import { XmlDomParser } from "@/features/preview/lib/model3d/xmlDom"
import { ModelRefusedError, REFERENCE_BASE, loadModel, modelInfo, mtlLibraries } from "@/features/preview/lib/model3d/load"

// The worker's loading path without a GPU: each format parsed as the 3D worker parses it (its globals, the ImageLoader
// shim answering texture reads), and its figures counted. Draco and KTX2 need decoder workers and are left to the e2e.

vi.mock("virtual:three-assets", () => ({
	THREE_ASSETS: { base: "/assets/three/", draco: "/assets/three/draco/gltf/", basis: "/assets/three/basis/" }
}))

// A 1×1 PNG's header is all the shim reads before decoding.
const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00,
	0x00, 0x02, 0x08, 0x06, 0x00, 0x00, 0x00
])
const requested: string[] = []
let images: ImageLoaderShim

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

beforeAll(() => {
	installModelGlobals()
	images = installImageLoaderShim(ImageLoader as unknown as ImageLoaderLike, {
		fetch: url => {
			requested.push(url)

			return Promise.resolve(url.endsWith(".png") ? new Response(PNG) : new Response(null, { status: 404 }))
		},
		decode: (_blob, options) =>
			Promise.resolve({ width: options.resizeWidth ?? 2, height: options.resizeHeight ?? 2, close: () => undefined } as ImageBitmap),
		maxSide: 4096,
		budget: { pixels: 1_000_000 },
		onSkipped: () => undefined
	})
})

function cubeStl(): Uint8Array {
	const bytes = new Uint8Array(84 + 12 * 50)

	new DataView(bytes.buffer).setUint32(80, 12, true)

	return bytes
}

const QUAD_OBJ =
	"mtllib quad.mtl\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nusemtl skin\nf 1/1 2/2 3/3\nf 1/1 3/3 4/4\n"

describe("loadModel", () => {
	it("reads a binary STL as one lit mesh", async () => {
		const loaded = await loadModel(cubeStl(), "stl", null, () => Promise.resolve(null))

		expect(modelInfo(loaded.root)).toMatchObject({ triangles: 12, vertices: 36, meshes: 1 })
	})

	it("reads an OBJ with the MTL it names, whose texture is asked for below the model's directory", async () => {
		const fetchText = vi.fn((url: string) =>
			Promise.resolve(url === `${REFERENCE_BASE}quad.mtl` ? "newmtl skin\nmap_Kd maps/skin.png\n" : null)
		)
		const loaded = await loadModel(encode(QUAD_OBJ), "obj", null, fetchText)

		await images.settled()

		expect(mtlLibraries(QUAD_OBJ)).toEqual(["quad.mtl"])
		expect(fetchText).toHaveBeenCalledWith(`${REFERENCE_BASE}quad.mtl`)
		expect(requested).toContain(`${REFERENCE_BASE}maps/skin.png`)
		expect(modelInfo(loaded.root)).toMatchObject({ triangles: 2, materials: 1, textures: 1 })
	})

	it("reads an OBJ whose MTL is missing with its default material", async () => {
		const loaded = await loadModel(encode(QUAD_OBJ), "obj", null, () => Promise.resolve(null))

		expect(modelInfo(loaded.root)).toMatchObject({ triangles: 2, textures: 0 })
	})

	it("reads a 3MF's model through the worker's DOMParser", async () => {
		const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`
		const zip = zipSync({
			"[Content_Types].xml": strToU8(
				'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
			),
			"_rels/.rels": strToU8(
				'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
			),
			"3D/3dmodel.model": strToU8(model)
		})
		const loaded = await loadModel(zip, "3mf", null, () => Promise.resolve(null))

		expect(modelInfo(loaded.root)).toMatchObject({ triangles: 4, vertices: 4, meshes: 1 })
	})

	it("reads a USDZ's layer and asks for its texture through the ImageLoader", async () => {
		const layer = `#usda 1.0
(
	defaultPrim = "Root"
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
		rel material:binding = </Root/Skin>
	}

	def Material "Skin"
	{
		token outputs:surface.connect = </Root/Skin/Surface.outputs:surface>

		def Shader "Surface"
		{
			uniform token info:id = "UsdPreviewSurface"
			color3f inputs:diffuseColor.connect = </Root/Skin/Texture.outputs:rgb>
			token outputs:surface
		}

		def Shader "Texture"
		{
			uniform token info:id = "UsdUVTexture"
			asset inputs:file = @textures/skin.png@
			float3 outputs:rgb
		}
	}
}
`
		const zip = zipSync({ "scene.usda": [strToU8(layer), { level: 0 }], "textures/skin.png": [PNG, { level: 0 }] })
		const before = requested.length
		const loaded = await loadModel(zip, "usdz", null, () => Promise.resolve(null))

		await images.settled()

		expect(modelInfo(loaded.root)).toMatchObject({ triangles: 2, meshes: 1 })
		// An embedded texture is a blob: URL, answered by the sandbox in the worker.
		expect(requested.slice(before).some(url => url.startsWith("blob:"))).toBe(true)
	})

	it("refuses a binary STL above the triangle limit before parsing", async () => {
		const stl = new Uint8Array(84)

		new DataView(stl.buffer).setUint32(80, 0, true)
		await expect(loadModel(stl, "stl", null, () => Promise.resolve(null))).resolves.toBeDefined()
		await expect(
			loadModel(encode("ply\nformat ascii 1.0\nelement vertex 40000000\nend_header\n"), "ply", null, () => Promise.resolve(null))
		).rejects.toBeInstanceOf(ModelRefusedError)
	})
})

describe("the worker's DOMParser", () => {
	const doc = new XmlDomParser().parseFromString(
		'<?xml version="1.0"?><model xmlns:m="urn:m" unit="mm"><resources><m:colorgroup id="2"><m:color color="#fff"/></m:colorgroup><object id="1"><mesh><vertices><vertex x="1"/><vertex x="2"/></vertices></mesh></object></resources><vertex x="9"/></model>',
		"application/xml"
	)

	it("selects by local name and descendant chain, in document order", () => {
		expect(doc.documentElement.nodeName).toBe("model")
		expect(doc.querySelector("model")?.getAttribute("unit")).toBe("mm")
		expect(doc.querySelectorAll("vertex").map(node => node.getAttribute("x"))).toEqual(["1", "2", "9"])
		expect(doc.querySelectorAll("vertices vertex").map(node => node.getAttribute("x"))).toEqual(["1", "2"])
		expect(doc.querySelectorAll("colorgroup")[0]?.nodeName).toBe("m:colorgroup")

		const mesh = doc.querySelector("mesh")

		expect(mesh?.querySelectorAll("vertex")).toHaveLength(2)
		expect(mesh?.querySelector("object")).toBeNull()
		expect(mesh?.children.map(node => node.nodeName)).toEqual(["vertices"])
		expect(doc.querySelector("model")?.attributes.map(attribute => attribute.name)).toEqual(["xmlns:m", "unit"])
		expect(doc.querySelector("object")?.getAttribute("missing")).toBeNull()
	})
})
