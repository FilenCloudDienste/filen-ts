// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { VideoProbe } from "@filen/shared/videos"
import { MediaScrubber } from "@/components/media/mediaScrubber"
import { ChaptersMenu, TracksMenu } from "@/features/preview/components/videoTrackMenus"
import type { PreviewSubtitles } from "@/features/preview/hooks/usePreviewSubtitles"
import "@/lib/i18n"

// The "converted" note asks the browser's decoders, which jsdom has none of.
// Whether the menu last asked them while open.
const asked = vi.hoisted(() => ({ open: false }))

vi.mock("@/lib/media/playback/useTranscodedTracks", () => ({
	useTranscodedTracks: (_probe: unknown, _size: number, open: boolean) => {
		asked.open = open

		return new Set([1])
	}
}))

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
		tooltipContainer: null,
		onOpenChange: () => undefined
	})
}

// The English catalogue is loaded, so the composed strings (chapter numbers, times) are asserted as shown.
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
			fireEvent.click(screen.getByRole("button", { name: "Audio" }))
			await Promise.resolve()
		})

		expect(await screen.findByText("English 5.1")).toBeTruthy()
		expect(await screen.findByText("Converted")).toBeTruthy()
		fireEvent.click(await screen.findByText("German Stereo"))
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
				tooltipContainer: null,
				onOpenChange: () => undefined
			})
		)
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Chapters" }))
			await Promise.resolve()
		})

		expect(await screen.findByText("Opening")).toBeTruthy()
		expect(await screen.findByText("Chapter 2")).toBeTruthy()
		// A radio list, the chapter playing (the first: no element, so time 0) checked.
		expect((await screen.findAllByRole("menuitemradio")).map(item => item.getAttribute("aria-checked"))).toEqual(["true", "false"])
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

describe("a menu that goes away while open", () => {
	it("reports itself closed, so the controls it held shown can hide", async () => {
		const changes: boolean[] = []
		const chapters = [
			{ start: 0, title: "Opening" },
			{ start: 600, title: null }
		]
		const view = render(
			createElement(ChaptersMenu, {
				chapters,
				media: null,
				container: null,
				tooltipContainer: null,
				onOpenChange: open => changes.push(open)
			})
		)

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Chapters" }))
			await Promise.resolve()
		})
		view.unmount()

		expect(changes.at(-1)).toBe(false)
	})

	it("reports the tracks menu closed when its options go while it is open, though it stays mounted", async () => {
		const changes: boolean[] = []
		const menu = (probe: VideoProbe) =>
			createElement(TracksMenu, {
				subtitles: NO_SUBTITLES,
				probe,
				nativeAudio: null,
				decision: null,
				audioIndex: 0,
				onAudio: () => undefined,
				size: 0,
				container: null,
				tooltipContainer: null,
				onOpenChange: (open: boolean) => changes.push(open)
			})
		const view = render(menu(probeWith([audioTrack(1, "eng", 6), audioTrack(2, "deu", 2)])))

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Audio" }))
			await Promise.resolve()
		})
		expect(changes.at(-1)).toBe(true)
		expect(asked.open).toBe(true)

		view.rerender(menu(probeWith([audioTrack(1, "eng", 6)])))

		expect(screen.queryByRole("button")).toBeNull()
		expect(changes.at(-1)).toBe(false)
		// It no longer asks the decoders about tracks it does not show.
		expect(asked.open).toBe(false)
	})
})

describe("the scrubber's chapter names", () => {
	it("says the chapter in its accessible value, numbering untitled ones", () => {
		render(
			createElement(MediaScrubber, {
				value: 700,
				duration: 1200,
				label: "Seek",
				onSeek: () => undefined,
				markers: [
					{ start: 0, title: "Opening" },
					{ start: 600, title: null }
				]
			})
		)

		expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("11:40 of 20:00, Chapter 2")
	})
})
