import { parseAvcSps, parseHevcSps } from "./codecString"
import { annexBNal } from "./probeElementary"

// How many frames of an H.264 or HEVC stream can precede a frame in decode order and follow it in presentation order,
// from its sequence parameter set: the configuration record's (avcC, hvcC), else the one an Annex B key picture
// carries in band. Null for another codec, or no SPS that says.

const isAvcSps = (header: number): boolean => (header & 0x1f) === 7
const isHevcSps = (header: number): boolean => ((header >> 1) & 0x3f) === 33

// The first SPS NAL unit of an AVCDecoderConfigurationRecord.
function avcCSps(avcC: Uint8Array): Uint8Array | null {
	if (avcC[0] !== 1 || ((avcC[5] ?? 0) & 0x1f) === 0 || avcC.length < 8) {
		return null
	}

	const length = ((avcC[6] ?? 0) << 8) + (avcC[7] ?? 0)

	return 8 + length <= avcC.length ? avcC.subarray(8, 8 + length) : null
}

// The first SPS NAL unit of an HEVCDecoderConfigurationRecord.
function hvcCSps(hvcC: Uint8Array): Uint8Array | null {
	if (hvcC[0] !== 1 || hvcC.length < 23) {
		return null
	}

	let at = 23

	for (let array = 0; array < (hvcC[22] ?? 0) && at + 3 <= hvcC.length; array++) {
		const type = (hvcC[at] ?? 0) & 0x3f
		const count = ((hvcC[at + 1] ?? 0) << 8) + (hvcC[at + 2] ?? 0)

		at += 3

		for (let unit = 0; unit < count && at + 2 <= hvcC.length; unit++) {
			const length = ((hvcC[at] ?? 0) << 8) + (hvcC[at + 1] ?? 0)

			if (type === 33 && at + 2 + length <= hvcC.length) {
				return hvcC.subarray(at + 2, at + 2 + length)
			}

			at += 2 + length
		}
	}

	return null
}

export function videoReorderFrames(codec: string, config: Uint8Array | null, keyPicture: Uint8Array | null): number | null {
	if (codec === "avc") {
		const nal = (config === null ? null : avcCSps(config)) ?? (keyPicture === null ? null : annexBNal(keyPicture, isAvcSps))

		return nal === null ? null : (parseAvcSps(nal)?.reorderFrames ?? null)
	}

	if (codec === "hevc") {
		const nal = (config === null ? null : hvcCSps(config)) ?? (keyPicture === null ? null : annexBNal(keyPicture, isHevcSps))

		return nal === null ? null : (parseHevcSps(nal)?.reorderFrames ?? null)
	}

	return null
}
