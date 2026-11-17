import { mp4aCodecString, parseAudioSpecificConfig, simpleAudioCodecString } from "./codecString"
import { AC3_CHANNELS, AC3_RATES } from "./probeIsobmff"
import type { MediaCodec } from "./probeTypes"

// PES packets (ISO/IEC 13818-1) and the elementary-stream headers inside them: MPEG audio, ADTS, AC-3/E-AC-3
// and DTS. Shared by the transport stream walker and the raw-audio duration estimate, so each header has
// one parser.

const NO_PES_HEADER = new Set([0xbc, 0xbe, 0xbf, 0xf0, 0xf1, 0xf2, 0xf8, 0xff])

// A 33-bit PTS/DTS in its five-byte PES encoding.
export function pesTimestamp(bytes: Uint8Array, at: number): number {
	return (
		(((bytes[at] ?? 0) >> 1) & 0x07) * 2 ** 30 +
		((bytes[at + 1] ?? 0) << 22) +
		(((bytes[at + 2] ?? 0) >> 1) << 15) +
		((bytes[at + 3] ?? 0) << 7) +
		((bytes[at + 4] ?? 0) >> 1)
	)
}

// A PES packet starting `payload`: its PTS and where its data begins; null when the payload starts no PES
// or its header runs past the payload.
export function pesStart(payload: Uint8Array): { pts: number | null; data: number } | null {
	if (payload.length < 9 || payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) {
		return null
	}

	if (NO_PES_HEADER.has(payload[3] ?? 0)) {
		return { pts: null, data: 6 }
	}

	if (((payload[6] ?? 0) & 0xc0) !== 0x80) {
		return null
	}

	const data = 9 + (payload[8] ?? 0)

	if (data > payload.length) {
		return null
	}

	return { pts: ((payload[7] ?? 0) & 0x80) !== 0 && data >= 14 ? pesTimestamp(payload, 9) : null, data }
}

export function readBits(bytes: Uint8Array, position: number, count: number): number {
	let value = 0

	for (let i = position; i < position + count; i++) {
		value = value * 2 + (((bytes[i >> 3] ?? 0) >> (7 - (i & 7))) & 1)
	}

	return value
}

export interface MpegAudioHeader {
	// MPEG-1, MPEG-2 or MPEG-2.5.
	version: 1 | 2 | 2.5
	layer: 1 | 2 | 3
	rate: number
	channels: 1 | 2
	samples: number
	// Null for a free-format frame, whose length its header does not state.
	frameBytes: number | null
	// Bytes of layer III side information after the four-byte header (zero for layers I and II).
	sideInfoBytes: number
	// The header bits every frame of one stream repeats: version, layer, protection and sample rate.
	shape: number
}

// kbps by [MPEG-1, MPEG-2/2.5] and layer (I, II, III); index 0 is free format.
const MPEG_BITRATES: readonly (readonly (readonly number[])[])[] = [
	[
		[0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
		[0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
		[0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
	],
	[
		[0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
		[0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
		[0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
	]
]
const MPEG_AUDIO_RATES = [44100, 48000, 32000]

// The MPEG-1/2/2.5 audio frame header (ISO/IEC 11172-3, 13818-3) at `at`; null where none starts, or for a
// reserved version, layer, bitrate or sample rate.
export function mpegAudioHeader(bytes: Uint8Array, at: number): MpegAudioHeader | null {
	const b1 = bytes[at + 1] ?? 0
	const b2 = bytes[at + 2] ?? 0
	const versionBits = (b1 >> 3) & 0x03
	const layerBits = (b1 >> 1) & 0x03
	const bitrateIndex = b2 >> 4
	const base = MPEG_AUDIO_RATES[(b2 >> 2) & 0x03]

	if (bytes[at] !== 0xff || (b1 & 0xe0) !== 0xe0 || versionBits === 1 || layerBits === 0 || bitrateIndex === 0x0f || base === undefined) {
		return null
	}

	const mpeg1 = versionBits === 3
	const layer = (4 - layerBits) as 1 | 2 | 3
	const rate = mpeg1 ? base : versionBits === 2 ? base / 2 : base / 4
	const kbps = MPEG_BITRATES[mpeg1 ? 0 : 1]?.[layer - 1]?.[bitrateIndex] ?? 0
	const padding = (b2 >> 1) & 0x01
	const samples = layer === 1 ? 384 : layer === 2 || mpeg1 ? 1152 : 576
	const mono = (bytes[at + 3] ?? 0) >> 6 === 3

	return {
		version: mpeg1 ? 1 : versionBits === 2 ? 2 : 2.5,
		layer,
		rate,
		channels: mono ? 1 : 2,
		samples,
		frameBytes:
			kbps === 0
				? null
				: layer === 1
					? (Math.floor((12 * kbps * 1000) / rate) + padding) * 4
					: Math.floor(((samples / 8) * kbps * 1000) / rate) + padding,
		sideInfoBytes: layer !== 3 ? 0 : mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17,
		shape: (b1 << 8) | (b2 & 0x0c)
	}
}

export interface AudioFormat {
	ch: number | null
	rate: number | null
	codec?: MediaCodec | null
	codecString?: string | null
}

// ADTS: the AudioSpecificConfig the header implies (object type = profile + 1).
export function adtsFormat(bytes: Uint8Array, at: number): AudioFormat | null {
	if (bytes[at] !== 0xff || ((bytes[at + 1] ?? 0) & 0xf6) !== 0xf0) {
		return null
	}

	const packed = bytes[at + 2] ?? 0
	const objectType = (packed >> 6) + 1
	const rateIndex = (packed >> 2) & 0x0f
	const channels = ((packed & 1) << 2) | ((bytes[at + 3] ?? 0) >> 6)

	if (rateIndex > 12) {
		return null
	}

	const config = Uint8Array.of((objectType << 3) | (rateIndex >> 1), ((rateIndex & 1) << 7) | (channels << 3))
	const parsed = parseAudioSpecificConfig(config)

	return {
		ch: parsed?.channels ?? null,
		rate: parsed?.sampleRate ?? null,
		codecString: mp4aCodecString({ objectTypeIndication: 0x40, audioSpecificConfig: config })
	}
}

// AC-3 (bsid ≤ 10) and E-AC-3 (11-16) sync frames: the main (or first independent) stream's channels.
export function dolbyFormat(bytes: Uint8Array, at: number): AudioFormat | null {
	if (bytes[at] !== 0x0b || bytes[at + 1] !== 0x77) {
		return null
	}

	const bsid = (bytes[at + 5] ?? 0) >> 3

	if (bsid <= 10) {
		const fscod = (bytes[at + 4] ?? 0) >> 6
		const acmod = (bytes[at + 6] ?? 0) >> 5
		let position = (at + 6) * 8 + 3

		position += (acmod & 1) !== 0 && acmod !== 1 ? 2 : 0
		position += (acmod & 4) !== 0 ? 2 : 0
		position += acmod === 2 ? 2 : 0

		return fscod === 3 ? null : { ch: (AC3_CHANNELS[acmod] ?? 2) + readBits(bytes, position, 1), rate: AC3_RATES[fscod] ?? null }
	}

	const packed = bytes[at + 4] ?? 0
	const fscod = packed >> 6
	const rate = fscod === 3 ? [24000, 22050, 16000][(packed >> 4) & 0x03] : AC3_RATES[fscod]

	if (bsid > 16 || (bytes[at + 2] ?? 0) >> 6 === 1 || rate === undefined) {
		return null
	}

	return { ch: (AC3_CHANNELS[(packed >> 1) & 0x07] ?? 2) + (packed & 1), rate }
}

// MPEG audio as a probe names it: layer III is MP3; layers I and II are no codec named yet.
export function mpegAudioFormat(bytes: Uint8Array, at: number): AudioFormat | null {
	const header = mpegAudioHeader(bytes, at)

	if (header === null) {
		return null
	}

	const mp3 = header.layer === 3

	return {
		ch: header.channels,
		rate: header.rate,
		codec: mp3 ? "mp3" : null,
		codecString: mp3 ? simpleAudioCodecString("mp3") : null
	}
}

const DTS_CHANNELS = [1, 2, 2, 2, 2, 3, 3, 4, 4, 5, 6, 6, 6, 7, 8, 8]
const DTS_RATES = [0, 8000, 16000, 32000, 0, 0, 11025, 22050, 44100, 0, 0, 12000, 24000, 48000, 0, 0]

// DTS core frame header: AMODE at bit 60, SFREQ at 66, LFF at 85.
export function dtsFormat(bytes: Uint8Array, at: number): AudioFormat | null {
	if (bytes[at] !== 0x7f || bytes[at + 1] !== 0xfe || bytes[at + 2] !== 0x80 || bytes[at + 3] !== 0x01) {
		return null
	}

	const base = at * 8
	const rate = DTS_RATES[readBits(bytes, base + 66, 4)] ?? 0
	const channels = DTS_CHANNELS[readBits(bytes, base + 60, 6)]
	const lfe = readBits(bytes, base + 85, 2)

	return rate === 0 ? null : { ch: channels === undefined ? null : channels + (lfe === 1 || lfe === 2 ? 1 : 0), rate }
}

export type ElementaryAudio = "adts" | "dolby" | "mpeg-audio" | "dts"

// Each elementary audio header: the bytes a reader needs from its start, and the reader.
export const AUDIO_HEADERS: Readonly<
	Record<ElementaryAudio, { bytes: number; read: (bytes: Uint8Array, at: number) => AudioFormat | null }>
> = {
	adts: { bytes: 7, read: adtsFormat },
	dolby: { bytes: 8, read: dolbyFormat },
	"mpeg-audio": { bytes: 4, read: mpegAudioFormat },
	dts: { bytes: 11, read: dtsFormat }
}
