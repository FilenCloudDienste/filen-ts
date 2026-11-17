import { InputFormat, type AudioCodec, type Demuxer, type Input, type VideoCodec } from "mediabunny"
import {
	ASF_DATA_HEADER_BYTES,
	ASF_HEADER,
	ASF_SIMPLE_INDEX,
	avcConfigCodecString,
	isGuid,
	mpegAudioHeader,
	parseAsfHeader,
	uint64le,
	type AsfHeader,
	type AsfStream,
	type MediaCodec
} from "@filen/shared/videos"
import {
	avcParameters,
	avcPicture,
	freshTimeline,
	withParameterSets,
	type AvcParameters,
	type AvcTimelineState
} from "@/lib/media/demux/avcTimeline"
import { MAX_PARTS, PacketDemuxer, readAt, type ContainerReader, type DemuxPacket, type DemuxTrack } from "@/lib/media/demux/packetDemuxer"

// ASF (Windows Media): fixed-size data packets, each carrying payloads: fragments of media objects (a picture, a
// stretch of audio) with the object's presentation time in its replicated data. Objects are reassembled per stream
// and object number. Seeks go through the Simple Index when the file has one, else interpolate over the packets,
// whose fixed size makes any position a packet boundary.

// Packets read at once.
const WINDOW_PACKETS = 64
// Packets read past a window to finish the objects that started in it.
const FINISH_PACKETS = 256
// An object bigger than this is no picture or stretch of sound this plays: dropped.
const MAX_OBJECT_BYTES = 16 * 1024 * 1024
// The head of the data read for a stream's first key object, for H.264's parameter sets.
const PARAMETER_SEARCH_PACKETS = 512

const VIDEO_CODECS: Partial<Record<MediaCodec, VideoCodec>> = { h264: "avc", hevc: "hevc", vp8: "vp8", vp9: "vp9", av1: "av1" }

function uint16le(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
}

function uint32le(bytes: Uint8Array, at: number): number {
	return uint16le(bytes, at) + uint16le(bytes, at + 2) * 0x10000
}

// A field whose 2-bit length type is 0 (absent), 1 (BYTE), 2 (WORD) or 3 (DWORD).
function sized(bytes: Uint8Array, at: number, type: number): [value: number, length: number] {
	switch (type & 0x03) {
		case 1:
			return [bytes[at] ?? 0, 1]
		case 2:
			return [uint16le(bytes, at), 2]
		case 3:
			return [uint32le(bytes, at), 4]
		default:
			return [0, 0]
	}
}

// One payload of a data packet: a fragment of a media object.
export interface AsfPayload {
	stream: number
	key: boolean
	object: number
	offset: number
	// The whole object's size and presentation time (ms), from the replicated data; null where it carries none.
	objectSize: number | null
	time: number | null
	// Where the fragment's bytes are in the packet.
	start: number
	length: number
	// Compressed payloads: several whole objects, each its own time.
	parts?: { start: number; length: number; time: number }[]
}

// The payloads of the data packet `packet` (exactly one packet's bytes); [] for one that does not parse.
export function asfPayloads(packet: Uint8Array): AsfPayload[] {
	let at = 0
	const first = packet[0] ?? 0

	// Error correction data.
	if ((first & 0x80) !== 0) {
		at += 1 + (first & 0x0f)
	}

	const lengthFlags = packet[at] ?? 0
	const propertyFlags = packet[at + 1] ?? 0

	at += 2

	const multiple = (lengthFlags & 0x01) !== 0
	const [, sequenceBytes] = sized(packet, at, lengthFlags >> 1)
	const [packetLength, packetLengthBytes] = sized(packet, at, lengthFlags >> 5)

	at += packetLengthBytes
	at += sequenceBytes

	const [padding, paddingBytes] = sized(packet, at, lengthFlags >> 3)

	at += paddingBytes
	// Send time and duration.
	at += 6

	const end = Math.min(packet.length, (packetLength > 0 ? packetLength : packet.length) - padding)
	const payloads: AsfPayload[] = []
	let count = 1
	let lengthType = 0

	if (multiple) {
		const flags = packet[at] ?? 0

		count = flags & 0x3f
		lengthType = flags >> 6
		at += 1
	}

	for (let i = 0; i < count && at < end; i++) {
		const streamByte = packet[at] ?? 0

		at += 1

		const [object, objectBytes] = sized(packet, at, propertyFlags >> 4)

		at += objectBytes

		const [offset, offsetBytes] = sized(packet, at, propertyFlags >> 2)

		at += offsetBytes

		const [replicated, replicatedBytes] = sized(packet, at, propertyFlags)

		at += replicatedBytes

		const replicatedAt = at

		at += replicated

		const [declared, declaredBytes] = multiple ? sized(packet, at, lengthType) : [end - at, 0]

		at += declaredBytes

		const length = Math.min(declared, end - at)

		if (length < 0 || at > end) {
			break
		}

		const payload: AsfPayload = {
			stream: streamByte & 0x7f,
			key: (streamByte & 0x80) !== 0,
			object,
			offset,
			objectSize: replicated >= 8 ? uint32le(packet, replicatedAt) : null,
			time: replicated >= 8 ? uint32le(packet, replicatedAt + 4) : null,
			start: at,
			length
		}

		// Compressed payloads: replicated data is one byte (the time delta), the offset field the presentation time, and
		// the data whole objects, each behind its length byte.
		if (replicated === 1) {
			const delta = packet[replicatedAt] ?? 0
			const parts: { start: number; length: number; time: number }[] = []

			for (let sub = at, k = 0; sub < at + length; k++) {
				const size = packet[sub] ?? 0

				parts.push({ start: sub + 1, length: Math.min(size, at + length - sub - 1), time: offset + k * delta })
				sub += 1 + size
			}

			payload.parts = parts
		}

		payloads.push(payload)
		at += length
	}

	return payloads
}

interface Pending {
	unit: number
	part: number
	key: boolean
	time: number
	size: number
	received: number
	// The single fragment's place (and bytes, in the read window) when the object came whole, else its assembled bytes.
	whole: { pos: number; data: Uint8Array } | null
	bytes: Uint8Array | null
}

interface Track {
	number: number
	stream: AsfStream
	demux: DemuxTrack
	frame: number
	mpegAudio: boolean
	// H.264: its parameter sets, for presentation times from picture order counts, and those kept in the format
	// header (put in front of key pictures that carry none).
	avc: AvcParameters | null
	parameterSets: Uint8Array | null
}

class AsfReader implements ContainerReader {
	public readonly duration: number | null
	public readonly dataStart: number
	private readonly input: Input
	private readonly size: number
	private readonly packetSize: number
	private readonly preroll: number
	private readonly dataEnd: number
	private readonly streams: Map<number, Track>
	private simpleIndex: { interval: number; packets: number[] } | null | undefined

	public constructor(input: Input, size: number, header: AsfHeader, packetSize: number, streams: Map<number, Track>) {
		this.input = input
		this.size = size
		this.packetSize = packetSize
		this.preroll = header.preroll
		this.duration = header.duration
		this.dataStart = header.headerSize + ASF_DATA_HEADER_BYTES
		this.dataEnd = header.packets > 0 ? Math.min(size, this.dataStart + header.packets * packetSize) : size
		this.streams = streams
	}

	public get tracks(): DemuxTrack[] {
		return [...this.streams.values()].map(track => track.demux)
	}

	public async readPackets(pos: number): Promise<{ packets: DemuxPacket[]; next: number } | null> {
		if (pos + this.packetSize > this.dataEnd) {
			return null
		}

		const windowEnd = Math.min(this.dataEnd, pos + WINDOW_PACKETS * this.packetSize)
		const finishEnd = Math.min(this.dataEnd, windowEnd + FINISH_PACKETS * this.packetSize)
		const pending = new Map<string, Pending>()
		const packets: DemuxPacket[] = []
		// Picture order counts, per H.264 stream, from where this read starts.
		const timelines = new Map<number, AvcTimelineState>()
		let bytes: Uint8Array = new Uint8Array()
		let bytesStart = pos

		for (let at = pos; at + this.packetSize <= finishEnd; at += this.packetSize) {
			// Past the window only objects already started are finished; once none is, the read ends.
			if (at >= windowEnd && pending.size === 0) {
				break
			}

			if (at + this.packetSize > bytesStart + bytes.length) {
				bytesStart = at
				bytes = (await readAt(this.input, at, Math.min(WINDOW_PACKETS * this.packetSize, finishEnd - at))) ?? new Uint8Array()

				if (bytes.length < this.packetSize) {
					break
				}
			}

			const packet = bytes.subarray(at - bytesStart, at - bytesStart + this.packetSize)
			let part = 0

			for (const payload of asfPayloads(packet)) {
				const track = this.streams.get(payload.stream)

				if (track === undefined) {
					continue
				}

				if (payload.parts !== undefined) {
					for (const sub of payload.parts) {
						if (at < windowEnd && part < MAX_PARTS) {
							this.emit(track, packets, timelines, {
								unit: at,
								part: part++,
								key: payload.key,
								time: sub.time,
								size: sub.length,
								received: sub.length,
								whole: { pos: at + sub.start, data: packet.subarray(sub.start, sub.start + sub.length) },
								bytes: null
							})
						}
					}

					continue
				}

				const id = `${String(payload.stream)}:${String(payload.object)}`
				let object = pending.get(id)

				if (object === undefined) {
					// An object is taken up only at its first fragment, and only inside the window.
					if (payload.offset !== 0 || at >= windowEnd || part >= MAX_PARTS || payload.time === null) {
						continue
					}

					const size = payload.objectSize ?? payload.length

					if (size > MAX_OBJECT_BYTES) {
						continue
					}

					object = { unit: at, part: part++, key: payload.key, time: payload.time, size, received: 0, whole: null, bytes: null }
					pending.set(id, object)
				}

				if (payload.offset !== object.received) {
					// A fragment lost or out of order: the object cannot be rebuilt.
					pending.delete(id)

					continue
				}

				if (object.received === 0 && payload.length >= object.size) {
					object.whole = { pos: at + payload.start, data: packet.subarray(payload.start, payload.start + object.size) }
				} else {
					object.bytes ??= new Uint8Array(object.size)
					object.bytes.set(
						packet.subarray(payload.start, payload.start + Math.min(payload.length, object.size - object.received)),
						object.received
					)
				}

				object.received += payload.length

				if (object.received >= object.size) {
					pending.delete(id)
					this.emit(track, packets, timelines, object)
				}
			}
		}

		packets.sort((a, b) => a.unit - b.unit || a.part - b.part)

		return { packets, next: windowEnd }
	}

	private emit(track: Track, out: DemuxPacket[], timelines: Map<number, AvcTimelineState>, object: Pending): void {
		const time = object.time / 1000 - this.preroll
		let pts = time
		let key = object.key || track.demux.type === "audio"

		// The object's time is its decode time where the writer had no other (ffmpeg's): H.264 pictures take their
		// presentation from picture order counts, counted from the last key picture.
		if (track.avc !== null) {
			const data = object.bytes ?? object.whole?.data ?? null
			let timeline = timelines.get(track.number)

			if (timeline === undefined) {
				timeline = freshTimeline()
				timelines.set(track.number, timeline)
			}

			const picture = data === null ? null : avcPicture(data, null, track.avc, timeline, time, false, track.frame)

			pts = picture?.pts ?? time
			key ||= picture?.key === true

			if (key && data !== null && picture?.parameterSets === false && track.parameterSets !== null) {
				object.bytes = withParameterSets(track.parameterSets, data)
				object.size = object.bytes.length
			}
		}

		const base = { track: track.number, pts, unit: object.unit, part: object.part, key }

		if (track.mpegAudio) {
			this.mpegFrames(track, out, object, base)

			return
		}

		if (object.whole !== null && object.bytes === null) {
			out.push({ ...base, duration: track.frame, pos: object.whole.pos, size: object.size })
		} else if (object.bytes !== null) {
			out.push({ ...base, duration: track.frame, pos: object.unit, size: object.size, payload: object.bytes })
		}
	}

	// MPEG audio objects hold several frames: one packet each, at the object's time onward, numbered on from the
	// object's part so they stay in order within its unit.
	private mpegFrames(track: Track, out: DemuxPacket[], object: Pending, base: Omit<DemuxPacket, "duration" | "pos" | "size">): void {
		const data = object.bytes

		if (data === null) {
			// The object came whole in one payload: the frames are read from where it lies, then split here.
			out.push({ ...base, duration: track.frame, pos: object.whole?.pos ?? object.unit, size: object.size })

			return
		}

		let pts = base.pts
		let part = base.part

		for (let offset = 0; offset + 4 <= data.length && part < MAX_PARTS;) {
			const header = mpegAudioHeader(data, offset)
			const frameBytes = header === null ? null : header.frameBytes

			if (header === null || frameBytes === null || offset + frameBytes > data.length) {
				return
			}

			const duration = header.samples / header.rate

			out.push({
				...base,
				part: part++,
				pts,
				duration,
				pos: object.unit,
				size: frameBytes,
				payload: data.slice(offset, offset + frameBytes)
			})
			pts += duration
			offset += frameBytes
		}
	}

	public resync(pos: number): Promise<number | null> {
		const packets = Math.ceil((pos - this.dataStart) / this.packetSize)
		const at = this.dataStart + Math.max(0, packets) * this.packetSize

		return Promise.resolve(at + this.packetSize <= this.dataEnd ? at : null)
	}

	public async indexedPosition(t: number): Promise<number | null> {
		const index = await this.loadSimpleIndex()

		if (index === null) {
			return null
		}

		const entry = Math.min(index.packets.length - 1, Math.max(0, Math.floor((t + this.preroll) / index.interval)))
		const packet = index.packets[entry]

		return packet === undefined ? null : this.dataStart + packet * this.packetSize
	}

	// The Simple Index after the data object: per time interval, the packet holding the key picture before it.
	private async loadSimpleIndex(): Promise<{ interval: number; packets: number[] } | null> {
		if (this.simpleIndex !== undefined) {
			return this.simpleIndex
		}

		this.simpleIndex = null

		const head = this.dataEnd + 56 <= this.size ? await readAt(this.input, this.dataEnd, 56) : null

		if (head === null || !isGuid(head, 0, ASF_SIMPLE_INDEX)) {
			return null
		}

		const interval = uint64le(head, 40) / 1e7
		const count = Math.min(uint32le(head, 52), Math.floor((this.size - this.dataEnd - 56) / 6))
		const entries = count > 0 && interval > 0 ? await readAt(this.input, this.dataEnd + 56, count * 6) : null

		if (entries === null) {
			return null
		}

		this.simpleIndex = { interval, packets: Array.from({ length: count }, (_, i) => uint32le(entries, i * 6)) }

		return this.simpleIndex
	}
}

function pcmCodec(tag: number, bits: number): AudioCodec | null {
	if (tag === 0x0003) {
		return bits === 32 ? "pcm-f32" : bits === 64 ? "pcm-f64" : null
	}

	return tag !== 0x0001
		? null
		: bits === 8
			? "pcm-u8"
			: bits === 16
				? "pcm-s16"
				: bits === 24
					? "pcm-s24"
					: bits === 32
						? "pcm-s32"
						: null
}

function audioTrack(stream: Extract<AsfStream, { audio: unknown }>, isDefault: boolean): DemuxTrack {
	const { audio, specific } = stream
	const channels = audio.ch ?? 2
	const sampleRate = audio.rate ?? 44100
	const tag = uint16le(specific, 0)
	let codec: AudioCodec | null = null

	if (audio.codec === "mp3" || audio.codec === "aac" || audio.codec === "ac3") {
		codec = audio.codec
	} else if (audio.codec === "pcm") {
		codec = pcmCodec(tag, uint16le(specific, 14))
	}

	const extra = specific.length >= 18 ? specific.subarray(18, 18 + uint16le(specific, 16)) : null

	return {
		type: "audio",
		number: stream.number,
		name: null,
		language: "und",
		isDefault,
		internalCodecId: tag,
		codec,
		channels,
		sampleRate,
		decoderConfig:
			codec === null
				? null
				: {
						codec: codec === "mp3" || codec.startsWith("pcm") ? codec : (audio.codecString ?? codec),
						numberOfChannels: channels,
						sampleRate,
						...(codec === "aac" && extra !== null && extra.length >= 2 ? { description: extra } : {})
					}
	}
}

async function openAsf(input: Input): Promise<ContainerReader> {
	const size = input._reader.fileSize ?? 0
	const prefix = (await readAt(input, 0, Math.min(size, 30))) ?? new Uint8Array()
	const headerSize = Math.min(size, uint64le(prefix, 16))
	const header = parseAsfHeader((await readAt(input, 0, headerSize)) ?? prefix)
	const packetSize = header.packetSize ?? 0
	const streams = new Map<number, Track>()
	let firstAudio = true

	for (const stream of header.streams) {
		const frame = header.frameTime.get(stream.number) ?? 1 / 30

		if ("video" in stream) {
			const codec = stream.video.codec === null ? null : (VIDEO_CODECS[stream.video.codec] ?? null)

			streams.set(stream.number, {
				number: stream.number,
				stream,
				frame,
				mpegAudio: false,
				avc: null,
				parameterSets: null,
				demux: {
					type: "video",
					number: stream.number,
					name: null,
					language: "und",
					isDefault: true,
					internalCodecId: stream.video.fourcc,
					codec,
					width: stream.video.w,
					height: stream.video.h,
					squarePixelWidth: stream.video.w,
					squarePixelHeight: stream.video.h,
					decoderConfig: null
				}
			})
		} else {
			streams.set(stream.number, {
				number: stream.number,
				stream,
				frame,
				mpegAudio: stream.audio.codec === "mp3" || stream.audio.codec === "mp2" || stream.audio.codec === "mp1",
				avc: null,
				parameterSets: null,
				demux: audioTrack(stream, firstAudio)
			})
			firstAudio = false
		}
	}

	const reader = new AsfReader(input, size, header, packetSize, streams)

	if (packetSize > 0) {
		await nameAvc(input, reader, header, streams)
	}

	return reader
}

function applyParameters(track: Track, parameters: AvcParameters, header: AsfHeader): void {
	const { sps } = parameters

	if (track.demux.type !== "video") {
		return
	}

	track.avc = parameters
	track.frame = header.frameTime.get(track.number) ?? sps.frameSeconds ?? track.frame
	track.demux = {
		...track.demux,
		width: sps.width,
		height: sps.height,
		squarePixelWidth: sps.par > 1 ? Math.round(sps.width * sps.par) : sps.width,
		squarePixelHeight: sps.par < 1 ? Math.round(sps.height / sps.par) : sps.height,
		decoderConfig: { codec: avcConfigCodecString("avc1", sps), codedWidth: sps.width, codedHeight: sps.height }
	}
}

// H.264 in ASF is Annex B. Its parameter sets follow the BITMAPINFOHEADER as extra data, or come in band: then the
// first key picture names the codec and the size.
async function nameAvc(input: Input, reader: AsfReader, header: AsfHeader, streams: Map<number, Track>): Promise<void> {
	const avc = [...streams.values()].filter(track => {
		if (track.demux.type !== "video" || track.demux.codec !== "avc") {
			return false
		}

		// The type-specific data: picture size (8), flags (1), format size (2), then the BITMAPINFOHEADER, whose size
		// counts the extra data after its 40 bytes.
		const { specific } = track.stream
		const biSize = uint32le(specific, 11)
		const extra = specific.subarray(11 + 40, biSize > 40 ? 11 + biSize : specific.length)
		const parameters = extra.length > 0 ? avcParameters(extra, null) : null

		if (parameters !== null) {
			applyParameters(track, parameters, header)
			track.parameterSets = extra
		}

		return parameters === null
	})
	let pos = reader.dataStart

	for (let read = 0; avc.length > 0 && read < PARAMETER_SEARCH_PACKETS; read += WINDOW_PACKETS) {
		const result = await reader.readPackets(pos)

		if (result === null) {
			break
		}

		for (const packet of result.packets) {
			const track = avc.find(candidate => candidate.number === packet.track)
			const data = packet.payload ?? (await readAt(input, packet.pos, Math.min(packet.size, 64 * 1024)))
			const parameters = data === null ? null : avcParameters(data, null)

			if (track !== undefined && parameters !== null) {
				applyParameters(track, parameters, header)
				avc.splice(avc.indexOf(track), 1)
			}
		}

		pos = result.next
	}

	for (const track of streams.values()) {
		// A picture stream whose parameters were never found plays nothing.
		if (track.demux.type === "video" && track.demux.decoderConfig === null) {
			track.demux = { ...track.demux, codec: null }
		}
	}
}

class AsfInputFormat extends InputFormat {
	public readonly name = "ASF"
	public readonly mimeType = "video/x-ms-asf"
	public readonly supportsTimestampedMediaData = true

	public override async _getMatchPosition(input: Input): Promise<number | null> {
		const head = await readAt(input, 0, 16)

		return head !== null && isGuid(head, 0, ASF_HEADER) ? 0 : null
	}

	public override _createDemuxer(input: Input): Demuxer {
		return new PacketDemuxer(input, "video/x-ms-asf", openAsf)
	}
}

export const ASF = new AsfInputFormat()
