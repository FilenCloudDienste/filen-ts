// Whether an ICC profile's red primary lies outside sRGB's, read from its rXYZ tag (ICC.1 §9.2.44, an XYZType of
// s15Fixed16 values, PCS-adapted to D50). sRGB's red X is about 0.436; Display P3's 0.515, Adobe RGB's 0.610. Such a
// source previews on a Display P3 drawing buffer, which shows its colours closer than sRGB can; the export is
// unaffected (raw values, the profile carried verbatim). A raw profile only: PNG iCCP data (zlib) answers false.
const SRGB_RED_X_LIMIT = 0.47

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

function readTag(bytes: Uint8Array, at: number): string {
	return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0)
}
