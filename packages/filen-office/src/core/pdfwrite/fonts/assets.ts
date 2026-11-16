import { gunzipSync } from "fflate"
import type { PdfFaceFile } from "./faces.generated"

// Reads a gzip'd face (assets/fonts/**.ttf.gz) into one buffer of the size the manifest gives, and refuses a file that
// decompresses to more. A server that already decoded it (Content-Encoding: gzip) hands over the TrueType bytes, which
// are taken as they are. readFace streams a body through the platform's DecompressionStream("gzip") with no
// intermediate copies; decodeFace decodes a body already in hand, synchronously (a worker's font hook that cannot
// await). The core has no DOM typings, so streams are described structurally.

export interface PdfByteReader {
	read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>
	cancel(reason?: unknown): Promise<void>
}

export interface PdfByteStream {
	getReader(): PdfByteReader
}

// Where font files come from. Web: a fetch body from the app origin (hashed URLs, HTTP cache); tests: node fs.
export interface PdfFontAssets {
	open(file: string): Promise<PdfByteStream>
}

interface ByteWriterLike {
	write(chunk: Uint8Array): Promise<void>
	close(): Promise<void>
	abort(reason: unknown): Promise<void>
}

interface DecompressionLike {
	readonly readable: PdfByteStream
	readonly writable: { getWriter(): ByteWriterLike }
}

export class PdfFontAssetError extends Error {}

function isGzip(head: Uint8Array): boolean {
	return head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b
}

function checkLength(face: PdfFaceFile, length: number): void {
	if (length !== face.ttfBytes) throw new PdfFontAssetError(`${face.file} is ${length} bytes, the manifest says ${face.ttfBytes}`)
}

// A face's TrueType bytes from its body as fetched: gunzipped into a buffer of the manifest's size, or the body itself
// when it was already decoded.
export function decodeFace(bytes: Uint8Array, face: PdfFaceFile): Uint8Array {
	if (!isGzip(bytes)) {
		checkLength(face, bytes.length)

		return bytes
	}

	// The trailer's size (modulo 2^32) is checked first, so an honestly larger file is refused before it inflates; a
	// forged one is cut off at the manifest's size.
	if (bytes.length < 18) throw new PdfFontAssetError(`${face.file} is not a gzip file`)

	const trailer = bytes.length - 4
	const declared =
		((bytes[trailer] ?? 0) |
			((bytes[trailer + 1] ?? 0) << 8) |
			((bytes[trailer + 2] ?? 0) << 16) |
			((bytes[trailer + 3] ?? 0) << 24)) >>>
		0

	if (declared !== face.ttfBytes % 2 ** 32) throw new PdfFontAssetError(`${face.file} is larger than the manifest says`)

	let decoded: Uint8Array

	try {
		decoded = gunzipSync(bytes, { out: new Uint8Array(face.ttfBytes) })
	} catch (error) {
		throw new PdfFontAssetError(`${face.file} is not a valid gzip file: ${error instanceof Error ? error.message : String(error)}`)
	}

	checkLength(face, decoded.length)

	return decoded
}

export async function readFace(assets: PdfFontAssets, face: PdfFaceFile, signal?: { readonly aborted: boolean }): Promise<Uint8Array> {
	const reader = (await assets.open(face.file)).getReader()
	const out = new Uint8Array(face.ttfBytes)
	let length = 0

	const append = (chunk: Uint8Array): void => {
		if (signal?.aborted === true) throw new PdfFontAssetError("The font read was aborted")
		if (length + chunk.length > out.length) throw new PdfFontAssetError(`${face.file} is larger than the manifest says`)

		out.set(chunk, length)
		length += chunk.length
	}

	const first = await reader.read()

	if (first.done || first.value === undefined) throw new PdfFontAssetError(`${face.file} is empty`)

	const head = first.value

	if (!isGzip(head)) {
		try {
			append(head)

			for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
				if (chunk.value !== undefined) append(chunk.value)
		} catch (error) {
			await reader.cancel(error).catch(() => undefined)

			throw error
		}
	} else {
		const Decompression = Reflect.get(globalThis, "DecompressionStream") as (new (format: string) => DecompressionLike) | undefined

		if (typeof Decompression !== "function") throw new PdfFontAssetError("This platform cannot decompress gzip")

		const stream = new Decompression("gzip")
		const writer = stream.writable.getWriter()
		const decoded = stream.readable.getReader()
		// Feeding runs beside reading, so the transform's backpressure never stalls either side.
		const feed = (async (): Promise<void> => {
			try {
				await writer.write(head)

				for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
					if (chunk.value !== undefined) await writer.write(chunk.value)
				}

				await writer.close()
			} catch (error) {
				await writer.abort(error).catch(() => undefined)
				await reader.cancel(error).catch(() => undefined)
			}
		})()

		try {
			for (let chunk = await decoded.read(); !chunk.done; chunk = await decoded.read())
				if (chunk.value !== undefined) append(chunk.value)
		} catch (error) {
			await decoded.cancel(error).catch(() => undefined)
			await reader.cancel(error).catch(() => undefined)

			throw error
		} finally {
			await feed
		}
	}

	checkLength(face, length)

	return out
}
