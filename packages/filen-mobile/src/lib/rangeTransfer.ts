/**
 * How file bytes cross the RN <-> WebView bridge, in bounded chunks, in both directions.
 *
 * Passing a file to a DOM component as a prop does not scale, and the reason is in expo/dom's
 * marshaller rather than anywhere obvious: every prop change is JSON-serialized into a JavaScript
 * SOURCE string and evaluated in the WebView, and the effect that does it depends on an object
 * rebuilt each render — so a whole-file prop is re-encoded, re-sent and re-parsed on every render of
 * the host, not once at load. Function props are exempt: they marshal as a NAME, and the WebView
 * calls back over an RPC. So the file moves through a function, in pieces, and nothing large is ever
 * a prop.
 *
 * The reader is the security boundary. It is a function prop, so anything running in the WebView can
 * call it — including a hostile document that achieved script execution. It therefore takes
 * `(offset, length)` and NOTHING else: a path parameter would turn it into an arbitrary-file-read
 * primitive.
 *
 * No DOM or native imports, so both sides share one definition and it is testable in node.
 */

/**
 * Bytes pulled per request by default. Larger than a filesystem block because every request is a
 * bridge round trip with a base64 encode/decode on each side, so fewer, bigger reads win.
 */
export const RANGE_CHUNK_SIZE = 256 * 1024

/**
 * Hard ceiling on a single transfer in either direction. The reader is a WebView-callable RPC, so it
 * needs a bound that does not depend on the caller behaving. A property of the bridge, not of any
 * file format — every viewer gets the same one.
 */
export const MAX_RANGE_LENGTH = 2 * 1024 * 1024

/**
 * Total bytes one document may pull before the reader refuses, as a multiple of its length. Reads are
 * synchronous on the JS thread, so an unbounded caller stalls the whole app rather than just its own
 * WebView. Four times the file length leaves room for a viewer to re-read regions it has evicted
 * while still bounding abuse.
 */
export const CUMULATIVE_READ_FACTOR = 4

/** Reads `length` bytes at `offset` and returns them base64-encoded. */
export type RangeReader = (offset: number, length: number) => Promise<string>

/** Appends one base64 chunk to the write target. */
export type ChunkWriter = (chunk: string) => Promise<void>

/**
 * Why a range request was refused. A closed set so the caller cannot leak a message built from
 * document-controlled values, and so each rejection is assertable in a test.
 */
export type RangeRejection = "notInteger" | "offsetOutOfRange" | "lengthOutOfBounds" | "exceedsFile" | "cumulativeLimit"

/**
 * Bounds for one read from the WebView-callable range reader.
 *
 * Kept separate from the hook so it is testable without a filesystem: this is the security boundary
 * for the only function a viewer can call into, and "reviewed by eye" is not a sufficient guarantee
 * for something a hostile document can invoke at will.
 *
 * Rejects, never clamps. A short read looks like a truncated file to whatever is parsing it, so
 * clamping would convert a bounds bug into a lie about the file's contents.
 */
export function checkRangeRequest({
	offset,
	length,
	size,
	bytesRead,
	cumulativeLimit
}: {
	offset: number
	length: number
	size: number
	bytesRead: number
	cumulativeLimit: number
}): RangeRejection | null {
	if (!Number.isInteger(offset) || !Number.isInteger(length)) {
		return "notInteger"
	}

	if (offset < 0 || offset >= size) {
		return "offsetOutOfRange"
	}

	if (length <= 0 || length > MAX_RANGE_LENGTH) {
		return "lengthOutOfBounds"
	}

	if (offset + length > size) {
		return "exceedsFile"
	}

	// Reads are synchronous on the JS thread, so an unbounded caller stalls the whole app rather than
	// just the WebView. This is the one bound that does not follow from the others.
	if (bytesRead + length > cumulativeLimit) {
		return "cumulativeLimit"
	}

	return null
}

/** Leading bytes of a PDF. */
export const PDF_MAGIC = "%PDF-"

/** Leading bytes of a zip local file header — what an OOXML (.docx) container starts with. */
export const ZIP_MAGIC = "PK"

/**
 * True when a file's leading bytes are the expected signature. Checked before a viewer is handed the
 * file so a mislabelled one is refused with an honest message instead of surfacing as a parse error
 * from deep inside a rendering library.
 */
export function hasMagic(header: string, magic: string): boolean {
	return header === magic
}

/**
 * Chars per String.fromCharCode.apply call when encoding. Applying it to a whole 2 MiB chunk blows
 * the argument limit; a per-char loop is correct but markedly slower on both engines.
 */
const BASE64_ENCODE_STRIDE = 8192

/** base64 -> bytes. WebView side: `atob` is a DOM global. */
export function base64ToBytes(encoded: string): Uint8Array {
	const binary = atob(encoded)
	const bytes = new Uint8Array(binary.length)

	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index)
	}

	return bytes
}

/** bytes -> base64. WebView side: `btoa` is a DOM global. */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = ""

	for (let offset = 0; offset < bytes.length; offset += BASE64_ENCODE_STRIDE) {
		binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(offset, offset + BASE64_ENCODE_STRIDE)))
	}

	return btoa(binary)
}

export type TransferOptions = {
	/** Polled between chunks so an unmount stops the pull instead of finishing it into a dead view. */
	isCancelled?: () => boolean
	/** Bytes so far / total, after each chunk. */
	onProgress?: (bytesTransferred: number, total: number) => void
	chunkSize?: number
}

/**
 * Pulls a whole file across the bridge. Returns null if cancelled part-way.
 *
 * Peak cost is the file plus one chunk: the destination is allocated up front and each chunk is
 * copied straight into it, so there is never a second full copy the way a concatenate-then-decode
 * would produce.
 */
export async function readAllBytes(read: RangeReader, size: number, options: TransferOptions = {}): Promise<Uint8Array | null> {
	const { isCancelled, onProgress, chunkSize = RANGE_CHUNK_SIZE } = options
	const bytes = new Uint8Array(size)
	let offset = 0

	while (offset < size) {
		if (isCancelled?.()) {
			return null
		}

		const length = Math.min(chunkSize, MAX_RANGE_LENGTH, size - offset)
		const chunk = base64ToBytes(await read(offset, length))

		// The reader rejects rather than clamps, so a short chunk means the file changed under us.
		// Continuing would silently assemble a file with a hole in it.
		if (chunk.byteLength !== length) {
			throw new Error("short read")
		}

		bytes.set(chunk, offset)

		offset += length

		onProgress?.(offset, size)
	}

	return bytes
}

/**
 * Pulls a whole file across the bridge and decodes it as UTF-8. Returns null if cancelled part-way.
 *
 * Decodes incrementally rather than assembling the bytes first, so the peak is the string plus one
 * chunk instead of the string plus the whole file. `stream: true` is what makes that safe: a
 * multi-byte character straddling a chunk boundary is held back until its remaining bytes arrive.
 *
 * Lossy by construction (the decoder is non-fatal), which matches the web app: valid text is
 * unchanged and undecodable input yields U+FFFD, for the binary-content gate to catch.
 */
export async function readAllText(read: RangeReader, size: number, options: TransferOptions = {}): Promise<string | null> {
	const { isCancelled, onProgress, chunkSize = RANGE_CHUNK_SIZE } = options
	const decoder = new TextDecoder("utf-8")
	let text = ""
	let offset = 0

	while (offset < size) {
		if (isCancelled?.()) {
			return null
		}

		const length = Math.min(chunkSize, MAX_RANGE_LENGTH, size - offset)
		const chunk = base64ToBytes(await read(offset, length))

		if (chunk.byteLength !== length) {
			throw new Error("short read")
		}

		text += decoder.decode(chunk, {
			stream: true
		})

		offset += length

		onProgress?.(offset, size)
	}

	// Flush any incomplete trailing sequence to a replacement character.
	return text + decoder.decode()
}

/**
 * Streams bytes back to the native side. Returns false if cancelled part-way.
 *
 * The mirror of the reader, and bounded for the same reason — the WebView decides when and how much
 * to send, so the chunk size is capped here and re-checked by the write target on arrival.
 */
export async function writeAllBytes(bytes: Uint8Array, write: ChunkWriter, options: TransferOptions = {}): Promise<boolean> {
	const { isCancelled, onProgress, chunkSize = MAX_RANGE_LENGTH } = options
	const stride = Math.min(chunkSize, MAX_RANGE_LENGTH)

	for (let offset = 0; offset < bytes.byteLength; offset += stride) {
		if (isCancelled?.()) {
			return false
		}

		await write(bytesToBase64(bytes.subarray(offset, Math.min(offset + stride, bytes.byteLength))))

		onProgress?.(Math.min(offset + stride, bytes.byteLength), bytes.byteLength)
	}

	return true
}
