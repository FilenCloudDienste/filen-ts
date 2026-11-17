import { describe, expect, it, vi } from "vitest"
import { charArray, doubleArray, fbxFile, int32, intArray, string } from "@/tests/support/fbx"
import {
	cameraPosition,
	fitOrbit,
	fitRadius,
	homeOrbit,
	panOrbit,
	rotateOrbit,
	sameOrbit,
	zoomOrbit
} from "@/features/preview/lib/model3d/orbit.logic"
import {
	MODEL_MAX_HEAP_BYTES,
	MODEL_MAX_BYTES,
	MODEL_MAX_TRIANGLES,
	MODEL_MAX_UNPACKED_BYTES,
	OBJ_MAX_CORNERS,
	fbxCosts,
	preflightUsdaText,
	textNumbers,
	gifDimensions,
	gltfMeshoptBytes,
	ktx2Pixels,
	objCounts,
	preflightFbx,
	preflightObj,
	binaryStlTriangles,
	gltfElements,
	gpuBytes,
	isTextModel,
	modelFormat,
	plyCounts,
	preflightGltf,
	preflightPly,
	preflightStl,
	preflightZip,
	textureSize
} from "@/features/preview/lib/model3d/preflight.logic"
import { bitmapOptions } from "@/features/preview/lib/model3d/imageLoaderShim"
import { MAX_REFERENCES } from "@/features/preview/lib/referenceResolver.logic"
import {
	animationEntries,
	referenceOutcomes,
	referenceServer,
	referenceSummary,
	type ReferenceOutcome
} from "@/features/preview/components/model3dViewer.logic"
import type { ResolvedReference } from "@/features/preview/lib/referenceResolver"

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

function binaryStl(triangles: number, declared = triangles): Uint8Array {
	const bytes = new Uint8Array(84 + triangles * 50)

	new DataView(bytes.buffer).setUint32(80, declared, true)

	return bytes
}

function glb(json: unknown): Uint8Array {
	const body = encode(JSON.stringify(json))
	const padded = Math.ceil(body.length / 4) * 4
	const bytes = new Uint8Array(20 + padded).fill(0x20, 20)
	const view = new DataView(bytes.buffer)

	view.setUint32(0, 0x46546c67, true)
	view.setUint32(4, 2, true)
	view.setUint32(8, bytes.length, true)
	view.setUint32(12, padded, true)
	view.setUint32(16, 0x4e4f534a, true)
	bytes.set(body, 20)

	return bytes
}

describe("orbit", () => {
	const sphere = { center: [1, 2, 3] as const, radius: 2 }

	it("frames the bounding sphere within the narrower field of view", () => {
		const square = fitRadius(sphere, 90, 1)

		expect(square).toBeCloseTo(2 / Math.sin(Math.PI / 4))
		// A tall canvas: the horizontal field is the narrower one, so the camera steps back.
		expect(fitRadius(sphere, 90, 0.5)).toBeGreaterThan(square)
		expect(fitRadius(sphere, 90, 2)).toBeCloseTo(square)
	})

	it("opens from the front-right above the centre, and Fit keeps the angles", () => {
		const home = homeOrbit(sphere, 45, 1)
		const [x, y, z] = cameraPosition(home)

		expect(home.target).toEqual([1, 2, 3])
		expect(x).toBeGreaterThan(1)
		expect(y).toBeGreaterThan(2)
		expect(z).toBeGreaterThan(3)
		expect(Math.hypot(x - 1, y - 2, z - 3)).toBeCloseTo(home.radius)

		const turned = rotateOrbit(home, 100, 0, 500)
		const fitted = fitOrbit({ ...turned, radius: 1, target: [0, 0, 0] }, sphere, 45, 1)

		expect(fitted.azimuth).toBe(turned.azimuth)
		expect(fitted.radius).toBe(home.radius)
		expect(fitted.target).toEqual([1, 2, 3])
	})

	it("keeps the camera off the poles and zoom within its bounds", () => {
		const home = homeOrbit(sphere, 45, 1)

		expect(rotateOrbit(home, 0, -1e6, 500).polar).toBeGreaterThan(0)
		expect(rotateOrbit(home, 0, 1e6, 500).polar).toBeLessThan(Math.PI)
		expect(zoomOrbit(home, 1e9, home.radius).radius).toBeCloseTo(home.radius * 0.01)
		expect(zoomOrbit(home, 1e-9, home.radius).radius).toBeCloseTo(home.radius * 100)
		expect(zoomOrbit(home, 2, home.radius).radius).toBeCloseTo(home.radius / 2)
	})

	it("pans the target in the view plane, leaving the angles", () => {
		const home = homeOrbit(sphere, 45, 1)
		const panned = panOrbit(home, 50, 0, 500, 45)
		const moved = panned.target.map((value, i) => value - (home.target[i] ?? 0))

		expect(panned.azimuth).toBe(home.azimuth)
		// A horizontal drag moves the target along the camera's right vector, never up.
		expect(moved[1]).toBeCloseTo(0)
		expect(Math.hypot(...moved)).toBeGreaterThan(0)
		expect(sameOrbit(home, { ...home })).toBe(true)
		expect(sameOrbit(home, panned)).toBe(false)
	})
})

describe("preflight", () => {
	it("reads a binary STL's triangle count from its header and refuses one above the limit", () => {
		expect(binaryStlTriangles(binaryStl(3))).toBe(3)
		expect(binaryStlTriangles(encode("solid cube\nendsolid cube\n"))).toBeNull()
		expect(preflightStl(binaryStl(1))).toEqual({ ok: true })
		// Trailing bytes after a real binary STL: still binary (no "solid"), still capped.
		expect(binaryStlTriangles(new Uint8Array([...binaryStl(3), 0, 0]))).toBe(3)

		const huge = new Uint8Array(84 + 50)

		new DataView(huge.buffer).setUint32(80, MODEL_MAX_TRIANGLES + 1, true)
		// As STLLoader reads it: no "solid", so binary, and its arrays would be sized by the header. Refused first.
		expect(preflightStl(huge)).toEqual({ ok: false, reason: "malformed" })
		expect(preflightStl(binaryStl(3, 4))).toEqual({ ok: false, reason: "malformed" })

		const declared = new Uint8Array(84 + (MODEL_MAX_TRIANGLES + 1) * 50)

		new DataView(declared.buffer).setUint32(80, MODEL_MAX_TRIANGLES + 1, true)
		expect(preflightStl(declared)).toEqual({ ok: false, reason: "tooLarge" })
	})

	it("reads a PLY header's element counts", () => {
		const ply = encode("ply\nformat ascii 1.0\nelement vertex 8\nproperty float x\nelement face 12\nend_header\n")

		expect(plyCounts(ply)).toEqual({ vertices: 8, faces: 12 })
		expect(preflightPly(ply)).toEqual({ ok: true })
		expect(preflightPly(encode("ply\nformat ascii 1.0\nelement vertex 40000000\nend_header\n"))).toEqual({
			ok: false,
			reason: "tooLarge"
		})
		expect(preflightPly(encode("not a ply"))).toEqual({ ok: false, reason: "malformed" })
		expect(isTextModel("ply", ply)).toBe(true)
		expect(isTextModel("ply", encode("ply\nformat binary_little_endian 1.0\nend_header\n"))).toBe(false)
	})

	it("sums a glTF's accessor counts from its JSON, binary or not", () => {
		const json = { asset: { version: "2.0" }, accessors: [{ count: 3 }, { count: 6 }, { count: -1 }, {}] }

		expect(gltfElements(json)).toBe(9)
		expect(preflightGltf(glb(json), true)).toEqual({ ok: true })
		expect(preflightGltf(encode(JSON.stringify(json)), false)).toEqual({ ok: true })
		expect(preflightGltf(glb({ accessors: [{ count: 1e9 }] }), true)).toEqual({ ok: false, reason: "tooLarge" })
		expect(preflightGltf(encode("{"), false)).toEqual({ ok: false, reason: "malformed" })
		expect(preflightGltf(new Uint8Array(24), true)).toEqual({ ok: false, reason: "malformed" })
	})

	it("counts what meshopt buffers would allocate, from their declared counts and strides", () => {
		const meshopt = (count: number) => ({
			bufferViews: [
				{ extensions: { EXT_meshopt_compression: { count, byteStride: 16 } } },
				{ extensions: { KHR_meshopt_compression: { count: 1, byteStride: 4 } } }
			]
		})

		expect(gltfMeshoptBytes(meshopt(10))).toBe(164)
		expect(preflightGltf(glb(meshopt(10)), true)).toEqual({ ok: true })
		expect(preflightGltf(glb(meshopt(100_000_000)), true)).toEqual({ ok: false, reason: "tooLarge" })
	})

	it("counts an OBJ's vertices and the corners its faces, lines and points copy, before parsing", () => {
		expect(
			objCounts("v 0 0 0\nv 1 0 0\n  v 0 1 0\nvt 0 0\nvn 0 0 1\nvp 1\nf 1 2 3\nf 1/1 2/1 3/1 1/1\nl 1 2 3\np 1 2\n# f 1 2 3\n")
		).toEqual({
			vertices: 3,
			corners: 3 + 6 + 3 + 2
		})
		// One face line with a million corners: refused before OBJLoader copies them.
		expect(preflightObj(`v 0.5 0.5 0.5\nf ${"1 ".repeat(OBJ_MAX_CORNERS)}\n`)).toEqual({ ok: false, reason: "tooLarge" })
		expect(preflightObj("v 0 0 0\nf 1 1 1\n")).toEqual({ ok: true })
	})

	it("reads lines as OBJLoader does: a continued face, a bare CR inside a line, CRLF, l and p lines", () => {
		const tokens = "1 ".repeat(OBJ_MAX_CORNERS + 1)

		// A backslash before the line feed joins the next line onto the face.
		expect(preflightObj(`f 1 1 \\\n${tokens}\n`)).toEqual({ ok: false, reason: "tooLarge" })
		expect(preflightObj(`f 1 1 \\\r\n${tokens}\r\nv 0 0 0\r\n`)).toEqual({ ok: false, reason: "tooLarge" })
		// With no CRLF anywhere, a CR is a space inside its line.
		expect(preflightObj(`f 1\r${tokens}\n`)).toEqual({ ok: false, reason: "tooLarge" })
		expect(preflightObj(`l ${tokens}\n`)).toEqual({ ok: false, reason: "tooLarge" })
		expect(preflightObj(`p ${tokens}\n`)).toEqual({ ok: false, reason: "tooLarge" })
		expect(objCounts("f 1 2 3\r\nf 1 2 3\r\n")).toEqual({ vertices: 0, corners: 6 })
		expect(objCounts("v 1 2 3\u00a0\nvv 1\n\u3000v 1\n")).toEqual({ vertices: 2, corners: 0 })
	})

	it("walks a binary FBX as FBXLoader reads it, counting the JS heap its arrays become", () => {
		const honest = fbxFile([{ name: "Geometry", properties: [doubleArray(1000, new Uint8Array(8000))] }])

		expect(fbxCosts(honest)?.heap).toBeGreaterThan(1000 * 8)
		expect(preflightFbx(honest)).toEqual({ ok: true })
		// A boolean array of type 'c' is one FBXLoader reads.
		expect(preflightFbx(fbxFile([{ name: "Flags", properties: [charArray([1, 0, 1])] }]))).toEqual({ ok: true })
		// A stored array declaring more than the file holds: FBXLoader's read would run past the end.
		expect(
			preflightFbx(fbxFile([{ name: "Geometry", properties: [doubleArray(1_000_000, new Uint8Array(8), { compressed: false })] }]))
		).toEqual({
			ok: false,
			reason: "malformed"
		})
		expect(preflightFbx(encode("; FBX 7.4.0 project file\n"))).toEqual({ ok: true })
	})

	it("finds an array hidden after a null record, nested or at the top level", () => {
		const huge = doubleArray(MODEL_MAX_HEAP_BYTES / 8, new Uint8Array(8))

		expect(
			preflightFbx(fbxFile([{ name: "Objects", properties: [], children: [null, { name: "Geometry", properties: [huge] }] }]))
		).toEqual({ ok: false, reason: "tooLarge" })
		expect(preflightFbx(fbxFile([{ name: "A", properties: [int32(1)] }, null, { name: "Geometry", properties: [huge] }]))).toEqual({
			ok: false,
			reason: "tooLarge"
		})
	})

	it("counts the face corners an FBX's polygon indices build, once more per blend shape", () => {
		// 1.1M indices fan into at most 3.3M corners: past the cap, from a few KB of zlib.
		const indices = (count: number) => ({ name: "PolygonVertexIndex", properties: [intArray(count)] })
		const geometry = (count: number, shape = false) => ({
			name: "Geometry",
			properties: [int32(1), string("Geometry::"), string(shape ? "Shape" : "Mesh")],
			children: [indices(count)]
		})

		expect(fbxCosts(fbxFile([{ name: "Objects", properties: [], children: [geometry(600_000)] }]))?.corners).toBe(1_800_000)
		expect(preflightFbx(fbxFile([{ name: "Objects", properties: [], children: [geometry(600_000)] }]))).toEqual({ ok: true })
		expect(preflightFbx(fbxFile([{ name: "Objects", properties: [], children: [geometry(1_100_000)] }]))).toEqual({
			ok: false,
			reason: "tooLarge"
		})
		// A blend shape builds the base geometry's buffers again.
		expect(preflightFbx(fbxFile([{ name: "Objects", properties: [], children: [geometry(600_000), geometry(10, true)] }]))).toEqual({
			ok: false,
			reason: "tooLarge"
		})
	})

	it("counts the numbers of an ASCII FBX's or USDA layer's text against the heap they become", () => {
		expect(textNumbers("Vertices: *6 { a: 0.5,-1,2e-3, 4 }")).toBe(5)
		expect(textNumbers("Kaydara, no numbers")).toBe(0)
		expect(preflightUsdaText(["point3f[] points = [(0, 0, 0), (1, 0, 0)]"])).toEqual({ ok: true })
		// A layer of numbers past the heap the arrays they become may take, counted across the layers.
		const layer = "1,".repeat(1 << 22)

		expect(preflightUsdaText(Array.from({ length: MODEL_MAX_HEAP_BYTES / 8 / (1 << 22) + 1 }, () => layer))).toEqual({
			ok: false,
			reason: "tooLarge"
		})
	})

	it("steps over a stored array by its element count, whatever its length field says", () => {
		const stored = doubleArray(10, new Uint8Array(80), { compressed: false, lengthField: 0 })
		const huge = doubleArray(MODEL_MAX_HEAP_BYTES / 8, new Uint8Array(8))

		expect(preflightFbx(fbxFile([{ name: "Geometry", properties: [stored, huge] }]))).toEqual({ ok: false, reason: "tooLarge" })
		expect(preflightFbx(fbxFile([{ name: "Geometry", properties: [stored, int32(5)] }]))).toEqual({ ok: true })
	})

	it("reads a KTX2's pixels from its header, its mip chain included", () => {
		const header = new Uint8Array(80)
		const view = new DataView(header.buffer)

		header.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])
		view.setUint32(20, 1024, true)
		view.setUint32(24, 512, true)
		view.setUint32(36, 6, true)
		view.setUint32(40, 1, true)

		expect(ktx2Pixels(header)).toBe(1024 * 512 * 6)

		// Levels to generate (0), or a chain: a third more.
		view.setUint32(40, 0, true)
		expect(ktx2Pixels(header)).toBe(Math.ceil((1024 * 512 * 6 * 4) / 3))
		expect(ktx2Pixels(new Uint8Array(80))).toBeNull()
	})

	it("refuses a zip that unpacks past the model cap in all, or too far in one entry", () => {
		const MIB = 1024 * 1024

		expect(MODEL_MAX_UNPACKED_BYTES).toBe(MODEL_MAX_BYTES)
		expect(preflightZip([{ compressed: MIB, uncompressed: 10 * MIB }])).toEqual({ ok: true })
		expect(preflightZip([{ compressed: MIB, uncompressed: 300 * MIB }])).toEqual({ ok: false, reason: "tooLarge" })
		expect(preflightZip(Array.from({ length: 2 }, () => ({ compressed: 60 * MIB, uncompressed: 65 * MIB })))).toEqual({
			ok: false,
			reason: "tooLarge"
		})
		// A tiny entry may compress far: a ratio counts only past 1 MiB.
		expect(preflightZip([{ compressed: 10, uncompressed: 100_000 }])).toEqual({ ok: true })
	})

	it("sizes a GIF by its first frame where it reaches past the logical screen", () => {
		const gif = new Uint8Array(40)
		const view = new DataView(gif.buffer)

		gif.set(new TextEncoder().encode("GIF89a"))
		view.setUint16(6, 1, true)
		view.setUint16(8, 1, true)
		gif[10] = 0
		// A graphic control extension, then the image descriptor at 13 + 8.
		gif.set([0x21, 0xf9, 0x04, 0, 0, 0, 0, 0], 13)
		gif[21] = 0x2c
		view.setUint16(22, 10, true)
		view.setUint16(24, 0, true)
		view.setUint16(26, 16384, true)
		view.setUint16(28, 16384, true)

		expect(gifDimensions(gif)).toEqual({ width: 16394, height: 16384 })
		expect(gifDimensions(new TextEncoder().encode("GIF89a"))).toBeNull()
	})

	it("sizes a texture within the side cap", () => {
		expect(textureSize(1024, 512, 4096)).toEqual({ width: 1024, height: 512 })
		expect(textureSize(8192, 4096, 4096)).toEqual({ width: 4096, height: 2048 })
		expect(textureSize(0, 10, 4096)).toBeNull()
	})

	it("estimates GPU memory from attributes, mipmapped textures and the framebuffer", () => {
		expect(gpuBytes({ attributes: 1000, textures: 3000, width: 10, height: 10, samples: 4 })).toBe(1000 + 4000 + 10 * 10 * 8 * 4)
	})

	it("knows its formats and which have a source to show", () => {
		expect(["stl", "obj", "gltf", "glb", "3mf", "fbx", "ply", "usdz"].map(modelFormat)).not.toContain(null)
		expect(modelFormat("dxf")).toBeNull()
		expect(isTextModel("obj", null)).toBe(true)
		expect(isTextModel("gltf", null)).toBe(true)
		expect(isTextModel("glb", null)).toBe(false)
		expect(isTextModel("stl", binaryStl(1))).toBe(false)
		expect(isTextModel("stl", encode("solid x\nendsolid x\n"))).toBe(true)
	})
})

describe("the ImageLoader shim", () => {
	it("decodes flipped, with straight alpha and no colour conversion, at the drawn size", () => {
		expect(bitmapOptions(null)).toEqual({ imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" })
		expect(bitmapOptions({ width: 64, height: 32 })).toEqual({
			imageOrientation: "flipY",
			premultiplyAlpha: "none",
			colorSpaceConversion: "none",
			resizeWidth: 64,
			resizeHeight: 32,
			resizeQuality: "high"
		})
	})
})

describe("the viewer's references and animations", () => {
	it("keeps one outcome per path and lists the ones not loaded, decoded", () => {
		const outcomes = referenceOutcomes([
			{ path: "mesh.mtl", status: "found" },
			{ path: "tex%20a.png", status: "missing" },
			{ path: "tex%20a.png", status: "found" },
			{ path: "member.png", status: "unreadable" },
			{ path: "../up.png", status: "refused" }
		])

		expect(outcomes).toHaveLength(4)
		expect(referenceSummary(outcomes)).toEqual({ missing: ["tex a.png"], unreadable: ["member.png"], refused: ["../up.png"] })
	})

	it("keys repeated and empty clip names apart", () => {
		const entries = animationEntries(["Walk", "", "Walk", ""])

		expect(new Set(entries.map(entry => entry.key)).size).toBe(4)
		expect(entries.map(entry => entry.name)).toEqual(["Walk", null, "Walk", null])
		expect(entries.map(entry => entry.clip)).toEqual([0, 1, 2, 3])
	})
})

describe("referenceServer", () => {
	function resolver(size: number) {
		const reads = vi.fn(() => Promise.resolve(new Uint8Array(size)))
		const resolve = vi.fn((path: string): Promise<ResolvedReference> =>
			Promise.resolve(path.includes("missing") ? { status: "missing" } : { status: "found", size, read: reads })
		)

		return { resolve, reads }
	}

	it("looks up and reads a file once however often, and however the model spells it, it is named", async () => {
		const { resolve, reads } = resolver(10)
		const outcomes: ReferenceOutcome[] = []
		const serve = referenceServer(resolve, 1000, new AbortController().signal, outcome => outcomes.push(outcome))

		const blobs = await Promise.all(["tex/Wood.png", "tex/wood.png", "./tex/WOOD.png", "tex%2Fwood.png"].map(serve))

		expect(blobs.every(blob => blob instanceof Blob)).toBe(true)
		expect(resolve).toHaveBeenCalledOnce()
		expect(reads).toHaveBeenCalledOnce()
		expect(outcomes).toHaveLength(1)
	})

	it("holds references read together against the cap, and stops looking past the distinct-file limit", async () => {
		const { resolve, reads } = resolver(600)
		const outcomes: ReferenceOutcome[] = []
		const serve = referenceServer(resolve, 1000, new AbortController().signal, outcome => outcomes.push(outcome))

		const [a, b] = await Promise.all([serve("a.png"), serve("b.png")])

		expect([a, b].filter(blob => blob !== null)).toHaveLength(1)
		expect(reads).toHaveBeenCalledOnce()

		const many = referenceServer(resolver(0).resolve, 1000, new AbortController().signal, outcome => outcomes.push(outcome))

		await Promise.all(Array.from({ length: MAX_REFERENCES + 5 }, (_, i) => many(`missing-${String(i)}.png`)))

		expect(outcomes.filter(outcome => outcome.status === "refused" && outcome.path.startsWith("missing-"))).toHaveLength(5)
	})
})
