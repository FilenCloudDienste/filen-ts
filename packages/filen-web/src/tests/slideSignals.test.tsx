// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import "@/lib/i18n"
import type { SlideKind } from "@/features/preview/lib/slideshow.logic"
import type { PreviewVideoSnapshot } from "@/features/preview/lib/previewVideo"

// What the preview's viewers tell a running slideshow: a video plays once (its repeat set aside, not changed) and
// reports its end or its failure, an animated image reports that it animates and the end of its first loop, and a
// video counts as shown on its first `playing`. Without a slideshow each viewer is as it always was.

interface FakeController {
	setLoop: ReturnType<typeof vi.fn<(loop: boolean) => void>>
	onEnded: (listener: () => void) => () => void
	ended: () => void
	retry: () => void
	ensureProbe: () => void
	selectAudio: () => void
}

function fakeController(): FakeController {
	const listeners = new Set<() => void>()

	return {
		setLoop: vi.fn<(loop: boolean) => void>(),
		onEnded: listener => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		ended: () => {
			for (const listener of listeners) {
				listener()
			}
		},
		retry: () => undefined,
		ensureProbe: () => undefined,
		selectAudio: () => undefined
	}
}

let controller = fakeController()
let snapshot: Partial<PreviewVideoSnapshot> | null = null

vi.mock("@/features/shell/hooks/useIsNarrowViewport", () => ({ useIsNarrowViewport: () => false }))
vi.mock("@/features/preview/hooks/usePreviewVideo", () => ({ usePreviewVideo: () => ({ controller, snapshot }) }))
vi.mock("@/features/preview/hooks/usePreviewSubtitles", () => ({
	usePreviewSubtitles: () => ({ options: [], selected: "off", select: () => undefined, cues: null, failed: false })
}))

import { VideoPlayer } from "@/features/preview/components/videoPlayer"
import { AnimatedImagePlayer } from "@/features/preview/components/animatedImagePlayer"
import { SlideSignalsContext, type SlideSignals } from "@/features/preview/lib/slideSignals"
import { ImageShownContext, type ShownImage } from "@/features/preview/lib/imageDisplay"
import { videoRepeat } from "@/lib/media/videoRepeat"
import { linkedFileItem } from "@/tests/fixtures/sdk"

function fakeSignals(): SlideSignals & {
	mediaEnded: ReturnType<typeof vi.fn<() => void>>
	animating: ReturnType<typeof vi.fn<() => void>>
} {
	return { active: true, mediaEnded: vi.fn<() => void>(), animating: vi.fn<() => void>() }
}

function videoPlayer(): ReactNode {
	return (
		<VideoPlayer
			item={linkedFileItem("clip.mp4")}
			alt="clip"
			downloadable={true}
			positionKey="k"
		/>
	)
}

function videoElement(): HTMLVideoElement {
	const element = document.querySelector("video")

	if (element === null) {
		throw new Error("no video")
	}

	return element
}

beforeEach(() => {
	controller = fakeController()
	snapshot = null
})

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

describe("slide signals — video", () => {
	it("a video under a slideshow does not loop and reports its end", () => {
		const signals = fakeSignals()

		render(<SlideSignalsContext value={signals}>{videoPlayer()}</SlideSignalsContext>)

		expect(controller.setLoop).toHaveBeenLastCalledWith(false)
		expect(screen.queryByRole("button", { name: "Repeat" })).toBeNull()
		expect(signals.mediaEnded).not.toHaveBeenCalled()

		act(() => {
			controller.ended()
		})

		expect(signals.mediaEnded).toHaveBeenCalledOnce()
	})

	it("the stored repeat preference is unchanged after a slideshow video", () => {
		const before = videoRepeat("preview")
		const signals = fakeSignals()
		const { unmount } = render(<SlideSignalsContext value={signals}>{videoPlayer()}</SlideSignalsContext>)

		act(() => {
			controller.ended()
		})
		unmount()

		expect(videoRepeat("preview")).toBe(before)
	})

	it("without the context the video loops as before", () => {
		render(videoPlayer())

		expect(controller.setLoop).toHaveBeenLastCalledWith(videoRepeat("preview"))
		expect(videoRepeat("preview")).toBe(true)
		expect(screen.getByRole("button", { name: "Repeat" })).toBeTruthy()
	})

	it("a failing video under a slideshow reports its end", () => {
		snapshot = { status: "failed", probe: null, decision: null, silentCodec: null }

		const signals = fakeSignals()

		render(<SlideSignalsContext value={signals}>{videoPlayer()}</SlideSignalsContext>)

		expect(signals.mediaEnded).toHaveBeenCalledOnce()
	})

	it("a video reports shown on its first playing event only inside ImageShownContext", () => {
		const shown = vi.fn<(image: ShownImage) => void>()

		render(<ImageShownContext value={shown}>{videoPlayer()}</ImageShownContext>)

		const element = videoElement()

		Object.defineProperty(element, "videoWidth", { configurable: true, get: () => 640 })
		Object.defineProperty(element, "videoHeight", { configurable: true, get: () => 360 })

		expect(shown).not.toHaveBeenCalled()

		fireEvent(element, new Event("playing"))
		fireEvent(element, new Event("playing"))

		expect(shown).toHaveBeenCalledOnce()
		expect(shown).toHaveBeenCalledWith({ width: 640, height: 360 })

		cleanup()
		// Outside the context nothing listens, and nothing breaks.
		render(videoPlayer())
		fireEvent(videoElement(), new Event("playing"))
		expect(shown).toHaveBeenCalledOnce()
	})
})

describe("slide signals — animated image", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
			() => ({ clearRect: vi.fn(), drawImage: vi.fn() }) as unknown as CanvasRenderingContext2D
		)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	function frameOf(index: number): VideoFrame {
		return { index, duration: 50_000, displayWidth: 10, displayHeight: 8, close: vi.fn() } as unknown as VideoFrame
	}

	function source() {
		const decoder = {
			complete: true,
			completed: Promise.resolve(),
			tracks: { selectedTrack: { frameCount: 3, repetitionCount: Number.POSITIVE_INFINITY } },
			decode: ({ frameIndex }: { frameIndex: number }) => Promise.resolve({ image: frameOf(frameIndex) }),
			close: vi.fn()
		}

		return { decoder: decoder as unknown as ImageDecoder, first: frameOf(0) }
	}

	it("an animated image reports the end of its first loop once", async () => {
		// An image is no kind of its own until its player says it animates.
		const kind: SlideKind = "image"
		const signals = fakeSignals()

		render(
			<SlideSignalsContext value={signals}>
				<AnimatedImagePlayer
					source={source()}
					alt={kind}
				/>
			</SlideSignalsContext>
		)

		expect(signals.animating).toHaveBeenCalledOnce()

		await act(async () => {
			await vi.advanceTimersByTimeAsync(140)
		})
		expect(signals.mediaEnded).not.toHaveBeenCalled()

		await act(async () => {
			await vi.advanceTimersByTimeAsync(10)
		})
		expect(signals.mediaEnded).toHaveBeenCalledOnce()

		// It keeps looping, and says so no more.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(600)
		})
		expect(signals.mediaEnded).toHaveBeenCalledOnce()
		expect(signals.animating).toHaveBeenCalledOnce()
	})
})
