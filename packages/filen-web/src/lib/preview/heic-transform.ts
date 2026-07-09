import { log } from "@/lib/log"

// HEIC/HEIF can't be decoded by the browser natively (see preview.logic.ts's needsImageTransform) —
// this lazy-imports libheif's WASM decoder on first call (dynamic import keeps the ~1.4 MB bundle out
// of the main chunk entirely) and re-encodes the decoded pixels to JPEG via OffscreenCanvas, on the
// main thread. No SDK/worker involvement: bytes arrive already decrypted from the buffered download
// (image-viewer.tsx's usePreviewBytes).

// Old-web's own HEIC encode quality (its primary target is WebP where the browser can actually encode
// it, JPEG only as a Safari fallback — this app always targets JPEG, so only that value applies).
const JPEG_QUALITY = 0.85

// `data` is pinned to the ArrayBuffer-backed generic (not the wider ArrayBufferLike default) because
// decodeHeic below only ever fills it via `new Uint8ClampedArray(length)` — a fresh allocation, never a
// SharedArrayBuffer — and encodeJpegReal's `new ImageData(...)` call requires exactly this narrower
// shape.
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

// The library's real runtime surface (embind-exported, so these names survive minification) is wider
// than this — only what decodeHeic below actually calls is declared.
export interface HeicDecoderModule {
	HeifDecoder: new () => HeicDecoderInstance
	heif_context_free: (context: unknown) => void
	// Present on some libheif builds, absent on others — this ESM bundle initializes synchronously in
	// practice, so awaiting it is defensive, not load-bearing.
	ready?: Promise<void>
}

export interface HeicTransformDeps {
	// Resolves the decoder module — production dynamic-imports the WASM bundle (loadRealDecoder
	// below); tests inject a fake so the memoization/error-mapping logic below runs with no WASM
	// involved (real decode correctness is e2e/manual territory).
	loadDecoder: () => Promise<HeicDecoderModule>
	// Encodes decoded RGBA pixels to a JPEG Blob — production uses OffscreenCanvas (encodeJpegReal
	// below); tests inject a fake.
	encodeJpeg: (pixels: DecodedHeicImage, quality: number) => Promise<Blob>
}

let decoderPromise: Promise<HeicDecoderModule> | null = null

// Shares one decoder init across concurrent/sequential calls (e.g. paging across several HEIC
// siblings). A failed resolution is NOT cached, so a later call retries instead of staying broken for
// the rest of the session.
async function loadDecoderOnce(loadDecoder: HeicTransformDeps["loadDecoder"]): Promise<HeicDecoderModule> {
	decoderPromise ??= loadDecoder()

	try {
		return await decoderPromise
	} catch (e) {
		decoderPromise = null

		throw e
	}
}

// libheif applies the container's own orientation transform during decode, so the returned pixels are
// already correctly oriented. A multi-image container (burst/Live Photo) uses only the first
// top-level image — this is a still-preview transform, not a burst viewer.
async function decodeHeic(bytes: Uint8Array, lib: HeicDecoderModule): Promise<DecodedHeicImage> {
	const decoder = new lib.HeifDecoder()
	// decode() allocates a heif_context internally before it can fail, so both the decode call and the
	// empty-result check below must run inside the try — otherwise an undecodable file leaks the
	// context (only freed in the finally below).
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

		// decode() allocates a heif_context that only auto-frees on the SAME decoder's next decode()
		// call — a fresh decoder per call needs this explicit free or the WASM heap only grows.
		if (decoder.decoder) {
			lib.heif_context_free(decoder.decoder)
		}
	}
}

async function loadRealDecoder(): Promise<HeicDecoderModule> {
	const { default: createLibheif } = await import("libheif-js/libheif-wasm/libheif-bundle.mjs")
	const lib = createLibheif() as HeicDecoderModule

	if (lib.ready) {
		await lib.ready
	}

	return lib
}

async function encodeJpegReal(pixels: DecodedHeicImage, quality: number): Promise<Blob> {
	const canvas = new OffscreenCanvas(pixels.width, pixels.height)
	const ctx = canvas.getContext("2d")

	if (ctx === null) {
		throw new Error("could not create an OffscreenCanvas 2D context")
	}

	ctx.putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0)

	return await canvas.convertToBlob({ type: "image/jpeg", quality })
}

const productionDeps: HeicTransformDeps = { loadDecoder: loadRealDecoder, encodeJpeg: encodeJpegReal }

// DI'd core — production wires productionDeps (transformHeicBytes below); tests inject fakes so the
// memoization + error-mapping logic here is exercised with no WASM/OffscreenCanvas involved.
export async function runHeicTransform(bytes: Uint8Array, deps: HeicTransformDeps): Promise<Blob> {
	try {
		const lib = await loadDecoderOnce(deps.loadDecoder)
		const decoded = await decodeHeic(bytes, lib)

		return await deps.encodeJpeg(decoded, JPEG_QUALITY)
	} catch (e) {
		// Never a throw-through: a WASM abort/trap can reject with a bare string or an unrelated shape,
		// not a proper Error. Logged here (the only place the raw detail is available) — the caller maps
		// this clean, stable message to a labeled error state for display (image-viewer.tsx).
		log.error("heic-transform", e)

		throw new Error("heic transform failed", { cause: e })
	}
}

export function transformHeicBytes(bytes: Uint8Array): Promise<Blob> {
	return runHeicTransform(bytes, productionDeps)
}
