import { avcConfigCodecString, hevcConfigCodecString, parseAvcSps, parseHevcSps, simpleAudioCodecString } from "./codecString"
import { BLOCK_BYTES, type BlockSource } from "./blockSource"
import { ascii, readBytes, uint16 } from "./probeBytes"
import {
	AUDIO_HEADERS,
	elementaryAudioTrack,
	elementaryVideoTrack,
	pesStart,
	ptsSpan,
	ptsSpanSeconds,
	type ElementaryAudio,
	type StreamPicture
} from "./probeElementary"
import type { MediaCodec, ParsedContainer, ProbeTier } from "./probeTypes"
import {
	TS_MIN_PACKETS,
	TS_PACKET_BYTES,
	TS_SNIFF_PACKETS,
	TS_SYNC,
	feedSection,
	packetAt,
	packetCount,
	readPat,
	type PsiWalk,
	type TsLayout,
	type TsPacket
} from "./transportStreamHead"

// MPEG transport streams (ISO/IEC 13818-1) of a single program: its PMT, each stream's first parameter set or
// frame header from the head, and the timing stream's PTS span from the head and the tail. The stream
// mapping follows the remux's demuxer (Mediabunny), so a track reported here is one it can read.

// A card stays within CARD_BLOCK_READS: two head blocks, and at most two for a tail straddling a boundary.
const HEAD_BYTES: Readonly<Record<ProbeTier, number>> = { card: 2 * BLOCK_BYTES, cover: 2 * BLOCK_BYTES, full: 4 * BLOCK_BYTES }
const TAIL_BYTES = BLOCK_BYTES
const FULL_BLOCK_READS = 6

const CHUNK_PACKETS = 32
const MAX_STREAMS = 32
// Enough for the SEI an encoder writes ahead of its parameter sets.
const VIDEO_PREFIX_BYTES = 16_384
const AUDIO_PREFIX_BYTES = 256
// PES starts read from the tail: B-frames put the latest PTS a few pictures before the last one.
const TAIL_PES = 4

type Need = "avc" | "hevc" | ElementaryAudio | null

interface StreamKind {
	kind: "video" | "audio"
	codec: MediaCodec | null
	fourcc: string
	codecString: string | null
	need: Need
}

interface Stream extends StreamKind {
	pid: number
	lang: string | null
	picture: StreamPicture | null
	ch: number | null
	rate: number | null
	// The current PES's payload while `need` is unmet.
	buffer: Uint8Array | null
	length: number
	collecting: boolean
	// Video: where the SPS starts in `buffer` (-1 not yet), and how far start codes were searched.
	spsAt: number
	searched: number
}

interface Walk extends PsiWalk {
	pmtFound: boolean
	streams: Stream[]
	byPid: Map<number, Stream>
	timingPid: number | null
	firstPts: number | null
}

function video(codec: MediaCodec | null, fourcc: string, need: Need = null): StreamKind {
	return { kind: "video", codec, fourcc, codecString: null, need }
}

function audio(codec: MediaCodec | null, codecString: string | null, need: Need): StreamKind {
	return { kind: "audio", codec, fourcc: "", codecString, need }
}

interface Descriptors {
	lang: string | null
	ac3: boolean
	eac3: boolean
	dts: boolean
}

// ISO 639-2 from a language descriptor; "und" and anything not three letters is no language.
function language(bytes: Uint8Array, at: number): string | null {
	const code = ascii(bytes, at, at + 3).toLowerCase()

	return /^[a-z]{3}$/.test(code) && code !== "und" ? code : null
}

function descriptors(bytes: Uint8Array, start: number, end: number): Descriptors {
	const found: Descriptors = { lang: null, ac3: false, eac3: false, dts: false }

	for (let at = start; at + 2 <= end;) {
		const tag = bytes[at] ?? 0
		const body = at + 2
		const next = body + (bytes[at + 1] ?? 0)

		if (next > end) {
			break
		}

		if (tag === 0x0a && next - body >= 4) {
			found.lang ??= language(bytes, body)
		} else if (tag === 0x6a) {
			found.ac3 = true
		} else if (tag === 0x7a || tag === 0xcc) {
			found.eac3 = true
		} else if (tag === 0x7b || (tag === 0x05 && next - body >= 4 && /^DTS[123]$/.test(ascii(bytes, body, body + 4)))) {
			found.dts = true
		}

		at = next
	}

	return found
}

// A program registered as Blu-ray ("HDMV", "HDPR"), whose private stream types mean what BDAV says.
function bluRayProgram(bytes: Uint8Array, start: number, end: number): boolean {
	for (let at = start; at + 2 <= end;) {
		const body = at + 2
		const next = body + (bytes[at + 1] ?? 0)

		if (next > end) {
			break
		}

		if (bytes[at] === 0x05 && next - body >= 4) {
			const id = ascii(bytes, body, body + 4)

			if (id === "HDMV" || id === "HDPR") {
				return true
			}
		}

		at = next
	}

	return false
}

function classify(type: number, found: Descriptors, bluRay: boolean): StreamKind | null {
	switch (type) {
		case 0x01:
			return video(null, "mp1v")
		case 0x02:
			return video(null, "mp2v")
		case 0x10:
			return video("mpeg4", "mp4v")
		case 0x1b:
			return video("h264", "avc1", "avc")
		case 0x24:
			return video("hevc", "hvc1", "hevc")
		case 0xea:
			return bluRay ? video(null, "vc-1") : null
		// MPEG-1/2 audio: only layer III, read from the first frame, is MP3.
		case 0x03:
		case 0x04:
			return audio(null, null, "mpeg-audio")
		case 0x0f:
			return audio("aac", null, "adts")
		// AAC in LATM: a track the remux's demuxer does not read.
		case 0x11:
			return audio(null, null, null)
		case 0x81:
			return audio("ac3", simpleAudioCodecString("ac3"), "dolby")
		case 0x87:
			return audio("eac3", simpleAudioCodecString("eac3"), "dolby")
		case 0x82:
		case 0x8a:
			return audio("dts", "dtsc", "dts")
		case 0x85:
			return bluRay ? audio("dts", "dtsh", "dts") : null
		case 0x86:
			return bluRay ? audio("dts", "dtsl", "dts") : null
		case 0xa2:
			return bluRay ? audio("dts", "dtse", "dts") : null
		// LPCM, TrueHD and E-AC-3 in BDAV: tracks the remux's demuxer does not read.
		case 0x80:
		case 0x84:
		case 0xa1:
			return bluRay ? audio(null, null, null) : null
		case 0x83:
			return bluRay ? audio("truehd", simpleAudioCodecString("truehd"), null) : null
		case 0x06:
			return found.eac3
				? audio("eac3", simpleAudioCodecString("eac3"), "dolby")
				: found.ac3
					? audio("ac3", simpleAudioCodecString("ac3"), "dolby")
					: found.dts
						? audio("dts", "dtsc", "dts")
						: null
		default:
			return null
	}
}

function readPmt(walk: Walk, section: Uint8Array): void {
	if (section.length < 16) {
		walk.malformed = true

		return
	}

	const end = section.length - 4
	const infoEnd = 12 + (uint16(section, 10) & 0x0fff)

	if (infoEnd > end) {
		walk.malformed = true

		return
	}

	const bluRay = bluRayProgram(section, 12, infoEnd)

	for (let at = infoEnd; at + 5 <= end && walk.streams.length < MAX_STREAMS;) {
		const pid = uint16(section, at + 1) & 0x1fff
		const next = at + 5 + (uint16(section, at + 3) & 0x0fff)

		if (next > end) {
			walk.malformed = true

			break
		}

		const found = descriptors(section, at + 5, next)
		const kind = classify(section[at] ?? 0, found, bluRay)

		if (kind !== null && !walk.byPid.has(pid)) {
			const stream: Stream = {
				...kind,
				pid,
				lang: kind.kind === "audio" ? found.lang : null,
				picture: null,
				ch: null,
				rate: null,
				buffer: null,
				length: 0,
				collecting: false,
				spsAt: -1,
				searched: 0
			}

			walk.streams.push(stream)
			walk.byPid.set(pid, stream)
		}

		at = next
	}

	walk.pmtFound = true
	walk.timingPid = (walk.streams.find(stream => stream.kind === "video") ?? walk.streams[0])?.pid ?? null
}

function resolve(stream: Stream): void {
	stream.need = null
	stream.buffer = null
	stream.collecting = false
}

function inspectAudio(stream: Stream, header: (typeof AUDIO_HEADERS)[keyof typeof AUDIO_HEADERS], complete: boolean): void {
	const { buffer, length } = stream

	if (buffer === null) {
		return
	}

	for (let at = 0; at + header.bytes <= length; at++) {
		const format = header.read(buffer, at)

		if (format !== null) {
			stream.ch = format.ch
			stream.rate = format.rate

			if (format.codec !== undefined) {
				stream.codec = format.codec
			}

			if (format.codecString !== undefined) {
				stream.codecString = format.codecString
			}

			resolve(stream)

			return
		}
	}

	if (complete || length >= buffer.length) {
		stream.collecting = false
	}
}

function isSps(stream: Stream, header: number): boolean {
	return stream.need === "avc" ? (header & 0x1f) === 7 : ((header >> 1) & 0x3f) === 33
}

// Finds the SPS in the PES payload gathered so far, resuming where the last search stopped; it ends at
// the next start code (00 00 00 or 00 00 01, which emulation prevention keeps out of a NAL unit).
function inspectVideo(stream: Stream, complete: boolean): void {
	const { buffer, length } = stream

	if (buffer === null) {
		return
	}

	if (stream.spsAt < 0) {
		for (let at = stream.searched; at + 3 < length; at++) {
			if (buffer[at] === 0 && buffer[at + 1] === 0 && buffer[at + 2] === 1 && isSps(stream, buffer[at + 3] ?? 0)) {
				stream.spsAt = at + 3

				break
			}
		}

		if (stream.spsAt < 0) {
			stream.searched = Math.max(stream.searched, length - 3)

			if (complete || length >= buffer.length) {
				stream.collecting = false
			}

			return
		}

		stream.searched = stream.spsAt + 1
	}

	let end = -1

	for (let at = stream.searched; at + 2 < length; at++) {
		if (buffer[at] === 0 && buffer[at + 1] === 0 && (buffer[at + 2] ?? 0) <= 1) {
			end = at

			break
		}
	}

	if (end < 0) {
		stream.searched = Math.max(stream.searched, length - 2)

		if (!complete && length < buffer.length) {
			return
		}

		end = length
	}

	const nal = buffer.subarray(stream.spsAt, end)

	if (stream.need === "avc") {
		const sps = parseAvcSps(nal)

		stream.picture = sps
		stream.codecString = sps === null ? null : avcConfigCodecString(stream.fourcc, sps)
	} else {
		const sps = parseHevcSps(nal)

		stream.picture = sps
		stream.codecString = sps === null ? null : hevcConfigCodecString(stream.fourcc, sps)
	}

	if (stream.picture === null) {
		stream.collecting = false

		return
	}

	resolve(stream)
}

function inspect(stream: Stream, complete: boolean): void {
	if (stream.need === "avc" || stream.need === "hevc") {
		inspectVideo(stream, complete)
	} else if (stream.need !== null) {
		inspectAudio(stream, AUDIO_HEADERS[stream.need], complete)
	}
}

function feedStream(walk: Walk, stream: Stream, payload: Uint8Array, unitStart: boolean): void {
	if (unitStart) {
		if (stream.collecting) {
			inspect(stream, true)
		}

		stream.collecting = false

		const pes = pesStart(payload)

		if (pes === null) {
			return
		}

		if (stream.pid === walk.timingPid && pes.pts !== null && walk.firstPts === null) {
			walk.firstPts = pes.pts
		}

		if (stream.need === null) {
			return
		}

		stream.buffer ??= new Uint8Array(stream.kind === "video" ? VIDEO_PREFIX_BYTES : AUDIO_PREFIX_BYTES)
		stream.collecting = true
		stream.length = 0
		stream.spsAt = -1
		stream.searched = 0
		payload = payload.subarray(pes.data)
	} else if (!stream.collecting) {
		return
	}

	const buffer = stream.buffer

	if (buffer === null) {
		return
	}

	const take = Math.min(payload.length, buffer.length - stream.length)

	buffer.set(payload.subarray(0, take), stream.length)
	stream.length += take
	inspect(stream, false)
}

// A PMT on a PID no PAT named (some streams carry none): a PSI payload whose first table is a PMT.
function guessedPmt(walk: Walk, packet: TsPacket): boolean {
	const { pid, payload } = packet

	if (pid === 0 || pid === 0x1fff) {
		return false
	}

	if (!packet.unitStart) {
		return walk.sections.has(pid)
	}

	return !(payload[0] === 0 && payload[1] === 0 && payload[2] === 1) && payload[1 + (payload[0] ?? 0)] === 0x02
}

function handlePacket(walk: Walk, bytes: Uint8Array, at: number): void {
	const packet = packetAt(bytes, at)

	if (packet === null) {
		return
	}

	const { pid, payload, unitStart } = packet

	if (walk.pmtFound) {
		const stream = walk.byPid.get(pid)

		if (stream !== undefined) {
			feedStream(walk, stream, payload, unitStart)
		}

		return
	}

	if (pid === 0 && !walk.patFound) {
		const section = feedSection(walk, pid, payload, unitStart)

		if (section?.[0] === 0x00) {
			readPat(walk, section)
		}
	} else if (pid === walk.pmtPid || (walk.pmtPid === null && guessedPmt(walk, packet))) {
		const section = feedSection(walk, pid, payload, unitStart)

		if (section?.[0] === 0x02) {
			readPmt(walk, section)
		}
	}
}

function settled(walk: Walk): boolean {
	return walk.pmtFound && walk.streams.every(stream => stream.need === null) && (walk.timingPid === null || walk.firstPts !== null)
}

async function scanHead(source: BlockSource, walk: Walk, layout: TsLayout, limit: number): Promise<void> {
	const packets = packetCount(limit, layout)

	for (let first = 0; first < packets && !settled(walk); first += CHUNK_PACKETS) {
		const count = Math.min(CHUNK_PACKETS, packets - first)
		const bytes = await readBytes(source, first * layout.stride + layout.prefix, (count - 1) * layout.stride + TS_PACKET_BYTES)

		for (let k = 0; k < count; k++) {
			handlePacket(walk, bytes, k * layout.stride)
		}
	}

	for (const stream of walk.streams) {
		if (stream.collecting) {
			inspect(stream, true)
		}
	}
}

function modulo(value: number, divisor: number): number {
	return ((value % divisor) + divisor) % divisor
}

// The residue (mod stride) of the sync byte positions in the tail chunk at `base`: the file's own grid,
// or the one its tail moved to (a capture cut and joined), or null when none lines up.
function tailGrid(bytes: Uint8Array, base: number, stride: number, expected: number): number | null {
	const fits = (residue: number): boolean => {
		let hits = 0

		for (let at = modulo(residue - base, stride); at + TS_PACKET_BYTES <= bytes.length && hits < TS_SNIFF_PACKETS; at += stride) {
			if (bytes[at] !== TS_SYNC) {
				return false
			}

			hits++
		}

		return hits >= TS_MIN_PACKETS
	}

	if (fits(expected)) {
		return expected
	}

	for (let residue = 0; residue < stride; residue++) {
		if (residue !== expected && fits(residue)) {
			return residue
		}
	}

	return null
}

// PTS of the timing stream's last PES starts, latest first. Walks back packet by packet reading only
// headers, and a whole packet only where the timing stream's PES starts.
async function tailTimestamps(source: BlockSource, pid: number, layout: TsLayout): Promise<number[]> {
	const { size } = source
	const { stride } = layout
	const floor = Math.max(0, size - TAIL_BYTES)
	const probeStart = Math.max(floor, size - TS_SNIFF_PACKETS * stride - TS_PACKET_BYTES)
	const grid = tailGrid(await readBytes(source, probeStart, size - probeStart), probeStart, stride, layout.prefix % stride)
	const found: number[] = []

	if (grid === null) {
		return found
	}

	const firstSync = probeStart + modulo(grid - probeStart, stride)

	for (
		let at = firstSync + Math.floor((size - TS_PACKET_BYTES - firstSync) / stride) * stride;
		at >= floor && found.length < TAIL_PES;
		at -= stride
	) {
		const header = await readBytes(source, at, 4)

		if (header[0] !== TS_SYNC || ((header[1] ?? 0) & 0x40) === 0 || ((((header[1] ?? 0) & 0x1f) << 8) | (header[2] ?? 0)) !== pid) {
			continue
		}

		const packet = packetAt(await readBytes(source, at, TS_PACKET_BYTES), 0)
		const pts = packet === null ? null : pesStart(packet.payload)?.pts

		if (pts !== null && pts !== undefined) {
			found.push(pts)
		}
	}

	return found
}

// The duration is the timing stream's PTS span, head to tail, across one 33-bit wrap. The index is "none":
// TS has none, and the remux's demuxer seeks by bisecting PES timestamps, so no seek scans the file.
export async function walkMpegTs(source: BlockSource, tier: ProbeTier, result: ParsedContainer, layout: TsLayout): Promise<void> {
	const walk: Walk = {
		sections: new Map(),
		patFound: false,
		pmtPid: null,
		pmtFound: false,
		malformed: false,
		streams: [],
		byPid: new Map(),
		timingPid: null,
		firstPts: null
	}

	result.index = "none"

	if (tier === "full") {
		source.allowBlockReads(FULL_BLOCK_READS)
	}

	await scanHead(source, walk, layout, Math.min(source.size, HEAD_BYTES[tier]))

	let firstAudio = true

	for (const stream of walk.streams) {
		if (stream.kind === "video") {
			result.tracks.push(elementaryVideoTrack(stream))

			continue
		}

		result.tracks.push(elementaryAudioTrack(stream.pid, stream, stream.lang, firstAudio))
		firstAudio = false
	}

	result.tracksFound = walk.pmtFound
	result.partial = walk.malformed || walk.streams.some(stream => stream.need !== null)

	if (walk.timingPid === null) {
		return
	}

	const first = walk.firstPts
	const lasts = first === null ? [] : await tailTimestamps(source, walk.timingPid, layout)
	let span = -1

	for (const last of lasts) {
		span = Math.max(span, ptsSpan(first ?? 0, last))
	}

	const duration = ptsSpanSeconds(span)

	if (duration === null) {
		result.partial = true
	} else {
		result.durationSec = duration
	}
}
