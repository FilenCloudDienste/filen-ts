import { InputFormat, type AudioCodec, type Demuxer, type Input, type VideoCodec } from "mediabunny"
import {
	flvAudioTag,
	flvVideoTag,
	mpegAudioHeader,
	parseAvcSps,
	readFlvMetaData,
	type FlvMetaData,
	type MediaCodec
} from "@filen/shared/videos"
import { PacketDemuxer, readAt, type ContainerReader, type DemuxPacket, type DemuxTrack } from "@/lib/media/demux/packetDemuxer"

// FLV: tags of audio, video and script data, each with its millisecond timestamp. H.264 (legacy and Enhanced RTMP),
// HEVC, AV1 and VP9 pictures; AAC and MP3 sound. Seeks go through onMetaData's keyframe list when the file has one,
// else through the shared interpolation over the file.

const TAG_HEADER_BYTES = 11
// The head read for the stream headers: onMetaData and the first tags of each stream.
const HEAD_BYTES = 1024 * 1024
// One read of tags.
const WINDOW_BYTES = 256 * 1024
// How far a resync looks for the next tag.
const RESYNC_BYTES = 1024 * 1024
const RESYNC_STEP_BYTES = 64 * 1024

const VIDEO_TRACK = 1
const AUDIO_TRACK = 2

const VIDEO_CODECS: Partial<Record<MediaCodec, VideoCodec>> = { h264: "avc", hevc: "hevc", av1: "av1", vp9: "vp9" }
const AUDIO_CODECS: Partial<Record<MediaCodec, AudioCodec>> = { aac: "aac", mp3: "mp3" }
// Enhanced RTMP video packet types.
const SEQUENCE_START = 0
const CODED_FRAMES = 1
const CODED_FRAMES_X = 3

function uint24(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0)
}

function uint32(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) * 0x1000000 + uint24(bytes, at + 1)
}

// A tag's signed 24-bit composition time offset.
function int24(bytes: Uint8Array, at: number): number {
	const value = uint24(bytes, at)

	return value >= 0x800000 ? value - 0x1000000 : value
}

// A tag's timestamp in milliseconds: 24 bits and an extension byte above them.
function timestamp(bytes: Uint8Array, at: number): number {
	return uint24(bytes, at + 4) + (bytes[at + 7] ?? 0) * 0x1000000
}

// The tag at `at` in `bytes` lines up: a known type, stream id 0, and (where it lies within `bytes`) a following
// PreviousTagSize that names it.
function plausibleTag(bytes: Uint8Array, at: number): boolean {
	const type = bytes[at] ?? 0
	const size = uint24(bytes, at + 1)
	const end = at + TAG_HEADER_BYTES + size

	if ((type !== 8 && type !== 9 && type !== 18) || uint24(bytes, at + 8) !== 0) {
		return false
	}

	return end + 4 > bytes.length || uint32(bytes, end) === TAG_HEADER_BYTES + size
}

interface Head {
	meta: FlvMetaData | null
	video: Uint8Array | null
	audio: Uint8Array | null
	// The first two video timestamps, for a frame duration onMetaData does not state.
	videoTimes: number[]
}

// Tags looked at for onMetaData before the head read stops waiting for it.
const META_TAGS = 16

function readHead(bytes: Uint8Array, dataStart: number, wantVideo: boolean, wantAudio: boolean): Head {
	const head: Head = { meta: null, video: null, audio: null, videoTimes: [] }

	for (let at = dataStart, tags = 0; at + TAG_HEADER_BYTES <= bytes.length; tags++) {
		const type = (bytes[at] ?? 0) & 0x1f
		const end = at + TAG_HEADER_BYTES + uint24(bytes, at + 1)

		if (end > bytes.length) {
			break
		}

		const data = bytes.subarray(at + TAG_HEADER_BYTES, end)

		if (type === 18) {
			head.meta ??= readFlvMetaData(data)
		} else if (type === 9 && data.length > 0) {
			// The sequence header names the codec; any tag stands in until one is seen.
			if (head.video === null || (isVideoSequenceHeader(data) && !isVideoSequenceHeader(head.video))) {
				head.video = data
			}

			if (head.videoTimes.length < 2) {
				head.videoTimes.push(timestamp(bytes, at))
			}
		} else if (type === 8 && data.length > 0 && (head.audio === null || isAacSequenceHeader(data))) {
			head.audio = data
		}

		at = end + 4

		const videoKnown = !wantVideo || (head.video !== null && isVideoSequenceHeader(head.video) && head.videoTimes.length >= 2)
		const audioKnown = !wantAudio || (head.audio !== null && ((head.audio[0] ?? 0) >> 4 !== 10 || isAacSequenceHeader(head.audio)))

		if (videoKnown && audioKnown && (head.meta !== null || tags >= META_TAGS)) {
			break
		}
	}

	return head
}

function isAacSequenceHeader(data: Uint8Array): boolean {
	return (data[0] ?? 0) >> 4 === 10 && data[1] === 0
}

function isVideoSequenceHeader(data: Uint8Array): boolean {
	const flags = data[0] ?? 0

	return (flags & 0x80) !== 0 ? (flags & 0x0f) === SEQUENCE_START : data[1] === 0
}

function videoTrack(data: Uint8Array, meta: FlvMetaData | null): DemuxTrack {
	const probed = flvVideoTag(data, meta?.width ?? 0, meta?.height ?? 0)
	const codec = probed.codec === null ? null : (VIDEO_CODECS[probed.codec] ?? null)
	const config = isVideoSequenceHeader(data) ? data.subarray(5) : null
	// The picture's size from the avcC's first SPS, where the header does not state it.
	const sps =
		codec === "avc" && config !== null && config.length > 8
			? parseAvcSps(config.subarray(8, 8 + ((config[6] ?? 0) << 8) + (config[7] ?? 0)))
			: null
	const width = sps?.width ?? probed.w
	const height = sps?.height ?? probed.h
	const par = sps?.par ?? 1

	return {
		type: "video",
		number: VIDEO_TRACK,
		name: null,
		language: "und",
		isDefault: true,
		internalCodecId: probed.fourcc,
		codec,
		width,
		height,
		squarePixelWidth: par > 1 ? Math.round(width * par) : width,
		squarePixelHeight: par < 1 ? Math.round(height / par) : height,
		decoderConfig:
			codec === null || probed.codecString === null || config === null
				? null
				: { codec: probed.codecString, description: config, codedWidth: width, codedHeight: height }
	}
}

function audioTrack(data: Uint8Array): DemuxTrack {
	const probed = flvAudioTag(data)
	const codec = probed.codec === null ? null : (AUDIO_CODECS[probed.codec] ?? null)
	const channels = probed.ch ?? 2
	const sampleRate = probed.rate ?? 44100
	const description = codec === "aac" && data[1] === 0 ? data.subarray(2) : null

	return {
		type: "audio",
		number: AUDIO_TRACK,
		name: null,
		language: "und",
		isDefault: true,
		internalCodecId: (data[0] ?? 0) >> 4,
		codec,
		channels,
		sampleRate,
		decoderConfig:
			codec === null || probed.codecString === null
				? null
				: {
						codec: codec === "mp3" ? "mp3" : probed.codecString,
						numberOfChannels: channels,
						sampleRate,
						...(description === null ? {} : { description })
					}
	}
}

// The packet a tag holds, or null for a header, a script tag or a stream this does not play.
function tagPacket(bytes: Uint8Array, at: number, unit: number, tracks: Map<number, DemuxTrack>, frameSeconds: number): DemuxPacket | null {
	const type = (bytes[at] ?? 0) & 0x1f
	const size = uint24(bytes, at + 1)
	const dataAt = at + TAG_HEADER_BYTES
	const flags = bytes[dataAt] ?? 0
	const dts = timestamp(bytes, at)

	if (type === 8) {
		const track = tracks.get(AUDIO_TRACK)

		if (track?.type !== "audio" || track.codec === null) {
			return null
		}

		// AAC: packet type 1 is a raw frame (0 is the sequence header).
		const skip = track.codec === "aac" ? 2 : 1

		if (track.codec === "aac" && bytes[dataAt + 1] !== 1) {
			return null
		}

		const header = track.codec === "mp3" ? mpegAudioHeader(bytes, dataAt + 1) : null
		const samples = track.codec === "aac" ? 1024 : (header?.samples ?? 1152)

		return {
			track: AUDIO_TRACK,
			pts: dts / 1000,
			duration: samples / (header?.rate ?? track.sampleRate),
			key: true,
			unit,
			part: 0,
			pos: unit + TAG_HEADER_BYTES + skip,
			size: size - skip
		}
	}

	if (type !== 9 || !tracks.has(VIDEO_TRACK)) {
		return null
	}

	const enhanced = (flags & 0x80) !== 0
	const key = ((flags >> 4) & 0x07) === 1
	let skip: number
	let composition: number

	if (enhanced) {
		const packetType = flags & 0x0f
		const fourcc = String.fromCharCode(bytes[dataAt + 1] ?? 0, bytes[dataAt + 2] ?? 0, bytes[dataAt + 3] ?? 0, bytes[dataAt + 4] ?? 0)
		const timed = packetType === CODED_FRAMES && (fourcc === "avc1" || fourcc === "hvc1")

		if (packetType !== CODED_FRAMES && packetType !== CODED_FRAMES_X) {
			return null
		}

		composition = timed ? int24(bytes, dataAt + 5) : 0
		skip = timed ? 8 : 5
	} else {
		// Legacy AVC/HEVC: packet type 1 carries NAL units after the composition time.
		if (bytes[dataAt + 1] !== 1) {
			return null
		}

		composition = int24(bytes, dataAt + 2)
		skip = 5
	}

	return {
		track: VIDEO_TRACK,
		pts: (dts + composition) / 1000,
		duration: frameSeconds,
		key,
		unit,
		part: 0,
		pos: unit + TAG_HEADER_BYTES + skip,
		size: size - skip
	}
}

async function openFlv(input: Input): Promise<ContainerReader> {
	const size = input._reader.fileSize ?? 0
	const header = (await readAt(input, 0, 9)) ?? new Uint8Array(9)
	const dataOffset = uint32(header, 5)
	// A DataOffset past the head the probe reads is no FLV this plays: no tag is read.
	const dataStart = dataOffset <= HEAD_BYTES ? dataOffset + 4 : size
	const flags = header[4] ?? 0
	const headBytes =
		dataStart >= size ? new Uint8Array() : ((await readAt(input, 0, Math.min(size, dataStart + HEAD_BYTES))) ?? new Uint8Array())
	const head = readHead(headBytes, dataStart, (flags & 0x01) !== 0, (flags & 0x04) !== 0)
	const tracks = new Map<number, DemuxTrack>()

	if (head.video !== null) {
		tracks.set(VIDEO_TRACK, videoTrack(head.video, head.meta))
	}

	if (head.audio !== null) {
		tracks.set(AUDIO_TRACK, audioTrack(head.audio))
	}

	const [first, second] = head.videoTimes
	const frameSeconds =
		head.meta?.frameRate !== null && head.meta?.frameRate !== undefined
			? 1 / head.meta.frameRate
			: first !== undefined && second !== undefined && second > first
				? (second - first) / 1000
				: 1 / 30
	const keyframes = head.meta?.keyframes ?? null

	const reader: ContainerReader = {
		tracks: [...tracks.values()],
		duration: head.meta?.duration ?? (await lastTagTime(input, size)),
		dataStart,
		readPackets: async pos => {
			if (pos + TAG_HEADER_BYTES > size) {
				return null
			}

			const bytes = (await readAt(input, pos, Math.min(WINDOW_BYTES, size - pos))) ?? new Uint8Array()
			const packets: DemuxPacket[] = []
			let at = 0

			while (at + TAG_HEADER_BYTES <= bytes.length) {
				const end = at + TAG_HEADER_BYTES + uint24(bytes, at + 1) + 4

				// A tag longer than the window: its header and first bytes are enough to place it.
				if (end > bytes.length && at > 0) {
					break
				}

				const packet = tagPacket(bytes, at, pos + at, tracks, frameSeconds)

				if (packet !== null && packet.size >= 0 && packet.pos + packet.size <= size) {
					packets.push(packet)
				}

				at = end
			}

			return at === 0 ? null : { packets, next: pos + at }
		},
		resync: pos => resyncTag(input, size, pos),
		indexedPosition: async t => {
			if (keyframes === null) {
				return null
			}

			let index = -1

			for (let i = 0; i < keyframes.times.length && (keyframes.times[i] ?? Infinity) <= t; i++) {
				index = i
			}

			const position = keyframes.positions[index]

			return position === undefined ? dataStart : resyncTag(input, size, position)
		}
	}

	return reader
}

// The first tag at or after `pos`.
async function resyncTag(input: Input, size: number, pos: number): Promise<number | null> {
	for (let start = Math.max(0, pos); start < Math.min(size, pos + RESYNC_BYTES); start += RESYNC_STEP_BYTES) {
		const bytes = await readAt(input, start, Math.min(RESYNC_STEP_BYTES + 64, size - start))

		if (bytes === null) {
			return null
		}

		for (let at = 0; at + TAG_HEADER_BYTES <= Math.min(bytes.length, RESYNC_STEP_BYTES); at++) {
			if (plausibleTag(bytes, at)) {
				return start + at
			}
		}
	}

	return null
}

// The last tag's timestamp in seconds, from the PreviousTagSize that ends the file.
async function lastTagTime(input: Input, size: number): Promise<number | null> {
	const tail = await readAt(input, size - 4, 4)
	const previous = tail === null ? 0 : uint32(tail, 0)
	const header = previous < TAG_HEADER_BYTES ? null : await readAt(input, size - 4 - previous, TAG_HEADER_BYTES)

	return header === null ? null : timestamp(header, 0) / 1000
}

class FlvInputFormat extends InputFormat {
	public readonly name = "FLV"
	public readonly mimeType = "video/x-flv"
	public readonly supportsTimestampedMediaData = true

	public override async _getMatchPosition(input: Input): Promise<number | null> {
		const head = await readAt(input, 0, 9)

		return head !== null && head[0] === 0x46 && head[1] === 0x4c && head[2] === 0x56 && head[3] === 1 ? 0 : null
	}

	public override _createDemuxer(input: Input): Demuxer {
		return new PacketDemuxer(input, "video/x-flv", openFlv)
	}
}

export const FLV = new FlvInputFormat()
