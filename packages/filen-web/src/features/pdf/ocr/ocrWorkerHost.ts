import { OCR_ENGINE_VARIANTS, type OcrEngineVariant, type OcrModel } from "@filen/office/dom/pdfedit/ocr"

// The text recognition worker's own helpers (ocr.worker.ts): which engine build this browser runs, and reading a
// language model.

// Smallest modules using one instruction of each feature: SIMD's i8x16.popcnt and relaxed SIMD's
// i8x16.relaxed_swizzle (the probes wasm-feature-detect uses).
const SIMD_PROBE = new Uint8Array([
	0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
])
const RELAXED_SIMD_PROBE = new Uint8Array([
	0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11
])

export function ocrEngineVariant(
	validate: (bytes: Uint8Array<ArrayBuffer>) => boolean = bytes => WebAssembly.validate(bytes)
): OcrEngineVariant {
	const supported: Readonly<Record<OcrEngineVariant, boolean>> = {
		"relaxedsimd-lstm": validate(RELAXED_SIMD_PROBE),
		"simd-lstm": validate(SIMD_PROBE),
		lstm: true
	}

	return OCR_ENGINE_VARIANTS.find(variant => supported[variant]) ?? "lstm"
}

// A model: fetched (gzip, served as opaque bytes), inflated straight into one buffer of its pinned size. Longer than
// pinned fails at once; the caller verifies the SHA-256.
export async function readOcrModel(model: OcrModel, onBytes: (bytes: number) => void): Promise<Uint8Array<ArrayBuffer>> {
	const response = await fetch(model.url, { credentials: "same-origin" })

	if (!response.ok || response.body === null) throw new Error(`model ${model.code}: HTTP ${String(response.status)}`)

	const out = new Uint8Array(model.bytes)
	const reader = response.body.pipeThrough(new DecompressionStream("gzip")).getReader()
	let at = 0

	for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
		if (at + chunk.value.byteLength > out.byteLength) {
			await reader.cancel()

			throw new Error(`model ${model.code} is larger than pinned`)
		}

		out.set(chunk.value, at)
		at += chunk.value.byteLength
		onBytes(at)
	}

	if (at !== out.byteLength) throw new Error(`model ${model.code} is smaller than pinned`)

	return out
}
