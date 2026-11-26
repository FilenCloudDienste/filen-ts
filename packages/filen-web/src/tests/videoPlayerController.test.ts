import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PlaybackSnapshot } from "@/lib/media/playback/openPlayback"
import type { PlaybackTrigger } from "@/lib/media/playback/types"
import { MAX_SUBTITLE_CUES, type ProbeAudio, type VideoProbe } from "@filen/shared/videos"
import type { RemuxTextCue } from "@/lib/media/remuxTypes"
import type { WatchItemTarget } from "@/features/videos/lib/player/watchTarget.logic"

const mocks = vi.hoisted(() => {
	const playbacks: {
		status: string
		listeners: Set<() => void>
		disposed: boolean
		startTime: number
		audioIndex: number
		subtitle: string
		onTextCues: ((cues: RemuxTextCue[]) => void) | undefined
	}[] = []
	const failure: { trigger: PlaybackTrigger } = { trigger: "network" }

	return {
		playbacks,
		probe: null as VideoProbe | null,
		failure,
		onOpen: null as (() => void) | null,
		openPlayback: vi.fn(),
		reachable: vi.fn(() => Promise.resolve(true)),
		watchOpen: vi.fn(() => Promise.resolve()),
		reportProgress: vi.fn(),
		reportStop: vi.fn(() => Promise.resolve()),
		dropPlayback: vi.fn(),
		playableFiles: vi.fn()
	}
})

vi.mock("@/lib/media/playback/openPlayback", () => ({
	openPlayback: mocks.openPlayback,
	embeddedTextReachable: mocks.reachable
}))
vi.mock("@/features/videos/lib/index", () => ({ videoLibrary: { playableFiles: mocks.playableFiles } }))
vi.mock("@/features/videos/lib/probeService", () => ({
	probeService: { request: () => Promise.resolve({ probe: mocks.probe ?? PROBE }) }
}))
vi.mock("@/features/videos/lib/watchState", () => ({
	watchState: {
		open: mocks.watchOpen,
		getSnapshot: () => ({ doc: { v: 1, items: {}, series: {} } }),
		reportProgress: mocks.reportProgress,
		reportStop: mocks.reportStop,
		dropPlayback: mocks.dropPlayback,
		setSeriesLanguages: () => Promise.resolve()
	}
}))
vi.mock("@/features/videos/lib/frames", () => ({ captureFrameFromVideo: () => Promise.resolve(null) }))
vi.mock("@/features/videos/lib/artwork", () => ({ storeCapturedFrame: () => Promise.resolve() }))

import {
	AUTO_RETRY_DELAYS_MS,
	PlayerController,
	WATCH_STATE_WAIT_MS,
	isPassingFailure
} from "@/features/videos/lib/player/playerController"
import { MAX_EMBEDDED_CUE_CHARS, embeddedCueCharge } from "@/workers/remux/textTap"

const PROBE: VideoProbe = {
	v: 1,
	container: "mp4",
	durationSec: 3600,
	index: "moov",
	video: null,
	audio: [],
	subs: [],
	chapters: [],
	cover: null,
	coverLand: null,
	partial: false
}

const TARGET: WatchItemTarget = {
	key: "movie",
	titleId: "title",
	titleName: "Movie",
	kind: "movie",
	itemClass: "movie",
	versionLabel: "",
	parts: [
		{
			file: { stableUuid: "movie", uuid: "movie-u", name: "Movie.mp4", size: 1000 },
			container: "mp4",
			unsupported: false,
			height: 1080,
			subtitles: [],
			nfo: null,
			thumb: null,
			edl: null
		}
	],
	episode: null,
	seriesDirUuid: null
}

// A media element as far as the controller reads it.
class FakeVideo extends EventTarget {
	public readonly HAVE_METADATA = 1
	public currentTime = 0
	public duration = Number.NaN
	public readyState = 0
	public paused = true
	public ended = false
	public seeking = false
	public refusePlay = false
	public play = vi.fn(() => {
		if (this.refusePlay) {
			return Promise.reject(new DOMException("no activation", "NotAllowedError"))
		}

		this.paused = false
		this.dispatchEvent(new Event("play"))

		return Promise.resolve()
	})
	public pause(): void {
		this.paused = true
		this.dispatchEvent(new Event("pause"))
	}

	public loaded(time: number): void {
		this.readyState = 4
		this.duration = 3600
		this.currentTime = time
		this.dispatchEvent(new Event("loadedmetadata"))
	}

	public tick(time: number): void {
		this.currentTime = time
		this.dispatchEvent(new Event("timeupdate"))
	}
}

function playbackFor(index: number) {
	const entry = mocks.playbacks[index]

	if (entry === undefined) {
		throw new Error("no playback")
	}

	return entry
}

function setStatus(index: number, status: string): void {
	const entry = playbackFor(index)

	entry.status = status

	for (const listener of entry.listeners) {
		listener()
	}
}

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve()
	}
}

let video: FakeVideo
let controller: PlayerController

beforeEach(() => {
	mocks.playbacks.length = 0
	mocks.probe = null
	mocks.failure.trigger = "network"
	mocks.onOpen = null
	mocks.reachable.mockImplementation(() => Promise.resolve(true))
	mocks.watchOpen.mockImplementation(() => Promise.resolve())
	mocks.openPlayback.mockImplementation(
		(
			_video: unknown,
			_file: unknown,
			_probe: unknown,
			selection: { audioIndex: number; subtitle: string },
			options: { startTime: number; onTextCues?: (cues: RemuxTextCue[]) => void }
		) => {
			const entry = {
				status: "opening",
				listeners: new Set<() => void>(),
				disposed: false,
				startTime: options.startTime,
				audioIndex: selection.audioIndex,
				subtitle: selection.subtitle,
				onTextCues: options.onTextCues
			}

			mocks.playbacks.push(entry)
			mocks.onOpen?.()

			return Promise.resolve({
				getSnapshot: (): PlaybackSnapshot => ({
					status: entry.status as PlaybackSnapshot["status"],
					decision: { path: "direct", reasons: [], audio: { mode: "native" } },
					selection: { audioIndex: selection.audioIndex, subtitle: "none" },
					failure: entry.status === "failed" ? { trigger: mocks.failure.trigger, detail: "test" } : null,
					demotions: 0
				}),
				subscribe: (listener: () => void) => {
					entry.listeners.add(listener)

					return () => entry.listeners.delete(listener)
				},
				selectAudio: () => Promise.resolve(),
				firstTime: () => 0.5,
				dispose: () => {
					entry.disposed = true
				}
			})
		}
	)
	mocks.playableFiles.mockResolvedValue([{ uuid: "movie-u", stableUUID: "movie", size: 1000n }])
	video = new FakeVideo()
	controller = new PlayerController()
	controller.attach(video as unknown as HTMLVideoElement)
})

afterEach(() => {
	controller.dispose()
	vi.useRealTimers()
})

async function openPlaying(time: number): Promise<void> {
	await controller.open({ target: TARGET, start: "resume", autoplay: false })
	video.loaded(time)
	setStatus(0, "ready")
	video.paused = false
	video.tick(time)
}

describe("PlayerController and the watch state", () => {
	it("drops the engine's playback when an item closes before it played (never journals a fake 0)", async () => {
		await controller.open({ target: TARGET, start: "resume", autoplay: false })
		setStatus(0, "failed")
		controller.stop()

		expect(mocks.reportStop).not.toHaveBeenCalled()
		expect(mocks.reportProgress).not.toHaveBeenCalled()
		expect(mocks.dropPlayback).toHaveBeenCalledWith({ stableUuid: "movie" })
	})

	it("ends a failed item at the last position it really reported", async () => {
		await openPlaying(1200)
		setStatus(0, "failed")
		// A failed element reads 0 from now on.
		video.currentTime = 0
		video.tick(0)
		controller.stop()

		expect(mocks.reportProgress).toHaveBeenCalledTimes(1)
		expect(mocks.reportStop).toHaveBeenCalledWith(expect.objectContaining({ pos: 1200, dur: 3600 }))
		expect(mocks.dropPlayback).not.toHaveBeenCalled()
	})

	it("retries at the last real position, not at the element's 0", async () => {
		await openPlaying(1500)
		setStatus(0, "failed")
		video.currentTime = 0
		await controller.retry()

		expect(mocks.playbacks[1]?.startTime).toBe(1500)
		expect(mocks.reportStop).toHaveBeenCalledWith(expect.objectContaining({ pos: 1500 }))
	})

	it("retries at the resume point when nothing played yet", async () => {
		await controller.open({ target: TARGET, start: "resume", autoplay: false })
		setStatus(0, "failed")
		await controller.retry()

		expect(mocks.playbacks[1]?.startTime).toBe(0)
	})

	it("reports a finish (Up Next past the credits) as played to the end, once", async () => {
		await openPlaying(3500)
		controller.finish()
		controller.stop()

		expect(mocks.reportStop).toHaveBeenCalledTimes(1)
		expect(mocks.reportStop).toHaveBeenCalledWith(expect.objectContaining({ pos: 3500, ended: true }))
	})

	it("starts without waiting more than 1.5 s for the watch state, and not at all for a part switch", async () => {
		vi.useFakeTimers()
		mocks.watchOpen.mockReturnValue(new Promise(() => undefined))

		const opening = controller.open({ target: TARGET, start: "resume", autoplay: false })

		await vi.advanceTimersByTimeAsync(WATCH_STATE_WAIT_MS - 100)
		expect(mocks.openPlayback).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(200)
		await opening
		expect(mocks.openPlayback).toHaveBeenCalledTimes(1)

		mocks.watchOpen.mockClear()
		await controller.open({ target: TARGET, start: "resume", autoplay: false }, { part: 0, position: 10 })
		expect(mocks.watchOpen).not.toHaveBeenCalled()
		expect(mocks.openPlayback).toHaveBeenCalledTimes(2)
	})
})

describe("PlayerController repeat", () => {
	it("reports the ended item watched once, then plays it again from its start on the same playback as a new session", async () => {
		controller.setOnEnded(() => {
			controller.replay()
		})
		await openPlaying(3599)

		const epoch = controller.getSnapshot().epoch

		video.paused = true
		video.ended = true
		video.currentTime = 3600
		video.dispatchEvent(new Event("ended"))

		expect(mocks.reportStop).toHaveBeenCalledTimes(1)
		expect(mocks.reportStop).toHaveBeenCalledWith(expect.objectContaining({ pos: 3600, ended: true }))
		expect(mocks.openPlayback).toHaveBeenCalledTimes(1)
		expect(video.currentTime).toBe(0.5)
		expect(video.play).toHaveBeenCalled()
		expect(controller.getSnapshot().epoch).toBe(epoch + 1)
		expect(controller.getSnapshot().resumedAt).toBeNull()

		mocks.reportProgress.mockClear()
		video.ended = false
		video.tick(5)

		expect(mocks.reportProgress).toHaveBeenCalledWith(expect.objectContaining({ pos: 5 }))
	})
})

describe("PlayerController autoplay", () => {
	it("reports a refused play, clears it on the element's play, and plays through the controller", async () => {
		video.refusePlay = true
		await controller.open({ target: TARGET, start: "resume", autoplay: true })
		video.loaded(0)
		await flush()

		expect(controller.getSnapshot().autoplayBlocked).toBe(true)

		video.refusePlay = false
		controller.play()
		await flush()

		expect(video.play).toHaveBeenCalledTimes(2)
		expect(controller.getSnapshot().autoplayBlocked).toBe(false)
	})
})

function audio(lang: string, codec: ProbeAudio["codec"] = "aac"): ProbeAudio {
	return { id: 0, codec, codecString: null, ch: 2, rate: 48000, lang, name: null, def: false, forced: false, commentary: false }
}

describe("PlayerController automatic retries", () => {
	async function failLatest(): Promise<void> {
		await flush()
		setStatus(mocks.playbacks.length - 1, "failed")
	}

	it("stops after three tries however often the reopen fails again", async () => {
		await controller.open({ target: TARGET, start: "resume", autoplay: false })
		await failLatest()

		const waits: number[] = []

		for (let i = 0; i < 6; i++) {
			const wait = controller.autoRetryDelay()

			if (wait === null) {
				break
			}

			waits.push(wait)
			await controller.autoRetry()
			await failLatest()
		}

		expect(waits).toEqual([...AUTO_RETRY_DELAYS_MS])
		expect(mocks.playbacks).toHaveLength(4)

		await controller.autoRetry()
		expect(mocks.playbacks).toHaveLength(4)
	})

	it("earns the tries back on another item, after going offline, and after playing on", async () => {
		await controller.open({ target: TARGET, start: "resume", autoplay: false })
		await failLatest()
		await controller.autoRetry()
		await failLatest()
		expect(controller.autoRetryDelay()).toBe(AUTO_RETRY_DELAYS_MS[1])

		controller.resetAutoRetries()
		expect(controller.autoRetryDelay()).toBe(AUTO_RETRY_DELAYS_MS[0])

		await controller.autoRetry()
		expect(controller.autoRetryDelay()).toBe(AUTO_RETRY_DELAYS_MS[1])

		// The reopen plays on for a while: the failure was passing.
		video.loaded(100)
		setStatus(mocks.playbacks.length - 1, "ready")
		video.paused = false
		video.tick(100)
		video.tick(120)
		expect(controller.autoRetryDelay()).toBe(AUTO_RETRY_DELAYS_MS[1])
		video.tick(131)
		expect(controller.autoRetryDelay()).toBe(AUTO_RETRY_DELAYS_MS[0])

		await failLatest()
		await controller.autoRetry()
		controller.stop()
		await controller.open({ target: TARGET, start: "resume", autoplay: false })
		expect(controller.autoRetryDelay()).toBe(AUTO_RETRY_DELAYS_MS[0])
	})

	it("doesn't reopen a failure that would only come back", async () => {
		mocks.failure.trigger = "keyframe-interval"
		await controller.open({ target: TARGET, start: "resume", autoplay: false })
		await failLatest()

		expect(controller.autoRetryDelay()).toBeNull()
		await controller.autoRetry()
		expect(mocks.playbacks).toHaveLength(1)

		expect(isPassingFailure({ trigger: "open-gop-start", detail: "" })).toBe(false)
		expect(isPassingFailure({ trigger: "media-error", detail: "" })).toBe(false)
		expect(isPassingFailure({ trigger: "media-error", detail: "", learnable: false })).toBe(true)
		expect(isPassingFailure({ trigger: "decode-stall", detail: "" })).toBe(true)
		expect(isPassingFailure(null)).toBe(true)
	})

	it("doesn't reopen an item that no longer failed", async () => {
		await controller.open({ target: TARGET, start: "resume", autoplay: false })
		await flush()
		setStatus(0, "ready")
		await controller.autoRetry()

		expect(mocks.playbacks).toHaveLength(1)
	})
})

describe("PlayerController audio choice", () => {
	it("keeps the user's audio track across a retry and Start over, not onto another item", async () => {
		mocks.probe = { ...PROBE, audio: [audio("eng"), audio("deu")] }
		await controller.open({ target: TARGET, start: "resume", autoplay: false })
		await flush()
		setStatus(0, "ready")
		expect(mocks.playbacks[0]?.audioIndex).toBe(0)

		await controller.selectAudio(1)
		setStatus(0, "failed")
		await controller.retry()
		expect(mocks.playbacks[1]?.audioIndex).toBe(1)

		await controller.open({ target: TARGET, start: "start", autoplay: true })
		expect(mocks.playbacks[2]?.audioIndex).toBe(1)

		const other = { ...TARGET, key: "other" }

		await controller.open({ target: other, start: "resume", autoplay: false })
		expect(mocks.playbacks[3]?.audioIndex).toBe(0)
	})

	it("keeps a detail-page pick across a retry", async () => {
		mocks.probe = { ...PROBE, audio: [audio("eng"), audio("deu")] }
		await controller.open({ target: TARGET, start: "resume", autoplay: false, audioIndex: 1 })
		await flush()
		setStatus(0, "failed")
		await controller.retry()

		expect(mocks.playbacks[1]?.audioIndex).toBe(1)
	})

	it("follows the chosen language onto a stack's next part, whose tracks may be ordered differently", async () => {
		const stacked: WatchItemTarget = {
			...TARGET,
			parts: [
				TARGET.parts[0],
				{ ...TARGET.parts[0], file: { stableUuid: "movie2", uuid: "movie2-u", name: "Movie.cd2.mp4", size: 1000 } }
			]
		} as WatchItemTarget

		mocks.playableFiles.mockResolvedValue([
			{ uuid: "movie-u", stableUUID: "movie", size: 1000n },
			{ uuid: "movie2-u", stableUUID: "movie2", size: 1000n }
		])
		mocks.probe = { ...PROBE, audio: [audio("eng"), audio("deu")] }
		await controller.open({ target: stacked, start: "start", autoplay: false })
		await flush()
		setStatus(0, "ready")
		await controller.selectAudio(1)

		mocks.probe = { ...PROBE, audio: [audio("deu"), audio("eng")] }
		await controller.open({ target: stacked, start: "resume", autoplay: true }, { part: 1, position: 0 })

		expect(mocks.playbacks[1]?.audioIndex).toBe(0)
	})
})

describe("PlayerController embedded cues", () => {
	function cue(track: number, start: number): RemuxTextCue {
		return { track, start, end: start + 1, text: `t${String(track)}@${String(start)}`, hint: 0 }
	}

	function sub(id: number): VideoProbe["subs"][number] {
		return { id, codecId: "S_TEXT/ASS", lang: null, name: null, def: false, forced: false, hi: false }
	}

	beforeEach(() => {
		mocks.probe = { ...PROBE, container: "mkv", subs: [sub(3), sub(4)] }
	})

	async function opened(): Promise<(cues: RemuxTextCue[]) => void> {
		controller.setSubtitleKind("embedded-text", 3)
		await controller.open({ target: TARGET, start: "resume", autoplay: false })

		const emit = mocks.playbacks[0]?.onTextCues

		if (emit === undefined) {
			throw new Error("no cue tap")
		}

		return emit
	}

	it("keeps events of one track that start together, and a block read again once", async () => {
		const emit = await opened()
		const speakers = [
			{ track: 3, start: 5, end: 7, text: "First speaker", hint: 0 },
			{ track: 3, start: 5, end: 7, text: "Second speaker", hint: 0 }
		]

		emit(speakers)
		// A restarted remux reads the same blocks again.
		emit(speakers)

		expect(controller.embeddedCues(3, controller.getSnapshot().embeddedVersion)?.texts).toEqual(["First speaker", "Second speaker"])
	})

	it("keeps no cues of a track the probe doesn't offer", async () => {
		const emit = await opened()

		emit([cue(9, 1)])

		expect(controller.embeddedCues(9, controller.getSnapshot().embeddedVersion)).toBeNull()
	})

	it("keeps no more characters over all tracks than the tap's budget", async () => {
		const emit = await opened()
		const text = "x".repeat(2048)
		const fits = Math.floor(MAX_EMBEDDED_CUE_CHARS / embeddedCueCharge(text))
		const half = Math.ceil(fits / 2)

		emit(Array.from({ length: half }, (_, index) => ({ track: 3, start: index, end: index + 1, text, hint: 0 })))
		emit(Array.from({ length: fits }, (_, index) => ({ track: 4, start: index, end: index + 1, text, hint: 0 })))

		const version = controller.getSnapshot().embeddedVersion

		expect(controller.embeddedCues(3, version)?.texts).toHaveLength(half)
		expect(controller.embeddedCues(4, version)?.texts).toHaveLength(fits - half)
	})

	it("re-renders and rebuilds only for the shown track", async () => {
		controller.setSubtitleKind("embedded-text", 3)
		await controller.open({ target: TARGET, start: "resume", autoplay: false })

		const emit = mocks.playbacks[0]?.onTextCues

		if (emit === undefined) {
			throw new Error("no cue tap")
		}

		emit([cue(3, 1)])

		const version = controller.getSnapshot().embeddedVersion
		const store = controller.embeddedCues(3, version)

		expect(store?.texts).toEqual(["t3@1"])

		// Another language's block: nothing re-renders, the shown store stays the same object.
		emit([cue(4, 1), cue(4, 2)])
		expect(controller.getSnapshot().embeddedVersion).toBe(version)
		expect(controller.embeddedCues(3, version)).toBe(store)
		expect(controller.embeddedCues(4, version)?.texts).toEqual(["t4@1", "t4@2"])

		emit([cue(3, 2)])
		expect(controller.getSnapshot().embeddedVersion).toBe(version + 1)
		expect(controller.embeddedCues(3, version + 1)?.texts).toEqual(["t3@1", "t3@2"])

		// Switching to a track that got cues since it was last read re-renders once.
		emit([cue(4, 3)])
		controller.setSubtitleKind("embedded-text", 4)
		expect(controller.getSnapshot().embeddedVersion).toBe(version + 2)
		expect(controller.embeddedCues(4, version + 2)?.texts).toEqual(["t4@1", "t4@2", "t4@3"])
	})

	it("keeps no more cues per track than a cue store holds", async () => {
		controller.setSubtitleKind("embedded-text", 3)
		await controller.open({ target: TARGET, start: "resume", autoplay: false })

		const emit = mocks.playbacks[0]?.onTextCues

		if (emit === undefined) {
			throw new Error("no cue tap")
		}

		emit(Array.from({ length: MAX_SUBTITLE_CUES + 10 }, (_, index) => cue(3, index)))

		const version = controller.getSnapshot().embeddedVersion

		expect(controller.embeddedCues(3, version)?.texts).toHaveLength(MAX_SUBTITLE_CUES)

		emit([cue(3, MAX_SUBTITLE_CUES + 20)])
		expect(controller.getSnapshot().embeddedVersion).toBe(version)
	})
})

describe("PlayerController embedded subtitle on a direct stream", () => {
	beforeEach(() => {
		mocks.probe = {
			...PROBE,
			container: "webm",
			subs: [{ id: 3, codecId: "S_TEXT/WEBVTT", lang: null, name: null, def: true, forced: false, hi: false }]
		}
	})

	it("reopens on the remux rung when the track is chosen while the stream opened", async () => {
		// The UI learns of the file's tracks only once the probe is in the snapshot, while it opens.
		mocks.onOpen = () => {
			mocks.onOpen = null
			controller.setSubtitleKind("embedded-text", 3)
		}
		await controller.open({ target: TARGET, start: "resume", autoplay: false })

		expect(mocks.playbacks).toHaveLength(2)
		expect(mocks.playbacks[0]?.disposed).toBe(true)
		expect(mocks.playbacks[1]?.subtitle).toBe("embedded-text")
	})

	it("keeps the part's tracks on offer while a later choice reopens it", async () => {
		await controller.open({ target: TARGET, start: "resume", autoplay: false })
		await flush()
		setStatus(0, "ready")

		controller.setSubtitleKind("embedded-text", 3)
		await flush()

		expect(controller.getSnapshot().phase).toBe("loading")
		expect(controller.getSnapshot().probe?.subs).toHaveLength(1)
		expect(mocks.playbacks[1]?.subtitle).toBe("embedded-text")
	})

	it("keeps a direct stream playing when no remux plays the file whole, and marks the tracks unavailable", async () => {
		mocks.reachable.mockImplementation(() => Promise.resolve(false))
		await controller.open({ target: TARGET, start: "resume", autoplay: false })
		await flush()
		setStatus(0, "ready")

		controller.setSubtitleKind("embedded-text", 3)
		await flush()

		expect(mocks.playbacks).toHaveLength(1)
		expect(mocks.playbacks[0]?.disposed).toBe(false)
		expect(controller.getSnapshot().phase).toBe("ready")
		expect(controller.getSnapshot().embeddedTextBlocked).toBe(true)

		// The mark holds across a reopen of the same part and is asked afresh for another audio track.
		await controller.retry()
		await flush()
		expect(controller.getSnapshot().embeddedTextBlocked).toBe(true)
		setStatus(1, "ready")
		await controller.selectAudio(1)
		expect(controller.getSnapshot().embeddedTextBlocked).toBe(false)
	})

	it("keeps the stream it opened when the track chosen meanwhile can't be shown", async () => {
		mocks.reachable.mockImplementation(() => Promise.resolve(false))
		mocks.onOpen = () => {
			mocks.onOpen = null
			controller.setSubtitleKind("embedded-text", 3)
		}
		await controller.open({ target: TARGET, start: "resume", autoplay: false })

		expect(mocks.playbacks).toHaveLength(1)
		expect(mocks.playbacks[0]?.disposed).toBe(false)
		expect(controller.getSnapshot().embeddedTextBlocked).toBe(true)
	})
})
