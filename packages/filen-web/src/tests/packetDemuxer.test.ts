import { describe, expect, it } from "vitest"
import { BufferSource, EncodedPacketSink, Input, InputFormat, type Demuxer } from "mediabunny"
import { PacketDemuxer, packetDemuxerOf, type ContainerReader, type DemuxPacket } from "@/lib/media/demux/packetDemuxer"

// A container of fixed 64 KiB units, each one audio packet whose payload the reader assembled; 0.1 s apiece.
const UNIT_BYTES = 64 * 1024
const UNIT_SECONDS = 0.1

function fakeReader(units: number, duration: number | null, reads: number[]): ContainerReader {
	return {
		tracks: [
			{
				type: "audio",
				number: 1,
				name: null,
				language: "und",
				isDefault: true,
				internalCodecId: null,
				codec: "pcm-s16",
				channels: 1,
				sampleRate: 48000,
				decoderConfig: { codec: "pcm-s16", numberOfChannels: 1, sampleRate: 48000 }
			}
		],
		duration,
		dataStart: 0,
		readPackets: pos => {
			const unit = pos / UNIT_BYTES

			if (unit >= units) {
				return Promise.resolve(null)
			}

			reads.push(pos)

			const packet: DemuxPacket = {
				track: 1,
				pts: unit * UNIT_SECONDS,
				duration: UNIT_SECONDS,
				key: true,
				unit: pos,
				part: 0,
				pos,
				size: UNIT_BYTES,
				payload: new Uint8Array(UNIT_BYTES).fill(unit & 0xff)
			}

			return Promise.resolve({ packets: [packet], next: pos + UNIT_BYTES })
		},
		resync: pos => Promise.resolve(Math.ceil(pos / UNIT_BYTES) * UNIT_BYTES)
	}
}

class FakeFormat extends InputFormat {
	public readonly name = "fake"
	public readonly mimeType = "audio/x-fake"
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

function inputOf(units: number, duration: number | null, reads: number[]): Input {
	return new Input({
		formats: [new FakeFormat(fakeReader(units, duration, reads))],
		source: new BufferSource(new Uint8Array(units * UNIT_BYTES))
	})
}

describe("PacketDemuxer", () => {
	it("estimates a duration the header lacks from the data's start, reading only that", async () => {
		const reads: number[] = []
		const input = inputOf(1000, null, reads)

		await input.getTracks()
		expect(packetDemuxerOf(input)).not.toBeNull()
		expect(await input.getDurationFromMetadata()).toBeCloseTo(100, 6)
		expect(Math.max(...reads)).toBeLessThan(64 * UNIT_BYTES)
	})

	it("gives a short file's exact duration once it was read to the end", async () => {
		const input = inputOf(5, null, [])

		expect(await input.getDurationFromMetadata()).toBeCloseTo(0.5, 6)
	})

	it("keeps assembled payloads within a byte budget, reading a dropped stretch again when asked", async () => {
		const reads: number[] = []
		const input = inputOf(400, 40, reads)
		const sink = new EncodedPacketSink((await input.getTracks())[0] ?? expect.unreachable())
		let count = 0

		for await (const packet of sink.packets()) {
			expect(packet.data[0]).toBe(count & 0xff)
			count++
		}

		expect(count).toBe(400)

		const before = reads.length
		const first = await sink.getPacket(0)

		expect(first?.data[0]).toBe(0)
		expect(reads.length).toBeGreaterThan(before)
	})
})

// Two audio tracks whose packets share their units: 16-byte units, each holding one packet of either track, read
// in windows of 64 units. Packets carry no payload of their own, so only the record budget evicts.
const SMALL_UNIT = 16
const WINDOW_UNITS = 64

function audioTrack(number: number) {
	return {
		type: "audio" as const,
		number,
		name: null,
		language: "und",
		isDefault: number === 1,
		internalCodecId: null,
		codec: "pcm-s16" as const,
		channels: 1,
		sampleRate: 48000,
		decoderConfig: { codec: "pcm-s16", numberOfChannels: 1, sampleRate: 48000 }
	}
}

function sharedUnits(units: number, tracks: number[]): ContainerReader {
	return {
		tracks: [audioTrack(1), audioTrack(2)],
		duration: units * 0.01,
		dataStart: 0,
		readPackets: pos => {
			const start = pos / SMALL_UNIT

			if (start >= units) {
				return Promise.resolve(null)
			}

			const packets: DemuxPacket[] = []
			const end = Math.min(units, start + WINDOW_UNITS)

			for (let unit = start; unit < end; unit++) {
				tracks.forEach((track, part) => {
					packets.push({
						track,
						pts: unit * 0.01,
						duration: 0.01,
						key: true,
						unit: unit * SMALL_UNIT,
						part,
						pos: unit * SMALL_UNIT,
						size: 1
					})
				})
			}

			return Promise.resolve({ packets, next: end * SMALL_UNIT })
		},
		resync: pos => Promise.resolve(Math.ceil(pos / SMALL_UNIT) * SMALL_UNIT)
	}
}

function inputOver(reader: ContainerReader, size: number): Input {
	return new Input({ formats: [new FakeFormat(reader)], source: new BufferSource(new Uint8Array(size)) })
}

describe("PacketDemuxer eviction", () => {
	it("never ends a track mid-way when the run it reads from is cut, however far one track lags the other", async () => {
		const UNITS = 6000

		for (let lag = 1200; lag <= 1500; lag += 37) {
			const input = inputOver(sharedUnits(UNITS, [1, 2]), UNITS * SMALL_UNIT)
			const [lead, behind] = await input.getAudioTracks()
			const ahead = new EncodedPacketSink(lead ?? expect.unreachable())
			const after = new EncodedPacketSink(behind ?? expect.unreachable())
			let a = await ahead.getFirstPacket()
			let b = await after.getFirstPacket()
			let readA = 1
			let readB = 1

			while (a !== null || b !== null) {
				if (a !== null && (readA - readB < lag || b === null)) {
					a = await ahead.getNextPacket(a)
					readA += a === null ? 0 : 1
				} else if (b !== null) {
					b = await after.getNextPacket(b)
					readB += b === null ? 0 : 1
				}
			}

			expect([lag, readA, readB]).toEqual([lag, UNITS, UNITS])
		}
	})

	it("stops looking for the first packet where no listed track's packets come", async () => {
		const reads: number[] = []
		const silent = sharedUnits(1_000_000, [7, 8])
		const reader: ContainerReader = {
			...silent,
			readPackets: pos => {
				reads.push(pos)

				return silent.readPackets(pos)
			}
		}
		const input = inputOver(reader, 1_000_000 * SMALL_UNIT)

		expect(await new EncodedPacketSink((await input.getAudioTracks())[0] ?? expect.unreachable()).getFirstPacket()).toBeNull()
		expect(Math.max(...reads)).toBeLessThanOrEqual(17 * 1024 * 1024)
	})
})
