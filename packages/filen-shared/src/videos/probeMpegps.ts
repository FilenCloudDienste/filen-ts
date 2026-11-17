import { avcConfigCodecString, hevcConfigCodecString, parseAvcSps, parseHevcSps, type SpsPicture } from "./codecString"
import { BLOCK_BYTES, type BlockSource } from "./blockSource"
import { AUDIO_HEADERS, pesStart, pesTimestamp, type ElementaryAudio } from "./probeElementary"
import { readBytes, seconds, transferKind, uint16 } from "./probeBytes"
import type { MediaCodec, ParsedContainer, ParsedTrack } from "./probeTypes"

// MPEG program streams (ISO/IEC 11172-1 and 13818-1: .mpg, .mpeg, .vob): the program stream map's stream types where
// there is one, else each stream's first payload, read from the head; the timing stream's PTS span from the head and
// the tail. PES and elementary headers are probeElementary's.

const HEAD_BYTES = BLOCK_BYTES
const TAIL_BYTES = BLOCK_BYTES
const MAX_STREAMS = 32
const VIDEO_PREFIX_BYTES = 65_536
const AUDIO_PREFIX_BYTES = 256
const PTS_MODULUS = 2 ** 33
const PTS_HZ = 90_000

export const MPEG_PS_PACK = 0xba
const PACK = MPEG_PS_PACK
const MAP = 0xbc
export const MPEG_PS_PRIVATE_1 = 0xbd
const PRIVATE_1 = MPEG_PS_PRIVATE_1

// One elementary stream as the head's payloads named it. `key` is its stream id, and for private stream 1 its
// sub-stream id too (0xbd << 8 | sub).
export interface MpegPsStream {
	key: number
	kind: "video" | "audio"
	codec: MediaCodec | null
	codecString: string | null
	fourcc: string
	need: "avc" | "hevc" | "mpeg-video" | ElementaryAudio | null
	ch: number | null
	rate: number | null
	picture: SpsPicture | null
	buffer: Uint8Array | null
	length: number
}

type Stream = MpegPsStream

interface Walk {
	streams: Map<number, Stream>
	// Program stream map stream types by stream id.
	types: Map<number, number>
	// Each stream's first PTS.
	firstPts: Map<number, number>
}

// The length of the pack header at `at`: MPEG-2 (14 bytes plus stuffing) or MPEG-1 (12).
function packLength(bytes: Uint8Array, at: number): number {
	const marker = bytes[at + 4] ?? 0

	return (marker & 0xc0) === 0x40 ? 14 + ((bytes[at + 13] ?? 0) & 0x07) : 12
}

// An MPEG-1 PES header after its six bytes: stuffing, the STD buffer, then a PTS (and DTS) or the 0x0F marker.
function mpeg1Pes(bytes: Uint8Array, at: number, end: number): { pts: number | null; data: number } | null {
	let position = at + 6

	while (position < end && bytes[position] === 0xff && position < at + 6 + 16) {
		position++
	}

	if (((bytes[position] ?? 0) & 0xc0) === 0x40) {
		position += 2
	}

	const marker = (bytes[position] ?? 0) >> 4

	if (marker === 0x02) {
		return { pts: pesTimestamp(bytes, position), data: position + 5 }
	}

	if (marker === 0x03) {
		return { pts: pesTimestamp(bytes, position), data: position + 10 }
	}

	return bytes[position] === 0x0f ? { pts: null, data: position + 1 } : null
}

// A PES packet's stream key (private stream 1 by its sub-stream id too), PTS and where its data starts.
export function mpegPsStreamKey(bytes: Uint8Array, id: number, data: number): number {
	return id === PRIVATE_1 ? (PRIVATE_1 << 8) | (bytes[data] ?? 0) : id
}

// A PES packet's PTS and where its data starts, MPEG-2 or MPEG-1 syntax.
export function mpegPsPes(bytes: Uint8Array, at: number, end: number): { pts: number | null; data: number } | null {
	if (((bytes[at + 6] ?? 0) & 0xc0) === 0x80) {
		const pes = pesStart(bytes.subarray(at, end))

		return pes === null ? null : { pts: pes.pts, data: at + pes.data }
	}

	return mpeg1Pes(bytes, at, end)
}

function readMap(walk: Walk, bytes: Uint8Array, at: number, end: number): void {
	const infoEnd = at + 10 + (uint16(bytes, at + 8) & 0x3ff)
	const mapEnd = Math.min(end - 4, infoEnd + 2 + uint16(bytes, infoEnd))

	for (let entry = infoEnd + 2; entry + 4 <= mapEnd; entry += 4 + uint16(bytes, entry + 2)) {
		walk.types.set(bytes[entry + 1] ?? 0, bytes[entry] ?? 0)
	}
}

function newStream(key: number, kind: Stream["kind"], codec: MediaCodec | null, need: Stream["need"], fourcc = ""): Stream {
	return { key, kind, codec, codecString: null, fourcc, need, ch: null, rate: null, picture: null, buffer: null, length: 0 }
}

// What a stream id (and, in private stream 1, its sub-stream id) carries; null for navigation, subpictures and
// anything this does not read.
function classify(walk: Walk, id: number, sub: number): Stream | null {
	const type = walk.types.get(id)

	if (id >= 0xe0 && id <= 0xef) {
		switch (type) {
			case 0x1b:
				return newStream(id, "video", "h264", "avc", "avc1")
			case 0x24:
				return newStream(id, "video", "hevc", "hevc", "hvc1")
			case 0x10:
				return newStream(id, "video", "mpeg4", null, "mp4v")
			default:
				return newStream(id, "video", null, "mpeg-video")
		}
	}

	if (id >= 0xc0 && id <= 0xdf) {
		return type === 0x0f ? newStream(id, "audio", "aac", "adts") : newStream(id, "audio", null, "mpeg-audio")
	}

	if (id !== PRIVATE_1) {
		return null
	}

	const key = (PRIVATE_1 << 8) | sub

	if (sub >= 0x80 && sub <= 0x87) {
		return { ...newStream(key, "audio", "ac3", "dolby"), codecString: "ac-3" }
	}

	if (sub >= 0x88 && sub <= 0x8f) {
		return { ...newStream(key, "audio", "dts", "dts"), codecString: "dtsc" }
	}

	return sub >= 0xa0 && sub <= 0xa7 ? newStream(key, "audio", "pcm", null) : null
}

// MPEG-1/2 video by its sequence header (00 00 01 B3), MPEG-2 when a sequence extension (B5) follows; H.264 or HEVC
// where an SPS appears instead, for a stream no map types.
function inspectVideo(stream: Stream, data: Uint8Array): void {
	for (let at = 0; at + 4 < data.length; at++) {
		if (data[at] !== 0 || data[at + 1] !== 0 || data[at + 2] !== 1) {
			continue
		}

		const code = data[at + 3] ?? 0

		if (stream.need === "mpeg-video" && code === 0xb3) {
			const mpeg2 = data
				.subarray(at + 4)
				.some((_, i, rest) => rest[i] === 0 && rest[i + 1] === 0 && rest[i + 2] === 1 && rest[i + 3] === 0xb5)

			stream.codec = mpeg2 ? "mpeg2" : "mpeg1"
			stream.fourcc = mpeg2 ? "mp2v" : "mp1v"
			stream.picture = {
				width: (uint16(data, at + 4) >> 4) & 0xfff,
				height: uint16(data, at + 5) & 0xfff,
				bitDepth: 8,
				par: 1,
				transfer: null
			}
			stream.need = null

			return
		}

		const avc = (code & 0x1f) === 7 && (stream.need === "avc" || stream.need === "mpeg-video")
		const hevc = ((code >> 1) & 0x3f) === 33 && stream.need === "hevc"

		if (avc || hevc) {
			let end = at + 4

			while (end + 2 < data.length && !(data[end] === 0 && data[end + 1] === 0 && (data[end + 2] ?? 2) <= 1)) {
				end++
			}

			const nal = data.subarray(at + 3, end)

			if (avc) {
				const sps = parseAvcSps(nal)

				stream.codec = "h264"
				stream.fourcc = "avc1"
				stream.picture = sps
				stream.codecString = sps === null ? null : avcConfigCodecString("avc1", sps)
			} else {
				const sps = parseHevcSps(nal)

				stream.picture = sps
				stream.codecString = sps === null ? null : hevcConfigCodecString("hvc1", sps)
			}

			stream.need = null

			return
		}
	}
}

function inspect(stream: Stream, complete: boolean): void {
	const { buffer, length, need } = stream

	if (buffer === null || need === null) {
		return
	}

	const data = buffer.subarray(0, length)

	if (stream.kind === "video") {
		inspectVideo(stream, data)
	} else if (need !== "avc" && need !== "hevc" && need !== "mpeg-video") {
		const header = AUDIO_HEADERS[need]

		for (let at = 0; at + header.bytes <= length; at++) {
			const format = header.read(data, at)

			if (format !== null) {
				stream.ch = format.ch
				stream.rate = format.rate
				stream.codec = format.codec === undefined ? stream.codec : format.codec
				stream.codecString = format.codecString === undefined ? stream.codecString : format.codecString
				stream.need = null

				break
			}
		}
	}

	if (stream.need === null || complete || length >= buffer.length) {
		stream.buffer = null
	}
}

function feed(walk: Walk, bytes: Uint8Array, at: number, end: number): void {
	const id = bytes[at + 3] ?? 0
	const pes = mpegPsPes(bytes, at, end)

	if (pes === null || pes.data > end) {
		return
	}

	const sub = id === PRIVATE_1 ? (bytes[pes.data] ?? 0) : 0
	const key = mpegPsStreamKey(bytes, id, pes.data)
	let stream = walk.streams.get(key)

	if (stream === undefined) {
		const found = walk.streams.size < MAX_STREAMS ? classify(walk, id, sub) : null

		if (found === null) {
			return
		}

		stream = found
		walk.streams.set(key, stream)
	}

	if (pes.pts !== null && !walk.firstPts.has(key)) {
		walk.firstPts.set(key, pes.pts)
	}

	// LPCM's header: sub-stream id, frame count, first access unit (2), emphasis, then quantisation, rate and channels.
	// Only 16-bit samples are plain big-endian PCM; 20- and 24-bit ones are packed in sample groups.
	if (stream.codec === "pcm" && stream.rate === null) {
		const format = bytes[pes.data + 5] ?? 0

		stream.rate = ((format >> 4) & 0x03) === 1 ? 96000 : 48000
		stream.ch = (format & 0x07) + 1

		if (format >> 6 !== 0) {
			stream.codec = "lpcm"
		}
	}

	if (stream.need === null) {
		return
	}

	// Private stream 1 audio: the sub-stream id, frame count and first access unit come before the frames.
	const data = bytes.subarray(pes.data + (id === PRIVATE_1 ? 4 : 0), end)

	stream.buffer ??= new Uint8Array(stream.kind === "video" ? VIDEO_PREFIX_BYTES : AUDIO_PREFIX_BYTES)

	const take = Math.min(data.length, stream.buffer.length - stream.length)

	stream.buffer.set(data.subarray(0, take), stream.length)
	stream.length += take
	inspect(stream, false)
}

// Each pack and PES packet within `bytes` from `start`, in order, until `visit` returns false; resyncs on the next
// pack start where a packet does not line up.
export function forEachMpegPsUnit(bytes: Uint8Array, start: number, visit: (id: number, at: number, end: number) => boolean | void): void {
	for (let at = start; at + 6 <= bytes.length;) {
		if (bytes[at] !== 0 || bytes[at + 1] !== 0 || bytes[at + 2] !== 1 || (bytes[at + 3] ?? 0) < PACK) {
			const next = bytes.indexOf(1, at + 1)

			at = next === -1 ? bytes.length : Math.max(at + 1, next - 2)

			continue
		}

		const id = bytes[at + 3] ?? 0
		const end = id === PACK ? at + packLength(bytes, at) : at + 6 + uint16(bytes, at + 4)

		if (end > bytes.length) {
			return
		}

		if (visit(id, at, end) === false) {
			return
		}

		at = end
	}
}

function videoTrack(stream: Stream): ParsedTrack {
	const { picture } = stream

	return {
		kind: "video",
		enabled: true,
		video: {
			codec: stream.codec,
			fourcc: stream.fourcc,
			codecString: stream.codecString,
			w: picture?.width ?? 0,
			h: picture?.height ?? 0,
			par: picture?.par ?? 1,
			rotation: 0,
			bitDepth: picture?.bitDepth ?? null,
			transfer: transferKind(picture?.transfer ?? null)
		}
	}
}

function headWalk(head: Uint8Array): Walk {
	const walk: Walk = { streams: new Map(), types: new Map(), firstPts: new Map() }

	forEachMpegPsUnit(head, 0, (id, at, end) => {
		if (id === MAP) {
			readMap(walk, head, at, end)
		} else if (id !== PACK && id !== 0xbb && id !== 0xbe && id !== 0xbf) {
			feed(walk, head, at, end)
		}
	})

	for (const stream of walk.streams.values()) {
		inspect(stream, true)
	}

	return walk
}

// The streams the head of a program stream holds, in the order their first payloads came.
export function readMpegPsStreams(head: Uint8Array): MpegPsStream[] {
	return [...headWalk(head).streams.values()]
}

// The duration is the timing stream's PTS span, head to tail, across one 33-bit wrap. There is no index: a player
// finds a time by interpolating over the file's size.
export async function walkMpegPs(source: BlockSource, result: ParsedContainer): Promise<void> {
	const head = await readBytes(source, 0, Math.min(source.size, HEAD_BYTES))
	const walk = headWalk(head)

	result.index = "none"

	let firstAudio = true

	for (const stream of walk.streams.values()) {
		if (stream.kind === "video") {
			result.tracks.push(videoTrack(stream))

			continue
		}

		result.tracks.push({
			kind: "audio",
			enabled: true,
			audio: {
				id: stream.key,
				codec: stream.codec,
				codecString: stream.codecString,
				ch: stream.ch,
				rate: stream.rate,
				lang: null,
				name: null,
				def: firstAudio,
				forced: false,
				commentary: false
			}
		})
		firstAudio = false
	}

	result.tracksFound = walk.streams.size > 0
	result.partial = [...walk.streams.values()].some(stream => stream.need !== null)
	// The picture times the file; without one, the first stream that has a PTS.
	const streams = [...walk.streams.values()]
	const timing = [...streams.filter(stream => stream.kind === "video"), ...streams].find(stream => walk.firstPts.has(stream.key))
	const first = timing === undefined ? undefined : walk.firstPts.get(timing.key)

	if (timing === undefined || first === undefined) {
		return
	}

	const tailStart = Math.max(0, source.size - TAIL_BYTES)
	const tail = tailStart === 0 ? head : await readBytes(source, tailStart, source.size - tailStart)
	let span = -1

	forEachMpegPsUnit(tail, 0, (id, at, end) => {
		const pes = id === PACK || id === MAP ? null : mpegPsPes(tail, at, end)

		if (pes === null || mpegPsStreamKey(tail, id, pes.data) !== timing.key) {
			return
		}

		const pts = pes.pts
		const elapsed = pts === null ? -1 : (((pts - first) % PTS_MODULUS) + PTS_MODULUS) % PTS_MODULUS

		if (elapsed >= 0 && elapsed < PTS_MODULUS / 2) {
			span = Math.max(span, elapsed)
		}
	})

	if (span > 0) {
		result.durationSec = seconds(span / PTS_HZ)
	} else {
		result.partial = true
	}
}
