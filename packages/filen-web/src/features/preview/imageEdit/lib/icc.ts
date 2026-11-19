// Whether an ICC profile's red primary lies outside sRGB's, read from its rXYZ tag (ICC.1 §9.2.44, an XYZType of
// s15Fixed16 values, PCS-adapted to D50). sRGB's red X is about 0.436; Display P3's 0.515, Adobe RGB's 0.610. Such a
// source previews on a Display P3 drawing buffer, which shows its colours closer than sRGB can; the export is
// unaffected (raw values, the profile carried verbatim). A raw profile only: PNG iCCP data goes through
// isWideGamutPngIccp.
const SRGB_RED_X_LIMIT = 0.47

// Past this an iCCP stream is not inflated: a few kilobytes can inflate to gigabytes, and a real profile is far smaller.
export const MAX_PNG_ICC_BYTES = 4 * 1024 * 1024

export function isWideGamutIcc(icc: Uint8Array | null): boolean {
	if (icc === null || icc.length < 132 || readTag(icc, 36) !== "acsp") {
		return false
	}

	const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength)
	const count = view.getUint32(128)

	for (let entry = 0; entry < count; entry++) {
		const at = 132 + entry * 12

		if (at + 12 > icc.length) {
			return false
		}

		if (readTag(icc, at) !== "rXYZ") {
			continue
		}

		const offset = view.getUint32(at + 4)

		if (offset + 20 > icc.length || readTag(icc, offset) !== "XYZ ") {
			return false
		}

		return view.getInt32(offset + 8) / 65536 > SRGB_RED_X_LIMIT
	}

	return false
}

// The same answer for a PNG's raw iCCP chunk data (PNG §11.3.3.3): a 1-79 byte name, its terminator, compression
// method 0, then the profile as a zlib stream. Inflated for the check only; anything malformed or past the cap is
// not wide gamut.
export async function isWideGamutPngIccp(data: Uint8Array, maxBytes = MAX_PNG_ICC_BYTES): Promise<boolean> {
	const nameEnd = data.indexOf(0)

	if (nameEnd < 1 || nameEnd > 79 || data[nameEnd + 1] !== 0) {
		return false
	}

	try {
		const reader = new Blob([data.slice(nameEnd + 2)]).stream().pipeThrough(new DecompressionStream("deflate")).getReader()
		const chunks: Uint8Array[] = []
		let total = 0

		for (;;) {
			const { done, value } = await reader.read()

			if (done) {
				break
			}

			total += value.byteLength

			if (total > maxBytes) {
				await reader.cancel()

				return false
			}

			chunks.push(value)
		}

		const profile = new Uint8Array(total)
		let at = 0

		for (const chunk of chunks) {
			profile.set(chunk, at)
			at += chunk.byteLength
		}

		return isWideGamutIcc(profile)
	} catch {
		return false
	}
}

function readTag(bytes: Uint8Array, at: number): string {
	return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0)
}
