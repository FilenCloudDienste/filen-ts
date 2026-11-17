// Checks a model file before a loader allocates anything for it: counts read from headers (a binary STL's triangle
// count, a PLY's element counts, a glTF's accessor counts), a zip's declared sizes, a texture's dimensions; and after
// parsing, the GPU memory the scene would take.

// A model and every file it references together.
export const MODEL_MAX_BYTES = 128 * 1024 * 1024
export const MODEL_MAX_TRIANGLES = 10_000_000
export const MODEL_MAX_VERTICES = 30_000_000
// What a 3MF or USDZ may unpack to, and how far one entry may expand.
export const MODEL_MAX_UNPACKED_BYTES = 512 * 1024 * 1024
export const MODEL_MAX_RATIO = 200
// The GPU memory a scene may take: attributes, textures with mipmaps, the framebuffer.
export const MODEL_MAX_GPU_BYTES = 768 * 1024 * 1024
// A texture's decoded RGBA bytes per pixel before resizing (W2's pixel budget figure).
export const TEXTURE_BPP = 4

export type ModelFormat = "stl" | "obj" | "gltf" | "glb" | "3mf" | "fbx" | "ply" | "usdz"

export type Preflight = { readonly ok: true } | { readonly ok: false; readonly reason: "tooLarge" | "malformed" }

const OK: Preflight = { ok: true }

// A binary STL: an 80-byte header, a triangle count, then 50 bytes per triangle. Anything else is ASCII.
export function binaryStlTriangles(bytes: Uint8Array): number | null {
	if (bytes.length < 84) return null

	const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true)

	return 84 + count * 50 === bytes.length ? count : null
}

export function preflightStl(bytes: Uint8Array): Preflight {
	const triangles = binaryStlTriangles(bytes)

	if (triangles !== null) return triangles > MODEL_MAX_TRIANGLES ? { ok: false, reason: "tooLarge" } : OK

	// ASCII: each facet is at least ~100 bytes, so the text cap bounds it already.
	return OK
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

	return gltfElements(json) > MODEL_MAX_VERTICES * 3 ? { ok: false, reason: "tooLarge" } : OK
}

export interface ZipEntrySize {
	readonly compressed: number
	readonly uncompressed: number
}

// A 3MF's or USDZ's central directory: what it unpacks to in all, and how far one entry expands.
export function preflightZip(entries: readonly ZipEntrySize[]): Preflight {
	let total = 0

	for (const entry of entries) {
		total += entry.uncompressed

		if (entry.uncompressed > Math.max(entry.compressed, 1) * MODEL_MAX_RATIO && entry.uncompressed > 1024 * 1024) {
			return { ok: false, reason: "tooLarge" }
		}
	}

	return total > MODEL_MAX_UNPACKED_BYTES ? { ok: false, reason: "tooLarge" } : OK
}

// How large a texture of `width` × `height` is drawn: within `maxSide` a side, and within the pixels the budget has
// left. Null when it does not fit even scaled to one pixel's worth of the budget (skipped).
export function textureSize(width: number, height: number, maxSide: number, pixelsLeft: number): { width: number; height: number } | null {
	if (width <= 0 || height <= 0 || pixelsLeft < 1) return null

	const side = Math.min(1, maxSide / Math.max(width, height))
	const budget = Math.min(1, Math.sqrt(pixelsLeft / (width * height)))
	const scale = Math.min(side, budget)

	return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
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
	switch (extension) {
		case "stl":
		case "obj":
		case "gltf":
		case "glb":
		case "3mf":
		case "fbx":
		case "ply":
		case "usdz":
			return extension
		default:
			return null
	}
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
