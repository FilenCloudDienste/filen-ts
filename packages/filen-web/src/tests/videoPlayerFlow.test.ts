import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SkipSegment } from "@filen/shared/videos"
import { IdleTimer } from "@/lib/media/autoHide.logic"
import {
	STAGE_CONTROLS_IDLE_MS,
	chapterAt,
	doubleTapZone,
	stageControlsVisible,
	stallState,
	type StageVisibility
} from "@/components/media/video/stage.logic"
import { SkipPromptTracker, creditsStart } from "@/features/videos/lib/player/skipPrompts.logic"
import {
	StillWatchingCounter,
	autoAdvance,
	itemEndAction,
	upNextState,
	upNextTiming,
	upNextTimingFor
} from "@/features/videos/lib/player/upNextFlow.logic"
import { jitteredBackoffMs } from "@/features/videos/lib/watchState.logic"

const HIDDEN: StageVisibility = {
	paused: false,
	waiting: false,
	pointerActive: false,
	keyboardFocus: false,
	popupOpen: false,
	scrubbing: false,
	blocking: false
}

describe("stage controls", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("hide only while playback runs untouched", () => {
		expect(stageControlsVisible(HIDDEN)).toBe(false)

		for (const flag of Object.keys(HIDDEN) as (keyof StageVisibility)[]) {
			expect(stageControlsVisible({ ...HIDDEN, [flag]: true })).toBe(true)
		}
	})

	it("fade 3 s after the last pointer move", () => {
		const changes: boolean[] = []
		const timer = new IdleTimer(active => changes.push(active), STAGE_CONTROLS_IDLE_MS)

		timer.poke()
		vi.advanceTimersByTime(2000)
		timer.poke()
		vi.advanceTimersByTime(2999)

		expect(changes).toEqual([true])

		vi.advanceTimersByTime(1)

		expect(changes).toEqual([true, false])
	})

	it("show a spinner only after 400 ms of stall and a message after 15 s", () => {
		expect(stallState(null)).toBe("none")
		expect(stallState(399)).toBe("none")
		expect(stallState(400)).toBe("spinner")
		expect(stallState(14_999)).toBe("spinner")
		expect(stallState(15_000)).toBe("stillLoading")
	})

	it("seek by double tap in the side thirds only", () => {
		expect(doubleTapZone(10, 300)).toBe(-1)
		expect(doubleTapZone(150, 300)).toBe(0)
		expect(doubleTapZone(290, 300)).toBe(1)
		expect(doubleTapZone(10, 0)).toBe(0)
	})

	it("name the chapter under the scrubber", () => {
		const chapters = [
			{ start: 0, title: "Cold open" },
			{ start: 90, title: "Intro" },
			{ start: 150, title: null }
		]

		expect(chapterAt(chapters, 30)?.title).toBe("Cold open")
		expect(chapterAt(chapters, 120)?.title).toBe("Intro")
		expect(chapterAt(chapters, 200)?.title).toBeNull()
		expect(chapterAt([], 10)).toBeNull()
	})
})

describe("Up Next timing", () => {
	it("needs 10 minutes of runtime and leads by 30, 35 or 40 s", () => {
		expect(upNextTiming(9 * 60, null)).toBeNull()
		expect(upNextTiming(20 * 60, null)).toEqual({ showAt: 1170, autoplayAt: 1200 })
		expect(upNextTiming(45 * 60, null)).toEqual({ showAt: 2665, autoplayAt: 2700 })
		expect(upNextTiming(55 * 60, null)).toEqual({ showAt: 3260, autoplayAt: 3300 })
	})

	it("shows at the credits when they start earlier, and plays on after the lead", () => {
		expect(upNextTiming(20 * 60, 1000)).toEqual({ showAt: 1000, autoplayAt: 1030 })
	})

	it("never starts showing with less than 20 s left, but stays once shown", () => {
		const timing = upNextTiming(1200, null)
		const base = { timing, duration: 1200, creditsStart: null, dismissed: false }

		expect(upNextState({ ...base, position: 1100, shown: false }).visible).toBe(false)
		expect(upNextState({ ...base, position: 1171, shown: false })).toEqual({ visible: true, countdown: 29 })
		expect(upNextState({ ...base, position: 1190, shown: false }).visible).toBe(false)
		expect(upNextState({ ...base, position: 1190, shown: true })).toEqual({ visible: true, countdown: 10 })
		expect(upNextState({ ...base, position: 1200, shown: true })).toEqual({ visible: true, countdown: 0 })
		expect(upNextState({ ...base, position: 1100, shown: true }).visible).toBe(false)
		expect(upNextState({ ...base, position: 1180, shown: true, dismissed: true }).visible).toBe(false)
	})
})

describe("still watching", () => {
	it("asks after three autoplays in a row without a control touched", () => {
		const counter = new StillWatchingCounter()
		const advance = () => autoAdvance({ hasNext: true, autoplay: true, consecutiveAutoplays: counter.value })

		expect(advance()).toBe("play")
		counter.note("autoplay")
		counter.note("autoplay")
		expect(advance()).toBe("play")
		counter.note("autoplay")
		expect(advance()).toBe("askStillWatching")
		counter.note("confirm")
		expect(advance()).toBe("play")
		counter.note("autoplay")
		counter.note("autoplay")
		counter.note("interaction")
		counter.note("autoplay")
		expect(advance()).toBe("play")
	})

	it("does nothing without a next item or with autoplay off", () => {
		expect(autoAdvance({ hasNext: false, autoplay: true, consecutiveAutoplays: 0 })).toBe("none")
		expect(autoAdvance({ hasNext: true, autoplay: false, consecutiveAutoplays: 0 })).toBe("none")
	})
})

describe("the end of an item", () => {
	const base = { repeat: false, hasNext: true, nativeFullscreen: false, upNextDismissed: false, cardShown: false }

	it("advances, offers the next or shows post-play while repeat is off", () => {
		expect(itemEndAction(base)).toBe("autoAdvance")
		expect(itemEndAction({ ...base, nativeFullscreen: true })).toBe("playNext")
		expect(itemEndAction({ ...base, upNextDismissed: true })).toBe("offerNext")
		expect(itemEndAction({ ...base, cardShown: true })).toBe("offerNext")
		expect(itemEndAction({ ...base, hasNext: false })).toBe("postPlay")
	})

	it("plays the item again on repeat, whatever comes next", () => {
		expect(itemEndAction({ ...base, repeat: true })).toBe("replay")
		expect(itemEndAction({ ...base, repeat: true, nativeFullscreen: true })).toBe("replay")
		expect(itemEndAction({ ...base, repeat: true, upNextDismissed: true, cardShown: true })).toBe("replay")
		expect(itemEndAction({ ...base, repeat: true, hasNext: false })).toBe("replay")
	})
})

describe("skip prompts", () => {
	const intro: SkipSegment = { kind: "intro", start: 60, end: 150, source: "skipType" }
	const outro: SkipSegment = { kind: "outro", start: 1500, end: 1800, source: "skipType" }
	const recap: SkipSegment = { kind: "recap", start: 0, end: 30, source: "chapter" }
	const cut: SkipSegment = { kind: "commercial", start: 400, end: 420, source: "edl", mustSkip: true }
	const tiny: SkipSegment = { kind: "intro", start: 700, end: 702, source: "chapter" }

	it("prompts on entering an intro and hides after 8 s unless the controls are up", () => {
		const tracker = new SkipPromptTracker({ segments: [intro], duration: 1800 })

		expect(tracker.update({ time: 30, now: 0, controlsShown: false }).prompt).toBeNull()
		expect(tracker.update({ time: 61, now: 1000, controlsShown: false }).prompt).toBe(intro)
		expect(tracker.update({ time: 66, now: 6000, controlsShown: false }).prompt).toBe(intro)
		expect(tracker.update({ time: 70, now: 9000, controlsShown: false }).prompt).toBeNull()
		expect(tracker.update({ time: 75, now: 9500, controlsShown: true }).prompt).toBe(intro)
		expect(tracker.update({ time: 80, now: 17_000, controlsShown: false }).prompt).toBe(intro)
	})

	it("skips to the segment's end, and never prompts again after seeking back into it", () => {
		const tracker = new SkipPromptTracker({ segments: [intro], duration: 1800 })

		tracker.update({ time: 61, now: 0, controlsShown: false })
		expect(tracker.skip(62)).toBe(150)
		expect(tracker.update({ time: 151, now: 100, controlsShown: false }).prompt).toBeNull()
		expect(tracker.update({ time: 100, now: 200, controlsShown: true }).prompt).toBeNull()
	})

	it("does not skip with a second or less of the segment left", () => {
		const tracker = new SkipPromptTracker({ segments: [intro], duration: 1800 })

		expect(tracker.update({ time: 149.5, now: 0, controlsShown: false }).prompt).toBeNull()
	})

	it("auto-skips an .edl cut, ignores segments under 3 s and kinds that are off by default", () => {
		const tracker = new SkipPromptTracker({ segments: [recap, cut, tiny], duration: 1800 })

		expect(tracker.update({ time: 5, now: 0, controlsShown: false })).toEqual({ prompt: null, jumpTo: null })
		expect(tracker.update({ time: 401, now: 10, controlsShown: false })).toEqual({ prompt: null, jumpTo: 420 })
		expect(tracker.update({ time: 701, now: 20, controlsShown: false })).toEqual({ prompt: null, jumpTo: null })
	})

	it("leaves an outro running to the end to Up Next", () => {
		const tracker = new SkipPromptTracker({ segments: [outro], duration: 1800 })

		expect(tracker.update({ time: 1501, now: 0, controlsShown: false }).prompt).toBeNull()
		expect(creditsStart([intro, outro], 1800)).toBe(1500)
		expect(creditsStart([intro], 1800)).toBeNull()
		expect(creditsStart([{ ...outro, end: 1700 }], 1800)).toBeNull()
	})
})

describe("Up Next on stacks and backoff jitter", () => {
	it("times Up Next on an episode's last part only", () => {
		const base = { repeat: false, hasNext: true, isEpisode: true, duration: 1200, creditsStart: null }

		expect(upNextTimingFor({ ...base, part: 0, parts: 2 })).toBeNull()
		expect(upNextTimingFor({ ...base, part: 1, parts: 2 })).toEqual({ showAt: 1170, autoplayAt: 1200 })
		expect(upNextTimingFor({ ...base, part: 0, parts: 1, isEpisode: false })).toBeNull()
		expect(upNextTimingFor({ ...base, part: 0, parts: 1, hasNext: false })).toBeNull()
		// On repeat the episode plays again instead.
		expect(upNextTimingFor({ ...base, part: 0, parts: 1, repeat: true })).toBeNull()
	})

	it("adds up to a quarter of jitter to a backoff", () => {
		expect(jitteredBackoffMs(30_000, 0)).toBe(30_000)
		expect(jitteredBackoffMs(30_000, 0.5)).toBe(33_750)
		expect(jitteredBackoffMs(30_000, 0.9999)).toBeLessThan(37_500)
		expect(jitteredBackoffMs(30_000, Number.NaN)).toBe(30_000)
	})
})
