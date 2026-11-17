import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BufferSource, CustomSource, EncodedPacketSink, Input, type EncodedPacket, type InputTrack } from "mediabunny"
import { AVI } from "@/lib/media/demux/aviDemuxer"

// h264-bframes-mp3.avi: ffmpeg's AVI writer (idx1), 2 s of 64x36 H.264 at 25 fps with B-frames (decode order I P B B
// B ...) and a key picture every 12, and 16 kbit/s MP3 at 22.05 kHz. The writer leaves one empty picture chunk in the
// first GOP, so frame 12's slot is empty and the last picture shows at frame 50, as ffmpeg itself times them.
const FIXTURE = readFileSync(join(__dirname, "fixtures", "demux", "h264-bframes-mp3.avi"))
const FRAME = 0.04

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

function inputOf(bytes: Uint8Array, reads: [number, number][] = []): Input {
	return new Input({
		formats: [AVI],
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

describe("AVI demuxer over a real file", () => {
	it("names H.264 from its parameter sets and MP3 from its format", async () => {
		const input = new Input({ formats: [AVI], source: new BufferSource(FIXTURE) })
		const video = defined(await input.getPrimaryVideoTrack())
		const audio = defined(await input.getPrimaryAudioTrack())

		expect(await input.getFormat()).toBe(AVI)
		expect(await video.getCodec()).toBe("avc")
		expect(await video.getDecoderConfig()).toMatchObject({ codedWidth: 64, codedHeight: 36 })
		expect((await video.getDecoderConfig())?.codec).toMatch(/^avc1\./)
		expect(await audio.getCodec()).toBe("mp3")
		// Numbered among the audio tracks, as the probe's audio list is, not by the stream's place in the file.
		expect([video.number, audio.number]).toEqual([1, 1])
		expect(await audio.getSampleRate()).toBe(22050)
		expect(await input.getDurationFromMetadata()).toBeCloseTo(2, 1)
	})

	it("gives B-frames their presentation times from picture order counts", async () => {
		const input = new Input({ formats: [AVI], source: new BufferSource(FIXTURE) })
		const video = await all(await sinkOf(input.getPrimaryVideoTrack()))
		const times = video.map(packet => Math.round(packet.timestamp / FRAME))

		expect(video).toHaveLength(50)
		expect(video[0]?.type).toBe("key")
		// Decode order I P B B B: the P picture shows fourth.
		expect(times.slice(0, 5)).toEqual([0, 4, 1, 2, 3])
		expect([...times].sort((a, b) => a - b)).toEqual(Array.from({ length: 51 }, (_, i) => i).filter(frame => frame !== 12))
		expect(video.filter(packet => packet.type === "key").map(packet => Math.round(packet.timestamp / FRAME))).toEqual([
			0, 13, 25, 37, 49
		])
	})

	it("re-frames MP3 one frame per packet, in time order", async () => {
		const input = new Input({ formats: [AVI], source: new BufferSource(FIXTURE) })
		const audio = await all(await sinkOf(input.getPrimaryAudioTrack()))

		expect(audio.length).toBeGreaterThan(30)

		for (const [i, packet] of audio.entries()) {
			expect(packet.data[0]).toBe(0xff)

			if (i > 0) {
				expect(packet.timestamp).toBeCloseTo((audio[i - 1]?.timestamp ?? 0) + (audio[i - 1]?.duration ?? 0), 6)
			}
		}
	})

	it("seeks through idx1 to the key picture at or before a time", async () => {
		const input = inputOf(FIXTURE)
		const sink = await sinkOf(input.getPrimaryVideoTrack())
		const key = await sink.getKeyPacket(1.1)

		expect(key?.timestamp).toBeCloseTo(1, 6)
		expect(key?.type).toBe("key")
		expect(Math.round(defined(await sink.getPacket(1.3)).timestamp / FRAME)).toBe(Math.round(1.28 / FRAME))
	})
})

// ── A synthetic OpenDML file ──

const encoder = new TextEncoder()

function le(value: number, bytes: number): number[] {
	return Array.from({ length: bytes }, (_, i) => Math.floor(value / 256 ** i) & 0xff)
}

function chunk(id: string, data: number[]): number[] {
	return [...encoder.encode(id), ...le(data.length, 4), ...data, ...(data.length % 2 === 1 ? [0] : [])]
}

function list(type: string, ...children: number[][]): number[] {
	return chunk("LIST", [...encoder.encode(type), ...children.flat()])
}

const FRAMES = 50
const KEY_EVERY = 10
// PCM, 8 kHz mono 16-bit: two chunks of 160 samples per picture.
const AUDIO_CHUNK = 320

// A super index of one stream: its standard indexes' positions, sizes and durations.
function superIndex(stream: string, entries: [number, number, number][]): number[] {
	return chunk("indx", [
		...le(4, 2),
		0,
		0,
		...le(entries.length, 4),
		...encoder.encode(stream),
		...le(0, 12),
		...entries.flatMap(([offset, size, duration]) => [...le(offset, 8), ...le(size, 4), ...le(duration, 4)])
	])
}

function standardIndex(id: string, stream: string, base: number, entries: [number, number, boolean][]): number[] {
	return chunk(id, [
		...le(2, 2),
		0,
		1,
		...le(entries.length, 4),
		...encoder.encode(stream),
		...le(base, 8),
		...le(0, 4),
		...entries.flatMap(([offset, size, key]) => [...le(offset, 4), ...le(size + (key ? 0 : 0x80000000), 4)])
	])
}

function openDml(): Uint8Array {
	// Built twice: the first pass finds where everything lands, the second writes the indexes with those positions.
	let layout: { video: number[]; audio: number[]; ix: number[] } = { video: [], audio: [], ix: [0, 0, 0] }
	let bytes: number[] = []

	for (let pass = 0; pass < 2; pass++) {
		const strh = (type: string, scale: number, rate: number, length: number, sampleSize: number) =>
			chunk("strh", [
				...encoder.encode(type),
				...le(0, 4),
				...le(0, 12),
				...le(scale, 4),
				...le(rate, 4),
				...le(0, 4),
				...le(length, 4),
				...le(0, 8),
				...le(sampleSize, 4),
				...le(0, 8)
			])
		const videoIndex = superIndex("00dc", [
			[layout.ix[0] ?? 0, 32 + 8 * 25, 25],
			[layout.ix[1] ?? 0, 32 + 8 * 25, 25]
		])
		const audioIndex = superIndex("01wb", [[layout.ix[2] ?? 0, 32 + 8 * FRAMES * 2, FRAMES * 2 * 160]])
		const hdrl = list(
			"hdrl",
			chunk("avih", [...le(40000, 4), ...le(0, 8), ...le(0, 4), ...le(0, 40)]),
			list(
				"strl",
				strh("vids", 1, 25, FRAMES, 0),
				chunk("strf", [
					...le(40, 4),
					...le(64, 4),
					...le(36, 4),
					...le(1, 2),
					...le(24, 2),
					...encoder.encode("XVID"),
					...le(0, 20)
				]),
				videoIndex
			),
			list(
				"strl",
				strh("auds", 1, 8000, FRAMES * 320, 2),
				chunk("strf", [...le(1, 2), ...le(1, 2), ...le(8000, 4), ...le(16000, 4), ...le(2, 2), ...le(16, 2)]),
				audioIndex
			)
		)
		const head = [...encoder.encode("AVI "), ...hdrl]
		// RIFF id and size, then the head ("AVI " included), then the movi list's id, size and type.
		const moviStart = 8 + head.length + 12
		const body: number[] = []
		const video: number[] = []
		const audio: number[] = []

		for (let frame = 0; frame < FRAMES; frame++) {
			video.push(moviStart + body.length)
			body.push(...chunk("00dc", [frame, ...new Array<number>(15).fill(frame)]))

			for (let half = 0; half < 2; half++) {
				audio.push(moviStart + body.length)
				body.push(...chunk("01wb", new Array<number>(AUDIO_CHUNK).fill(frame)))
			}
		}

		const movi = list("movi", ...[body])
		const ixStart = 8 + head.length + movi.length
		const ix0 = standardIndex(
			"ix00",
			"00dc",
			0,
			video.slice(0, 25).map((at, i) => [at + 8, 16, i % KEY_EVERY === 0])
		)
		const ix1 = standardIndex(
			"ix00",
			"00dc",
			0,
			video.slice(25).map((at, i) => [at + 8, 16, (i + 25) % KEY_EVERY === 0])
		)
		const ix2 = standardIndex(
			"ix01",
			"01wb",
			0,
			audio.map(at => [at + 8, AUDIO_CHUNK, true])
		)

		layout = { video, audio, ix: [ixStart, ixStart + ix0.length, ixStart + ix0.length + ix1.length] }

		const riff = [...head, ...movi, ...ix0, ...ix1, ...ix2]

		bytes = [...encoder.encode("RIFF"), ...le(riff.length, 4), ...riff]
	}

	return Uint8Array.from(bytes)
}

describe("AVI demuxer over an OpenDML index", () => {
	it("seeks through the standard index covering a time, and times audio by its byte count", async () => {
		const bytes = openDml()
		const input = inputOf(bytes)
		const video = await sinkOf(input.getPrimaryVideoTrack())
		const audio = await sinkOf(input.getPrimaryAudioTrack())
		const picture = defined(await video.getPacket(1.5))

		expect(picture.timestamp).toBeCloseTo(1.48, 6)
		expect(picture.data[0]).toBe(37)

		const sound = defined(await audio.getPacket(1.5))

		expect(sound.timestamp).toBeCloseTo(1.5, 6)
		expect(sound.data[0]).toBe(37)
		expect((await video.getNextPacket(picture))?.timestamp).toBeCloseTo(1.52, 6)
	})

	it("seeks with no more than three reads once open: the standard index, the run of chunks there, the picture", async () => {
		const reads: [number, number][] = []
		const input = inputOf(openDml(), reads)
		const video = await sinkOf(input.getPrimaryVideoTrack())

		await video.getFirstPacket()

		const opened = reads.length

		expect((await video.getKeyPacket(1.5))?.timestamp).toBeCloseTo(1.48, 6)
		expect(reads.length - opened).toBeLessThanOrEqual(3)
	})

	it("survives truncation", async () => {
		const bytes = openDml()

		for (const end of [12, 40, 200, 600, bytes.length - 100]) {
			const input = new Input({ formats: [AVI], source: new BufferSource(bytes.slice(0, end)) })
			const tracks = await input.getTracks().catch(() => [])

			for (const track of tracks) {
				await all(new EncodedPacketSink(track)).catch(() => [])
			}
		}
	})
})

describe("AVI demuxer over a large MP3 chunk", () => {
	it("keeps every frame of a chunk holding more frames than a unit has parts", async () => {
		const FRAME_COUNT = 4200
		// MPEG-1 layer III, 32 kbit/s at 44.1 kHz: 104-byte frames of 1152 samples.
		const frame = [0xff, 0xfb, 0x10, 0x00, ...new Array<number>(100).fill(0)]
		const strh = chunk("strh", [
			...encoder.encode("auds"),
			...le(0, 4),
			...le(0, 12),
			...le(1152, 4),
			...le(44100, 4),
			...le(0, 4),
			...le(FRAME_COUNT, 4),
			...le(0, 8),
			...le(0, 4),
			...le(0, 8)
		])
		const strf = chunk("strf", [...le(0x55, 2), ...le(2, 2), ...le(44100, 4), ...le(4000, 4), ...le(1, 2), ...le(0, 2)])
		const hdrl = list("hdrl", chunk("avih", [...le(0, 4), ...le(0, 8), ...le(0, 4), ...le(0, 40)]), list("strl", strh, strf))
		const movi = list("movi", chunk("00wb", Array.from({ length: FRAME_COUNT }, () => frame).flat()))
		const riff = [...encoder.encode("AVI "), ...hdrl, ...movi]
		const input = new Input({
			formats: [AVI],
			source: new BufferSource(Uint8Array.from([...encoder.encode("RIFF"), ...le(riff.length, 4), ...riff]))
		})
		const packets = await all(await sinkOf(input.getPrimaryAudioTrack()))
		const seconds = packets.reduce((sum, packet) => sum + packet.duration, 0)

		expect(packets.length).toBeGreaterThan(4000)
		expect(seconds).toBeCloseTo((FRAME_COUNT * 1152) / 44100, 3)
		expect(packets.reduce((sum, packet) => sum + packet.data.length, 0)).toBe(FRAME_COUNT * frame.length)
	})
})

describe("AVI demuxer over a long all-intra idx1", () => {
	it("seeks through a key index it thinned past its cap, reading only around the target after the index", async () => {
		// Two hours and sixteen minutes of 25 fps pictures, every one a key picture, as 200-byte chunks under idx1: far
		// more than reading forward to a time in the middle would take.
		const COUNT = 25 * 8200
		const PICTURE = 200
		const strh = chunk("strh", [
			...encoder.encode("vids"),
			...le(0, 4),
			...le(0, 12),
			...le(1, 4),
			...le(25, 4),
			...le(0, 4),
			...le(COUNT, 4),
			...le(0, 8),
			...le(0, 4),
			...le(0, 8)
		])
		const strf = chunk("strf", [
			...le(40, 4),
			...le(64, 4),
			...le(36, 4),
			...le(1, 2),
			...le(24, 2),
			...encoder.encode("XVID"),
			...le(0, 20)
		])
		const head = [...encoder.encode("AVI "), ...list("hdrl", chunk("avih", le(0, 56)), list("strl", strh, strf))]
		const moviHeader = 12
		const moviBody = COUNT * (8 + PICTURE)
		const total = head.length + moviHeader + moviBody + 8 + COUNT * 16
		const bytes = new Uint8Array(8 + total)
		const view = new DataView(bytes.buffer)
		bytes.set([...encoder.encode("RIFF"), ...le(total, 4), ...head], 0)

		let at = 8 + head.length

		bytes.set([...encoder.encode("LIST"), ...le(4 + moviBody, 4), ...encoder.encode("movi")], at)

		at += moviHeader

		for (let frame = 0; frame < COUNT; frame++) {
			bytes.set(encoder.encode("00dc"), at)
			view.setUint32(at + 4, PICTURE, true)
			view.setUint16(at + 8, frame & 0xffff, true)
			at += 8 + PICTURE
		}

		bytes.set([...encoder.encode("idx1"), ...le(COUNT * 16, 4)], at)
		at += 8

		for (let frame = 0; frame < COUNT; frame++, at += 16) {
			bytes.set(encoder.encode("00dc"), at)
			view.setUint32(at + 4, 0x10, true)
			view.setUint32(at + 8, 4 + frame * (8 + PICTURE), true)
			view.setUint32(at + 12, PICTURE, true)
		}

		const reads: [number, number][] = []
		const sink = await sinkOf(inputOf(bytes, reads).getPrimaryVideoTrack())
		const key = defined(await sink.getKeyPacket(5000.5))

		const moviStart = 8 + head.length + moviHeader
		const chunkAt = (frame: number): number => moviStart + frame * (8 + PICTURE)

		expect(key.timestamp).toBeCloseTo(5000.48, 6)
		// Past 8192 positions the index keeps one every two seconds: reading starts at the even second, not at the
		// picture an index of every key picture would name.
		expect(reads.some(([start]) => start === chunkAt(125_000))).toBe(true)
		expect(reads.some(([start]) => start === chunkAt(125_012))).toBe(false)
		expect(new DataView(key.data.buffer, key.data.byteOffset).getUint16(0, true)).toBe(Math.round(key.timestamp * 25) & 0xffff)

		const idx1Start = 8 + head.length + moviHeader + moviBody
		const outsideIndex = reads.filter(([start]) => start < idx1Start).reduce((sum, [start, end]) => sum + end - start, 0)

		expect(outsideIndex).toBeLessThan(1024 * 1024)
	})
})
