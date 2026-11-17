// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { VideoProbe } from "@filen/shared/videos"
import { MediaScrubber } from "@/components/media/mediaScrubber"
import { ChaptersMenu, TracksMenu } from "@/features/preview/components/videoTrackMenus"
import type { PreviewSubtitles } from "@/features/preview/hooks/usePreviewSubtitles"

// The "converted" note asks the browser's decoders, which jsdom has none of.
vi.mock("@/lib/media/playback/useTranscodedTracks", () => ({ useTranscodedTracks: () => new Set([1]) }))

function probeWith(audio: ReturnType<typeof audioTrack>[]): VideoProbe {
	return {
		v: 1,
		container: "mkv",
		durationSec: 60,
		index: "cues",
		video: null,
		audio,
		subs: [],
		chapters: [],
		cover: null,
		coverLand: null,
		partial: false
	}
}

const NO_SUBTITLES: PreviewSubtitles = {
	options: [],
	selected: "off",
	select: () => undefined,
	cues: null,
	failed: false
}

function audioTrack(id: number, lang: string, ch: number) {
	return {
		id,
		codec: "aac" as const,
		codecString: "mp4a.40.2",
		ch,
		rate: 48_000,
		lang,
		name: null,
		def: id === 1,
		forced: false,
		commentary: false
	}
}

function tracksMenu(probe: VideoProbe | null, onAudio: (index: number) => void = () => undefined) {
	return createElement(TracksMenu, {
		subtitles: NO_SUBTITLES,
		probe,
		nativeAudio: null,
		decision: null,
		audioIndex: 0,
		onAudio,
		size: 0,
		container: null,
		onOpenChange: () => undefined
	})
}

// Strings render as their keys here (no catalogue is loaded); the track names come from the language table.
describe("the preview player's track menus", () => {
	it("shows no tracks button for one audio track and no subtitles", () => {
		const probe = probeWith([audioTrack(1, "eng", 2)])

		render(tracksMenu(probe))
		expect(screen.queryByRole("button")).toBeNull()
	})

	it("lists every audio track by language and channels, and switches to the one picked", async () => {
		const picked: number[] = []
		const probe = probeWith([audioTrack(1, "eng", 6), audioTrack(2, "deu", 2)])

		render(tracksMenu(probe, index => picked.push(index)))
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "videos:playerTracks" }))
			await Promise.resolve()
		})

		expect(await screen.findByText("English 5.1")).toBeTruthy()
		expect(await screen.findByText(/playerAudioTranscoded/)).toBeTruthy()
		fireEvent.click(await screen.findByText("German playerChannelsStereo"))
		expect(picked).toEqual([1])
	})

	it("lists the chapters, untitled ones by number", async () => {
		render(
			createElement(ChaptersMenu, {
				chapters: [
					{ start: 0, title: "Opening" },
					{ start: 600, title: null }
				],
				media: null,
				container: null,
				onOpenChange: () => undefined
			})
		)
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "previewMediaChapters" }))
			await Promise.resolve()
		})

		expect(await screen.findByText("Opening")).toBeTruthy()
		expect(await screen.findByText("previewMediaChapterNumber")).toBeTruthy()
		expect(await screen.findByText("10:00")).toBeTruthy()
	})
})

describe("the scrubber's chapter marks", () => {
	it("marks every chapter start inside the rail", () => {
		const { container } = render(
			createElement(MediaScrubber, {
				value: 0,
				duration: 1200,
				label: "Seek",
				onSeek: () => undefined,
				markers: [
					{ start: 0, title: "Opening" },
					{ start: 300, title: "Middle" },
					{ start: 900, title: null }
				]
			})
		)
		// The ticks are the rail's marks of the background colour; one at the very start would only thicken the edge.
		const ticks = [...container.querySelectorAll<HTMLElement>(".bg-background\\/80")].map(element => element.style.left)

		expect(ticks).toEqual(["25%", "75%"])
	})
})
