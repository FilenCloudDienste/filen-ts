// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { VideoScrubber } from "@/components/media/video/videoScrubber"
import type { StageChapter } from "@/components/media/video/stage.logic"
import { MEDIA_SEEK_STEP_SECONDS } from "@/lib/media/mediaKeys.logic"

const CHAPTERS: StageChapter[] = [
	{ start: 0, title: "Opening" },
	{ start: 100, title: null }
]

// jsdom's media element has no media: the scrubber reads these.
function fakeVideo(currentTime: number): HTMLVideoElement {
	const video = document.createElement("video")

	Object.defineProperty(video, "duration", { configurable: true, get: () => 600 })
	Object.defineProperty(video, "currentTime", { configurable: true, get: () => currentTime })

	return video
}

function renderScrubber(currentTime: number, onSeekBy: (seconds: number) => void = () => undefined): HTMLInputElement {
	render(
		<VideoScrubber
			video={fakeVideo(currentTime)}
			visible={false}
			chapters={CHAPTERS}
			pendingTarget={null}
			remainingMode={false}
			label="Seek"
			onSeek={() => undefined}
			onSeekBy={onSeekBy}
			onChapter={() => undefined}
			onScrub={() => undefined}
			onToggleRemaining={() => undefined}
		/>
	)

	const input = screen.getByRole("slider", { name: "Seek" })

	if (!(input instanceof HTMLInputElement)) {
		throw new Error("no range input")
	}

	return input
}

afterEach(() => {
	cleanup()
})

describe("VideoScrubber", () => {
	it("steps the arrows by the shared seek step", () => {
		const onSeekBy = vi.fn()
		const input = renderScrubber(30, onSeekBy)

		fireEvent.keyDown(input, { key: "ArrowLeft" })
		fireEvent.keyDown(input, { key: "ArrowRight" })

		expect(onSeekBy.mock.calls).toEqual([[-MEDIA_SEEK_STEP_SECONDS], [MEDIA_SEEK_STEP_SECONDS]])
	})

	it("names the chapter in the accessible value", () => {
		const input = renderScrubber(30)

		expect(input.getAttribute("aria-valuetext")).toBe("0:30 of 10:00, Chapter 1: Opening")
	})

	it("numbers an untitled chapter in the accessible value", () => {
		const input = renderScrubber(130)

		expect(input.getAttribute("aria-valuetext")).toBe("2:10 of 10:00, Chapter 2")
	})

	it("names an untitled chapter in the hover bubble", () => {
		const input = renderScrubber(0)
		const rail = input.parentElement

		if (rail === null) {
			throw new Error("no rail")
		}

		rail.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 24 })
		// jsdom has no pointer capture: a hover never holds it.
		rail.hasPointerCapture = () => false
		fireEvent.pointerMove(rail, { clientX: 300, pointerType: "mouse", pointerId: 1 })

		expect(screen.getByText("· Chapter 2")).toBeTruthy()
	})
})
