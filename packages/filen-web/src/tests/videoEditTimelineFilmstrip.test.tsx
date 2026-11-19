// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import "@/lib/i18n"
import { VideoTimeline } from "@/features/preview/videoEdit/components/videoTimeline"
import { EditorPlayback } from "@/features/preview/videoEdit/components/editorPlayback"
import { fullView } from "@/features/preview/videoEdit/lib/timeline.logic"
import { fakeBitmap, fakeVideoEditClient } from "@/tests/support/fakeVideoEditClient"

// The timeline's filmstrip keys its tiles by keyframe: every slot a keyframe stands for is drawn from its one tile,
// what a capped answer left out is asked again, and an answer that adds nothing ends the asking.

const DURATION = 64
// The filmstrip's tile width (92 CSS px at its 52 px height).
const TILE = 92

let trackWidth = 0

class SizedResizeObserver {
	private readonly callback: ResizeObserverCallback

	public constructor(callback: ResizeObserverCallback) {
		this.callback = callback
	}

	public observe(): void {
		this.callback([{ contentRect: { width: trackWidth, height: 52 } } as ResizeObserverEntry], this)
	}

	public unobserve = vi.fn()

	public disconnect = vi.fn()
}

const drawImage = vi.fn()

function mount(keyframes: Float64Array, width: number, answer: (times: readonly number[]) => readonly number[]) {
	trackWidth = width

	const { client } = fakeVideoEditClient({ info: { duration: DURATION, keyframes } })

	client.filmstrip.mockImplementation((times: readonly number[]) =>
		Promise.resolve(answer(times).map(time => ({ time, bitmap: fakeBitmap(92, 52) })))
	)
	render(
		<VideoTimeline
			client={client}
			playback={new EditorPlayback()}
			duration={DURATION}
			fps={25}
			keyframes={keyframes}
			keep={[{ start: 0, end: DURATION }]}
			view={fullView(DURATION)}
			selection={null}
			splits={[]}
			snaps={[]}
			locked={false}
			decodingSuspended={false}
			onView={vi.fn()}
			onSeek={vi.fn()}
			onSelect={vi.fn()}
			onEdge={vi.fn()}
			onScrub={vi.fn()}
			onScrubEnd={vi.fn()}
			onLoupeCanvas={vi.fn()}
			onMakePrecise={vi.fn()}
		/>
	)

	return client
}

async function settle(): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(500)
	})
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.stubGlobal("ResizeObserver", SizedResizeObserver)
	drawImage.mockClear()
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		fillRect: vi.fn(),
		drawImage,
		fillStyle: ""
	} as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe("VideoTimeline filmstrip", () => {
	it("draws every slot sharing a keyframe from one fetch of that keyframe", async () => {
		// 920 px of 92 px tiles over 64 s: eight 8 s slots, four on each keyframe.
		const client = mount(new Float64Array([0, 32]), 10 * TILE, times => times)

		await settle()

		expect(client.filmstrip).toHaveBeenCalledTimes(1)
		expect(client.filmstrip.mock.calls[0]?.[0]).toEqual([0, 32])
		// Drawn once the answer is in: all eight slots, from two tiles.
		expect(drawImage).toHaveBeenCalledTimes(8)
	})

	it("asks again for the keyframes a capped answer left out", async () => {
		// 64 one-second slots over 32 keyframes; the worker answers 24 at a time.
		const keyframes = new Float64Array(Array.from({ length: 32 }, (_, index) => index * 2))
		const client = mount(keyframes, 64 * TILE, times => times.slice(0, 24))

		await settle()

		expect(client.filmstrip).toHaveBeenCalledTimes(2)
		expect(client.filmstrip.mock.calls[0]?.[0]).toHaveLength(32)
		expect(client.filmstrip.mock.calls[1]?.[0]).toEqual(Array.from({ length: 8 }, (_, index) => 48 + index * 2))
	})

	it("stops asking once an answer adds nothing", async () => {
		const client = mount(new Float64Array([0, 32]), 10 * TILE, () => [])

		await settle()

		expect(client.filmstrip).toHaveBeenCalledTimes(1)
		expect(drawImage).not.toHaveBeenCalled()
	})
})
