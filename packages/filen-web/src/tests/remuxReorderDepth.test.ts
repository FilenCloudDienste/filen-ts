import { describe, expect, it } from "vitest"
import { EncodedPacket } from "mediabunny"
import { FragmentedTrackOutput } from "@/workers/remux/output"
import { PumpGate } from "@/workers/remux/pump"
import { AVC_PRIVATE } from "@/tests/support/fragmentedMp4"
import { fmp4Samples, type Fmp4Sample } from "@/tests/support/fmp4"

// A stream whose first GOP reorders nothing and whose later ones reorder two deep (a B-pyramid): with the SPS's
// bound, decode times lag presentation by two frames from the start, so every later picture still decodes before it
// is presented and no decode duration is zero. With no bound the first GOP's lag (none) is all there is, and the
// later GOPs' decode times are held at their presentations instead, some then sharing one.

const FRAME = 1 / 25
// Presentation order, in frames, of each GOP's pictures in decode order.
const FLAT = [0, 1, 2, 3, 4, 5, 6, 7]
const PYRAMID = [0, 4, 2, 1, 3, 8, 6, 5, 7]
const GOPS = [FLAT, PYRAMID, PYRAMID, PYRAMID]

async function remux(reorderFrames: number | null): Promise<Fmp4Sample[]> {
	const chunks: Uint8Array[] = []
	const output = new FragmentedTrackOutput({
		track: {
			kind: "video",
			codec: "avc",
			decoderConfig: { codec: "avc1.64001f", codedWidth: 1280, codedHeight: 720, description: AVC_PRIVATE },
			rotation: 0,
			reorderFrames
		},
		gate: new PumpGate(Number.POSITIVE_INFINITY),
		maxFragmentBytes: 8_000_000,
		onSegment: bytes => {
			chunks.push(bytes)
		}
	})
	let start = 0

	for (const gop of GOPS) {
		for (const [index, frame] of gop.entries()) {
			await output.write(
				new EncodedPacket(new Uint8Array(64).fill(frame), index === 0 ? "key" : "delta", (start + frame) * FRAME, FRAME)
			)
		}

		start += gop.length
	}

	await output.end()
	await new Promise(resolve => setTimeout(resolve, 0))

	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
	const bytes = new Uint8Array(total)
	let at = 0

	for (const chunk of chunks) {
		bytes.set(chunk, at)
		at += chunk.length
	}

	return fmp4Samples(bytes, Number.POSITIVE_INFINITY).samples
}

describe("remux decode times on a stream that reorders deeper after its first GOP", () => {
	it("lag by the SPS's bound: every picture decoded before it is presented, no zero durations", async () => {
		const samples = await remux(2)

		expect(samples).toHaveLength(GOPS.flat().length)
		expect(samples[0]?.dts).toBe(0)

		for (const [index, sample] of samples.entries()) {
			expect(sample.pts, `#${String(index)}`).toBeGreaterThanOrEqual(sample.dts)
			expect(sample.duration, `#${String(index)}`).toBeGreaterThan(0)
			expect(sample.trunVersion, `#${String(index)}`).toBe(0)
		}
	})

	it("without a bound, still never presents a picture before it is decoded", async () => {
		const samples = await remux(null)

		for (const [index, sample] of samples.entries()) {
			expect(sample.pts, `#${String(index)}`).toBeGreaterThanOrEqual(sample.dts)
			expect(sample.duration, `#${String(index)}`).toBeGreaterThanOrEqual(0)
		}

		// What the bound is for: the held decode times collapse.
		expect(samples.some(sample => sample.duration === 0)).toBe(true)
	})
})
