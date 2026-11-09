// The lossless turn or flip of a JPEG: only its Exif Orientation changes, so the file streams from the download to
// the upload with its head (everything before the first scan) rewritten and the scan data passed through untouched.
// Import-free apart from types: the SDK worker runs it.

// Thrown by the SDK worker's rewrite when the head cannot be rewritten (too large, not a JPEG it can walk, the
// rewriter refused): the caller re-encodes instead.
export const ORIENTATION_REWRITE_UNAVAILABLE = "jpeg orientation rewrite unavailable"

// The most of a file held before its first scan; past it the head is not buffered and the caller re-encodes.
export const ORIENTATION_HEAD_MAX = 1024 * 1024

// Where the first SOS marker starts in `bytes[0..length)`: its offset, "more" when the walk needs bytes past
// `length`, or "invalid" for a stream that is not a JPEG the walk understands (ITU T.81 B.1.1: segments after SOI,
// each a marker and, except RSTn/TEM/SOI, a 2-byte big-endian length that counts itself).
export function jpegScanStart(bytes: Uint8Array, length: number): number | "more" | "invalid" {
	if (length < 2) {
		return "more"
	}

	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
		return "invalid"
	}

	let at = 2

	for (;;) {
		if (at >= length) {
			return "more"
		}

		if (bytes[at] !== 0xff) {
			return "invalid"
		}

		// Fill bytes before a marker (B.1.1.2).
		let marker = at + 1

		while (marker < length && bytes[marker] === 0xff) {
			marker++
		}

		if (marker >= length) {
			return "more"
		}

		const code = bytes[marker] ?? 0

		if (code === 0xda) {
			return at
		}

		if (code === 0x00 || code === 0xd8 || code === 0xd9) {
			return "invalid"
		}

		// Standalone markers carry no length.
		if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
			at = marker + 1

			continue
		}

		if (marker + 2 >= length) {
			return "more"
		}

		const segment = ((bytes[marker + 1] ?? 0) << 8) | (bytes[marker + 2] ?? 0)

		if (segment < 2) {
			return "invalid"
		}

		at = marker + 1 + segment
	}
}

// A stream that holds the bytes up to the first scan (at most `max`), hands them to `rewrite`, and sends its answer
// followed by everything else as it arrives. `refused()` tells a caller whose stream errored whether the head was
// the reason (the file is fine; re-encode it) rather than the transfer.
export function orientationRewriteStream(
	rewrite: (head: Uint8Array) => Uint8Array | null,
	max: number
): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; refused: () => boolean } {
	let held = new Uint8Array(0)
	let filled = 0
	let passing = false
	let refused = false
	const refuse = (): Error => {
		refused = true

		return new Error(ORIENTATION_REWRITE_UNAVAILABLE)
	}
	const stream = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			if (passing) {
				controller.enqueue(chunk)

				return
			}

			if (filled + chunk.length > held.length) {
				const grown = new Uint8Array(Math.min(Math.max(held.length * 2, filled + chunk.length, 64 * 1024), max + chunk.length))

				grown.set(held.subarray(0, filled))
				held = grown
			}

			held.set(chunk, filled)
			filled += chunk.length

			const scan = jpegScanStart(held, filled)

			if (scan === "invalid" || (scan === "more" && filled > max) || (typeof scan === "number" && scan > max)) {
				throw refuse()
			}

			if (scan === "more") {
				return
			}

			const head = rewrite(held.subarray(0, scan))

			if (head === null) {
				throw refuse()
			}

			passing = true
			controller.enqueue(head)
			controller.enqueue(held.slice(scan, filled))
			held = new Uint8Array(0)
		},
		flush() {
			// The file ended before any scan: nothing a viewer would show.
			if (!passing) {
				throw refuse()
			}
		}
	})

	return { readable: stream.readable, writable: stream.writable, refused: () => refused }
}
