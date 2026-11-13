import { describe, expect, it } from "vitest"
import type { VideoProbe } from "@filen/shared/videos"
import {
	BucketState,
	PriorityLock,
	WAVEFORM_MAX_BUCKETS,
	WaveformBuckets,
	filmstripSize,
	hasLocationTag,
	pickFrame,
	planFilmstrip,
	rotationOf,
	sourceInfo,
	type DemuxedFacts
} from "@/features/preview/videoEdit/worker/preview.logic"

class Frame {
	public closed = false
	public readonly timestamp: number

	public constructor(timestamp: number) {
		this.timestamp = timestamp
	}

	public close(): void {
		this.closed = true
	}
}

describe("pickFrame", () => {
	it("returns the exact frame, closing the ones before it and keeping the ones after", () => {
		const queue = [new Frame(10), new Frame(20), new Frame(30)]
		const [a, b, c] = queue
		const candidate = { frame: null as Frame | null }

		expect(pickFrame(queue, 20, candidate)).toBe(b)
		expect(a?.closed).toBe(true)
		expect(queue).toEqual([c])
		expect(candidate.frame).toBeNull()
	})

	it("keeps the closest earlier frame as the candidate while the target has not come", () => {
		const queue = [new Frame(10), new Frame(20)]
		const candidate = { frame: null as Frame | null }

		expect(pickFrame(queue, 25, candidate)).toBeNull()
		expect(candidate.frame?.timestamp).toBe(20)
		expect(queue).toHaveLength(0)
	})

	it("answers with the candidate when a later frame shows the target will not come", () => {
		const queue = [new Frame(30)]
		const earlier = new Frame(20)
		const candidate = { frame: earlier as Frame | null }

		expect(pickFrame(queue, 25, candidate)).toBe(earlier)
		expect(queue).toHaveLength(1)
		expect(pickFrame([new Frame(40)], 35, { frame: null })?.timestamp).toBe(40)
	})
})

describe("planFilmstrip", () => {
	it("shares a keyframe between the times it stands for, in time order, within the cap", () => {
		expect(planFilmstrip([4, 0, 4, null, 8, 2], 3)).toEqual([
			{ keyTime: 0, positions: [1] },
			{ keyTime: 4, positions: [0, 2] },
			{ keyTime: 8, positions: [4] }
		])
	})

	it("sizes stills by height in display orientation", () => {
		expect(filmstripSize({ width: 1920, height: 1080 }, 54)).toEqual({ width: 96, height: 54 })
		expect(filmstripSize({ width: 1080, height: 1920 }, 64)).toEqual({ width: 36, height: 64 })
	})
})

describe("PriorityLock", () => {
	it("lets one holder in at a time, interactive waiters before background ones", async () => {
		const lock = new PriorityLock()
		const order: string[] = []
		const first = await lock.acquire("background")
		const background = lock.acquire("background").then(release => {
			order.push("background")
			release()
		})
		const interactive = lock.acquire("interactive").then(release => {
			order.push("interactive")
			release()
		})

		expect(lock.waiting).toEqual({ interactive: 1, background: 1 })
		first()
		first()
		await Promise.all([background, interactive])

		expect(order).toEqual(["interactive", "background"])
	})
})

describe("WaveformBuckets", () => {
	it("caps the bucket count for long files", () => {
		expect(new WaveformBuckets(10).count).toBe(200)
		expect(new WaveformBuckets(4 * 3600).count).toBe(WAVEFORM_MAX_BUCKETS)
	})

	it("reads out columns as the loudest known bucket, NaN where nothing is known", () => {
		const buckets = new WaveformBuckets(10)

		buckets.done(0, 0.5)
		buckets.done(1, 0.25)
		buckets.done(150, 2)

		const columns = buckets.columns({ start: 0, end: 10 }, 10)

		expect(columns[0]).toBe(0.5)
		expect(Number.isNaN(columns[1])).toBe(true)
		// Clamped to 1.
		expect(columns[7]).toBe(1)

		// Zoomed in past the bucket width: each column takes its bucket's value.
		const zoomed = buckets.columns({ start: 0, end: 0.1 }, 4)

		expect(Array.from(zoomed)).toEqual([0.5, 0.5, 0.25, 0.25])
	})

	it("picks pending buckets whose bytes landed and unknown ones between known offsets", () => {
		const buckets = new WaveformBuckets(10)

		buckets.pending(10, 1000)
		buckets.pending(20, 5000)
		buckets.pending(30, 9000)
		buckets.done(25, 0.1)

		const candidates = buckets.candidatesFor(4000, 6000)

		expect(candidates).toContain(20)
		expect(candidates).not.toContain(25)
		expect(candidates).not.toContain(10)
		expect(Math.min(...candidates)).toBeGreaterThanOrEqual(10)
		expect(Math.max(...candidates)).toBeLessThanOrEqual(30)
		expect(buckets.state(20)).toBe(BucketState.Pending)
	})

	it("sweeps a skeleton of unknown buckets", () => {
		const buckets = new WaveformBuckets(10)

		buckets.failed(32)

		expect(buckets.skeleton(32)).toEqual([0, 64, 96, 128, 160, 192])
	})
})

describe("source facts", () => {
	it("finds location tags", () => {
		expect(hasLocationTag({ "©xyz": "+52.5+013.4/" })).toBe(true)
		expect(hasLocationTag({ "com.apple.quicktime.location.ISO6709": "+52.5+013.4/" })).toBe(true)
		expect(hasLocationTag({ LOCATION: "Berlin" })).toBe(true)
		expect(hasLocationTag({ title: "Holiday", "©day": "2024" })).toBe(false)
		expect(hasLocationTag(undefined)).toBe(false)
	})

	it("normalises rotations", () => {
		expect(rotationOf(-90)).toBe(270)
		expect(rotationOf(450)).toBe(90)
		expect(rotationOf(0)).toBe(0)
	})

	it("combines the probe and the demuxer", () => {
		const facts: DemuxedFacts = {
			duration: 9.5,
			displayWidth: 1080,
			displayHeight: 1920,
			rotation: 90,
			frameRate: 29.97,
			videoCodec: "hvc1.2.4.L153.B0",
			colorTransfer: "hlg",
			keyframes: Float64Array.from([0, 1]),
			audio: [{ number: 1, codec: "aac", channels: 2, language: null }],
			formatName: "QuickTime File Format",
			hasSubtitleTracks: false,
			metadataRaw: { "com.apple.quicktime.location.ISO6709": "+1+2/" },
			previewable: true
		}
		const probe = {
			v: 1,
			container: "mov",
			durationSec: 10,
			index: "moov",
			video: {
				codec: "hevc",
				fourcc: "hvc1",
				codecString: null,
				w: 1920,
				h: 1080,
				par: 1,
				rotation: 90,
				bitDepth: 10,
				transfer: "hlg"
			},
			audio: [],
			subs: [{ id: 3, codecId: "tx3g", lang: null, name: null, def: false, forced: false, hi: false }],
			chapters: [],
			cover: null,
			partial: false
		} satisfies VideoProbe

		expect(sourceInfo(probe, facts, 1234)).toEqual({
			duration: 10,
			width: 1080,
			height: 1920,
			rotation: 90,
			frameRate: 29.97,
			videoCodec: "hvc1.2.4.L153.B0",
			transfer: "hlg",
			bitDepth: 10,
			keyframes: facts.keyframes,
			audio: facts.audio,
			container: "mov",
			hasSubtitles: true,
			hasChapters: false,
			hasLocation: true,
			bytes: 1234,
			previewable: true
		})

		expect(sourceInfo(null, { ...facts, colorTransfer: null, metadataRaw: undefined }, 1).container).toBe("quicktime-file-format")
		expect(sourceInfo(null, { ...facts, colorTransfer: null }, 1).transfer).toBe("sdr")
	})
})
