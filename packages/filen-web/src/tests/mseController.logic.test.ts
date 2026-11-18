import { describe, expect, it } from "vitest"
import {
	aheadSeconds,
	backBufferEviction,
	evictedAhead,
	shouldEndStream,
	TimelineOps,
	trackBitrate,
	unionRanges,
	recentEvictions,
	browserEngine,
	forwardBuffered,
	initialAudio,
	isAudioOnlySession,
	playableRanges,
	sessionAhead,
	bufferedAhead,
	bufferLimits,
	intersectRanges,
	needsMore,
	quotaAction,
	rangesOutside,
	seekPlan,
	stallAction,
	startTarget,
	supportedCopyCodec
} from "@/lib/media/mseController.logic"

const MiB = 1_048_576

describe("browserEngine", () => {
	it("tells the three engines apart, Chromium-based Edge included", () => {
		expect(browserEngine("Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/157.0")).toBe("firefox")
		expect(browserEngine("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/156.0 Safari/537.36 Edg/155.0")).toBe("chromium")
		expect(browserEngine("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15")).toBe("webkit")
	})
})

describe("bufferLimits", () => {
	it("uses Chromium's tiers by device class", () => {
		expect(bufferLimits({ engine: "chromium", mobile: false, deviceMemoryGiB: 2 })).toEqual({ video: 150 * MiB, audio: 12 * MiB })
		expect(bufferLimits({ engine: "chromium", mobile: true, deviceMemoryGiB: 8 })).toEqual({ video: 80 * MiB, audio: 5 * MiB })
		expect(bufferLimits({ engine: "chromium", mobile: true, deviceMemoryGiB: 2 })).toEqual({ video: 30 * MiB, audio: 2 * MiB })
		expect(bufferLimits({ engine: "chromium", mobile: true, deviceMemoryGiB: 1 })).toEqual({ video: 15 * MiB, audio: MiB })
		expect(bufferLimits({ engine: "firefox", mobile: false, deviceMemoryGiB: null })).toEqual({ video: 150 * MiB, audio: 20 * MiB })
	})
})

describe("aheadSeconds", () => {
	it("fills at most 60% of the limit, within 10 to 60 seconds", () => {
		// 5 Mb/s: 60% of 150 MiB lasts far longer than a minute.
		expect(aheadSeconds({ limitBytes: 150 * MiB, bitrate: 5_000_000, scale: 1 })).toBe(60)
		// 40 Mb/s: 0.6 * 150 MiB * 8 / 40e6 ≈ 18.9 s.
		expect(aheadSeconds({ limitBytes: 150 * MiB, bitrate: 40_000_000, scale: 1 })).toBeCloseTo(18.87, 1)
		// 80 Mb/s on a low-end device: never below 10 s.
		expect(aheadSeconds({ limitBytes: 15 * MiB, bitrate: 80_000_000, scale: 1 })).toBe(10)
		expect(aheadSeconds({ limitBytes: 150 * MiB, bitrate: 0, scale: 1 })).toBe(60)
	})

	it("shrinks with the quota scale", () => {
		expect(aheadSeconds({ limitBytes: 150 * MiB, bitrate: 40_000_000, scale: 0.7 })).toBeCloseTo(13.21, 1)
	})
})

describe("needsMore", () => {
	it("resumes below half the window", () => {
		expect(needsMore({ bufferedAhead: 29, ahead: 60 })).toBe(true)
		expect(needsMore({ bufferedAhead: 31, ahead: 60 })).toBe(false)
	})
})

describe("bufferedAhead", () => {
	it("follows contiguous ranges across holes up to the tolerance", () => {
		const ranges = [
			[0, 5],
			[5.05, 9],
			[12, 20]
		] as const

		expect(bufferedAhead(ranges, 2)).toBe(7)
		expect(bufferedAhead(ranges, 10)).toBe(0)
		expect(bufferedAhead(ranges, 2, 0)).toBe(3)
	})
})

describe("intersectRanges", () => {
	it("is where both tracks are buffered", () => {
		expect(
			intersectRanges(
				[
					[0, 10],
					[20, 30]
				],
				[
					[2, 25],
					[28, 40]
				]
			)
		).toEqual([
			[2, 10],
			[20, 25],
			[28, 30]
		])
	})
})

describe("backBufferEviction", () => {
	const base = { currentTime: 100, bufferedStart: 0, now: 40_000, lastEvictionAt: 0, fillShare: 0.2 }

	it("removes what lies more than 10 s behind the playhead, at most every 30 s", () => {
		expect(backBufferEviction(base)).toEqual([0, 90])
		expect(backBufferEviction({ ...base, lastEvictionAt: 20_000 })).toBeNull()
	})

	it("removes early when the buffer is filling up, but never twice within a few seconds", () => {
		expect(backBufferEviction({ ...base, lastEvictionAt: 20_000, fillShare: 0.75 })).toEqual([0, 90])
		expect(backBufferEviction({ ...base, lastEvictionAt: 38_000, fillShare: 0.95 })).toBeNull()
	})

	it("keeps a back buffer of 10 s and skips slivers under a second", () => {
		expect(backBufferEviction({ ...base, currentTime: 8 })).toBeNull()
		expect(backBufferEviction({ ...base, currentTime: 10.5 })).toBeNull()
	})
})

describe("trackBitrate", () => {
	it("measures from appended bytes once there is a second of media, falling back before", () => {
		expect(trackBitrate({ bytes: 1_000_000, seconds: 4, fallback: 5 })).toBe(2_000_000)
		expect(trackBitrate({ bytes: 1_000, seconds: 0.2, fallback: 192_000 })).toBe(192_000)
		expect(trackBitrate({ bytes: 0, seconds: 0, fallback: 0 })).toBe(0)
	})
})

describe("quotaAction", () => {
	it("first evicts up to 2 s behind the playhead, then shrinks the window", () => {
		const ranges = [[0, 60]] as const

		expect(quotaAction({ attempt: 0, currentTime: 30, ranges, scale: 1 })).toEqual({ type: "evict", range: [0, 28] })
		expect(quotaAction({ attempt: 1, currentTime: 30, ranges, scale: 1 })).toEqual({ type: "shrink", scale: 0.7 })
	})

	it("fails when the segment alone does not fit", () => {
		expect(quotaAction({ attempt: 0, currentTime: 0, ranges: [], scale: 1 })).toEqual({ type: "fatal" })
		// Behind the playhead was already given back and nothing is buffered ahead of it.
		expect(quotaAction({ attempt: 1, currentTime: 5, ranges: [[3, 5]], scale: 1 })).toEqual({ type: "fatal" })
	})
})

describe("startTarget", () => {
	it("keeps the time asked for, once a key picture at or before it starts playback", () => {
		expect(startTarget(12, { video: { keyTime: 10, clamped: false }, audio: { startTime: 10 } })).toBe(12)
	})

	it("moves a time before the first picture onto it", () => {
		// A transport stream whose first picture is at 1.41 s, looped back to 0.
		expect(startTarget(0, { video: { keyTime: 1.41, clamped: false }, audio: { startTime: 1.4 } })).toBe(1.41)
	})

	it("moves to where a file without an index could be seeked", () => {
		expect(startTarget(50, { video: { keyTime: 20, clamped: true }, audio: null })).toBe(20)
	})

	it("starts audio alone where its first sound is", () => {
		expect(startTarget(0, { video: null, audio: { startTime: 1.5 } })).toBe(1.5)
		expect(startTarget(5, { video: null, audio: { startTime: 4.9 } })).toBe(5)
	})

	it("finds even a lead of a few milliseconds", () => {
		// An MPEG-PS whose first picture is at 5.3 ms.
		expect(startTarget(0, { video: { keyTime: 0.0053, clamped: false }, audio: { startTime: 0 } })).toBe(0.0053)
	})
})

describe("seekPlan", () => {
	it("plays from the buffer when both tracks hold half a second past the target", () => {
		const video = [[0, 30]] as const

		expect(seekPlan({ time: 10, video, audio: [[0, 30]] })).toBe("inBuffer")
		expect(seekPlan({ time: 10, video, audio: [[0, 10.2]] })).toBe("restart")
		expect(seekPlan({ time: 40, video, audio: null })).toBe("restart")
		expect(seekPlan({ time: 29.8, video, audio: null })).toBe("restart")
	})
})

describe("rangesOutside", () => {
	it("is what lies outside the kept window", () => {
		expect(
			rangesOutside(
				[
					[0, 20],
					[50, 100]
				],
				10,
				60
			)
		).toEqual([
			[0, 10],
			[60, 100]
		])
	})
})

describe("stallAction", () => {
	it("skips a small hole at once and a large one only once stalled", () => {
		const ranges = [[10.05, 30]] as const

		const small = stallAction({ currentTime: 10, ranges, stalledMs: 0, nudges: 0 })
		const large = stallAction({ currentTime: 9, ranges, stalledMs: 1250, nudges: 0 })

		expect(small.type).toBe("skip")
		expect(small.type === "skip" ? small.to : 0).toBeCloseTo(10.1, 6)
		expect(stallAction({ currentTime: 9, ranges, stalledMs: 300, nudges: 0 })).toEqual({ type: "none" })
		expect(large.type).toBe("skip")
		expect(large.type === "skip" ? large.to : 0).toBeCloseTo(10.1, 6)
	})

	it("nudges a playhead stuck inside buffered data, then gives up after three tries", () => {
		const ranges = [[0, 30]] as const

		expect(stallAction({ currentTime: 10, ranges, stalledMs: 1000, nudges: 0 })).toEqual({ type: "none" })
		const first = stallAction({ currentTime: 10, ranges, stalledMs: 1250, nudges: 0 })
		const third = stallAction({ currentTime: 10, ranges, stalledMs: 1250, nudges: 2 })

		expect(first.type === "nudge" ? first.to : 0).toBeCloseTo(10.1, 6)
		expect(third.type === "nudge" ? third.to : 0).toBeCloseTo(10.3, 6)
		expect(stallAction({ currentTime: 10, ranges, stalledMs: 1250, nudges: 3 })).toEqual({ type: "fatal" })
	})

	it("waits when nothing is buffered ahead", () => {
		expect(stallAction({ currentTime: 31, ranges: [[0, 30]], stalledMs: 5000, nudges: 0 })).toEqual({ type: "none" })
	})
})

describe("evictedAhead", () => {
	it("spots a hole the browser cut into what this fetch had buffered", () => {
		const ranges = [
			[0, 10.03],
			[30, 40]
		] as const

		expect(evictedAhead({ currentTime: 10, ranges, seen: [[0, 40]] })).toBe(true)
	})

	it("leaves a gap in the file itself, never buffered, to the gap handling", () => {
		const ranges = [
			[0, 10.03],
			[12, 40]
		] as const

		expect(
			evictedAhead({
				currentTime: 10,
				ranges,
				seen: [
					[0, 10.03],
					[12, 40]
				]
			})
		).toBe(false)
	})

	it("ignores a forward buffer that is long enough", () => {
		expect(
			evictedAhead({
				currentTime: 10,
				ranges: [
					[0, 25],
					[30, 40]
				],
				seen: [[0, 40]]
			})
		).toBe(false)
	})
})

describe("unionRanges", () => {
	it("merges overlapping and touching ranges in order", () => {
		expect(
			unionRanges(
				[
					[10, 20],
					[0, 5]
				],
				[
					[4, 8],
					[20, 25],
					[30, 31]
				]
			)
		).toEqual([
			[0, 8],
			[10, 25],
			[30, 31]
		])
	})
})

describe("shouldEndStream", () => {
	const done = { ended: true, idle: true, updating: false }

	it("ends once every track with a SourceBuffer has its last segment in", () => {
		expect(shouldEndStream({ open: true, tracks: [done, done] })).toBe(true)
		expect(shouldEndStream({ open: true, tracks: [done, null] })).toBe(true)
	})

	it("waits for a track still appending, still updating or not yet ended, and for an open source", () => {
		expect(shouldEndStream({ open: true, tracks: [done, { ...done, idle: false }] })).toBe(false)
		expect(shouldEndStream({ open: true, tracks: [{ ...done, updating: true }, done] })).toBe(false)
		expect(shouldEndStream({ open: true, tracks: [{ ...done, ended: false }, done] })).toBe(false)
		expect(shouldEndStream({ open: false, tracks: [done, done] })).toBe(false)
	})
})

describe("TimelineOps", () => {
	function deferred() {
		return Promise.withResolvers<undefined>()
	}

	it("runs restarts one at a time and coalesces a burst to the latest target", async () => {
		const started: number[] = []
		const gates: ReturnType<typeof deferred>[] = []
		const ops = new TimelineOps({
			restart: time => {
				started.push(time)

				const gate = deferred()

				gates.push(gate)

				return gate.promise
			},
			onRestartError: () => undefined
		})

		ops.restart(1)
		await Promise.resolve()

		for (let time = 2; time <= 30; time++) {
			ops.restart(time)
		}

		expect(started).toEqual([1])

		gates[0]?.resolve(undefined)
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(started).toEqual([1, 30])

		gates[1]?.resolve(undefined)
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(ops.busy).toBe(false)
	})

	it("reports a failed restart as superseded when a newer one is waiting", async () => {
		const reports: boolean[] = []
		const gate = deferred()
		let calls = 0
		const ops = new TimelineOps({
			restart: async () => {
				calls++

				if (calls === 1) {
					await gate.promise

					throw new Error("old seek failed")
				}
			},
			onRestartError: (_error, superseded) => {
				reports.push(superseded)
			}
		})

		ops.restart(1)
		await Promise.resolve()
		ops.restart(2)
		gate.resolve(undefined)
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(reports).toEqual([true])
		expect(calls).toBe(2)
	})

	it("queues other operations behind a restart in flight", async () => {
		const order: string[] = []
		const gate = deferred()
		const ops = new TimelineOps({
			restart: async () => {
				order.push("restart")
				await gate.promise
			},
			onRestartError: () => undefined
		})

		ops.restart(5)
		await Promise.resolve()

		const switched = ops.run(() => {
			order.push("switch")

			return Promise.resolve()
		})

		gate.resolve(undefined)
		await switched

		expect(order).toEqual(["restart", "switch"])
	})
})

describe("recentEvictions", () => {
	it("keeps only refetches within the last minute", () => {
		expect(recentEvictions([0, 30_000, 59_000], 90_000)).toEqual([59_000])
	})
})

describe("audio alone", () => {
	const limits = { video: 150 * MiB, audio: 12 * MiB }

	it("plays audio alone on an element without a picture, or for a file without a video track", () => {
		expect(isAudioOnlySession({ elementShowsVideo: false, hasVideoTrack: true })).toBe(true)
		expect(isAudioOnlySession({ elementShowsVideo: true, hasVideoTrack: false })).toBe(true)
		// An unplayable video track on a <video> element fails rather than playing as sound.
		expect(isAudioOnlySession({ elementShowsVideo: true, hasVideoTrack: true })).toBe(false)
	})

	it("plans seeks from the audio buffer alone", () => {
		expect(seekPlan({ time: 10, video: null, audio: [[0, 30]] })).toBe("inBuffer")
		expect(seekPlan({ time: 10, video: null, audio: [[0, 10.2]] })).toBe("restart")
		expect(seekPlan({ time: 40, video: null, audio: [[0, 30]] })).toBe("restart")
	})

	it("counts only the tracks played as playable and as forward buffer", () => {
		const audio: [number, number][] = [
			[0, 20],
			[25, 40]
		]

		expect(playableRanges(null, audio)).toEqual(audio)
		expect(playableRanges([[5, 30]], null)).toEqual([[5, 30]])
		expect(playableRanges([[5, 30]], audio)).toEqual([
			[5, 20],
			[25, 30]
		])
		expect(playableRanges(null, null)).toEqual([])
		expect(forwardBuffered(10, null, audio)).toBe(10)
		expect(forwardBuffered(10, [[0, 15]], audio)).toBe(5)
		expect(forwardBuffered(10, null, null)).toBe(0)
	})

	it("sizes the window by the audio buffer's limit and the track's bitrate", () => {
		// 0.6 * 12 MiB * 8 / 1411.2 kb/s (CD-quality PCM) ≈ 42.8 s.
		expect(sessionAhead({ audioOnly: true, limits, fileBitrate: 40_000_000, audioBitrate: 1_411_200, scale: 1 })).toBeCloseTo(42.8, 1)
		expect(sessionAhead({ audioOnly: true, limits, fileBitrate: 40_000_000, audioBitrate: 128_000, scale: 1 })).toBe(60)
		// A 1 MiB audio buffer (low-memory Android) still keeps the 10 s floor.
		expect(
			sessionAhead({ audioOnly: true, limits: { video: 15 * MiB, audio: MiB }, fileBitrate: 0, audioBitrate: 1_411_200, scale: 1 })
		).toBe(10)
		// With video, the file's bitrate against the video buffer, as before.
		expect(sessionAhead({ audioOnly: false, limits, fileBitrate: 40_000_000, audioBitrate: 128_000, scale: 1 })).toBeCloseTo(18.87, 1)
	})

	it("starts the chosen track, or the default one with its mode left to the page", () => {
		const tracks = [
			{ id: 1, isDefault: false },
			{ id: 2, isDefault: true }
		]

		expect(initialAudio({ tracks, chosen: { trackId: 1, mode: "transcode" }, audioOnly: false })).toEqual({
			trackId: 1,
			mode: "transcode"
		})
		expect(initialAudio({ tracks, chosen: undefined, audioOnly: false })).toEqual({ trackId: 2, mode: null })
		expect(initialAudio({ tracks, chosen: { trackId: 9, mode: "copy" }, audioOnly: false })).toEqual({ trackId: 2, mode: null })
		expect(initialAudio({ tracks: [{ id: 4, isDefault: false }], chosen: undefined, audioOnly: true })).toEqual({
			trackId: 4,
			mode: null
		})
		expect(initialAudio({ tracks: [], chosen: undefined, audioOnly: true })).toBeNull()
	})

	it("plays video alone when asked, but never nothing when audio is all there is", () => {
		const tracks = [{ id: 3, isDefault: true }]

		expect(initialAudio({ tracks, chosen: { trackId: -1, mode: "none" }, audioOnly: false })).toBeNull()
		expect(initialAudio({ tracks, chosen: { trackId: -1, mode: "none" }, audioOnly: true })).toEqual({ trackId: 3, mode: null })
	})
})

describe("supportedCopyCodec", () => {
	const takes =
		(...codecs: string[]) =>
		(mime: string) =>
			codecs.some(codec => mime === `audio/mp4; codecs="${codec}"`)

	it("finds the spelling of MP3 each engine takes, so the copy path is not given up for a re-encode", () => {
		expect(supportedCopyCodec("mp3", takes("mp4a.6B", "mp4a.69"))).toBe("mp4a.6B")
		expect(supportedCopyCodec("mp3", takes("mp4a.69"))).toBe("mp4a.69")
		expect(supportedCopyCodec("mp3", takes("mp3"))).toBe("mp3")
		expect(supportedCopyCodec("mp3", takes("opus"))).toBeNull()
	})

	it("keeps the track's own spelling when it is taken, and tries no others for a codec that has none", () => {
		expect(supportedCopyCodec("flac", takes("flac", "fLaC"))).toBe("flac")
		expect(supportedCopyCodec("flac", takes("fLaC"))).toBe("fLaC")
		expect(supportedCopyCodec("mp4a.40.2", takes("mp4a.40.2"))).toBe("mp4a.40.2")
		expect(supportedCopyCodec("mp4a.40.2", takes("mp4a.40.5"))).toBeNull()
	})
})
