// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { BlockSource, type ReadRange } from "@/lib/media/blockSource"
import { undecodedKinds, usePlaybackGap } from "@/features/preview/hooks/usePlaybackGap"
import type { ContainerTrack } from "@/features/preview/lib/containerTracks"

const { readContainerTracks } = vi.hoisted(() => ({ readContainerTracks: vi.fn<() => Promise<ContainerTrack[] | null>>() }))

vi.mock("@/features/preview/lib/containerTracks", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/preview/lib/containerTracks")>()),
	readContainerTracks
}))

interface Decoding {
	videoWidth?: number
	frames?: number
	audioBytes?: number
	// Only AAC decodes here.
	canPlay?: (query: string) => boolean
}

function video({
	videoWidth = 640,
	frames = 30,
	audioBytes = 4096,
	canPlay = query => query.includes("mp4a")
}: Decoding): HTMLVideoElement {
	const element = document.createElement("video")
	let currentTime = 0

	Object.defineProperties(element, {
		videoWidth: { get: () => videoWidth },
		webkitAudioDecodedByteCount: { get: () => audioBytes },
		seeking: { get: () => false },
		currentTime: {
			get: () => currentTime,
			set: (value: number) => {
				currentTime = value
			}
		}
	})
	element.getVideoPlaybackQuality = () => ({ totalVideoFrames: frames }) as VideoPlaybackQuality
	element.canPlayType = query => (canPlay(query) ? "probably" : "")

	return element
}

// Plays `seconds` of the element in 0.25s steps, as its timeupdate events would report them.
function play(element: HTMLVideoElement, seconds: number): void {
	for (let elapsed = 0; elapsed < seconds; elapsed += 0.25) {
		element.currentTime += 0.25
		element.dispatchEvent(new Event("timeupdate"))
	}
}

const SOURCE = new BlockSource(1024, vi.fn<ReadRange>())

describe("undecodedKinds", () => {
	it("flags a kind only where the element decoded none of it", () => {
		expect(undecodedKinds(video({}))).toEqual([])
		expect(undecodedKinds(video({ audioBytes: 0 }))).toEqual(["audio"])
		expect(undecodedKinds(video({ videoWidth: 0 }))).toEqual(["video"])
		expect(undecodedKinds(video({ frames: 0, audioBytes: 0 }))).toEqual(["video", "audio"])
	})
})

describe("usePlaybackGap", () => {
	it("names an audio codec the browser cannot decode once playback ran without sound", async () => {
		const element = video({ audioBytes: 0 })

		readContainerTracks.mockResolvedValue([
			{ kind: "video", codec: "h264" },
			{ kind: "audio", codec: "ac3" }
		])

		const { result } = renderHook(() => usePlaybackGap(element, SOURCE))

		act(() => {
			play(element, 1)
		})
		expect(readContainerTracks).not.toHaveBeenCalled()

		act(() => {
			play(element, 1)
		})
		await waitFor(() => {
			expect(result.current).toBe("ac3")
		})
		expect(readContainerTracks).toHaveBeenCalledOnce()
	})

	it("reads nothing for a file the browser decodes", () => {
		const element = video({})

		renderHook(() => usePlaybackGap(element, SOURCE))
		act(() => {
			play(element, 3)
		})

		expect(readContainerTracks).not.toHaveBeenCalled()
	})

	it("stays quiet for silence the container explains or the browser can decode", async () => {
		readContainerTracks
			.mockResolvedValueOnce([{ kind: "video", codec: "h264" }])
			.mockResolvedValueOnce([{ kind: "audio", codec: "aac" }])

		for (let i = 0; i < 2; i++) {
			const element = video({ audioBytes: 0 })
			const { result } = renderHook(() => usePlaybackGap(element, SOURCE))

			act(() => {
				play(element, 2)
			})
			await act(async () => {
				await Promise.resolve()
			})

			expect(result.current).toBeNull()
		}

		expect(readContainerTracks).toHaveBeenCalledTimes(2)
	})

	it("names a video codec when the picture never decoded", async () => {
		const element = video({ videoWidth: 0, frames: 0 })

		readContainerTracks.mockResolvedValue([
			{ kind: "video", codec: "hevc" },
			{ kind: "audio", codec: "aac" }
		])

		const { result } = renderHook(() => usePlaybackGap(element, SOURCE))

		act(() => {
			play(element, 2)
		})
		await waitFor(() => {
			expect(result.current).toBe("hevc")
		})
	})
})
