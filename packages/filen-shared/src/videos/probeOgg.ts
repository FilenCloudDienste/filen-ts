import { BLOCK_BYTES, type BlockSource } from "./blockSource"
import { ascii, readBytes, seconds } from "./probeBytes"
import type { MediaCodec, ParsedContainer, ParsedTrack } from "./probeTypes"

// Ogg (RFC 3533): the logical streams its beginning-of-stream pages announce, each identified by its first
// packet, and the span its last granule positions give. One page and packet parser serves both the probe
// walk and the audio-metadata read's video check (oggHeadVideo).

const CAPTURE = "OggS"
const PAGE_HEADER_BYTES = 27
// Every identification header this reads fits in its first bytes (Speex's channel count ends at 52).
const PACKET_HEAD_BYTES = 64
const MAX_STREAMS = 32
const BOS = 0x02
const CONTINUED = 0x01

interface Page {
	flags: number
	// Null where no packet ends on the page (-1), or past 2^53.
	granule: number | null
	serial: number
	// The segment table and where the page's data starts and ends.
	lacing: number
	dataStart: number
	end: number
}

function uint32le(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)) + (bytes[at + 3] ?? 0) * 0x1000000
}

function uint16be(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)
}

function uint24be(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) << 16) | uint16be(bytes, at + 1)
}

function uint32be(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) * 0x1000000 + uint24be(bytes, at + 1)
}

// The page header at `at`, when it and its segment table lie within `bytes`.
function pageAt(bytes: Uint8Array, at: number): Page | null {
	if (at + PAGE_HEADER_BYTES > bytes.length || ascii(bytes, at, at + 4) !== CAPTURE || bytes[at + 4] !== 0) {
		return null
	}

	const segments = bytes[at + 26] ?? 0
	const dataStart = at + PAGE_HEADER_BYTES + segments

	if (dataStart > bytes.length) {
		return null
	}

	let size = 0

	for (let i = at + PAGE_HEADER_BYTES; i < dataStart; i++) {
		size += bytes[i] ?? 0
	}

	const low = uint32le(bytes, at + 6)
	const high = uint32le(bytes, at + 10)

	return {
		flags: bytes[at + 5] ?? 0,
		granule: high >= 0x200000 ? null : high * 0x100000000 + low,
		serial: uint32le(bytes, at + 14),
		lacing: at + PAGE_HEADER_BYTES,
		dataStart,
		end: dataStart + size
	}
}

interface Packet {
	serial: number
	// The packet's first PACKET_HEAD_BYTES bytes.
	head: Uint8Array
	length: number
	// It starts on its stream's beginning-of-stream page.
	bos: boolean
}

interface Partial {
	head: number[]
	length: number
	bos: boolean
}

// Each whole packet in `bytes`, in order, until `visit` returns false or a page runs past the end. Pages that
// do not line up end the walk: a capture pattern is only looked for where the previous page ends.
function forEachPacket(bytes: Uint8Array, visit: (packet: Packet, page: Page) => boolean): void {
	const open = new Map<number, Partial>()

	for (let page = pageAt(bytes, 0); page !== null && page.end <= bytes.length; page = pageAt(bytes, page.end)) {
		let partial = open.get(page.serial)

		if ((page.flags & CONTINUED) === 0) {
			partial = undefined
		}

		let at = page.dataStart

		for (let i = page.lacing; i < page.dataStart; i++) {
			const lace = bytes[i] ?? 0

			partial ??= { head: [], length: 0, bos: (page.flags & BOS) !== 0 }

			for (let k = at; k < at + lace && partial.head.length < PACKET_HEAD_BYTES; k++) {
				partial.head.push(bytes[k] ?? 0)
			}

			partial.length += lace
			at += lace

			if (lace < 255) {
				const done = partial

				partial = undefined

				if (!visit({ serial: page.serial, head: Uint8Array.from(done.head), length: done.length, bos: done.bos }, page)) {
					return
				}
			}
		}

		if (partial === undefined) {
			open.delete(page.serial)
		} else if (open.size < MAX_STREAMS || open.has(page.serial)) {
			open.set(page.serial, partial)
		}
	}
}

type OggVideoCodec = "theora" | "vp8"

interface OggStream {
	kind: "video" | "audio"
	codec: MediaCodec | null
	codecString: string | null
	fourcc: string
	w: number
	h: number
	par: number
	ch: number | null
	rate: number | null
	// Seconds at a granule position of this stream; null where it cannot tell.
	time: (granule: number) => number | null
	// Whether a packet after the headers carries a picture or sound.
	isData: (head: Uint8Array, length: number) => boolean
}

function ratio(numerator: number, denominator: number): number {
	return numerator > 0 && denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : 1
}

function audioStream(codec: MediaCodec | null, codecString: string | null, ch: number, rate: number, time: OggStream["time"]): OggStream {
	return {
		kind: "audio",
		codec,
		codecString,
		fourcc: "",
		w: 0,
		h: 0,
		par: 1,
		ch: ch > 0 ? ch : null,
		rate: rate > 0 ? rate : null,
		time,
		isData: () => true
	}
}

function perSample(rate: number, skip = 0): OggStream["time"] {
	return granule => (rate > 0 ? Math.max(0, granule - skip) / rate : null)
}

// What a stream's first packet says it is; null for a stream this does not read (Skeleton, Kate, Dirac).
function identify(head: Uint8Array): OggStream | null {
	if (head[0] === 0x80 && ascii(head, 1, 7) === "theora" && head.length >= 42) {
		// FRN and FRD at 22 and 26, PARN/PARD at 30 and 33, KFGSHIFT across bytes 40-41.
		const fps = { n: uint32be(head, 22), d: uint32be(head, 26) }
		const shift = (((head[40] ?? 0) & 0x03) << 3) | ((head[41] ?? 0) >> 5)

		return {
			kind: "video",
			codec: "theora",
			codecString: "theora",
			fourcc: "theora",
			w: uint24be(head, 14),
			h: uint24be(head, 17),
			par: ratio(uint24be(head, 30), uint24be(head, 33)),
			ch: null,
			rate: null,
			time: granule => {
				const keyframe = Math.floor(granule / 2 ** shift)

				return fps.n > 0 ? ((keyframe + (granule - keyframe * 2 ** shift)) * fps.d) / fps.n : null
			},
			isData: (packet, length) => length > 0 && ((packet[0] ?? 0) & 0x80) === 0
		}
	}

	if (head[0] === 0x4f && ascii(head, 1, 5) === "VP80" && head[5] === 0x01 && head.length >= 26) {
		const fps = { n: uint32be(head, 18), d: uint32be(head, 22) }

		return {
			kind: "video",
			codec: "vp8",
			codecString: "vp8",
			fourcc: "VP80",
			w: uint16be(head, 8),
			h: uint16be(head, 10),
			par: ratio(uint24be(head, 12), uint24be(head, 15)),
			ch: null,
			rate: null,
			// The frame count is the granule position's upper 32 bits.
			time: granule => (fps.n > 0 ? (Math.floor(granule / 0x100000000) * fps.d) / fps.n : null),
			isData: (packet, length) => length > 0 && !(packet[0] === 0x4f && ascii(packet, 1, 5) === "VP80")
		}
	}

	if (head[0] === 0x01 && ascii(head, 1, 7) === "vorbis") {
		const rate = uint32le(head, 12)

		return audioStream("vorbis", "vorbis", head[11] ?? 0, rate, perSample(rate))
	}

	if (ascii(head, 0, 8) === "OpusHead") {
		// Opus always decodes at 48 kHz; the header's rate is only the source's.
		return audioStream("opus", "opus", head[9] ?? 0, 48000, perSample(48000, (head[10] ?? 0) | ((head[11] ?? 0) << 8)))
	}

	if (head[0] === 0x7f && ascii(head, 1, 5) === "FLAC" && ascii(head, 9, 13) === "fLaC") {
		// STREAMINFO after the mapping header (13 bytes) and its block header (4): rate (20 bits) and channels (3) at 10-12.
		const rate = ((head[27] ?? 0) << 12) | ((head[28] ?? 0) << 4) | ((head[29] ?? 0) >> 4)

		return audioStream("flac", "flac", (((head[29] ?? 0) >> 1) & 0x07) + 1, rate, perSample(rate))
	}

	if (ascii(head, 0, 8) === "Speex   ") {
		const rate = uint32le(head, 36)

		return audioStream(null, null, uint32le(head, 48), rate, perSample(rate))
	}

	return null
}

// A real picture stream at the head of an Ogg file: its codec and size. Never a single cover frame.
export interface OggVideoFacts {
	codec: OggVideoCodec
	codecString: string
	width: number
	height: number
}

// Picture packets a stream must show within the bytes read before it counts as video rather than a cover
// (one picture packet, or Theora's still-image convention).
const MIN_PICTURE_PACKETS = 2

// The first Theora or VP8 stream in `bytes` (an Ogg file's head) with at least MIN_PICTURE_PACKETS picture
// packets within them; null when there is none, or too few of its packets lie within `bytes` to tell.
export function oggHeadVideo(bytes: Uint8Array): OggVideoFacts | null {
	let video: { serial: number; stream: OggStream; pictures: number } | null = null
	let facts: OggVideoFacts | null = null

	forEachPacket(bytes, packet => {
		if (video === null) {
			if (!packet.bos) {
				return false
			}

			const stream = identify(packet.head)

			if (stream?.kind === "video") {
				video = { serial: packet.serial, stream, pictures: 0 }
			}

			return true
		}

		if (packet.serial !== video.serial || !video.stream.isData(packet.head, packet.length)) {
			return true
		}

		video.pictures++

		if (video.pictures < MIN_PICTURE_PACKETS) {
			return true
		}

		const { stream } = video

		facts = {
			codec: stream.codec === "vp8" ? "vp8" : "theora",
			codecString: stream.codecString ?? "",
			width: stream.w,
			height: stream.h
		}

		return false
	})

	return facts
}

const TAIL_BYTES = BLOCK_BYTES

// The streams the beginning-of-stream pages of the head announce, then the span the tail's last granule
// positions give. Ogg has no index: a player seeks by bisecting pages.
export async function walkOgg(source: BlockSource, result: ParsedContainer): Promise<void> {
	const head = await readBytes(source, 0, Math.min(source.size, BLOCK_BYTES))
	const streams = new Map<number, OggStream>()
	let headersDone = false

	result.index = "none"

	forEachPacket(head, packet => {
		if (!packet.bos) {
			headersDone = true

			return false
		}

		const stream = identify(packet.head)

		if (stream !== null && streams.size < MAX_STREAMS) {
			streams.set(packet.serial, stream)
		}

		return true
	})

	result.tracksFound = headersDone || head.length === source.size

	let firstAudio = true

	for (const [serial, stream] of streams) {
		result.tracks.push(trackOf(serial, stream, firstAudio))
		firstAudio &&= stream.kind !== "audio"
	}

	if (streams.size === 0) {
		return
	}

	const tailStart = Math.max(0, source.size - TAIL_BYTES)
	const tail = tailStart === 0 ? head : await readBytes(source, tailStart, source.size - tailStart)
	let duration: number | null = null

	for (let at = tail.indexOf(0x4f); at !== -1 && at + PAGE_HEADER_BYTES <= tail.length; at = tail.indexOf(0x4f, at + 1)) {
		const page = pageAt(tail, at)
		const stream = page === null ? undefined : streams.get(page.serial)

		if (page === null || stream === undefined || page.granule === null) {
			continue
		}

		const time = stream.time(page.granule)

		if (time !== null && Number.isFinite(time) && time > (duration ?? -1)) {
			duration = time
		}
	}

	result.durationSec = duration === null ? null : seconds(duration)
	result.partial ||= duration === null
}

function trackOf(serial: number, stream: OggStream, def: boolean): ParsedTrack {
	if (stream.kind === "video") {
		return {
			kind: "video",
			enabled: true,
			video: {
				codec: stream.codec,
				fourcc: stream.fourcc,
				codecString: stream.codecString,
				w: stream.w,
				h: stream.h,
				par: stream.par,
				rotation: 0,
				bitDepth: 8,
				transfer: "sdr"
			}
		}
	}

	return {
		kind: "audio",
		enabled: true,
		audio: {
			id: serial,
			codec: stream.codec,
			codecString: stream.codecString,
			ch: stream.ch,
			rate: stream.rate,
			lang: null,
			name: null,
			def,
			forced: false,
			commentary: false
		}
	}
}
