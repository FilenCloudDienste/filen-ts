// A zip's central directory checked before anything inflates it. hucre caps each entry at the smaller of
// its declared uncompressed size and the limit it is given, so a small file with many large entries could
// still inflate without bound: the declared sizes are summed here, and an entry that could inflate past
// its declared size (a compressed entry declaring none, or sizes left to a data descriptor) is refused.
// Mirrors hucre's reader (zip/reader.mjs): the last end-of-central-directory record within the trailing
// 64 KiB, then its entries in order.

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const SENTINEL_32 = 0xffffffff
const SENTINEL_16 = 0xffff

export class ZipLimitError extends Error {}

export function checkZipLimits(bytes: Uint8Array, limits: { maxEntries: number; maxBytes: number }): void {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let eocd = -1

	for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
		if (view.getUint32(offset, true) === EOCD) {
			eocd = offset

			break
		}
	}

	if (eocd < 0) {
		throw new ZipLimitError("spreadsheet: not a zip")
	}

	const count = view.getUint16(eocd + 10, true)
	const directoryOffset = view.getUint32(eocd + 16, true)

	// A ZIP64 archive: more entries or bytes than any spreadsheet opened here.
	if (count === SENTINEL_16 || directoryOffset === SENTINEL_32 || view.getUint32(eocd + 12, true) === SENTINEL_32) {
		throw new ZipLimitError("spreadsheet: zip too large")
	}

	if (count > limits.maxEntries) {
		throw new ZipLimitError("spreadsheet: too many zip entries")
	}

	let position = directoryOffset
	let total = 0

	for (let entry = 0; entry < count; entry++) {
		if (position + 46 > bytes.length || view.getUint32(position, true) !== CENTRAL) {
			throw new ZipLimitError("spreadsheet: bad zip directory")
		}

		const flags = view.getUint16(position + 8, true)
		const method = view.getUint16(position + 10, true)
		const compressed = view.getUint32(position + 20, true)
		const uncompressed = view.getUint32(position + 24, true)

		if (compressed === SENTINEL_32 || uncompressed === SENTINEL_32) {
			throw new ZipLimitError("spreadsheet: zip too large")
		}

		// A stored entry is its compressed bytes, bounded by the file. A deflated one inflates up to its
		// declared size, unless it declares none, or leaves its sizes to a data descriptor (read from the
		// local header then).
		if (method === 8 && ((compressed > 0 && uncompressed === 0) || (compressed === 0 && (flags & 8) !== 0))) {
			throw new ZipLimitError("spreadsheet: zip entry without a size")
		}

		total += method === 0 ? compressed : uncompressed

		if (total > limits.maxBytes) {
			throw new ZipLimitError("spreadsheet: zip inflates too large")
		}

		position += 46 + view.getUint16(position + 28, true) + view.getUint16(position + 30, true) + view.getUint16(position + 32, true)
	}
}
