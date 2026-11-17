import { mpegAudioHeader } from "@filen/shared/videos"

// A duration for a raw audio stream whose header states none (ADTS never does; MP3 does only through a
// Xing frame count): the stream's size over the byte rate of the frames at its start. Exact for a
// constant bitrate; for a variable one an estimate the MediaSource corrects when the stream ends.

export type FrameStream = "mp3" | "adts"

// The fewest frames whose byte rate stands for the stream's.
const MIN_FRAMES = 8

export const ID3V2_HEADER_BYTES = 10

// The size of the ID3v2 tag starting `head` (its header included), or 0 when none starts there.
export function id3v2Bytes(head: Uint8Array): number {
	if (head.length < ID3V2_HEADER_BYTES || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) {
		return 0
	}

	let size = 0

	for (let i = 6; i < 10; i++) {
		const byte = head[i] ?? 0x80

		if (byte >= 0x80) {
			return 0
		}

		size = size * 128 + byte
	}

	return ID3V2_HEADER_BYTES + size + (((head[5] ?? 0) & 0x10) !== 0 ? ID3V2_HEADER_BYTES : 0)
}

export interface Frame {
	bytes: number
	samples: number
	rate: number
	// What a following frame of the same stream must match.
	shape: number
	// Byte offset of a Xing/Info/VBRI tag's identifier, for MP3.
	tagAt: number | null
}

function mpegFrame(bytes: Uint8Array, at: number): Frame | null {
	const header = mpegAudioHeader(bytes, at)

	// A free-format frame states no length to step to the next by.
	const frameBytes = header === null ? null : header.frameBytes

	if (header === null || frameBytes === null) {
		return null
	}

	return {
		bytes: frameBytes,
		samples: header.samples,
		rate: header.rate,
		shape: header.shape,
		tagAt: header.layer === 3 ? at + 4 + header.sideInfoBytes : null
	}
}

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]

function adtsFrame(bytes: Uint8Array, at: number): Frame | null {
	const b1 = bytes[at + 1] ?? 0
	const b2 = bytes[at + 2] ?? 0
	const rate = ADTS_RATES[(b2 >> 2) & 0x0f]
	const frameBytes = (((bytes[at + 3] ?? 0) & 0x03) << 11) | ((bytes[at + 4] ?? 0) << 3) | ((bytes[at + 5] ?? 0) >> 5)

	if (bytes[at] !== 0xff || (b1 & 0xf6) !== 0xf0 || rate === undefined || frameBytes < 7) {
		return null
	}

	return { bytes: frameBytes, samples: 1024 * (((bytes[at + 6] ?? 0) & 0x03) + 1), rate, shape: (b1 << 8) | (b2 & 0xfc), tagAt: null }
}

// The MPEG audio or ADTS frame header at `at`, or null where none starts.
export function frameAt(stream: FrameStream, bytes: Uint8Array, at: number): Frame | null {
	return stream === "mp3" ? mpegFrame(bytes, at) : adtsFrame(bytes, at)
}

function isTagFrame(bytes: Uint8Array, frame: Frame, at: number): boolean {
	const ids = [frame.tagAt, at + 36]

	return ids.some(
		id =>
			id !== null &&
			["Xing", "Info", "VBRI"].includes(
				String.fromCharCode(bytes[id] ?? 0, bytes[id + 1] ?? 0, bytes[id + 2] ?? 0, bytes[id + 3] ?? 0)
			)
	)
}

// `bytes`: the stream's first bytes (after any ID3v2 tags), `size` bytes of stream in all. Seconds, or
// null when too few frames line up to tell.
export function estimateFrameStreamDuration(params: { stream: FrameStream; bytes: Uint8Array; size: number }): number | null {
	const { bytes, size } = params
	const read = params.stream === "mp3" ? mpegFrame : adtsFrame
	// A frame counts only where the next one follows it, or the stream ends with it: a sync word alone
	// is two bytes any data can hold.
	const fits = (frame: Frame, at: number): boolean => {
		const next = at + frame.bytes

		return next === size || (next + 4 <= bytes.length && read(bytes, next)?.shape === frame.shape)
	}

	for (let at = 0; at + 7 <= bytes.length; at++) {
		const first = read(bytes, at)

		if (first === null || !fits(first, at)) {
			continue
		}

		// The first frame of a Xing/VBRI stream holds no audio; its bytes start the audio all the same.
		let position = params.stream === "mp3" && isTagFrame(bytes, first, at) ? at + first.bytes : at
		const start = position
		let frames = 0
		let seconds = 0

		for (let frame = read(bytes, position); frame !== null && position + frame.bytes <= bytes.length; frame = read(bytes, position)) {
			if (frame.shape !== first.shape) {
				break
			}

			frames++
			seconds += frame.samples / frame.rate
			position += frame.bytes
		}

		if (position === size) {
			return seconds
		}

		return frames < MIN_FRAMES ? null : ((size - start) * seconds) / (position - start)
	}

	return null
}
