import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AnimatedImagePlayback, type PlaybackDecoder } from "@/features/preview/lib/animatedImagePlayback"

// The animation clock over a stand-in ImageDecoder: frames drawn in turn at their own delays and closed once drawn,
// one decoded ahead at most, the file's loop count honoured, and the clock held while the picture cannot be seen.

interface FakeFrame {
	readonly index: number
	readonly duration: number
	readonly displayWidth: number
	readonly displayHeight: number
	readonly close: ReturnType<typeof vi.fn>
}

function fakeFrame(index: number, duration: number): FakeFrame {
	return { index, duration, displayWidth: 4, displayHeight: 3, close: vi.fn() }
}

function asFrame(frame: FakeFrame): VideoFrame {
	return frame as unknown as VideoFrame
}

function fakeDecoder(frameCount: number, repetitionCount: number, duration = 50_000) {
	const made: FakeFrame[] = []
	const decode = vi.fn(({ frameIndex }: { frameIndex: number }) => {
		if (frameIndex >= frameCount) {
			return Promise.reject(new RangeError("no such frame"))
		}

		const frame = fakeFrame(frameIndex, duration)

		made.push(frame)

		return Promise.resolve({ image: asFrame(frame) })
	})
	const decoder: PlaybackDecoder = {
		complete: true,
		completed: Promise.resolve(),
		tracks: { selectedTrack: { frameCount, repetitionCount } },
		decode
	}

	return { decoder, decode, made }
}

function fakeContext() {
	const drawn: number[] = []
	const context = {
		clearRect: vi.fn(),
		drawImage: vi.fn((frame: FakeFrame) => {
			drawn.push(frame.index)
		})
	}

	return { context: context as unknown as CanvasRenderingContext2D, drawn }
}

function setup(frameCount: number, repetitionCount: number, autoplay = true, duration = 50_000) {
	const { decoder, decode, made } = fakeDecoder(frameCount, repetitionCount, duration)
	const first = fakeFrame(0, duration)
	const playback = new AnimatedImagePlayback(decoder, asFrame(first), autoplay)
	const { context, drawn } = fakeContext()

	playback.attach(context)
	playback.start()

	return { playback, decode, made, drawn, first }
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("AnimatedImagePlayback", () => {
	it("draws the frames in turn at their delays and closes each once drawn", async () => {
		const { playback, drawn, made, first } = setup(3, Number.POSITIVE_INFINITY)

		expect(drawn).toEqual([0])
		expect(first.close).toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(49)
		expect(drawn).toEqual([0])

		await vi.advanceTimersByTimeAsync(1)
		expect(drawn).toEqual([0, 1])

		await vi.advanceTimersByTimeAsync(100)
		expect(drawn).toEqual([0, 1, 2, 0])
		expect(playback.getSnapshot().index).toBe(0)

		// Every frame drawn is closed; the one decoded ahead is still waiting its turn.
		const drawnFrames = made.slice(0, 3)

		expect(drawnFrames.every(frame => frame.close.mock.calls.length > 0)).toBe(true)
		playback.stop()
	})

	it("decodes at most one frame ahead", async () => {
		const { playback, decode } = setup(10, Number.POSITIVE_INFINITY)

		await vi.advanceTimersByTimeAsync(0)
		expect(decode).toHaveBeenCalledTimes(1)
		expect(decode).toHaveBeenLastCalledWith({ frameIndex: 1 })

		await vi.advanceTimersByTimeAsync(50)
		expect(decode).toHaveBeenCalledTimes(2)
		expect(decode).toHaveBeenLastCalledWith({ frameIndex: 2 })
		playback.stop()
	})

	it("plays as often as the file says, then stops on its last frame", async () => {
		const { playback, drawn } = setup(2, 1)

		await vi.advanceTimersByTimeAsync(1_000)
		// Once through, one repeat.
		expect(drawn).toEqual([0, 1, 0, 1])
		expect(playback.getSnapshot()).toMatchObject({ index: 1, playing: false })

		// Play again starts over.
		playback.play()
		await vi.advanceTimersByTimeAsync(0)
		expect(drawn.at(-1)).toBe(0)
		expect(playback.getSnapshot().playing).toBe(true)
		playback.stop()
	})

	it("stands still once paused, and a step pauses and shows the neighbouring frame", async () => {
		const { playback, drawn } = setup(5, Number.POSITIVE_INFINITY)

		playback.pause()
		await vi.advanceTimersByTimeAsync(500)
		expect(drawn).toEqual([0])

		playback.play()
		playback.step(1)
		await vi.advanceTimersByTimeAsync(0)
		expect(drawn).toEqual([0, 1])
		expect(playback.getSnapshot()).toMatchObject({ index: 1, playing: false })

		playback.step(-1)
		playback.step(-1)
		await vi.advanceTimersByTimeAsync(0)
		// The second step waits for the first and lands where it was headed: frame 0, never below.
		expect(playback.getSnapshot().index).toBe(0)
		expect(drawn.at(-1)).toBe(0)
		playback.stop()
	})

	it("seeks to a frame and plays on from there", async () => {
		const { playback, drawn } = setup(6, Number.POSITIVE_INFINITY)

		playback.seek(4)
		await vi.advanceTimersByTimeAsync(0)
		expect(drawn.at(-1)).toBe(4)

		await vi.advanceTimersByTimeAsync(50)
		expect(drawn.at(-1)).toBe(5)
		playback.stop()
	})

	it("holds the clock while the picture cannot be seen", async () => {
		const { playback, drawn } = setup(4, Number.POSITIVE_INFINITY)

		playback.setHold("hidden", true)
		await vi.advanceTimersByTimeAsync(500)
		expect(drawn).toEqual([0])
		expect(playback.getSnapshot().playing).toBe(true)

		playback.setHold("hidden", false)
		await vi.advanceTimersByTimeAsync(50)
		expect(drawn).toEqual([0, 1])
		playback.stop()
	})

	it("runs faster at a higher rate", async () => {
		const { playback, drawn } = setup(4, Number.POSITIVE_INFINITY)

		playback.setRate(2)
		await vi.advanceTimersByTimeAsync(25)
		expect(drawn).toEqual([0, 1])
		playback.stop()
	})

	it("stops drawing once stopped", async () => {
		const { playback, drawn } = setup(4, Number.POSITIVE_INFINITY)

		playback.stop()
		await vi.advanceTimersByTimeAsync(500)
		expect(drawn).toEqual([0])
	})
})
