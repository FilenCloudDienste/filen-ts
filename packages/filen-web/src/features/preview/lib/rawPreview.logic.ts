import type { EmbeddedPreviewResult } from "@filen/sdk-rs"

// A camera RAW's preview is the JPEG the camera itself embedded in the container, lifted out by the
// SDK's writeEmbeddedPreview — the RAW is never decoded here. The SDK splices a 36-byte EXIF
// orientation into those bytes when only the container knew the rotation, so an <img> (which honours
// EXIF orientation by default) shows them upright with no transform of our own.
//
// "noPreview" is a settled answer about the file (no JPEG of at least 512 px embedded, or a forged
// length), not a failure: the SDK's documented fallback for it is the thumbnail.
export type RawPreviewResult = { type: "preview"; blob: Blob } | { type: "noPreview" }

// Collects what the SDK writes into a Blob on the JS side. Each chunk is copied as it arrives: with
// threads on, a chunk can be a view onto the wasm module's shared memory, which the SDK is free to
// reuse once write() returns.
export function createMemorySink(): { writer: WritableStream<Uint8Array>; chunks: Uint8Array<ArrayBuffer>[] } {
	const chunks: Uint8Array<ArrayBuffer>[] = []
	const writer = new WritableStream<Uint8Array>({
		write(chunk) {
			chunks.push(chunk.slice())
		}
	})

	return { writer, chunks }
}

// The embedded preview is a JPEG by definition (EmbeddedPreviewResult's own contract), so the Blob is
// typed as one. An empty "preview" would only mean the transport dropped bytes the SDK counted as
// written, so it is reported as an error rather than rendered as a broken image.
export function toRawPreviewResult(result: EmbeddedPreviewResult, chunks: Uint8Array<ArrayBuffer>[]): RawPreviewResult {
	if (result.type === "noPreview") {
		return { type: "noPreview" }
	}

	const blob = new Blob(chunks, { type: "image/jpeg" })

	if (blob.size === 0 || BigInt(blob.size) !== result.bytes) {
		throw new Error(`embedded preview size mismatch: wrote ${String(blob.size)}, expected ${String(result.bytes)}`)
	}

	return { type: "preview", blob }
}
