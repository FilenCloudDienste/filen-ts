import { describe, expect, it } from "vitest"
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
	MODEL_MAX_TRIANGLES,
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
import { animationEntries, referenceOutcomes, referenceSummary } from "@/features/preview/components/model3dViewer.logic"

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
		// The size must match the count, else it is ASCII.
		expect(binaryStlTriangles(binaryStl(3, 4))).toBeNull()
		expect(binaryStlTriangles(encode("solid cube\nendsolid cube\n"))).toBeNull()
		expect(preflightStl(binaryStl(1))).toEqual({ ok: true })

		const huge = new Uint8Array(84)

		new DataView(huge.buffer).setUint32(80, MODEL_MAX_TRIANGLES + 1, true)
		// A header declaring more than the bytes hold is ASCII by size; a matching one above the limit is refused.
		expect(preflightStl(huge)).toEqual({ ok: true })
		expect(binaryStlTriangles(huge)).toBeNull()
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

	it("refuses a zip that unpacks too far, in all or in one entry", () => {
		const MIB = 1024 * 1024

		expect(preflightZip([{ compressed: MIB, uncompressed: 10 * MIB }])).toEqual({ ok: true })
		expect(preflightZip([{ compressed: MIB, uncompressed: 300 * MIB }])).toEqual({ ok: false, reason: "tooLarge" })
		expect(preflightZip(Array.from({ length: 6 }, () => ({ compressed: 90 * MIB, uncompressed: 100 * MIB })))).toEqual({
			ok: false,
			reason: "tooLarge"
		})
		// A tiny entry may compress far: a ratio counts only past 1 MiB.
		expect(preflightZip([{ compressed: 10, uncompressed: 100_000 }])).toEqual({ ok: true })
	})

	it("sizes a texture within the side cap and the pixels left, and skips one that cannot fit", () => {
		expect(textureSize(1024, 512, 4096, 1e9)).toEqual({ width: 1024, height: 512 })
		expect(textureSize(8192, 4096, 4096, 1e9)).toEqual({ width: 4096, height: 2048 })
		expect(textureSize(2000, 2000, 4096, 1_000_000)).toEqual({ width: 1000, height: 1000 })
		expect(textureSize(2000, 2000, 4096, 0)).toBeNull()
		expect(textureSize(0, 10, 4096, 1e9)).toBeNull()
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
