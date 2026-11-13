import {
	ADTS,
	EncodedPacketSink,
	FLAC,
	MATROSKA,
	MP3,
	WEBM,
	type EncodedPacket,
	type Input,
	type InputAudioTrack,
	type InputFormat
} from "mediabunny"
import { BlockSource, walkContainer } from "@filen/shared/videos"
import type { BlockCache } from "@/lib/media/blockCache"
import { openBlockInput, type BlockInput } from "@/lib/media/blockInput"
import { AUDIO_UNSUPPORTED_ERROR, type RemuxStats } from "@/lib/media/remuxTypes"
import { sampleReader, type SampleItem, type SampleReader } from "@/workers/remux/audioTranscode"
import { estimateFrameStreamDuration, ID3V2_HEADER_BYTES, id3v2Bytes } from "@/workers/remux/audioDuration.logic"
import { ac3Layout, dtsLayout, type Speaker } from "@/workers/remux/channelLayout.logic"
import { isTranscodableAudio } from "@/workers/remux/codecs.logic"
import { decodedSamples, ffmpegDecoders, type DecoderLease, type FfmpegCodec } from "@/workers/remux/ffmpegDecoder"
import {
	MAX_UNIT_BYTES,
	measureRawStream,
	nextRawUnit,
	rawSegment,
	rawTimeline,
	rawTimelineOffset,
	rawUnitAt,
	rawUnitIndex,
	rawUnitLength,
	walkRawUnits,
	type RawStreamInfo,
	type RawTimeline
} from "@/workers/remux/rawAudio.logic"

// An audio file opened for decoding, whatever holds it: a container mediabunny reads (its default
// decodable audio track), a codec only FFmpeg decodes inside one (TrueHD, ALAC), or a bare AC-3, E-AC-3 or
// DTS stream. What the WAV stream (pcmStream.ts) decodes from.

// The head searched for a bare stream's first frames.
const RAW_HEAD_BYTES = 262_144
const DURATION_ESTIMATE_BYTES = 262_144
const MAX_ID3_TAGS = 4

// TrueHD's access units are a few dozen samples each: about this many bytes of them go to the decoder worker
// at once, each with its own timestamp, so the round trips overlap instead of running one by one.
const TRUEHD_BATCH_BYTES = 16_384

// Nothing in the file can be decoded: no audio track, a codec without a decoder, or no known duration.
export class AudioUnsupportedError extends Error {
	public constructor(reason: string) {
		super(reason)
		this.name = AUDIO_UNSUPPORTED_ERROR
	}
}

export interface AudioInputInfo {
	codec: string
	sampleRate: number
	channels: number
	duration: number
	// The speakers an AC-3/E-AC-3/DTS stream's frames name, for the downmix.
	header: Speaker[] | null
}

export interface AudioInput {
	readonly info: AudioInputInfo
	readonly cache: BlockCache
	// A fresh decode of the track, for one cursor.
	reader(stats: RemuxStats, isCancelled: () => boolean): SampleReader
	close(): Promise<void>
}

// The packets a decoder is fed, in order from a start time.
export interface PacketCursor<P> {
	first(time: number): Promise<P | null>
	next(previous: P): Promise<P | null>
	data(packet: P): Uint8Array
	timestamp(packet: P): number
}

// Samples per ALAC frame a cookie may declare: encoders write 4096, and FFmpeg sizes its buffers by it.
const MAX_ALAC_FRAME_LENGTH = 65_536
const MAX_ALAC_CHANNELS = 8

// ALAC's magic cookie in the 36-byte atom form FFmpeg reads: Matroska stores the 24-byte config alone, MP4
// the full box's payload (version and flags first). Null for a cookie declaring a frame length or channel count
// no encoder writes.
export function alacExtradata(config: Uint8Array): Uint8Array | null {
	const payload = config.length === 24 ? config : config.length === 28 ? config.subarray(4) : null

	if (payload === null) {
		return null
	}

	const frameLength = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0)
	const channels = payload[9] ?? 0

	if (frameLength === 0 || frameLength > MAX_ALAC_FRAME_LENGTH || channels === 0 || channels > MAX_ALAC_CHANNELS) {
		return null
	}

	const out = new Uint8Array(36)

	new DataView(out.buffer).setUint32(0, 36)
	out.set([0x61, 0x6c, 0x61, 0x63], 4)
	out.set(payload, 12)

	return out
}

// Decoded samples of `packets` through the FFmpeg decoders worker.
export function ffmpegSampleReader<P>(params: {
	codec: FfmpegCodec
	extradata?: Uint8Array
	packets: PacketCursor<P>
	stats: RemuxStats
}): SampleReader {
	const { codec, packets, stats } = params
	let lease: DecoderLease | null = null
	let opening: Promise<DecoderLease> | null = null
	let last: P | null = null
	let done = false
	// Set by close(), which a pull still waiting on a read or a decode outlives: nothing is opened or queued
	// after it, or the decoder opened then would never be released.
	let closed = false
	let nextTimestamp = 0
	const ready: SampleItem[] = []
	// A method rather than a variable read: it changes across awaits.
	const isClosed = (): boolean => closed

	const open = (): Promise<DecoderLease> => {
		opening ??= ffmpegDecoders.open(codec, params.extradata).then(opened => {
			lease = opened

			return opened
		})

		return opening
	}

	// The worker answers in order, so the frames are queued in decode order.
	const decode = async (batch: readonly { data: Uint8Array; timestamp: number }[]): Promise<void> => {
		if (isClosed()) {
			return
		}

		const held = await open()

		if (isClosed()) {
			return
		}

		const responses = await Promise.all(
			batch.map(({ data, timestamp }) => {
				const buffer = data.slice().buffer

				return ffmpegDecoders.request(
					held,
					{ type: "decode", handle: held.handle, data: buffer, timestampUs: Math.round(timestamp * 1_000_000) },
					[buffer]
				)
			})
		)

		for (const response of responses) {
			queue(response.frames ?? [])
		}
	}

	const queue = (frames: Parameters<typeof decodedSamples>[0]): void => {
		if (isClosed()) {
			return
		}

		const decoded = decodedSamples(frames, nextTimestamp)

		nextTimestamp = decoded.next

		for (const sample of decoded.samples) {
			ready.push({ timestamp: sample.timestamp, duration: sample.duration, type: "key", sample })
		}
	}

	// Feeds packets until something is decoded or the track ends.
	const pull = async (start: number | null): Promise<SampleItem | null> => {
		const begun = performance.now()

		try {
			while (ready.length === 0 && !done && !isClosed()) {
				const batch: { data: Uint8Array; timestamp: number }[] = []
				let bytes = 0

				do {
					const packet =
						start !== null && last === null ? await packets.first(start) : last === null ? null : await packets.next(last)

					if (isClosed()) {
						return null
					}

					if (packet === null) {
						done = true
						break
					}

					last = packet

					const data = packets.data(packet)

					batch.push({ data, timestamp: packets.timestamp(packet) })
					bytes += data.length
				} while (codec === "truehd" && bytes < TRUEHD_BATCH_BYTES)

				if (batch.length > 0) {
					await decode(batch)
				}

				if (done && lease !== null && !isClosed()) {
					const held: DecoderLease = lease
					const response = await ffmpegDecoders.request(held, { type: "flush", handle: held.handle })

					queue(response.frames ?? [])
				}
			}

			return isClosed() ? null : (ready.shift() ?? null)
		} catch (error) {
			// The decoder went with close(): the pull ends as the track would.
			if (isClosed()) {
				return null
			}

			throw error
		} finally {
			stats.decodeWaitSeconds += (performance.now() - begun) / 1000
		}
	}

	return {
		first: time => pull(time),
		next: () => pull(null),
		close: async () => {
			closed = true

			for (const item of ready.splice(0)) {
				item.sample.close()
			}

			if (opening !== null) {
				const pending = opening

				opening = null
				ffmpegDecoders.release(await pending.catch(() => null))
				lease = null
			}
		}
	}
}

export function containerPackets(track: InputAudioTrack): PacketCursor<EncodedPacket> {
	const sink = new EncodedPacketSink(track)

	return {
		first: async time => (await sink.getPacket(time)) ?? (await sink.getFirstPacket()),
		next: previous => sink.getNextPacket(previous),
		data: packet => packet.data,
		timestamp: packet => packet.timestamp
	}
}

interface RawPacket {
	data: Uint8Array
	offset: number
	index: number
}

// A bare stream's access units, each walked frame by frame to where the next starts (sizes vary: padded AC-3
// frames at 44.1 kHz, DTS-HD extensions). A start that lands inside a unit (a seek, by the average size)
// resyncs to the next confirmed unit, and its index follows from where that lies.
export function rawPackets(cache: BlockCache, info: RawStreamInfo): PacketCursor<RawPacket> {
	const unitSeconds = info.unitSamples / info.sampleRate
	const size = cache.size

	const read = async (offset: number, bytes: number): Promise<{ window: Uint8Array; atEnd: boolean }> => {
		const end = Math.min(size, offset + bytes)

		return { window: await cache.read(offset, end), atEnd: end === size }
	}

	const unitAt = async (offset: number, index: number, exact: boolean): Promise<RawPacket | null> => {
		if (offset + 16 > size) {
			return null
		}

		// Most units fit the first window; a long one, or a resync, gets the widest.
		let { window, atEnd } = await read(offset, Math.ceil(info.unitBytes * 2) + 4096)
		let at = 0
		let length = rawUnitLength(window, 0, info.codec, atEnd)

		if (length === null && !atEnd) {
			;({ window, atEnd } = await read(offset, 2 * MAX_UNIT_BYTES))
			length = rawUnitLength(window, 0, info.codec, atEnd)
		}

		if (length === null) {
			at = nextRawUnit(window, 1, info.codec, atEnd)

			if (at === -1) {
				return null
			}

			length = rawUnitLength(window, at, info.codec, atEnd)
		}

		if (length === null) {
			return null
		}

		const start = offset + at

		return { data: window.subarray(at, at + length), offset: start, index: exact && at === 0 ? index : rawUnitIndex(info, start) }
	}

	if (info.timeline !== null) {
		return segmentedPackets(info, info.timeline, unitAt)
	}

	return {
		first: time => {
			const unit = rawUnitAt(info, time)

			return unitAt(unit.offset, unit.index, false)
		},
		next: previous => unitAt(previous.offset + previous.data.length, previous.index + 1, true),
		data: packet => packet.data,
		timestamp: packet => packet.index * unitSeconds
	}
}

// A variable-bitrate stream's units by the timeline's segments (rawTimeline): unit `index` is always the same
// bytes, whether a seek reached it or playback walked into it. The units a segment's start resyncs to are found
// from the offset its first time maps to; within a segment they follow in order; past its end, or the end of
// the file, the next segment starts afresh.
function segmentedPackets(
	info: RawStreamInfo,
	timeline: RawTimeline,
	unitAt: (offset: number, index: number, exact: boolean) => Promise<RawPacket | null>
): PacketCursor<RawPacket> {
	const tailOffset = timeline.knots[timeline.knots.length - 1]?.offset ?? info.start

	const segmentStart = async (index: number): Promise<RawPacket | null> => {
		for (let start = rawSegment(timeline, index).start; start < timeline.units;) {
			const segment = rawSegment(timeline, start)
			const unit = await unitAt(
				segment.tail ? tailOffset : rawTimelineOffset(timeline, start * timeline.unitSeconds),
				start,
				segment.tail
			)

			if (unit !== null) {
				return { ...unit, index: start }
			}

			start = segment.end
		}

		return null
	}

	const next = async (previous: RawPacket): Promise<RawPacket | null> => {
		const index = previous.index + 1

		if (index >= timeline.units) {
			return null
		}

		if (index >= rawSegment(timeline, previous.index).end) {
			return await segmentStart(index)
		}

		const unit = await unitAt(previous.offset + previous.data.length, index, true)

		return unit === null ? await segmentStart(rawSegment(timeline, index).end) : { ...unit, index }
	}

	return {
		// From the segment's start, walked (without decoding) to the unit covering `time`.
		first: async time => {
			const target = Math.max(0, Math.min(timeline.units - 1, Math.floor(time / timeline.unitSeconds)))
			let unit = await segmentStart(target)

			while (unit !== null && unit.index < target) {
				unit = await next(unit)
			}

			return unit
		},
		next,
		data: packet => packet.data,
		timestamp: packet => packet.index * timeline.unitSeconds
	}
}

// The speakers a track's first frame names, for AC-3, E-AC-3 and DTS.
async function headerSpeakers(track: InputAudioTrack, codec: string | null): Promise<Speaker[] | null> {
	const parse = codec === "ac3" || codec === "eac3" ? ac3Layout : codec === "dts" ? dtsLayout : null

	if (parse === null) {
		return null
	}

	try {
		const packet = await new EncodedPacketSink(track).getFirstPacket()

		return packet === null ? null : parse(packet.data)
	} catch {
		return null
	}
}

function startsWithRawSync(head: Uint8Array): boolean {
	return (head[0] === 0x0b && head[1] === 0x77) || (head[0] === 0x7f && head[1] === 0xfe && head[2] === 0x80 && head[3] === 0x01)
}

// A bare AC-3, E-AC-3 or DTS stream with the speakers its first frame names. The same decision for both
// readers of a file: a head that starts with a sync word is measured first; otherwise only a file no
// container format recognises is (one with junk or tags before its first frame). Null for a container.
export async function rawStreamOf(cache: BlockCache, input: Input): Promise<{ info: RawStreamInfo; header: Speaker[] | null } | null> {
	const head = await cache.read(0, Math.min(cache.size, RAW_HEAD_BYTES))

	if (
		!startsWithRawSync(head) &&
		(await input.getFormat().then(
			() => true,
			() => false
		))
	) {
		return null
	}

	const measured = measureRawStream(head, cache.size)

	if (measured === null) {
		return null
	}

	const timeline = measured.variable ? await sampledTimeline(cache, measured) : null
	const info: RawStreamInfo =
		timeline === null ? measured : { ...measured, timeline, units: timeline.units, duration: timeline.units * timeline.unitSeconds }
	const first = head.subarray(info.start)

	return { info, header: info.codec === "dts" ? dtsLayout(first) : ac3Layout(first) }
}

// Where the timeline of a variable-bitrate stream is sampled, besides its head: a few windows inside, and its
// tail, whose units are counted to the end. A handful of bounded reads at open.
const SAMPLED_FRACTIONS = [0.25, 0.5, 0.75]
const SAMPLE_WINDOW_BYTES = 262_144
const TAIL_WINDOW_BYTES = 524_288
const SAMPLE_UNITS = 64

async function sampledTimeline(cache: BlockCache, info: RawStreamInfo): Promise<RawTimeline | null> {
	const size = cache.size
	const samples = [{ offset: info.start, unitBytes: info.unitBytes }]

	for (const fraction of SAMPLED_FRACTIONS) {
		const from = Math.floor(info.start + (size - info.start) * fraction)
		const end = Math.min(size, from + SAMPLE_WINDOW_BYTES)
		const walked = walkRawUnits(await cache.read(from, end), 0, info.codec, end === size, SAMPLE_UNITS)
		const last = samples[samples.length - 1]

		if (walked !== null && last !== undefined && from + walked.first > last.offset) {
			samples.push({ offset: from + walked.first, unitBytes: walked.bytes / walked.units })
		}
	}

	const tailFrom = Math.max(info.start, size - TAIL_WINDOW_BYTES)
	const tail = walkRawUnits(await cache.read(tailFrom, size), 0, info.codec, true, Number.POSITIVE_INFINITY)

	if (tail === null) {
		return null
	}

	return rawTimeline({
		start: info.start,
		unitSeconds: info.unitSamples / info.sampleRate,
		samples,
		tail: { offset: tailFrom + tail.first, units: tail.units, bytes: tail.bytes }
	})
}

function openRaw(source: BlockInput, raw: { info: RawStreamInfo; header: Speaker[] | null }): AudioInput {
	const { cache } = source
	const { info } = raw

	return {
		info: { codec: info.codec, sampleRate: info.sampleRate, channels: info.channels, duration: info.duration, header: raw.header },
		cache,
		reader: stats => ffmpegSampleReader({ codec: info.codec, packets: rawPackets(cache, info), stats }),
		close: () => {
			source.close()

			return Promise.resolve()
		}
	}
}

// A track mediabunny cannot name but our own container walk can (TrueHD, ALAC), with ALAC's cookie.
export async function probedCodecs(cache: BlockCache): Promise<Map<number, { codec: FfmpegCodec; extradata?: Uint8Array }>> {
	const found = new Map<number, { codec: FfmpegCodec; extradata?: Uint8Array }>()

	try {
		const source = new BlockSource(cache.size, (start, end) => Promise.resolve(cache.read(start, end)), { maxBlockReads: 4 })
		const parsed = await walkContainer(source, "card")

		for (const track of parsed?.tracks ?? []) {
			if (track.kind !== "audio") {
				continue
			}

			if (track.audio.codec === "truehd") {
				found.set(track.audio.id, { codec: "truehd" })
			} else if (track.audio.codec === "alac") {
				const extradata = track.config === undefined || track.config === null ? null : alacExtradata(track.config)

				if (extradata !== null) {
					found.set(track.audio.id, { codec: "alac", extradata })
				}
			}
		}
	} catch {
		// Nothing more is known about the tracks.
	}

	return found
}

// An MP3 or ADTS stream's duration, which no header gives: its size over the byte rate of its first frames,
// behind any ID3v2 tags. Null for other formats and when the frames tell nothing. The demuxer has just read
// the head, so these reads come from the block cache.
export async function estimatedStreamDuration(cache: BlockCache, format: InputFormat): Promise<number | null> {
	const stream = format === MP3 ? "mp3" : format === ADTS ? "adts" : null

	if (stream === null) {
		return null
	}

	try {
		return await estimate(cache, stream)
	} catch {
		return null
	}
}

async function estimate(cache: BlockCache, stream: "mp3" | "adts"): Promise<number | null> {
	let start = 0

	for (let i = 0; i < MAX_ID3_TAGS && start + ID3V2_HEADER_BYTES <= cache.size; i++) {
		const tag = id3v2Bytes(await cache.read(start, start + ID3V2_HEADER_BYTES))

		if (tag === 0) {
			break
		}

		start += tag
	}

	if (start >= cache.size) {
		return null
	}

	const bytes = await cache.read(start, Math.min(cache.size, start + DURATION_ESTIMATE_BYTES))

	return estimateFrameStreamDuration({ stream, bytes, size: cache.size - start })
}

async function openContainer(source: BlockInput): Promise<AudioInput | null> {
	const { cache, input } = source

	const format = await input.getFormat().catch(() => null)

	if (format === null) {
		return null
	}

	const tracks = await input.getAudioTracks()
	const dispositions = await Promise.all(tracks.map(track => track.getDisposition()))
	const ordered = [
		...tracks.filter((_, i) => dispositions[i]?.default === true),
		...tracks.filter((_, i) => dispositions[i]?.default !== true)
	]
	let probed: Awaited<ReturnType<typeof probedCodecs>> | null = null
	let chosen: { track: InputAudioTrack; codec: string; ffmpeg: { codec: FfmpegCodec; extradata?: Uint8Array } | null } | null = null

	for (const track of ordered) {
		const codec = await track.getCodec()

		if (isTranscodableAudio(codec)) {
			chosen = { track, codec, ffmpeg: null }
			break
		}

		// Not a codec mediabunny knows: perhaps one only FFmpeg decodes.
		probed ??= await probedCodecs(cache)

		const known = probed.get(track.id)

		if (known !== undefined) {
			chosen = { track, codec: known.codec, ffmpeg: known }
			break
		}
	}

	if (chosen === null) {
		throw new AudioUnsupportedError(tracks.length === 0 ? "no audio track" : "no decoder for the audio codec")
	}

	const { track, ffmpeg } = chosen
	const duration =
		(await input.getDurationFromMetadata()) ??
		(format === MATROSKA || format === WEBM || format === FLAC ? null : await estimatedOrComputed(cache, input, format))

	if (duration === null || !(duration > 0)) {
		throw new AudioUnsupportedError("unknown duration")
	}

	const [sampleRate, channels, header] = await Promise.all([
		track.getSampleRate(),
		track.getNumberOfChannels(),
		headerSpeakers(track, chosen.codec)
	])

	return {
		info: { codec: chosen.codec, sampleRate, channels, duration, header },
		cache,
		reader: (stats, isCancelled) =>
			ffmpeg === null
				? sampleReader(track, stats, isCancelled)
				: ffmpegSampleReader({
						codec: ffmpeg.codec,
						...(ffmpeg.extradata === undefined ? {} : { extradata: ffmpeg.extradata }),
						packets: containerPackets(track),
						stats
					}),
		close: () => {
			source.close()

			return Promise.resolve()
		}
	}
}

async function estimatedOrComputed(cache: BlockCache, input: Input, format: InputFormat): Promise<number | null> {
	return format === MP3 || format === ADTS ? await estimatedStreamDuration(cache, format) : await input.computeDuration()
}

// Opens the file a range port serves. Throws AudioUnsupportedError when nothing in it can be decoded.
export async function openAudioInput(port: MessagePort, size: number): Promise<AudioInput> {
	// Audio is read in order and at a low bitrate.
	const source = openBlockInput(port, size, "audio")

	try {
		const raw = await rawStreamOf(source.cache, source.input)
		const opened = raw === null ? await openContainer(source) : openRaw(source, raw)

		if (raw !== null) {
			// A bare stream is read through the cache alone.
			source.input.dispose()
		}

		if (opened === null) {
			throw new AudioUnsupportedError("not an audio file this browser can decode")
		}

		return opened
	} catch (error) {
		source.close()

		throw error
	}
}
