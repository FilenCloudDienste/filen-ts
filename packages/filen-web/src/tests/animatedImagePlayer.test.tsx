// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { AnimatableImage } from "@/features/preview/components/animatedImagePlayer"
import { ownedFileItem } from "@/tests/fixtures/sdk"
import { i18n } from "@/lib/i18n"

// An animated image in the preview: the player takes over from the plain <img> once ImageDecoder has its first frame,
// plays, pauses, steps and scrubs frames, honours the loop count, and leaves everything as it was where ImageDecoder
// is missing or the file is a still.

// Two images and a looping block: an animated GIF to the sniff.
function animatedGif(): Uint8Array<ArrayBuffer> {
	const parts = [
		[...new TextEncoder().encode("GIF89a"), 10, 0, 8, 0, 0x80, 0, 0, 0, 0, 0, 0, 0, 0],
		[0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 10, 0, 8, 0, 0, 2, 2, 0x4c, 0x01, 0],
		[0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 10, 0, 8, 0, 0, 2, 2, 0x4c, 0x01, 0],
		[0x3b]
	]

	return new Uint8Array(parts.flat())
}

interface DecoderState {
	frameCount: number
	repetitionCount: number
	animated: boolean
	decoded: number[]
	closed: number
}

const state: DecoderState = { frameCount: 3, repetitionCount: Number.POSITIVE_INFINITY, animated: true, decoded: [], closed: 0 }
const drawn: number[] = []

function frameOf(index: number): VideoFrame {
	return { index, duration: 50_000, displayWidth: 10, displayHeight: 8, close: vi.fn() } as unknown as VideoFrame
}

class FakeImageDecoder {
	public static isTypeSupported = vi.fn(() => Promise.resolve(true))
	public readonly complete = true
	public readonly completed = Promise.resolve()
	public readonly tracks = {
		ready: Promise.resolve(),
		selectedTrack: { animated: state.animated, frameCount: state.frameCount, repetitionCount: state.repetitionCount }
	}

	public decode({ frameIndex }: { frameIndex: number }): Promise<{ image: VideoFrame }> {
		state.decoded.push(frameIndex)

		return frameIndex < state.frameCount ? Promise.resolve({ image: frameOf(frameIndex) }) : Promise.reject(new RangeError("none"))
	}

	public close(): void {
		state.closed++
	}
}

const item = ownedFileItem("cat.gif", "image/gif", { size: 64n })

function renderImage() {
	return render(
		<AnimatableImage
			item={item}
			url="/preview/stream/cat.gif"
			alt="cat"
		>
			<img
				src="/preview/stream/cat.gif"
				alt="cat"
			/>
		</AnimatableImage>
	)
}

async function flush(ms = 0): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms)
	})
}

beforeEach(() => {
	vi.useFakeTimers()
	Object.assign(state, { frameCount: 3, repetitionCount: Number.POSITIVE_INFINITY, animated: true, decoded: [], closed: 0 })
	drawn.length = 0
	vi.stubGlobal("ImageDecoder", FakeImageDecoder)
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.resolve(new Response(animatedGif())))
	)
	HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
		clearRect: vi.fn(),
		drawImage: (frame: { index: number }) => {
			drawn.push(frame.index)
		}
	})) as unknown as typeof HTMLCanvasElement.prototype.getContext
	HTMLElement.prototype.setPointerCapture = vi.fn()
	HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe("AnimatableImage", () => {
	it("keeps the plain image where ImageDecoder is missing", async () => {
		vi.stubGlobal("ImageDecoder", undefined)
		Reflect.deleteProperty(globalThis, "ImageDecoder")
		renderImage()
		await flush()

		expect(screen.getByRole("img", { name: "cat" }).tagName).toBe("IMG")
		expect(fetch).not.toHaveBeenCalled()
	})

	it("keeps the plain image for a still", async () => {
		state.animated = false
		renderImage()
		await flush()

		expect(screen.getByRole("img", { name: "cat" }).tagName).toBe("IMG")
		expect(state.closed).toBeGreaterThan(0)
	})

	it("plays an animation on a canvas with the player's controls", async () => {
		renderImage()
		await flush()

		expect(screen.getByRole("img", { name: "cat" }).tagName).toBe("CANVAS")
		expect(drawn).toEqual([0])
		expect(screen.getByText("1/3")).toBeTruthy()

		await flush(50)
		expect(drawn).toEqual([0, 1])
		expect(screen.getByText("2/3")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: i18n.t("audio:pause") }))
		await flush(500)
		expect(drawn).toEqual([0, 1])
		expect(screen.getByRole("button", { name: i18n.t("audio:play") })).toBeTruthy()
	})

	it("steps a frame either way, pausing", async () => {
		renderImage()
		await flush()

		fireEvent.click(screen.getByRole("button", { name: i18n.t("preview:previewAnimationNextFrame") }))
		await flush()
		expect(drawn.at(-1)).toBe(1)
		expect(screen.getByRole("button", { name: i18n.t("audio:play") })).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: i18n.t("preview:previewAnimationPreviousFrame") }))
		await flush()
		expect(drawn.at(-1)).toBe(0)

		await flush(500)
		expect(drawn.at(-1)).toBe(0)
	})

	it("steps a frame on the period key and toggles on space", async () => {
		renderImage()
		await flush()

		const canvas = screen.getByRole("img", { name: "cat" })

		fireEvent.keyDown(canvas, { key: ".", code: "Period" })
		await flush()
		expect(drawn.at(-1)).toBe(1)
		expect(screen.getByRole("button", { name: i18n.t("audio:play") })).toBeTruthy()

		fireEvent.keyDown(canvas, { key: " ", code: "Space" })
		await flush()
		expect(screen.getByRole("button", { name: i18n.t("audio:pause") })).toBeTruthy()
	})

	it("seeks with the frame slider", async () => {
		renderImage()
		await flush()

		const slider = screen.getByRole("slider", { name: i18n.t("preview:previewAnimationFrameSlider") })

		fireEvent.keyDown(slider, { key: "End" })
		await flush()
		expect(drawn.at(-1)).toBe(2)
		expect(slider.getAttribute("aria-valuetext")).toBe(i18n.t("preview:previewAnimationFrameOf", { frame: 3, count: 3 }))
	})

	it("stops after the file's own number of plays", async () => {
		state.frameCount = 2
		state.repetitionCount = 0
		renderImage()
		await flush()

		await flush(1_000)
		expect(drawn).toEqual([0, 1])
		expect(screen.getByRole("button", { name: i18n.t("audio:play") })).toBeTruthy()
	})

	it("closes the decoder when it goes", async () => {
		const view = renderImage()

		await flush()
		view.unmount()
		expect(state.closed).toBe(1)
	})
})
