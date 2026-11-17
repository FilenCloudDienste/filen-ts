import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { BufferSource, EncodedPacketSink, Input } from "mediabunny"
import { exposeRangePort } from "@/lib/media/rangePort"
import { AVI } from "@/lib/media/demux/aviDemuxer"
import { ASF } from "@/lib/media/demux/asfDemuxer"
import { MPEG_PS } from "@/lib/media/demux/mpegPsDemuxer"
import type { RemuxEvent } from "@/lib/media/remuxTypes"
import { videoReorderFrames } from "@filen/shared/videos"
import { fmp4Samples } from "@/tests/support/fmp4"

const { RemuxEngine } = await import("@/workers/remux/engine")

// The legacy containers' B-frame streams remuxed to fragmented MP4: decode times lag presentation by the reorder
// delay (the SPS's max_num_reorder_frames, in frames), so every sample is decoded no later than it is presented
// (version-0 trun, offsets never negative), the first fragment decodes from 0, and the edit list puts each picture back
// at its source time, on the audio's timeline.

const FILES = [
	["h264-bframes-mp3.avi", AVI],
	["h264-mp3.asf", ASF],
	["h264-ac3.vob", MPEG_PS]
] as const

const read = (name: string): Buffer => readFileSync(new URL(`fixtures/demux/${name}`, import.meta.url))

// The source's presentation times of its video packets, in decode order.
async function sourceTimes(bytes: Buffer, format: (typeof FILES)[number][1]): Promise<number[]> {
	const input = new Input({ formats: [format], source: new BufferSource(bytes) })
	const track = await input.getPrimaryVideoTrack()

	if (track === null) {
		throw new Error("no video track")
	}

	const times: number[] = []

	for await (const packet of new EncodedPacketSink(track).packets()) {
		times.push(packet.timestamp)
	}

	return times
}

// The video a start at `time` is remuxed to, every fragment of it.
async function remuxVideo(bytes: Buffer, time: number): Promise<{ keyTime: number; bytes: Uint8Array }> {
	const { port1, port2 } = new MessageChannel()
	const params = {
		port: port2,
		size: bytes.length,
		transcodeTargets: ["aac" as const],
		maxFragmentBytes: { video: 8_000_000, audio: 8_000_000 }
	}
	const segments: Uint8Array[] = []
	const ended = Promise.withResolvers<undefined>()

	exposeRangePort(port1, (start, end) => Promise.resolve(new Uint8Array(bytes.subarray(start, end))), new AbortController())

	const engine = new RemuxEngine(params, (event: RemuxEvent) => {
		if (event.type === "segment" && event.kind === "video") {
			segments.push(event.bytes)
		} else if (event.type === "ended" && event.kind === "video") {
			ended.resolve(undefined)
		} else if (event.type === "error") {
			ended.reject(new Error(event.message))
		}
	})

	try {
		await engine.open(params)

		const { video } = await engine.seek({ generation: 1, time, horizon: Number.POSITIVE_INFINITY, video: true, audio: null })

		await ended.promise

		return { keyTime: video?.keyTime ?? Number.NaN, bytes: Buffer.concat(segments) }
	} finally {
		await engine.close()
		port1.close()
	}
}

describe("legacy B-frame streams remuxed to fragmented MP4", () => {
	it("decode every picture no later than it is presented, from 0, and present each at its source time", async () => {
		for (const [name, format] of FILES) {
			const bytes = read(name)
			const source = await sourceTimes(bytes, format)

			// The fixtures do reorder pictures: some are presented before one decoded ahead of them.
			expect(
				source.some((time, index) => index > 0 && time < Math.max(...source.slice(0, index))),
				name
			).toBe(true)

			const output = await remuxVideo(bytes, 0)
			const { timescale, editMediaTime, samples } = fmp4Samples(output.bytes, Number.POSITIVE_INFINITY)

			expect(timescale, name).not.toBeNull()
			expect(samples, name).toHaveLength(source.length)
			expect(samples[0]?.dts, name).toBe(0)

			for (const [index, sample] of samples.entries()) {
				expect(sample.pts, `${name} #${String(index)}`).toBeGreaterThanOrEqual(sample.dts)
				expect(sample.trunVersion, `${name} #${String(index)}`).toBe(0)
			}

			// The edit list trims the lag back off: presentation starts at the key picture, each picture where the
			// source put it (to the track's timescale).
			const shift = editMediaTime ?? 0
			const tick = 1 / (timescale ?? 1)

			expect(Math.abs(Math.min(...samples.map(sample => sample.pts)) - shift - output.keyTime), name).toBeLessThanOrEqual(tick)

			// The lag is the SPS's bound: the first picture decodes that many frames (of 40 ms) before it shows.
			const reorder = videoReorderFrames("avc", null, new Uint8Array(bytes))

			expect(reorder, name).toBeGreaterThan(0)
			expect(Math.abs(shift + output.keyTime - (reorder ?? 0) * 0.04), name).toBeLessThanOrEqual(tick)

			for (const [index, sample] of samples.entries()) {
				expect(Math.abs(sample.pts - shift - (source[index] ?? Number.NaN)), `${name} #${String(index)}`).toBeLessThanOrEqual(tick)
			}
		}
	})

	it("keep the lag on a start past the first key picture, where no edit list is needed", async () => {
		for (const [name, format] of FILES) {
			const bytes = read(name)
			const source = await sourceTimes(bytes, format)
			const output = await remuxVideo(bytes, source.at(-1) ?? 0)
			const { timescale, editMediaTime, samples } = fmp4Samples(output.bytes, Number.POSITIVE_INFINITY)
			const tick = 1 / (timescale ?? 1)
			const from = source.indexOf(output.keyTime)

			expect(output.keyTime, name).toBeGreaterThan(source[0] ?? 0)
			expect(editMediaTime, name).toBeNull()
			expect(samples.length, name).toBeGreaterThan(0)

			for (const [index, sample] of samples.entries()) {
				expect(sample.pts, `${name} #${String(index)}`).toBeGreaterThanOrEqual(sample.dts)
				expect(sample.trunVersion, `${name} #${String(index)}`).toBe(0)
				expect(Math.abs(sample.pts - (source[from + index] ?? Number.NaN)), `${name} #${String(index)}`).toBeLessThanOrEqual(tick)
			}
		}
	})
})
