import { beforeAll, describe, expect, it, vi } from "vitest"
import { deflateSync, strToU8, zipSync } from "fflate"
import { ImageBitmapLoader, ImageLoader, type Texture } from "three"
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js"
import {
	installTextureShim,
	type ImageBitmapLoaderLike,
	type ImageLoaderLike,
	type Ktx2LoaderLike,
	type TextureShim
} from "@/features/preview/lib/model3d/imageLoaderShim"
import { installModelGlobals } from "@/features/preview/lib/model3d/workerGlobals"
import { XmlDomParser } from "@/features/preview/lib/model3d/xmlDom"
import { ModelRefusedError, REFERENCE_BASE, loadModel, modelInfo, mtlLibraries, releaseSource } from "@/features/preview/lib/model3d/load"
import { MODEL_MAX_TRIANGLES } from "@/features/preview/lib/model3d/preflight.logic"

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

	it("reads an empty binary STL, and refuses an STL or PLY whose header declares more than the limit before parsing", async () => {
		const stl = new Uint8Array(84)

		new DataView(stl.buffer).setUint32(80, 0, true)
		await expect(loadModel(stl, "stl", null, () => Promise.resolve(null))).resolves.toBeDefined()

		// A header declaring more triangles than the cap, without their bytes: STLLoader would size its arrays from it.
		const huge = new Uint8Array(84 + 50)

		new DataView(huge.buffer).setUint32(80, MODEL_MAX_TRIANGLES + 1, true)
		await expect(loadModel(huge, "stl", null, () => Promise.resolve(null))).rejects.toBeInstanceOf(ModelRefusedError)
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

	it("reserves a GIF by its first frame where it reaches past its logical screen", async () => {
		const gif = new Uint8Array(40)
		const view = new DataView(gif.buffer)

		gif.set(encode("GIF89a"))
		view.setUint16(6, 1, true)
		view.setUint16(8, 1, true)
		// The image descriptor: a 4096 × 4096 frame on a 1 × 1 screen.
		gif[13] = 0x2c
		view.setUint16(18, 4096, true)
		view.setUint16(20, 4096, true)
		gif.set([2, 1, 0, 0x3b], 23)
		files.set(`${REFERENCE_BASE}frame.gif`, gif)
		budget.pixels = 1_000_000
		decodes.length = 0

		expect(await loadTexture(new ImageLoader() as never, `${REFERENCE_BASE}frame.gif`)).toBeNull()
		expect(decodes).toHaveLength(0)
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

// A GLB of `json` and a binary chunk.
function glbOf(json: unknown, bin: Uint8Array): Uint8Array {
	const text = JSON.stringify(json)
	const body = encode(text.padEnd(Math.ceil(text.length / 4) * 4, " "))
	const padded = Math.ceil(bin.length / 4) * 4
	const glb = new Uint8Array(12 + 8 + body.length + 8 + padded)
	const view = new DataView(glb.buffer)

	view.setUint32(0, 0x46546c67, true)
	view.setUint32(4, 2, true)
	view.setUint32(8, glb.length, true)
	view.setUint32(12, body.length, true)
	view.setUint32(16, 0x4e4f534a, true)
	glb.set(body, 20)
	view.setUint32(20 + body.length, padded, true)
	view.setUint32(24 + body.length, 0x004e4942, true)
	glb.set(bin, 28 + body.length)

	return glb
}

// A quantized glTF (KHR_mesh_quantization, as gltfpack writes): one triangle with normalized UNSIGNED_SHORT positions,
// and an animation whose rotation output is normalized SHORT.
function quantizedGlb(): Uint8Array {
	const bin = new Uint8Array(64)
	const view = new DataView(bin.buffer)

	// Positions at 0: three VEC3 of uint16, each padded to 8 bytes.
	;[
		[0, 0, 0],
		[65535, 0, 0],
		[0, 65535, 0]
	].forEach(([x, y, z], i) => {
		view.setUint16(i * 8, x ?? 0, true)
		view.setUint16(i * 8 + 2, y ?? 0, true)
		view.setUint16(i * 8 + 4, z ?? 0, true)
	})
	// Times at 24: two floats; rotations at 32: two VEC4 of int16 (identity, then a quarter turn about y).
	view.setFloat32(24, 0, true)
	view.setFloat32(28, 1, true)
	;[0, 0, 0, 32767, 0, 23170, 0, 23170].forEach((value, i) => {
		view.setInt16(32 + i * 2, value, true)
	})

	return glbOf(
		{
			asset: { version: "2.0" },
			extensionsUsed: ["KHR_mesh_quantization"],
			extensionsRequired: ["KHR_mesh_quantization"],
			buffers: [{ byteLength: 64 }],
			bufferViews: [
				{ buffer: 0, byteOffset: 0, byteLength: 24, byteStride: 8 },
				{ buffer: 0, byteOffset: 24, byteLength: 8 },
				{ buffer: 0, byteOffset: 32, byteLength: 16 }
			],
			accessors: [
				{ bufferView: 0, componentType: 5123, normalized: true, count: 3, type: "VEC3", min: [0, 0, 0], max: [65535, 65535, 0] },
				{ bufferView: 1, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1] },
				{ bufferView: 2, componentType: 5122, normalized: true, count: 2, type: "VEC4" }
			],
			meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
			nodes: [{ mesh: 0 }],
			scenes: [{ nodes: [0] }],
			animations: [{ channels: [{ sampler: 0, target: { node: 0, path: "rotation" } }], samplers: [{ input: 1, output: 2 }] }]
		},
		bin
	)
}

describe("bounded loaders", () => {
	it("reads a quantized glTF with normalized positions and a normalized animation", async () => {
		const loaded = await loadModel(quantizedGlb(), "glb", null, () => Promise.resolve(null))

		expect(modelInfo(loaded.root)).toMatchObject({ triangles: 1, vertices: 3 })
		expect(loaded.animations).toHaveLength(1)
	})

	it("unpacks a 3MF with its own zip reader, never three's: a trailing fake end record's bomb is never read", async () => {
		const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`
		const benign = zipSync({
			"_rels/.rels": strToU8(
				'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
			),
			"3D/3dmodel.model": strToU8(model)
		})
		const bomb = deflateSync(new Uint8Array(30 * 1024 * 1024))
		const parts: Uint8Array[] = [benign]
		const local = new Uint8Array(30 + 1)
		const localView = new DataView(local.buffer)
		const bombOffset = benign.length

		localView.setUint32(0, 0x04034b50, true)
		localView.setUint16(8, 8, true)
		localView.setUint32(18, bomb.length, true)
		localView.setUint32(22, 30 * 1024 * 1024, true)
		localView.setUint16(26, 1, true)
		local[30] = 0x78
		parts.push(local, bomb)

		const directoryOffset = bombOffset + local.length + bomb.length
		const records = 400

		for (let i = 0; i < records; i++) {
			const record = new Uint8Array(46 + 4)
			const view = new DataView(record.buffer)

			view.setUint32(0, 0x02014b50, true)
			view.setUint16(10, 8, true)
			view.setUint32(20, bomb.length, true)
			view.setUint32(24, 30 * 1024 * 1024, true)
			view.setUint16(28, 4, true)
			view.setUint32(42, bombOffset, true)
			record.set(encode(`b${String(i).padStart(3, "0")}`), 46)
			parts.push(record)
		}

		const end = new Uint8Array(22)
		const endView = new DataView(end.buffer)

		endView.setUint32(0, 0x06054b50, true)
		endView.setUint16(8, records, true)
		endView.setUint16(10, records, true)
		endView.setUint32(12, 0xfffffff0, true)
		endView.setUint32(16, directoryOffset, true)
		parts.push(end)

		const file = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
		let at = 0

		for (const part of parts) {
			file.set(part, at)
			at += part.length
		}

		const loaded = await loadModel(file, "3mf", null, () => Promise.resolve(null))

		expect(modelInfo(loaded.root)).toMatchObject({ triangles: 1 })
	})

	it("gives a KTX2's pixels back when its transcode fails", async () => {
		const header = new Uint8Array(80)

		header.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])
		new DataView(header.buffer).setUint32(20, 4, true)
		new DataView(header.buffer).setUint32(24, 4, true)
		new DataView(header.buffer).setUint32(40, 1, true)
		budget.pixels = 1_000_000
		skipped.length = 0

		const loader = new KTX2Loader() as unknown as { _createTexture: (buffer: ArrayBuffer) => Promise<Texture> }

		// No transcoder in a test: the transcode fails after the reserve. A skip (unreadable header, no room) would
		// leave the budget unchanged without ever reserving.
		await expect(loader._createTexture(header.buffer)).rejects.not.toMatchObject({ name: "TextureSkipped" })
		expect(skipped).not.toContain("ktx2")
		expect(budget.pixels).toBe(1_000_000)
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

	it("reads the rest of an mtllib line linearly, trimmed, without its line break", () => {
		const started = performance.now()

		expect(mtlLibraries(`mtllib a${" ".repeat(1_000_000)}b\n`)).toEqual([`a${" ".repeat(1_000_000)}b`])
		expect(performance.now() - started).toBeLessThan(1000)
		expect(mtlLibraries("mtllib a.mtl b.mtl \t\r\nmtllib my model.mtl\r\n")).toEqual(["a.mtl", "b.mtl", "my model.mtl"])
		expect(mtlLibraries("mtllib \t \nmtllib\r\nmtllib   \r\n  mtllib c.mtl")).toEqual(["c.mtl"])
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
