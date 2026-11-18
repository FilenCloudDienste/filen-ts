import { Inflate } from "fflate"

// A deflated data set (PS3.5 A.5): the file meta group as stored, the rest raw deflate. dicom-parser's `inflater` must
// return the whole stream, header bytes included, so the header is kept in place and the rest inflated after it.

// Fed this much at a time: one push inflates to at most about 1032× its input (deflate's ceiling) before the running
// total is checked, so a bomb is stopped within about 16.5 MiB of the cap.
const PUSH_BYTES = 16 * 1024

export class DicomInflateCapError extends Error {
	override readonly name = "DicomInflateCapError"
}

// `bytes[0, position)` followed by the inflated rest, refused once the inflated part passes `cap` bytes. The result is
// held in a buffer reserved up to the cap and grown as it fills, so no copy of the whole is ever made.
export function inflateDataset(bytes: Uint8Array, position: number, cap: number): Uint8Array {
	if (position < 0 || position > bytes.length) {
		throw new RangeError("the data set starts outside the file")
	}

	const buffer = new ArrayBuffer(position, { maxByteLength: position + Math.max(0, cap) })
	let length = position

	new Uint8Array(buffer).set(bytes.subarray(0, position))

	const stream = new Inflate(chunk => {
		if (chunk.length === 0) return

		if (length - position + chunk.length > cap) {
			throw new DicomInflateCapError(`the data set inflates past ${String(cap)} bytes`)
		}

		buffer.resize(length + chunk.length)
		new Uint8Array(buffer, length, chunk.length).set(chunk)
		length += chunk.length
	})

	for (let at = position; at < bytes.length; at += PUSH_BYTES) {
		const end = Math.min(bytes.length, at + PUSH_BYTES)

		stream.push(bytes.subarray(at, end), end === bytes.length)
	}

	if (position === bytes.length) stream.push(new Uint8Array(0), true)

	return new Uint8Array(buffer, 0, length)
}
