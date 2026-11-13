import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
	BufferSource,
	BufferTarget,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	Input,
	MP4,
	Mp4OutputFormat,
	Output
} from "mediabunny"
import { FrameDecodeError, GopDecoder, SupersededError } from "@/features/preview/videoEdit/worker/gopDecoder"
import { AVC_PRIVATE, FPS, GOP_FRAMES, fragmentedMp4 } from "@/tests/support/fragmentedMp4"

// Exact-frame decoding over a real demuxer (mediabunny reading an MP4 written by mediabunny) with a stand-in
// VideoDecoder that holds `delay` frames before putting them out, as a reordering hardware decoder does.

class FakeChunk {
	public readonly type: string
	public readonly timestamp: number
	public readonly duration: number | null
	public readonly byteLength: number

	public constructor(init: { type: string; timestamp: number; duration?: number; data: ArrayBufferView }) {
		this.type = init.type
		this.timestamp = init.timestamp
		this.duration = init.duration ?? null
		this.byteLength = init.data.byteLength
	}
}

class FakeFrame {
	public readonly timestamp: number
	public closed = false

	public constructor(timestamp: number) {
		this.timestamp = timestamp
		frames.push(this)
	}

	public close(): void {
		this.closed = true
	}
}

let frames: FakeFrame[] = []

class FakeDecoder extends EventTarget {
	public static delay = 0
	public static failAt: number | null = null
	public static created: FakeDecoder[] = []
	public state: "unconfigured" | "configured" | "closed" = "unconfigured"
	public decodeQueueSize = 0
	public fed: { type: string; timestamp: number }[] = []
	public configures = 0
	public resets = 0
	public flushes = 0
	private held: number[] = []
	private readonly init: VideoDecoderInit

	public constructor(init: VideoDecoderInit) {
		super()
		this.init = init
		FakeDecoder.created.push(this)
	}

	public configure(): void {
		this.state = "configured"
		this.configures++
	}

	public decode(chunk: FakeChunk): void {
		if (this.state !== "configured") {
			throw new Error("not configured")
		}

		this.fed.push({ type: chunk.type, timestamp: chunk.timestamp })
		this.decodeQueueSize++
		queueMicrotask(() => {
			if (this.state !== "configured") {
				return
			}

			this.decodeQueueSize--

			if (chunk.timestamp === FakeDecoder.failAt) {
				this.state = "closed"
				this.init.error(new DOMException("boom", "EncodingError"))

				return
			}

			this.held.push(chunk.timestamp)
			this.dispatchEvent(new Event("dequeue"))

			if (this.held.length > FakeDecoder.delay) {
				this.emit(this.held.shift() ?? 0)
			}
		})
	}

	public async flush(): Promise<void> {
		this.flushes++
		await new Promise(resolve => setTimeout(resolve, 0))

		for (const timestamp of this.held.splice(0)) {
			this.emit(timestamp)
		}
	}

	public reset(): void {
		this.held = []
		this.decodeQueueSize = 0
		this.state = "unconfigured"
		this.resets++
	}

	public close(): void {
		this.state = "closed"
	}

	private emit(timestamp: number): void {
		this.init.output(new FakeFrame(timestamp) as unknown as VideoFrame)
	}
}

beforeEach(() => {
	vi.stubGlobal("EncodedVideoChunk", FakeChunk)
	frames = []
	FakeDecoder.created = []
	FakeDecoder.delay = 0
	FakeDecoder.failAt = null
})

afterEach(() => {
	expect(frames.filter(frame => !frame.closed).length).toBeLessThanOrEqual(5)
})

async function sinkOf(bytes: Uint8Array): Promise<EncodedPacketSink> {
	const input = new Input({ formats: [MP4], source: new BufferSource(bytes) })
	const track = await input.getPrimaryVideoTrack()

	if (track === null) {
		throw new Error("no video track")
	}

	return new EncodedPacketSink(track)
}

function decoder(sink: EncodedPacketSink): GopDecoder<EncodedPacket> {
	return new GopDecoder<EncodedPacket>({ codec: "avc1.64001f" }, sink, init => new FakeDecoder(init) as unknown as VideoDecoder)
}

function us(seconds: number): number {
	return Math.round(seconds * 1e6)
}

const always = (): boolean => true

let plain: Uint8Array

beforeAll(async () => {
	plain = await fragmentedMp4({ seconds: 6, audio: false, fastStart: "in-memory" })
})

describe("GopDecoder", () => {
	for (const delay of [0, 2]) {
		it(`returns the exact frame shown at a time, decoding from its keyframe (decoder delay ${String(delay)})`, async () => {
			FakeDecoder.delay = delay

			const gop = decoder(await sinkOf(plain))
			// 1.5 s is frame 37 of the GOP that starts at 0.
			const frame = await gop.frameAt(1.5 + 0.01, always)
			const fake = FakeDecoder.created[0]

			expect(frame.timestamp).toBe(us(37 / FPS))
			expect(fake?.fed[0]).toEqual({ type: "key", timestamp: 0 })
			// It fed what it needed and at most a few more.
			expect(fake?.fed.length).toBeGreaterThanOrEqual(38)
			expect(fake?.fed.length).toBeLessThanOrEqual(38 + delay + 3)
			frame.close()
		})
	}

	it("steps forward within the GOP without starting over", async () => {
		FakeDecoder.delay = 2

		const gop = decoder(await sinkOf(plain))

		;(await gop.frameAt(10 / FPS, always)).close()

		const fake = FakeDecoder.created[0]
		const fedBefore = fake?.fed.length ?? 0

		for (let frame = 11; frame < 20; frame++) {
			const next = await gop.frameAt(frame / FPS, always)

			expect(next.timestamp).toBe(us(frame / FPS))
			next.close()
		}

		expect(FakeDecoder.created).toHaveLength(1)
		expect(fake?.configures).toBe(1)
		expect(fake?.resets).toBe(0)
		// One more packet per step, give or take what was already in flight.
		expect((fake?.fed.length ?? 0) - fedBefore).toBeLessThanOrEqual(9 + 3)
	})

	it("starts over from the keyframe for a step back, and from another keyframe for another GOP", async () => {
		const gop = decoder(await sinkOf(plain))

		;(await gop.frameAt(30 / FPS, always)).close()
		;(await gop.frameAt(20 / FPS, always)).close()

		const fake = FakeDecoder.created[0]

		expect(fake?.resets).toBe(1)
		expect(fake?.fed.filter(chunk => chunk.type === "key").map(chunk => chunk.timestamp)).toEqual([0, 0])

		const far = await gop.frameAt((GOP_FRAMES + 3) / FPS, always)

		expect(far.timestamp).toBe(us((GOP_FRAMES + 3) / FPS))
		expect(fake?.fed.filter(chunk => chunk.type === "key").at(-1)?.timestamp).toBe(us(GOP_FRAMES / FPS))
		far.close()
	})

	it("answers the last frame for a time past the end, flushing the decoder", async () => {
		FakeDecoder.delay = 2

		const gop = decoder(await sinkOf(plain))
		const last = await gop.frameAt(999, always)

		expect(last.timestamp).toBe(us((6 * FPS - 1) / FPS))
		expect(FakeDecoder.created[0]?.flushes).toBe(1)
		last.close()
	})

	it("stops a superseded request between packets and keeps the position for the next", async () => {
		const gop = decoder(await sinkOf(plain))
		let fed = 0
		const stale = gop.frameAt(40 / FPS, () => ++fed < 10)

		await expect(stale).rejects.toBeInstanceOf(SupersededError)

		const fake = FakeDecoder.created[0]
		const before = fake?.fed.length ?? 0
		const next = await gop.frameAt(12 / FPS, always)

		expect(next.timestamp).toBe(us(12 / FPS))
		// Continued, not restarted.
		expect(fake?.resets).toBe(0)
		expect((fake?.fed.length ?? 0) - before).toBeLessThan(12)
		next.close()
	})

	it("decodes a keyframe on its own for a still", async () => {
		const gop = decoder(await sinkOf(plain))
		const still = await gop.keyFrameAt(3.3)

		expect(still?.timestamp).toBe(us(2))
		expect(FakeDecoder.created[0]?.fed).toEqual([{ type: "key", timestamp: us(2) }])
		still?.close()

		// The next request starts over.
		const frame = await gop.frameAt(63 / FPS + 0.001, always)

		expect(frame.timestamp).toBe(us(63 / FPS))
		frame.close()
	})

	it("is correct for variable frame rates: the latest sample at or before the time", async () => {
		const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() })
		const source = new EncodedVideoPacketSource("avc")
		const times = [0, 0.04, 0.05, 0.2, 0.21, 0.5, 0.9, 0.95]

		output.addVideoTrack(source)
		await output.start()

		for (const [index, time] of times.entries()) {
			const next = times[index + 1] ?? time + 0.04

			await source.add(
				new EncodedPacket(
					new Uint8Array([0, 0, 0, 1, index === 0 ? 0x65 : 0x41]),
					index === 0 ? "key" : "delta",
					time,
					next - time
				),
				index === 0
					? { decoderConfig: { codec: "avc1.64001f", codedWidth: 1280, codedHeight: 720, description: AVC_PRIVATE } }
					: undefined
			)
		}

		await output.finalize()

		const gop = decoder(await sinkOf(new Uint8Array(output.target.buffer ?? new ArrayBuffer(0))))

		for (const [at, expected] of [
			[0.045, 0.04],
			[0.19, 0.05],
			[0.2, 0.2],
			[0.7, 0.5],
			[0.93, 0.9]
		] as const) {
			const frame = await gop.frameAt(at, always)

			expect(frame.timestamp).toBe(us(expected))
			frame.close()
		}
	})

	it("reports a decoder that fails, and recovers with a new one", async () => {
		const gop = decoder(await sinkOf(plain))

		FakeDecoder.failAt = us(20 / FPS)

		await expect(gop.frameAt(30 / FPS, always)).rejects.toBeInstanceOf(FrameDecodeError)

		FakeDecoder.failAt = null

		const frame = await gop.frameAt(30 / FPS, always)

		expect(frame.timestamp).toBe(us(30 / FPS))
		expect(FakeDecoder.created).toHaveLength(2)
		frame.close()
	})

	it("closes every frame it holds on release", async () => {
		FakeDecoder.delay = 2

		const gop = decoder(await sinkOf(plain))

		;(await gop.frameAt(0.2, always)).close()
		gop.release()

		expect(frames.every(frame => frame.closed)).toBe(true)
		expect(FakeDecoder.created[0]?.state).toBe("closed")
	})
})
