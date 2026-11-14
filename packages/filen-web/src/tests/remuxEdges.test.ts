import { registerDecoder } from "mediabunny"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { BLOCK_BYTES } from "@filen/shared/videos"
import { exposeRangePort } from "@/lib/media/rangePort"
import { isSourceReadError } from "@/lib/media/remuxTypes"
import { openAudioInput, type AudioInput } from "@/workers/remux/audioInput"
import { analyzeEdges, analyzeInput } from "@/workers/remux/edges"
import {
	accumulateEnvelope,
	createEnvelope,
	EDGE_WINDOWS,
	ENVELOPE_WINDOW_MS,
	findBoundaryLevels,
	findEdges,
	finishEnvelope,
	powerDb
} from "@/workers/remux/edges.logic"
import { TAIL_PADDING } from "@/workers/remux/tailWindow.logic"
import { adtsFile, flacFile, LevelDecoder, mp3File, SHAPE, wavFile, type LevelShape } from "@/tests/support/edgeAudio"

// A Chromium engine: FLAC goes to the stand-in decoder, not to the FFmpeg worker WebKit's FLAC uses.
vi.hoisted(() => {
	Object.defineProperty(globalThis.navigator, "userAgent", { value: "Mozilla/5.0 Chrome/140.0", configurable: true })
})

// ── Envelope ────────────────────────────────────────────────────────────────

function envelopeOf(chunks: readonly Float32Array[][], sampleRate: number): Float32Array {
	const envelope = createEnvelope(4)

	for (const planes of chunks) {
		accumulateEnvelope(envelope, planes.length, planes[0]?.length ?? 0, sampleRate, channel => planes[channel] ?? new Float32Array(0))
	}

	return finishEnvelope(envelope, sampleRate)
}

function constant(frames: number, value: number): Float32Array {
	return new Float32Array(frames).fill(value)
}

describe("accumulateEnvelope", () => {
	// 1 kHz: 50 frames a window.
	const RATE = 1000

	it("averages squares over 50 ms windows, whatever the chunking", () => {
		const whole = envelopeOf([[constant(500, 0.5)]], RATE)
		const pieces = envelopeOf(
			Array.from({ length: 17 }, (_, i) => [constant(i === 16 ? 500 - 16 * 30 : 30, 0.5)]),
			RATE
		)

		expect(whole.length).toBe(10)
		expect([...whole].every(value => Math.abs(value - 0.25) < 1e-6)).toBe(true)
		expect([...pieces]).toEqual([...whole])
	})

	it("keeps a window that spans chunks exact", () => {
		// 30 frames at 1, then 20 at 0: one window whose mean square is 30 / 50.
		const envelope = envelopeOf([[constant(30, 1)], [constant(20, 0)]], RATE)

		expect(envelope.length).toBe(1)
		expect(envelope[0]).toBeCloseTo(0.6)
	})

	it("takes the loudest channel of each window", () => {
		const envelope = envelopeOf(
			[
				[constant(50, 0.1), constant(50, 0.5)],
				[constant(50, 0.4), constant(50, 0.2)]
			],
			RATE
		)

		expect(envelope[0]).toBeCloseTo(0.25)
		expect(envelope[1]).toBeCloseTo(0.16)
	})

	it("follows a change in channel count without carrying a dropped channel's sums", () => {
		const envelope = envelopeOf(
			[[constant(25, 0), constant(25, 0.8)], [constant(25, 0.2)], [constant(50, 0.2)], [constant(50, 0), constant(50, 0)]],
			RATE
		)

		// The window the second channel left inside closes with the first alone: 25 frames at 0.2 over 50.
		expect(envelope[0]).toBeCloseTo(0.02)
		expect(envelope[1]).toBeCloseTo(0.04)
		expect(envelope[2]).toBe(0)
	})

	it("counts a last open window of half a window or more, and grows past its first capacity", () => {
		expect(envelopeOf([[constant(1025, 0.5)]], RATE).length).toBe(21)
		expect(envelopeOf([[constant(1024, 0.5)]], RATE).length).toBe(20)
		expect(envelopeOf([[constant(1000, 0.5)], [constant(30, 0.5)]], RATE).length).toBe(21)
	})

	it("ignores an empty chunk", () => {
		expect(envelopeOf([[new Float32Array(0)]], RATE).length).toBe(0)
	})
})

// ── Edges ───────────────────────────────────────────────────────────────────

function fromDb(levels: readonly number[]): Float32Array {
	return Float32Array.from(levels, db => (db <= -100 ? 0 : 10 ** (db / 10)))
}

function run(count: number, db: number): number[] {
	return new Array<number>(count).fill(db)
}

function ramp(count: number, from: number, to: number): number[] {
	return Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1))
}

const HEAD = fromDb([...run(30, -90), ...run(170, -10)])

describe("findEdges", () => {
	it("starts past leading silence, 50 ms early, and skips at most 10 s", () => {
		expect(findEdges(HEAD, null).inStartMs).toBe(29 * ENVELOPE_WINDOW_MS)
		expect(findEdges(fromDb(run(200, -10)), null).inStartMs).toBe(0)
		expect(findEdges(fromDb(run(220, -80)), null).inStartMs).toBe(10_000)
		expect(findEdges(new Float32Array(0), null).inStartMs).toBeNull()
	})

	it("ends 50 ms past the last audible window, with no fade-out for a flat ending", () => {
		const edges = findEdges(HEAD, fromDb([...run(380, -10), ...run(20, -100)]))

		expect(edges.outEndFromEndMs).toBe(19 * ENVELOPE_WINDOW_MS)
		expect(edges.fadeOutFromEndMs).toBeNull()
		expect(findEdges(HEAD, fromDb(run(400, -10))).outEndFromEndMs).toBe(0)
	})

	it("knows nothing of a tail that is silent all through, or one that could not be read", () => {
		expect(findEdges(HEAD, fromDb(run(400, -100)))).toMatchObject({ outEndFromEndMs: null, fadeOutFromEndMs: null })
		expect(findEdges(HEAD, null)).toMatchObject({ outEndFromEndMs: null, fadeOutFromEndMs: null })
	})

	it("finds a fade-out where the level has fallen 12 dB below the reference and keeps falling", () => {
		// -10 dB, then down to -70 dB over 100 windows: -22 dB is crossed 19.8 windows in.
		const edges = findEdges(HEAD, fromDb([...run(300, -10), ...ramp(100, -10, -70)]))

		expect(edges.fadeOutFromEndMs).toBe((400 - 320) * ENVELOPE_WINDOW_MS)
		// -60 dB is reached 82.5 windows in: window 382 is the last audible one.
		expect(edges.outEndFromEndMs).toBe((400 - 2 - 382) * ENVELOPE_WINDOW_MS)
	})

	it("takes the 90th percentile of the audible windows as the reference, not the loudest", () => {
		// A few loud windows (5 %) do not lift the reference: -15 dB is 5 dB below it, no fade-out.
		const edges = findEdges(HEAD, fromDb([...run(20, 0), ...run(340, -10), ...run(40, -15)]))

		expect(edges.fadeOutFromEndMs).toBeNull()

		// Loud for more than a tenth of the tail: the reference is 0 dB and the quiet ending is a fade-out.
		expect(findEdges(HEAD, fromDb([...run(60, 0), ...run(300, -10), ...run(40, -15)])).fadeOutFromEndMs).toBe(40 * ENVELOPE_WINDOW_MS)
	})

	it("starts a fade-out only after the last rise of the smoothed level", () => {
		// A 0 dB reference, then -30 dB, a 10 dB bump, and -40 dB to the end.
		const plain = findEdges(HEAD, fromDb([...run(300, 0), ...run(100, -30)]))
		const bumped = findEdges(HEAD, fromDb([...run(300, 0), ...run(40, -30), ...run(20, -20), ...run(40, -40)]))

		expect(plain.fadeOutFromEndMs).toBe(100 * ENVELOPE_WINDOW_MS)
		expect(bumped.fadeOutFromEndMs).toBeGreaterThan((400 - 350) * ENVELOPE_WINDOW_MS)
		expect(bumped.fadeOutFromEndMs).toBeLessThan((400 - 340) * ENVELOPE_WINDOW_MS)
	})

	it("clamps a fade-out longer than the window to 2 s into it: at most 18 s before the end", () => {
		const edges = findEdges(HEAD, fromDb([...run(30, -5), ...ramp(90, -20, -58), ...run(280, -100)]))

		expect(edges.fadeOutFromEndMs).toBe(18_000)
	})

	it("measures the boundary seconds' levels", () => {
		const head = fromDb([...run(20, -40), ...run(180, -10)])
		const tail = fromDb([...run(380, -10), ...run(20, -55)])

		const levels = findBoundaryLevels(head, tail, 1)

		expect(levels?.headDb).toBeCloseTo(-40)
		expect(levels?.tailDb).toBeCloseTo(-55)
		expect(findBoundaryLevels(head, null, 1)).toBeNull()
		expect(findBoundaryLevels(fromDb(run(20, -100)), fromDb(run(20, -100)), 1)).toEqual({ headDb: -120, tailDb: -120 })
	})

	it("reads digital silence as a finite floor", () => {
		expect(powerDb(0)).toBe(-120)
		expect(powerDb(1)).toBe(0)
	})
})

// ── Real decodes ────────────────────────────────────────────────────────────

beforeAll(() => {
	registerDecoder(LevelDecoder)
})

interface Served {
	port: MessagePort
	size: number
	// Bytes the port served (whole blocks, as the cache fetches them).
	served: () => number
}

function serve(bytes: Uint8Array, fail = false): Served {
	const { port1, port2 } = new MessageChannel()
	let served = 0

	exposeRangePort(
		port1,
		(start, end) => {
			if (fail && start > 0) {
				return Promise.reject(new Error("network down"))
			}

			served += end - start

			return Promise.resolve(bytes.slice(start, end))
		},
		new AbortController()
	)

	return { port: port2, size: bytes.length, served: () => served }
}

// The byte ranges the analysis asks the block cache for (its demand, before block rounding), merged.
function spyReads(input: AudioInput): () => [number, number][] {
	const ranges: [number, number][] = []
	const read = input.cache.read.bind(input.cache)
	const stream = input.cache.stream.bind(input.cache)

	vi.spyOn(input.cache, "read").mockImplementation((start, end) => {
		ranges.push([start, end])

		return read(start, end)
	})
	vi.spyOn(input.cache, "stream").mockImplementation((start, end) => {
		ranges.push([start, end])

		return stream(start, end)
	})

	return () => {
		const merged: [number, number][] = []

		for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
			const last = merged[merged.length - 1]

			if (last !== undefined && start <= last[1]) {
				last[1] = Math.max(last[1], end)
			} else {
				merged.push([start, end])
			}
		}

		return merged
	}
}

function bytesIn(ranges: readonly [number, number][], from: number, to: number): number {
	return ranges.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(end, to) - Math.max(start, from)), 0)
}

// What the fixtures' shape gives: audio from 1.5 s, silence for the last 3 s, a fade (linear in dB, -6 to -70 dB
// over 10 s) whose -18 dB point lies 11.125 s before the end. A frame or two of slack for each.
function expectShape(edges: Awaited<ReturnType<typeof analyzeInput>>, slackMs: number, shape: LevelShape = SHAPE): void {
	expect(edges.status).toBe("ok")
	expect(edges.durationSec).toBeCloseTo(shape.durationSec, 0)
	expect(Math.abs((edges.inStartMs ?? -1) - 1450)).toBeLessThanOrEqual(slackMs)
	expect(Math.abs((edges.outEndFromEndMs ?? -1) - 4560)).toBeLessThanOrEqual(slackMs + 100)
	expect(Math.abs((edges.fadeOutFromEndMs ?? -1) - 11_125)).toBeLessThanOrEqual(slackMs + 100)
	expect(edges.boundary?.headDb).toBeLessThan(-100)
	expect(edges.boundary?.tailDb).toBeLessThan(-100)
}

const FORMATS = [
	{ name: "MP3", file: mp3File, slackMs: 80 },
	{ name: "ADTS", file: adtsFile, slackMs: 80 },
	{ name: "FLAC", file: flacFile, slackMs: 150 }
] as const

// Five minutes: many download blocks, so a read of the whole file would show.
const LONG: LevelShape = { ...SHAPE, durationSec: 300 }

describe("analyzeInput over real demuxers", () => {
	for (const format of FORMATS) {
		it(`finds ${format.name} edges with the tail read by byte offset: tail ≤ 1.2 × the window, total ≤ head + 1.2 × tail`, async () => {
			const bytes = format.file(LONG)
			const source = serve(bytes)
			const input = await openAudioInput(source.port, source.size, "analysis")
			const reads = spyReads(input)

			const edges = await analyzeInput(input)

			await input.close()

			const byteRate = bytes.length / LONG.durationSec
			const head = EDGE_WINDOWS.headSeconds * byteRate
			const tail = EDGE_WINDOWS.tailSeconds * byteRate
			const merged = reads()
			const half = Math.floor(bytes.length / 2)

			expectShape(edges, format.slackMs, LONG)
			expect(bytesIn(merged, half, bytes.length)).toBeLessThanOrEqual(tail * 1.2)
			expect(bytesIn(merged, half, bytes.length)).toBeGreaterThanOrEqual(tail)
			expect(bytesIn(merged, 0, bytes.length)).toBeLessThanOrEqual(head + tail * 1.2)
			// Downloads are whole blocks: the head's and the tail's, nowhere near the whole file.
			expect(source.served()).toBeLessThanOrEqual(4 * BLOCK_BYTES)
			expect(source.served()).toBeLessThan(bytes.length / 2)
		})
	}

	it("finds WAV edges through the container's own seek", async () => {
		const bytes = wavFile()
		const source = serve(bytes)
		const input = await openAudioInput(source.port, source.size, "analysis")

		expectShape(await analyzeInput(input), 60)
		await input.close()
	})

	it("reads one pass for a track no longer than both windows", async () => {
		const bytes = mp3File({ durationSec: 25, leadSec: 2, fadeFromEndSec: 8, trailSec: 1 })
		const source = serve(bytes)
		const input = await openAudioInput(source.port, source.size, "analysis")
		const edges = await analyzeInput(input)

		await input.close()

		expect(edges.status).toBe("ok")
		expect(Math.abs((edges.inStartMs ?? -1) - 1950)).toBeLessThanOrEqual(80)
		expect(edges.outEndFromEndMs).not.toBeNull()
	})

	it("past the byte budget reads only the boundary seconds and answers skipped with them", async () => {
		const bytes = flacFile()
		const source = serve(bytes)
		const input = await openAudioInput(source.port, source.size, "analysis")
		const reads = spyReads(input)
		const edges = await analyzeInput(input, { ...EDGE_WINDOWS, maxWindowBytes: 1_000_000 })

		await input.close()

		expect(edges).toMatchObject({ status: "skipped", inStartMs: null, outEndFromEndMs: null, fadeOutFromEndMs: null })
		expect(edges.boundary?.headDb).toBeLessThan(-100)
		expect(edges.boundary?.tailDb).toBeLessThan(-100)

		const byteRate = bytes.length / SHAPE.durationSec

		expect(bytesIn(reads(), Math.floor(bytes.length / 2), bytes.length)).toBeLessThanOrEqual(
			1 * byteRate * TAIL_PADDING * 1.2 + 131_072
		)
	})
})

describe("analyzeEdges", () => {
	it("analyses the file a port serves", async () => {
		const bytes = mp3File()
		const source = serve(bytes)

		expectShape(await analyzeEdges(source.port, source.size), 80)
	})

	it("answers failed for a file nothing in which decodes", async () => {
		const garbage = new Uint8Array(200_000).fill(0x42)
		const source = serve(garbage)

		expect(await analyzeEdges(source.port, source.size)).toMatchObject({ status: "failed", boundary: null })
	})

	it("rejects, rather than answering, when the bytes do not arrive", async () => {
		const bytes = mp3File()
		const source = serve(bytes, true)
		const outcome = await analyzeEdges(source.port, source.size).then(
			() => null,
			(error: unknown) => error
		)

		expect(isSourceReadError(outcome)).toBe(true)
	})
})
