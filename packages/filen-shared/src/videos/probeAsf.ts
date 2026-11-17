import { BLOCK_BYTES, type BlockSource } from "./blockSource"
import { readBytes, seconds } from "./probeBytes"
import { bitmapVideo, spsCodecString, uint16le, uint32le, waveFormatAudio } from "./probeAvi"
import type { ParsedContainer, ProbeAudio, ProbeVideo } from "./probeTypes"

// ASF (Windows Media: .wmv, .wma, .asf): the header object's file and stream properties, read from the head, and
// whether a Simple Index object follows the data object.

const HEAD_BYTES = BLOCK_BYTES
const OBJECT_HEADER_BYTES = 24
const MAX_STREAMS = 32

function guid(text: string): Uint8Array {
	return Uint8Array.from(text.match(/../g) ?? [], pair => Number.parseInt(pair, 16))
}

// GUIDs in their stored byte order.
export const ASF_HEADER = guid("3026b2758e66cf11a6d900aa0062ce6c")
const FILE_PROPERTIES = guid("a1dcab8c47a9cf118ee400c00c205365")
const STREAM_PROPERTIES = guid("9107dcb7b7a9cf118ee600c00c205365")
const HEADER_EXTENSION = guid("b503bf5f2ea9cf118ee300c00c205365")
const EXTENDED_STREAM_PROPERTIES = guid("14e68a292226174cb935dae07ee9289c")
const AUDIO_MEDIA = guid("409e69f84d5bcf11a8fd00805f5c442b")
const VIDEO_MEDIA = guid("c0ef19bc4d5bcf11a8fd00805f5c442b")
export const ASF_SIMPLE_INDEX = guid("90080033b1e5cf1189f400a0c90349cb")

export function isGuid(bytes: Uint8Array, at: number, id: Uint8Array): boolean {
	return id.every((byte, i) => bytes[at + i] === byte)
}

export function uint64le(bytes: Uint8Array, at: number): number {
	return uint32le(bytes, at) + uint32le(bytes, at + 4) * 0x100000000
}

interface AsfObject {
	at: number
	// Its data after the 24-byte header, `end` exclusive.
	start: number
	end: number
}

function objects(bytes: Uint8Array, start: number, end: number): AsfObject[] {
	const found: AsfObject[] = []

	for (let at = start; at + OBJECT_HEADER_BYTES <= end && found.length < 256;) {
		const size = uint64le(bytes, at + 16)

		if (size < OBJECT_HEADER_BYTES) {
			break
		}

		found.push({ at, start: at + OBJECT_HEADER_BYTES, end: at + size })
		at += size
	}

	return found
}

// A stream the header declares; `specific` is its type-specific data (a WAVEFORMATEX, or the picture size and a
// BITMAPINFOHEADER), for a demuxer.
export type AsfStream = { number: number; specific: Uint8Array } & (
	{ video: ProbeVideo } | { audio: Pick<ProbeAudio, "codec" | "codecString" | "ch" | "rate"> }
)

type Stream = AsfStream

// A Stream Properties object's data at `at`: its type GUID, stream number and type-specific data (WAVEFORMATEX, or the
// picture size then a BITMAPINFOHEADER).
function streamProperties(bytes: Uint8Array, at: number, end: number): Stream | null {
	const specific = at + 54
	const length = Math.min(uint32le(bytes, at + 40), end - specific)
	const number = uint16le(bytes, at + 48) & 0x7f

	if (length <= 0) {
		return null
	}

	const data = bytes.subarray(specific, specific + length)

	if (isGuid(bytes, at, AUDIO_MEDIA) && length >= 16) {
		return { number, specific: data, audio: waveFormatAudio(bytes, specific, length) }
	}

	// Encoded width (4), height (4), flags (1), format data size (2), then the BITMAPINFOHEADER.
	if (isGuid(bytes, at, VIDEO_MEDIA) && length >= 11 + 20) {
		return { number, specific: data, video: bitmapVideo(bytes, specific + 11) }
	}

	return null
}

// The Stream Properties object an Extended Stream Properties object may end with, past its names and payload
// extension systems.
function embeddedStream(bytes: Uint8Array, object: AsfObject): Stream | null {
	let at = object.start + 60
	const names = uint16le(bytes, at)
	const extensions = uint16le(bytes, at + 2)

	at += 4

	for (let i = 0; i < names && at < object.end; i++) {
		at += 4 + uint16le(bytes, at + 2)
	}

	for (let i = 0; i < extensions && at < object.end; i++) {
		at += 22 + uint32le(bytes, at + 18)
	}

	return at + OBJECT_HEADER_BYTES <= object.end && isGuid(bytes, at, STREAM_PROPERTIES)
		? streamProperties(bytes, at + OBJECT_HEADER_BYTES, Math.min(object.end, at + uint64le(bytes, at + 16)))
		: null
}

// The data object's header (GUID, size, file id, packet count, reserved) before its first data packet.
export const ASF_DATA_HEADER_BYTES = 50

export interface AsfHeader {
	// Where the data object starts.
	headerSize: number
	// The data packets' fixed size (the file properties' minimum and maximum agree); null when they do not.
	packetSize: number | null
	packets: number
	// Seconds, the preroll taken off; null when unknown.
	duration: number | null
	preroll: number
	streams: AsfStream[]
	// Each stream's average time per frame, seconds, from its extended stream properties.
	frameTime: Map<number, number>
	// The header lies within `bytes`.
	complete: boolean
}

// The header object at the start of `bytes`.
export function parseAsfHeader(bytes: Uint8Array): AsfHeader {
	const headerSize = uint64le(bytes, 16)
	const headerEnd = Math.min(headerSize, bytes.length)
	const header: AsfHeader = {
		headerSize,
		packetSize: null,
		packets: 0,
		duration: null,
		preroll: 0,
		streams: [],
		frameTime: new Map(),
		complete: headerSize <= bytes.length
	}

	for (const object of objects(bytes, 30, headerEnd)) {
		if (isGuid(bytes, object.at, FILE_PROPERTIES) && object.start + 80 <= headerEnd) {
			const minimum = uint32le(bytes, object.start + 68)

			header.preroll = uint64le(bytes, object.start + 56) / 1000
			header.packets = uint64le(bytes, object.start + 32)
			header.packetSize = minimum > 0 && minimum === uint32le(bytes, object.start + 72) ? minimum : null

			const play = uint64le(bytes, object.start + 40) / 1e7 - header.preroll

			header.duration = play > 0 && Number.isFinite(play) ? play : null
		} else if (isGuid(bytes, object.at, STREAM_PROPERTIES)) {
			const stream = streamProperties(bytes, object.start, Math.min(object.end, headerEnd))

			if (stream !== null && header.streams.length < MAX_STREAMS) {
				header.streams.push(stream)
			}
		} else if (isGuid(bytes, object.at, HEADER_EXTENSION)) {
			for (const inner of objects(bytes, object.start + 22, Math.min(object.end, headerEnd))) {
				if (!isGuid(bytes, inner.at, EXTENDED_STREAM_PROPERTIES) || inner.start + 60 > inner.end) {
					continue
				}

				const frame = uint64le(bytes, inner.start + 52) / 1e7

				if (frame > 0) {
					header.frameTime.set(uint16le(bytes, inner.start + 48), frame)
				}

				const stream = embeddedStream(bytes, inner)

				if (
					stream !== null &&
					header.streams.length < MAX_STREAMS &&
					!header.streams.some(known => known.number === stream.number)
				) {
					header.streams.push(stream)
				}
			}
		}
	}

	header.streams.sort((a, b) => a.number - b.number)

	return header
}

// The duration is the file properties' play duration less the preroll. The index is "simple" when a Simple Index
// object follows the data object.
export async function walkAsf(source: BlockSource, result: ParsedContainer): Promise<void> {
	const bytes = await readBytes(source, 0, Math.min(source.size, HEAD_BYTES))
	const header = parseAsfHeader(bytes)
	const { headerSize } = header

	result.index = "none"
	result.durationSec = header.duration === null ? null : seconds(header.duration)
	result.tracksFound = header.complete
	result.partial = !result.tracksFound

	let firstAudio = true

	for (const stream of header.streams) {
		if ("video" in stream) {
			// H.264 is named by its SPS: in the format data past the BITMAPINFOHEADER where the muxer put it, else in
			// band, in the first packets of the data object, which the head holds.
			const video =
				stream.video.codec === "h264" && stream.video.codecString === null
					? {
							...stream.video,
							codecString:
								spsCodecString(stream.specific.subarray(11 + 40)) ??
								spsCodecString(bytes.subarray(Math.min(headerSize, bytes.length)))
						}
					: stream.video

			result.tracks.push({ kind: "video", enabled: true, video })
		} else {
			result.tracks.push({
				kind: "audio",
				enabled: true,
				audio: { id: stream.number, ...stream.audio, lang: null, name: null, def: firstAudio, forced: false, commentary: false },
				config: stream.specific
			})
			firstAudio = false
		}
	}

	// The data object follows the header; its size says where an index object would start.
	const dataSize = headerSize + OBJECT_HEADER_BYTES <= bytes.length ? uint64le(bytes, headerSize + 16) : 0
	const indexAt = headerSize + dataSize

	if (dataSize > 0 && indexAt + 16 <= source.size) {
		result.index = isGuid(await readBytes(source, indexAt, 16), 0, ASF_SIMPLE_INDEX) ? "simple" : "none"
	}
}
