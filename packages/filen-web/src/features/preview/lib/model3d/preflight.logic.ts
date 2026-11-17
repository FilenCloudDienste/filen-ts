import { Unzlib } from "fflate"
import { zipFits, type ZipEntrySize } from "@/features/preview/lib/zipBudget.logic"

// Checks a model file before a loader allocates anything for it: counts read from headers or a byte scan (a binary
// STL's triangle count, an OBJ's vertex and face lines, a PLY's element counts, a glTF's accessor and meshopt counts, a
// binary FBX's arrays), a zip's declared sizes, a texture's dimensions; and after parsing, the GPU memory the scene
// would take.

// A model and every file it references together.
export const MODEL_MAX_BYTES = 128 * 1024 * 1024
export const MODEL_MAX_TRIANGLES = 10_000_000
export const MODEL_MAX_VERTICES = 30_000_000
// OBJLoader copies every face corner into plain JS arrays (a position, a normal and a uv each), about eight times a
// typed array's footprint: an OBJ gets a tenth of the triangles.
export const OBJ_MAX_TRIANGLES = 1_000_000
// What a 3MF or USDZ may unpack to in all (the model cap), each entry also within the zip ratio.
export const MODEL_MAX_UNPACKED_BYTES = MODEL_MAX_BYTES
// The arrays a binary FBX declares, inflated, together.
export const FBX_MAX_ARRAY_BYTES = 512 * 1024 * 1024
// What a parse may allocate in typed arrays: one, and all of them (allocationBudget.ts). A USDZ's buffers are held to
// the unpacked cap each.
export const PARSE_MAX_ALLOCATION = 512 * 1024 * 1024
export const PARSE_MAX_TOTAL = 1024 * 1024 * 1024
// The GPU memory a scene may take: attributes, textures with mipmaps, the framebuffer.
export const MODEL_MAX_GPU_BYTES = 768 * 1024 * 1024
// A texture's decoded RGBA bytes per pixel before resizing (W2's pixel budget figure).
export const TEXTURE_BPP = 4

// The 3D viewer's formats by extension: the one list the category table and the viewer read.
export const MODEL_FORMATS = ["stl", "obj", "gltf", "glb", "3mf", "fbx", "ply", "usdz"] as const

export type ModelFormat = (typeof MODEL_FORMATS)[number]

export type Preflight = { readonly ok: true } | { readonly ok: false; readonly reason: "tooLarge" | "malformed" }

const OK: Preflight = { ok: true }

const SOLID = [0x73, 0x6f, 0x6c, 0x69, 0x64]

// Read as STLLoader reads it: binary when the size matches the count in its header, or when "solid" does not open it
// within its first bytes (after a byte order mark); else ASCII.
export function isBinaryStl(bytes: Uint8Array): boolean {
	if (bytes.length >= 84 && 84 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true) * 50 === bytes.length)
		return true

	for (let offset = 0; offset < 5; offset++) {
		if (SOLID.every((byte, i) => bytes[offset + i] === byte)) return false
	}

	return true
}

// A binary STL's declared triangle count: an 80-byte header, the count, then 50 bytes per triangle. Null for ASCII.
export function binaryStlTriangles(bytes: Uint8Array): number | null {
	if (!isBinaryStl(bytes)) return null

	return bytes.length < 84 ? 0 : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true)
}

export function preflightStl(bytes: Uint8Array): Preflight {
	const triangles = binaryStlTriangles(bytes)

	// ASCII: each facet is at least ~100 bytes, so the text cap bounds it already.
	if (triangles === null) return OK
	// The loader sizes its arrays by the declared count: one the bytes cannot hold is refused before it does.
	if (bytes.length < 84 || 84 + triangles * 50 > bytes.length) return { ok: false, reason: "malformed" }

	return triangles > MODEL_MAX_TRIANGLES ? { ok: false, reason: "tooLarge" } : OK
}

function isLineSpace(byte: number | undefined): boolean {
	return byte === 0x20 || byte === 0x09
}

// An OBJ's vertex lines and the triangles its faces fan into (a face of n corners is n − 2), by one scan over the
// bytes: what OBJLoader would copy, counted before it parses.
export function objCounts(bytes: Uint8Array): { vertices: number; triangles: number } {
	let vertices = 0
	let triangles = 0
	let at = 0

	while (at < bytes.length) {
		while (isLineSpace(bytes[at])) at++

		const first = bytes[at]
		const second = bytes[at + 1]

		if (first === 0x76 && isLineSpace(second)) vertices++

		if (first === 0x66 && isLineSpace(second)) {
			let corners = 0

			at += 1

			while (at < bytes.length && bytes[at] !== 0x0a && bytes[at] !== 0x0d) {
				while (isLineSpace(bytes[at])) at++

				if (at >= bytes.length || bytes[at] === 0x0a || bytes[at] === 0x0d) break

				corners++

				while (at < bytes.length && !isLineSpace(bytes[at]) && bytes[at] !== 0x0a && bytes[at] !== 0x0d) at++
			}

			triangles += Math.max(0, corners - 2)
		}

		while (at < bytes.length && bytes[at] !== 0x0a) at++

		at++
	}

	return { vertices, triangles }
}

export function preflightObj(bytes: Uint8Array): Preflight {
	const counts = objCounts(bytes)

	return counts.vertices > MODEL_MAX_VERTICES || counts.triangles > OBJ_MAX_TRIANGLES ? { ok: false, reason: "tooLarge" } : OK
}

// A PLY header's element counts ("element vertex N", "element face N"), read up to "end_header".
export function plyCounts(bytes: Uint8Array): { vertices: number; faces: number } | null {
	const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)))
	const end = head.indexOf("end_header")

	if (!head.startsWith("ply") || end === -1) return null

	let vertices = 0
	let faces = 0

	for (const line of head.slice(0, end).split(/\r?\n/)) {
		const [keyword, element, count] = line.trim().split(/\s+/)

		if (keyword !== "element" || count === undefined) continue

		const value = Number(count)

		if (!Number.isSafeInteger(value) || value < 0) return null
		if (element === "vertex") vertices = value
		if (element === "face") faces = value
	}

	return { vertices, faces }
}

export function preflightPly(bytes: Uint8Array): Preflight {
	const counts = plyCounts(bytes)

	if (counts === null) return { ok: false, reason: "malformed" }

	return counts.vertices > MODEL_MAX_VERTICES || counts.faces > MODEL_MAX_TRIANGLES ? { ok: false, reason: "tooLarge" } : OK
}

// A glTF's JSON chunk (a .glb's first chunk, or the whole .gltf).
export function gltfJson(bytes: Uint8Array, binary: boolean): unknown {
	const decoder = new TextDecoder()

	if (!binary) return JSON.parse(decoder.decode(bytes))

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB")

	const length = view.getUint32(12, true)

	if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > bytes.length) throw new Error("no JSON chunk")

	return JSON.parse(decoder.decode(bytes.subarray(20, 20 + length)))
}

// The bytes the meshopt extension (EXT_ or KHR_meshopt_compression) has GLTFLoader allocate for its bufferViews, from
// their declared counts and strides.
export function gltfMeshoptBytes(json: unknown): number {
	const views = typeof json === "object" && json !== null ? (json as { bufferViews?: unknown }).bufferViews : undefined

	if (!Array.isArray(views)) return 0

	let total = 0

	for (const view of views as unknown[]) {
		const extensions = typeof view === "object" && view !== null ? (view as { extensions?: unknown }).extensions : undefined

		if (typeof extensions !== "object" || extensions === null) continue

		for (const name of ["EXT_meshopt_compression", "KHR_meshopt_compression"]) {
			const definition = (extensions as Record<string, unknown>)[name]

			if (typeof definition !== "object" || definition === null) continue

			const { count, byteStride } = definition as { count?: unknown; byteStride?: unknown }

			total += typeof count === "number" && typeof byteStride === "number" && count > 0 && byteStride > 0 ? count * byteStride : 0
		}
	}

	return total
}

// The elements every accessor declares, summed: what the loader would allocate for vertices and indices.
export function gltfElements(json: unknown): number {
	const accessors = typeof json === "object" && json !== null ? (json as { accessors?: unknown }).accessors : undefined

	if (!Array.isArray(accessors)) return 0

	let total = 0

	for (const accessor of accessors as unknown[]) {
		const count = typeof accessor === "object" && accessor !== null ? (accessor as { count?: unknown }).count : undefined

		total += typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0
	}

	return total
}

export function preflightGltf(bytes: Uint8Array, binary: boolean): Preflight {
	let json: unknown

	try {
		json = gltfJson(bytes, binary)
	} catch {
		return { ok: false, reason: "malformed" }
	}

	return gltfElements(json) > MODEL_MAX_VERTICES * 3 || gltfMeshoptBytes(json) > MODEL_MAX_GPU_BYTES
		? { ok: false, reason: "tooLarge" }
		: OK
}

// A 3MF's or USDZ's central directory: within the unpacked cap in all, each entry within the zip ratio.
export function preflightZip(entries: readonly ZipEntrySize[]): Preflight {
	return zipFits(entries, MODEL_MAX_UNPACKED_BYTES) ? OK : { ok: false, reason: "tooLarge" }
}

const FBX_MAGIC = "Kaydara FBX Binary  \0"
// Element sizes of the array property types.
const FBX_ARRAY_SIZES: Readonly<Record<string, number>> = { f: 4, d: 8, l: 8, i: 4, b: 1 }
const FBX_SCALAR_SIZES: Readonly<Record<string, number>> = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 }
const FBX_MAX_DEPTH = 64

export interface FbxArray {
	// The zlib stream, and the bytes it must inflate to.
	readonly offset: number
	readonly length: number
	readonly inflated: number
}

export function isBinaryFbx(bytes: Uint8Array): boolean {
	return bytes.length >= 27 && new TextDecoder("latin1").decode(bytes.subarray(0, FBX_MAGIC.length)) === FBX_MAGIC
}

// A binary FBX's arrays, walked through its node records without reading them: what they inflate to together, and
// each compressed one. Null when the records do not hold together.
export function fbxArrays(bytes: Uint8Array): { total: number; compressed: FbxArray[] } | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const version = view.getUint32(23, true)
	const wide = version >= 7500
	const compressed: FbxArray[] = []
	let total = 0

	const word = (at: number): number =>
		wide ? view.getUint32(at, true) + view.getUint32(at + 4, true) * 0x1_0000_0000 : view.getUint32(at, true)
	const header = wide ? 25 : 13

	// The records from `start` until a null record or `end`; false when one does not fit.
	const walk = (start: number, end: number, depth: number): boolean => {
		let at = start

		if (depth > FBX_MAX_DEPTH) return false

		while (at + header <= end) {
			const endOffset = word(at)
			const properties = word(at + (wide ? 8 : 4))
			const nameLength = view.getUint8(at + (wide ? 24 : 12))

			// The null record closing a list.
			if (endOffset === 0) return true
			if (endOffset <= at || endOffset > end) return false

			let cursor = at + header + nameLength

			for (let p = 0; p < properties; p++) {
				if (cursor + 1 > endOffset) return false

				const type = String.fromCharCode(view.getUint8(cursor))

				cursor++

				const scalar = FBX_SCALAR_SIZES[type]
				const element = FBX_ARRAY_SIZES[type]

				if (scalar !== undefined) {
					cursor += scalar
				} else if (element !== undefined) {
					if (cursor + 12 > endOffset) return false

					const count = view.getUint32(cursor, true)
					const encoding = view.getUint32(cursor + 4, true)
					const length = view.getUint32(cursor + 8, true)

					cursor += 12
					total += count * element

					if (encoding === 1) compressed.push({ offset: cursor, length, inflated: count * element })

					cursor += length
				} else if (type === "S" || type === "R") {
					if (cursor + 4 > endOffset) return false

					cursor += 4 + view.getUint32(cursor, true)
				} else {
					return false
				}
			}

			if (cursor > endOffset) return false
			if (cursor < endOffset && !walk(cursor, endOffset, depth + 1)) return false

			at = endOffset
		}

		return true
	}

	return walk(27, bytes.length, 0) ? { total, compressed } : null
}

// Input fed to the inflater at a time: deflate expands at most about 1032:1, so one step yields a few MiB at most.
const INFLATE_STEP = 4096

// Whether a zlib stream inflates to no more than `limit` bytes, counted as it inflates and stopped once past it ("over"),
// or does not inflate ("corrupt"): the loader's own inflate is unbounded, so its arrays are checked before it runs.
export function inflatesWithin(stream: Uint8Array, limit: number): "ok" | "over" | "corrupt" {
	const state = { produced: 0, over: false }
	const inflater = new Unzlib(chunk => {
		state.produced += chunk.length
		state.over ||= state.produced > limit
	})

	try {
		for (let at = 0; at < stream.length && !state.over; at += INFLATE_STEP) {
			inflater.push(stream.subarray(at, at + INFLATE_STEP), at + INFLATE_STEP >= stream.length)
		}
	} catch {
		return state.over ? "over" : "corrupt"
	}

	return state.over ? "over" : "ok"
}

export function preflightFbx(bytes: Uint8Array): Preflight {
	// ASCII FBX: its arrays are its text, bounded by the cap.
	if (!isBinaryFbx(bytes)) return OK

	const arrays = fbxArrays(bytes)

	if (arrays === null) return { ok: false, reason: "malformed" }
	if (arrays.total > FBX_MAX_ARRAY_BYTES) return { ok: false, reason: "tooLarge" }

	for (const array of arrays.compressed) {
		if (array.offset + array.length > bytes.length) return { ok: false, reason: "malformed" }
		const inflated = inflatesWithin(bytes.subarray(array.offset, array.offset + array.length), array.inflated)

		if (inflated !== "ok") return { ok: false, reason: inflated === "over" ? "tooLarge" : "malformed" }
	}

	return OK
}

// How large a texture of `width` × `height` is drawn: within `maxSide` a side. Null for no size.
export function textureSize(width: number, height: number, maxSide: number): { width: number; height: number } | null {
	if (width <= 0 || height <= 0) return null

	const scale = Math.min(1, maxSide / Math.max(width, height))

	return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}

// A KTX2 texture's pixels at its base level, every layer and face, from its header; null when it is no KTX2.
export function ktx2Pixels(bytes: Uint8Array): number | null {
	const identifier = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]

	if (bytes.length < 44 || !identifier.every((byte, i) => bytes[i] === byte)) return null

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const side = (at: number): number => Math.max(1, view.getUint32(at, true))

	return view.getUint32(20, true) * side(24) * side(28) * side(32) * side(36)
}

export interface GpuFootprint {
	// Bytes of every geometry attribute and index.
	readonly attributes: number
	// RGBA bytes of every texture at its drawn size.
	readonly textures: number
	readonly width: number
	readonly height: number
	readonly samples: number
}

// Attributes, textures with their mipmap chain (× 4/3), and the framebuffer (colour and depth, times the samples).
export function gpuBytes(footprint: GpuFootprint): number {
	const framebuffer = footprint.width * footprint.height * 8 * Math.max(1, footprint.samples)

	return footprint.attributes + (footprint.textures * 4) / 3 + framebuffer
}

export function modelFormat(extension: string): ModelFormat | null {
	return (MODEL_FORMATS as readonly string[]).includes(extension) ? (extension as ModelFormat) : null
}

// Formats read as text, whose source is offered.
export function isTextModel(format: ModelFormat, bytes: Uint8Array | null): boolean {
	if (format === "obj" || format === "gltf") return true
	if (format === "stl" || format === "ply")
		return bytes !== null && (format === "stl" ? binaryStlTriangles(bytes) === null : isAsciiPly(bytes))

	return false
}

function isAsciiPly(bytes: Uint8Array): boolean {
	return new TextDecoder("latin1").decode(bytes.subarray(0, 64)).includes("format ascii")
}
