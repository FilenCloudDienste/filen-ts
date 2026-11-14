import { frameAt, type FrameStream } from "@/workers/remux/audioDuration.logic"

// The last seconds of an MP3, ADTS or FLAC stream, reached by byte offset. Their demuxers index frames from the
// start of the file, so a seek to the tail through them reads the whole file; a window cut at an estimated offset
// and resynced to the first real frame header decodes on its own instead. Times in the window count back from
// the end of the file, so no absolute timestamp (nor a constant bitrate) is needed.

// The streams whose tail is read by byte offset.
export type TailStream = FrameStream | "flac"

// The window is cut this much longer than asked for: a bitrate higher at the end than on average still covers it.
export const TAIL_PADDING = 1.1

// How far past the cut a frame header is looked for: a few dozen MPEG or ADTS frames, a few FLAC frames.
export const RESYNC_BYTES = 131_072

// Frames after a candidate MPEG or ADTS header that must follow it, each at the length the one before declares.
const CHAINED_FRAMES = 2

// The byte rate of the stream's audio over its whole length.
function byteRate(params: { size: number; audioStart: number; duration: number }): number {
	return Math.max(0, params.size - params.audioStart) / params.duration
}

// Where a window holding the last `seconds` of audio starts, padded: never before the audio itself.
export function tailWindowOffset(params: { size: number; audioStart: number; duration: number; seconds: number }): number {
	const bytes = Math.ceil(params.seconds * byteRate(params) * TAIL_PADDING)

	return Math.max(params.audioStart, params.size - bytes)
}

// The bytes a head window of `headSeconds` and a padded tail window of `tailSeconds` take, together, by the
// average byte rate; never more than the audio itself.
export function edgeWindowBytes(params: {
	size: number
	audioStart: number
	duration: number
	headSeconds: number
	tailSeconds: number
}): number {
	const audio = Math.max(0, params.size - params.audioStart)

	return Math.min(audio, Math.ceil((params.headSeconds + params.tailSeconds * TAIL_PADDING) * byteRate(params)))
}

// The first MPEG audio or ADTS frame at or after `from` that the next frames confirm: a sync word alone is
// two bytes any data can hold. `shape` (the stream's version, layer and rate, from a frame of its head) rejects
// a header of another kind; `atEnd` says `bytes` ends where the file does, so a chain may end with it.
export function syncFrameStream(
	bytes: Uint8Array,
	from: number,
	stream: FrameStream,
	shape: number | null,
	atEnd: boolean
): { at: number; shape: number } | null {
	for (let at = Math.max(0, from); at + 7 <= bytes.length; at++) {
		if (bytes[at] !== 0xff) {
			continue
		}

		const frame = frameAt(stream, bytes, at)

		if (frame === null || (shape !== null && frame.shape !== shape) || !chained(bytes, at + frame.bytes, stream, frame.shape, atEnd)) {
			continue
		}

		return { at, shape: frame.shape }
	}

	return null
}

function chained(bytes: Uint8Array, next: number, stream: FrameStream, shape: number, atEnd: boolean): boolean {
	let at = next

	for (let i = 0; i < CHAINED_FRAMES; i++) {
		if (at === bytes.length && atEnd) {
			return true
		}

		const frame = at + 7 <= bytes.length ? frameAt(stream, bytes, at) : null

		if (frame?.shape !== shape) {
			return false
		}

		at += frame.bytes
	}

	return true
}

// ── FLAC ────────────────────────────────────────────────────────────────────

export const FLAC_MAGIC = [0x66, 0x4c, 0x61, 0x43]
export const STREAMINFO_BYTES = 34
export const METADATA_HEADER_BYTES = 4
const STREAMINFO_TYPE = 0

export interface FlacStreamInfo {
	sampleRate: number
	channels: number
}

export interface FlacMetadataBlock {
	last: boolean
	type: number
	size: number
}

export function isFlacMagic(bytes: Uint8Array): boolean {
	return FLAC_MAGIC.every((byte, i) => bytes[i] === byte)
}

// A metadata block's 4-byte header: the last-block flag, the type and the size of what follows.
export function flacMetadataBlock(bytes: Uint8Array): FlacMetadataBlock | null {
	if (bytes.length < METADATA_HEADER_BYTES) {
		return null
	}

	const first = bytes[0] ?? 0

	return { last: (first & 0x80) !== 0, type: first & 0x7f, size: ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0) }
}

export function isStreamInfoBlock(block: FlacMetadataBlock): boolean {
	return block.type === STREAMINFO_TYPE && block.size >= STREAMINFO_BYTES
}

// The rate and channel count a STREAMINFO block's 34 bytes state; null for a rate of 0.
export function flacStreamInfo(block: Uint8Array): FlacStreamInfo | null {
	if (block.length < STREAMINFO_BYTES) {
		return null
	}

	const sampleRate = ((block[10] ?? 0) << 12) | ((block[11] ?? 0) << 4) | ((block[12] ?? 0) >> 4)
	const channels = (((block[12] ?? 0) >> 1) & 0x07) + 1

	return sampleRate === 0 ? null : { sampleRate, channels }
}

// What a window of frames is prefixed with to read as a FLAC file of its own: the magic and the stream's
// STREAMINFO block, flagged as the last metadata block. The other blocks (tags, pictures of any size) are left out.
export function flacVirtualHeader(streamInfo: Uint8Array): Uint8Array {
	const out = new Uint8Array(FLAC_MAGIC.length + METADATA_HEADER_BYTES + STREAMINFO_BYTES)

	out.set(FLAC_MAGIC, 0)
	out.set([0x80 | STREAMINFO_TYPE, 0, 0, STREAMINFO_BYTES], FLAC_MAGIC.length)
	out.set(streamInfo.subarray(0, STREAMINFO_BYTES), FLAC_MAGIC.length + METADATA_HEADER_BYTES)

	return out
}

// Frame header rates by their 4-bit code (0: STREAMINFO's; 12-14: stated after the header; 15: invalid).
const FLAC_RATES = [0, 88_200, 176_400, 192_000, 8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 96_000]

// CRC-8 with polynomial x^8 + x^2 + x + 1, as FLAC frame headers carry it.
export function crc8(bytes: Uint8Array, start: number, end: number): number {
	let crc = 0

	for (let i = start; i < end; i++) {
		crc ^= bytes[i] ?? 0

		for (let bit = 0; bit < 8; bit++) {
			crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
		}
	}

	return crc
}

// The length of the coded frame or sample number starting at `at` (UTF-8's scheme, up to 7 bytes), or null.
function codedNumberLength(bytes: Uint8Array, at: number): number | null {
	const first = bytes[at] ?? 0xff
	let length = 1

	if (first >= 0x80) {
		length = Math.clz32(~first << 24)

		if (length < 2 || length > 7) {
			return null
		}
	}

	for (let i = 1; i < length; i++) {
		if (((bytes[at + i] ?? 0) & 0xc0) !== 0x80) {
			return null
		}
	}

	return length
}

// The length of a FLAC frame header at `at` that matches the stream, its CRC-8 checked; null for anything else
// (a sync word inside audio data, another stream's header, a cut-off header).
export function flacFrameHeaderLength(bytes: Uint8Array, at: number, info: FlacStreamInfo): number | null {
	if (bytes[at] !== 0xff || ((bytes[at + 1] ?? 0) & 0xfe) !== 0xf8 || at + 6 > bytes.length) {
		return null
	}

	const sizes = bytes[at + 2] ?? 0
	const blockCode = sizes >> 4
	const rateCode = sizes & 0x0f
	const layout = bytes[at + 3] ?? 0
	const channelCode = layout >> 4
	const depthCode = (layout >> 1) & 0x07

	if (blockCode === 0 || rateCode === 15 || channelCode > 10 || depthCode === 3 || (layout & 0x01) !== 0) {
		return null
	}

	if ((channelCode < 8 ? channelCode + 1 : 2) !== info.channels) {
		return null
	}

	const coded = codedNumberLength(bytes, at + 4)

	if (coded === null) {
		return null
	}

	let end = at + 4 + coded

	end += blockCode === 6 ? 1 : blockCode === 7 ? 2 : 0

	const rateAt = end

	end += rateCode === 12 ? 1 : rateCode === 13 || rateCode === 14 ? 2 : 0

	if (end + 1 > bytes.length) {
		return null
	}

	const stated =
		rateCode === 0
			? info.sampleRate
			: rateCode === 12
				? (bytes[rateAt] ?? 0) * 1000
				: rateCode === 13
					? ((bytes[rateAt] ?? 0) << 8) | (bytes[rateAt + 1] ?? 0)
					: rateCode === 14
						? (((bytes[rateAt] ?? 0) << 8) | (bytes[rateAt + 1] ?? 0)) * 10
						: FLAC_RATES[rateCode]

	if (stated !== info.sampleRate || crc8(bytes, at, end) !== bytes[end]) {
		return null
	}

	return end + 1 - at
}

// The first FLAC frame header at or after `from`.
export function syncFlacFrame(bytes: Uint8Array, from: number, info: FlacStreamInfo): number | null {
	for (let at = Math.max(0, from); at + 6 <= bytes.length; at++) {
		if (bytes[at] === 0xff && flacFrameHeaderLength(bytes, at, info) !== null) {
			return at
		}
	}

	return null
}
