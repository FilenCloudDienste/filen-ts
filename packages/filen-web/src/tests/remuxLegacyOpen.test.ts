import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { BufferSource, Input } from "mediabunny"
import { exposeRangePort } from "@/lib/media/rangePort"
import { AVI } from "@/lib/media/demux/aviDemuxer"
import { ASF } from "@/lib/media/demux/asfDemuxer"
import { MPEG_PS } from "@/lib/media/demux/mpegPsDemuxer"

const { RemuxEngine } = await import("@/workers/remux/engine")

// The containers the app demuxes itself, opened as the remux worker opens a file: its video and its audio tracks asked
// for at once. Each track must keep the id mediabunny gives it by its place in the list it cached.

const FILES = [
	["h264-bframes-mp3.avi", AVI],
	["h264-mp3.asf", ASF],
	["h264-ac3.vob", MPEG_PS]
] as const

const read = (name: string): Buffer => readFileSync(new URL(`fixtures/demux/${name}`, import.meta.url))

describe("legacy containers opened for remuxing", () => {
	it("keep every track's id when the video and audio tracks are asked for together", async () => {
		for (const [name, format] of FILES) {
			const input = new Input({ formats: [format], source: new BufferSource(read(name)) })
			const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getAudioTracks()])

			expect(video?.id, name).toBe(1)
			expect(
				audio.map(track => track.id),
				name
			).toEqual([2])
		}
	})

	it("open in the remux engine with their video and audio", async () => {
		for (const [name] of FILES) {
			const bytes = read(name)
			const { port1, port2 } = new MessageChannel()
			const params = {
				port: port2,
				size: bytes.length,
				transcodeTargets: ["aac" as const],
				maxFragmentBytes: { video: 8_000_000, audio: 8_000_000 }
			}

			exposeRangePort(port1, (start, end) => Promise.resolve(new Uint8Array(bytes.subarray(start, end))), new AbortController())

			const engine = new RemuxEngine(params, () => undefined)

			try {
				const info = await engine.open(params)

				expect(info.video, name).not.toBeNull()
				expect(info.audio, name).toHaveLength(1)
			} finally {
				await engine.close()
			}
		}
	})
})
