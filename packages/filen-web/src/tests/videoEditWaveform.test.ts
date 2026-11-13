import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { BLOCK_BYTES } from "@filen/shared/videos"
import { BlockCache } from "@/lib/media/blockCache"
import { WaveformTap } from "@/features/preview/videoEdit/worker/waveform"
import { fragmentedMp4 } from "@/tests/support/fragmentedMp4"

// The waveform tap over a real demuxer (mediabunny reading an MP4 written by mediabunny, audio packets filled with a
// byte that names them) and a stand-in AudioDecoder whose samples are that byte / 255: peaks appear only for audio
// inside blocks other readers fetched, and the tap itself never downloads.

const SECONDS = 20
const PACKET_SECONDS = 1024 / 48_000

function fill(packet: number): number {
	return (packet % 250) + 1
}

class FakeAudioChunk {
	private readonly data: Uint8Array

	public constructor(init: { data: Uint8Array }) {
		this.data = new Uint8Array(init.data)
	}

	public get byteLength(): number {
		return this.data.byteLength
	}

	public copyTo(target: Uint8Array): void {
		target.set(this.data)
	}
}

class FakeAudioDecoder {
	public static decoded = 0
	public state = "unconfigured"
	private readonly init: AudioDecoderInit
	private pending: number[] = []

	public constructor(init: AudioDecoderInit) {
		this.init = init
	}

	public configure(): void {
		this.state = "configured"
	}

	public decode(chunk: FakeAudioChunk): void {
		const bytes = new Uint8Array(chunk.byteLength)

		chunk.copyTo(bytes)
		this.pending.push((bytes[0] ?? 0) / 255)
		FakeAudioDecoder.decoded++
	}

	public flush(): Promise<void> {
		for (const value of this.pending.splice(0)) {
			this.init.output({
				numberOfFrames: 4,
				numberOfChannels: 2,
				copyTo: (target: Float32Array) => {
					target.fill(value, 0, 4)
				},
				close: () => undefined
			} as unknown as AudioData)
		}

		return Promise.resolve()
	}

	public close(): void {
		this.state = "closed"
	}
}

let bytes: Uint8Array

beforeAll(async () => {
	// About 10 MiB: video packets padded so the file spans several download blocks.
	bytes = await fragmentedMp4({ seconds: SECONDS, audio: true, padding: 20_000, fastStart: "in-memory", audioFill: fill })
})

beforeEach(() => {
	vi.stubGlobal("EncodedAudioChunk", FakeAudioChunk)
	vi.stubGlobal("AudioDecoder", FakeAudioDecoder)
	FakeAudioDecoder.decoded = 0
})

afterEach(() => {
	vi.unstubAllGlobals()
})

interface Harness {
	cache: BlockCache
	tap: WaveformTap
	requests: [number, number][]
}

function harness(): Harness {
	const requests: [number, number][] = []
	let tap: WaveformTap | null = null
	const cache = new BlockCache(
		bytes.length,
		(start, end) => {
			requests.push([start, end])

			return Promise.resolve(bytes.slice(start, end))
		},
		{ capacity: 64, readAhead: 0, maxRunBlocks: 1, onBlock: index => tap?.onBlock(index) }
	)

	tap = new WaveformTap({
		cache,
		size: bytes.length,
		duration: SECONDS,
		createDecoder: init => new FakeAudioDecoder(init) as unknown as AudioDecoder,
		isConfigSupported: () => Promise.resolve(true),
		yieldSlice: () => Promise.resolve()
	})

	return { cache, tap, requests }
}

async function settle(): Promise<void> {
	for (let i = 0; i < 200; i++) {
		await new Promise(resolve => setTimeout(resolve, 0))
	}
}

function knownBuckets(tap: WaveformTap): number[] {
	const grid = tap.bucketGrid
	const known: number[] = []

	for (let bucket = 0; bucket < grid.count; bucket++) {
		if (!Number.isNaN(grid.peakOf(bucket))) {
			known.push(bucket)
		}
	}

	return known
}

describe("WaveformTap", () => {
	it("never downloads: only blocks other readers fetched turn into peaks", async () => {
		const { cache, tap, requests } = harness()

		// The demuxer reads the head (moov first here).
		await cache.read(0, 64)
		tap.start()
		await settle()

		expect(requests).toEqual([[0, BLOCK_BYTES]])

		const afterHead = knownBuckets(tap)

		// Playback fetches block 5.
		await cache.read(5 * BLOCK_BYTES, 5 * BLOCK_BYTES + 10)
		await settle()

		expect(requests).toEqual([
			[0, BLOCK_BYTES],
			[5 * BLOCK_BYTES, 6 * BLOCK_BYTES]
		])

		const fresh = knownBuckets(tap).filter(bucket => !afterHead.includes(bucket))
		const grid = tap.bucketGrid

		expect(fresh.length).toBeGreaterThan(5)
		// One contiguous run, around the middle of the file (block 5 of about 10).
		expect((fresh.at(-1) ?? 0) - (fresh[0] ?? 0)).toBeLessThan(fresh.length + 3)
		expect(grid.timeOf(fresh[0] ?? 0)).toBeGreaterThan(SECONDS * 0.3)
		expect(grid.timeOf(fresh.at(-1) ?? 0)).toBeLessThan(SECONDS * 0.8)

		// Each peak is the loudest packet decoded for its bucket: the one at its middle, and maybe the next.
		for (const bucket of fresh) {
			const packet = Math.floor(grid.timeOf(bucket) / PACKET_SECONDS)
			const peak = grid.peakOf(bucket)

			expect([fill(packet) / 255, fill(packet + 1) / 255].some(value => Math.abs(value - peak) < 1e-6)).toBe(true)
		}

		tap.close()
	})

	it("catches up with blocks already resident when it starts, and decodes a sample of each bucket", async () => {
		const { cache, tap, requests } = harness()

		await cache.read(0, 64)
		await cache.read(3 * BLOCK_BYTES, 3 * BLOCK_BYTES + 10)
		tap.start()
		await settle()

		expect(requests).toHaveLength(2)
		expect(knownBuckets(tap).length).toBeGreaterThan(5)
		// A sample: a few packets per bucket, not every packet of the fetched audio.
		expect(FakeAudioDecoder.decoded).toBeLessThan(knownBuckets(tap).length * 4 + 1)
		tap.close()
	})

	it("publishes columns to subscribers, NaN where nothing is known", async () => {
		const { cache, tap } = harness()
		const updates: Float32Array[] = []

		await cache.read(0, 64)
		tap.start()
		tap.subscribe(1, { start: 0, end: SECONDS }, 100, peaks => updates.push(peaks))

		expect(updates).toHaveLength(1)
		expect(updates[0]?.every(Number.isNaN)).toBe(true)

		await cache.read(7 * BLOCK_BYTES, 7 * BLOCK_BYTES + 10)
		await settle()
		await new Promise(resolve => setTimeout(resolve, 250))

		const last = updates.at(-1)

		expect(updates.length).toBeGreaterThan(1)
		expect(last?.some(value => !Number.isNaN(value))).toBe(true)
		expect(last?.some(value => Number.isNaN(value))).toBe(true)

		tap.unsubscribe(1)
		tap.close()
	})

	it("gives up quietly without a decoder for the audio", async () => {
		const { cache, tap } = harness()

		vi.stubGlobal("AudioDecoder", undefined)
		await cache.read(0, 64)
		tap.start()
		await cache.read(4 * BLOCK_BYTES, 4 * BLOCK_BYTES + 10)
		await settle()

		expect(knownBuckets(tap)).toEqual([])
		tap.close()
	})
})
