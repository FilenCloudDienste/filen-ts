import { describe, expect, it, vi } from "vitest"
import {
	SIMPLE_BLOCK_CUE_SECONDS,
	TextTap,
	embeddedCueCharge,
	isTapTextCodec,
	type TextTapCue,
	type TextTapTrack
} from "@/workers/remux/textTap"

// Builds Matroska bytes by hand: element = ID bytes, an 8-byte size, the payload.
function element(id: number[], payload: Uint8Array | number[]): Uint8Array {
	const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload)
	const size = [0x01, 0, 0, 0, 0, 0, 0, 0]
	let rest = data.length

	for (let i = 7; i >= 1; i--) {
		size[i] = rest & 0xff
		rest = Math.floor(rest / 256)
	}

	return concat([new Uint8Array(id), new Uint8Array(size), data])
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

// Track number (1-byte vint), int16 timestamp relative to the cluster, flags, frame.
function blockPayload(track: number, relative: number, frame: Uint8Array): Uint8Array {
	return concat([new Uint8Array([0x80 | track, (relative >> 8) & 0xff, relative & 0xff, 0x00]), frame])
}

function cluster(timestamp: number, children: Uint8Array[]): Uint8Array {
	return element([0x1f, 0x43, 0xb6, 0x75], concat([element([0xe7], [(timestamp >> 8) & 0xff, timestamp & 0xff]), ...children]))
}

const simpleBlock = (track: number, relative: number, frame: Uint8Array): Uint8Array =>
	element([0xa3], blockPayload(track, relative, frame))

const blockGroup = (track: number, relative: number, frame: Uint8Array, duration: number): Uint8Array =>
	element(
		[0xa0],
		concat([element([0xa1], blockPayload(track, relative, frame)), element([0x9b], [(duration >> 8) & 0xff, duration & 0xff])])
	)

const SRT: TextTapTrack = { number: 3, codecId: "S_TEXT/UTF8", compression: null }
const ASS: TextTapTrack = { number: 4, codecId: "S_TEXT/ASS", compression: null }

function tap(tracks: TextTapTrack[], blockBytes: number, charBudget?: number) {
	const cues: TextTapCue[] = []
	const instance = new TextTap({
		tracks,
		timestampScale: 1_000_000,
		blockBytes,
		...(charBudget === undefined ? {} : { charBudget }),
		emit: batch => {
			cues.push(...batch)
		}
	})

	return { instance, cues }
}

// Hands the file over in blocks of `size`, in the given order.
function feed(instance: TextTap, bytes: Uint8Array, size: number, order?: number[]): void {
	const count = Math.ceil(bytes.length / size)
	const indices = order ?? Array.from({ length: count }, (_, index) => index)

	for (const index of indices) {
		instance.addBlock(index, bytes.subarray(index * size, Math.min(bytes.length, (index + 1) * size)))
	}
}

async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await new Promise(resolve => setTimeout(resolve, 0))
	}
}

const VIDEO_FRAME = new Uint8Array(300).fill(7)

const FILE = concat([
	cluster(1000, [
		simpleBlock(1, 0, VIDEO_FRAME),
		blockGroup(3, 500, text("Hello <i>there</i>"), 2000),
		simpleBlock(1, 40, VIDEO_FRAME),
		simpleBlock(4, 1000, text("0,0,Default,,0,0,0,,{\\an8}Top line"))
	]),
	cluster(5000, [simpleBlock(1, 0, VIDEO_FRAME), simpleBlock(3, 200, text("Second & cue")), simpleBlock(2, 0, text("audio"))])
])

describe("TextTap", () => {
	it("takes the text tracks' blocks from clusters spread over many blocks, and nothing else", async () => {
		const { instance, cues } = tap([SRT, ASS], 128)

		feed(instance, FILE, 128)
		await settle()

		expect(cues).toEqual([
			{ track: 3, start: 1.5, end: 3.5, text: "Hello <i>there</i>", hint: 0 },
			{ track: 4, start: 2, end: 2 + SIMPLE_BLOCK_CUE_SECONDS, text: "Top line", hint: 8 },
			{ track: 3, start: 5.2, end: 5.2 + SIMPLE_BLOCK_CUE_SECONDS, text: "Second &amp; cue", hint: 0 }
		])
	})

	it("waits for a block that lands late and never reports a cue twice", async () => {
		const { instance, cues } = tap([SRT], 64)
		const count = Math.ceil(FILE.length / 64)
		const order = Array.from({ length: count }, (_, index) => index).filter(index => index !== 3)

		feed(instance, FILE, 64, order)
		feed(instance, FILE, 64, [3])
		// Read again (evicted and fetched anew).
		feed(instance, FILE, 64)
		await settle()

		expect(cues.map(cue => cue.text)).toEqual(["Hello <i>there</i>", "Second &amp; cue"])
	})

	it("finds a cluster in a block playback jumped to", async () => {
		const { instance, cues } = tap([SRT], 64)
		const firstClusterLength = cluster(1000, [
			simpleBlock(1, 0, VIDEO_FRAME),
			blockGroup(3, 500, text("Hello <i>there</i>"), 2000),
			simpleBlock(1, 40, VIDEO_FRAME),
			simpleBlock(4, 1000, text("0,0,Default,,0,0,0,,{\\an8}Top line"))
		]).length
		const padded = concat([new Uint8Array(64 - (firstClusterLength % 64)).fill(0xec), FILE.subarray(firstClusterLength)])
		const shifted = concat([FILE.subarray(0, firstClusterLength), padded])
		const second = Math.ceil(firstClusterLength / 64)

		feed(
			instance,
			shifted,
			64,
			Array.from({ length: Math.ceil(shifted.length / 64) - second }, (_, i) => i + second)
		)
		await settle()

		expect(cues.map(cue => cue.text)).toEqual(["Second &amp; cue"])
	})

	it("inflates zlib-compressed frames and undoes header stripping", async () => {
		const compressed = new Uint8Array(
			await new Response(
				new Blob([new TextEncoder().encode("Squeezed")]).stream().pipeThrough(new CompressionStream("deflate"))
			).arrayBuffer()
		)
		const file = concat([cluster(0, [simpleBlock(5, 0, compressed), simpleBlock(6, 100, text("ripped"))])])
		const { instance, cues } = tap(
			[
				{ number: 5, codecId: "S_TEXT/UTF8", compression: { algorithm: 0, settings: new Uint8Array(0) } },
				{ number: 6, codecId: "S_TEXT/UTF8", compression: { algorithm: 3, settings: text("St") } }
			],
			4096
		)

		feed(instance, file, 4096)
		await settle()

		expect(cues.map(cue => cue.text)).toEqual(["Squeezed", "Stripped"])
	})

	it("ignores image subtitles and unknown compression, and survives garbage", async () => {
		const { instance, cues } = tap(
			[
				{ number: 3, codecId: "S_HDMV/PGS", compression: null },
				{ number: 4, codecId: "S_TEXT/UTF8", compression: "unsupported" }
			],
			128
		)

		expect(instance.active).toBe(false)
		feed(instance, FILE, 128)

		const noisy = tap([SRT], 128)

		feed(
			noisy.instance,
			new Uint8Array(4096).map((_, i) => (i * 37) & 0xff),
			128
		)
		await settle()

		expect(cues).toEqual([])
		expect(noisy.cues).toEqual([])
	})

	it("inflates one cue at a time and drops a cue that inflates past what a cue can show", async () => {
		const deflate = async (value: string): Promise<Uint8Array> =>
			new Uint8Array(
				await new Response(
					new Blob([new TextEncoder().encode(value)]).stream().pipeThrough(new CompressionStream("deflate"))
				).arrayBuffer()
			)
		const frames = await Promise.all(Array.from({ length: 40 }, (_, i) => deflate(`Cue ${String(i)}`)))
		const bomb = await deflate("x".repeat(64 * 1024 - 1))
		const file = cluster(0, [...frames.map((frame, i) => simpleBlock(5, i * 10, frame)), simpleBlock(5, 1000, bomb)])
		const Real = globalThis.DecompressionStream
		const live = { now: 0, max: 0 }

		vi.stubGlobal(
			"DecompressionStream",
			class {
				public readonly writable: WritableStream<BufferSource>
				public readonly readable: ReadableStream<Uint8Array>

				public constructor(format: CompressionFormat) {
					const real = new Real(format)

					live.now++
					live.max = Math.max(live.max, live.now)
					this.writable = real.writable
					this.readable = real.readable.pipeThrough(
						new TransformStream<Uint8Array, Uint8Array>({
							flush: () => {
								live.now--
							}
						})
					)
				}
			}
		)

		const { instance, cues } = tap(
			[{ number: 5, codecId: "S_TEXT/UTF8", compression: { algorithm: 0, settings: new Uint8Array(0) } }],
			1 << 20
		)

		feed(instance, file, 1 << 20)

		for (let i = 0; i < 20 && cues.length < 40; i++) {
			await settle()
		}

		expect(cues.map(cue => cue.text)).toEqual(frames.map((_, i) => `Cue ${String(i)}`))
		expect(live.max).toBe(1)
	})

	it("decodes no track whose stripped header is longer than a header", async () => {
		const { instance, cues } = tap(
			[{ number: 6, codecId: "S_TEXT/UTF8", compression: { algorithm: 3, settings: new Uint8Array(4096).fill(0x41) } }],
			4096
		)

		expect(instance.active).toBe(false)
		feed(instance, cluster(0, [simpleBlock(6, 0, text("ripped"))]), 4096)
		await settle()

		expect(cues).toEqual([])
	})

	it("skips an oversized BlockGroup by its size and charges group children to the arrival's budget", async () => {
		const header = vi.spyOn(TextTap.prototype as unknown as { header: (pos: number) => unknown }, "header")
		// Two-byte Void children: an ID and a zero size.
		const voids = (bytes: number) => new Uint8Array(bytes).map((_, i) => (i % 2 === 0 ? 0xec : 0x80))
		const huge = element([0xa0], voids(512 * 1024))
		const groups = Array.from({ length: 20 }, () => element([0xa0], voids(60 * 1024)))
		const file = concat([
			cluster(0, [huge, simpleBlock(3, 10, text("after the big one")), ...groups, simpleBlock(3, 20, text("last"))])
		])
		const size = 256 * 1024
		const { instance, cues } = tap([SRT], size)
		const perArrival: number[] = []

		for (let index = 0; index * size < file.length; index++) {
			header.mockClear()
			instance.addBlock(index, file.subarray(index * size, Math.min(file.length, (index + 1) * size)))
			perArrival.push(header.mock.calls.length)
		}

		// Arrivals with nothing new to read walk on from where the budget stopped.
		for (let i = 0; i < 20 && cues.length < 2; i++) {
			header.mockClear()
			instance.addBlock(Math.floor((file.length - 1) / size), file.subarray(Math.floor((file.length - 1) / size) * size))
			perArrival.push(header.mock.calls.length)
		}

		await settle()

		expect(cues.map(cue => cue.text)).toEqual(["after the big one", "last"])
		expect(Math.max(...perArrival)).toBeLessThanOrEqual(50_000 + 16)
	})

	it("keeps every block of a track that starts at the same time, and still reports each once", async () => {
		const { instance, cues } = tap([ASS], 64)
		const bytes = cluster(1000, [
			simpleBlock(4, 0, text("0,0,Sign,,0,0,0,,{\\an8}A sign")),
			simpleBlock(4, 0, text("0,0,Default,,0,0,0,,First speaker")),
			simpleBlock(4, 0, text("1,0,Default,,0,0,0,,Second speaker"))
		])

		feed(instance, bytes, 64)
		// Read again (evicted and fetched anew).
		feed(instance, bytes, 64)
		await settle()

		expect(cues.map(cue => [cue.start, cue.text])).toEqual([
			[1, "A sign"],
			[1, "First speaker"],
			[1, "Second speaker"]
		])
	})

	it("takes no CodecID inherited from Object.prototype for a text codec", async () => {
		expect(isTapTextCodec("S_TEXT/ASS")).toBe(true)

		for (const codecId of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
			expect(isTapTextCodec(codecId)).toBe(false)
		}

		const { instance, cues } = tap([{ number: 3, codecId: "constructor", compression: null }], 128)

		expect(instance.active).toBe(false)
		feed(instance, FILE, 128)
		await settle()

		expect(cues).toEqual([])
	})

	it("hands on no more characters than the embedded cue budget, then stops walking", async () => {
		const line = "y".repeat(100)
		const bytes = cluster(
			0,
			Array.from({ length: 60 }, (_, i) => simpleBlock(3, i, text(line)))
		)
		const { instance, cues } = tap([SRT], 1 << 20, embeddedCueCharge(line) * 10)

		feed(instance, bytes, 1 << 20)
		await settle()

		expect(cues).toHaveLength(10)
		expect(instance.active).toBe(false)
	})
})
