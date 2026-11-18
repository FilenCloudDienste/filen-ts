// DICOM RLE (PS3.5 Annex G): a 64-byte header of up to 15 segment offsets, then one PackBits segment per byte plane,
// most significant byte first within a sample, sample by sample. The output is sized from the tags alone and written
// into a buffer of exactly that size: a segment that runs long is cut off, one that runs short leaves zeros.

const HEADER_BYTES = 64
const MAX_SEGMENTS = 15

export class DicomRleError extends Error {
	override readonly name = "DicomRleError"
}

export interface RleFrame {
	readonly rows: number
	readonly columns: number
	readonly samplesPerPixel: number
	// 1, 2 or 4.
	readonly bytesPerSample: number
}

// One frame's samples, pixel-interleaved, each sample's bytes little-endian (as a native frame lies in memory): view
// the result as a Uint16Array or Uint32Array for wider samples.
export function decodeRle(encoded: Uint8Array, frame: RleFrame): Uint8Array {
	const { rows, columns, samplesPerPixel, bytesPerSample } = frame
	const pixels = rows * columns
	const segments = samplesPerPixel * bytesPerSample

	if (segments < 1 || segments > MAX_SEGMENTS) {
		throw new DicomRleError(`${String(segments)} byte planes cannot be RLE segments`)
	}

	if (encoded.length < HEADER_BYTES) {
		throw new DicomRleError("the RLE header is cut short")
	}

	const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
	const declared = view.getUint32(0, true)

	if (declared !== segments) {
		throw new DicomRleError(`the RLE header names ${String(declared)} segments, the tags ${String(segments)}`)
	}

	const output = new Uint8Array(pixels * segments)
	const stride = segments

	for (let segment = 0; segment < segments; segment++) {
		const start = view.getUint32(4 + segment * 4, true)
		const next = segment + 1 < segments ? view.getUint32(8 + segment * 4, true) : encoded.length
		const end = Math.min(encoded.length, next)

		if (start < HEADER_BYTES || start > end) {
			throw new DicomRleError("an RLE segment lies outside the frame")
		}

		const sample = Math.floor(segment / bytesPerSample)
		// Most significant byte first: plane 0 of a sample is its highest byte.
		const byte = bytesPerSample - 1 - (segment % bytesPerSample)

		unpackSegment(encoded, start, end, output, sample * bytesPerSample + byte, stride, pixels)
	}

	return output
}

// PackBits into every `stride`th byte of `output` from `first`, at most `count` bytes.
function unpackSegment(
	input: Uint8Array,
	start: number,
	end: number,
	output: Uint8Array,
	first: number,
	stride: number,
	count: number
): void {
	let at = start
	let written = 0

	while (at < end && written < count) {
		const header = input[at++] ?? 0
		const n = header > 127 ? header - 256 : header

		if (n >= 0) {
			const run = Math.min(n + 1, end - at, count - written)

			for (let i = 0; i < run; i++) output[first + (written + i) * stride] = input[at + i] ?? 0

			at += n + 1
			written += run
		} else if (n !== -128) {
			if (at >= end) break

			const value = input[at++] ?? 0
			const run = Math.min(1 - n, count - written)

			for (let i = 0; i < run; i++) output[first + (written + i) * stride] = value

			written += run
		}
	}
}
