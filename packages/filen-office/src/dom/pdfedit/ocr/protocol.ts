import type { QuarterTurns } from "../../../core/pdfedit/ocrGeometry"

// What a page and a text recognition worker say to each other. Requests carry an id and get exactly one answer;
// a model download also posts progress events. Pixels and recognised pages are transferred.

// tesseract.js-core's LSTM-only builds, best first: the host loads the first its browser validates.
export type OcrEngineVariant = "relaxedsimd-lstm" | "simd-lstm" | "lstm"

export const OCR_ENGINE_VARIANTS: readonly OcrEngineVariant[] = ["relaxedsimd-lstm", "simd-lstm", "lstm"]

// One build's wasm (its glue is bundled with the host's worker).
export interface OcrEngineAssets {
	readonly wasm: string
}

// A language model as served: gzip-compressed at `url`; `bytes` and `sha256` describe it uncompressed.
export interface OcrModelAsset {
	readonly url: string
	readonly bytes: number
	readonly sha256: string
	// What downloading it costs.
	readonly transferBytes: number
}

// vite/ocr-assets-plugin.ts's `virtual:ocr-assets`.
export interface OcrAssets {
	readonly engines: Readonly<Record<OcrEngineVariant, OcrEngineAssets>>
	readonly languages: Readonly<Record<string, OcrModelAsset>>
}

export interface OcrModel extends OcrModelAsset {
	// The model's name ("eng", "chi_sim").
	readonly code: string
}

export type OcrFailure =
	// A model could not be fetched, or did not match its size and SHA-256.
	| "modelFailed"
	// No model is loaded yet.
	| "notReady"
	// A wasm trap or out of memory: the worker refuses everything from now on.
	| "poisoned"
	// The request was malformed.
	| "badRequest"
	// The recogniser refused the image.
	| "failed"
	// The worker was terminated.
	| "closed"

export interface OcrRecogniseArgs {
	// DeviceGray rows of `stride` bytes, `width` used (transferred).
	readonly pixels: Uint8Array<ArrayBuffer>
	readonly width: number
	readonly height: number
	readonly stride: number
	readonly dpi: number
	// Try the page turned when its words are recognised poorly (core/pdfedit/ocrGeometry.ts OCR_ORIENTATION_*).
	readonly orient: boolean
}

export interface OcrPageResult {
	// A one-page text-only PDF: invisible text over a page the image's size at its resolution (transferred).
	readonly pdf: Uint8Array<ArrayBuffer>
	// The image was read turned clockwise by this much (ocrOverlayMatrix).
	readonly turns: QuarterTurns
	// Mean word confidence, 0-100.
	readonly confidence: number
	readonly words: number
	// Words recognised with a confidence below 50.
	readonly doubtfulWords: number
	// Extra passes the orientation check ran (at most 3).
	readonly orientationPasses: number
}

export interface OcrHeapReport {
	readonly heapBytes: number
}

export interface OcrOps {
	// Loads these models (fetched, verified, then initialised together); a no-op for the set already loaded.
	load: { readonly args: { readonly models: readonly OcrModel[] }; readonly value: OcrHeapReport }
	recognise: { readonly args: OcrRecogniseArgs; readonly value: OcrPageResult }
	heap: { readonly args: Record<string, never>; readonly value: OcrHeapReport }
}

export type OcrOp = keyof OcrOps
export type OcrArgs<K extends OcrOp> = OcrOps[K]["args"]
export type OcrValue<K extends OcrOp> = OcrOps[K]["value"]

export type ToOcr = { readonly t: "call"; readonly id: number; readonly op: OcrOp; readonly args: unknown }

export type FromOcr =
	| { readonly t: "ok"; readonly id: number; readonly value: unknown }
	| { readonly t: "error"; readonly id: number; readonly failure: OcrFailure; readonly message: string }
	// A model download's progress: uncompressed bytes of all models in the request.
	| { readonly t: "progress"; readonly id: number; readonly loaded: number; readonly total: number }
	| { readonly t: "poisoned"; readonly message: string }

export function isFromOcr(data: unknown): data is FromOcr {
	if (typeof data !== "object" || data === null) return false

	const t: unknown = Reflect.get(data, "t")

	return t === "ok" || t === "error" || t === "progress" || t === "poisoned"
}

export function isToOcr(data: unknown): data is ToOcr {
	return (
		typeof data === "object" &&
		data !== null &&
		Reflect.get(data, "t") === "call" &&
		typeof Reflect.get(data, "id") === "number" &&
		typeof Reflect.get(data, "op") === "string"
	)
}
