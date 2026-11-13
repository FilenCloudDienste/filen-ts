import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EditorPlayback } from "@/features/preview/videoEdit/components/editorPlayback"
import { colourBlockedByHdr, dropNotices, etaMinutes, targetNote, unavailableFeatures } from "@/features/preview/videoEdit/lib/availability"
import type { ExportPlan, VideoSourceInfo } from "@/features/preview/videoEdit/types"
import { FAKE_INFO, FAKE_PLAN } from "@/tests/support/fakeVideoEditClient"

// The editor's playback over a stand-in element: it jumps over removed sections and loops a selection on the frame it
// reaches them, plays at the recipe's speed with the pitch kept, doubles on L, previews the gain as the element's
// volume, and tells its listeners every frame. Then the Save popover's pure readings of a plan.

class FakeVideo extends EventTarget {
	paused = true
	seeking = false
	currentTime = 0
	duration = 100
	playbackRate = 1
	preservesPitch = false
	muted = false
	volume = 1

	play(): Promise<void> {
		this.paused = false
		this.dispatchEvent(new Event("play"))

		return Promise.resolve()
	}

	pause(): void {
		this.paused = true
		this.dispatchEvent(new Event("pause"))
	}
}

let frames: FrameRequestCallback[] = []

function runFrame(): void {
	const pending = frames

	frames = []

	for (const callback of pending) {
		callback(0)
	}
}

beforeEach(() => {
	frames = []
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.push(callback)

		return frames.length
	})
	vi.stubGlobal("cancelAnimationFrame", () => {
		frames = []
	})
})

afterEach(() => {
	vi.unstubAllGlobals()
})

function setUp(): { playback: EditorPlayback; video: FakeVideo; ticks: number[] } {
	const playback = new EditorPlayback()
	const video = new FakeVideo()
	const ticks: number[] = []

	playback.attach(video as unknown as HTMLVideoElement)
	playback.subscribe(time => {
		ticks.push(time)
	})
	playback.setKeep([
		{ start: 0, end: 10 },
		{ start: 20, end: 30 }
	])

	return { playback, video, ticks }
}

describe("EditorPlayback", () => {
	it("starts a press of play at the next kept moment and jumps removed sections", () => {
		const { playback, video, ticks } = setUp()

		video.currentTime = 12
		playback.play()

		expect(video.currentTime).toBe(20)

		video.currentTime = 30.01
		runFrame()

		// Past the last kept part: back to the first.
		expect(video.currentTime).toBe(0)
		expect(ticks.at(-1)).toBe(0)

		video.currentTime = 10.5
		runFrame()
		expect(video.currentTime).toBe(20)
	})

	it("loops a selection", () => {
		const { playback, video } = setUp()

		playback.setLoop({ start: 2, end: 4 })
		video.currentTime = 3
		playback.play()
		video.currentTime = 4.2
		runFrame()

		expect(video.currentTime).toBe(2)
	})

	it("stops ticking once paused", () => {
		const { playback, video } = setUp()

		playback.play()
		playback.pause()
		runFrame()

		expect(video.paused).toBe(true)
		expect(frames).toEqual([])
	})

	it("plays at the recipe's speed with the pitch kept, doubling on L up to four times", () => {
		const { playback, video } = setUp()

		playback.setSpeed(1.5)
		expect(video.playbackRate).toBe(1.5)
		expect(video.preservesPitch).toBe(true)

		playback.shuttleForward()
		expect(video.paused).toBe(false)
		expect(video.playbackRate).toBe(1.5)

		playback.shuttleForward()
		playback.shuttleForward()
		playback.shuttleForward()
		expect(video.playbackRate).toBe(6)

		playback.pause()
		expect(video.playbackRate).toBe(1.5)
	})

	it("previews mute and gain on the element", () => {
		const { playback, video } = setUp()

		playback.setSound(false, -20)
		expect(video.volume).toBeCloseTo(0.1)

		playback.setSound(true, 6)
		expect(video.muted).toBe(true)
		expect(video.volume).toBe(1)
	})
})

describe("plan readings", () => {
	const plan = (patch: Partial<ExportPlan>): ExportPlan => ({ ...FAKE_PLAN, ...patch })

	it("keeps only the features it knows as unavailable", () => {
		expect([...unavailableFeatures(plan({ unavailable: ["adjust", "somethingElse"] }))]).toEqual(["adjust"])
		expect(unavailableFeatures(null).size).toBe(0)
	})

	it("joins subtitles and chapters into one notice", () => {
		expect(dropNotices(["chapters", "subtitles", "location"])).toEqual(["subtitlesAndChapters", "location"])
		expect(dropNotices(["subtitles", "extraAudio"])).toEqual(["subtitles", "extraAudio"])
	})

	it("reads what happens to the original from the targets", () => {
		expect(targetNote(plan({ targets: ["inPlace", "copy"] }))).toBe("versionKept")
		expect(targetNote(plan({ targets: ["copy", "inPlace"] }))).toBe("versioningOff")
		expect(targetNote(plan({ targets: ["copy"] }))).toBe("copyOnly")
	})

	it("blocks colour on HDR unless the plan keeps 10-bit", () => {
		const hdr: VideoSourceInfo = { ...FAKE_INFO, transfer: "pq" }

		expect(colourBlockedByHdr(FAKE_INFO, null)).toBe(false)
		expect(colourBlockedByHdr(hdr, plan({ hdr: "toSdr" }))).toBe(true)
		expect(colourBlockedByHdr(hdr, plan({ hdr: "hevc10" }))).toBe(false)
	})

	it("rounds the time to whole minutes", () => {
		expect(etaMinutes(null)).toBe(0)
		expect(etaMinutes(59)).toBe(0)
		expect(etaMinutes(185)).toBe(3)
	})
})
