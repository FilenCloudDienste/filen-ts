import { describe, expect, it } from "vitest"
import { MEDIA_BOOKMARKS_MAX, type MediaBookmark } from "../core/anim/media"
import { MediaTimingDriver, type TimedMedia } from "../react/presentation/show/mediaTiming"
import { budget, cpuMs } from "./timing"

// mediaTimingPerf: the show's per-frame media timing work (trim window, fade gain and the bookmark cursor) on a
// medium with the most bookmarks a file may give (and a trim and fade) adds at most 1 ms of main-thread CPU per frame;
// measured as the mean over a minute of 60 Hz frames, least of several runs.

const FRAMES = 3600
const RUNS = 5

describe("mediaTimingPerf", () => {
	it("adds at most 1 ms of main-thread CPU per frame", ({ task }) => {
		const bookmarks: MediaBookmark[] = []

		for (let k = 0; k < MEDIA_BOOKMARKS_MAX; k++) bookmarks.push({ name: `Bookmark ${String(k)}`, timeMs: 200 + k * 230 })

		let best = Number.POSITIVE_INFINITY
		let fired = 0

		for (let run = 0; run < RUNS; run++) {
			const element: TimedMedia = {
				currentTime: 0,
				volume: 1,
				duration: 70,
				paused: false,
				pause: () => undefined,
				play: () => Promise.resolve(),
				addEventListener: () => undefined,
				removeEventListener: () => undefined
			}
			const driver = new MediaTimingDriver(
				element,
				{ trim: { startMs: 100, endMs: 500 }, fade: { inMs: 2000, outMs: 2000 }, bookmarks },
				{
					bookmark: () => {
						fired++
					},
					ended: () => undefined
				},
				{ loop: false, volume: 1, frames: { request: () => 0, cancel: () => undefined } }
			)
			const start = cpuMs()

			for (let frame = 0; frame < FRAMES; frame++) {
				element.currentTime = 0.1 + frame / 60
				driver.tick()
			}

			best = Math.min(best, (cpuMs() - start) / FRAMES)
			driver.dispose()
		}

		// Every bookmark within the minute fired once per run.
		expect(fired).toBe(RUNS * bookmarks.filter(bookmark => bookmark.timeMs <= 60_100).length)
		expect(best).toBeLessThanOrEqual(budget(1))

		Object.assign(task.meta, { perf: { mediaTimingFrameCpuMs: { value: best, budget: 1 } } })
	})
})
