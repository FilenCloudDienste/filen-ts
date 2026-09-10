// Pure sizing/encoding helpers shared by the client-side thumbnail generators (video, pdf) — the two
// categories the Rust SDK cannot decode and this app therefore still draws to a canvas itself. Zero
// dependencies of its own, so it can be imported from anywhere without risking a cycle.

// Aspect-preserving max-dimension fit, never upscaling — a source already at or under maxDim in both
// dimensions returns its own size unchanged (scale clamped to 1).
export function fitWithin(width: number, height: number, maxDim: number): { width: number; height: number } {
	const scale = Math.min(1, maxDim / Math.max(width, height))

	return {
		width: Math.round(width * scale),
		height: Math.round(height * scale)
	}
}

// A canvas silently downgrades an unsupported requested encode type to image/png instead of throwing
// (WHATWG canvas spec) — the produced blob's own .type is the only reliable signal a webp attempt
// actually produced webp, so this keeps it when honored and otherwise awaits the caller's jpeg
// fallback attempt.
export async function selectWebpOrFallback(webpAttempt: Blob, jpegFallback: () => Promise<Blob>): Promise<Blob> {
	return webpAttempt.type === "image/webp" ? webpAttempt : await jpegFallback()
}

const JPEG_FALLBACK_QUALITY = 0.85

// OffscreenCanvas.convertToBlob and HTMLCanvasElement.toBlob are different APIs (promise-returning
// vs. callback-based) — convertToBlob's presence, which HTMLCanvasElement never has, is what
// TypeScript narrows the union on below, so no runtime `instanceof OffscreenCanvas` (unavailable
// outside a browser/worker realm, e.g. under a plain Node unit test) is ever needed here.
async function attemptEncode(canvas: OffscreenCanvas | HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
	if ("convertToBlob" in canvas) {
		// exactOptionalPropertyTypes forbids an explicit `quality: undefined` property, so the options
		// object is built conditionally rather than always including the (possibly absent) key.
		return await (quality === undefined ? canvas.convertToBlob({ type }) : canvas.convertToBlob({ type, quality }))
	}

	return await new Promise<Blob>((resolve, reject) => {
		canvas.toBlob(
			blob => {
				if (blob === null) {
					reject(new Error("canvas toBlob produced no result"))

					return
				}

				resolve(blob)
			},
			type,
			quality
		)
	})
}

// webp-first, jpeg-0.85 fallback — the on-disk format policy the canvas-drawing generators share. The
// SDK arm needs none of this: it encodes webp itself, inside wasm.
export async function encodeCanvasThumb(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
	const webp = await attemptEncode(canvas, "image/webp")

	return await selectWebpOrFallback(webp, () => attemptEncode(canvas, "image/jpeg", JPEG_FALLBACK_QUALITY))
}
