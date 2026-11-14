import { AudioSample, CustomAudioDecoder, type EncodedPacket } from "mediabunny"
import { crc8 } from "@/workers/remux/tailWindow.logic"

// Synthetic MP3, ADTS and FLAC streams for the edge analysis: real frame headers the demuxers walk, whose
// payload bytes all carry one level code (the frame's level in -dB; SILENT and above is digital silence), and a
// stand-in decoder that turns each packet into a constant stereo sample at that level. A level code never is
// 0xff, so no payload byte can pass for a sync word.

export const SILENT = 200
export const RATE = 44_100

export function amplitudeOf(code: number): number {
	return code >= SILENT ? 0 : 10 ** (-code / 20)
}

// The level the analysis tests play: silence, then -6 dB, then a fade (linear in dB) to -70 dB, then silence.
export interface LevelShape {
	durationSec: number
	leadSec: number
	fadeFromEndSec: number
	trailSec: number
}

export const SHAPE: LevelShape = { durationSec: 90, leadSec: 1.5, fadeFromEndSec: 13, trailSec: 3 }

export function levelCode(time: number, shape: LevelShape = SHAPE): number {
	const fadeStart = shape.durationSec - shape.fadeFromEndSec
	const fadeEnd = shape.durationSec - shape.trailSec

	if (time < shape.leadSec || time >= fadeEnd) {
		return SILENT
	}

	if (time < fadeStart) {
		return 6
	}

	return Math.round(6 + (64 * (time - fadeStart)) / (fadeEnd - fadeStart))
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let offset = 0

	for (const part of parts) {
		out.set(part, offset)
		offset += part.length
	}

	return out
}

// MPEG-1 Layer III, 320 kbps, 44.1 kHz, stereo, no padding: 1044 bytes and 1152 samples a frame.
export const MP3_FRAME_BYTES = 1044
export const MP3_HEADER = [0xff, 0xfb, 0xe0, 0x00]

export function mp3Frame(code: number): Uint8Array {
	const frame = new Uint8Array(MP3_FRAME_BYTES).fill(code)

	frame.set(MP3_HEADER)

	return frame
}

// An ID3v2.4 tag of `size` bytes of padding.
export function id3Tag(size: number): Uint8Array {
	const out = new Uint8Array(10 + size)

	out.set([0x49, 0x44, 0x33, 4, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f])

	return out
}

export function mp3File(shape: LevelShape = SHAPE): Uint8Array {
	const seconds = 1152 / RATE
	const count = Math.round(shape.durationSec / seconds)

	return concat([id3Tag(118), ...Array.from({ length: count }, (_, i) => mp3Frame(levelCode(i * seconds, shape)))])
}

// AAC LC in ADTS, 44.1 kHz, stereo: 1024 samples a frame.
export const ADTS_FRAME_BYTES = 930

export function adtsFrame(code: number, length = ADTS_FRAME_BYTES): Uint8Array {
	const frame = new Uint8Array(length).fill(code)

	frame.set([
		0xff,
		0xf1,
		(1 << 6) | (4 << 2),
		(2 << 6) | ((length >> 11) & 0x03),
		(length >> 3) & 0xff,
		((length & 0x07) << 5) | 0x1f,
		0xfc
	])

	return frame
}

export function adtsFile(shape: LevelShape = SHAPE): Uint8Array {
	const seconds = 1024 / RATE
	const count = Math.round(shape.durationSec / seconds)

	return concat(Array.from({ length: count }, (_, i) => adtsFrame(levelCode(i * seconds, shape))))
}

// FLAC, 44.1 kHz, stereo, 16 bit, fixed 4096-sample blocks.
export const FLAC_BLOCK = 4096
export const FLAC_FRAME_BYTES = 6000

function codedNumber(value: number): number[] {
	if (value < 0x80) {
		return [value]
	}

	if (value < 0x800) {
		return [0xc0 | (value >> 6), 0x80 | (value & 0x3f)]
	}

	return [0xe0 | (value >> 12), 0x80 | ((value >> 6) & 0x3f), 0x80 | (value & 0x3f)]
}

export function flacFrameHeader(frameNumber: number, options: { rateCode?: number; layout?: number } = {}): Uint8Array {
	const header = Uint8Array.from([0xff, 0xf8, 0xc0 | (options.rateCode ?? 9), options.layout ?? 0x18, ...codedNumber(frameNumber), 0])

	header[header.length - 1] = crc8(header, 0, header.length - 1)

	return header
}

export function flacFrame(frameNumber: number, code: number): Uint8Array {
	const frame = new Uint8Array(FLAC_FRAME_BYTES).fill(code)

	frame.set(flacFrameHeader(frameNumber))

	return frame
}

export function streamInfo(totalSamples: number): Uint8Array {
	const packed = (BigInt(RATE) << 44n) | (1n << 41n) | (15n << 36n) | BigInt(totalSamples)
	const out = new Uint8Array(34)

	out.set([0x10, 0x00, 0x10, 0x00])

	for (let i = 0; i < 8; i++) {
		out[10 + i] = Number((packed >> BigInt((7 - i) * 8)) & 0xffn)
	}

	return out
}

export function flacFile(shape: LevelShape = SHAPE): Uint8Array {
	const seconds = FLAC_BLOCK / RATE
	const count = Math.round(shape.durationSec / seconds)
	// A picture block ahead of the frames, which the tail window leaves out.
	const picture = new Uint8Array(5000)

	return concat([
		Uint8Array.from([0x66, 0x4c, 0x61, 0x43, 0x00, 0, 0, 34]),
		streamInfo(count * FLAC_BLOCK),
		Uint8Array.from([0x80 | 6, (picture.length >> 16) & 0xff, (picture.length >> 8) & 0xff, picture.length & 0xff]),
		picture,
		...Array.from({ length: count }, (_, i) => flacFrame(i, levelCode(i * seconds, shape)))
	])
}

const SAMPLES_PER_PACKET: Record<string, number> = { mp3: 1152, aac: 1024, flac: FLAC_BLOCK }

// Decodes each packet into constant stereo audio at the level its last byte names.
export class LevelDecoder extends CustomAudioDecoder {
	public static override supports(codec: string): boolean {
		return codec in SAMPLES_PER_PACKET
	}

	public init(): void {
		return undefined
	}

	public decode(packet: EncodedPacket): void {
		const frames = SAMPLES_PER_PACKET[this.codec] ?? 1024
		const data = new Float32Array(frames * 2).fill(amplitudeOf(packet.data[packet.data.length - 1] ?? SILENT))

		this.onSample(new AudioSample({ data, format: "f32-planar", numberOfChannels: 2, sampleRate: RATE, timestamp: packet.timestamp }))
	}

	public flush(): void {
		return undefined
	}

	public close(): void {
		return undefined
	}
}

// A 16-bit PCM WAV of a 1 kHz tone at 8 kHz, its amplitude following `levelCode`.
export function wavFile(shape: LevelShape = SHAPE, channels = 1): Uint8Array {
	const rate = 8000
	const frames = Math.round(shape.durationSec * rate)
	const dataBytes = frames * channels * 2
	const out = new Uint8Array(44 + dataBytes)
	const view = new DataView(out.buffer)
	const text = (at: number, value: string): void => {
		out.set(new TextEncoder().encode(value), at)
	}

	text(0, "RIFF")
	view.setUint32(4, 36 + dataBytes, true)
	text(8, "WAVE")
	text(12, "fmt ")
	view.setUint32(16, 16, true)
	view.setUint16(20, 1, true)
	view.setUint16(22, channels, true)
	view.setUint32(24, rate, true)
	view.setUint32(28, rate * channels * 2, true)
	view.setUint16(32, channels * 2, true)
	view.setUint16(34, 16, true)
	text(36, "data")
	view.setUint32(40, dataBytes, true)

	for (let i = 0; i < frames; i++) {
		// A peak of √2 × the level's amplitude, so the tone's mean square is the level's.
		const value = Math.SQRT2 * amplitudeOf(levelCode(i / rate, shape)) * Math.sin((2 * Math.PI * 1000 * i) / rate)

		for (let channel = 0; channel < channels; channel++) {
			view.setInt16(44 + (i * channels + channel) * 2, Math.round(Math.max(-1, Math.min(1, value)) * 32767), true)
		}
	}

	return out
}
