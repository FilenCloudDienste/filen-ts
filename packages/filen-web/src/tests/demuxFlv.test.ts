import { describe, expect, it } from "vitest"
import { BufferSource, CustomSource, EncodedPacketSink, Input, type EncodedPacket, type InputTrack } from "mediabunny"
import { FLV } from "@/lib/media/demux/flvDemuxer"

// x264 High@L3.1: its SPS, PPS and the avcC holding them.
const SPS = [
	0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50, 0x05, 0xbb, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03, 0x03, 0x00,
	0xf1, 0x83, 0x19, 0x60
]
const PPS = [0x68, 0xef, 0x89, 0xcb]
const AVCC = [0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0, SPS.length, ...SPS, 0x01, 0, PPS.length, ...PPS]
const FPS = 25
const KEY_EVERY = 25

function be(value: number, bytes: number): number[] {
	return Array.from({ length: bytes }, (_, i) => Math.floor(value / 256 ** (bytes - 1 - i)) & 0xff)
}

function text(value: string): number[] {
	return [...new TextEncoder().encode(value)]
}

function f64(value: number): number[] {
	const bytes = new Uint8Array(8)

	new DataView(bytes.buffer).setFloat64(0, value)

	return [...bytes]
}

function amfNumbers(values: number[]): number[] {
	return [0x0a, ...be(values.length, 4), ...values.flatMap(value => [0x00, ...f64(value)])]
}

function tag(type: number, ms: number, data: number[]): number[] {
	return [type, ...be(data.length, 3), ...be(ms & 0xffffff, 3), ms >>> 24, 0, 0, 0, ...data, ...be(11 + data.length, 4)]
}

function metaData(duration: number, keyframes: { times: number[]; positions: number[] } | null): number[] {
	const index =
		keyframes === null
			? []
			: [
					...be(9, 2),
					...text("keyframes"),
					0x03,
					...be(5, 2),
					...text("times"),
					...amfNumbers(keyframes.times),
					...be(13, 2),
					...text("filepositions"),
					...amfNumbers(keyframes.positions),
					0,
					0,
					9
				]

	return [
		0x02,
		...be(10, 2),
		...text("onMetaData"),
		0x08,
		...be(3, 4),
		...be(8, 2),
		...text("duration"),
		0x00,
		...f64(duration),
		...be(9, 2),
		...text("framerate"),
		0x00,
		...f64(FPS),
		...index,
		0,
		0,
		9
	]
}

// An FLV of `frames` H.264 pictures (a key one every second, `pictureBytes` each) and an AAC frame per 1024 samples
// at 48 kHz; with onMetaData's keyframe list when `indexed`.
function flv(frames: number, pictureBytes: number, indexed: boolean): Uint8Array {
	const header = [...text("FLV"), 1, 0x05, ...be(9, 4), 0, 0, 0, 0]
	const body: number[][] = [tag(9, 0, [0x17, 0, 0, 0, 0, ...AVCC]), tag(8, 0, [0xaf, 0, 0x11, 0x90])]
	const keys: { times: number[]; positions: number[] } = { times: [], positions: [] }
	let audioMs = 0

	for (let frame = 0; frame < frames; frame++) {
		const ms = (frame * 1000) / FPS
		const key = frame % KEY_EVERY === 0
		const nal = [key ? 0x65 : 0x41, frame & 0xff, ...new Array<number>(pictureBytes).fill(frame & 0x7f)]

		if (key) {
			keys.times.push(ms / 1000)
			keys.positions.push(body.reduce((sum, part) => sum + part.length, 0))
		}

		body.push(tag(9, Math.round(ms), [key ? 0x17 : 0x27, 1, 0, 0, 0, ...be(nal.length, 4), ...nal]))

		while (audioMs <= ms) {
			body.push(tag(8, Math.round(audioMs), [0xaf, 1, 0x21, 0x10, 0x04]))
			audioMs += (1024 * 1000) / 48000
		}
	}

	const duration = frames / FPS
	// The metadata tag's own length shifts the positions after it; it is the same length with and without real ones.
	const draft = tag(18, 0, metaData(duration, indexed ? keys : null))
	const base = header.length + draft.length
	const meta = tag(18, 0, metaData(duration, indexed ? { times: keys.times, positions: keys.positions.map(at => base + at) } : null))

	return Uint8Array.from([...header, ...meta, ...body.flat()])
}

function inputOf(bytes: Uint8Array, reads: [number, number][] = []): Input {
	return new Input({
		formats: [FLV],
		source: new CustomSource({
			getSize: () => bytes.length,
			read: (start, end) => {
				reads.push([start, end])

				return bytes.slice(start, end)
			},
			maxCacheSize: 0,
			prefetchProfile: "none"
		})
	})
}

function defined<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) {
		throw new Error("missing")
	}

	return value
}

async function sinkOf(track: Promise<InputTrack | null>): Promise<EncodedPacketSink> {
	return new EncodedPacketSink(defined(await track))
}

async function all(sink: EncodedPacketSink): Promise<EncodedPacket[]> {
	const packets: EncodedPacket[] = []

	for await (const packet of sink.packets()) {
		packets.push(packet)
	}

	return packets
}

describe("FLV demuxer", () => {
	it("reads the tracks from the sequence headers and onMetaData", async () => {
		const input = new Input({ formats: [FLV], source: new BufferSource(flv(50, 16, true)) })
		const video = await input.getPrimaryVideoTrack()
		const audio = await input.getPrimaryAudioTrack()

		expect(await input.getFormat()).toBe(FLV)
		expect(await video?.getCodec()).toBe("avc")
		expect((await video?.getDecoderConfig())?.codec).toBe("avc1.64001f")
		expect(await video?.getCodedWidth()).toBeGreaterThan(0)
		expect(await audio?.getCodec()).toBe("aac")
		expect(await audio?.getDecoderConfig()).toMatchObject({ codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 48000 })
		expect(await input.getDurationFromMetadata()).toBe(2)
	})

	it("lists every picture and audio frame in order, with key flags and timestamps", async () => {
		const input = new Input({ formats: [FLV], source: new BufferSource(flv(50, 16, true)) })
		const video = await all(await sinkOf(input.getPrimaryVideoTrack()))
		const audio = await all(await sinkOf(input.getPrimaryAudioTrack()))

		expect(video).toHaveLength(50)
		expect(video.map(packet => packet.type).filter(type => type === "key")).toHaveLength(2)
		expect(video[1]?.timestamp).toBeCloseTo(0.04, 6)
		expect(video[0]?.data.slice(0, 5)).toEqual(Uint8Array.from([0, 0, 0, 18, 0x65]))
		expect(audio.length).toBeGreaterThan(90)
		expect(audio[0]?.data).toEqual(Uint8Array.from([0x21, 0x10, 0x04]))
	})

	it("finds the key picture at or before a time, and the picture at a time", async () => {
		const input = new Input({ formats: [FLV], source: new BufferSource(flv(100, 16, true)) })
		const sink = await sinkOf(input.getPrimaryVideoTrack())

		expect((await sink.getKeyPacket(2.5))?.timestamp).toBeCloseTo(2, 6)
		expect((await sink.getPacket(3.04))?.timestamp).toBeCloseTo(3.04, 6)
		expect(await sink.getPacket(-1)).toBeNull()
	})

	it("seeks a large file without an index by interpolation, reading only around the target", async () => {
		const bytes = flv(1500, 8 * 1024, false)
		const reads: [number, number][] = []
		const input = inputOf(bytes, reads)
		const sink = await sinkOf(input.getPrimaryVideoTrack())
		const key = await sink.getKeyPacket(41.3)

		expect(key?.timestamp).toBeCloseTo(41, 6)
		expect(key?.type).toBe("key")

		const read = reads.reduce((sum, [start, end]) => sum + end - start, 0)

		expect(read).toBeLessThan(bytes.length / 2)
		expect((await sink.getNextPacket(defined(key)))?.timestamp).toBeCloseTo(41.04, 6)
	})

	it("uses onMetaData's keyframe list to seek", async () => {
		const bytes = flv(1500, 8 * 1024, true)
		const reads: [number, number][] = []
		const input = inputOf(bytes, reads)
		const sink = await sinkOf(input.getPrimaryVideoTrack())

		expect((await sink.getKeyPacket(55.9))?.timestamp).toBeCloseTo(55, 6)
		expect(reads.reduce((sum, [start, end]) => sum + end - start, 0)).toBeLessThan(bytes.length / 4)
	})

	it("survives truncated and hostile files", async () => {
		const bytes = flv(30, 16, true)

		for (const end of [9, 13, 40, 120, 400, bytes.length - 7]) {
			const input = new Input({ formats: [FLV], source: new BufferSource(bytes.slice(0, end)) })
			const tracks = await input.getTracks().catch(() => [])

			for (const track of tracks) {
				await all(new EncodedPacketSink(track)).catch(() => [])
			}
		}
	})
})
