import { describe, expect, it } from "vitest"
import { BLOCK_BYTES, BlockSource, bytesReadRange, probeVideo, type VideoProbe } from "@filen/shared/videos"

const encoder = new TextEncoder()

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
	const arrays = parts.map(part => (part instanceof Uint8Array ? part : Uint8Array.from(part)))
	const out = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0))
	let offset = 0

	for (const part of arrays) {
		out.set(part, offset)
		offset += part.length
	}

	return out
}

function text(value: string): Uint8Array {
	return encoder.encode(value)
}

function le(value: number, bytes: number): number[] {
	return Array.from({ length: bytes }, (_, i) => Math.floor(value / 256 ** i) & 0xff)
}

function be(value: number, bytes: number): number[] {
	return le(value, bytes).reverse()
}

function f64(value: number): number[] {
	const bytes = new Uint8Array(8)

	new DataView(bytes.buffer).setFloat64(0, value)

	return [...bytes]
}

async function probe(bytes: Uint8Array, maxBlockReads = 4): Promise<VideoProbe | null> {
	return probeVideo(new BlockSource(bytes.length, bytesReadRange(bytes), { maxBlockReads }), "card")
}

// x264 High@L3.1: its SPS, and the avcC holding it.
const SPS = [
	0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50, 0x05, 0xbb, 0x01, 0x10, 0x00, 0x00, 0x03, 0x00, 0x10, 0x00, 0x00, 0x03, 0x03, 0x00,
	0xf1, 0x83, 0x19, 0x60
]
const PPS = [0x68, 0xef, 0x89, 0xcb]
const AVCC = [0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, ...be(SPS.length, 2), ...SPS, 0x01, ...be(PPS.length, 2), ...PPS]

// ── AVI ──

function riffChunk(id: string, data: Uint8Array | number[]): Uint8Array {
	const body = data instanceof Uint8Array ? data : Uint8Array.from(data)

	return concat(text(id), le(body.length, 4), body, body.length % 2 === 1 ? [0] : [])
}

function riffList(type: string, ...children: Uint8Array[]): Uint8Array {
	return riffChunk("LIST", concat(text(type), ...children))
}

function strh(type: string, handler: string, scale: number, rate: number, length: number): Uint8Array {
	return riffChunk(
		"strh",
		concat(text(type), text(handler), new Uint8Array(12), le(scale, 4), le(rate, 4), le(0, 4), le(length, 4), new Uint8Array(20))
	)
}

function bitmapInfo(fourcc: string, width: number, height: number): number[] {
	return [...le(40, 4), ...le(width, 4), ...le(height, 4), ...le(1, 2), ...le(24, 2), ...text(fourcc), ...new Array<number>(20).fill(0)]
}

function waveFormat(tag: number, channels: number, rate: number, extra: number[] = []): number[] {
	return [...le(tag, 2), ...le(channels, 2), ...le(rate, 4), ...le(0, 4), ...le(0, 2), ...le(16, 2), ...le(extra.length, 2), ...extra]
}

function avi(video: string, withSps: boolean, flags = 0x10): Uint8Array {
	const avih = riffChunk("avih", concat(le(40000, 4), new Uint8Array(8), le(flags, 4), new Uint8Array(40)))
	const hdrl = riffList(
		"hdrl",
		avih,
		riffList("strl", strh("vids", video, 1, 25, 250), riffChunk("strf", bitmapInfo(video, 640, 360))),
		riffList(
			"strl",
			strh("auds", "\0\0\0\0", 1, 48000, 480000),
			riffChunk("strf", waveFormat(0x55, 2, 48000)),
			riffChunk("strn", text("Commentary\0"))
		)
	)
	const picture = withSps ? [0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, ...SPS, 0, 0, 0, 1, ...PPS] : [0, 0, 0, 1, 0x65, 0x88]
	const movi = riffList("movi", riffChunk("01wb", new Uint8Array(32)), riffChunk("00dc", picture))
	const body = concat(text("AVI "), hdrl, movi)

	return concat(text("RIFF"), le(body.length, 4), body)
}

describe("probeVideo — AVI", () => {
	it("reads the stream headers, an in-band SPS and the index flag", async () => {
		expect(await probe(avi("H264", true))).toMatchObject({
			container: "avi",
			durationSec: 10,
			index: "idx",
			video: { codec: "h264", fourcc: "H264", codecString: "avc1.64001f", w: 640, h: 360 },
			audio: [{ id: 1, codec: "mp3", codecString: "mp4a.6B", ch: 2, rate: 48000, name: "Commentary", def: true }],
			partial: false
		})
	})

	it("names MPEG-4 Part 2 and leaves an H.264 stream without an SPS unnamed by string", async () => {
		expect((await probe(avi("XVID", false, 0)))?.video).toMatchObject({ codec: "mpeg4", codecString: null })
		expect(await probe(avi("XVID", false, 0))).toMatchObject({ index: "none" })
		expect((await probe(avi("avc1", false)))?.video).toMatchObject({ codec: "h264", codecString: null })
	})

	it("survives truncation", async () => {
		const file = avi("H264", true)

		for (const end of [12, 20, 40, 100, file.length - 10]) {
			await expect(probe(file.slice(0, end))).resolves.not.toThrow()
		}
	})
})

// ── FLV ──

function flvTag(type: number, timestamp: number, data: number[]): number[] {
	return [type, ...be(data.length, 3), ...be(timestamp & 0xffffff, 3), timestamp >>> 24, 0, 0, 0, ...data, ...be(11 + data.length, 4)]
}

function amfString(value: string): number[] {
	return [...be(value.length, 2), ...text(value)]
}

function flv(withMetaData: boolean): Uint8Array {
	const meta = [
		0x02,
		...amfString("onMetaData"),
		0x08,
		...be(4, 4),
		...amfString("duration"),
		0x00,
		...f64(12.5),
		...amfString("width"),
		0x00,
		...f64(640),
		...amfString("height"),
		0x00,
		...f64(360),
		...amfString("keyframes"),
		0x03,
		...amfString("times"),
		0x0a,
		...be(2, 4),
		0x00,
		...f64(0),
		0x00,
		...f64(2),
		0,
		0,
		0x09,
		0,
		0,
		0x09
	]

	return concat(
		text("FLV"),
		[1, 0x05, ...be(9, 4), 0, 0, 0, 0],
		withMetaData ? flvTag(18, 0, meta) : [],
		flvTag(9, 0, [0x17, 0, 0, 0, 0, ...AVCC]),
		flvTag(8, 0, [0xaf, 0, 0x11, 0x90]),
		flvTag(9, 9_000, [0x27, 1, 0, 0, 0, 1, 2, 3])
	)
}

describe("probeVideo — FLV", () => {
	it("reads onMetaData and the sequence headers", async () => {
		expect(await probe(flv(true))).toMatchObject({
			container: "flv",
			durationSec: 12.5,
			index: "keyframes",
			video: { codec: "h264", codecString: "avc1.64001f", w: 640, h: 360 },
			audio: [{ codec: "aac", codecString: "mp4a.40.2", ch: 2, rate: 48000 }],
			partial: false
		})
	})

	it("times a file without onMetaData by its last tag", async () => {
		expect(await probe(flv(false))).toMatchObject({ durationSec: 9, index: "none", video: { codec: "h264" } })
	})

	it("names Sorenson H.263 and VP6, which no browser decodes", async () => {
		const file = concat(text("FLV"), [1, 0x01, ...be(9, 4), 0, 0, 0, 0], flvTag(9, 0, [0x12, 1, 2]))

		expect((await probe(file))?.video).toMatchObject({ codec: "h263", codecString: null })
	})

	it("survives hostile metadata", async () => {
		const file = flv(true)

		for (const end of [9, 20, 40, 60, 90]) {
			await expect(probe(file.slice(0, end))).resolves.not.toThrow()
		}

		const deep = concat(
			text("FLV"),
			[1, 0x01, ...be(9, 4), 0, 0, 0, 0],
			flvTag(18, 0, [0x02, ...amfString("onMetaData"), ...new Array<number>(64).fill(0x0a)])
		)

		await expect(probe(deep)).resolves.toMatchObject({ container: "flv" })
	})
})

// ── ASF ──

function guid(hex: string): number[] {
	return (hex.match(/../g) ?? []).map(pair => Number.parseInt(pair, 16))
}

function asfObject(id: string, data: number[]): number[] {
	return [...guid(id), ...le(24 + data.length, 8), ...data]
}

function streamProperties(type: string, number: number, specific: number[]): number[] {
	return asfObject("9107dcb7b7a9cf118ee600c00c205365", [
		...guid(type),
		...new Array<number>(16).fill(0),
		...le(0, 8),
		...le(specific.length, 4),
		...le(0, 4),
		...le(number, 2),
		...le(0, 4),
		...specific
	])
}

function asf(withIndex: boolean): Uint8Array {
	const fileProperties = asfObject("a1dcab8c47a9cf118ee400c00c205365", [
		...new Array<number>(40).fill(0),
		...le(1_230_000_000, 8),
		...le(0, 8),
		...le(3000, 8),
		...le(2, 4),
		...le(0, 12)
	])
	const audio = streamProperties("409e69f84d5bcf11a8fd00805f5c442b", 1, waveFormat(0x161, 2, 44100))
	const video = streamProperties("c0ef19bc4d5bcf11a8fd00805f5c442b", 2, [
		...le(1280, 4),
		...le(720, 4),
		2,
		...le(40, 2),
		...bitmapInfo("WMV3", 1280, 720)
	])
	const children = [...fileProperties, ...video, ...audio]
	const header = asfObject("3026b2758e66cf11a6d900aa0062ce6c", [...le(3, 4), 1, 2, ...children])
	const data = asfObject("3626b2758e66cf11a6d900aa0062ce6c", new Array<number>(50).fill(0))

	return concat(header, data, withIndex ? asfObject("90080033b1e5cf1189f400a0c90349cb", new Array<number>(8).fill(0)) : [])
}

describe("probeVideo — ASF", () => {
	it("reads the file and stream properties, and finds the simple index", async () => {
		expect(await probe(asf(true))).toMatchObject({
			container: "asf",
			durationSec: 120,
			index: "simple",
			video: { codec: "wmv", fourcc: "WMV3", codecString: null, w: 1280, h: 720 },
			audio: [{ id: 1, codec: "wma", codecString: null, ch: 2, rate: 44100 }],
			partial: false
		})
		expect(await probe(asf(false))).toMatchObject({ index: "none" })
	})

	it("survives truncation", async () => {
		const file = asf(true)

		for (const end of [16, 30, 60, 120, file.length - 20]) {
			await expect(probe(file.slice(0, end))).resolves.not.toThrow()
		}
	})
})

// ── MPEG-PS ──

function pts(value: number, marker: number): number[] {
	return [
		(marker << 4) | (Math.floor(value / 2 ** 30) << 1) | 1,
		(value >> 22) & 0xff,
		(((value >> 15) & 0x7f) << 1) | 1,
		(value >> 7) & 0xff,
		((value & 0x7f) << 1) | 1
	]
}

function pack(): number[] {
	return [0, 0, 1, 0xba, 0x44, 0, 4, 0, 4, 1, 0x01, 0x89, 0xc3, 0xf8]
}

function pes(id: number, time: number, payload: number[]): number[] {
	const header = [0x80, 0x80, 5, ...pts(time, 2)]

	return [0, 0, 1, id, ...be(header.length + payload.length, 2), ...header, ...payload]
}

function sequenceHeader(extension: boolean): number[] {
	return [0, 0, 1, 0xb3, 0x2d, 0x02, 0x40, 0x24, 0xff, 0xff, 0xe0, 0x18, ...(extension ? [0, 0, 1, 0xb5, 0x14, 0x8a, 0, 1, 0, 0] : [])]
}

function mpegPs(extension: boolean, length = 0): Uint8Array {
	const head = [
		...pack(),
		...pes(0xe0, 90_000, sequenceHeader(extension)),
		...pes(0xc0, 90_000, [0xff, 0xfd, 0x90, 0x00, 0, 0]),
		...pes(0xbd, 90_000, [0x80, 1, 0, 1, 0x0b, 0x77, 0, 0, 0x14, 0x40, 0xe0, 0])
	]
	const tail = [...pack(), ...pes(0xe0, 90_000 + 90_000 * 60, [0, 0, 1, 0])]
	const out = new Uint8Array(Math.max(length, head.length + tail.length))

	out.set(head)
	out.set(tail, out.length - tail.length)

	return out
}

describe("probeVideo — MPEG-PS", () => {
	it("names MPEG-2 video, MPEG audio by layer and AC-3 in private stream 1, and spans the PTS head to tail", async () => {
		const record = await probe(mpegPs(true))

		expect(record).toMatchObject({
			container: "ps",
			durationSec: 60,
			index: "none",
			video: { codec: "mpeg2", w: 720, h: 576 }
		})
		expect(record?.audio.map(({ codec, rate }) => ({ codec, rate }))).toEqual([
			{ codec: null, rate: 44100 },
			{ codec: "ac3", rate: 48000 }
		])
	})

	it("tells MPEG-1 video by its missing sequence extension, and reads a tail blocks away", async () => {
		expect((await probe(mpegPs(false, 3 * BLOCK_BYTES)))?.video?.codec).toBe("mpeg1")
		expect(await probe(mpegPs(false, 3 * BLOCK_BYTES))).toMatchObject({ durationSec: 60 })
	})

	it("survives truncation", async () => {
		const file = mpegPs(true)

		for (const end of [4, 14, 20, 40, file.length - 7]) {
			await expect(probe(file.slice(0, end))).resolves.not.toThrow()
		}
	})
})
