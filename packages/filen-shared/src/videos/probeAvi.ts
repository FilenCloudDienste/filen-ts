import { avcConfigCodecString, mp4aCodecString, parseAudioSpecificConfig, parseAvcSps, simpleAudioCodecString } from "./codecString"
import { BLOCK_BYTES, type BlockSource } from "./blockSource"
import { ascii, readBytes, seconds } from "./probeBytes"
import { annexBNal } from "./probeElementary"
import type { ByteRange, MediaCodec, ParsedContainer, ProbeAudio, ProbeVideo } from "./probeTypes"

// AVI (RIFF "AVI "): the stream headers of the hdrl list, and the first H.264 picture's SPS where the stream carries
// one in band. Windows codec identifiers (BITMAPINFOHEADER compression, WAVEFORMATEX format tags) are named here
// once; ASF reuses them.

const HEAD_BYTES = BLOCK_BYTES
const MAX_STREAMS = 32
// The first picture chunk's prefix searched for an SPS: an encoder writes it at the start of a keyframe.
const SPS_SEARCH_BYTES = 65_536
const AVIF_HASINDEX = 0x10
// Chunk headers walked to find a list or the first picture chunk.
const MAX_SCANNED_CHUNKS = 64

export function uint16le(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
}

export function uint32le(bytes: Uint8Array, at: number): number {
	return uint16le(bytes, at) + uint16le(bytes, at + 2) * 0x10000
}

const VIDEO_FOURCCS: Readonly<Record<string, MediaCodec>> = {
	H264: "h264",
	X264: "h264",
	AVC1: "h264",
	DAVC: "h264",
	HEVC: "hevc",
	H265: "hevc",
	HVC1: "hevc",
	XVID: "mpeg4",
	DIVX: "mpeg4",
	DX50: "mpeg4",
	FMP4: "mpeg4",
	MP4V: "mpeg4",
	"3IV2": "mpeg4",
	MP4S: "mpeg4",
	M4S2: "mpeg4",
	MJPG: "mjpeg",
	MPG1: "mpeg1",
	MPG2: "mpeg2",
	WMV1: "wmv",
	WMV2: "wmv",
	WMV3: "wmv",
	WVC1: "vc1",
	WMVA: "vc1",
	H263: "h263",
	U263: "h263",
	VP60: "vp6",
	VP61: "vp6",
	VP62: "vp6",
	VP6F: "vp6",
	VP80: "vp8",
	VP90: "vp9",
	AV01: "av1"
}

// A BITMAPINFOHEADER compression FourCC's codec, case-insensitively; null for one this does not name.
export function videoFourccCodec(fourcc: string): MediaCodec | null {
	return VIDEO_FOURCCS[fourcc.toUpperCase()] ?? null
}

// WAVE_FORMAT_* tags (mmreg.h). WAVE_FORMAT_MPEG (0x0050) is layer I or II; layer II is what it holds in practice,
// and the MP2 decoder reads either.
const FORMAT_TAGS: Readonly<Record<number, MediaCodec>> = {
	0x0050: "mp2",
	0x0160: "wma",
	0x0001: "pcm",
	0x0003: "pcm",
	0x0002: "adpcm",
	0x0011: "adpcm",
	0x0055: "mp3",
	0x00ff: "aac",
	0x1600: "aac",
	0x1610: "aac",
	0x706d: "aac",
	0x2000: "ac3",
	0x2001: "dts",
	0x0161: "wma",
	0x0162: "wmapro",
	0x0163: "wmalossless",
	0xa109: "speex"
}

const WAVE_FORMAT_EXTENSIBLE = 0xfffe

// The format tag of a WAVEFORMATEX(TENSIBLE) at `at`, `length` bytes: an extensible one's is its sub-format GUID's
// first two bytes.
export function waveFormatTag(bytes: Uint8Array, at: number, length: number): number {
	const tag = uint16le(bytes, at)
	const extra = length >= 18 ? Math.min(uint16le(bytes, at + 16), length - 18) : 0

	return tag === WAVE_FORMAT_EXTENSIBLE && extra >= 22 ? uint16le(bytes, at + 24) : tag
}

// The codec's own configuration in a WAVEFORMATEX(TENSIBLE) at `at`, `length` bytes: its extra bytes, clamped to what
// is there, past WAVE_FORMAT_EXTENSIBLE's own 22 (valid bits, channel mask, sub-format), as FFmpeg's WAV header reader
// takes it.
export function waveFormatExtra(bytes: Uint8Array, at: number, length: number): Uint8Array {
	const extra = length >= 18 ? Math.min(uint16le(bytes, at + 16), length - 18) : 0
	const skip = uint16le(bytes, at) === WAVE_FORMAT_EXTENSIBLE && extra >= 22 ? 22 : 0

	return bytes.subarray(at + 18 + skip, at + 18 + extra)
}

// A WAVEFORMATEX(TENSIBLE) at `at`, `length` bytes: codec, channels, rate and, for AAC, the AudioSpecificConfig its
// extra bytes hold.
export function waveFormatAudio(bytes: Uint8Array, at: number, length: number): Pick<ProbeAudio, "codec" | "codecString" | "ch" | "rate"> {
	const tag = waveFormatTag(bytes, at, length)
	const ch = uint16le(bytes, at + 2)
	const rate = uint32le(bytes, at + 4)
	const extra = waveFormatExtra(bytes, at, length)
	const codec = FORMAT_TAGS[tag] ?? null
	let codecString: string | null = null

	if (codec === "aac") {
		const config = extra.length >= 2 ? extra : null

		codecString = mp4aCodecString({
			objectTypeIndication: 0x40,
			audioSpecificConfig: config !== null && parseAudioSpecificConfig(config) !== null ? config : null
		})
	} else if (codec === "mp3" || codec === "ac3") {
		codecString = simpleAudioCodecString(codec)
	} else if (codec === "dts") {
		codecString = "dtsc"
	}

	return { codec, codecString, ch: ch > 0 ? ch : null, rate: rate > 0 ? rate : null }
}

// The picture a BITMAPINFOHEADER at `at` describes, before any SPS is read.
export function bitmapVideo(bytes: Uint8Array, at: number): ProbeVideo {
	const fourcc = ascii(bytes, at + 16, at + 20).replace(/\0/g, "")
	const codec = videoFourccCodec(fourcc)

	return {
		codec,
		fourcc,
		// VP8 needs no configuration to be named; everything else needs its stream's parameters.
		codecString: codec === "vp8" ? "vp8" : null,
		w: Math.abs(uint32le(bytes, at + 4) | 0),
		h: Math.abs(uint32le(bytes, at + 8) | 0),
		par: 1,
		rotation: 0,
		bitDepth: null,
		transfer: "sdr"
	}
}

interface Chunk {
	id: string
	// Its data, `end` exclusive; for a LIST, after the list type.
	start: number
	end: number
	list: string | null
}

// The chunks between `start` and `end`, stopping at the first that does not fit within `bytes`' reach.
function chunks(bytes: Uint8Array, start: number, end: number): Chunk[] {
	const found: Chunk[] = []

	for (let at = start; at + 8 <= end && found.length < 256;) {
		const id = ascii(bytes, at, at + 4)
		const size = uint32le(bytes, at + 4)
		const list = id === "LIST" || id === "RIFF" ? ascii(bytes, at + 8, at + 12) : null
		const dataStart = at + 8 + (list === null ? 0 : 4)

		found.push({ id, start: dataStart, end: at + 8 + size, list })
		// Chunks are padded to an even size.
		at += 8 + size + (size & 1)
	}

	return found
}

// One strl list: the stream header's timing, the format the strf chunk describes (and its raw bytes, for a demuxer),
// the name, and the OpenDML super index when there is one.
export interface AviStream {
	kind: "vids" | "auds" | string
	handler: string
	// Ticks per second are rate / scale.
	scale: number
	rate: number
	start: number
	length: number
	// Bytes per tick of a fixed-size stream (PCM, CBR audio); 0 when each chunk is one tick (video, VBR audio).
	sampleSize: number
	video: ProbeVideo | null
	audio: Pick<ProbeAudio, "codec" | "codecString" | "ch" | "rate"> | null
	strf: Uint8Array | null
	name: string | null
	superIndex: Uint8Array | null
}

function readStream(bytes: Uint8Array, list: Chunk): AviStream | null {
	let stream: AviStream | null = null

	for (const chunk of chunks(bytes, list.start, Math.min(list.end, bytes.length))) {
		if (chunk.id === "strh" && chunk.end - chunk.start >= 36) {
			stream = {
				kind: ascii(bytes, chunk.start, chunk.start + 4),
				handler: ascii(bytes, chunk.start + 4, chunk.start + 8),
				scale: uint32le(bytes, chunk.start + 20),
				rate: uint32le(bytes, chunk.start + 24),
				start: uint32le(bytes, chunk.start + 28),
				length: uint32le(bytes, chunk.start + 32),
				sampleSize: chunk.end - chunk.start >= 48 ? uint32le(bytes, chunk.start + 44) : 0,
				video: null,
				audio: null,
				strf: null,
				name: null,
				superIndex: null
			}
		} else if (stream !== null && chunk.id === "strf") {
			stream.strf = bytes.subarray(chunk.start, Math.min(chunk.end, bytes.length))

			if (stream.kind === "vids" && chunk.end - chunk.start >= 20) {
				stream.video = bitmapVideo(bytes, chunk.start)
			} else if (stream.kind === "auds" && chunk.end - chunk.start >= 16) {
				stream.audio = waveFormatAudio(bytes, chunk.start, Math.min(chunk.end, bytes.length) - chunk.start)
			}
		} else if (stream !== null && chunk.id === "strn") {
			const name = ascii(bytes, chunk.start, Math.min(chunk.end, bytes.length)).replace(/\0.*$/s, "")

			stream.name = name === "" ? null : name
		} else if (stream !== null && chunk.id === "indx") {
			stream.superIndex = bytes.subarray(chunk.start, Math.min(chunk.end, bytes.length))
		}
	}

	return stream
}

// Reads `length` bytes at `start`; null past the file's end.
export type ReadAt = (start: number, length: number) => Promise<Uint8Array | null>

// The first `max` bytes of the first chunk of stream `index` whose id ends in `kinds` (dc/db for pictures): chunk
// headers walked from the movi list's start (into "rec " lists), then the chunk's head.
export async function aviFirstChunk(read: ReadAt, movi: ByteRange, index: number, max: number): Promise<Uint8Array | null> {
	const tag = `${String(index).padStart(2, "0")}d`

	for (let at = movi.start, count = 0; at + 8 <= movi.end && count < MAX_SCANNED_CHUNKS; count++) {
		const header = await read(at, 8)

		if (header === null) {
			return null
		}

		const id = ascii(header, 0, 4)
		const size = uint32le(header, 4)

		if (id === "LIST") {
			at += 12

			continue
		}

		if (id.startsWith(tag) && size > 0) {
			return read(at + 8, Math.max(0, Math.min(size, max, movi.end - at - 8)))
		}

		at += 8 + size + (size & 1)
	}

	return null
}

// The codec string of the first H.264 SPS in Annex B `data` (a stream's first chunk, a container's head); null without
// one.
export function spsCodecString(data: Uint8Array | null): string | null {
	const nal = data === null ? null : annexBNal(data, header => (header & 0x1f) === 7)
	const sps = nal === null ? null : parseAvcSps(nal)

	return sps === null ? null : avcConfigCodecString("avc1", sps)
}

export interface AviLists {
	hdrl: ByteRange | null
	movi: ByteRange | null
	// The idx1 chunk's data, when one follows the movi list.
	idx1: ByteRange | null
}

// The hdrl and movi lists among the top-level chunks, by their headers alone, and the idx1 chunk after movi.
export async function aviLists(read: ReadAt, size: number): Promise<AviLists> {
	const riff = await read(4, 4)
	const riffEnd = Math.min(size, 8 + (riff === null ? 0 : uint32le(riff, 0)))
	const found: AviLists = { hdrl: null, movi: null, idx1: null }

	for (let at = 12, count = 0; at + 12 <= riffEnd && at < HEAD_BYTES && count < MAX_SCANNED_CHUNKS; count++) {
		const header = await read(at, 12)

		if (header === null) {
			break
		}

		const size = uint32le(header, 4)
		const list = ascii(header, 0, 4) === "LIST" ? ascii(header, 8, 12) : null
		const range = { start: at + 12, end: at + 8 + size }

		if (list === "hdrl") {
			found.hdrl ??= range
		} else if (list === "movi") {
			found.movi ??= range
		}

		if (found.hdrl !== null && found.movi !== null) {
			break
		}

		at += 8 + size + (size & 1)
	}

	const movi = found.movi
	const after = movi === null ? null : movi.end + ((movi.end - movi.start) & 1)
	const next = after === null || after + 8 > size ? null : await read(after, 8)

	if (after !== null && next !== null && ascii(next, 0, 4) === "idx1") {
		found.idx1 = { start: after + 8, end: Math.min(size, after + 8 + uint32le(next, 4)) }
	}

	return found
}

export interface AviHeader {
	// avih's dwFlags.
	flags: number
	streams: AviStream[]
}

// The streams an hdrl list's data (`bytes`) declares, in order.
export function parseAviHeader(bytes: Uint8Array): AviHeader {
	const header = chunks(bytes, 0, bytes.length)
	const avih = header.find(chunk => chunk.id === "avih")
	const streams: AviStream[] = []

	for (const list of header) {
		if (list.list === "strl" && streams.length < MAX_STREAMS) {
			const stream = readStream(bytes, list)

			if (stream !== null) {
				streams.push(stream)
			}
		}
	}

	return { flags: avih === undefined ? 0 : uint32le(bytes, avih.start + 12), streams }
}

// The duration is the picture stream's length over its rate (audio's when there is no picture). The index is
// "idx" when the header says an idx1 follows the movi list or a stream has an OpenDML super index.
export async function walkAvi(source: BlockSource, result: ParsedContainer): Promise<void> {
	const read: ReadAt = (start, length) => readBytes(source, start, length)
	const { hdrl, movi } = await aviLists(read, source.size)

	result.index = "none"

	if (hdrl === null) {
		result.partial = true

		return
	}

	const hdrlEnd = Math.min(hdrl.end, source.size, hdrl.start + HEAD_BYTES)
	const { flags, streams } = parseAviHeader(await readBytes(source, hdrl.start, Math.max(0, hdrlEnd - hdrl.start)))

	result.tracksFound = hdrl.end <= hdrlEnd
	result.partial = !result.tracksFound
	result.index = (flags & AVIF_HASINDEX) !== 0 || streams.some(stream => stream.superIndex !== null) ? "idx" : "none"

	let firstAudio = true
	let timing: AviStream | null = null

	for (const [index, stream] of streams.entries()) {
		if (stream.video !== null) {
			const video = { ...stream.video }

			if (video.codec === "h264" && movi !== null) {
				video.codecString = spsCodecString(await aviFirstChunk(read, movi, index, SPS_SEARCH_BYTES))
			}

			result.tracks.push({ kind: "video", enabled: true, video })
			timing ??= stream
		} else if (stream.audio !== null) {
			result.tracks.push({
				kind: "audio",
				enabled: true,
				audio: { id: index, ...stream.audio, lang: null, name: stream.name, def: firstAudio, forced: false, commentary: false },
				config: stream.strf
			})
			firstAudio = false
		}
	}

	timing ??= streams.find(stream => stream.audio !== null) ?? null

	const span = timing === null || timing.rate === 0 ? null : (timing.length * timing.scale) / timing.rate

	result.durationSec = span === null || span <= 0 || !Number.isFinite(span) ? null : seconds(span)
}
