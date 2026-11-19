// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"

vi.mock("@/features/shell/hooks/useIsNarrowViewport", () => ({ useIsNarrowViewport: () => false }))
// The preview player without its source pipeline: the test presents the frames.
vi.mock("@/features/preview/hooks/usePreviewVideo", () => ({ usePreviewVideo: () => ({ controller: null, snapshot: null }) }))
vi.mock("@/features/preview/hooks/usePreviewSubtitles", () => ({
	usePreviewSubtitles: () => ({ options: [], selected: "off", select: () => undefined, cues: null, failed: false })
}))

import { VideoStage, type VideoStageProps } from "@/components/media/video/videoStage"
import { VideoPlayer } from "@/features/preview/components/videoPlayer"
import { frameStepSeconds, measureFrameInterval } from "@/lib/media/playerKeyboard"
import { linkedFileItem } from "@/tests/fixtures/sdk"

type FrameCallback = (now: number, metadata: VideoFrameCallbackMetadata) => void

// jsdom has no requestVideoFrameCallback: the test presents the frames.
let frameCallbacks: FrameCallback[] = []

function present(mediaTime: number, presentedFrames: number): void {
	const callbacks = frameCallbacks

	frameCallbacks = []

	for (const callback of callbacks) {
		callback(0, { mediaTime, presentedFrames } as VideoFrameCallbackMetadata)
	}
}

function setPaused(element: HTMLVideoElement, paused: boolean): void {
	Object.defineProperty(element, "paused", { configurable: true, get: () => paused })
}

// Plays two frames 1/60 s apart at `start`, then pauses there.
function playFrames(element: HTMLVideoElement, start: number): void {
	setPaused(element, false)
	fireEvent(element, new Event("playing"))
	present(start, 10)
	present(start + 1 / 60, 11)
	setPaused(element, true)
	fireEvent(element, new Event("pause"))
	element.currentTime = start
}

beforeEach(() => {
	frameCallbacks = []
	Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
		configurable: true,
		value(callback: FrameCallback): number {
			frameCallbacks.push(callback)

			return frameCallbacks.length
		}
	})
	Object.defineProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback", {
		configurable: true,
		value(): void {
			frameCallbacks = []
		}
	})
})

afterEach(() => {
	cleanup()
	Reflect.deleteProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback")
	Reflect.deleteProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback")
})

describe("frame steps", () => {
	it("the stage steps by the interval between two presented frames, 24 fps before any", () => {
		let video: HTMLVideoElement | null = null
		const props: VideoStageProps = {
			title: "Movie",
			backLabel: "Back",
			onBack: () => undefined,
			videoLabel: "Movie",
			onVideo: element => {
				video = element
			},
			chapters: [],
			cues: null,
			cueOffset: 0,
			loading: false,
			hasNext: false,
			hasPrevious: false,
			trailing: () => null,
			holdControls: false,
			onAction: () => false
		}

		render(createElement(VideoStage, props))

		const element = video as HTMLVideoElement | null

		if (element === null) {
			throw new Error("no video")
		}

		const stage = screen.getByRole("dialog", { name: "Movie" })

		element.currentTime = 5
		fireEvent.keyDown(stage, { key: ".", code: "Period" })
		expect(element.currentTime).toBeCloseTo(5 + 1 / 24)

		act(() => {
			playFrames(element, 5)
		})

		fireEvent.keyDown(stage, { key: ".", code: "Period" })
		expect(element.currentTime).toBeCloseTo(5 + 1 / 60)
		fireEvent.keyDown(stage, { key: ",", code: "Comma" })
		expect(element.currentTime).toBeCloseTo(5)

		// A new source forgets the old one's interval.
		fireEvent(element, new Event("emptied"))
		fireEvent.keyDown(stage, { key: ".", code: "Period" })
		expect(element.currentTime).toBeCloseTo(5 + 1 / 24)
	})

	it("the preview player's first key after a pause steps by the interval measured while it played", () => {
		render(createElement(VideoPlayer, { item: linkedFileItem("clip.mp4"), alt: "clip", downloadable: true, positionKey: "k" }))

		const surface = document.querySelector("[data-preview-surface]")
		const element = surface?.querySelector("video") ?? null

		if (surface === null || element === null) {
			throw new Error("no player")
		}

		// Played, paused with a click on the picture: the frame key is the first key.
		act(() => {
			playFrames(element, 2)
		})

		fireEvent.keyDown(surface, { key: ".", code: "Period" })
		expect(element.currentTime).toBeCloseTo(2 + 1 / 60)
	})

	it("a seek during playback that fires no 'playing' resumes the run once it lands", () => {
		const element = document.createElement("video")
		const stop = measureFrameInterval(element)

		setPaused(element, false)
		fireEvent(element, new Event("playing"))
		present(1, 10)
		fireEvent(element, new Event("seeking"))
		expect(frameCallbacks).toHaveLength(0)
		fireEvent(element, new Event("seeked"))
		expect(frameCallbacks).toHaveLength(1)

		// "playing" after the same seek doesn't restart the run that "seeked" started.
		present(8, 20)
		fireEvent(element, new Event("playing"))
		present(8 + 1 / 50, 21)
		setPaused(element, true)
		fireEvent(element, new Event("pause"))
		expect(frameStepSeconds(element)).toBeCloseTo(1 / 50)

		stop()
	})
})
