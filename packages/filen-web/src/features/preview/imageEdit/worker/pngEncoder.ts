import { crc32 } from "@/features/preview/imageEdit/lib/crc32"

// An 8-bit truecolour PNG (PNG 3rd ed.) from an RGBA buffer: colour type 6 with alpha, else 2 (the alpha bytes
// dropped). Every row uses filter type 1, Sub (§9.2): one subtraction per byte, far cheaper than Paeth's
// per-byte predictor search for a modest size cost. The filtered rows stream through the platform's
// CompressionStream("deflate"), which is the zlib format (RFC 1950) IDAT requires (§10.1), so the filtered image is
// never held whole; only its compressed output is, written into ONE IDAT of the final file.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// Filtered bytes handed to the compressor per write: large enough that per-chunk overhead vanishes, small enough
// that the queue between this loop and the deflater stays a few MB.
const BATCH_BYTES = 1 << 20

const FILTER_SUB = 1

function writeChunkHeader(view: DataView, at: number, length: number, type: string): void {
	view.setUint32(at, length)

	for (let i = 0; i < 4; i++) {
		view.setUint8(at + 4 + i, type.charCodeAt(i))
	}
}

// `data` is RGBA, width × height × 4 bytes, straight (not premultiplied) alpha.
export async function encodePng(data: Uint8Array, width: number, height: number, hasAlpha: boolean): Promise<Uint8Array<ArrayBuffer>> {
	if (width < 1 || height < 1 || data.length < width * height * 4) {
		throw new Error("PNG: pixel buffer does not match its size")
	}

	const channels = hasAlpha ? 4 : 3
	const rowBytes = 1 + width * channels
	const rowsPerBatch = Math.max(1, Math.floor(BATCH_BYTES / rowBytes))
	const compressor = new CompressionStream("deflate")
	const writer = compressor.writable.getWriter()

	const collect = async (): Promise<Uint8Array[]> => {
		const parts: Uint8Array[] = []
		const reader = compressor.readable.getReader()

		for (;;) {
			const { done, value } = await reader.read()

			if (done) {
				return parts
			}

			parts.push(value)
		}
	}

	const write = async (): Promise<void> => {
		for (let y0 = 0; y0 < height; y0 += rowsPerBatch) {
			const rows = Math.min(rowsPerBatch, height - y0)
			// A fresh batch each time: the stream may still hold the previous one until the deflater consumes it.
			const batch = new Uint8Array(rows * rowBytes)

			for (let r = 0; r < rows; r++) {
				const src = (y0 + r) * width * 4
				let out = r * rowBytes

				batch[out++] = FILTER_SUB

				if (hasAlpha) {
					// Sub: each byte minus the same channel of the pixel to its left (0 left of the first pixel).
					batch[out++] = data[src] ?? 0
					batch[out++] = data[src + 1] ?? 0
					batch[out++] = data[src + 2] ?? 0
					batch[out++] = data[src + 3] ?? 0

					for (let i = src + 4, end = src + width * 4; i < end; i++) {
						batch[out++] = ((data[i] ?? 0) - (data[i - 4] ?? 0)) & 0xff
					}
				} else {
					batch[out++] = data[src] ?? 0
					batch[out++] = data[src + 1] ?? 0
					batch[out++] = data[src + 2] ?? 0

					for (let i = src + 4, end = src + width * 4; i < end; i += 4) {
						batch[out++] = ((data[i] ?? 0) - (data[i - 4] ?? 0)) & 0xff
						batch[out++] = ((data[i + 1] ?? 0) - (data[i - 3] ?? 0)) & 0xff
						batch[out++] = ((data[i + 2] ?? 0) - (data[i - 2] ?? 0)) & 0xff
					}
				}
			}

			// Backpressure: wait for room instead of queueing the whole filtered image.
			await writer.ready
			void writer.write(batch).catch(() => undefined)
		}

		await writer.close()
	}

	// Read while writing: the deflater only makes room once its output is drained.
	const [parts] = await Promise.all([collect(), write()])
	let compressed = 0

	for (const part of parts) {
		compressed += part.length
	}

	// Signature, IHDR (13 data bytes), one IDAT, IEND; 12 bytes of length + type + CRC per chunk.
	const ihdrAt = SIGNATURE.length
	const idatAt = ihdrAt + 12 + 13
	const iendAt = idatAt + 12 + compressed
	const png = new Uint8Array(iendAt + 12)
	const view = new DataView(png.buffer)

	png.set(SIGNATURE, 0)

	writeChunkHeader(view, ihdrAt, 13, "IHDR")
	view.setUint32(ihdrAt + 8, width)
	view.setUint32(ihdrAt + 12, height)
	// Bit depth 8, colour type 6 (RGBA) or 2 (RGB), compression 0, filter method 0, no interlace.
	png.set([8, hasAlpha ? 6 : 2, 0, 0, 0], ihdrAt + 16)
	view.setUint32(ihdrAt + 21, crc32(png.subarray(ihdrAt + 4, ihdrAt + 21)) >>> 0)

	writeChunkHeader(view, idatAt, compressed, "IDAT")

	let at = idatAt + 8

	for (const part of parts) {
		png.set(part, at)
		at += part.length
	}

	view.setUint32(at, crc32(png.subarray(idatAt + 4, at)) >>> 0)

	writeChunkHeader(view, iendAt, 0, "IEND")
	view.setUint32(iendAt + 8, crc32(png.subarray(iendAt + 4, iendAt + 8)) >>> 0)

	return png
}
