import {
	avcCodecString,
	hevcCodecString,
	mp4aCodecString,
	parseAudioSpecificConfig,
	parseAvcC,
	simpleAudioCodecString
} from "./codecString"
import { BLOCK_BYTES, type BlockSource } from "./blockSource"
import { ascii, readBytes, seconds, uint16, uint32 } from "./probeBytes"
import type { MediaCodec, ParsedContainer, ProbeAudio, ProbeVideo } from "./probeTypes"

// FLV (FLV\x01): the onMetaData script tag's duration, size and keyframe index, and the first audio and video tags'
// codec configuration (legacy and Enhanced RTMP), all from the head; the last tag's timestamp when onMetaData has no
// duration.

const HEAD_BYTES = BLOCK_BYTES
const TAG_HEADER_BYTES = 11
const AMF_MAX_DEPTH = 4
// A two-hour file indexed every second lists 7200 keyframes.
const AMF_MAX_ENTRIES = 131_072

// AMF0 values. Objects are Maps, so no key a file names can reach a prototype.
type AmfValue = number | boolean | string | null | AmfObject | AmfValue[]

type AmfObject = Map<string, AmfValue>

class AmfReader {
	public at: number
	private readonly bytes: Uint8Array
	private readonly end: number

	public constructor(bytes: Uint8Array, at: number, end: number) {
		this.bytes = bytes
		this.at = at
		this.end = end
	}

	private string(long: boolean): string {
		const length = long ? uint32(this.bytes, this.at) : uint16(this.bytes, this.at)
		const start = this.at + (long ? 4 : 2)

		this.at = start + length

		return ascii(this.bytes, start, Math.min(start + length, this.end, start + 256))
	}

	private properties(depth: number): AmfObject {
		const object: AmfObject = new Map()

		for (let count = 0; this.at + 3 <= this.end && count < AMF_MAX_ENTRIES; count++) {
			const key = this.string(false)

			if (key === "" && this.bytes[this.at] === 0x09) {
				this.at++

				break
			}

			object.set(key, this.value(depth + 1))
		}

		return object
	}

	public value(depth = 0): AmfValue {
		if (this.at >= this.end || depth > AMF_MAX_DEPTH) {
			this.at = this.end

			return null
		}

		const type = this.bytes[this.at++] ?? 5

		switch (type) {
			case 0x00: {
				if (this.at + 8 > this.end) {
					this.at = this.end

					return null
				}

				const value = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength).getFloat64(this.at)

				this.at += 8

				return value
			}
			case 0x01:
				return this.bytes[this.at++] !== 0
			case 0x02:
				return this.string(false)
			case 0x0c:
				return this.string(true)
			case 0x03:
				return this.properties(depth)
			case 0x08:
				this.at += 4

				return this.properties(depth)
			case 0x0a: {
				const count = uint32(this.bytes, this.at)
				const values: AmfValue[] = []

				this.at += 4

				for (let i = 0; i < count && this.at < this.end && i < AMF_MAX_ENTRIES; i++) {
					values.push(this.value(depth + 1))
				}

				return values
			}
			case 0x0b:
				this.at += 10

				return null
			case 0x05:
			case 0x06:
				return null
			default:
				// A type this does not read: nothing after it can be located.
				this.at = this.end

				return null
		}
	}
}

function numberOf(value: AmfValue | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}

// Flash's own ADPCM (1) is not the WAV ADPCM the decoders here read: left unnamed, like Nellymoser.
const SOUND_FORMATS: Readonly<Record<number, MediaCodec>> = { 0: "pcm", 2: "mp3", 3: "pcm", 10: "aac", 11: "speex", 14: "mp3" }
const SOUND_RATES = [5512, 11025, 22050, 44100]
const VIDEO_CODECS: Readonly<Record<number, MediaCodec>> = { 2: "h263", 4: "vp6", 5: "vp6", 7: "h264", 12: "hevc" }
// Enhanced RTMP video FourCCs.
const EX_VIDEO: Readonly<Record<string, MediaCodec>> = { avc1: "h264", hvc1: "hevc", av01: "av1", vp09: "vp9" }

export type AudioFields = Pick<ProbeAudio, "codec" | "codecString" | "ch" | "rate">

// The codec, channels and rate an audio tag states; its AAC sequence header, when it is one, decides them.
export function flvAudioTag(data: Uint8Array): AudioFields {
	const flags = data[0] ?? 0
	const format = flags >> 4
	const codec = SOUND_FORMATS[format] ?? null
	let codecString: string | null = codec === "mp3" ? simpleAudioCodecString("mp3") : null
	let ch: number | null = (flags & 1) + 1
	let rate: number | null = format === 14 ? 8000 : (SOUND_RATES[(flags >> 2) & 0x03] ?? null)

	// AAC: the sequence header's AudioSpecificConfig decides rate and channels.
	if (codec === "aac" && data[1] === 0) {
		const config = data.subarray(2)
		const parsed = parseAudioSpecificConfig(config)

		codecString = mp4aCodecString({ objectTypeIndication: 0x40, audioSpecificConfig: parsed === null ? null : config })
		ch = parsed?.channels ?? ch
		rate = parsed?.sampleRate ?? rate
	} else if (codec === "aac") {
		codecString = mp4aCodecString({ objectTypeIndication: 0x40, audioSpecificConfig: null })
	}

	return { codec, codecString, ch, rate }
}

// The codec a video tag states, named by its sequence header (legacy AVC or Enhanced RTMP) when it is one.
export function flvVideoTag(data: Uint8Array, width: number, height: number): ProbeVideo {
	const flags = data[0] ?? 0
	const enhanced = (flags & 0x80) !== 0
	const fourcc = enhanced ? ascii(data, 1, 5) : String(flags & 0x0f)
	const codec = enhanced ? (EX_VIDEO[fourcc] ?? null) : (VIDEO_CODECS[flags & 0x0f] ?? null)
	// A sequence header: legacy AVC packet type 0 (after the 3-byte composition time), or Enhanced packet type 0.
	const config = enhanced ? ((flags & 0x0f) === 0 ? data.subarray(5) : null) : data[1] === 0 ? data.subarray(5) : null
	let codecString: string | null = null

	if (config !== null && codec === "h264") {
		codecString = avcCodecString({ fourcc: "avc1", avcC: config })
	} else if (config !== null && codec === "hevc") {
		codecString = hevcCodecString({ fourcc: "hvc1", hvcC: config })
	}

	const avc = config !== null && codec === "h264" ? parseAvcC(config) : null

	return {
		codec,
		fourcc: enhanced ? fourcc : codec === "h264" ? "avc1" : fourcc,
		codecString,
		w: width,
		h: height,
		par: 1,
		rotation: 0,
		bitDepth: avc?.bitDepth ?? null,
		transfer: "sdr"
	}
}

export interface FlvMetaData {
	duration: number | null
	width: number | null
	height: number | null
	frameRate: number | null
	// The keyframes' times (seconds) and their tags' file positions, in order; null when not listed.
	keyframes: { times: number[]; positions: number[] } | null
}

function numbers(value: AmfValue | undefined): number[] {
	return Array.isArray(value) ? value.map(entry => (typeof entry === "number" && Number.isFinite(entry) ? entry : Number.NaN)) : []
}

// A script tag's onMetaData, from the tag's data; null for any other script tag.
export function readFlvMetaData(data: Uint8Array): FlvMetaData | null {
	const reader = new AmfReader(data, 0, data.length)
	const name = reader.value()
	const meta = reader.value()

	if (name !== "onMetaData" || !(meta instanceof Map)) {
		return null
	}

	const index = meta.get("keyframes")
	const times = index instanceof Map ? numbers(index.get("times")) : []
	const positions = index instanceof Map ? numbers(index.get("filepositions")) : []
	const usable = times.length > 0 && times.length === positions.length && [...times, ...positions].every(Number.isFinite)

	return {
		duration: numberOf(meta.get("duration")),
		width: numberOf(meta.get("width")),
		height: numberOf(meta.get("height")),
		frameRate: numberOf(meta.get("framerate")),
		keyframes: usable ? { times, positions } : null
	}
}

// The duration is onMetaData's, else the last tag's timestamp. The index is "keyframes" when onMetaData lists
// them (filepositions and times), else "none".
export async function walkFlv(source: BlockSource, result: ParsedContainer): Promise<void> {
	const bytes = await readBytes(source, 0, Math.min(source.size, HEAD_BYTES))
	const flags = bytes[4] ?? 0
	let meta: FlvMetaData | null = null
	let video: ProbeVideo | null = null
	let audio: AudioFields | null = null
	let at = uint32(bytes, 5) + 4

	result.index = "none"

	const wantVideo = (flags & 0x01) !== 0
	const wantAudio = (flags & 0x04) !== 0

	while (at + TAG_HEADER_BYTES <= bytes.length && (meta === null || (wantVideo && video === null) || (wantAudio && audio === null))) {
		const type = (bytes[at] ?? 0) & 0x1f
		const size = ((bytes[at + 1] ?? 0) << 16) | uint16(bytes, at + 2)
		const start = at + TAG_HEADER_BYTES
		const end = start + size

		if (end > bytes.length) {
			break
		}

		const data = bytes.subarray(start, end)

		if (type === 18 && meta === null) {
			meta = readFlvMetaData(data)
		} else if (type === 9 && video === null && size > 0) {
			video = flvVideoTag(data, meta?.width ?? 0, meta?.height ?? 0)
		} else if (type === 8 && audio === null && size > 0) {
			audio = flvAudioTag(data)
		}

		at = end + 4
	}

	if (video !== null) {
		result.tracks.push({ kind: "video", enabled: true, video })
	}

	if (audio !== null) {
		result.tracks.push({
			kind: "audio",
			enabled: true,
			audio: { id: 1, ...audio, lang: null, name: null, def: true, forced: false, commentary: false }
		})
	}

	result.tracksFound = (!wantVideo || video !== null) && (!wantAudio || audio !== null)
	result.partial = !result.tracksFound

	result.index = meta === null || meta.keyframes === null ? "none" : "keyframes"

	const duration = meta?.duration ?? (await lastTimestamp(source))

	result.durationSec = duration === null ? null : seconds(duration)
}

// The last tag's timestamp in seconds, from the PreviousTagSize that ends the file.
async function lastTimestamp(source: BlockSource): Promise<number | null> {
	if (source.size < 13 + TAG_HEADER_BYTES) {
		return null
	}

	const previous = uint32(await readBytes(source, source.size - 4, 4), 0)
	const tag = source.size - 4 - previous

	if (previous < TAG_HEADER_BYTES || tag < 13) {
		return null
	}

	const header = await readBytes(source, tag, TAG_HEADER_BYTES)
	const millis = ((header[4] ?? 0) << 16) + uint16(header, 5) + (header[7] ?? 0) * 0x1000000

	return millis > 0 ? millis / 1000 : null
}
