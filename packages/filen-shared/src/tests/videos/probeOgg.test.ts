import { describe, expect, it } from "vitest"
import {
	BLOCK_BYTES,
	BlockSource,
	bytesReadRange,
	decidePlayback,
	oggHeadVideo,
	oggVideoProbe,
	oggVideoVerdict,
	probeVideo,
	type OggVideoFacts,
	type PlaybackCapabilities
} from "@filen/shared/videos"

const BOS = 0x02

function le32(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function be(value: number, bytes: number): number[] {
	return Array.from({ length: bytes }, (_, i) => Math.floor(value / 256 ** (bytes - 1 - i)) & 0xff)
}

function ascii(text: string): number[] {
	return [...text].map(char => char.charCodeAt(0))
}

// One Ogg page holding whole packets (CRC left zero: nothing here checks it).
function page(serial: number, flags: number, granule: number, packets: number[][]): number[] {
	const lacing: number[] = []

	for (const packet of packets) {
		let left = packet.length

		while (left >= 255) {
			lacing.push(255)
			left -= 255
		}

		lacing.push(left)
	}

	return [
		...ascii("OggS"),
		0,
		flags,
		...le32(granule % 0x100000000),
		...le32(Math.floor(granule / 0x100000000)),
		...le32(serial),
		...le32(0),
		...le32(0),
		lacing.length,
		...lacing,
		...packets.flat()
	]
}

// Theora identification header: 320x240 picture, 25 fps, KFGSHIFT 6.
function theoraIdent(): number[] {
	const head = [0x80, ...ascii("theora"), 3, 2, 1, ...be(20, 2), ...be(15, 2), ...be(320, 3), ...be(240, 3), 0, 0]

	head.push(...be(25, 4), ...be(1, 4), ...be(1, 3), ...be(1, 3), 0, ...be(0, 3), (6 >> 3) & 0x03, (6 & 0x07) << 5)

	return head
}

function vorbisIdent(): number[] {
	return [0x01, ...ascii("vorbis"), ...le32(0), 2, ...le32(44100), ...le32(0), ...le32(128000), ...le32(0), 0xb8, 0x01]
}

function vp8Header(): number[] {
	return [0x4f, ...ascii("VP80"), 0x01, 1, 0, ...be(640, 2), ...be(360, 2), ...be(1, 3), ...be(1, 3), ...be(30, 4), ...be(1, 4)]
}

const PICTURE = [0x00, 1, 2, 3]

// Theora + Vorbis: the BOS pages, the header pages, then `pictures` picture packets and a last page each.
function theoraFile(pictures: number, lastGranule = 250 << 6): Uint8Array {
	return Uint8Array.from([
		...page(1, BOS, 0, [theoraIdent()]),
		...page(2, BOS, 0, [vorbisIdent()]),
		...page(1, 0, 0, [
			[0x81, ...ascii("theora")],
			[0x82, ...ascii("theora"), 9, 9]
		]),
		...page(2, 0, 0, [
			[0x03, ...ascii("vorbis")],
			[0x05, ...ascii("vorbis")]
		]),
		...page(
			1,
			0,
			pictures << 6,
			Array.from({ length: pictures }, () => PICTURE)
		),
		...page(1, 0x04, lastGranule, [PICTURE]),
		...page(2, 0x04, 441000, [[0x00, 7]])
	])
}

async function probeOf(bytes: Uint8Array) {
	return probeVideo(new BlockSource(bytes.length, bytesReadRange(bytes), { maxBlockReads: 4 }), "card")
}

function caps(overrides: Partial<PlaybackCapabilities>): PlaybackCapabilities {
	return {
		browser: "chrome",
		mediaSource: true,
		audioTracks: false,
		canPlayType: {},
		isTypeSupported: {},
		decodingInfoFile: {},
		decodingInfoMediaSource: {},
		audioEncoders: [],
		...overrides
	}
}

describe("probeVideo — Ogg", () => {
	it("reads Theora and Vorbis from the beginning-of-stream pages, and the span from the last granules", async () => {
		const record = await probeOf(theoraFile(3))

		expect(record).toMatchObject({
			container: "ogg",
			index: "none",
			video: { codec: "theora", codecString: "theora", w: 320, h: 240, par: 1 },
			audio: [{ id: 2, codec: "vorbis", codecString: "vorbis", ch: 2, rate: 44100, def: true }],
			partial: false
		})
		// 250 frames at 25 fps; the Vorbis stream ends at 10 s too.
		expect(record?.durationSec).toBe(10)
	})

	it("reads VP8, Opus and FLAC headers", async () => {
		const opus = [...ascii("OpusHead"), 1, 6, 0x38, 0x01, ...le32(44100), 0, 0, 0]
		const flac = [0x7f, ...ascii("FLAC"), 1, 0, 0, 1, ...ascii("fLaC"), 0, 0, 0, 34, 0, 16, 0, 16, 0, 0, 0, 0, 0, 0, 0x0b, 0xb8, 0x03]
		const bytes = Uint8Array.from([
			...page(1, BOS, 0, [vp8Header()]),
			...page(2, BOS, 0, [opus]),
			...page(3, BOS, 0, [flac]),
			...page(2, 0x04, 48000 * 4 + 312, [[0]])
		])
		const record = await probeOf(bytes)

		expect(record?.video).toMatchObject({ codec: "vp8", codecString: "vp8", w: 640, h: 360 })
		expect(record?.audio.map(({ codec, ch, rate }) => ({ codec, ch, rate }))).toEqual([
			{ codec: "opus", ch: 6, rate: 48000 },
			{ codec: "flac", ch: 2, rate: 48000 }
		])
		expect(record?.durationSec).toBe(4)
	})

	it("survives truncated and hostile pages", async () => {
		const file = theoraFile(3)

		for (const end of [5, 27, 40, 90, file.length - 3]) {
			await expect(probeOf(file.slice(0, end))).resolves.toBeDefined()
		}

		const hostile = Uint8Array.from([
			...ascii("OggS"),
			0,
			BOS,
			...new Array<number>(20).fill(0xff),
			255,
			...new Array<number>(255).fill(255)
		])

		await expect(probeOf(hostile)).resolves.toMatchObject({ container: "ogg", video: null, audio: [] })
	})
})

describe("oggHeadVideo", () => {
	it("finds a real picture stream: two or more picture packets", () => {
		expect(oggHeadVideo(theoraFile(2))).toEqual({ codec: "theora", codecString: "theora", width: 320, height: 240 })
	})

	it("finds no video in a cover frame", () => {
		const cover = Uint8Array.from([
			...page(2, BOS, 0, [vorbisIdent()]),
			...page(1, BOS, 0, [theoraIdent()]),
			...page(1, 0, 0, [[0x81], [0x82]]),
			...page(1, 0x04, 1 << 6, [PICTURE])
		])

		expect(oggHeadVideo(cover)).toBeNull()
		expect(oggHeadVideo(Uint8Array.from(page(2, BOS, 0, [vorbisIdent()])))).toBeNull()
	})

	it("reads nothing past the bytes it is given", () => {
		const file = theoraFile(2)
		const picturesAt = file.length - 80

		expect(oggHeadVideo(file.subarray(0, picturesAt))).toBeNull()
	})

	it("counts VP8 frames, not its header packets", () => {
		const bytes = Uint8Array.from([
			...page(1, BOS, 0, [vp8Header()]),
			...page(1, 0, 0, [
				[0x4f, ...ascii("VP80"), 0x02],
				[0x10, 1],
				[0x11, 2]
			])
		])

		expect(oggHeadVideo(bytes)).toEqual({ codec: "vp8", codecString: "vp8", width: 640, height: 360 })
	})
})

describe("oggVideoVerdict", () => {
	const facts: OggVideoFacts = { codec: "theora", codecString: "theora", width: 320, height: 240 }
	const query = 'video/ogg; codecs="theora"'

	it("says video only where this browser has a rung for the stream", () => {
		expect(oggVideoVerdict(facts, caps({ browser: "firefox", canPlayType: { [query]: "maybe" } }))).toBe("video")
		expect(oggVideoVerdict(facts, caps({}))).toBeNull()
	})

	it("is the ladder's own answer: Firefox plays Ogg Theora direct, Chrome gets the container message", () => {
		const probe = { ...oggVideoProbe(facts), audio: [{ codec: "vorbis", codecString: "vorbis", channels: 2 }] }
		const both = 'video/ogg; codecs="theora,vorbis"'
		const selection = { audioIndex: 0, subtitle: "none" } as const

		expect(decidePlayback(probe, selection, caps({ browser: "firefox", canPlayType: { [both]: "probably" } })).path).toBe("direct")
		expect(decidePlayback(probe, selection, caps({})).reasons).toContain("container-unsupported")
	})
})

describe("Ogg head within one block", () => {
	it("keeps the probe's card read to the head and tail blocks", async () => {
		const reads: number[] = []
		const file = new Uint8Array(3 * BLOCK_BYTES)

		file.set(theoraFile(2))

		const source = new BlockSource(
			file.length,
			(start, end) => {
				reads.push(start / BLOCK_BYTES)

				return Promise.resolve(file.subarray(start, end))
			},
			{ maxBlockReads: 4 }
		)

		await probeVideo(source, "card")

		expect(reads).toEqual([0, 2])
	})
})
