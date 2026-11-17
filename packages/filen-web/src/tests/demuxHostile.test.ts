import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BufferSource, CustomSource, EncodedPacketSink, Input, type InputFormat, type InputTrack } from "mediabunny"
import { ASF_SIMPLE_INDEX, parseAsfHeader } from "@filen/shared/videos"
import { ASF } from "@/lib/media/demux/asfDemuxer"
import { AVI, KeyIndexBuilder } from "@/lib/media/demux/aviDemuxer"
import { FLV } from "@/lib/media/demux/flvDemuxer"

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
