import { log } from "@/lib/log"
import { fitWithin, encodeCanvasThumb } from "@/features/drive/lib/thumbGenerators.logic"

// Pure decode (HEIC/HEIF bytes -> RGBA) + encode (RGBA -> JPEG Blob) logic, dependency-injected so
// runHeicTransform below runs in node against a fake decoder (see heicCodec.test.ts) with no WASM and
// no OffscreenCanvas involved. heic.worker.ts is the only real caller: browsers can't decode HEIC/HEIF
// natively (preview.logic.ts's needsImageTransform), and libheif's decode is a synchronous embind call
// — running it in place would freeze the tab for as long as a multi-megapixel photo takes to decode.
// imageViewer.tsx never imports this file directly; heicTransform.ts is its entry point and owns
// getting bytes to that worker and a Blob back.

// Matches the old web app's HEIC->JPEG quality. That app reaches JPEG output via a WebP-first path
// (browser-native encode) with JPEG only as its Safari fallback; this app always emits JPEG, so 0.85 is
// the one value worth carrying over.
const JPEG_QUALITY = 0.85

// `data`'s generic is pinned to ArrayBuffer (not the wider, default ArrayBufferLike) — decodeHeic below
// only ever allocates it fresh via `new Uint8ClampedArray(length)`, never backed by a
// SharedArrayBuffer, and `new ImageData(...)` in encodeJpegReal requires exactly this narrower shape.
export interface DecodedHeicImage {
	width: number
	height: number
	data: Uint8ClampedArray<ArrayBuffer>
}

interface HeicImage {
	get_width: () => number
	get_height: () => number
	display: (target: DecodedHeicImage, callback: (result: unknown) => void) => void
	free: () => void
}

interface HeicDecoderInstance {
	decode: (bytes: Uint8Array) => HeicImage[]
	decoder: unknown
}

// Narrowed to exactly what decodeHeic/initLibheifDecoder use below — the library's actual embind-
// exported surface is much wider, and (being embind, not a plain object literal) keeps its real names
// through minification regardless of how narrow this declares it.
export interface HeicDecoderModule {
	HeifDecoder: new () => HeicDecoderInstance
	heif_context_free: (context: unknown) => void
	// Not every libheif build exposes this. Where it's present, this ESM bundle has already resolved it
	// by the time the factory call returns, in practice — so awaiting it is a defensive no-op here, not
	// a real dependency.
	ready?: Promise<void>
}

// Threaded through runHeicTransform below to switch it from the preview path (full-resolution,
// always-JPEG, byte-for-byte unchanged when omitted) to the thumbnail path (downscaled, webp-first).
export interface HeicTransformOpts {
	maxDimension?: number
}

export interface HeicTransformDeps {
	// Production resolves the real WASM module (initLibheifDecoder below); tests supply a fake so
	// getSharedDecoder/runHeicTransform's memoization + error-mapping run with no WASM involved — actual
	// decode correctness is only provable in a real browser (see the HEIC leg of the preview e2e suite).
	getDecoder: () => Promise<HeicDecoderModule>
	// Production encodes via OffscreenCanvas (encodeJpegReal below); tests supply a fake.
	encodeJpeg: (pixels: DecodedHeicImage, quality: number) => Promise<Blob>
	// Only reached when opts.maxDimension is set (encodeThumbReal below); tests supply a fake.
	encodeThumb: (pixels: DecodedHeicImage, maxDimension: number) => Promise<Blob>
}

let sharedDecoderPromise: Promise<HeicDecoderModule> | null = null

// One decoder init shared across concurrent/sequential calls — arrow-paging across several HEIC
// siblings in one preview session reuses the same in-flight/resolved module rather than re-fetching the
// WASM bundle per file. A rejected init is evicted, not cached, so the next call gets a real retry
// instead of staying broken for the rest of the worker's lifetime.
async function getSharedDecoder(getDecoder: HeicTransformDeps["getDecoder"]): Promise<HeicDecoderModule> {
	sharedDecoderPromise ??= getDecoder()

	try {
		return await sharedDecoderPromise
	} catch (e) {
		sharedDecoderPromise = null

		throw e
	}
}

// Orientation is already applied: libheif bakes the container's own EXIF/orientation transform into the
// decoded pixels, so nothing downstream ever re-rotates. Only the first top-level image is read — a
// burst/Live Photo container decodes multiple, but this is a single still preview, not a burst viewer.
async function decodeHeic(bytes: Uint8Array, lib: HeicDecoderModule): Promise<DecodedHeicImage> {
	const decoder = new lib.HeifDecoder()
	// decode() can allocate its heif_context before it throws, so both the call and the empty-result
	// check right after need to stay inside this try — otherwise an undecodable file's context never
	// reaches the free() below.
	let images: HeicImage[] = []

	try {
		images = decoder.decode(bytes)

		const image = images[0]

		if (image === undefined) {
			throw new Error("no image in HEIC/HEIF container")
		}

		const width = image.get_width()
		const height = image.get_height()

		if (width <= 0 || height <= 0) {
			throw new Error("invalid HEIC/HEIF image dimensions")
		}

		const target = { width, height, data: new Uint8ClampedArray(width * height * 4) }

		await new Promise<void>((resolve, reject) => {
			image.display(target, result => {
				if (result === null || result === undefined) {
					reject(new Error("HEIC/HEIF decode failed"))

					return
				}

				resolve()
			})
		})

		return target
	} finally {
		for (const image of images) {
			image.free()
		}

		// A decoder's heif_context only frees itself on that SAME decoder's next decode() call — every
		// call here gets a fresh decoder, so that auto-free never happens on its own, and skipping this
		// explicit free just grows the WASM heap call after call.
		if (decoder.decoder) {
			lib.heif_context_free(decoder.decoder)
		}
	}
}

// Dynamic import: keeps the ~1.4 MB WASM bundle out of this worker's own eagerly-evaluated chunk,
// fetched only once a HEIC file is actually opened.
async function initLibheifDecoder(): Promise<HeicDecoderModule> {
	const { default: initLibheifBundle } = await import("libheif-js/libheif-wasm/libheif-bundle.mjs")
	// Return shape isn't typed anywhere upstream (see the ambient shim) — cast against our own
	// hand-written interface, scoped to exactly the surface decodeHeic uses; not a null-strip.
	const lib = initLibheifBundle() as HeicDecoderModule

	if (lib.ready) {
		await lib.ready
	}

	return lib
}

// Runs worker-side — this module's only real caller is heic.worker.ts — where OffscreenCanvas is fully
// spec'd to work with no main-thread handoff, and is available in every browser this app targets
// (Chromium, Firefox, Safari 16.4+). Encoding here rather than on the main thread means the only thing
// crossing back over Comlink is the final JPEG Blob, not the much larger raw RGBA buffer
// (width*height*4 bytes — easily 10x+ a compressed JPEG for a real photo).
async function encodeJpegReal(pixels: DecodedHeicImage, quality: number): Promise<Blob> {
	const canvas = new OffscreenCanvas(pixels.width, pixels.height)
	const ctx = canvas.getContext("2d")

	if (ctx === null) {
		throw new Error("could not create an OffscreenCanvas 2D context")
	}

	ctx.putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0)

	return await canvas.convertToBlob({ type: "image/jpeg", quality })
}

// Thumbnail encode path: downscales to maxDimension first (a no-op draw when the source is already
// at or under it — decodeHeic's own RGBA is used as-is, matching encodeJpegReal's full-resolution
// draw) then hands off to the same webp-first/jpeg-fallback policy every other thumbnail generator
// shares (thumbGenerators.logic.ts) — unlike encodeJpegReal, this never re-encodes at the source's
// full resolution, since a thumbnail's whole point is the smaller target size.
async function encodeThumbReal(pixels: DecodedHeicImage, maxDimension: number): Promise<Blob> {
	const { width, height } = fitWithin(pixels.width, pixels.height, maxDimension)
	const canvas = new OffscreenCanvas(width, height)
	const ctx = canvas.getContext("2d")

	if (ctx === null) {
		throw new Error("could not create an OffscreenCanvas 2D context")
	}

	if (width === pixels.width && height === pixels.height) {
		ctx.putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0)
	} else {
		const bitmap = await createImageBitmap(new ImageData(pixels.data, pixels.width, pixels.height))

		ctx.drawImage(bitmap, 0, 0, width, height)
		bitmap.close()
	}

	return await encodeCanvasThumb(canvas)
}

// heic.worker.ts's only wiring: the real decoder + real encoders, handed to runHeicTransform below.
export const productionDeps: HeicTransformDeps = {
	getDecoder: initLibheifDecoder,
	encodeJpeg: encodeJpegReal,
	encodeThumb: encodeThumbReal
}

// DI'd core: heic.worker.ts wires productionDeps for the real path; tests inject fakes so the
// memoization + error-mapping below run with no WASM/OffscreenCanvas involved. This is also the
// boundary every failure mode gets normalized at, before a thrown value has any chance to cross the
// worker's postMessage hop back to its caller (see heic.worker.test.ts for why that ordering matters).
// `opts` is omitted by every preview caller (imageViewer.tsx via heicTransform.ts) — the
// full-resolution, always-JPEG behavior above is byte-for-byte unchanged from before opts existed.
// Only the thumbnail generator (thumbGenerators.ts) passes maxDimension, switching the encode step
// to the downscaled, webp-first path instead.
export async function runHeicTransform(bytes: Uint8Array, deps: HeicTransformDeps, opts?: HeicTransformOpts): Promise<Blob> {
	try {
		const lib = await getSharedDecoder(deps.getDecoder)
		const decoded = await decodeHeic(bytes, lib)
		const maxDimension = opts?.maxDimension

		return maxDimension === undefined ? await deps.encodeJpeg(decoded, JPEG_QUALITY) : await deps.encodeThumb(decoded, maxDimension)
	} catch (e) {
		// Never a throw-through: a WASM abort/trap can reject with a bare string or some other non-Error
		// shape. Logged here — the only place the raw detail is available — before normalizing to a real
		// Error; the caller (imageViewer.tsx) maps any rejection to the same one labeled error state
		// regardless of content.
		log.error("heic-decode", e)

		throw new Error("heic transform failed", { cause: e })
	}
}
