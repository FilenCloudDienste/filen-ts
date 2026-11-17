import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { BufferSource, EncodedPacketSink, Input, type EncodedPacket, type InputTrack } from "mediabunny"
import { ASF } from "@/lib/media/demux/asfDemuxer"
import { MPEG_PS } from "@/lib/media/demux/mpegPsDemuxer"

// Both written by ffmpeg from 2 s of 64x36 H.264 at 25 fps with B-frames (decode order I P B B ...) and a key picture
// every 12: h264-mp3.asf with 16 kbit/s MP3 at 22.05 kHz, its objects timed by decode time only; h264-ac3.vob with
// AC-3 at 48 kHz in private stream 1, several pictures to a PES and a PTS on the first only.
const ASF_FILE = readFileSync(join(__dirname, "fixtures", "demux", "h264-mp3.asf"))
const PS_FILE = readFileSync(join(__dirname, "fixtures", "demux", "h264-ac3.vob"))
const FRAME = 0.04

function defined<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) {
		throw new Error("missing")
	}

	return value
}

async function all(track: Promise<InputTrack | null>): Promise<EncodedPacket[]> {
	const packets: EncodedPacket[] = []

	for await (const packet of new EncodedPacketSink(defined(await track)).packets()) {
		packets.push(packet)
	}

	return packets
}

function frames(packets: EncodedPacket[]): number[] {
	return packets.map(packet => Math.round(packet.timestamp / FRAME))
}

describe("ASF demuxer", () => {
	const input = (): Input => new Input({ formats: [ASF], source: new BufferSource(ASF_FILE) })

	it("names H.264 from its first key picture and MP3 from its format", async () => {
		const file = input()
		const video = defined(await file.getPrimaryVideoTrack())
		const audio = defined(await file.getPrimaryAudioTrack())

		expect(await file.getFormat()).toBe(ASF)
		expect(await video.getCodec()).toBe("avc")
		expect(await video.getDecoderConfig()).toMatchObject({ codedWidth: 64, codedHeight: 36 })
		expect(await audio.getCodec()).toBe("mp3")
		expect(await file.getDurationFromMetadata()).toBeGreaterThan(1.9)
	})

	it("reassembles every picture, timed by picture order count, and every MP3 frame", async () => {
		const video = await all(input().getPrimaryVideoTrack())
		const audio = await all(input().getPrimaryAudioTrack())
		const times = frames(video)

		expect(video).toHaveLength(50)
		expect(times.slice(0, 4)).toEqual([0, 3, 1, 2])
		expect(new Set(times).size).toBe(50)
		expect(video[0]?.type).toBe("key")
		expect(audio.length).toBeGreaterThan(30)
		expect(audio.every(packet => packet.data[0] === 0xff)).toBe(true)
	})

	it("finds the key picture at or before a time", async () => {
		const sink = new EncodedPacketSink(defined(await input().getPrimaryVideoTrack()))
		const key = defined(await sink.getKeyPacket(1.1))

		expect(key.type).toBe("key")
		expect(key.timestamp).toBeLessThanOrEqual(1.1)
		expect(key.timestamp).toBeGreaterThan(0.4)
	})

	it("survives truncation", async () => {
		for (const end of [16, 40, 400, 3000, ASF_FILE.length - 100]) {
			const file = new Input({ formats: [ASF], source: new BufferSource(ASF_FILE.subarray(0, end)) })

			for (const track of await file.getTracks().catch(() => [])) {
				await all(Promise.resolve(track)).catch(() => [])
			}
		}
	})
})

describe("MPEG program stream demuxer", () => {
	const input = (): Input => new Input({ formats: [MPEG_PS], source: new BufferSource(PS_FILE) })

	it("names H.264 and AC-3", async () => {
		const file = input()
		const video = defined(await file.getPrimaryVideoTrack())
		const audio = defined(await file.getPrimaryAudioTrack())

		expect(await file.getFormat()).toBe(MPEG_PS)
		expect(await video.getCodec()).toBe("avc")
		expect(await video.getDecoderConfig()).toMatchObject({ codedWidth: 64, codedHeight: 36 })
		expect(await audio.getCodec()).toBe("ac3")
		expect(await audio.getSampleRate()).toBe(48000)
		expect(await file.getDurationFromMetadata()).toBeGreaterThan(1.5)
	})

	it("cuts the pictures apart however they were packed, timed from the PTS and picture order counts", async () => {
		const video = await all(input().getPrimaryVideoTrack())
		const times = frames(video)

		expect(video).toHaveLength(50)
		expect(new Set(times).size).toBe(50)
		expect(Math.max(...times) - Math.min(...times)).toBe(49)
		expect(video[0]?.type).toBe("key")
		expect(video.every(packet => packet.data[0] === 0 && packet.data[1] === 0)).toBe(true)
	})

	it("cuts AC-3 into its frames, 32 ms apart", async () => {
		const audio = await all(input().getPrimaryAudioTrack())

		expect(audio.length).toBeGreaterThan(55)

		for (const [i, packet] of audio.entries()) {
			expect([packet.data[0], packet.data[1]]).toEqual([0x0b, 0x77])

			if (i > 0) {
				expect(packet.timestamp - (audio[i - 1]?.timestamp ?? 0)).toBeCloseTo(0.032, 6)
			}
		}
	})

	it("survives truncation", async () => {
		for (const end of [4, 14, 100, 2048, PS_FILE.length - 100]) {
			const file = new Input({ formats: [MPEG_PS], source: new BufferSource(PS_FILE.subarray(0, end)) })

			for (const track of await file.getTracks().catch(() => [])) {
				await all(Promise.resolve(track)).catch(() => [])
			}
		}
	})
})

// ── E-AC-3 with dependent substreams, in packs built by hand ──

function ptsField(value: number): number[] {
	return [
		0x21 | (Math.floor(value / 2 ** 30) << 1),
		(value >> 22) & 0xff,
		(((value >> 15) & 0x7f) << 1) | 1,
		(value >> 7) & 0xff,
		((value & 0x7f) << 1) | 1
	]
}

// An MPEG-2 pack header, then a private stream 1 PES of AC-3 sub-stream 0x80 holding `data`, with a PTS.
function privatePack(pts: number, data: number[]): number[] {
	const header = [0x80, 0x80, 5, ...ptsField(pts)]
	const payload = [0x80, 1, 0, 1, ...data]
	const length = header.length + payload.length

	return [0, 0, 1, 0xba, 0x44, 0, 4, 0, 4, 1, 0x01, 0x89, 0xc3, 0xf8, 0, 0, 1, 0xbd, length >> 8, length & 0xff, ...header, ...payload]
}

// A 64-byte E-AC-3 frame at 48 kHz, six blocks of 256 samples, 5.1 (bsid 16): an independent one, or a dependent one
// (stream type 1) carrying the channels past 5.1.
function eac3Frame(dependent: boolean): number[] {
	const frame = new Array<number>(64).fill(0)

	frame.splice(0, 6, 0x0b, 0x77, dependent ? 0x40 : 0x00, 31, (3 << 4) | (7 << 1) | 1, 16 << 3)

	return frame
}

describe("MPEG program stream demuxer over E-AC-3 with dependent substreams", () => {
	it("keeps each independent frame with its dependent one in one packet, 32 ms apart", async () => {
		const unit = [...eac3Frame(false), ...eac3Frame(true)]
		const bytes = Uint8Array.from(Array.from({ length: 10 }, (_, i) => privatePack(90_000 + i * 2 * 2880, [...unit, ...unit])).flat())
		const audio = await all(new Input({ formats: [MPEG_PS], source: new BufferSource(bytes) }).getPrimaryAudioTrack())

		expect(audio.length).toBeGreaterThanOrEqual(18)

		for (const [i, packet] of audio.entries()) {
			expect(packet.data.length).toBe(128)
			expect(packet.data[2]).toBe(0x00)
			expect(packet.data[66]).toBe(0x40)

			if (i > 0) {
				expect(packet.timestamp - (audio[i - 1]?.timestamp ?? 0)).toBeCloseTo(0.032, 6)
			}
		}
	})
})
