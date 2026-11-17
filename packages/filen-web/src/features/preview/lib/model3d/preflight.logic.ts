import { zipFits, type ZipEntrySize } from "@/features/preview/lib/zipBudget.logic"

// Checks a model file before a loader allocates anything for it: counts read from headers or a byte scan (a binary
// STL's triangle count, an OBJ's vertex and face lines, a PLY's element counts, a glTF's accessor and meshopt counts, a
// binary FBX's arrays), a zip's declared sizes, a texture's dimensions; and after parsing, the GPU memory the scene
// would take.

// A model and every file it references together.
export const MODEL_MAX_BYTES = 128 * 1024 * 1024
export const MODEL_MAX_TRIANGLES = 10_000_000
export const MODEL_MAX_VERTICES = 30_000_000
// OBJLoader keeps every vertex and copies every face, line and point corner into plain JS arrays (a position, a normal,
// a uv and a colour each), about eight times a typed array's footprint: an OBJ gets a tenth of the corners and vertices.
export const OBJ_MAX_CORNERS = 3_000_000
export const OBJ_MAX_VERTICES = 3_000_000
// What a 3MF or USDZ may unpack to in all (the model cap), each entry also within the zip ratio.
export const MODEL_MAX_UNPACKED_BYTES = MODEL_MAX_BYTES
// The JS heap a parse may build in plain arrays and objects: a binary FBX's (FBXLoader turns every array into a plain JS
// array, 8 bytes an element, a boolean as much as a double, every node into an object and every property into a
// value), and the numbers of an ASCII FBX's or USDA layer's text.
export const MODEL_MAX_HEAP_BYTES = 512 * 1024 * 1024
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

// JavaScript's \s, which OBJLoader splits its tokens on.
function isSpace(code: number): boolean {
	return (
		code === 0x20 ||
		(code >= 0x09 && code <= 0x0d) ||
		code === 0xa0 ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000 ||
		code === 0xfeff
	)
}

// An OBJ's vertices and the corners its faces (fanned into triangles: n − 2 of them, three corners each), lines and
// points copy, counted on OBJLoader's own line model without building its strings: CRLF reads as LF where the text has
// any, a backslash before a line feed joins the next line, lines split on LF alone (a lone CR is a space), a line's
// first character picks what it is, and its tokens split on any whitespace.
export function objCounts(text: string): { vertices: number; corners: number } {
	const crlf = text.includes("\r\n")
	let vertices = 0
	let corners = 0
	// The current line: its first character, its first token so far (for "v"), and its tokens after the first character.
	let first = -1
	let head = ""
	let tokens = 0
	let inToken = false
	let headDone = false

	const end = (): void => {
		if (first === 0x76 && head === "v") vertices++
		else if (first === 0x66) corners += 3 * Math.max(0, tokens - 2)
		else if (first === 0x6c || first === 0x70) corners += tokens

		first = -1
		head = ""
		tokens = 0
		inToken = false
		headDone = false
	}

	for (let at = 0; at < text.length; at++) {
		let code = text.charCodeAt(at)

		if (code === 0x0d && crlf && text.charCodeAt(at + 1) === 0x0a) {
			at++
			code = 0x0a
		}

		if (code === 0x5c) {
			const next = text.charCodeAt(at + 1)

			// A continuation: the backslash and its line feed vanish.
			if (next === 0x0a || (crlf && next === 0x0d && text.charCodeAt(at + 2) === 0x0a)) {
				at += next === 0x0a ? 1 : 2

				continue
			}
		}

		if (code === 0x0a) {
			end()

			continue
		}

		if (first === -1) {
			// Leading whitespace is trimmed; the first other character is the line's kind, its tokens counted after it.
			if (isSpace(code)) continue

			first = code
			head = String.fromCharCode(code)

			continue
		}

		const space = isSpace(code)

		if (!headDone) {
			if (space) headDone = true
			else if (head.length < 2) head += String.fromCharCode(code)
			else head = "vv"
		}

		if (!space && !inToken) tokens++

		inToken = !space
	}

	end()

	return { vertices, corners }
}

export function preflightObj(text: string): Preflight {
	const counts = objCounts(text)

	return counts.vertices > OBJ_MAX_VERTICES || counts.corners > OBJ_MAX_CORNERS ? { ok: false, reason: "tooLarge" } : OK
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

const GLTF_COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }
const GLTF_COMPONENT_BYTES: Readonly<Record<number, number>> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }

// The bytes every accessor's elements take (count × components × component size): what GLTFLoader allocates for an
// accessor with no buffer view, and what its attributes hold.
export function gltfAccessorBytes(json: unknown): number {
	const accessors = typeof json === "object" && json !== null ? (json as { accessors?: unknown }).accessors : undefined

	if (!Array.isArray(accessors)) return 0

	let total = 0

	for (const accessor of accessors as unknown[]) {
		if (typeof accessor !== "object" || accessor === null) continue

		const { count, type, componentType } = accessor as { count?: unknown; type?: unknown; componentType?: unknown }
		const components = typeof type === "string" ? (GLTF_COMPONENTS[type] ?? 16) : 16
		const bytes = typeof componentType === "number" ? (GLTF_COMPONENT_BYTES[componentType] ?? 4) : 4

		total += typeof count === "number" && Number.isFinite(count) && count > 0 ? count * components * bytes : 0
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
// Element sizes of the array property types ('c' is a boolean array as 'b' is).
const FBX_ARRAY_SIZES: Readonly<Record<string, number>> = { b: 1, c: 1, d: 8, f: 4, i: 4, l: 8 }
const FBX_SCALAR_SIZES: Readonly<Record<string, number>> = { C: 1, D: 8, F: 4, I: 4, L: 8, Y: 2 }
// Records nested deeper than this are refused (FBXLoader recurses).
const FBX_MAX_DEPTH = 1024
// What the parse builds in the JS heap: a plain array's element, a node object, a property value.
const JS_ELEMENT_BYTES = 8
const JS_NODE_BYTES = 256
const JS_PROPERTY_BYTES = 16

export function isBinaryFbx(bytes: Uint8Array): boolean {
	return bytes.length >= 27 && new TextDecoder("latin1").decode(bytes.subarray(0, FBX_MAGIC.length)) === FBX_MAGIC
}

class FbxEnd extends Error {}

// A binary FBX walked exactly as FBXLoader's BinaryParser reads it, reading no array: top-level records until its end of
// content (the footer's 160 bytes and alignment); a record's properties, then its children while its end offset lies
// ahead (null records included, and records past them); an uncompressed array taking its element count's bytes
// whatever its length field says, a compressed one its compressed length (which the patched loader inflates into its
// declared size, never past it). Returns the JS heap the parse would build, and the face corners its geometry builds
// (every PolygonVertexIndex entry fans into at most three corners, rebuilt once per blend-shape geometry); null when the
// bytes would not parse.
export function fbxCosts(bytes: Uint8Array): { heap: number; corners: number } | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const size = bytes.length
	let offset = 23
	let heap = 0
	let polygonIndices = 0
	let shapes = 0

	const need = (count: number): void => {
		if (count < 0 || offset + count > size) throw new FbxEnd()
	}
	const uint8 = (): number => {
		need(1)

		return view.getUint8(offset++)
	}
	const uint32 = (): number => {
		need(4)

		const value = view.getUint32(offset, true)

		offset += 4

		return value
	}
	const uint64 = (): number => {
		const low = uint32()

		return uint32() * 0x1_0000_0000 + low
	}
	const skip = (count: number): void => {
		need(count)
		offset += count
	}

	const version = uint32()

	if (version < 6400) return null

	const wide = version >= 7500
	const endOfContent = (): boolean => (size % 16 === 0 ? ((offset + 160 + 16) & ~0xf) >= size : offset + 160 + 16 >= size)

	const node = (depth: number): void => {
		if (depth > FBX_MAX_DEPTH) throw new FbxEnd()

		const endOffset = wide ? uint64() : uint32()
		const properties = wide ? uint64() : uint32()

		if (wide) uint64()
		else uint32()

		const nameLength = uint8()
		const name = new TextDecoder("latin1").decode(bytes.subarray(offset, offset + nameLength))

		skip(nameLength)
		heap += JS_NODE_BYTES

		if (endOffset === 0) return

		for (let p = 0; p < properties; p++) {
			const type = String.fromCharCode(uint8())
			const scalar = FBX_SCALAR_SIZES[type]
			const element = FBX_ARRAY_SIZES[type]

			heap += JS_PROPERTY_BYTES

			if (scalar !== undefined) {
				skip(scalar)
			} else if (type === "R" || type === "S") {
				const length = uint32()

				// A blend shape is a Geometry whose type is "Shape": FBXLoader builds the base geometry's buffers again for it.
				if (
					type === "S" &&
					name === "Geometry" &&
					length === 5 &&
					new TextDecoder("latin1").decode(bytes.subarray(offset, offset + 5)) === "Shape"
				)
					shapes++

				skip(length)
				heap += length
			} else if (element !== undefined) {
				const count = uint32()
				const encoding = uint32()
				const compressed = uint32()

				skip(encoding === 0 ? count * element : compressed)
				heap += count * JS_ELEMENT_BYTES + (encoding === 0 ? 0 : count * element)

				if (name === "PolygonVertexIndex") polygonIndices += count
			} else {
				throw new FbxEnd()
			}

			if (heap > MODEL_MAX_HEAP_BYTES) return
		}

		while (endOffset > offset && heap <= MODEL_MAX_HEAP_BYTES) node(depth + 1)
	}

	try {
		while (!endOfContent() && heap <= MODEL_MAX_HEAP_BYTES) node(0)
	} catch (error) {
		if (error instanceof FbxEnd || error instanceof RangeError) return null

		throw error
	}

	return { heap, corners: 3 * polygonIndices * (1 + shapes) }
}

// An ASCII FBX's numbers, each a JS value of the arrays FBXLoader builds from its text: counted, not parsed.
export function textNumbers(text: string): number {
	let count = 0
	let inNumber = false

	for (let at = 0; at < text.length; at++) {
		const code = text.charCodeAt(at)
		const digit = code >= 0x30 && code <= 0x39

		if (digit && !inNumber) count++

		inNumber = digit || (inNumber && (code === 0x2e || code === 0x65 || code === 0x45 || code === 0x2d || code === 0x2b))
	}

	return count
}

// A USDZ's text layers (.usda): their numbers against the heap they become.
export function preflightUsdaText(texts: readonly string[]): Preflight {
	let numbers = 0

	for (const text of texts) numbers += textNumbers(text)

	return numbers * JS_ELEMENT_BYTES > MODEL_MAX_HEAP_BYTES ? { ok: false, reason: "tooLarge" } : OK
}

export function preflightFbx(bytes: Uint8Array): Preflight {
	// ASCII FBX: every number of its text a value of an array FBXLoader builds, against the same heap.
	if (!isBinaryFbx(bytes)) {
		return textNumbers(new TextDecoder().decode(bytes)) * JS_ELEMENT_BYTES > MODEL_MAX_HEAP_BYTES
			? { ok: false, reason: "tooLarge" }
			: OK
	}

	const costs = fbxCosts(bytes)

	if (costs === null) return { ok: false, reason: "malformed" }

	return costs.heap > MODEL_MAX_HEAP_BYTES || costs.corners > OBJ_MAX_CORNERS ? { ok: false, reason: "tooLarge" } : OK
}

// How large a texture of `width` × `height` is drawn: within `maxSide` a side. Null for no size.
export function textureSize(width: number, height: number, maxSide: number): { width: number; height: number } | null {
	if (width <= 0 || height <= 0) return null

	const scale = Math.min(1, maxSide / Math.max(width, height))

	return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}

// A KTX2 texture's pixels, every layer and face, its mip chain included (a third more) when it has one or asks for one
// to be generated (levelCount 0); null when it is no KTX2.
export function ktx2Pixels(bytes: Uint8Array): number | null {
	const identifier = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]

	if (bytes.length < 44 || !identifier.every((byte, i) => bytes[i] === byte)) return null

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const side = (at: number): number => Math.max(1, view.getUint32(at, true))
	const base = view.getUint32(20, true) * side(24) * side(28) * side(32) * side(36)

	return view.getUint32(40, true) === 1 ? base : Math.ceil((base * 4) / 3)
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
