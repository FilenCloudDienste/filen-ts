import { MsgError } from "./errors"

// [MS-OXRTFCP] Compressed RTF: a 16-byte header (§2.1.3.1.1: compressed size, raw size, type, CRC), then runs of
// a control byte and eight literals or dictionary references (§2.1.3.1.4), over a 4096-byte ring dictionary preloaded
// with the string below (§3.1.3.1). The CRC is not checked: a damaged body still shows what decompresses.

const COMPRESSED = 0x75465a4c // "LZFu"
const UNCOMPRESSED = 0x414c454d // "MELA"
const HEADER = 16
const DICTIONARY = 4096
const PRELOAD =
	"{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx"
// A control byte and eight references (2 bytes each, up to 17 bytes out each): no run expands more than this.
const RUN_IN = 17
const RUN_OUT = 8 * 17

export const LZFU_PRELOAD_LENGTH = PRELOAD.length

// The RTF in a PidTagRtfCompressed value. Output stops at `maxSize` bytes (past it: MsgError "tooLarge") and at the
// header's raw size, and the buffer is sized by what the input can expand to, so a header naming a huge size
// allocates nothing it cannot fill. One pass over the input.
export function decompressRtf(bytes: Uint8Array, maxSize: number): Uint8Array {
	if (bytes.length < HEADER) throw new MsgError("corrupt", "The compressed RTF header is cut short")

	const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const compressedSize = data.getUint32(0, true)
	const rawSize = data.getUint32(4, true)
	const type = data.getUint32(8, true)

	if (rawSize > maxSize) throw new MsgError("tooLarge", "The RTF body is larger than the limit")

	const end = Math.min(bytes.length, 4 + compressedSize)

	if (type === UNCOMPRESSED) return bytes.subarray(HEADER, Math.min(end, HEADER + rawSize))
	if (type !== COMPRESSED) throw new MsgError("corrupt", "Unknown compressed RTF type")

	const dictionary = new Uint8Array(DICTIONARY)

	for (let k = 0; k < PRELOAD.length; k++) dictionary[k] = PRELOAD.charCodeAt(k)

	const out = new Uint8Array(Math.min(rawSize, Math.ceil(Math.max(0, end - HEADER) / RUN_IN) * RUN_OUT))
	let write = PRELOAD.length
	let length = 0
	let at = HEADER

	while (at < end && length < out.length) {
		const control = bytes[at++] as number

		for (let bit = 0; bit < 8 && at < end && length < out.length; bit++) {
			if ((control & (1 << bit)) === 0) {
				const byte = bytes[at++] as number

				out[length++] = byte
				dictionary[write] = byte
				write = (write + 1) & (DICTIONARY - 1)
				continue
			}

			if (at + 1 >= end) return out.subarray(0, length)

			const reference = ((bytes[at] as number) << 8) | (bytes[at + 1] as number)
			const offset = reference >> 4
			const count = (reference & 0xf) + 2

			at += 2

			// A reference to the write position ends the stream.
			if (offset === write) return out.subarray(0, length)

			for (let k = 0; k < count && length < out.length; k++) {
				const byte = dictionary[(offset + k) & (DICTIONARY - 1)] as number

				out[length++] = byte
				dictionary[write] = byte
				write = (write + 1) & (DICTIONARY - 1)
			}
		}
	}

	return out.subarray(0, length)
}
