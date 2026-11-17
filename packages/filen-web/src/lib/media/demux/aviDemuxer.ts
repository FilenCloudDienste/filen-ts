import { InputFormat, type AudioCodec, type Demuxer, type Input, type VideoCodec } from "mediabunny"
import {
	annexBNal,
	avcConfigCodecString,
	aviFirstChunk,
	avcPpsPocPresent,
	aviLists,
	BLOCK_BYTES,
	mpegAudioHeader,
	parseAvcSps,
	parseAviHeader,
	type AviStream,
	type MediaCodec,
	type ByteRange,
	type ReadAt
} from "@filen/shared/videos"
import {
	avcPicture,
	cloneTimeline,
	withParameterSets,
	freshTimeline,
	type AvcParameters,
	type AvcTimelineState
} from "@/lib/media/demux/avcTimeline"
import { blockCacheOf } from "@/lib/media/demux/inputCache"
import { MAX_PARTS, PacketDemuxer, readAt, type ContainerReader, type DemuxPacket, type DemuxTrack } from "@/lib/media/demux/packetDemuxer"

// AVI: a movi list of chunks, one stream's frame (or a stretch of its audio) each, in decode order with no
// timestamps; a chunk's time is how many ticks of its stream came before it. Positions with known tick counts come
// from the start of the data, the OpenDML index (one ix## read per seek) or idx1 (read once, past the block cache);
// a file without either is read from the start. H.264 presentation times come from picture order counts.

const WINDOW_BYTES = 256 * 1024
// The head of a picture chunk read when the chunk is past the window: its first slice header and parameter sets.
const PICTURE_HEAD_BYTES = 16 * 1024
// idx1 entries read per pass.
const IDX1_SLICE_BYTES = 1024 * 1024
const IDX1_ENTRY_BYTES = 16
const AVIIF_KEYFRAME = 0x10
// An OpenDML standard index entry's size flag: set on a chunk that is not a keyframe.
const ODML_DELTA = 0x80000000
// The key index keeps at most one position this often (an audio-only file's, too), and at most this many: past it,
// every other one goes and the spacing doubles.
const KEY_INDEX_SECONDS = 1
const MAX_KEY_INDEX_ENTRIES = 8192
// Decoding states kept for later reads: a key picture's only this far past the one before it, and at most this many
// (past it, every other one goes).
const CHECKPOINT_SPACING_BYTES = 1024 * 1024
const MAX_CHECKPOINTS = 512
// A chunk larger than this is no frame this plays: skipped.
const MAX_CHUNK_BYTES = 32 * 1024 * 1024
// The most of one OpenDML standard index read.
const MAX_STANDARD_INDEX_BYTES = 1024 * 1024

const VIDEO_CODECS: Partial<Record<MediaCodec, VideoCodec>> = { h264: "avc", hevc: "hevc", vp8: "vp8", vp9: "vp9", av1: "av1" }

function uint16le(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
}

function uint32le(bytes: Uint8Array, at: number): number {
	return uint16le(bytes, at) + uint16le(bytes, at + 2) * 0x10000
}

function fourcc(bytes: Uint8Array, at: number): string {
	return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0)
}

// The stream a data chunk id ("01wb", "00dc") belongs to; null for any other chunk.
function chunkStream(id: string): number | null {
	if (!/^\d\d(dc|db|wb|pc)$/.test(id)) {
		return null
	}

	return Number(id.slice(0, 2))
}

// The decoding state at a chunk: ticks of each stream before it, the H.264 picture order count, and an MP3 frame cut
// by the chunk before.
interface AviState {
	ticks: number[]
	timeline: AvcTimelineState
	carry: Map<number, { bytes: Uint8Array; pts: number }>
}

function cloneState(state: AviState): AviState {
	return { ticks: [...state.ticks], timeline: cloneTimeline(state.timeline), carry: new Map(state.carry) }
}

interface AvcStream extends AvcParameters {
	// Length-prefixed NAL units (an avcC in strf) rather than Annex B.
	lengthSize: number | null
	// Annex B parameter sets kept in strf, put in front of key pictures that carry none.
	parameterSets: Uint8Array | null
}

interface Track {
	stream: AviStream
	index: number
	video: DemuxTrack | null
	audio: DemuxTrack | null
	avc: AvcStream | null
	// MPEG audio, re-framed one frame per packet.
	mpegAudio: boolean
}

function videoTrack(stream: AviStream, index: number, avc: AvcStream | null, extradata: Uint8Array | null): DemuxTrack {
	const probed = stream.video
	const codec = probed?.codec === null || probed === null ? null : (VIDEO_CODECS[probed.codec] ?? null)
	const width = avc?.sps.width ?? probed?.w ?? 0
	const height = avc?.sps.height ?? probed?.h ?? 0
	const par = avc?.sps.par ?? 1
	const codecString = codec === "avc" ? (avc === null ? null : avcConfigCodecString("avc1", avc.sps)) : codec === "vp8" ? "vp8" : null

	return {
		type: "video",
		number: index + 1,
		name: stream.name,
		language: "und",
		isDefault: true,
		internalCodecId: probed?.fourcc ?? null,
		codec: codecString === null ? null : codec,
		width,
		height,
		squarePixelWidth: par > 1 ? Math.round(width * par) : width,
		squarePixelHeight: par < 1 ? Math.round(height / par) : height,
		decoderConfig:
			codecString === null
				? null
				: {
						codec: codecString,
						codedWidth: width,
						codedHeight: height,
						...(avc?.lengthSize === null || extradata === null ? {} : { description: extradata })
					}
	}
}

function pcmCodec(tag: number, bits: number): AudioCodec | null {
	if (tag === 0x0003) {
		return bits === 64 ? "pcm-f64" : bits === 32 ? "pcm-f32" : null
	}

	return bits === 8 ? "pcm-u8" : bits === 16 ? "pcm-s16" : bits === 24 ? "pcm-s24" : bits === 32 ? "pcm-s32" : null
}

function audioTrack(stream: AviStream, index: number, isDefault: boolean): DemuxTrack {
	const strf = stream.strf ?? new Uint8Array()
	const probed = stream.audio
	let tag = uint16le(strf, 0)
	const bits = uint16le(strf, 14)
	const extraLength = strf.length >= 18 ? Math.min(uint16le(strf, 16), strf.length - 18) : 0

	if (tag === 0xfffe && extraLength >= 22) {
		tag = uint16le(strf, 24)
	}

	const channels = probed?.ch ?? 2
	const sampleRate = probed?.rate ?? 48000
	let codec: AudioCodec | null = null
	let config: AudioDecoderConfig | null = null

	if (probed?.codec === "pcm") {
		codec = pcmCodec(tag, bits)
		config = codec === null ? null : { codec, numberOfChannels: channels, sampleRate }
	} else if (probed?.codec === "mp3" || probed?.codec === "ac3" || probed?.codec === "dts" || probed?.codec === "aac") {
		codec = probed.codec
		// AAC without an AudioSpecificConfig is ADTS framed (WAVE_FORMAT_MPEG_ADTS_AAC), which needs none.
		const description = codec === "aac" && extraLength >= 2 ? strf.subarray(18, 18 + extraLength) : null

		config = {
			codec: codec === "mp3" ? "mp3" : (probed.codecString ?? codec),
			numberOfChannels: channels,
			sampleRate,
			...(description === null ? {} : { description })
		}
	}

	return {
		type: "audio",
		number: index + 1,
		name: stream.name,
		language: "und",
		isDefault,
		internalCodecId: tag,
		codec,
		channels,
		sampleRate,
		decoderConfig: config
	}
}

class AviReader implements ContainerReader {
	public readonly tracks: DemuxTrack[]
	public readonly duration: number | null
	public readonly dataStart: number
	private readonly input: Input
	private readonly size: number
	private readonly movi: ByteRange
	private readonly idx1: ByteRange | null
	private readonly streams: Track[]
	private readonly video: Track | null
	// States at chunk positions, sorted by position: the data's start, every key picture read, every index position
	// handed out, and where each read stopped.
	private readonly checkpoints = new Map<number, AviState>()
	private readonly checkpointOrder: number[] = []
	private readonly initial: AviState
	private keyIndex: KeyIndex | null | undefined

	public constructor(input: Input, size: number, movi: ByteRange, idx1: ByteRange | null, streams: Track[]) {
		this.input = input
		this.size = size
		this.movi = movi
		this.idx1 = idx1
		this.streams = streams
		this.dataStart = movi.start
		this.video = streams.find(track => track.video !== null) ?? null
		this.tracks = streams.flatMap(track => track.video ?? track.audio ?? [])

		const timing = this.video ?? streams.find(track => track.audio !== null) ?? null
		const span = timing === null || timing.stream.rate === 0 ? null : (timing.stream.length * timing.stream.scale) / timing.stream.rate

		this.duration = span === null || !Number.isFinite(span) || span <= 0 ? null : span
		this.initial = { ticks: streams.map(() => 0), timeline: freshTimeline(), carry: new Map() }
		this.remember(movi.start, this.initial)
	}

	private remember(pos: number, state: AviState): void {
		if (!this.checkpoints.has(pos)) {
			this.checkpointOrder.splice(this.atOrBefore(pos) + 1, 0, pos)
		}

		this.checkpoints.set(pos, cloneState(state))

		if (this.checkpointOrder.length > MAX_CHECKPOINTS) {
			// Every other one goes; the data's start and the one just kept stay.
			const kept = this.checkpointOrder.filter((at, i) => i % 2 === 0 || at === pos || at === this.movi.start)

			for (const at of this.checkpointOrder) {
				if (!kept.includes(at)) {
					this.checkpoints.delete(at)
				}
			}

			this.checkpointOrder.splice(0, this.checkpointOrder.length, ...kept)
		}
	}

	// Index in checkpointOrder of the latest position at or before `pos`, -1 for none.
	private atOrBefore(pos: number): number {
		let low = 0
		let high = this.checkpointOrder.length - 1

		while (low <= high) {
			const middle = (low + high) >> 1

			if ((this.checkpointOrder[middle] ?? Infinity) <= pos) {
				low = middle + 1
			} else {
				high = middle - 1
			}
		}

		return high
	}

	// The latest checkpoint at or before `pos`.
	private checkpointAt(pos: number): { pos: number; state: AviState } {
		const found = this.checkpointOrder[this.atOrBefore(pos)] ?? this.movi.start

		return { pos: found, state: cloneState(this.checkpoints.get(found) ?? this.initial) }
	}

	private seconds(track: Track, ticks: number): number {
		return track.stream.rate === 0 ? 0 : ((track.stream.start + ticks) * track.stream.scale) / track.stream.rate
	}

	public async readPackets(pos: number): Promise<{ packets: DemuxPacket[]; next: number } | null> {
		const end = Math.min(this.movi.end, this.size)

		if (pos + 8 > end) {
			return null
		}

		const checkpoint = this.checkpointAt(pos)
		const state = checkpoint.state
		const packets: DemuxPacket[] = []
		let at = checkpoint.pos
		let windowStart = at
		let window: Uint8Array = new Uint8Array()

		// Chunks before `pos` (from the checkpoint) only advance the state; chunks from `pos` on make packets until the
		// window past `pos` is used up.
		for (;;) {
			if (at + 8 > end || (at >= pos && at - pos >= WINDOW_BYTES)) {
				break
			}

			if (at + 8 > windowStart + window.length) {
				windowStart = at
				window = (await readAt(this.input, at, Math.min(WINDOW_BYTES, end - at))) ?? new Uint8Array()

				if (window.length < 8) {
					break
				}
			}

			const offset = at - windowStart
			const id = fourcc(window, offset)
			const size = uint32le(window, offset + 4)

			if (id === "LIST") {
				at += 12

				continue
			}

			const index = chunkStream(id)
			const track = index === null ? undefined : this.streams[index]

			if (track !== undefined) {
				const dataEnd = offset + 8 + size
				const data = dataEnd <= window.length ? window.subarray(offset + 8, dataEnd) : null

				await this.chunk(track, at, size, data, state, at >= pos ? packets : null)
			}

			at += 8 + size + (size & 1)
		}

		if (at <= pos) {
			return null
		}

		this.remember(at, state)

		return { packets, next: at }
	}

	// One data chunk at `at`: its packets go to `out` (null while catching up to a read's start).
	private async chunk(
		track: Track,
		at: number,
		size: number,
		window: Uint8Array | null,
		state: AviState,
		out: DemuxPacket[] | null
	): Promise<void> {
		const ticks = state.ticks[track.index] ?? 0
		const pts = this.seconds(track, ticks)
		const sampleSize = track.stream.sampleSize

		state.ticks[track.index] = ticks + (sampleSize > 0 ? Math.floor(size / sampleSize) : 1)

		if (size > MAX_CHUNK_BYTES) {
			return
		}

		if (track.video !== null) {
			if (size > 0) {
				await this.picture(track, at, size, window, pts, state, out)
			}

			return
		}

		if (track.audio === null || size === 0) {
			return
		}

		if (!track.mpegAudio) {
			out?.push({
				track: track.index + 1,
				pts,
				duration: this.audioDuration(track, size),
				key: true,
				unit: at,
				part: 0,
				pos: at + 8,
				size
			})

			return
		}

		const data = window ?? (await readAt(this.input, at + 8, size)) ?? new Uint8Array()

		this.mpegFrames(track, at, data, pts, state, out)
	}

	private audioDuration(track: Track, size: number): number {
		const ticks = track.stream.sampleSize > 0 ? size / track.stream.sampleSize : 1

		return track.stream.rate === 0 ? 0 : (ticks * track.stream.scale) / track.stream.rate
	}

	// MPEG audio cut into its frames, one packet each; a frame the chunk ends inside is finished by the next chunk.
	private mpegFrames(track: Track, at: number, data: Uint8Array, chunkPts: number, state: AviState, out: DemuxPacket[] | null): void {
		const carried = state.carry.get(track.index) ?? null
		const bytes = carried === null ? data : concat(carried.bytes, data)
		const base = carried === null ? 0 : carried.bytes.length
		let pts = carried?.pts ?? chunkPts
		let part = 0
		let offset = 0

		state.carry.delete(track.index)

		while (offset + 4 <= bytes.length) {
			const header = mpegAudioHeader(bytes, offset)
			// A free-format frame states no length to step by: resync past it.
			const frameBytes = header === null ? null : header.frameBytes

			if (header === null || frameBytes === null) {
				offset++

				continue
			}

			const frameEnd = offset + frameBytes

			if (frameEnd > bytes.length) {
				break
			}

			const duration = header.samples / header.rate

			if (part < MAX_PARTS) {
				out?.push({
					track: track.index + 1,
					pts,
					duration,
					key: true,
					unit: at,
					part: part++,
					pos: at + 8 + offset - base,
					size: frameBytes,
					...(offset < base ? { payload: bytes.slice(offset, frameEnd) } : {})
				})
			}

			pts += duration
			offset = frameEnd
		}

		if (offset < bytes.length) {
			state.carry.set(track.index, { bytes: bytes.slice(offset), pts })
		}
	}

	private async picture(
		track: Track,
		at: number,
		size: number,
		window: Uint8Array | null,
		dts: number,
		state: AviState,
		out: DemuxPacket[] | null
	): Promise<void> {
		const frame = track.stream.rate === 0 ? 0 : track.stream.scale / track.stream.rate
		const avc = track.avc
		let key = true
		let pts = dts

		let payload: Uint8Array | null = null

		if (avc !== null) {
			const head = window ?? (await readAt(this.input, at + 8, Math.min(size, PICTURE_HEAD_BYTES))) ?? new Uint8Array()
			const picture = avcPicture(head, avc.lengthSize, avc, state.timeline, dts, false, frame)

			key = picture.key
			pts = picture.pts ?? dts

			if (key && !picture.parameterSets && avc.parameterSets !== null && out !== null) {
				const data = window !== null && window.length >= size ? window : await readAt(this.input, at + 8, size)

				payload = data === null ? null : withParameterSets(avc.parameterSets, data.subarray(0, size))
			}

			// A key picture is where a later read can start: the state before it (this chunk's tick taken back), kept
			// where no other is close before it.
			if (key && at - (this.checkpointOrder[this.atOrBefore(at)] ?? -Infinity) >= CHECKPOINT_SPACING_BYTES) {
				const ticks = [...state.ticks]

				ticks[track.index] = (ticks[track.index] ?? 1) - 1
				this.remember(at, { ticks, timeline: freshTimeline(), carry: state.carry })
			}
		}

		out?.push({
			track: track.index + 1,
			pts,
			duration: frame,
			key,
			unit: at,
			part: 0,
			pos: at + 8,
			size,
			...(payload === null ? {} : { payload })
		})
	}

	public resync(): Promise<number | null> {
		// Chunks carry no times: a position is only useful where an index says what came before it.
		return Promise.resolve(null)
	}

	public async indexedPosition(t: number): Promise<number | null> {
		const opendml = await this.openDmlPosition(t)

		if (opendml !== null) {
			return opendml
		}

		const index = await this.loadKeyIndex()

		if (index === null) {
			return null
		}

		const timing = this.video ?? this.streams.find(track => track.audio !== null)

		if (timing === undefined) {
			return null
		}

		const streams = this.streams.length
		let low = 0
		let high = index.positions.length - 1

		// The latest entry at or before `t`, by binary search on the timing stream's ticks.
		while (low <= high) {
			const middle = (low + high) >> 1

			if (this.seconds(timing, index.ticks[middle * streams + timing.index] ?? 0) <= t) {
				low = middle + 1
			} else {
				high = middle - 1
			}
		}

		const position = index.positions[high]

		if (position === undefined) {
			return this.movi.start
		}

		this.remember(position, {
			ticks: Array.from(index.ticks.subarray(high * streams, (high + 1) * streams)),
			timeline: freshTimeline(),
			carry: new Map()
		})

		return position
	}

	// idx1, walked once in slices read past the block cache: key picture chunk positions (for an audio-only file, any
	// of its chunks) about once a second, with every stream's ticks before each.
	private async loadKeyIndex(): Promise<KeyIndex | null> {
		if (this.keyIndex !== undefined || this.idx1 === null) {
			return this.keyIndex ?? null
		}

		const { start, end } = this.idx1
		const cache = blockCacheOf(this.input)
		const read: ReadAt = (from, length) => (cache === null ? readAt(this.input, from, length) : cache.readThrough(from, from + length))
		const streams = this.streams.length
		const ticks = this.streams.map(() => 0)
		const timing = this.video ?? this.streams.find(track => track.audio !== null)
		const index = new KeyIndexBuilder(streams)
		let base: number | null = null

		for (let at = start; timing !== undefined && at + IDX1_ENTRY_BYTES <= end;) {
			const length = Math.min(IDX1_SLICE_BYTES, end - at) - (Math.min(IDX1_SLICE_BYTES, end - at) % IDX1_ENTRY_BYTES)
			const slice = await read(at, length)

			if (slice === null || slice.length === 0) {
				break
			}

			for (let entry = 0; entry + IDX1_ENTRY_BYTES <= slice.length; entry += IDX1_ENTRY_BYTES) {
				const stream = chunkStream(fourcc(slice, entry))
				const track = stream === null ? undefined : this.streams[stream]

				if (track === undefined) {
					continue
				}

				const offset = uint32le(slice, entry + 8)
				const size = uint32le(slice, entry + 12)

				base ??= await this.idx1Base(offset)

				if (track === timing && (track !== this.video || (uint32le(slice, entry + 4) & AVIIF_KEYFRAME) !== 0)) {
					index.add(base + offset, this.seconds(track, ticks[track.index] ?? 0), ticks)
				}

				ticks[track.index] =
					(ticks[track.index] ?? 0) + (track.stream.sampleSize > 0 ? Math.floor(size / track.stream.sampleSize) : 1)
			}

			at += slice.length
		}

		this.keyIndex = index.build()

		return this.keyIndex
	}

	// idx1 offsets count from the movi list's type field, or (some writers) from the file's start: whichever names a
	// chunk header with a stream id.
	private async idx1Base(first: number): Promise<number> {
		const relative = this.movi.start - 4
		const header = await readAt(this.input, relative + first, 4)

		return header !== null && chunkStream(fourcc(header, 0)) !== null ? relative : 0
	}

	// The OpenDML super index of the picture stream: the one ix## covering `t`, read for its last key picture at or
	// before `t`; the other streams' ticks there come from their own ix## covering the same time.
	private async openDmlPosition(t: number): Promise<number | null> {
		const video = this.video

		if (video?.stream.superIndex == null) {
			return null
		}

		const target = Math.floor((t * video.stream.rate) / Math.max(1, video.stream.scale)) - video.stream.start
		const entries = await this.standardIndex(video, target)

		if (entries === null) {
			return null
		}

		let key: { position: number; tick: number } | null = null

		for (const [i, entry] of entries.entries.entries()) {
			const tick = entries.firstTick + i

			if (tick > target) {
				break
			}

			if (entry.key) {
				key = { position: entry.position, tick }
			}
		}

		if (key === null) {
			return null
		}

		const ticks: number[] = []

		for (const track of this.streams) {
			ticks[track.index] = track === video ? key.tick : await this.ticksBefore(track, key.position, this.seconds(video, key.tick))
		}

		this.remember(key.position, { ticks, timeline: freshTimeline(), carry: new Map() })

		return key.position
	}

	// A stream's ticks before the chunk at `position`, from its ix## covering `seconds`; estimated from its rate where
	// it has none.
	private async ticksBefore(track: Track, position: number, seconds: number): Promise<number> {
		const estimate = Math.max(0, Math.floor((seconds * track.stream.rate) / Math.max(1, track.stream.scale)) - track.stream.start)

		if (track.stream.superIndex === null) {
			return estimate
		}

		const index = await this.standardIndex(track, estimate)

		if (index === null) {
			return estimate
		}

		let ticks = index.firstTick

		for (const entry of index.entries) {
			if (entry.position >= position) {
				return ticks
			}

			ticks += track.stream.sampleSize > 0 ? Math.floor(entry.size / track.stream.sampleSize) : 1
		}

		return ticks
	}

	// The standard index (ix##) the super index points to for the stretch holding tick `target`, with the ticks
	// before it; null when the super index or the chunk is unreadable.
	private async standardIndex(
		track: Track,
		target: number
	): Promise<{ firstTick: number; entries: { position: number; size: number; key: boolean }[] } | null> {
		const index = track.stream.superIndex

		// wLongsPerEntry 4, an index of indexes (bIndexType 0), entries from byte 24.
		if (index === null || index.length < 24 || index[3] !== 0) {
			return null
		}

		const count = uint32le(index, 4)
		let firstTick = 0

		for (let i = 0; i < count && 24 + i * 16 + 16 <= index.length; i++) {
			const at = 24 + i * 16
			const offset = uint32le(index, at) + uint32le(index, at + 4) * 0x100000000
			const size = uint32le(index, at + 8)
			const duration = uint32le(index, at + 12)

			if (target >= firstTick + duration && i + 1 < count) {
				firstTick += duration

				continue
			}

			// dwSize counts the chunk with or without its header, by writer: read the header's worth more.
			const chunk =
				offset + 8 <= this.size
					? await readAt(this.input, offset, Math.min(size + 8, MAX_STANDARD_INDEX_BYTES, this.size - offset))
					: null

			// ix## header: id, size, then wLongsPerEntry 2, sub-type, bIndexType 1, entries, chunk id, base offset.
			if (chunk === null || chunk.length < 32 || chunk[11] !== 1) {
				return null
			}

			const entries: { position: number; size: number; key: boolean }[] = []
			const inUse = uint32le(chunk, 12)
			const baseOffset = uint32le(chunk, 20) + uint32le(chunk, 24) * 0x100000000

			for (let entry = 0; entry < inUse && 32 + entry * 8 + 8 <= chunk.length; entry++) {
				const raw = uint32le(chunk, 32 + entry * 8 + 4)

				// dwOffset points at the chunk's data; its header is the 8 bytes before.
				entries.push({
					position: baseOffset + uint32le(chunk, 32 + entry * 8) - 8,
					size: raw & 0x7fffffff,
					key: (raw & ODML_DELTA) === 0
				})
			}

			return { firstTick, entries }
		}

		return null
	}
}

// The key index: positions and, flat, every stream's ticks before each.
export interface KeyIndex {
	positions: Float64Array
	ticks: Float64Array
}

export class KeyIndexBuilder {
	private readonly streams: number
	private positions: number[] = []
	private ticks: number[] = []
	private spacing = KEY_INDEX_SECONDS
	private last = -Infinity

	public constructor(streams: number) {
		this.streams = streams
	}

	public add(position: number, seconds: number, ticks: readonly number[]): void {
		if (seconds - this.last < this.spacing) {
			return
		}

		this.last = seconds
		this.positions.push(position)

		for (let stream = 0; stream < this.streams; stream++) {
			this.ticks.push(ticks[stream] ?? 0)
		}

		if (this.positions.length > MAX_KEY_INDEX_ENTRIES) {
			this.positions = this.positions.filter((_, i) => i % 2 === 0)
			this.ticks = this.ticks.filter((_, i) => Math.floor(i / this.streams) % 2 === 0)
			this.spacing *= 2
		}
	}

	public build(): KeyIndex | null {
		return this.positions.length === 0 ? null : { positions: Float64Array.from(this.positions), ticks: Float64Array.from(this.ticks) }
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length)

	out.set(a)
	out.set(b, a.length)

	return out
}

async function openAvi(input: Input): Promise<ContainerReader> {
	const size = input._reader.fileSize ?? 0
	const read: ReadAt = (start, length) => readAt(input, start, length)
	const lists = await aviLists(read, size)
	const hdrl = lists.hdrl
	const movi = lists.movi ?? { start: size, end: size }
	// The header list read no further than the probe's walker reads it.
	const header = hdrl === null ? null : await read(hdrl.start, Math.min(hdrl.end, size, hdrl.start + BLOCK_BYTES) - hdrl.start)
	const streams = header === null ? [] : parseAviHeader(header).streams
	const tracks: Track[] = []
	let firstAudio = true

	for (const [index, stream] of streams.entries()) {
		const track: Track = { stream, index, video: null, audio: null, avc: null, mpegAudio: false }

		if (stream.kind === "vids" && stream.video !== null) {
			const strf = stream.strf ?? new Uint8Array()
			// The BITMAPINFOHEADER's size counts the extra data after its 40 bytes.
			const biSize = uint32le(strf, 0)
			const extradata = strf.length > 40 ? strf.subarray(40, biSize > 40 ? Math.min(biSize, strf.length) : strf.length) : null
			const avcC = extradata !== null && extradata[0] === 1 ? extradata : null

			if (stream.video.codec === "h264") {
				// The parameter sets: in an avcC after the BITMAPINFOHEADER, Annex B there, or in the first picture.
				const sample = avcC !== null ? null : (extradata ?? (await aviFirstChunk(read, movi, index, PICTURE_HEAD_BYTES)))
				const spsNal =
					avcC !== null
						? avcC.subarray(8, 8 + ((avcC[6] ?? 0) << 8) + (avcC[7] ?? 0))
						: sample === null
							? null
							: annexBNal(sample, byte => (byte & 0x1f) === 7)
				const ppsNal = avcC !== null ? null : sample === null ? null : annexBNal(sample, byte => (byte & 0x1f) === 8)
				const sps = spsNal === null ? null : parseAvcSps(spsNal)

				track.avc =
					sps === null
						? null
						: {
								sps,
								pocPresent: ppsNal === null ? false : (avcPpsPocPresent(ppsNal) ?? false),
								lengthSize: avcC === null ? null : ((avcC[4] ?? 3) & 0x03) + 1,
								parameterSets: avcC === null && extradata !== null && spsNal !== null ? extradata : null
							}
			}

			track.video = videoTrack(stream, index, track.avc, avcC)
		} else if (stream.kind === "auds" && stream.audio !== null) {
			track.audio = audioTrack(stream, index, firstAudio)
			track.mpegAudio = stream.audio.codec === "mp3" || stream.audio.codec === "mp2" || stream.audio.codec === "mp1"
			firstAudio = false
		}

		tracks.push(track)
	}

	return new AviReader(input, size, movi, lists.idx1, tracks)
}

class AviInputFormat extends InputFormat {
	public readonly name = "AVI"
	public readonly mimeType = "video/x-msvideo"
	public readonly supportsTimestampedMediaData = true

	public override async _getMatchPosition(input: Input): Promise<number | null> {
		const head = await readAt(input, 0, 12)

		return head !== null && fourcc(head, 0) === "RIFF" && fourcc(head, 8) === "AVI " ? 0 : null
	}

	public override _createDemuxer(input: Input): Demuxer {
		return new PacketDemuxer(input, "video/x-msvideo", openAvi)
	}
}

export const AVI = new AviInputFormat()
