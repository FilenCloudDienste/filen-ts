import { describe, expect, it } from "vitest"
import {
	BlockSource,
	bytesReadRange,
	indexedKeyframeTimes,
	openKeyframeIndex,
	probeSource,
	probeVideo,
	readKeyframe,
	readMfra,
	type ProbeTier,
	type ReadRange
} from "@filen/shared/videos"
import { ALL_FORMATS, BufferSource, Input, Mp4OutputFormat } from "mediabunny"
import { AVC_PRIVATE, FPS, GOP_FRAMES, fragmentedMp4, videoPacket } from "@/tests/support/fragmentedMp4"

// Fragmented MP4 written by mediabunny (the export path's muxer), read back by the shared probe: duration
// from the patched-in mehd, else from the mfra and the last moof; keyframes through the mfra.

// A read range that records the block-aligned reads made through it.
function countingRange(bytes: Uint8Array): { readRange: ReadRange; ranges: [number, number][] } {
	const inner = bytesReadRange(bytes)
	const ranges: [number, number][] = []

	return {
		ranges,
		readRange: (start, end) => {
			ranges.push([start, end])

			return inner(start, end)
		}
	}
}

async function probe(bytes: Uint8Array, tier: ProbeTier) {
	const counted = countingRange(bytes)
	const record = await probeVideo(probeSource(bytes.length, counted.readRange, tier), tier)

	return { record, ranges: counted.ranges }
}

describe("fragmented MP4 probe", () => {
	it("reads the duration mediabunny writes as mehd, without touching the file's tail on a card", async () => {
		const bytes = await fragmentedMp4({ seconds: 12, audio: true, expectedDuration: 12 })
		const { record, ranges } = await probe(bytes, "card")

		expect(record?.container).toBe("mp4")
		expect(record?.durationSec).toBeCloseTo(12, 3)
		expect(record?.index).toBeNull()
		expect(record?.video?.codec).toBe("h264")
		expect(ranges.every(([start]) => start === 0)).toBe(true)

		// mvex/mehd, version 0, in the movie timescale (mediabunny writes 57600).
		const mehd = Buffer.from(bytes).indexOf("mehd")

		expect(mehd).toBeGreaterThan(0)
		expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(mehd + 8)).toBe(12 * 57_600)
	})

	it("writes no mehd without an expected duration, and mediabunny still reads its own output", async () => {
		const bytes = await fragmentedMp4({ seconds: 3, audio: true })

		expect(Buffer.from(bytes).indexOf("mehd")).toBe(-1)

		const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS })

		try {
			expect(await input.computeDuration()).toBeCloseTo(3, 1)
		} finally {
			input.dispose()
		}
	})

	it("rejects an expected duration that is not a finite non-negative number", () => {
		expect(() => new Mp4OutputFormat({ fastStart: "fragmented", expectedDuration: -1 })).toThrow(TypeError)
		expect(() => new Mp4OutputFormat({ fastStart: "fragmented", expectedDuration: Number.POSITIVE_INFINITY })).toThrow(TypeError)
	})

	it("derives the duration from the mfra and the last moof when there is no mehd", async () => {
		const bytes = await fragmentedMp4({ seconds: 9, audio: true })

		for (const tier of ["card", "full", "cover"] as const) {
			const { record } = await probe(bytes, tier)

			expect(record?.durationSec).toBeCloseTo(9, 1)
			expect(record?.index).toBe("mfra")
			expect(record?.partial).toBe(false)
		}
	})

	it("indexes every fragment's keyframe per track", async () => {
		const bytes = await fragmentedMp4({ seconds: 8, audio: false })
		const access = await readMfra(new BlockSource(bytes.length, bytesReadRange(bytes)))
		const video = access?.get(1)

		expect(video?.times.length).toBe(8 * (FPS / GOP_FRAMES))
		expect(video?.ordered).toBe(true)
	})

	it("finds keyframes through the mfra, byte for byte", async () => {
		const bytes = await fragmentedMp4({ seconds: 10, audio: true, expectedDuration: 10 })
		const source = new BlockSource(bytes.length, bytesReadRange(bytes), { maxBlockReads: 8 })
		const index = await openKeyframeIndex(source)

		expect(index?.durationSec).toBeCloseTo(10, 3)
		expect(index?.decoder.codec).toBe("avc1.64001f")
		expect(index?.decoder.description).toEqual(AVC_PRIVATE)

		for (const [time, keyframe] of [
			[0, 0],
			[1.9, 0],
			[2, 2],
			[5.5, 4],
			[99, 8]
		] as const) {
			const ref = await index?.keyframeAt(time)

			expect(ref?.timeSec).toBeCloseTo(keyframe, 3)

			if (ref === null || ref === undefined) {
				throw new Error("no keyframe")
			}

			expect(await readKeyframe(source, ref)).toEqual(videoPacket(keyframe * FPS))
		}
	})

	it("lists every keyframe time from the mfra", async () => {
		const bytes = await fragmentedMp4({ seconds: 10, audio: true, expectedDuration: 10 })
		const times = await indexedKeyframeTimes(new BlockSource(bytes.length, bytesReadRange(bytes), { maxBlockReads: 8 }))

		expect(Array.from(times ?? [], time => Math.round(time * 1000) / 1000)).toEqual([0, 2, 4, 6, 8])
	})

	it("stays within a frame's read budget for a small file", async () => {
		const bytes = await fragmentedMp4({ seconds: 6, audio: true })
		const counted = countingRange(bytes)
		const source = new BlockSource(bytes.length, counted.readRange, { maxBlockReads: 8 })
		const index = await openKeyframeIndex(source)
		const ref = await index?.keyframeAt(3)

		expect(ref?.timeSec).toBeCloseTo(2, 3)
		expect(source.blockReads).toBeLessThanOrEqual(8)
	})

	it("treats a fragmented file without its mfra as having no index and no known duration", async () => {
		const whole = await fragmentedMp4({ seconds: 4, audio: false })
		const mfraSize = new DataView(whole.buffer).getUint32(whole.length - 4)
		const bytes = whole.subarray(0, whole.length - mfraSize)
		const { record } = await probe(bytes, "full")

		expect(record?.durationSec).toBeNull()
		expect(record?.index).toBe("none")
		expect(await openKeyframeIndex(new BlockSource(bytes.length, bytesReadRange(bytes)))).toBeNull()
	})

	it("survives a corrupt mfro", async () => {
		const bytes = (await fragmentedMp4({ seconds: 4, audio: false })).slice()

		new DataView(bytes.buffer).setUint32(bytes.length - 4, bytes.length + 10)

		const { record } = await probe(bytes, "full")

		expect(record?.index).toBe("none")
		expect(record?.durationSec).toBeNull()
	})
})
