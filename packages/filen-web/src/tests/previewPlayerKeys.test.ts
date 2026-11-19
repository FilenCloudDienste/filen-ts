// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { MediaScrubber } from "@/components/media/mediaScrubber"
import { MEDIA_ACTIONS } from "@/lib/media/keymap"
import { mediaKeyAction } from "@/lib/media/mediaKeys.logic"
import { handlePlayerKeyDown, previewVideoActions, seekPlayerTo } from "@/lib/media/playerKeyboard"
import { SEEK_COALESCE_MS, SeekCoalescer } from "@/lib/media/seekCoalescer.logic"
import "@/lib/i18n"

function pageKey(code: "PageUp" | "PageDown", chapters: number): string | null {
	return mediaKeyAction(
		{ code, key: code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false },
		"surface",
		previewVideoActions(false, chapters),
		{},
		false
	)
}

describe("the preview video player's chapter keys", () => {
	it("takes PageUp and PageDown only from two chapters on, leaving them to what is around it otherwise", () => {
		expect(pageKey("PageUp", 0)).toBeNull()
		expect(pageKey("PageDown", 1)).toBeNull()
		expect(pageKey("PageUp", 2)).toBe("media.chapterPrevious")
		expect(pageKey("PageDown", 5)).toBe("media.chapterNext")
		expect(previewVideoActions(true, 2)).toContain("media.fullscreen")
	})

	it("lists them as keys of any video player", () => {
		const hints = MEDIA_ACTIONS.filter(action => action.id === "media.chapterPrevious" || action.id === "media.chapterNext").map(
			action => action.hintKey
		)

		expect(hints).toEqual(["videos:mediaHintVideo", "videos:mediaHintVideo"])
	})
})

// A <video> as far as the keys reach it: every position assignment is recorded.
function fakeVideo(duration: number) {
	const seeks: number[] = []
	let position = 0
	const video = {
		duration,
		paused: true,
		get currentTime(): number {
			return position
		},
		set currentTime(seconds: number) {
			position = seconds
			seeks.push(seconds)
		}
	}

	return { video: video as unknown as HTMLVideoElement, seeks }
}

// A clock and a timer the test advances by hand.
function manualClock() {
	let now = 0
	let pending: { callback: () => void; at: number } | null = null

	return {
		now: () => now,
		setTimer: (callback: () => void, ms: number) => {
			pending = { callback, at: now + ms }

			return pending
		},
		clearTimer: (timer: { callback: () => void; at: number }) => {
			if (pending === timer) {
				pending = null
			}
		},
		advance(ms: number): void {
			now += ms

			if (pending !== null && pending.at <= now) {
				const due = pending

				pending = null
				due.callback()
			}
		}
	}
}

function press(
	video: HTMLVideoElement,
	seeks: SeekCoalescer<{ callback: () => void; at: number }>,
	code: string,
	repeat: boolean
): boolean {
	return handlePlayerKeyDown(
		{
			code,
			key: code,
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			altKey: false,
			repeat,
			target: document.body,
			defaultPrevented: false,
			preventDefault: () => undefined,
			stopPropagation: () => undefined
		},
		video,
		null,
		{},
		[],
		seeks
	)
}

function coalescerFor(
	video: HTMLVideoElement,
	clock: ReturnType<typeof manualClock>,
	onPending: (seconds: number | null) => void = () => undefined
): SeekCoalescer<{ callback: () => void; at: number }> {
	return new SeekCoalescer({
		current: () => video.currentTime,
		duration: () => video.duration,
		seek: seconds => {
			video.currentTime = seconds
		},
		onPending,
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer
	})
}

describe("the preview video player's held seek keys", () => {
	it("seeks once at once and once per window after, to where the repeats add up", () => {
		const { video, seeks } = fakeVideo(600)
		const clock = manualClock()
		const coalescer = coalescerFor(video, clock)

		expect(press(video, coalescer, "ArrowRight", false)).toBe(true)

		// The OS repeats the key about every 33ms.
		for (let i = 0; i < 4; i++) {
			clock.advance(33)
			press(video, coalescer, "ArrowRight", true)
		}

		expect(seeks).toEqual([10])

		clock.advance(SEEK_COALESCE_MS)

		expect(seeks).toEqual([10, 50])
	})

	it("drops a pending seek an absolute seek supersedes", () => {
		const { video, seeks } = fakeVideo(600)
		const clock = manualClock()
		const coalescer = coalescerFor(video, clock)

		press(video, coalescer, "ArrowRight", false)
		clock.advance(33)
		press(video, coalescer, "ArrowRight", true)
		press(video, coalescer, "Home", false)
		clock.advance(SEEK_COALESCE_MS)

		expect(seeks).toEqual([10, 0])
	})

	it("reports where a held seek is headed until it lands, for the playhead readouts", () => {
		const { video } = fakeVideo(600)
		const clock = manualClock()
		const shown: (number | null)[] = []
		const coalescer = coalescerFor(video, clock, seconds => {
			shown.push(seconds)
		})

		press(video, coalescer, "ArrowRight", false)
		clock.advance(33)
		press(video, coalescer, "ArrowRight", true)
		clock.advance(33)
		press(video, coalescer, "ArrowRight", true)

		expect(shown).toEqual([20, 30])

		clock.advance(SEEK_COALESCE_MS)

		expect(shown).toEqual([20, 30, null])
	})

	it("lets a pointer's seek supersede a held seek still pending rather than be overridden by it", () => {
		const { video, seeks } = fakeVideo(600)
		const clock = manualClock()
		const shown: (number | null)[] = []
		const coalescer = coalescerFor(video, clock, seconds => {
			shown.push(seconds)
		})

		press(video, coalescer, "ArrowRight", false)
		clock.advance(33)
		press(video, coalescer, "ArrowRight", true)
		seekPlayerTo(video, coalescer, 123)
		clock.advance(SEEK_COALESCE_MS)

		expect(seeks).toEqual([10, 123])
		expect(shown).toEqual([20, null])
	})
})

// The preview's scrubber as videoPlayer.tsx wires it: its relative keys into the coalescer, its absolute seeks past it.
function renderScrubber(video: HTMLVideoElement, coalescer: SeekCoalescer<{ callback: () => void; at: number }>) {
	return render(
		createElement(MediaScrubber, {
			value: video.currentTime,
			duration: video.duration,
			label: "Seek",
			onSeek: seconds => {
				seekPlayerTo(video, coalescer, seconds)
			},
			onSeekBy: delta => {
				coalescer.seekBy(delta)
			}
		})
	)
}

describe("the preview scrubber's held seek keys", () => {
	it("seeks once at once and once per window after, to where the repeats add up", () => {
		const { video, seeks } = fakeVideo(600)
		const clock = manualClock()
		const coalescer = coalescerFor(video, clock)

		renderScrubber(video, coalescer)

		const slider = screen.getByRole("slider")

		fireEvent.keyDown(slider, { key: "ArrowRight" })

		for (let i = 0; i < 4; i++) {
			clock.advance(33)
			fireEvent.keyDown(slider, { key: "ArrowRight", repeat: true })
		}

		expect(seeks).toEqual([10])

		clock.advance(SEEK_COALESCE_MS)

		expect(seeks).toEqual([10, 50])
	})

	it("lets a pointer release supersede a held seek still pending", () => {
		const { video, seeks } = fakeVideo(600)
		const clock = manualClock()
		const coalescer = coalescerFor(video, clock)
		const { container } = renderScrubber(video, coalescer)
		const slider = screen.getByRole("slider")
		const rail = container.firstElementChild as HTMLElement

		rail.setPointerCapture = vi.fn()
		rail.hasPointerCapture = () => true
		rail.getBoundingClientRect = () => new DOMRect(0, 0, 600, 20)

		fireEvent.keyDown(slider, { key: "ArrowRight" })
		clock.advance(33)
		fireEvent.keyDown(slider, { key: "ArrowRight", repeat: true })
		fireEvent.pointerDown(rail, { button: 0, pointerId: 1, clientX: 300 })
		fireEvent.pointerUp(rail, { button: 0, pointerId: 1, clientX: 300 })
		clock.advance(SEEK_COALESCE_MS)

		expect(seeks).toEqual([10, 300])
	})
})
