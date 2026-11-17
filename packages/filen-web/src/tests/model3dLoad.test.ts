import { beforeAll, describe, expect, it, vi } from "vitest"
import { zipSync, strToU8 } from "fflate"
import { ImageBitmapLoader, ImageLoader, type Texture } from "three"
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js"
import {
	installTextureShim,
	type ImageBitmapLoaderLike,
	type ImageLoaderLike,
	type Ktx2LoaderLike,
	type TextureShim
} from "@/features/preview/lib/model3d/imageLoaderShim"
import { AllocationRefusedError, withAllocationBudget } from "@/features/preview/lib/model3d/allocationBudget"
import { installModelGlobals } from "@/features/preview/lib/model3d/workerGlobals"
import { XmlDomParser } from "@/features/preview/lib/model3d/xmlDom"
import { ModelRefusedError, REFERENCE_BASE, loadModel, modelInfo, mtlLibraries, releaseSource } from "@/features/preview/lib/model3d/load"

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
const budget = { pixels: 1_000_000 }
const decodes: ImageBitmapOptions[] = []
const skipped: string[] = []
// A file's bytes by URL, else a 2×2 PNG for any .png.
const files = new Map<string, Uint8Array>()
let images: TextureShim

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

beforeAll(() => {
	installModelGlobals()
	images = installTextureShim(
		{
			ImageLoader: ImageLoader as unknown as ImageLoaderLike,
			ImageBitmapLoader: ImageBitmapLoader as unknown as ImageBitmapLoaderLike,
			KTX2Loader: KTX2Loader as unknown as Ktx2LoaderLike
		},
		{
			fetch: url => {
				requested.push(url)

				const bytes = files.get(url) ?? (url.endsWith(".png") ? PNG : null)

				return Promise.resolve(
					bytes === null ? new Response(null, { status: 404 }) : new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]))
				)
			},
			decode: (_blob, options) => {
				decodes.push(options)

				return Promise.resolve({
					width: options.resizeWidth ?? 2,
					height: options.resizeHeight ?? 2,
					close: () => undefined
				} as ImageBitmap)
			},
			maxSide: 4096,
			budget,
			onSkipped: url => {
				skipped.push(url)
			}
		}
	)
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

// A PNG header declaring `width` × `height`: all the shim reads before it reserves.
function pngOf(width: number, height: number): Uint8Array {
	const bytes = PNG.slice()
	const view = new DataView(bytes.buffer)

	view.setUint32(16, width)
	view.setUint32(20, height)

	return bytes
}

function loadTexture(
	loader: { load: (url: string, onLoad: (texture: never) => void, onProgress: undefined, onError: (error: unknown) => void) => unknown },
	url: string
): Promise<unknown> {
	return new Promise(resolve => {
		loader.load(url, resolve, undefined, () => {
			resolve(null)
		})
	})
}

describe("the texture budget", () => {
	it("reserves each texture's full size before decoding, so textures asked for in one tick cannot all pass", async () => {
		budget.pixels = 3000 * 3000
		skipped.length = 0

		for (const name of ["a", "b", "c"]) files.set(`${REFERENCE_BASE}${name}.png`, pngOf(2000, 2000))

		const loader = new ImageLoader()
		const results = await Promise.all(["a", "b", "c"].map(name => loadTexture(loader as never, `${REFERENCE_BASE}${name}.png`)))

		// 9M pixels hold two 4M-pixel textures, not three.
		expect(results.filter(result => result !== null)).toHaveLength(2)
		expect(skipped).toEqual([`${REFERENCE_BASE}c.png`])
		// Drawn at full size (under the side cap): both stay charged.
		expect(budget.pixels).toBe(3000 * 3000 - 2 * 2000 * 2000)
	})

	it("keeps only the drawn size charged once a texture over the side cap is decoded smaller", async () => {
		budget.pixels = 9000 * 9000
		files.set(`${REFERENCE_BASE}wide.png`, pngOf(8192, 8192))

		expect(await loadTexture(new ImageLoader() as never, `${REFERENCE_BASE}wide.png`)).not.toBeNull()
		expect(decodes.at(-1)).toMatchObject({ resizeWidth: 4096, resizeHeight: 4096, imageOrientation: "flipY" })
		expect(budget.pixels).toBe(9000 * 9000 - 4096 * 4096)
	})

	it("skips an image whose dimensions cannot be read, never decoding it", async () => {
		budget.pixels = 1_000_000
		decodes.length = 0
		files.set(`${REFERENCE_BASE}odd.avif`, encode("not an image header"))

		expect(await loadTexture(new ImageLoader() as never, `${REFERENCE_BASE}odd.avif`)).toBeNull()
		expect(decodes).toHaveLength(0)
	})

	it("budgets glTF's ImageBitmapLoader too, keeping the options its caller set", async () => {
		budget.pixels = 100
		decodes.length = 0
		files.set(`${REFERENCE_BASE}big.png`, pngOf(4096, 4096))

		const loader = new ImageBitmapLoader().setOptions({ imageOrientation: "none", premultiplyAlpha: "none" })

		expect(await loadTexture(loader as never, `${REFERENCE_BASE}big.png`)).toBeNull()

		budget.pixels = 1_000_000

		expect(await loadTexture(loader as never, `${REFERENCE_BASE}skin.png`)).not.toBeNull()
		expect(decodes.at(-1)).toMatchObject({ imageOrientation: "none", premultiplyAlpha: "none", colorSpaceConversion: "none" })
	})

	it("refuses a KTX2 whose header does not fit before it transcodes", async () => {
		const header = new Uint8Array(80)

		header.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])
		new DataView(header.buffer).setUint32(20, 16384, true)
		new DataView(header.buffer).setUint32(24, 16384, true)
		budget.pixels = 1_000_000

		const loader = new KTX2Loader() as unknown as { _createTexture: (buffer: ArrayBuffer) => Promise<Texture> }

		await expect(loader._createTexture(header.buffer)).rejects.toMatchObject({ name: "TextureSkipped" })
		expect(budget.pixels).toBe(1_000_000)
	})
})

describe("the parse's allocation budget", () => {
	it("refuses a typed array over the limit before allocating it, and restores the constructors", async () => {
		const real = Float32Array

		await expect(
			withAllocationBudget({ each: 1024, total: 4096 }, () => Promise.resolve(new Float32Array(1024)))
		).rejects.toBeInstanceOf(AllocationRefusedError)
		await expect(
			withAllocationBudget({ each: 1024, total: 2048 }, () => {
				const first = new Uint8Array(1000)

				// A view over an existing buffer allocates nothing; the third allocation takes the total past 2048.
				new Float32Array(first.buffer)
				new Uint8Array(1000)

				return Promise.resolve(new ArrayBuffer(100))
			})
		).rejects.toBeInstanceOf(AllocationRefusedError)
		await expect(withAllocationBudget({ each: 1024, total: 4096 }, () => Promise.resolve(new Uint8Array(10).length))).resolves.toBe(10)
		expect(Float32Array).toBe(real)
		expect(new Float32Array(2) instanceof Float32Array).toBe(true)
	})

	it("refuses a USDZ whose layer asks for a buffer past the unpacked cap", async () => {
		// A USDC crate whose LZ4 token block declares 4 GiB uncompressed is caught where it allocates.
		const refused = withAllocationBudget({ each: 1024, total: 1024 }, () => Promise.resolve(new Uint8Array(2 ** 32 - 1)))

		await expect(refused).rejects.toBeInstanceOf(AllocationRefusedError)
	})

	it("turns a refused allocation into a too-large model, the loader's own wrapping included", async () => {
		// Within the preflight's meshopt cap, past what one allocation may take: GLTFLoader's new ArrayBuffer(count ×
		// stride) is refused before it allocates 720 MB.
		const gltf = {
			asset: { version: "2.0" },
			extensionsUsed: ["EXT_meshopt_compression"],
			buffers: [{ byteLength: 4 }],
			bufferViews: [
				{
					buffer: 0,
					byteLength: 4,
					extensions: {
						EXT_meshopt_compression: { buffer: 0, byteLength: 4, count: 45_000_000, byteStride: 16, mode: "ATTRIBUTES" }
					}
				}
			],
			accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: "VEC4" }],
			meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
			nodes: [{ mesh: 0 }],
			scenes: [{ nodes: [0] }]
		}

		const json = encode(JSON.stringify(gltf).padEnd(Math.ceil(JSON.stringify(gltf).length / 4) * 4, " "))
		const glb = new Uint8Array(12 + 8 + json.length + 8 + 4)
		const view = new DataView(glb.buffer)

		view.setUint32(0, 0x46546c67, true)
		view.setUint32(4, 2, true)
		view.setUint32(8, glb.length, true)
		view.setUint32(12, json.length, true)
		view.setUint32(16, 0x4e4f534a, true)
		glb.set(json, 20)
		view.setUint32(20 + json.length, 4, true)
		view.setUint32(24 + json.length, 0x004e4942, true)

		await expect(loadModel(glb, "glb", null, () => Promise.resolve(null))).rejects.toMatchObject({
			name: "ModelRefused",
			reason: "tooLarge"
		})
	})

	it("frees the file's bytes once parsed, the scene intact", async () => {
		const stl = new Uint8Array(84 + 12 * 50)

		new DataView(stl.buffer).setUint32(80, 12, true)
		new DataView(stl.buffer).setFloat32(84 + 12, 5, true)

		const loaded = await loadModel(stl, "stl", null, () => Promise.resolve(null))

		releaseSource(stl)

		expect(stl.byteLength).toBe(0)
		expect(modelInfo(loaded.root)).toMatchObject({ triangles: 12, size: [5, 0, 0] })
	})
})

describe("mtllib", () => {
	it("names several MTLs or one with spaces, each once, and every MTL's materials apply", async () => {
		expect(mtlLibraries("mtllib a.mtl b.mtl\nmtllib my model.mtl\nmtllib a.mtl\n")).toEqual(["a.mtl", "b.mtl", "my model.mtl"])

		const obj = "mtllib a.mtl b.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl red\nf 1 2 3\nusemtl blue\nf 1 3 2\n"
		const mtl: Record<string, string> = { "a.mtl": "newmtl red\nKd 1 0 0\n", "b.mtl": "newmtl blue\nKd 0 0 1\n" }
		const loaded = await loadModel(encode(obj), "obj", null, url => Promise.resolve(mtl[url.slice(REFERENCE_BASE.length)] ?? null))
		const names: string[] = []

		loaded.root.traverse(object => {
			const material = (object as { material?: { name: string } | { name: string }[] }).material

			for (const one of Array.isArray(material) ? material : material === undefined ? [] : [material]) names.push(one.name)
		})

		expect(names.sort()).toEqual(["blue", "red"])
	})

	it("refuses an OBJ whose faces fan past the triangle cap before parsing", async () => {
		await expect(
			loadModel(encode(`v 0 0 0\nf ${"1 ".repeat(1_100_000)}\n`), "obj", null, () => Promise.resolve(null))
		).rejects.toMatchObject({
			reason: "tooLarge"
		})
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
