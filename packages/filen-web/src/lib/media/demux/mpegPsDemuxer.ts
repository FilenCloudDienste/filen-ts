import { InputFormat, type AudioCodec, type Demuxer, type Input, type VideoCodec } from "mediabunny"
import {
	BitReader,
	BlockSource,
	MPEG_PS_PACK,
	MPEG_PS_PRIVATE_1,
	forEachMpegPsUnit,
	mpegPsPes,
	mpegPsStreamKey,
	readMpegPsStreams,
	unescapeRbsp,
	walkContainer,
	type MpegPsStream
} from "@filen/shared/videos"
import { avcParameters, avcPicture, freshTimeline, type AvcParameters, type AvcTimelineState } from "@/lib/media/demux/avcTimeline"
import { MAX_PARTS, PacketDemuxer, readAt, type ContainerReader, type DemuxPacket, type DemuxTrack } from "@/lib/media/demux/packetDemuxer"
import { frameAt } from "@/workers/remux/audioDuration.logic"
import { MAX_UNIT_BYTES, parseRawFrame, rawUnitLength } from "@/workers/remux/rawAudio.logic"

// MPEG program streams (.mpg, .mpeg, .vob): packs of PES packets, the same elementary streams as a transport stream
// carries, with PTS but no index. A picture runs from one PTS-bearing PES of its stream to the next; audio PES carry
// several frames, cut apart by their headers. Seeks interpolate over the file and resync on the next pack.

// Bytes of packs read at once.
const WINDOW_BYTES = 256 * 1024
// Bytes read past a window to finish the frames that started in it.
const FINISH_BYTES = 1024 * 1024
// How far a resync looks for the next pack.
const RESYNC_BYTES = 1024 * 1024
const HEAD_BYTES = 1024 * 1024
// A frame's duration where the SPS states none.
const DEFAULT_FRAME_SECONDS = 1 / 25
const PTS_HZ = 90_000
// The largest picture assembled; past it the stream is not one this plays.
const MAX_FRAME_BYTES = 16 * 1024 * 1024
// Private stream 1 headers: sub-stream id, frame count and first access unit; LPCM adds three bytes more.
const PRIVATE_HEADER_BYTES = 4
const LPCM_HEADER_BYTES = 7

type FrameKind = "mpeg-audio" | "dolby" | "dts" | "adts"

// What parseRawFrame reads of a header.
const RAW_HEADER_BYTES = 16

// The audio unit at `at`: an MPEG audio or ADTS frame, or an AC-3/E-AC-3 or DTS access unit with its dependent frames
// and extension substreams, by the parsers the bare streams and their durations already use. Null where none starts;
// "more" where one may, but `bytes` ends before it can tell.
function audioFrame(kind: FrameKind, bytes: Uint8Array, at: number): { bytes: number; samples: number; rate: number } | "more" | null {
	if (kind === "mpeg-audio" || kind === "adts") {
		const frame = frameAt(kind === "adts" ? "adts" : "mp3", bytes, at)

		return frame === null ? null : { bytes: frame.bytes, samples: frame.samples, rate: frame.rate }
	}

	if (at + RAW_HEADER_BYTES > bytes.length) {
		return "more"
	}

	const first = parseRawFrame(bytes, at)

	if (first === null || !first.unitStart || (kind === "dts") !== (first.codec === "dts")) {
		return null
	}

	// A unit's end is confirmed by the next unit's start.
	const length = rawUnitLength(bytes, at, first.codec, false)

	if (length === null) {
		return bytes.length - at < MAX_UNIT_BYTES ? "more" : null
	}

	return { bytes: length, samples: first.samples, rate: first.sampleRate }
}

interface Track {
	number: number
	stream: MpegPsStream
	demux: DemuxTrack
	frames: FrameKind | null
	lpcm: boolean
	// H.264: cut into access units and timed by picture order count.
	avc: AvcParameters | null
}

const FRAME_KINDS: Partial<Record<string, FrameKind>> = {
	mp1: "mpeg-audio",
	mp2: "mpeg-audio",
	mp3: "mpeg-audio",
	ac3: "dolby",
	eac3: "dolby",
	dts: "dts",
	aac: "adts"
}

function videoCodec(stream: MpegPsStream): VideoCodec | null {
	return stream.codecString === null ? null : stream.codec === "h264" ? "avc" : stream.codec === "hevc" ? "hevc" : null
}

function track(stream: MpegPsStream, number: number, isDefault: boolean): Track {
	if (stream.kind === "video") {
		const codec = videoCodec(stream)
		const width = stream.picture?.width ?? 0
		const height = stream.picture?.height ?? 0
		const par = stream.picture?.par ?? 1

		return {
			number,
			stream,
			frames: null,
			lpcm: false,
			avc: null,
			demux: {
				type: "video",
				number,
				name: null,
				language: "und",
				isDefault: true,
				internalCodecId: stream.fourcc,
				codec,
				width,
				height,
				squarePixelWidth: par > 1 ? Math.round(width * par) : width,
				squarePixelHeight: par < 1 ? Math.round(height / par) : height,
				decoderConfig:
					codec === null || stream.codecString === null
						? null
						: { codec: stream.codecString, codedWidth: width, codedHeight: height }
			}
		}
	}

	const lpcm = stream.codec === "pcm"
	const frames = stream.codec === null ? null : (FRAME_KINDS[stream.codec] ?? null)
	// MP1/MP2 frames are cut apart like MP3's, but no decoder here names them.
	const codec: AudioCodec | null = lpcm
		? "pcm-s16be"
		: stream.codec === "mp3" || stream.codec === "ac3" || stream.codec === "eac3" || stream.codec === "dts" || stream.codec === "aac"
			? stream.codec
			: null
	const channels = stream.ch ?? 2
	const sampleRate = stream.rate ?? 48000

	return {
		number,
		stream,
		frames: frames ?? (stream.need === "mpeg-audio" ? "mpeg-audio" : null),
		lpcm,
		avc: null,
		demux: {
			type: "audio",
			number,
			name: null,
			language: "und",
			isDefault,
			internalCodecId: stream.key,
			codec,
			channels,
			sampleRate,
			decoderConfig:
				codec === null
					? null
					: {
							codec: codec === "mp3" || codec === "pcm-s16be" ? codec : (stream.codecString ?? codec),
							numberOfChannels: channels,
							sampleRate
						}
		}
	}
}

// H.264 or HEVC: whether the access unit opens with a picture decoding can start at (an IDR or I slice, an IRAP).
function startsDecoding(codec: VideoCodec | null, data: Uint8Array): boolean {
	for (let at = 0; at + 4 < data.length; at++) {
		if (data[at] !== 0 || data[at + 1] !== 0 || data[at + 2] !== 1) {
			continue
		}

		const header = data[at + 3] ?? 0

		if (codec === "hevc") {
			const type = (header >> 1) & 0x3f

			if (type < 32) {
				return type >= 16 && type <= 23
			}

			continue
		}

		const type = header & 0x1f

		if (type === 5) {
			return true
		}

		if (type === 1) {
			const bits = new BitReader(unescapeRbsp(data.subarray(at + 4, at + 16)))

			bits.ue()

			const slice = bits.ue() ?? -1

			return slice === 2 || slice === 4 || slice === 7 || slice === 9
		}
	}

	return false
}

interface PendingVideo {
	bytes: Uint8Array
	// PES PTS by where its data starts in `bytes`.
	anchors: { at: number; pts: number }[]
	// The pack holding the PES whose data starts at each offset.
	units: { at: number; unit: number }[]
	// Access unit starts found so far, and how far `bytes` has been searched for them.
	starts: number[]
	scan: { at: number; picture: boolean }
	// Where the data read past the window starts; null while inside it.
	closingAt: number | null
	timeline: AvcTimelineState
}

// The PTS a PES gave the first access unit starting in it: the latest anchor at or before `start`, taken.
function takeAnchor(anchors: { at: number; pts: number }[], start: number): number | null {
	let found: number | null = null

	while (anchors.length > 0 && (anchors[0]?.at ?? Infinity) <= start) {
		found = anchors.shift()?.pts ?? found
	}

	return found
}

function unitAt(units: { at: number; unit: number }[], start: number): number {
	let found = units[0]?.unit ?? 0

	for (const entry of units) {
		if (entry.at > start) {
			break
		}

		found = entry.unit
	}

	return found
}

// Access unit starts in Annex B `bytes` from `scan.at` on: an access unit delimiter, an SEI or parameter set after a
// picture, or a picture whose first slice starts at macroblock 0 after a picture. `scan` keeps where the search
// stopped and whether a picture is open, across calls as `bytes` grows.
function auStarts(bytes: Uint8Array, scan: { at: number; picture: boolean }): number[] {
	const starts: number[] = []
	let at = scan.at

	for (; at + 4 < bytes.length; at++) {
		if (bytes[at] !== 0 || bytes[at + 1] !== 0 || bytes[at + 2] !== 1) {
			continue
		}

		const type = (bytes[at + 3] ?? 0) & 0x1f
		const slice = type === 1 || type === 5
		// first_mb_in_slice is ue(v): 0 is the single bit 1.
		const firstSlice = slice && ((bytes[at + 4] ?? 0) & 0x80) !== 0
		// The start code's leading zero byte (00 00 00 01) belongs to this unit.
		const start = at > 0 && bytes[at - 1] === 0 ? at - 1 : at

		if (type === 9 || (scan.picture && (type === 6 || type === 7 || type === 8 || firstSlice))) {
			starts.push(start)
			scan.picture = false
		}

		scan.picture ||= slice
		at += 3
	}

	scan.at = at

	return starts
}

interface PendingAudio {
	bytes: Uint8Array
	anchor: { at: number; pts: number } | null
	pts: number | null
	unit: number
}

interface Open {
	unit: number
	part: number
	pts: number
	chunks: Uint8Array[]
	length: number
}

class MpegPsReader implements ContainerReader {
	public readonly tracks: DemuxTrack[]
	public readonly duration: number | null
	public readonly dataStart = 0
	private readonly input: Input
	private readonly size: number
	private readonly streams: Map<number, Track>

	public constructor(input: Input, size: number, duration: number | null, streams: Map<number, Track>) {
		this.input = input
		this.size = size
		this.duration = duration
		this.streams = streams
		this.tracks = [...streams.values()].map(entry => entry.demux)
	}

	public async readPackets(pos: number): Promise<{ packets: DemuxPacket[]; next: number } | null> {
		if (pos + 4 > this.size) {
			return null
		}

		const windowEnd = Math.min(this.size, pos + WINDOW_BYTES)
		const bytes = (await readAt(this.input, pos, Math.min(this.size - pos, WINDOW_BYTES + FINISH_BYTES))) ?? new Uint8Array()
		const packets: DemuxPacket[] = []
		const open = new Map<number, Open>()
		const audio = new Map<number, PendingAudio>()
		const video = new Map<number, PendingVideo>()
		const parts = new Map<number, number>()
		let unit = pos
		// The first pack past the window: where the next read starts.
		const reach: { next: number | null } = { next: null }

		const partOf = (at: number): number | null => {
			const part = parts.get(at) ?? 0

			if (part >= MAX_PARTS) {
				return null
			}

			parts.set(at, part + 1)

			return part
		}

		forEachMpegPsUnit(bytes, 0, (id, at, end) => {
			const absolute = pos + at

			if (id === MPEG_PS_PACK) {
				unit = absolute

				if (absolute >= windowEnd) {
					reach.next ??= absolute

					// Past the window only what started in it is finished; once nothing is, the read ends.
					return open.size > 0 || audio.size > 0 || video.size > 0
				}

				return true
			}

			const pes = mpegPsPes(bytes, at, end)
			const key = pes === null || pes.data > end ? null : mpegPsStreamKey(bytes, id, pes.data)
			const entry = key === null ? undefined : this.streams.get(key)

			if (pes === null || key === null || entry === undefined) {
				return true
			}

			const inWindow = absolute < windowEnd

			if (entry.avc !== null) {
				this.accessUnits(
					entry,
					entry.avc,
					key,
					pes.pts,
					bytes.subarray(pes.data, end),
					inWindow,
					unit,
					video,
					packets,
					partOf,
					false
				)
			} else if (entry.demux.type === "video") {
				this.picture(entry, key, pes.pts, bytes.subarray(pes.data, end), inWindow, unit, open, packets, partOf)
			} else {
				this.sound(entry, key, pes.pts, bytes.subarray(pes.data, end), inWindow, unit, absolute, audio, packets, partOf)
			}

			return true
		})

		// Pictures still open at the end of what was read finish there.
		for (const key of video.keys()) {
			const entry = this.streams.get(key)

			if (entry?.avc != null) {
				this.accessUnits(entry, entry.avc, key, null, new Uint8Array(), false, unit, video, packets, partOf, true)
			}

			video.delete(key)
		}

		for (const [key, frame] of open) {
			const entry = this.streams.get(key)

			if (entry !== undefined && frame.length > 0) {
				packets.push(this.closed(entry, frame))
			}
		}

		packets.sort((a, b) => a.unit - b.unit || a.part - b.part)
		this.durations(packets)

		const end = reach.next ?? pos + bytes.length

		return end <= pos ? null : { packets, next: end }
	}

	private closed(entry: Track, frame: Open): DemuxPacket {
		// A copy, so the packet does not pin the window it was read from.
		const data = concat(frame.chunks, frame.length)

		return {
			track: entry.number,
			pts: frame.pts / PTS_HZ,
			duration: 0,
			key: startsDecoding(entry.demux.type === "video" ? entry.demux.codec : null, data),
			unit: frame.unit,
			part: frame.part,
			pos: frame.unit,
			size: data.length,
			payload: data
		}
	}

	// H.264 cut into access units (at an access unit delimiter, parameter sets after a picture, or a picture's first
	// slice), wherever the PES boundaries fall: a muxer may pack several pictures in one PES and give a PTS to the first
	// only. A PES's PTS goes to the first access unit starting in it; the others are timed by picture order count.
	// Past the window (`inWindow` false) no access unit starts any more; `flush` ends the last one at the data's end.
	private accessUnits(
		entry: Track,
		parameters: AvcParameters,
		key: number,
		pts: number | null,
		data: Uint8Array,
		inWindow: boolean,
		unit: number,
		video: Map<number, PendingVideo>,
		out: DemuxPacket[],
		partOf: (unit: number) => number | null,
		flush: boolean
	): void {
		let pending = video.get(key)

		if (pending === undefined) {
			if (!inWindow || pts === null) {
				return
			}

			// A PES with a PTS starts an access unit.
			pending = {
				bytes: new Uint8Array(),
				anchors: [],
				units: [],
				scan: { at: 0, picture: false },
				starts: [0],
				closingAt: null,
				timeline: freshTimeline()
			}
			video.set(key, pending)
		}

		if (data.length > 0) {
			const at = pending.bytes.length

			if (!inWindow) {
				pending.closingAt ??= at
			}

			if (pts !== null) {
				pending.anchors.push({ at, pts: pts / PTS_HZ })
			}

			pending.units.push({ at, unit })
			pending.bytes = concat([pending.bytes, data], at + data.length)
			for (const start of auStarts(pending.bytes, pending.scan)) {
				if (start > (pending.starts.at(-1) ?? -1)) {
					pending.starts.push(start)
				}
			}
		}

		const frame = parameters.sps.frameSeconds ?? DEFAULT_FRAME_SECONDS
		const bounds = flush ? [...pending.starts, pending.bytes.length] : pending.starts
		const closingAt = pending.closingAt
		let emitted = 0

		for (let i = 0; i + 1 < bounds.length; i++) {
			const start = bounds[i] ?? 0

			// One that starts past the window is the next read's.
			if (closingAt !== null && start >= closingAt) {
				break
			}

			const data = pending.bytes.slice(start, bounds[i + 1])
			const picture = avcPicture(data, null, parameters, pending.timeline, takeAnchor(pending.anchors, start), true, frame)
			const holder = unitAt(pending.units, start)
			const part = picture.pts === null ? null : partOf(holder)

			if (part !== null && picture.pts !== null) {
				out.push({
					track: entry.number,
					pts: picture.pts,
					duration: frame,
					key: picture.key || startsDecoding("avc", data),
					unit: holder,
					part,
					pos: holder,
					size: data.length,
					payload: data
				})
			}

			emitted = i + 1
		}

		const keep = bounds[emitted] ?? pending.bytes.length

		if (flush || (closingAt !== null && keep >= closingAt)) {
			video.delete(key)

			return
		}

		pending.bytes = pending.bytes.slice(keep)
		pending.scan.at = Math.max(0, pending.scan.at - keep)
		pending.starts = pending.starts.slice(emitted).map(start => start - keep)
		pending.anchors = pending.anchors.map(anchor => ({ at: anchor.at - keep, pts: anchor.pts }))
		pending.units = pending.units.map(holder => ({ at: holder.at - keep, unit: holder.unit }))
		pending.closingAt = closingAt === null ? null : closingAt - keep
	}

	// A PES of a picture stream: one with a PTS closes the picture open before it and opens the next (inside the window).
	private picture(
		entry: Track,
		key: number,
		pts: number | null,
		data: Uint8Array,
		inWindow: boolean,
		unit: number,
		open: Map<number, Open>,
		out: DemuxPacket[],
		partOf: (unit: number) => number | null
	): void {
		if (pts !== null) {
			const current = open.get(key)

			if (current !== undefined) {
				open.delete(key)
				out.push(this.closed(entry, current))
			}

			const part = inWindow ? partOf(unit) : null

			if (part !== null) {
				open.set(key, { unit, part, pts, chunks: [], length: 0 })
			}
		}

		const frame = open.get(key)

		if (frame !== undefined && frame.length + data.length <= MAX_FRAME_BYTES) {
			frame.chunks.push(data)
			frame.length += data.length
		}
	}

	// A PES of a sound stream: LPCM is a packet as it is; framed audio is cut into its frames, the PES's PTS going to
	// the first frame that starts in it.
	private sound(
		entry: Track,
		key: number,
		pts: number | null,
		payload: Uint8Array,
		inWindow: boolean,
		unit: number,
		pos: number,
		audio: Map<number, PendingAudio>,
		out: DemuxPacket[],
		partOf: (unit: number) => number | null
	): void {
		const skip = key >> 8 === MPEG_PS_PRIVATE_1 ? (entry.lpcm ? LPCM_HEADER_BYTES : PRIVATE_HEADER_BYTES) : 0
		const data = payload.subarray(Math.min(payload.length, skip))

		if (entry.lpcm || entry.frames === null) {
			const part = inWindow && pts !== null ? partOf(unit) : null
			// 20/24-bit DVD LPCM keeps its 3-byte header (quantisation, rate, channels), which FFmpeg's decoder reads.
			const grouped = entry.stream.codec === "lpcm"
			const bits = grouped ? 16 + (((data[1] ?? 0) >> 6) & 0x03) * 4 : 16
			const rate = entry.demux.type === "audio" ? (entry.demux.sampleRate * entry.demux.channels * bits) / 8 : 1

			if (part !== null && pts !== null) {
				out.push({
					track: entry.number,
					pts: pts / PTS_HZ,
					duration: (grouped ? Math.max(0, data.length - 3) : data.length) / rate,
					key: true,
					unit,
					part,
					pos,
					size: data.length,
					payload: data.slice()
				})
			}

			return
		}

		let pending = audio.get(key)

		if (pending === undefined) {
			if (!inWindow || pts === null) {
				return
			}

			pending = { bytes: new Uint8Array(), anchor: null, pts: null, unit }
			audio.set(key, pending)
		}

		if (pts !== null) {
			pending.anchor = { at: pending.bytes.length, pts }
		}

		// Past the window only the frames that started before this PES are kept.
		const before = inWindow ? Infinity : pending.bytes.length

		pending.bytes = concat([pending.bytes, data], pending.bytes.length + data.length)
		pending.unit = unit
		this.frames(entry, pending, out, partOf, before)

		if (!inWindow) {
			audio.delete(key)
		}
	}

	private frames(entry: Track, pending: PendingAudio, out: DemuxPacket[], partOf: (unit: number) => number | null, before: number): void {
		const kind = entry.frames

		if (kind === null) {
			return
		}

		let offset = 0

		while (offset + 12 <= pending.bytes.length) {
			const frame = audioFrame(kind, pending.bytes, offset)

			if (frame === "more") {
				break
			}

			if (frame === null) {
				offset++

				continue
			}

			if (offset + frame.bytes > pending.bytes.length) {
				break
			}

			if (pending.anchor !== null && offset >= pending.anchor.at) {
				pending.pts = pending.anchor.pts
				pending.anchor = null
			}

			const part = pending.pts !== null && offset < before ? partOf(pending.unit) : null

			if (part !== null && pending.pts !== null) {
				out.push({
					track: entry.number,
					pts: pending.pts / PTS_HZ,
					duration: frame.samples / frame.rate,
					key: true,
					unit: pending.unit,
					part,
					pos: pending.unit,
					size: frame.bytes,
					payload: pending.bytes.slice(offset, offset + frame.bytes)
				})
			}

			if (pending.pts !== null) {
				pending.pts += (frame.samples / frame.rate) * PTS_HZ
			}

			offset += frame.bytes
		}

		if (pending.anchor !== null) {
			pending.anchor = { at: pending.anchor.at - offset, pts: pending.anchor.pts }
		}

		pending.bytes = pending.bytes.slice(offset)
	}

	// A picture lasts until the next one shows: each one's duration from the presentation times of its stream.
	private durations(packets: DemuxPacket[]): void {
		const byTrack = new Map<number, DemuxPacket[]>()

		for (const packet of packets) {
			if (packet.duration === 0) {
				byTrack.set(packet.track, [...(byTrack.get(packet.track) ?? []), packet])
			}
		}

		for (const list of byTrack.values()) {
			const sorted = [...list].sort((a, b) => a.pts - b.pts)

			for (const [i, packet] of sorted.entries()) {
				const following = sorted[i + 1]

				packet.duration =
					following === undefined
						? sorted[i - 1] === undefined
							? 0
							: packet.pts - (sorted[i - 1]?.pts ?? 0)
						: following.pts - packet.pts
			}
		}
	}

	public async resync(pos: number): Promise<number | null> {
		for (let start = pos; start < Math.min(this.size, pos + RESYNC_BYTES); start += WINDOW_BYTES) {
			const bytes = await readAt(this.input, start, Math.min(WINDOW_BYTES + 3, this.size - start))

			if (bytes === null) {
				return null
			}

			for (let at = 0; at + 4 <= bytes.length; at++) {
				if (bytes[at] === 0 && bytes[at + 1] === 0 && bytes[at + 2] === 1 && bytes[at + 3] === MPEG_PS_PACK) {
					return start + at
				}
			}
		}

		return null
	}
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
	const out = new Uint8Array(length)
	let at = 0

	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.length
	}

	return out
}

async function openMpegPs(input: Input): Promise<ContainerReader> {
	const size = input._reader.fileSize ?? 0
	const head = (await readAt(input, 0, Math.min(size, HEAD_BYTES))) ?? new Uint8Array()
	const streams = new Map<number, Track>()
	let number = 1
	let firstAudio = true

	// The parameter sets for H.264 timing: the head's first SPS and PPS (a program stream carries one picture stream).
	const parameters = avcParameters(head, null)

	for (const stream of readMpegPsStreams(head)) {
		const entry = track(stream, number++, stream.kind === "audio" && firstAudio)

		entry.avc = entry.demux.type === "video" && entry.demux.codec === "avc" ? parameters : null
		streams.set(stream.key, entry)
		firstAudio &&= stream.kind !== "audio"
	}

	// The duration as the probe reads it: the timing stream's PTS span, from the head and the tail.
	const parsed = await walkContainer(
		new BlockSource(size, async (start, end) => (await readAt(input, start, end - start)) ?? new Uint8Array()),
		"card"
	)

	return new MpegPsReader(input, size, parsed?.durationSec ?? null, streams)
}

class MpegPsInputFormat extends InputFormat {
	public readonly name = "MPEG-PS"
	public readonly mimeType = "video/mpeg"
	public readonly supportsTimestampedMediaData = true

	public override async _getMatchPosition(input: Input): Promise<number | null> {
		const head = await readAt(input, 0, 4)

		return head !== null && head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === MPEG_PS_PACK ? 0 : null
	}

	public override _createDemuxer(input: Input): Demuxer {
		return new PacketDemuxer(input, "video/mpeg", openMpegPs)
	}
}

export const MPEG_PS = new MpegPsInputFormat()
