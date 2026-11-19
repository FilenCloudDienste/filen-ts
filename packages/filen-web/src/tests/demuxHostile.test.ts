import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BufferSource, CustomSource, EncodedPacketSink, Input, InputFormat, type Demuxer, type InputTrack } from "mediabunny"
import { ASF_SIMPLE_INDEX, parseAsfHeader } from "@filen/shared/videos"
import { ASF } from "@/lib/media/demux/asfDemuxer"
import { AVI, KeyIndexBuilder } from "@/lib/media/demux/aviDemuxer"
import { FLV } from "@/lib/media/demux/flvDemuxer"
import { PacketDemuxer, packetDemuxerOf, type ContainerReader, type DemuxPacket } from "@/lib/media/demux/packetDemuxer"

// Real files with one header size made hostile, served as the head of a 2 GiB file: opening and reading them stays
// within the probe's own read budget instead of fetching what the header claims.
const VIRTUAL_SIZE = 2 * 1024 ** 3
const READ_BUDGET = 8 * 1024 * 1024
const FIXTURES = join(__dirname, "fixtures", "demux")

function patched(name: string, at: (bytes: Uint8Array) => number, value: number, width: number): Uint8Array {
	const bytes = Uint8Array.from(readFileSync(join(FIXTURES, name)))
	const offset = at(bytes)

	for (let i = 0; i < width; i++) {
		bytes[offset + i] = Math.floor(value / 256 ** i) & 0xff
	}

	return bytes
}

function indexOfBytes(bytes: Uint8Array, needle: readonly number[]): number {
	for (let at = 0; at + needle.length <= bytes.length; at++) {
		if (needle.every((byte, i) => bytes[at + i] === byte)) {
			return at
		}
	}

	throw new Error("not found")
}

async function bytesRead(
	format: InputFormat,
	head: Uint8Array,
	act: (track: InputTrack) => Promise<unknown> = track => new EncodedPacketSink(track).getFirstPacket()
): Promise<number> {
	let total = 0
	const input = new Input({
		formats: [format],
		source: new CustomSource({
			getSize: () => VIRTUAL_SIZE,
			read: (start, end) => {
				total += end - start

				const out = new Uint8Array(end - start)

				out.set(head.subarray(Math.min(start, head.length), Math.min(end, head.length)))

				return out
			},
			maxCacheSize: 0,
			prefetchProfile: "none"
		})
	})

	for (const track of await input.getTracks().catch(() => [])) {
		await act(track).catch(() => null)
	}

	return total
}

// The File Properties object's GUID, as stored.
const ASF_FILE_PROPERTIES = [0xa1, 0xdc, 0xab, 0x8c, 0x47, 0xa9, 0xcf, 0x11, 0x8e, 0xe4, 0x00, 0xc0, 0x0c, 0x20, 0x53, 0x65]

describe("demuxers over hostile header sizes", () => {
	it("AVI: an hdrl list claiming gigabytes", async () => {
		const bytes = patched("h264-bframes-mp3.avi", () => 16, 0x7ffffff0, 4)

		expect(await bytesRead(AVI, bytes)).toBeLessThan(READ_BUDGET)
	})

	it("ASF: a header object claiming gigabytes", async () => {
		const bytes = patched("h264-mp3.asf", () => 16, 0x7ffffff0, 8)

		expect(await bytesRead(ASF, bytes)).toBeLessThan(READ_BUDGET)
	})

	it("ASF: a data packet size of a gigabyte", async () => {
		// The minimum and maximum packet sizes, 68 bytes into the object's data (24 into the object).
		const bytes = patched("h264-mp3.asf", found => indexOfBytes(found, ASF_FILE_PROPERTIES) + 24 + 68, 0x4000_0000 * 0x1_0000_0001, 8)

		expect(await bytesRead(ASF, bytes)).toBeLessThan(READ_BUDGET)
	})

	it("ASF: a Simple Index claiming four billion entries", async () => {
		const bytes = patched("h264-mp3.asf", found => indexOfBytes(found, [...ASF_SIMPLE_INDEX]) + 52, 0xffffffff, 4)

		expect(await bytesRead(ASF, bytes, track => new EncodedPacketSink(track).getKeyPacket(1))).toBeLessThan(READ_BUDGET)
	})

	it("FLV: a DataOffset past the head", async () => {
		const header = Uint8Array.from([0x46, 0x4c, 0x56, 1, 0x05, 0x7f, 0xff, 0xff, 0xf0, 0, 0, 0, 0])

		expect(await bytesRead(FLV, header)).toBeLessThan(READ_BUDGET)
	})
})

describe("AVI key index", () => {
	it("keeps one position a second at most, thinning past its cap, with the ticks of those positions only", () => {
		const builder = new KeyIndexBuilder(32)
		const ticks = Array.from({ length: 32 }, () => 0)

		// Six hours of all-intra pictures at 25 fps.
		for (let frame = 0; frame < 25 * 3600 * 6; frame++) {
			ticks[0] = frame
			builder.add(frame * 1000, frame / 25, ticks)
		}

		const index = defined(builder.build())
		const entries = index.positions.length

		expect(entries).toBeLessThanOrEqual(8192)
		expect(index.ticks.length).toBe(entries * 32)
		expect(index.ticks[32]).toBeGreaterThanOrEqual(25)
		expect((index.positions[1] ?? 0) - (index.positions[0] ?? 0)).toBeGreaterThanOrEqual(25 * 1000)
	})
})

function defined<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) {
		throw new Error("missing")
	}

	return value
}

// ── ASF data packets built by hand, behind the real file's header ──

// The fixture's header with the data packets (3200 bytes each) `build` makes for its audio stream, and nothing after.
function asfWith(build: (audioStream: number) => Uint8Array[]): Uint8Array {
	const real = Uint8Array.from(readFileSync(join(FIXTURES, "h264-mp3.asf")))
	const header = parseAsfHeader(real)
	const packets = build(header.streams.find(stream => "audio" in stream)?.number ?? 0)
	const dataStart = header.headerSize + 50
	const bytes = new Uint8Array(dataStart + packets.length * 3200)
	const view = new DataView(bytes.buffer)
	const fileProperties = indexOfBytes(real, ASF_FILE_PROPERTIES)

	bytes.set(real.subarray(0, dataStart))
	view.setUint32(fileProperties + 24 + 32, packets.length, true)
	view.setUint32(header.headerSize + 40, packets.length, true)
	packets.forEach((packet, i) => {
		bytes.set(packet, dataStart + i * 3200)
	})

	return bytes
}

interface AsfTestPayload {
	stream: number
	object: number
	offset: number
	objectSize: number
	timeMs: number
	data: Uint8Array
}

// One data packet: multiple payloads, object numbers in a byte, offsets in a dword, 8 bytes of replicated data (the
// object's size and time) and a word of length each.
function asfPacket(payloads: AsfTestPayload[]): Uint8Array {
	const packet = new Uint8Array(3200)
	const view = new DataView(packet.buffer)
	let at = 0

	packet[at++] = 0x01
	packet[at++] = 0x5d
	at += 6
	packet[at++] = 0x80 | payloads.length

	for (const payload of payloads) {
		packet[at++] = 0x80 | payload.stream
		packet[at++] = payload.object
		view.setUint32(at, payload.offset, true)
		at += 4
		packet[at++] = 8
		view.setUint32(at, payload.objectSize, true)
		view.setUint32(at + 4, payload.timeMs, true)
		at += 8
		view.setUint16(at, payload.data.length, true)
		at += 2
		packet.set(payload.data, at)
		at += payload.data.length
	}

	return packet
}

// MPEG-2 layer III, 16 kbit/s at 22.05 kHz: 52-byte frames of 576 samples.
function mp3Frames(count: number): Uint8Array {
	const out = new Uint8Array(52 * count)

	for (let i = 0; i < count; i++) {
		out.set([0xff, 0xf3, 0x20, 0xc0], i * 52)
	}

	return out
}

describe("ASF reassembly", () => {
	it("splits MPEG audio objects that share a data packet into frames of their own, never sharing a sequence number", async () => {
		const bytes = asfWith(audioStream => [
			asfPacket([
				{ stream: audioStream, object: 1, offset: 0, objectSize: 156, timeMs: 4000, data: mp3Frames(3) },
				{ stream: audioStream, object: 2, offset: 0, objectSize: 156, timeMs: 4078, data: mp3Frames(3) }
			])
		])
		const input = new Input({ formats: [ASF], source: new BufferSource(bytes) })
		const packets: number[] = []

		for await (const packet of new EncodedPacketSink(defined(await input.getPrimaryAudioTrack())).packets()) {
			expect(packet.data.length).toBe(52)
			packets.push(packet.timestamp)
		}

		expect(packets).toHaveLength(6)
		expect(new Set(packets).size).toBe(6)
		expect([...packets].sort((a, b) => a - b)).toEqual(packets)
	})

	it("holds no more than its budget of objects being reassembled, whatever sizes they claim", async () => {
		// Four packets of 63 objects each, every one claiming nearly 16 MiB and sending 16 bytes of it.
		const bytes = asfWith(audioStream =>
			Array.from({ length: 4 }, (_, packet) =>
				asfPacket(
					Array.from({ length: 63 }, (_, i) => ({
						stream: audioStream,
						object: (packet * 63 + i) & 0xff,
						offset: 0,
						objectSize: 16 * 1024 * 1024 - 1,
						timeMs: 4000 + packet * 100 + i,
						data: new Uint8Array(16)
					}))
				)
			)
		)
		const input = new Input({ formats: [ASF], source: new BufferSource(bytes) })
		const before = process.memoryUsage().arrayBuffers

		await new EncodedPacketSink(defined(await input.getPrimaryAudioTrack())).getFirstPacket()

		expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(48 * 1024 * 1024)
	})
})

// ── Key packet search over a long group of pictures ──

// One video picture per 16-byte unit, at 30 fps unless given, read 64 units at a time; packets carry no payload, so
// only the record budget (about 2730 packets) evicts.
const PICTURE_UNIT = 16
const PICTURE_SECONDS = 1 / 30

function pictures(units: number, isKey: (unit: number) => boolean, seconds: number): ContainerReader {
	// A search that rereads the file endlessly fails here instead of hanging (reads resolve at once, so no timeout fires).
	const readLimit = units
	let reads = 0

	return {
		tracks: [
			{
				type: "video",
				number: 1,
				name: null,
				language: "und",
				isDefault: true,
				internalCodecId: null,
				codec: "avc",
				width: 16,
				height: 16,
				squarePixelWidth: 16,
				squarePixelHeight: 16,
				decoderConfig: { codec: "avc1.42001e", codedWidth: 16, codedHeight: 16 }
			}
		],
		duration: units * seconds,
		dataStart: 0,
		readPackets: pos => {
			reads++

			if (reads > readLimit) {
				throw new Error(`read ${String(reads)} times`)
			}

			const start = pos / PICTURE_UNIT

			if (start >= units) {
				return Promise.resolve(null)
			}

			const packets: DemuxPacket[] = []
			const end = Math.min(units, start + 64)

			for (let unit = start; unit < end; unit++) {
				packets.push({
					track: 1,
					pts: unit * seconds,
					duration: seconds,
					key: isKey(unit),
					unit: unit * PICTURE_UNIT,
					part: 0,
					pos: unit * PICTURE_UNIT,
					size: 1
				})
			}

			return Promise.resolve({ packets, next: end * PICTURE_UNIT })
		},
		resync: pos => Promise.resolve(Math.ceil(pos / PICTURE_UNIT) * PICTURE_UNIT)
	}
}

class PictureFormat extends InputFormat {
	public readonly name = "pictures"
	public readonly mimeType = "video/x-pictures"
	public readonly supportsTimestampedMediaData = true
	private readonly reader: ContainerReader

	public constructor(reader: ContainerReader) {
		super()
		this.reader = reader
	}

	public override _getMatchPosition(): Promise<number | null> {
		return Promise.resolve(0)
	}

	public override _createDemuxer(input: Input): Demuxer {
		return new PacketDemuxer(input, this.mimeType, () => Promise.resolve(this.reader))
	}
}

async function packetAt(units: number, isKey: (unit: number) => boolean, unit: number, key: boolean, seconds = PICTURE_SECONDS) {
	const input = new Input({
		formats: [new PictureFormat(pictures(units, isKey, seconds))],
		source: new BufferSource(new Uint8Array(units * PICTURE_UNIT))
	})

	await input.getTracks()

	return defined(packetDemuxerOf(input)).at(1, unit * seconds, key, { metadataOnly: true })
}

async function keyPacketAt(units: number, isKey: (unit: number) => boolean, unit: number) {
	return packetAt(units, isKey, unit, true)
}

describe("PacketDemuxer key packet search", () => {
	it("finds the only key picture more than 3000 packets before the target", async () => {
		for (const keyUnit of [0, 1000]) {
			const found = await keyPacketAt(6000, unit => unit === keyUnit, keyUnit + 3500)

			expect([keyUnit, found?.type, found?.timestamp]).toEqual([keyUnit, "key", keyUnit * PICTURE_SECONDS])
		}
	})

	it("gives the latest key picture before the target, not an earlier one", async () => {
		const found = await keyPacketAt(9000, unit => unit === 0 || unit === 1000 || unit === 5000, 8000)

		expect(found?.timestamp).toBe(5000 * PICTURE_SECONDS)
	})

	it("ends with no key packet where the file has none", async () => {
		expect(await keyPacketAt(6000, () => false, 4500)).toBeNull()
	})

	// 4000 pictures a second: the second read past the target holds more packets than the kept budget.
	it("ends where more than the kept budget lies within the margin past the target", async () => {
		const seconds = 1 / 4000
		const isKey = (unit: number) => unit % 7000 === 0

		const key = await packetAt(50_000, isKey, 40_000, true, seconds)
		const any = await packetAt(50_000, isKey, 40_000, false, seconds)

		expect([key?.type, key?.timestamp, any?.timestamp]).toEqual(["key", 35_000 * seconds, 40_000 * seconds])
	})
})
